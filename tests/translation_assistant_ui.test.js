/*
 * Tests for translation_assistant_ui.js, the Translation Assistant panel.
 *
 *   node --test tests/translation_assistant_ui.test.js
 *
 * DEV-ONLY, like its siblings. There is no browser here: the panel is loaded
 * under node:vm against the same deliberately small DOM shim that
 * translation_lens_ui.test.js uses -- createElement, appendChild, textContent,
 * setAttribute, addEventListener, attachShadow and focus, and nothing else.
 *
 * Drafts are built by the real engine from synthetic content, not hand-written
 * as literals. What the panel says about a draft is only true if it is true of
 * a draft the engine can actually produce, and two of the defects this file
 * pins were invisible to a literal because they only appear when two fields
 * share one destination.
 *
 * No instance name, record identifier or real source string belongs here.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");

const root = path.join(__dirname, "..");
const UI_SOURCE = fs.readFileSync(path.join(root, "translation_assistant_ui.js"), "utf8");
const ENGINE_SOURCE = fs.readFileSync(path.join(root, "translation_assistant.js"), "utf8");

const HOST_ID = "snh-translation-assistant-results";

/* ------------------------------------------------------------------ *
 * The DOM shim
 * ------------------------------------------------------------------ */

function createDom() {
  let activeElement = null;
  /* The download anchor is removed from the shadow root immediately after it
   * is clicked, so what it was asked to save has to be recorded as it happens
   * or it cannot be inspected at all. */
  const clicks = [];

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = Object.create(null);
      this.handlers = Object.create(null);
      this.style = {};
      this.className = "";
      this.id = "";
      this.type = "";
      this.href = "";
      this.download = "";
      this.clicked = 0;
      this.shadowRoot = null;
      this._text = "";
    }
    /* STYLE is skipped for the same reason the Lens harness skips it: the
     * panel's stylesheet is a <style> child of the shadow root, and folding it
     * into every assertion would make a text match mean nothing. */
    get textContent() {
      return this._text + this.children
        .filter((child) => child.tagName !== "STYLE")
        .map((child) => child.textContent)
        .join("");
    }
    set textContent(value) {
      this.children.forEach((child) => { child.parentNode = null; });
      this.children = [];
      this._text = value == null ? "" : String(value);
    }
    get firstChild() { return this.children[0] || null; }
    appendChild(node) {
      if (!node) return node;
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
      return node;
    }
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
      node.parentNode = null;
      return node;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name] : null;
    }
    addEventListener(type, handler) {
      (this.handlers[type] = this.handlers[type] || []).push(handler);
    }
    attachShadow() {
      const shadow = new El("#shadow");
      shadow.host = this;
      this.shadowRoot = shadow;
      return shadow;
    }
    focus() { activeElement = this; }
    click() {
      this.clicked += 1;
      clicks.push({ tagName: this.tagName, download: this.download, href: this.href });
    }
  }

  const document = {
    createElement: (tag) => new El(tag),
    documentElement: new El("html"),
    get activeElement() { return activeElement; },
  };
  return { El, document, clicks };
}

function walk(node, visit) {
  (node.children || []).forEach((child) => {
    visit(child);
    walk(child, visit);
  });
}

function findAll(root_, predicate) {
  const out = [];
  walk(root_, (node) => { if (predicate(node)) out.push(node); });
  return out;
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

function load() {
  const dom = createDom();
  const revoked = [];
  const downloaded = [];
  const timers = [];
  const opened = [];
  const sandbox = {
    document: dom.document,
    Blob: class Blob {
      constructor(parts) { this.parts = parts || []; }
    },
    /* A real URL constructor, because the panel validates its links with one,
     * carrying the two statics the download route uses. The blob is kept, not
     * just counted: a test that watches the anchor and the clipboard but never
     * looks at the bytes passes just as happily when the file is empty. */
    URL: Object.assign(class SandboxURL extends URL {}, {
      createObjectURL: (blob) => {
        downloaded.push(blob);
        return "blob:draft";
      },
      revokeObjectURL: (url) => revoked.push(url),
    }),
    location: { origin: "https://example.service-now.com" },
    navigator: {
      clipboard: {
        written: [],
        writeText(text) {
          sandbox.navigator.clipboard.written.push(String(text));
          return Promise.resolve();
        },
      },
    },
    /* Fake timers, so a flash can be seen to revert without a real clock. */
    setTimeout: (fn) => {
      timers.push({ fn, cancelled: false, done: false });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].cancelled = true;
    },
    Promise,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  /* The engine first, as the worker injects it (background.js injects
   * translation_assistant.js and translation_assistant_ui.js into one world,
   * in that order). The panel reads markup with the engine's scanner, so a
   * sandbox without it would test a fallback the real panel never takes. */
  vm.runInContext(ENGINE_SOURCE, sandbox, { filename: "translation_assistant.js" });
  vm.runInContext(UI_SOURCE, sandbox, { filename: "translation_assistant_ui.js" });

  const notices = [];
  return {
    ui: sandbox.SNTranslationAssistantUI,
    notices,
    revoked,
    downloaded,
    opened,
    sandbox,
    runTimers() {
      timers.forEach((timer) => {
        if (!timer.cancelled && !timer.done) {
          timer.done = true;
          timer.fn();
        }
      });
    },
    clipboard: sandbox.navigator.clipboard,
    get lastDownloadName() {
      const anchors = dom.clicks.filter((entry) => entry.tagName === "A");
      return anchors.length ? anchors[anchors.length - 1].download : null;
    },
    callbacks: {
      onNotify: (message, isError) => notices.push({ message, isError: !!isError }),
      onClose: () => {},
      onOpenUrl: (url) => { opened.push(url); },
    },
    shadow() {
      const host = dom.document.documentElement.children.find((node) => node.id === HOST_ID);
      return host ? host.shadowRoot : null;
    },
    text() {
      const shadow = this.shadow();
      return shadow ? shadow.textContent : "";
    },
  };
}

/* ------------------------------------------------------------------ *
 * Engine-built fixtures, shaped like the probe output in the plan
 * ------------------------------------------------------------------ */

function loadEngine() {
  const context = { globalThis: null, crypto: nodeCrypto.webcrypto };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(ENGINE_SOURCE, context, { filename: "translation_assistant.js" });
  return context.SNTranslationAssistant;
}

const TA = loadEngine();

let sysIdCounter = 0;
function nextSysId() {
  sysIdCounter += 1;
  return String(sysIdCounter).padStart(32, "b");
}

function field(options) {
  const opts = options || {};
  const info = {
    originalValue: opts.source === undefined ? "Cost centre" : opts.source,
    textType: opts.textType || "plain",
    isFieldLocked: !!opts.locked,
    additionalParameters: {
      sysId: nextSysId(),
      name: opts.name || "question_text",
      type: opts.type || "translated_field",
      table: opts.table || "question",
      scope: "global",
    },
  };
  if (opts.target !== undefined) info.translatedValue = opts.target;
  return info;
}

function element(options) {
  const opts = options || {};
  return {
    groupName: opts.groupName || "Variable: Cost centre",
    label: opts.label || "Question",
    id: opts.id || (opts.groupName || "Variable: Cost centre") + ": " + (opts.label || "Question"),
    fieldInfo: opts.fields || [field()],
    isInternal: false,
  };
}

function draftFrom(content, options) {
  return TA.buildDraft(Object.assign({
    content,
    exportId: "a".repeat(32),
    now: 1000,
    artifactInternalName: "catalog_item",
    artifactSysId: "0".repeat(31) + "1",
    sourceLanguage: "en",
    targetLanguage: "fr",
    sourceLanguageName: "English",
    targetLanguageName: "French",
  }, options || {}));
}

function show(harness, draft) {
  const fingerprint = "ta-test-1";
  harness.ui.open({ fingerprint, context: {}, callbacks: harness.callbacks });
  assert.strictEqual(harness.ui.showDraft({ fingerprint, draft }), true);
  return harness.text();
}

/* ------------------------------------------------------------------ *
 * The tally is one accounting system (Codex phase 2 review, finding 3)
 * ------------------------------------------------------------------ */

test("the tally reconciles when two fields share one destination", () => {
  const content = [
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Variable: Cost centre (copy)", fields: [field({ source: "Cost centre" })] }),
  ];
  const draft = draftFrom(content);
  const harness = load();
  const text = show(harness, draft);

  assert.match(text, /2\s*fields on this item/);
  /* Both fields are eligible and neither is excluded, so a reader subtracting
   * the exclusions from the total must arrive at the number shown. Printing
   * the ROW count here is what made the tally unfalsifiable. */
  assert.ok(text.includes("2to translate") || /2\s*to translate/.test(text),
    "the total counts fields, as Sect. 4 promises: " + text);
  assert.ok(/1 translation row/.test(text),
    "and the deduplication is stated rather than swallowed: " + text);
});

test("the tally says nothing about rows when every field has its own", () => {
  const content = [
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Variable: Department", fields: [field({ source: "Department" })] }),
  ];
  const text = show(load(), draftFrom(content));
  assert.ok(!/translation row/.test(text),
    "an unshared item gets the plan's own wording, with no extra clause: " + text);
});

/* ------------------------------------------------------------------ *
 * The shared-translation warning (Codex phase 2 review, finding 6)
 * ------------------------------------------------------------------ */

test("a lone translated_field row still warns that the translation is shared", () => {
  /* Sect. 21 records this happening by accident on the PDI: one inserted row
   * translated a second item that merely carried the same variable label. */
  const draft = draftFrom([element({ fields: [field({ source: "Cost centre" })] })]);
  assert.strictEqual(draft.sharedRows, 0, "the fixture must be the singleton case");
  const text = show(load(), draft);
  assert.match(text, /every catalog item on this instance/,
    "the user is entitled to know this before they publish");
});

test("the warning describes the source text, not English", () => {
  const content = [element({ fields: [field({ source: "Kostenstelle" })] })];
  const draft = draftFrom(content, {
    sourceLanguage: "de",
    targetLanguage: "fr",
    sourceLanguageName: "German",
    targetLanguageName: "French",
  });
  const text = show(load(), draft);
  assert.match(text, /every catalog item on this instance/);
  assert.ok(!/English/.test(text),
    "the source language is whatever the picker says it is: " + text);
});

test("a record-scoped draft gets no instance-wide warning", () => {
  const draft = draftFrom([element({ fields: [field({ type: "translated_text" })] })]);
  const text = show(load(), draft);
  assert.ok(!/every catalog item on this instance/.test(text),
    "translated_text is stored per record, so the warning would be false: " + text);
});

/* ------------------------------------------------------------------ *
 * Regressions the two fixes above must not cause
 * ------------------------------------------------------------------ */

test("an item with nothing to translate still explains itself", () => {
  const draft = draftFrom([element({ fields: [field({ locked: true, target: "Centre de cout" })] })]);
  const harness = load();
  const text = show(harness, draft);
  assert.match(text, /Nothing to translate here/);
  assert.match(text, /unlock it on this page first/);
  assert.ok(!/verified|reviewed/i.test(text), "locked is derived, never verified");
});

test("both output routes hand over the one string the engine serialised", () => {
  const draft = draftFrom([element({ fields: [field({ source: "Cost centre" })] })]);
  const harness = load();
  show(harness, draft);
  const shadow = harness.shadow();

  const button = findAll(shadow, (node) => node.tagName === "BUTTON")
    .find((node) => node.textContent === "Download JSON");
  assert.ok(button, "the primary route is a button");
  (button.handlers.click || []).forEach((handler) => handler({}));
  const anchor = findAll(shadow, (node) => node.tagName === "A")[0];
  assert.ok(!anchor, "the anchor is removed once it has been clicked");

  /* The bytes, not the gesture. Watching the anchor and the clipboard while
   * never opening the blob is how a download route can ship empty. */
  assert.strictEqual(harness.downloaded.length, 1);
  assert.strictEqual(harness.downloaded[0].parts.join(""), draft.serialized,
    "the file is the one string the engine serialised, prompt included");
  assert.deepStrictEqual(harness.revoked, ["blob:draft"], "and the object URL is released");

  /* The artifact's own name is customer content, so the filename carries the
   * language pair and the draft id instead. */
  assert.strictEqual(harness.lastDownloadName, "glidelens-translation-en-fr-" +
    draft.exportId.slice(0, 8) + ".json");

  const copyLink = findAll(shadow, (node) => node.tagName === "BUTTON")
    .find((node) => node.textContent === "Copy prompt + JSON instead");
  assert.ok(copyLink, "the escape hatch is a text link, not a second button of equal weight");
  (copyLink.handlers.click || []).forEach((handler) => handler({}));
  return Promise.resolve().then(() => {
    assert.deepStrictEqual(harness.clipboard.written, [draft.serialized]);
  });
});

/* ------------------------------------------------------------------ *
 * House style
 *
 * Phase 2 first shipped with a light theme of its own -- a white card, a
 * green button, no footer -- beside six panels that all wear the same dark
 * palette. With no build step to share CSS, each panel carries a verbatim
 * copy, so drift is only ever visible to a test.
 * ------------------------------------------------------------------ */

test("the panel wears the shared GlideLens palette", () => {
  const start = UI_SOURCE.indexOf("const UI_CSS");
  const css = UI_SOURCE.slice(start, UI_SOURCE.indexOf("`;", start));
  assert.match(css, /:host\{[^}]*all:initial/,
    "without it the ServiceNow page's inherited font and colour leak through the shadow boundary");
  assert.match(css, /--teal:#31d4c4/);
  assert.match(css, /--pink:#ff6fae/);
  assert.match(css, /\.panel\{[^}]*background:#1e1e2e/);
});

test("the panel carries the house footer and exactly one pink action", () => {
  const draft = draftFrom([element({ fields: [field({ source: "Cost centre" })] })]);
  const harness = load();
  show(harness, draft);
  const shadow = harness.shadow();

  const footer = findAll(shadow, (node) => node.tagName === "FOOTER")[0];
  assert.ok(footer, "every GlideLens panel ends in a toolbar footer");
  assert.match(footer.textContent, /never saves or publishes/i);
  assert.strictEqual(
    findAll(footer, (node) => node.tagName === "BUTTON" && node.textContent === "Close").length, 1);

  const primaries = findAll(shadow, (node) => node.className === "primary");
  assert.strictEqual(primaries.length, 1, "one primary route");
  assert.strictEqual(primaries[0].textContent, "Download JSON");
  /* Each step has one button and one escape hatch drawn as a link. The reply's
   * Fill is a plain button, so Download stays the only pink one on this view. */
  const links = findAll(shadow, (node) => node.tagName === "BUTTON" && node.className === "secondary");
  assert.deepStrictEqual(links.map((node) => node.textContent),
    ["Copy prompt + JSON instead", "Upload a file instead"]);
  const fill = findAll(shadow, (node) => node.tagName === "BUTTON" && node.textContent === "Fill the page");
  assert.strictEqual(fill.length, 1);
  assert.strictEqual(fill[0].className, "action", "not a second pink button");
});

test("the subtitle names the language pair in the mono accent", () => {
  const draft = draftFrom([element({ fields: [field({ source: "Cost centre" })] })]);
  const harness = load();
  show(harness, draft);
  const mono = findAll(harness.shadow(), (node) => node.className === "mono");
  assert.strictEqual(mono.length, 1);
  assert.strictEqual(mono[0].textContent, "English → French");
});

/* ------------------------------------------------------------------ *
 * Feedback and evidence (live test on the PDI, 2026-09-11)
 *
 * Copying worked and said nothing: the panel's notices go to the command
 * palette's toast, and the palette has closed by the time the panel is up.
 * And "2 of these translations are shared" asked to be taken on trust.
 * ------------------------------------------------------------------ */

function buttonNamed(root_, text) {
  return findAll(root_, (node) => node.tagName === "BUTTON" && node.textContent === text)[0] || null;
}

function press(node) {
  assert.ok(node, "expected a control to press");
  (node.handlers.click || []).forEach((handler) => handler({ target: node }));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a copy confirms itself on the link, then puts the label back", async () => {
  const harness = load();
  show(harness, draftFrom([element({ fields: [field({ source: "Cost centre" })] })]));
  const link = buttonNamed(harness.shadow(), "Copy prompt + JSON instead");
  press(link);
  await flush();
  assert.match(link.textContent, /^Copied/,
    "the palette's toast is gone by now, so the control is the only place feedback can land");
  harness.runTimers();
  assert.strictEqual(link.textContent, "Copy prompt + JSON instead");
});

test("a failed copy says so instead of failing silently", async () => {
  const harness = load();
  show(harness, draftFrom([element({ fields: [field({ source: "Cost centre" })] })]));
  harness.clipboard.writeText = () => Promise.reject(new Error("denied"));
  const link = buttonNamed(harness.shadow(), "Copy prompt + JSON instead");
  press(link);
  await flush();
  assert.match(link.textContent, /^Copy failed/);
  assert.match(link.textContent, /Download JSON/, "and names the route that still works");
});

test("a failed download says so on the button, then puts the label back", () => {
  const harness = load();
  show(harness, draftFrom([element({ fields: [field({ source: "Cost centre" })] })]));
  harness.sandbox.Blob = class {
    constructor() { throw new Error("blocked"); }
  };
  const button = buttonNamed(harness.shadow(), "Download JSON");
  press(button);
  assert.match(button.textContent, /^Download failed/);
  harness.runTimers();
  assert.strictEqual(button.textContent, "Download JSON");
});

test("the shared warning names each shared translation", () => {
  const draft = draftFrom([
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Variable: Department", fields: [field({ source: "Department" })] }),
    element({
      groupName: "Variable: Notes",
      fields: [field({ source: "Notes", type: "translated_text", name: "help_text" })],
    }),
  ]);
  const harness = load();
  show(harness, draft);
  const items = findAll(harness.shadow(), (node) =>
    node.tagName === "LI" && node.parentNode && node.parentNode.className === "shared-list");
  assert.strictEqual(items.length, 2, "the record-scoped row is not shared, so it is not listed");
  assert.match(items[0].textContent, /“Cost centre”/);
  assert.match(items[0].textContent, /Question · Variable: Cost centre/);
  assert.match(items[1].textContent, /“Department”/);
});

test("each shared translation links to the fields that use its text, on this instance", () => {
  const harness = load();
  show(harness, draftFrom([element({ fields: [field({ source: "Cost centre" })] })]));
  press(buttonNamed(harness.shadow(), "Where this text is used ↗"));
  assert.deepStrictEqual(harness.opened, [
    "https://example.service-now.com/question_list.do?sysparm_query=question_text%3DCost%20centre",
  ], "the page's own table and column, filtered on the source text");
});

test("a text a list filter cannot express gets no links rather than wrong ones", () => {
  /* Translation Lens's queryValueStatus rules: a caret is the clause
   * separator, and a line break cannot sit inside an encoded query either. */
  for (const source of ["Up ^ down", "Line one\nLine two"]) {
    const harness = load();
    show(harness, draftFrom([element({ fields: [field({ source })] })]));
    assert.strictEqual(verifyButtons(harness.shadow()).length, 0, JSON.stringify(source));
    assert.match(harness.text(), /cannot express this text/);
  }
});

test("a text a list filter would run as a script gets no links, and says why", () => {
  /* Codex review of 337a328..0d928d4, P1, measured on the PDI: a query value
   * that is a javascript: expression is evaluated by the server instead of
   * matched as words, and encoding the URL does not stop it. Refused wherever
   * it appears, in any capitalisation, with or without space before the
   * colon: refusing too much costs a link, refusing too little opens a list
   * whose filter is someone's script. */
  for (const source of [
    "javascript:'Cost centre'",
    "JavaScript :gs.getUserName()",
    "Cost centre javascript:x",
  ]) {
    const harness = load();
    show(harness, draftFrom([
      element({ groupName: "Variable: Shared", fields: [field({ source })] }),
      element({
        groupName: "Variable: Done",
        fields: [field({ source: source + " (done)", locked: true, target: "Centre de coûts" })],
      }),
    ]));
    assert.strictEqual(verifyButtons(harness.shadow()).length, 0, JSON.stringify(source));
    const shared = findAll(harness.shadow(), (node) => node.className === "shared-list")[0];
    assert.match(shared.textContent, /would run this text as a script/, "the shared row says why");
    const detail = detailOf(bucketToggle(harness.shadow(), "already translated"));
    assert.match(detail.textContent, /would run this text as a script/, "so does the listed field");
  }
});

test("a table name that is not a plain identifier never becomes a link", () => {
  const harness = load();
  show(harness, draftFrom([element({
    fields: [field({ source: "Cost centre", table: "x/../../elsewhere" })],
  })]));
  assert.strictEqual(verifyButtons(harness.shadow()).length, 0,
    "neither the usage list nor the stored translation may be built from it");
  assert.deepStrictEqual(harness.opened, []);
});

function verifyButtons(root_) {
  return findAll(root_, (node) => node.tagName === "BUTTON" && node.className === "verify");
}

test("each shared translation links to where its translation is stored", () => {
  /* The key a publish writes -- the page's own table and column, the source
   * text, the target language -- which is the same key Translation Lens
   * links to for a choice. */
  const harness = load();
  show(harness, draftFrom([element({ fields: [field({ source: "Cost centre" })] })]));
  press(buttonNamed(harness.shadow(), "Stored French translation ↗"));
  assert.deepStrictEqual(harness.opened, [
    "https://example.service-now.com/sys_translated_list.do?sysparm_query=" +
      "name%3Dquestion%5Eelement%3Dquestion_text%5Evalue%3DCost%20centre%5Elanguage%3Dfr",
  ]);
});

test("the note says when the stored-translation list is empty, and when it is not", () => {
  /* Every listed row is unlocked. In ad-hoc mode that usually means no
   * translation exists, so an empty list must not read as a broken link --
   * but a translation the user unlocked to have redone is unlocked too, is
   * filled like any other, and is still stored (Codex review, P2). The note
   * has to be true of both. */
  const harness = load();
  show(harness, draftFrom([element({
    fields: [field({ source: "Cost centre", target: "Centre de coûts" })],
  })]));
  assert.match(harness.text(), /empty unless one was published and then unlocked to be redone/);
  assert.doesNotMatch(harness.text(), /stays empty until one is published/);
});

test("a language code that is not sys_language-shaped gets no stored link", () => {
  const harness = load();
  const draft = draftFrom([element({ fields: [field({ source: "Cost centre" })] })]);
  draft.languages.targetLanguage = "fr/../x";
  show(harness, draft);
  assert.ok(buttonNamed(harness.shadow(), "Where this text is used ↗"),
    "the usage link does not depend on the language");
  assert.strictEqual(verifyButtons(harness.shadow()).length, 1);
});

/* ------------------------------------------------------------------ *
 * The lists behind two counts (owner request, 2026-09-11)
 *
 * "Already translated" and "rich text" open into a list on request. The
 * counts stay first; the list is for checking what was excluded and where
 * its translation is kept.
 * ------------------------------------------------------------------ */

function bucketToggle(root_, what) {
  return findAll(root_, (node) => node.tagName === "BUTTON" && node.className === "toggle" &&
    node.parentNode && node.parentNode.textContent.includes(what))[0] || null;
}

function detailOf(toggle) {
  const row = toggle.parentNode;
  const siblings = row.parentNode.children;
  return siblings[siblings.indexOf(row) + 1];
}

function mixedDraft() {
  return draftFrom([
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({
      groupName: "Variable: Approver",
      fields: [field({ source: "Approver", locked: true, target: "Approbateur" })],
    }),
    element({
      groupName: "Basic Info",
      label: "Description",
      fields: [field({
        source: "<p>Read the <b>notes</b></p>", type: "translated_html", textType: "html",
        name: "description", table: "sc_cat_item",
      })],
    }),
  ]);
}

test("the already-translated count opens into a list, closed by default", () => {
  const harness = load();
  show(harness, mixedDraft());
  const toggle = bucketToggle(harness.shadow(), "already translated");
  assert.ok(toggle, "the bucket offers the list");
  const detail = detailOf(toggle);
  assert.strictEqual(detail.hidden, true, "the counts stay first");
  assert.strictEqual(toggle.getAttribute("aria-expanded"), "false");

  press(toggle);
  assert.strictEqual(detail.hidden, false);
  assert.strictEqual(toggle.textContent, "Hide");
  assert.strictEqual(toggle.getAttribute("aria-expanded"), "true");
  assert.match(detail.textContent, /“Approver”/);
  assert.match(detail.textContent, /→ “Approbateur”/, "the translation that makes it count as done");

  press(toggle);
  assert.strictEqual(detail.hidden, true);
  assert.strictEqual(toggle.textContent, "Show them");
});

test("an already-translated field links to the sys_translated row that holds it", () => {
  const harness = load();
  show(harness, mixedDraft());
  const detail = detailOf(bucketToggle(harness.shadow(), "already translated"));
  press(verifyButtons(detail)[0]);
  assert.deepStrictEqual(harness.opened, [
    "https://example.service-now.com/sys_translated_list.do?sysparm_query=" +
      "name%3Dquestion%5Eelement%3Dquestion_text%5Evalue%3DApprover%5Elanguage%3Dfr",
  ]);
});

test("a rich text field shows plain words and links to its record's translation", () => {
  /* No editor reported ready, so it waits in the editor bucket. */
  const draft = mixedDraft();
  const rich = draft.excluded.find((entry) => entry.reason === "rich_text_editor");
  const harness = load();
  show(harness, draft);
  const detail = detailOf(bucketToggle(harness.shadow(), "rich text"));
  assert.match(detail.textContent, /“Read the notes”/, "markup is shown as words, never rendered");
  assert.ok(!/<b>/.test(detail.textContent));
  assert.match(detail.textContent, /no French translation yet/);

  press(verifyButtons(detail)[0]);
  assert.deepStrictEqual(harness.opened, [
    "https://example.service-now.com/sys_translated_text_list.do?sysparm_query=" +
      "documentkey%3D" + rich.sysId + "%5Efieldname%3Ddescription%5Elanguage%3Dfr",
  ], "keyed by the record's sys_id, without a table name the store may spell differently");
});

test("only the already-translated and rich text counts open into a list", () => {
  const harness = load();
  show(harness, draftFrom([
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Variable: Blank", fields: [field({ source: "" })] }),
  ]));
  assert.match(harness.text(), /empty/, "the empty bucket is shown");
  assert.strictEqual(
    findAll(harness.shadow(), (node) => node.tagName === "BUTTON" && node.className === "toggle").length, 0);
});

test("every listed field is built from the same parts, however long its text", () => {
  /* Owner report, 2026-09-11: the list was one wrapping row per field, so the
   * text length decided which line the translation, the location and the link
   * landed on, and a short entry never matched a long one. Each entry is now
   * its text, its translation, then one foot line: where it lives, its link. */
  const long = "Is this a replacement for a device that was lost, stolen or damaged while travelling for work ?";
  const harness = load();
  show(harness, draftFrom([
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Variable: Choice", fields: [field({ source: "No", locked: true, target: "Non" })] }),
    element({ groupName: "Variable: Lost", fields: [field({ source: long, locked: true, target: long })] }),
    element({
      groupName: "Basic Info",
      label: "Description",
      fields: [field({
        source: "<p>Notes</p>", type: "translated_html", textType: "html",
        name: "description", table: "sc_cat_item",
      })],
    }),
  ]));
  const shapes = findAll(harness.shadow(), (node) =>
    node.tagName === "LI" && node.parentNode && node.parentNode.className === "excluded-list")
    .map((item) => [
      item.children.map((child) => child.className).join(" "),
      item.children[item.children.length - 1].children.map((child) => child.className).join(" "),
    ]);
  /* In bucket order: the two already translated, then the rich text waiting
   * for its editor. */
  assert.deepStrictEqual(shapes, [
    ["src tgt foot", "where verify"],
    ["src tgt foot", "where verify"],
    ["src untranslated foot", "where verify"],
  ]);
});

test("each rich-text bucket names its reason, and a locked rich-text field is shown as words too", () => {
  const harness = load();
  const content = [
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Basic Info", label: "Description", fields: [field({
      source: "<p>Hi</p><script>run()</script>", type: "translated_html", textType: "html", name: "description", table: "sc_cat_item",
    })] }),
    element({ groupName: "Variable: Notes", label: "Rich text", fields: [field({
      source: "<p>Read <b>this</b></p>", type: "translated_html", textType: "html", name: "rich_text", table: "item_option_new",
    })] }),
    element({ groupName: "Variable: Terms", label: "Rich text", fields: [field({
      source: "<p>Agree</p>", target: "<p><strong>Accepter</strong></p>", locked: true,
      type: "translated_html", textType: "html", name: "rich_text", table: "item_option_new",
    })] }),
  ];
  const text = show(harness, draftFrom(content));
  assert.match(text, /rich text with markup left to you\(excluded — it holds a script, a form, an embedded frame or tags this fill cannot read — translate it on the page\)/);
  assert.match(text, /rich text whose editor is not ready\(excluded — let the page finish loading, then run Translation Assistant again\)/);

  const detail = detailOf(bucketToggle(harness.shadow(), "already translated"));
  assert.match(detail.textContent, /“Agree”/);
  assert.match(detail.textContent, /→ “Accepter”/);
  assert.ok(!/<strong>|<p>/.test(detail.textContent), "markup is words, whichever bucket it is in");
});

/* A draft whose rich-text fields all have a ready editor, as the page reader
 * reports them when the page has loaded. */
function readyEditors(content) {
  const list = [];
  content.forEach((el, elementIndex) => (el.fieldInfo || []).forEach((info, fieldIndex) => {
    if (info.textType === "html") list.push({ elementIndex, fieldIndex, editors: 1, ready: true });
  }));
  return list;
}

function richContent() {
  return [
    element({ groupName: "Basic Info", label: "Description", fields: [field({
      source: "<p>Read the <b>notes</b></p>", target: "<p>Lire les <strong>brouillons</strong></p>",
      type: "translated_html", textType: "html", name: "description", table: "sc_cat_item",
    })] }),
  ];
}

function richEvaluation(content, reply) {
  const richEditors = readyEditors(content);
  const draft = draftFrom(content, { richEditors });
  const payload = clone(draft.payload);
  payload.rows[0].target = reply;
  return {
    draft,
    evaluation: clone(TA.evaluateReply({ draft: TA.storedDraft(draft), reply: payload, content, identity: FILL_IDENTITY, richEditors })),
  };
}

test("a rich-text fill reports its texts as words, and a replaced translation as words too", async () => {
  const content = richContent();
  const { draft, evaluation } = richEvaluation(content, "<p>Lisez les <b>notes</b></p>");
  assert.strictEqual(evaluation.rows[0].verdict, "fill");
  const harness = load();
  withFill(harness, filledAnswer(evaluation, [1]));
  show(harness, draft);
  await pasteAndFill(harness, "reply text");

  const text = harness.text();
  assert.match(text, /Filled 1 field\./);
  assert.match(text, /Replaced 1 existing translation/);
  assert.match(text, /“Read the notes”Filled“Lisez les notes”Was“Lire les brouillons”/);
  assert.ok(!/<b>|<strong>|<p>/.test(text), "no markup is shown anywhere in the report");
});

test("a reply that changes a rich-text field's tags says only the words may change", async () => {
  const content = richContent();
  const { draft, evaluation } = richEvaluation(content, "<p>Lisez les <a href=\"https://example.com\">notes</a></p>");
  assert.strictEqual(evaluation.rows[0].verdict, "markup_changed");
  const harness = load();
  withFill(harness, filledAnswer(evaluation, []));
  show(harness, draft);
  await pasteAndFill(harness, "reply text");

  const text = harness.text();
  assert.match(text, /Nothing was filled\./);
  /* The tag is named. Both texts read alike here -- "Read the notes" against
   * "Lisez les notes" -- so a reason that only says the tags differ leaves a
   * user staring at two lines with nothing to act on (review finding). */
  assert.match(
    text,
    /its HTML tags are not the source's — the reply has <a href="https:\/\/example\.com"> where the source has <b>, and only the words between tags may change/
  );
  assert.doesNotMatch(text, /Fill anyway|Overwrite/, "nothing a user can choose past it");
});

test("the writer's reason for a rich-text field it did not fill is the one the report gives", async () => {
  const content = richContent();
  const { draft, evaluation } = richEvaluation(content, "<p>Lisez les <b>notes</b></p>");
  const identityKey = evaluation.rows[0].members[0].identityKey;
  for (const [why, pattern, flagged] of [
    ["rich_rewritten", /changed this translation's words, so it was put back as it was/, false],
    ["rich_too_long", /longer than the field holds once the editor formats it, so it was put back as it was — shorten it/, false],
    ["rich_unsynced", /the page did not take this translation in, so the editor was put back as it was — reload the page/, false],
    ["rich_reverted", /did not hold as written, so the editor was put back as it was/, false],
    /* An arrow key: telling a user to press any key types into the field. */
    ["rich_unrecorded", /holds an edit the page has not taken in — click into the box, press an arrow key, then fill again/, false],
    ["rich_editor", /was not ready or not editable — let the page finish loading, then fill again/, false],
    ["rich_unconfirmed", /could not be put back as it was — reload the page before you publish/, true],
  ]) {
    const harness = load();
    withFill(harness, filledAnswer(evaluation, [1], {
      landed: 0, attempted: 1, missed: [1], missedFields: [{ k: 1, identityKey, why }],
    }));
    show(harness, draft);
    await pasteAndFill(harness, "reply text");
    const text = harness.text();
    assert.match(text, pattern, why);
    assert.strictEqual(/Reload the page before you publish\./.test(text), flagged, why + ": the page-level note");
    assert.doesNotMatch(text, /Replaced 1 existing translation/, why + ": a field that did not take replaced nothing");
  }
});

test("a long text is cut at a whole word, and the whole of it is on hover", () => {
  const words = "With the managed laptop programme remote staff get a secured device the software " +
    "their role needs and help from the service desk wherever they happen to work";
  const harness = load();
  show(harness, draftFrom([
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Variable: Long", fields: [field({ source: words, locked: true, target: "Oui" })] }),
  ]));
  const detail = detailOf(bucketToggle(harness.shadow(), "already translated"));
  const source = findAll(detail, (node) => node.className === "src")[0];
  assert.ok(source.textContent.endsWith("…”"), source.textContent);
  const shown = source.textContent.slice(1, -2);
  assert.ok(words.startsWith(shown + " "), "ends on a whole word: " + shown);
  assert.strictEqual(source.title, words, "the whole text is one hover away");
  const target = findAll(detail, (node) => node.className === "tgt")[0];
  assert.strictEqual(target.title, "Oui", "one line can clip even a short text, so it has a hover too");
});

test("the list's stylesheet keeps each text to one line and each foot to one row", () => {
  /* The test above pins the parts, not the layout: turning the one-line rule
   * into wrapping inline text left it passing (Codex review, P3). Node cannot
   * lay the panel out, so this reads the stylesheet the panel injects. */
  const harness = load();
  show(harness, mixedDraft());
  const style = findAll(harness.shadow(), (node) => node.tagName === "STYLE")[0];
  assert.ok(style, "the panel injects its stylesheet");
  const css = style.textContent
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};:,])\s*/g, "$1");
  const rule = (selector) => {
    const at = css.indexOf("}" + selector + "{");
    assert.ok(at >= 0, "no rule for " + selector);
    const start = at + selector.length + 2;
    return css.slice(start, css.indexOf("}", start));
  };
  const text = rule(".excluded-list .src,.excluded-list .tgt");
  ["display:block", "white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis"].forEach((declaration) => {
    assert.ok(text.includes(declaration), "a listed text keeps to one line: " + declaration);
  });
  assert.ok(rule(".tally .excluded-list li").includes("display:block"),
    "an entry is a stack of lines, not one wrapping row");
  const foot = rule(".foot");
  assert.ok(foot.includes("display:flex") && !foot.includes("flex-wrap:wrap"),
    "the foot is one row at the panel's normal width");
});

test("plain text keeps its angle brackets; only rich text is shown as words", () => {
  /* Codex review, P2, measured: every entry went through the markup stripper,
   * so "Enter <account> here" showed as "Enter here", its hover lost the
   * placeholder too, and a translation that was nothing but "<compte>" read
   * as no translation at all. */
  const harness = load();
  show(harness, draftFrom([
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({
      groupName: "Variable: Account",
      fields: [field({ source: "Enter <account> here", locked: true, target: "Saisir <compte> ici" })],
    }),
    element({
      groupName: "Variable: Placeholder",
      fields: [field({ source: "<account>", locked: true, target: "<compte>" })],
    }),
  ]));
  const detail = detailOf(bucketToggle(harness.shadow(), "already translated"));
  assert.match(detail.textContent, /“Enter <account> here”/);
  assert.match(detail.textContent, /→ “Saisir <compte> ici”/);
  assert.match(detail.textContent, /→ “<compte>”/, "a translation that looks like a tag is still a translation");
  assert.doesNotMatch(detail.textContent, /no French translation yet/);
  const titles = findAll(detail, (node) => node.className === "src" || node.className === "tgt")
    .map((node) => node.title);
  assert.deepStrictEqual(titles, ["Enter <account> here", "Saisir <compte> ici", "<account>", "<compte>"]);
});

test("a rich source this fill leaves to the user never shows a piece of a tag as a word", () => {
  /* Review finding: the panel stripped markup with a pattern over angle
   * brackets, which reads the ">" inside a quoted attribute as the end of the
   * tag and puts the rest of that tag on screen dressed as words. The sources
   * it happens to are exactly the ones in this bucket -- the ones the user is
   * being told to go and translate by hand. The panel uses the fill's own
   * scanner now, so a source that scanner reads is shown as words, and one it
   * refuses is shown as written rather than stripped into something that only
   * looks like words. Either way no fragment of a tag passes for a word. */
  const harness = load();
  const rich = (source) => element({ groupName: "Basic Info", fields: [field({
    source, type: "translated_html", textType: "html", name: "description", table: "sc_cat_item",
  })] });
  show(harness, draftFrom([
    /* Read by the scanner, excluded for the element it holds. Its "&amp;" is
     * what a person reads as "&", so that is what the list shows. */
    rich("<p>Read the <iframe src=\"https://example.com\"></iframe>notes &amp; drafts</p>"),
    /* Refused by the scanner: a ">" inside a quoted attribute value. */
    rich("<p>Open the <button onclick=\"a>b\">console</button></p>"),
  ]));
  const detail = detailOf(bucketToggle(harness.shadow(), "rich text with markup left to you"));
  assert.match(
    detail.textContent,
    /“Read the notes & drafts”/,
    "a source the scanner reads is shown as words, with character references decoded"
  );
  assert.doesNotMatch(detail.textContent, /&amp;/, "an entity is never shown as itself");
  assert.match(
    detail.textContent,
    /“<p>Open the <button onclick="a>b">console<\/button><\/p>”/,
    "a source it refuses is shown as written"
  );
  assert.doesNotMatch(detail.textContent, /“b">console/, "and never as the tail of a tag passing for words");
});

/* ------------------------------------------------------------------ *
 * Step 2: the reply comes back (phase 3)
 *
 * No preview before the fill, by the owner's decision: the comparison page is
 * the preview. So the report carries the weight -- every row not filled is
 * named with its reason, the two choices a user can make resend the same
 * reply, and a replaced translation shows its old text. Evaluations are the
 * real engine's, over content a draft was really built from.
 * ------------------------------------------------------------------ */

const FILL_IDENTITY = {
  artifactInternalName: "catalog_item",
  artifactSysId: "0".repeat(31) + "1",
  sourceLanguage: "en",
  targetLanguage: "fr",
};
const clone = (value) => JSON.parse(JSON.stringify(value));

function evaluationFor(content, answers, live) {
  const draft = draftFrom(content);
  const reply = clone(draft.payload);
  reply.rows.forEach((row) => {
    if (Object.prototype.hasOwnProperty.call(answers, row.source)) row.target = answers[row.source];
  });
  return clone(TA.evaluateReply({
    draft: TA.storedDraft(draft),
    reply,
    content: live || content,
    identity: FILL_IDENTITY,
  }));
}

function filledAnswer(evaluation, filled, extra) {
  return Object.assign({
    ok: true,
    written: filled.length > 0,
    landed: filled.length,
    attempted: filled.length,
    missed: [],
    report: { rows: evaluation.rows, unknown: 0, filled },
  }, extra || {});
}

function withFill(harness, answer) {
  const calls = [];
  harness.callbacks.onFill = (request) => {
    calls.push(clone(request));
    return typeof answer === "function" ? answer(request, calls.length) : Promise.resolve(answer);
  };
  return calls;
}

async function pasteAndFill(harness, text) {
  const box = findAll(harness.shadow(), (node) => node.tagName === "TEXTAREA")[0];
  assert.ok(box, "the reply box is on the panel");
  box.value = text;
  press(buttonNamed(harness.shadow(), "Fill the page"));
  await flush();
}

test("Fill sends the pasted reply and reports how many fields it filled", async () => {
  const content = [
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Variable: Approver", fields: [field({ source: "Approver" })] }),
  ];
  const evaluation = evaluationFor(content, { "Cost centre": "Centre de coût", Approver: "Approbateur" });
  const harness = load();
  const calls = withFill(harness, filledAnswer(evaluation, [1, 2]));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "{ \"reply\": true }");

  assert.deepStrictEqual(calls, [{ text: "{ \"reply\": true }", include: [], overrides: [] }]);
  const text = harness.text();
  assert.match(text, /Filled 2 fields\./);
  assert.match(text, /Review them on the page, then press Publish/);
  assert.match(text, /reloading the page discards every fill/);
  assert.doesNotMatch(text, /Not filled/);
});

test("an empty box sends nothing and says what to do", async () => {
  const harness = load();
  const calls = withFill(harness, { ok: true });
  show(harness, draftFrom([element({ fields: [field({ source: "Cost centre" })] })]));
  await pasteAndFill(harness, "   ");
  assert.strictEqual(calls.length, 0);
  assert.match(harness.text(), /Paste the reply first/);
});

test("a placeholder mismatch waits for Fill anyway, which resends the reply with that row", async () => {
  const content = [element({ groupName: "Variable: Charge", fields: [field({ source: "Charge ${account}" })] })];
  const evaluation = evaluationFor(content, { "Charge ${account}": "Débiter le compte" });
  const k = evaluation.rows[0].k;
  const harness = load();
  const calls = withFill(harness, filledAnswer(evaluation, []));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");

  const text = harness.text();
  assert.match(text, /Nothing was filled\./);
  assert.match(text, /Not filled \(1\)/);
  assert.match(text, /placeholders differ — the source has \$\{account\}, the translation has none/);
  press(buttonNamed(harness.shadow(), "Fill anyway"));
  await flush();
  assert.deepStrictEqual(calls[1], { text: "reply text", include: [k], overrides: [] });
});

test("a field changed on the page offers Overwrite, bound to the value it shows", async () => {
  const content = [element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] })];
  const live = clone(content);
  live[0].fieldInfo[0].translatedValue = "typed by hand";
  const evaluation = evaluationFor(content, { "Cost centre": "Centre de coût" }, live);
  assert.strictEqual(evaluation.rows[0].verdict, "edited");
  const harness = load();
  const calls = withFill(harness, filledAnswer(evaluation, []));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");

  const text = harness.text();
  assert.match(text, /changed on the page since the draft/);
  assert.match(text, /Reply“Centre de coût”On the page“typed by hand”/);
  press(buttonNamed(harness.shadow(), "Overwrite"));
  await flush();
  assert.deepStrictEqual(calls[1].overrides, [{
    k: evaluation.rows[0].k,
    reviewed: [{ identityKey: evaluation.rows[0].members[0].identityKey, target: "typed by hand" }],
  }]);
});

test("every report entry is built from the same parts, with the reason and its button on one line", async () => {
  /* Owner report, 2026-09-13: an entry was six lines of prose one under the
   * other -- text, arrow, reason, location, "on the page", button -- and hard
   * to read. Now: the field, its text, a labelled pair of values, then one
   * verdict line holding the reason and, beside it, the button. */
  const content = [
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Variable: Charge", fields: [field({ source: "Charge ${account}" })] }),
    element({ groupName: "Variable: Approver", fields: [field({ source: "Approver" })] }),
  ];
  const live = clone(content);
  live[0].fieldInfo[0].translatedValue = "typed by hand";
  const evaluation = evaluationFor(content, {
    "Cost centre": "Centre de coût",
    "Charge ${account}": "Débiter le compte",
  }, live);
  const harness = load();
  withFill(harness, filledAnswer(evaluation, []));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");

  const entries = findAll(harness.shadow(), (node) =>
    node.tagName === "LI" && node.parentNode && node.parentNode.className === "report-list");
  const shapes = entries.map((item) => {
    const pair = item.children.find((child) => child.className === "pair");
    return [
      item.children.map((child) => child.className).join(" "),
      pair ? pair.children.map((child) => child.textContent).join("|") : "",
      item.children[item.children.length - 1].children.map((child) => child.tagName).join(" "),
    ];
  });
  /* Placeholder warning first, then the edited field, then the one the reply
   * left out -- which has no translation to pair, so no pair. */
  assert.deepStrictEqual(shapes, [
    ["field src pair verdict", "Reply|“Débiter le compte”", "SPAN BUTTON"],
    ["field src pair verdict", "Reply|“Centre de coût”|On the page|“typed by hand”", "SPAN BUTTON"],
    ["field src verdict", "", "SPAN"],
  ]);
  assert.match(harness.text(), /Variable: Charge“Charge \$\{account\}”Reply/,
    "the field is named above its text");
});

test("a fill that replaced a translation shows the old text, and how to keep it", async () => {
  /* Unlocked to be redone: eligible by lock state, with a translation already
   * in the box. Clearing that box would not bring the old one back. */
  const content = [element({
    groupName: "Variable: Cost centre",
    fields: [field({ source: "Cost centre", target: "Centre de frais", locked: false })],
  })];
  const evaluation = evaluationFor(content, { "Cost centre": "Centre de coût" });
  const harness = load();
  withFill(harness, filledAnswer(evaluation, [1]));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");

  const text = harness.text();
  assert.match(text, /Replaced 1 existing translation/);
  assert.match(text, /Filled“Centre de coût”Was“Centre de frais”/);
  assert.match(text, /clearing the box deletes it/);
});

test("a partial landing names the fields that did not take", async () => {
  const content = [
    element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Variable: Approver", fields: [field({ source: "Approver" })] }),
  ];
  const evaluation = evaluationFor(content, { "Cost centre": "Centre de coût", Approver: "Approbateur" });
  const harness = load();
  withFill(harness, filledAnswer(evaluation, [1, 2], { landed: 1, attempted: 2, missed: [2] }));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");

  const text = harness.text();
  assert.match(text, /Filled 1 of 2 fields — 1 did not take on the page/);
  assert.match(text, /Not filled \(1\)/);
  assert.match(text, /“Approver”.*did not take on the page/);
});

test("a refusal keeps the reply in the box and shows how it starts", async () => {
  const harness = load();
  withFill(harness, { ok: false, code: "unparseable", message: "That is not JSON: bad token", excerpt: "Sure! Here it is" });
  show(harness, draftFrom([element({ fields: [field({ source: "Cost centre" })] })]));
  await pasteAndFill(harness, "Sure! Here it is {");

  const text = harness.text();
  assert.match(text, /That is not JSON: bad token/);
  assert.match(text, /The reply starts:Sure! Here it is/);
  assert.strictEqual(findAll(harness.shadow(), (node) => node.tagName === "TEXTAREA")[0].value, "Sure! Here it is {");
});

test("a fill that may still be running says so, rather than failing", async () => {
  const harness = load();
  withFill(harness, { ok: false, indeterminate: true, message: "It may still be filling." });
  show(harness, draftFrom([element({ fields: [field({ source: "Cost centre" })] })]));
  await pasteAndFill(harness, "reply text");
  const flagged = findAll(harness.shadow(), (node) => node.className === "note flag");
  assert.strictEqual(flagged.length, 1);
  assert.match(flagged[0].textContent, /may still be filling/);
  assert.strictEqual(findAll(harness.shadow(), (node) => node.className === "error").length, 0);
});

test("a second press while a fill runs sends nothing", async () => {
  const harness = load();
  let release;
  const calls = withFill(harness, () => new Promise((resolve) => { release = resolve; }));
  show(harness, draftFrom([element({ fields: [field({ source: "Cost centre" })] })]));
  const box = findAll(harness.shadow(), (node) => node.tagName === "TEXTAREA")[0];
  box.value = "reply text";
  const fill = buttonNamed(harness.shadow(), "Fill the page");
  press(fill);
  press(fill);
  await flush();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(fill.disabled, true);
  release({ ok: false, message: "done" });
  await flush();
});

test("an answer for a panel that has since been replaced is not drawn", async () => {
  const content = [element({ fields: [field({ source: "Cost centre" })] })];
  const evaluation = evaluationFor(content, { "Cost centre": "Centre de coût" });
  const harness = load();
  let release;
  withFill(harness, () => new Promise((resolve) => { release = resolve; }));
  show(harness, draftFrom(content));
  const box = findAll(harness.shadow(), (node) => node.tagName === "TEXTAREA")[0];
  box.value = "reply text";
  press(buttonNamed(harness.shadow(), "Fill the page"));

  harness.ui.open({ fingerprint: "ta-test-2", context: {}, callbacks: harness.callbacks });
  release(filledAnswer(evaluation, [1]));
  await flush();
  assert.doesNotMatch(harness.text(), /Filled/);
});

test("an uploaded file lands in the box and fills nothing by itself", async () => {
  const harness = load();
  const calls = withFill(harness, { ok: true });
  show(harness, draftFrom([element({ fields: [field({ source: "Cost centre" })] })]));
  press(buttonNamed(harness.shadow(), "Upload a file instead"));
  const picker = findAll(harness.shadow(), (node) => node.tagName === "INPUT" && node.type === "file")[0];
  assert.ok(picker && picker.clicked === 1, "the link opens the file picker");
  picker.files = [{ name: "reply.json", size: 12, text: () => Promise.resolve("{\"rows\":[]}") }];
  (picker.handlers.change || []).forEach((handler) => handler({ target: picker }));
  await flush();

  assert.strictEqual(findAll(harness.shadow(), (node) => node.tagName === "TEXTAREA")[0].value, "{\"rows\":[]}");
  assert.strictEqual(calls.length, 0, "choosing a file does not write to the page");
  assert.match(harness.text(), /Loaded reply\.json\. Press Fill the page\./);
});

test("shared translations a fill wrote are named once, as the draft named them", async () => {
  const content = [element({ groupName: "Variable: Cost centre", fields: [field({ source: "Cost centre" })] })];
  const evaluation = evaluationFor(content, { "Cost centre": "Centre de coût" });
  assert.strictEqual(evaluation.rows[0].instanceWide, true);
  const harness = load();
  withFill(harness, filledAnswer(evaluation, [1]));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");
  assert.match(harness.text(),
    /One translation filled on this page is shared: publishing it changes that translation for every catalog item/);
});

test("the old text of a replaced translation survives the next click, and a refusal", async () => {
  /* Codex review, P2: after Fill anyway on a second row the worker evaluates
   * the first row as unchanged -- the page now holds its replacement -- and
   * the rebuilt report dropped the old text while the replacement stayed on
   * the page, unpublished. The shared warning went the same way. */
  const content = [
    element({ groupName: "Variable: Cost centre",
      fields: [field({ source: "Cost centre", target: "Centre de frais", locked: false })] }),
    element({ groupName: "Variable: Charge", fields: [field({ source: "Charge ${account}" })] }),
  ];
  const answers = { "Cost centre": "Centre de coût", "Charge ${account}": "Débiter le compte" };
  const first = evaluationFor(content, answers);
  const costCentre = first.rows.find((row) => row.source === "Cost centre");
  const charge = first.rows.find((row) => row.source === "Charge ${account}");
  assert.strictEqual(charge.warning, "placeholder");
  /* The page after the first fill: the replacement is in the box. */
  const live = clone(content);
  live[0].fieldInfo[0].translatedValue = "Centre de coût";
  const second = evaluationFor(content, answers, live);
  assert.strictEqual(second.rows.find((row) => row.source === "Cost centre").verdict, "unchanged");

  const harness = load();
  withFill(harness, (request, call) => {
    if (call === 1) return Promise.resolve(filledAnswer(first, [costCentre.k]));
    if (call === 2) return Promise.resolve(filledAnswer(second, [charge.k]));
    return Promise.resolve({ ok: false, code: "not_written", message: "The page changed just as it was being filled, so nothing was filled." });
  });
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");
  assert.match(harness.text(), /Replaced 1 existing translation.*Was“Centre de frais”/);
  assert.match(harness.text(), /One translation filled on this page is shared/);

  press(buttonNamed(harness.shadow(), "Fill anyway"));
  await flush();
  let text = harness.text();
  assert.match(text, /Filled 1 field\./);
  assert.match(text, /1 translation in the reply is already on the page/);
  assert.match(text, /Replaced 1 existing translation.*Was“Centre de frais”/, "the old text is still there to type back");
  assert.match(text, /2 translations filled on this page are shared/, "both fills count, not only this click's");

  press(buttonNamed(harness.shadow(), "Fill from a different reply"));
  await pasteAndFill(harness, "another reply");
  text = harness.text();
  assert.match(text, /The page changed just as it was being filled/);
  assert.match(text, /Replaced 1 existing translation.*Was“Centre de frais”/, "a refusal changes nothing on the page");
  assert.match(text, /2 translations filled on this page are shared/);
});

test("a shared row that half landed names the field that missed, and keeps the old text of the one that did", async () => {
  /* Codex review, P2: several fields can share one row. When one lands and
   * another misses, the row was neither written nor unwritten: it is a
   * replacement to remember and a field to check, and the panel has to say
   * which. */
  const content = [
    element({ groupName: "Variable: Cost centre", label: "Question", id: "Variable: Cost centre: Question",
      fields: [field({ source: "Cost centre", target: "Centre de frais", locked: false })] }),
    element({ groupName: "Variable: Cost centre (copy)", label: "Question", id: "Variable: Cost centre (copy): Question",
      fields: [field({ source: "Cost centre", target: "Centre de frais", locked: false })] }),
  ];
  const evaluation = evaluationFor(content, { "Cost centre": "Centre de coût" });
  assert.strictEqual(evaluation.rows.length, 1, "one translation, two fields");
  const row = evaluation.rows[0];
  assert.strictEqual(row.members.length, 2);
  const missedMember = row.members[1];
  const harness = load();
  withFill(harness, filledAnswer(evaluation, [row.k], {
    landed: 1, attempted: 2, missed: [row.k], missedFields: [{ k: row.k, identityKey: missedMember.identityKey }],
  }));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");

  const text = harness.text();
  assert.match(text, /Filled 1 of 2 fields — 1 did not take on the page/);
  assert.match(text, /Replaced 1 existing translation.*Was“Centre de frais”/, "the field that landed replaced its text");
  assert.match(text, /One translation filled on this page is shared/);
  const notFilled = text.indexOf("Not filled (1)");
  assert.ok(notFilled > 0);
  assert.ok(text.indexOf("did not take on the page for “" + missedMember.elementId + "”, though the rest of this row did") > notFilled,
    "the member that missed is named, under Not filled");
});

test("a fill the page could not confirm keeps every attempted row's old text, and says to check each", async () => {
  /* Codex review, P2: the event fired, then reading the model back threw. The
   * worker used to report that as written with nothing landed and nothing
   * missed -- a success with a count of zero. */
  const content = [element({ groupName: "Variable: Cost centre",
    fields: [field({ source: "Cost centre", target: "Centre de frais", locked: false })] })];
  const evaluation = evaluationFor(content, { "Cost centre": "Centre de coût" });
  const harness = load();
  withFill(harness, filledAnswer(evaluation, [1], { confirmed: false, why: "boom", landed: 0, attempted: 1 }));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");

  const text = harness.text();
  assert.match(text, /Attempted to fill 1 field, but the page could not confirm it \(boom\)\. Check each one on the page before you publish\./);
  assert.doesNotMatch(text, /Not filled/);
  assert.match(text, /Replaced 1 existing translation.*Attempted“Centre de coût”Was“Centre de frais”/,
    "the old text is kept, and the write is labelled as attempted, not filled");
  assert.match(text, /One translation filled or attempted on this page is shared/);
  assert.doesNotMatch(text, /never confirmed by the page/, "the headline already says so on this report");

  /* Codex review, P2: after a refused click the uncertainty vanished while
   * the replacement and shared claims stayed. */
  press(buttonNamed(harness.shadow(), "Fill from a different reply"));
  harness.callbacks.onFill = () => Promise.resolve({ ok: false, code: "not_written", message: "The page changed just as it was being filled, so nothing was filled." });
  await pasteAndFill(harness, "another reply");
  const later = harness.text();
  assert.match(later, /1 attempted fill on this page was never confirmed by the page — check that field before you publish/);
  assert.match(later, /Attempted“Centre de coût”Was“Centre de frais”/);
  assert.match(later, /filled or attempted on this page is shared/);
  assert.doesNotMatch(later, /Filled“/);
});

test("the history is kept by field, so a reused row number and a later-landing member both survive", async () => {
  /* Codex review, P2: keyed by row number, the history froze a whole draft
   * row on first sight. A reply from another draft reusing the number for a
   * different destination lost its old text, and a member of a shared row
   * that landed only on a later fill was never remembered. */
  /* The two members hold DIFFERENT old text (one of them none), so a history
   * holding one member renders differently from one holding both (Codex:
   * with identical old text, a join that never happened still passed). */
  const shared = [
    element({ groupName: "Variable: Cost centre", label: "Question", id: "Variable: Cost centre: Question",
      fields: [field({ source: "Cost centre", target: "Centre de frais", locked: false })] }),
    element({ groupName: "Variable: Cost centre (copy)", label: "Question", id: "Variable: Cost centre (copy): Question",
      fields: [field({ source: "Cost centre" })] }),
  ];
  const first = evaluationFor(shared, { "Cost centre": "Centre de coût" });
  const row = first.rows[0];
  assert.strictEqual(row.members.length, 2);
  const harness = load();
  const answers = [
    /* Click 1: only the first member lands. */
    filledAnswer(first, [row.k], {
      landed: 1, attempted: 2, missed: [row.k], missedFields: [{ k: row.k, identityKey: row.members[1].identityKey }],
    }),
    /* Click 2: the second member lands (the page took it this time). */
    filledAnswer(first, [row.k], { landed: 2, attempted: 2 }),
  ];
  let click = 0;
  harness.callbacks.onFill = () => Promise.resolve(answers[click++]);
  show(harness, draftFrom(shared));
  await pasteAndFill(harness, "reply text");
  let text = harness.text();
  assert.match(text, /Replaced 1 existing translation/);
  const pairText = () => {
    const replaced = findAll(harness.shadow(), (node) =>
      node.tagName === "LI" && node.parentNode && node.parentNode.className === "report-list")[0];
    return replaced.children.find((child) => child.className === "pair").children.map((child) => child.textContent);
  };
  assert.deepStrictEqual(pairText(), ["Filled", "“Centre de coût”", "Was", "“Centre de frais”"],
    "one member so far, so one unnamed line");
  assert.match(text, /One translation filled on this page is shared/, "one destination, however many fields");

  press(buttonNamed(harness.shadow(), "Fill from a different reply"));
  await pasteAndFill(harness, "reply text again");
  text = harness.text();
  assert.deepStrictEqual(pairText(), [
    "Filled", "“Centre de coût”",
    "Was", "“Centre de frais”Variable: Cost centre: Question",
    "", "“(empty)”Variable: Cost centre (copy): Question",
  ], "the later member joined, and the two old values are shown apart, each named");
  assert.match(text, /One translation filled on this page is shared/, "still one destination");

  /* A second draft on the same page reuses row number 1 for a different
   * destination: its old text must not be swallowed by the first row's. */
  const other = [element({ groupName: "Variable: Approver", label: "Question", id: "Variable: Approver: Question",
    fields: [field({ source: "Approver", target: "Approbateur", locked: false })] })];
  const second = evaluationFor(other, { Approver: "Valideur" });
  assert.strictEqual(second.rows[0].k, row.k, "the fixture really does reuse the number");
  harness.callbacks.onFill = () => Promise.resolve(filledAnswer(second, [second.rows[0].k]));
  press(buttonNamed(harness.shadow(), "Fill from a different reply"));
  await pasteAndFill(harness, "a reply for another draft");
  text = harness.text();
  assert.match(text, /Replaced 2 existing translations/);
  assert.match(text, /Was“Centre de frais”/);
  assert.match(text, /“Approver”Filled“Valideur”Was“Approbateur”/);
  assert.match(text, /2 translations filled on this page are shared/);
});

test("Overwrite from a per-field display binds every field to the value shown for it", async () => {
  const content = [
    element({ groupName: "Variable: Cost centre", label: "Question", id: "Variable: Cost centre: Question",
      fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Variable: Cost centre (copy)", label: "Question", id: "Variable: Cost centre (copy): Question",
      fields: [field({ source: "Cost centre" })] }),
  ];
  const live = clone(content);
  live[0].fieldInfo[0].translatedValue = "typed by hand";
  const evaluation = evaluationFor(content, { "Cost centre": "Centre de coût" }, live);
  const row = evaluation.rows[0];
  const harness = load();
  const calls = withFill(harness, filledAnswer(evaluation, []));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");
  press(buttonNamed(harness.shadow(), "Overwrite"));
  await flush();
  assert.deepStrictEqual(calls[1].overrides, [{
    k: row.k,
    reviewed: [
      { identityKey: row.members[0].identityKey, target: "typed by hand" },
      { identityKey: row.members[1].identityKey, target: "" },
    ],
  }]);
});

test("a field written again by a later reply keeps its first old text but takes the later write's uncertainty", async () => {
  /* Codex review, P2: a confirmed fill, then a different reply writing the
   * same field whose read-back failed, then a refused reply. The history
   * skipped the second write, so the field stayed "Filled" with the first
   * target while the page held an unconfirmed second one. */
  const content = [element({ groupName: "Variable: Cost centre",
    fields: [field({ source: "Cost centre", target: "Centre de frais", locked: false })] })];
  const first = evaluationFor(content, { "Cost centre": "Centre de coût" });
  /* The page after the first fill, and a second reply with a different translation. */
  const live = clone(content);
  live[0].fieldInfo[0].translatedValue = "Centre de coût";
  const second = evaluationFor(content, { "Cost centre": "Centre de coûts" }, live);
  assert.strictEqual(second.rows[0].verdict, "edited", "the page moved since the draft: the first fill is on it");
  const harness = load();
  const answers = [
    filledAnswer(first, [1]),
    Object.assign(filledAnswer(second, [1]), { confirmed: false, why: "boom", landed: 0, attempted: 1 }),
    { ok: false, code: "not_written", message: "The page changed just as it was being filled, so nothing was filled." },
  ];
  let click = 0;
  harness.callbacks.onFill = () => Promise.resolve(answers[click++]);
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply one");
  assert.match(harness.text(), /Filled“Centre de coût”Was“Centre de frais”/);

  press(buttonNamed(harness.shadow(), "Fill from a different reply"));
  await pasteAndFill(harness, "reply two");
  let text = harness.text();
  assert.match(text, /Attempted to fill 1 field, but the page could not confirm it/);
  assert.match(text, /Attempted“Centre de coûts”Was“Centre de frais”/,
    "the later target, the first old text, and the later write's uncertainty");
  assert.doesNotMatch(text, /Filled“/);

  press(buttonNamed(harness.shadow(), "Fill from a different reply"));
  await pasteAndFill(harness, "reply three");
  text = harness.text();
  assert.match(text, /1 attempted fill on this page was never confirmed by the page/);
  assert.match(text, /Attempted“Centre de coûts”Was“Centre de frais”/);
  assert.match(text, /filled or attempted on this page is shared/);
  assert.doesNotMatch(text, /Filled“/);
});

test("a shared row whose fields hold different values shows every value, each named", async () => {
  /* Codex review note: the display collapsed a shared row's distinct values
   * into one line and left an empty member out, so a user reviewing an
   * Overwrite could not see every value it would replace. */
  const content = [
    element({ groupName: "Variable: Cost centre", label: "Question", id: "Variable: Cost centre: Question",
      fields: [field({ source: "Cost centre" })] }),
    element({ groupName: "Variable: Cost centre (copy)", label: "Question", id: "Variable: Cost centre (copy): Question",
      fields: [field({ source: "Cost centre" })] }),
  ];
  const live = clone(content);
  live[0].fieldInfo[0].translatedValue = "typed by hand";
  const evaluation = evaluationFor(content, { "Cost centre": "Centre de coût" }, live);
  assert.strictEqual(evaluation.rows.length, 1);
  assert.strictEqual(evaluation.rows[0].verdict, "edited");
  const harness = load();
  withFill(harness, filledAnswer(evaluation, []));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");

  const entry = findAll(harness.shadow(), (node) =>
    node.tagName === "LI" && node.parentNode && node.parentNode.className === "report-list")[0];
  const pair = entry.children.find((child) => child.className === "pair");
  assert.deepStrictEqual(pair.children.map((child) => child.textContent), [
    "Reply", "“Centre de coût”",
    "On the page", "“typed by hand”Variable: Cost centre: Question",
    "", "“(empty)”Variable: Cost centre (copy): Question",
  ]);

  /* And when the fields agree, one line, unnamed. */
  const agreed = clone(content);
  agreed.forEach((element_) => { element_.fieldInfo[0].translatedValue = "typed by hand"; });
  const same = evaluationFor(content, { "Cost centre": "Centre de coût" }, agreed);
  const second = load();
  withFill(second, filledAnswer(same, []));
  show(second, draftFrom(content));
  await pasteAndFill(second, "reply text");
  const onePair = findAll(second.shadow(), (node) => node.className === "pair")[0];
  assert.deepStrictEqual(onePair.children.map((child) => child.textContent),
    ["Reply", "“Centre de coût”", "On the page", "“typed by hand”"]);
});

/* ------------------------------------------------------------------ *
 * Script messages (owner request, 2026-09-16)
 *
 * A message is stored in sys_ui_message by key, and what shares it is every
 * script asking for that key, so the panel names it as a message, links to
 * the row a publish would write, and offers no usage list it cannot build.
 * ------------------------------------------------------------------ */

function message(options) {
  const opts = options || {};
  const params = { scope: "global" };
  if (opts.key !== undefined) params.key = opts.key;
  const info = { originalValue: opts.source, isFieldLocked: !!opts.locked, additionalParameters: params };
  if (opts.target !== undefined) info.translatedValue = opts.target;
  return info;
}

function script(fields) {
  return element({ groupName: "Catalog Client Script: Lookup", label: "Script", fields });
}

test("a script message is warned about as a message, and linked to its stored row only", () => {
  const harness = load();
  show(harness, draftFrom([script([message({ key: "lookup.start_date_missing", source: "Start date is missing." })])]));
  const text = harness.text();
  assert.match(text, /One of these translations is a script message: publishing it changes that message for every script on this instance that uses the same message key\./);
  assert.doesNotMatch(text, /every catalog item/, "no catalog item shares a message");
  assert.match(text, /Each links to where its French translation is stored — empty unless/);
  assert.match(text, /Script message · Catalog Client Script: Lookup/);
  assert.strictEqual(buttonNamed(harness.shadow(), "Where this text is used ↗"), null,
    "the scripts asking for a key are not something a list filter can find");

  press(buttonNamed(harness.shadow(), "Stored French translation ↗"));
  assert.deepStrictEqual(harness.opened, [
    "https://example.service-now.com/sys_ui_message_list.do?sysparm_query=" +
      "key%3Dlookup.start_date_missing%5Elanguage%3Dfr",
  ]);
});

test("fields and messages on one item each get their own sentence", () => {
  const harness = load();
  show(harness, draftFrom([
    element({ fields: [field({ source: "Cost centre" })] }),
    script([message({ source: "Pick a date" })]),
    script([message({ source: "Pick a start date" })]),
  ]));
  const text = harness.text();
  assert.match(text, /One of these translations is shared: publishing it changes that translation for every catalog item/);
  assert.match(text, /2 of these translations are script messages: publishing them changes those messages for every script/);
  assert.match(text, /Each links to where its French translation is stored, and each field also to the fields that use its text/);
});

test("a message key no list filter can carry gets no link, and says so", () => {
  const harness = load();
  show(harness, draftFrom([script([message({ source: "Pick one ^ or the other" })])]));
  assert.strictEqual(verifyButtons(harness.shadow()).length, 0);
  assert.match(harness.text(), /no list links: a list filter cannot express this text/);
});

test("a message that looks like a key is listed, and linked to that key in every language", () => {
  const harness = load();
  show(harness, draftFrom([
    script([message({ source: "help.cost_centre" })]),
    element({ fields: [field({ source: "Cost centre" })] }),
  ]));
  assert.match(harness.text(), /script messages that look like a key/);
  const toggle = bucketToggle(harness.shadow(), "script messages that look like a key");
  assert.ok(toggle, "the count alone cannot say which key needs its text");
  const detail = detailOf(toggle);
  press(toggle);
  assert.match(detail.textContent, /“help\.cost_centre”/);
  const link = verifyButtons(detail)[0];
  assert.strictEqual(link.textContent, "Messages for this key ↗");
  press(link);
  assert.deepStrictEqual(harness.opened, [
    "https://example.service-now.com/sys_ui_message_list.do?sysparm_query=key%3Dhelp.cost_centre",
  ]);
});

test("an already-translated message links to its stored row in the target language", () => {
  const harness = load();
  show(harness, draftFrom([
    script([message({ source: "Pick a date", locked: true, target: "Choisissez une date" })]),
    element({ fields: [field({ source: "Cost centre" })] }),
  ]));
  const detail = detailOf(bucketToggle(harness.shadow(), "already translated"));
  assert.match(detail.textContent, /→ “Choisissez une date”/);
  press(verifyButtons(detail)[0]);
  assert.deepStrictEqual(harness.opened, [
    "https://example.service-now.com/sys_ui_message_list.do?sysparm_query=key%3DPick%20a%20date%5Elanguage%3Dfr",
  ]);
});

test("a lock in the row's own element is not named as another field", async () => {
  /* Review finding: a locked appearance of the key added to the same script
   * carried that script's element id, so the report said the row shared a
   * translation with itself. */
  const content = [script([message({ source: "Pick a date" })])];
  const live = clone(content);
  live[0].fieldInfo.push(message({ source: "pick a date", locked: true, target: "Choisissez une date" }));
  const evaluation = evaluationFor(content, { "Pick a date": "Choisissez une date" }, live);
  assert.strictEqual(evaluation.rows[0].verdict, "locked");
  const harness = load();
  withFill(harness, filledAnswer(evaluation, []));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");
  assert.match(harness.text(), /locked — unlock it on the page to fill this/);
  assert.doesNotMatch(harness.text(), /“Catalog Client Script: Lookup: Script” is locked/);

  /* A lock in another script is another place, and is named. Both scripts
   * were there at draft time -- a new section would refuse the whole reply --
   * and the second was locked since. */
  const two = [
    script([message({ source: "Pick a date" })]),
    element({ groupName: "Catalog Client Script: Submit", label: "Script", fields: [message({ source: "Pick a date" })] }),
  ];
  const lockedSince = clone(two);
  lockedSince[1].fieldInfo[0].isFieldLocked = true;
  const other = load();
  withFill(other, filledAnswer(evaluationFor(two, { "Pick a date": "Choisissez une date" }, lockedSince), []));
  show(other, draftFrom(two));
  await pasteAndFill(other, "reply text");
  assert.match(other.text(), /“Catalog Client Script: Submit: Script” is locked, and they share one translation/);
});

test("a message a fill wrote is named as a shared script message, not a catalog field", async () => {
  const content = [script([message({ source: "Pick a date" })])];
  const evaluation = evaluationFor(content, { "Pick a date": "Choisissez une date" });
  assert.strictEqual(evaluation.rows[0].store, "sys_ui_message");
  const harness = load();
  withFill(harness, filledAnswer(evaluation, [1]));
  show(harness, draftFrom(content));
  await pasteAndFill(harness, "reply text");
  const text = harness.text();
  assert.match(text,
    /One script message filled on this page is shared: publishing it changes that message for every script on this instance that uses the same message key\./);
  assert.doesNotMatch(text, /One translation filled on this page is shared/);
});

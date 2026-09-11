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
  const links = findAll(shadow, (node) => node.tagName === "BUTTON" && node.className === "secondary");
  assert.strictEqual(links.length, 1, "and one escape hatch, drawn as a link");
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

test("a text a list filter cannot express gets no link rather than a wrong one", () => {
  const harness = load();
  show(harness, draftFrom([element({ fields: [field({ source: "Up ^ down" })] })]));
  assert.strictEqual(buttonNamed(harness.shadow(), "Where this text is used ↗"), null);
  assert.match(harness.text(), /cannot express \^/);
});

test("a table name that is not a plain identifier never becomes a link", () => {
  const harness = load();
  show(harness, draftFrom([element({
    fields: [field({ source: "Cost centre", table: "x/../../elsewhere" })],
  })]));
  assert.strictEqual(buttonNamed(harness.shadow(), "Where this text is used ↗"), null);
  assert.deepStrictEqual(harness.opened, []);
});

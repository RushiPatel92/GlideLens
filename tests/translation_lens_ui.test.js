/*
 * Tests for translation_lens_ui.js, the Translation Lens panel.
 *
 *   node --test tests/translation_lens_ui.test.js
 *
 * DEV-ONLY, like its siblings. There is no browser here: the module is loaded
 * under node:vm against a deliberately small DOM shim (about 90 lines below)
 * that implements only the handful of calls the panel actually makes --
 * createElement, appendChild, textContent, setAttribute, addEventListener,
 * attachShadow and focus. The panel is written against that same small
 * surface, with element references held rather than re-queried, which is what
 * makes this possible without a DOM library.
 *
 * What is worth pinning here is not the pixels. It is the discipline the
 * feature's correctness rests on:
 *   - a late call from a superseded run must be discarded, never painted;
 *   - progressive sections must accumulate, and the completed result must
 *     replace them rather than stack a second copy;
 *   - absent data must never read as coverage -- an unavailable row stays
 *     unavailable and stays out of the denominator;
 *   - a blank translation row is Blank, not Missing;
 *   - the report never carries a value, a URL, a hostname or a sys_id;
 *   - Copy writes exactly what onCopyReport returned, and navigation only
 *     ever goes through onOpenUrl.
 *
 * Every fixture is synthetic. No instance name, hostname, sys_id or real
 * translation appears in this file.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "translation_lens_ui.js"),
  "utf8"
);
/* Loaded only by load({ withEngine: true }). Every other test here runs the
 * panel with no engine on purpose, which exercises its local fallbacks; the
 * engine-backed tests exist to pin the contract between the two files. */
const ENGINE_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "translation_lens.js"),
  "utf8"
);
const ORIGIN = "https://example.service-now.com";
const HOST_ID = "snh-translation-lens-results";

/* ------------------------------------------------------------------ *
 * The DOM shim
 * ------------------------------------------------------------------ */

function createDom() {
  let activeElement = null;

  class El {
    constructor(tag) {
      this.tagName = String(tag || "div").toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = Object.create(null);
      this.handlers = Object.create(null);
      this.style = {};
      this.className = "";
      this.id = "";
      this.title = "";
      this.value = "";
      this.disabled = false;
      this.shadowRoot = null;
      this._text = "";
    }
    get textContent() {
      /* Deliberately unlike the real DOM in one narrow way: the panel's own
       * stylesheet is 300 lines of CSS living in a <style> child of the
       * shadow root, and a real textContent would fold all of it into every
       * assertion below -- "100%" and "%" both appear in it. Skipping STYLE
       * makes a text assertion mean "the panel says this to the reader". */
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
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name] : null;
    }
    addEventListener(type, handler) {
      (this.handlers[type] = this.handlers[type] || []).push(handler);
    }
    attachShadow() {
      const root = new El("#shadow");
      root.host = this;
      this.shadowRoot = root;
      return root;
    }
    focus() {
      activeElement = this;
      let node = this;
      while (node.parentNode) node = node.parentNode;
      if (node.tagName === "#SHADOW") node.activeElement = this;
    }
    select() { /* clipboard fallback only */ }
  }

  const document = {
    createElement: (tag) => new El(tag),
    documentElement: new El("html"),
    body: new El("body"),
    get activeElement() { return activeElement; },
    execCommand: () => true,
  };
  const window = {
    handlers: Object.create(null),
    addEventListener(type, handler) {
      (this.handlers[type] = this.handlers[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this.handlers[type] || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
  };
  return { El, document, window, setActive: (node) => { activeElement = node; } };
}

function walk(node, visit) {
  (node.children || []).forEach((child) => {
    visit(child);
    walk(child, visit);
  });
}

function findAll(root, predicate) {
  const out = [];
  walk(root, (node) => { if (predicate(node)) out.push(node); });
  return out;
}

function find(root, predicate) {
  return findAll(root, predicate)[0] || null;
}

function buttonWithText(root, text) {
  return find(root, (node) => node.tagName === "BUTTON" && node.textContent === text);
}

/* Ancestors contain their descendants' text, so a contains-match has to be
 * pinned to the button itself or it returns the whole overlay. */
function buttonContaining(root, text) {
  return find(root, (node) => node.tagName === "BUTTON" && node.textContent.includes(text));
}

function click(node) {
  assert.ok(node, "expected a clickable node");
  (node.handlers.click || []).forEach((handler) => handler({
    target: node,
    stopPropagation() {},
    preventDefault() {},
  }));
}

function pressKey(harness, key) {
  (harness.window.handlers.keydown || []).slice().forEach((handler) => handler({
    key,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {},
  }));
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

function load(options) {
  const opts = options || {};
  const dom = opts.withDom === false ? null : createDom();
  const sandbox = {
    URL,
    setTimeout,
    clearTimeout,
    Promise,
    console,
  };
  if (dom) {
    sandbox.document = dom.document;
    sandbox.window = dom.window;
    sandbox.location = { origin: ORIGIN, href: ORIGIN + "/incident.do" };
    sandbox.navigator = {
      clipboard: {
        written: [],
        writeText(text) {
          sandbox.navigator.clipboard.written.push(String(text));
          return Promise.resolve();
        },
      },
    };
  }
  sandbox.globalThis = sandbox;
  sandbox.URLSearchParams = URLSearchParams;
  vm.createContext(sandbox);
  if (opts.withEngine) {
    vm.runInContext(ENGINE_SOURCE, sandbox, { filename: "translation_lens.js" });
  }
  vm.runInContext(SOURCE, sandbox, { filename: "translation_lens_ui.js" });
  return {
    sandbox,
    ui: sandbox.SNTranslationLensUI,
    document: dom && dom.document,
    window: dom && dom.window,
    clipboard: sandbox.navigator && sandbox.navigator.clipboard,
    shadow() {
      const host = (dom.document.documentElement.children || [])
        .find((node) => node.id === HOST_ID);
      return host ? host.shadowRoot : null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Synthetic fixtures
 * ------------------------------------------------------------------ */

const LANGUAGES = {
  active: [
    { id: "en", sysId: "", name: "English", fallbackRef: "" },
    { id: "fr", sysId: "", name: "French", fallbackRef: "" },
    { id: "de", sysId: "", name: "German", fallbackRef: "" },
  ],
  baseLanguage: "en",
  assumedBase: false,
  fallbackById: { en: "", fr: "", de: "" },
  countedLanguageIds: ["fr", "de"],
  visibleLanguageIds: ["fr", "de"],
  activeCount: 3,
  shownCount: 2,
};

function makeRow(over) {
  return Object.assign({
    id: "label:widget_name",
    element: "widget_name",
    label: "widget_name",
    aspect: "label",
    store: "sys_documentation",
    internalType: "string",
    definingTable: "demo_widget",
    concreteTable: "demo_widget",
    registrationTable: "demo_widget",
    source: "",
    states: {
      fr: { state: "direct", direct: true, duplicateCount: 0 },
      de: { state: "missing", direct: false, duplicateCount: 0 },
    },
    coverage: { covered: 1, counted: 2, percent: 50, missing: ["de"], unavailable: [] },
    evidence: {},
    links: null,
  }, over || {});
}

function makeSection(id, label, rows, over) {
  return Object.assign({ id, label, rows: rows || [] }, over || {});
}

function makeResult(over) {
  const result = Object.assign({
    version: "test",
    context: { mode: "form", surface: "Classic form", table: "demo_widget", isNewRecord: false },
    languages: LANGUAGES,
    sections: [
      makeSection("labels", "Field Labels", [makeRow()]),
      makeSection("messages", "Messages", [], { scan: { dynamicCount: 2, invalid: [], capped: false, omittedCount: 0 }, separateHeadline: true }),
    ],
    failures: [],
    unavailable: false,
  }, over || {});
  result.summary = { covered: 1, counted: 2, percent: 50, complete: 0, partial: 1, none: 0, rowCount: 1 };
  result.messageSummary = { covered: 0, counted: 0, percent: null, complete: 0, partial: 0, none: 0, rowCount: 0 };
  return result;
}

function openPanel(harness, over) {
  const calls = { close: [], open: [], copy: 0, lookup: [] };
  const options = Object.assign({
    fingerprint: "run-1",
    context: { mode: "form", surface: "Classic form", table: "demo_widget", isNewRecord: false },
    callbacks: {
      onClose: (info) => calls.close.push(info),
      onOpenUrl: (url) => { calls.open.push(url); return Promise.resolve(); },
      onCopyReport: () => { calls.copy++; return "REPORT TEXT"; },
      onLookupMessage: (key) => { calls.lookup.push(key); return Promise.resolve({ ok: true, row: makeRow() }); },
    },
  }, over || {});
  assert.strictEqual(harness.ui.open(options), true, "open() should mount");
  return calls;
}

/* ------------------------------------------------------------------ *
 * Contract surface
 * ------------------------------------------------------------------ */

test("the module exposes exactly the six contracted methods", () => {
  const harness = load();
  assert.ok(harness.ui, "SNTranslationLensUI missing from globalThis");
  assert.deepStrictEqual(
    Object.keys(harness.ui).sort(),
    ["close", "formatResultsAsText", "open", "setProgress", "showError", "showResults"]
  );
  Object.keys(harness.ui).forEach((name) => {
    assert.strictEqual(typeof harness.ui[name], "function", name + " must be callable");
  });
});

test("the module loads with no DOM at all and refuses to open", () => {
  const harness = load({ withDom: false });
  assert.ok(harness.ui, "the module must still define its API");
  assert.strictEqual(harness.ui.open({ fingerprint: "x" }), false);
});

test("every call before a panel exists is ignored rather than thrown", () => {
  const harness = load();
  assert.strictEqual(harness.ui.setProgress({ fingerprint: "a" }), false);
  assert.strictEqual(harness.ui.showResults({ fingerprint: "a", result: makeResult() }), false);
  assert.strictEqual(harness.ui.showError({ fingerprint: "a", message: "x" }), false);
  assert.strictEqual(harness.ui.close({ fingerprint: "a" }), false);
  assert.strictEqual(harness.ui.setProgress(), false);
  assert.strictEqual(harness.ui.close(), false);
});

/* ------------------------------------------------------------------ *
 * Mount, identity, accessibility
 * ------------------------------------------------------------------ */

test("open() mounts a titled dialog before any result arrives", () => {
  const harness = load();
  openPanel(harness);
  const shadow = harness.shadow();
  assert.ok(shadow, "a closed shadow root should be attached");
  const dialog = find(shadow, (node) => node.getAttribute("role") === "dialog");
  assert.ok(dialog, "role=dialog is required");
  assert.strictEqual(dialog.getAttribute("aria-modal"), "true");
  const heading = find(shadow, (node) => node.tagName === "H2");
  assert.strictEqual(heading.textContent, "Translation Lens");
  assert.strictEqual(dialog.getAttribute("aria-labelledby"), heading.id);
  assert.ok(shadow.textContent.includes("Classic form"), "the surface belongs in the subtitle");
  assert.ok(shadow.textContent.includes("demo_widget"), "the table belongs in the subtitle");
  assert.ok(shadow.textContent.includes("Reading"), "a progress state shows before results");
});

test("a new record is identified in the subtitle and its values are not claimed", () => {
  const harness = load();
  openPanel(harness, {
    context: { mode: "form", surface: "Classic form", table: "demo_widget", isNewRecord: true },
  });
  const text = harness.shadow().textContent;
  assert.ok(text.includes("New record"), "a new record must say so");
  assert.ok(
    text.includes("no saved value to assess"),
    "and must say why values are absent rather than implying coverage"
  );
});

test("Escape closes the panel and reports the close to the caller", () => {
  const harness = load();
  const calls = openPanel(harness);
  pressKey(harness, "Escape");
  assert.strictEqual(harness.shadow(), null, "the host element should be removed");
  assert.strictEqual(calls.close.length, 1, "onClose tells content.js the run was dismissed");
});

test("focus returns to the invoking element when the panel closes", () => {
  const harness = load();
  const invoker = harness.document.createElement("button");
  let focused = 0;
  invoker.focus = () => { focused++; };
  harness.document.documentElement.appendChild(invoker);
  const dom = harness.document;
  Object.defineProperty(dom, "activeElement", { get: () => invoker, configurable: true });
  openPanel(harness);
  pressKey(harness, "Escape");
  assert.ok(focused > 0, "the invoker must get focus back");
});

test("a programmatic close does not fire onClose, but a user close does", () => {
  const harness = load();
  const calls = openPanel(harness);
  assert.strictEqual(harness.ui.close({ fingerprint: "run-1", reason: "superseded" }), true);
  assert.strictEqual(calls.close.length, 0, "the orchestrator closing its own panel is not a dismissal");

  const second = openPanel(harness, { fingerprint: "run-2" });
  const shadow = harness.shadow();
  click(buttonWithText(shadow, "Close"));
  assert.strictEqual(second.close.length, 1);
});

/* ------------------------------------------------------------------ *
 * Fingerprint discipline
 * ------------------------------------------------------------------ */

test("a call carrying another run's fingerprint is discarded, not rendered", () => {
  const harness = load();
  openPanel(harness);

  assert.strictEqual(harness.ui.setProgress({ fingerprint: "run-0", detail: "stale phase" }), false);
  assert.ok(!harness.shadow().textContent.includes("stale phase"));

  const stale = makeResult({
    sections: [makeSection("labels", "Stale Section", [makeRow({ element: "stale_element" })])],
  });
  assert.strictEqual(harness.ui.showResults({ fingerprint: "run-0", result: stale }), false);
  assert.ok(!harness.shadow().textContent.includes("stale_element"));

  assert.strictEqual(harness.ui.showError({ fingerprint: "run-0", message: "stale failure" }), false);
  assert.ok(!harness.shadow().textContent.includes("stale failure"));

  assert.strictEqual(harness.ui.close({ fingerprint: "run-0" }), false);
  assert.ok(harness.shadow(), "a stale close must not take the live panel down");
});

test("a matching fingerprint paints, and progress text updates", () => {
  const harness = load();
  openPanel(harness);
  assert.strictEqual(
    harness.ui.setProgress({ fingerprint: "run-1", phase: "labels", detail: "Reading field labels" }),
    true
  );
  assert.ok(harness.shadow().textContent.includes("Reading field labels"));
});

/* ------------------------------------------------------------------ *
 * Progressive sections
 * ------------------------------------------------------------------ */

test("progressive sections accumulate instead of replacing each other", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({
    fingerprint: "run-1",
    section: makeSection("labels", "Field Labels", [makeRow()]),
    partial: true,
  });
  harness.ui.showResults({
    fingerprint: "run-1",
    section: makeSection("choices", "Choices", [makeRow({
      id: "choices:state", element: "state", label: "state", aspect: "choices", store: "sys_choice",
    })]),
    partial: true,
  });
  const text = harness.shadow().textContent;
  assert.ok(text.includes("Field Labels"), "the first section must survive the second");
  assert.ok(text.includes("Choices"));
  assert.ok(text.includes("widget_name"));
  assert.ok(text.includes("state"));
  assert.ok(text.includes("still reading"), "a partial run must say the counts are partial");
});

test("a section arriving twice is reconciled, not listed twice", () => {
  const harness = load();
  openPanel(harness);
  const first = makeSection("labels", "Field Labels", [makeRow()]);
  harness.ui.showResults({ fingerprint: "run-1", section: first, partial: true });
  const revised = makeSection("labels", "Field Labels", [
    makeRow(), makeRow({ id: "label:widget_state", element: "widget_state", label: "widget_state" }),
  ]);
  harness.ui.showResults({ fingerprint: "run-1", section: revised, partial: true });
  const shadow = harness.shadow();
  const headings = findAll(shadow, (node) => node.className === "group-name" &&
    node.textContent === "Field Labels");
  assert.strictEqual(headings.length, 1, "one group per section id");
  assert.ok(shadow.textContent.includes("widget_state"));
});

test("the completed result replaces progressive state and clears the partial notice", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({
    fingerprint: "run-1",
    section: makeSection("labels", "Field Labels", [makeRow({ element: "provisional_field", label: "provisional_field" })]),
    partial: true,
  });
  assert.ok(harness.shadow().textContent.includes("provisional_field"));
  harness.ui.showResults({ fingerprint: "run-1", result: makeResult(), partial: false });
  const text = harness.shadow().textContent;
  assert.ok(!text.includes("provisional_field"), "the completed result is authoritative");
  assert.ok(text.includes("widget_name"));
  assert.ok(!text.includes("still reading"));
  assert.ok(!text.includes("Reading…"), "the progress banner goes away when the run completes");
});

/* ------------------------------------------------------------------ *
 * Truthfulness of the rendered state
 * ------------------------------------------------------------------ */

test("a blank translation row renders as Blank, not as ordinary Missing", () => {
  const harness = load();
  openPanel(harness);
  const row = makeRow({
    states: {
      fr: { state: "missing", direct: false, blank: true, duplicateCount: 0 },
      de: { state: "missing", direct: false, duplicateCount: 0 },
    },
    coverage: { covered: 0, counted: 2, percent: 0, missing: ["fr", "de"], unavailable: [] },
  });
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({ sections: [makeSection("labels", "Field Labels", [row])] }),
  });
  const shadow = harness.shadow();
  click(buttonWithText(shadow, "Expand all"));
  const chips = findAll(harness.shadow(), (node) => node.className && String(node.className).startsWith("chip "));
  const words = chips.map((chip) => chip.textContent);
  assert.ok(words.some((word) => word.includes("fr") && word.includes("Blank")), "fr is Blank: " + words.join(" | "));
  assert.ok(words.some((word) => word.includes("de") && word.includes("Missing")), "de is Missing");
  assert.ok(
    words.some((word) => word.includes("∅")) && words.some((word) => word.includes("—")),
    "both states carry a symbol as well as words"
  );
});

test("an unavailable row is named, excluded from the count, and never shown as covered", () => {
  const harness = load();
  openPanel(harness);
  const row = makeRow({
    states: {
      fr: { state: "unavailable", reason: "label read unavailable" },
      de: { state: "unavailable", reason: "label read unavailable" },
    },
    coverage: { covered: 0, counted: 0, percent: null, missing: [], unavailable: ["fr", "de"] },
    evidence: { unavailable: true },
  });
  const result = makeResult({ sections: [makeSection("labels", "Field Labels", [row])] });
  result.summary = { covered: 0, counted: 0, percent: null, complete: 0, partial: 0, none: 0, rowCount: 1 };
  result.failures = [{ table: "sys_documentation", status: 403, code: "access", error: "denied", truncated: false }];
  harness.ui.showResults({ fingerprint: "run-1", result });
  const text = harness.shadow().textContent;
  assert.ok(text.includes("Unavailable"), "the row must say it was not read");
  assert.ok(!text.includes("100%"), "an unread row must never read as complete");
  assert.ok(text.includes("nothing counted yet") || text.includes("—"), "no score is claimed");
  assert.ok(text.includes("Read failures"), "the failed read is surfaced");
  assert.ok(text.includes("sys_documentation"));
});

test("an unreadable language list stops any score being claimed at all", () => {
  const harness = load();
  openPanel(harness);
  const result = makeResult({
    languages: null,
    sections: [],
    unavailable: true,
    failures: [{ table: "sys_language", status: 0, code: "transport", error: "read failed" }],
  });
  result.summary = { covered: 0, counted: 0, percent: null, complete: 0, partial: 0, none: 0, rowCount: 0 };
  harness.ui.showResults({ fingerprint: "run-1", result });
  const text = harness.shadow().textContent;
  assert.ok(text.includes("Active languages could not be read"));
  assert.ok(!text.includes("%"), "no percentage may appear when nothing was assessed");
});

test("messages keep their own headline and stay out of the main score", () => {
  const harness = load();
  openPanel(harness);
  const messageRow = makeRow({
    id: "message:demo.key", element: "demo.key", label: "demo.key",
    aspect: "message", store: "sys_ui_message",
    coverage: { covered: 0, counted: 2, percent: 0, missing: ["fr", "de"], unavailable: [] },
    states: { fr: { state: "missing" }, de: { state: "missing" } },
  });
  const result = makeResult({
    sections: [
      makeSection("labels", "Field Labels", [makeRow()]),
      makeSection("messages", "Messages", [messageRow], {
        separateHeadline: true,
        scan: { dynamicCount: 3, invalid: [], capped: false, omittedCount: 0 },
      }),
    ],
  });
  result.summary = { covered: 1, counted: 2, percent: 50, complete: 0, partial: 1, none: 0, rowCount: 1 };
  result.messageSummary = { covered: 0, counted: 2, percent: 0, complete: 0, partial: 0, none: 1, rowCount: 1 };
  harness.ui.showResults({ fingerprint: "run-1", result });
  const text = harness.shadow().textContent;
  assert.ok(text.includes("50%"), "the main score is the non-message score");
  assert.ok(text.includes("Messages 0/2"), "messages carry their own denominator");
  assert.ok(text.includes("counted separately"));
  assert.ok(text.includes("3 dynamic keys were not checked."), "the scan's blind spots are stated");
  assert.ok(text.includes("not of every key this page uses"));
});

test("a fatal error keeps the sections already read and says the rest is unknown", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({
    fingerprint: "run-1",
    section: makeSection("labels", "Field Labels", [makeRow()]),
    partial: true,
  });
  harness.ui.showError({ fingerprint: "run-1", message: "Translation reads exceeded 60 seconds." });
  const text = harness.shadow().textContent;
  assert.ok(text.includes("Translation Lens stopped:"));
  assert.ok(text.includes("Translation reads exceeded 60 seconds."));
  assert.ok(text.includes("widget_name"), "what was read stays on screen");
  assert.ok(text.includes("Everything else is unknown, not covered."));
});

test("an empty section says the engine produced no rows rather than showing coverage", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({ sections: [makeSection("choices", "Choices", [])] }),
  });
  assert.ok(harness.shadow().textContent.includes("produced no rows of this kind"));
});

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

test("the filters narrow the list and the language picker reports n of m", () => {
  const harness = load();
  openPanel(harness);
  const covered = makeRow({
    id: "label:covered_field", element: "covered_field", label: "covered_field",
    states: { fr: { state: "direct", direct: true }, de: { state: "direct", direct: true } },
    coverage: { covered: 2, counted: 2, percent: 100, missing: [], unavailable: [] },
  });
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({
      sections: [
        makeSection("labels", "Field Labels", [makeRow(), covered]),
        makeSection("choices", "Choices", [makeRow({ id: "choices:state", element: "state", label: "state", aspect: "choices" })]),
      ],
    }),
  });
  let shadow = harness.shadow();
  assert.ok(shadow.textContent.includes("2 of 2 languages shown"));

  click(buttonWithText(shadow, "Missing only"));
  shadow = harness.shadow();
  assert.ok(!shadow.textContent.includes("covered_field"), "a fully covered row is not a gap");
  assert.ok(shadow.textContent.includes("widget_name"));

  click(buttonWithText(shadow, "Choices"));
  shadow = harness.shadow();
  assert.ok(!shadow.textContent.includes("widget_name"), "the Labels section is filtered out");
  assert.ok(shadow.textContent.includes("state"));
});

/* The default fixture is covered in French and missing in German, so
 * deselecting German is exactly the difference between "half done" and
 * "done in the language I ship". */
function openPicker(harness) {
  let shadow = harness.shadow();
  click(buttonWithText(shadow, "Expand all"));
  shadow = harness.shadow();
  click(buttonContaining(shadow, "Languages "));
  return harness.shadow();
}

function hideGerman(harness) {
  const shadow = openPicker(harness);
  const boxes = findAll(shadow, (node) => node.tagName === "INPUT" && node.attributes["aria-label"]);
  const german = boxes.find((box) => String(box.attributes["aria-label"]).includes("German"));
  assert.ok(german, "the picker lists every counted language");
  german.checked = false;
  (german.handlers.change || []).forEach((handler) => handler({ target: german }));
  return harness.shadow();
}

function scoreText(shadow) {
  const score = findAll(shadow, (node) => String(node.className).indexOf("score") === 0)[0];
  assert.ok(score, "the headline score is rendered");
  return score.textContent;
}

test("deselecting a language rescopes the score and keeps the all-language score beside it", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({ fingerprint: "run-1", result: makeResult() });
  const shadow = hideGerman(harness);

  assert.ok(shadow.textContent.includes("1 of 2 languages shown"));
  assert.strictEqual(scoreText(shadow), "100%", "the headline counts only the selected language");
  assert.ok(
    shadow.textContent.includes("all 2 languages: 50%"),
    "the all-language score must stay on screen: " + shadow.textContent
  );
  const chips = findAll(shadow, (node) => node.className === "chip gap");
  assert.ok(!chips.some((chip) => chip.textContent.includes("de")), "the hidden language has no chip");
});

test("the complete count follows the selection, which is the whole point of scoping it", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({ fingerprint: "run-1", result: makeResult() });

  const before = harness.shadow().textContent;
  assert.ok(before.includes("0 complete"), "nothing is complete across both languages: " + before);

  const after = hideGerman(harness).textContent;
  assert.ok(after.includes("1 complete"), "the row is complete in the selected language: " + after);
});

test("the per-row bar follows the selection so it cannot contradict the headline", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({ fingerprint: "run-1", result: makeResult() });
  assert.ok(harness.shadow().textContent.includes("1/2"), "the row starts counted over both");

  const shadow = hideGerman(harness);
  const cells = findAll(shadow, (node) => node.className === "cov-num");
  assert.ok(cells.length, "the row still renders a coverage cell");
  const text = cells.map((cell) => cell.textContent).join(" ");
  assert.ok(text.includes("1/1"), "the row is counted over the selection: " + text);
  assert.ok(!text.includes("1/2"), "and never over both while the headline says otherwise");
});

test("deselecting every language counts nothing rather than reporting completion", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({ fingerprint: "run-1", result: makeResult() });
  const opened = openPicker(harness);
  click(buttonWithText(opened, "None"));
  const shadow = harness.shadow();

  assert.strictEqual(scoreText(shadow), "—", "an empty selection scores nothing, not 100%");
  assert.ok(shadow.textContent.includes("nothing counted in the selected languages"));
  assert.ok(
    shadow.textContent.includes("all 2 languages: 50%"),
    "the gap is still on screen: " + shadow.textContent
  );
});

test("an engine that ignores the language scope is never trusted to label a scoped score", () => {
  const harness = load();
  /* Stands in for a stale engine loaded from a service worker that has not
   * restarted: it accepts the second argument and quietly ignores it. Its
   * all-language answer must not be painted as the selected-language one. */
  harness.sandbox.SNTranslationLens = {
    sectionSummary: () => ({
      covered: 1, counted: 2, percent: 50,
      complete: 0, partial: 1, none: 0, rowCount: 1,
    }),
  };
  openPanel(harness);
  harness.ui.showResults({ fingerprint: "run-1", result: makeResult() });
  const shadow = hideGerman(harness);
  assert.strictEqual(
    scoreText(shadow), "100%",
    "the panel recounts locally rather than mislabelling the engine's number"
  );
});

test("re-selecting a language restores the unscoped score rather than a cached one", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({ fingerprint: "run-1", result: makeResult() });
  assert.strictEqual(scoreText(harness.shadow()), "50%", "the baseline counts both languages");

  let shadow = hideGerman(harness);
  assert.strictEqual(scoreText(shadow), "100%");

  /* Back on again. The scope is derived once per paint and held for that
   * paint, so a missing invalidation would pin this at 100% forever -- the
   * panel would keep reporting a selection the reader had already undone. */
  const boxes = findAll(shadow, (node) => node.tagName === "INPUT" && node.attributes["aria-label"]);
  const german = boxes.find((box) => String(box.attributes["aria-label"]).includes("German"));
  assert.ok(german, "the picker still lists the language");
  german.checked = true;
  (german.handlers.change || []).forEach((handler) => handler({ target: german }));
  shadow = harness.shadow();

  assert.strictEqual(scoreText(shadow), "50%", "the score returns to every counted language");
  assert.ok(
    !shadow.textContent.includes("all 2 languages:"),
    "and the all-language line is dropped once nothing is deselected: " + shadow.textContent
  );
});


/* ------------------------------------------------------------------ *
 * Minor rows and per-section coverage
 * ------------------------------------------------------------------ */

function listedRows(shadow) {
  return findAll(shadow, (node) => node.className === "row");
}

function sectionScores(shadow) {
  return findAll(shadow, (node) => node.className === "group-cov").map((node) => node.textContent);
}

function coveredRow(over) {
  return makeRow(Object.assign({
    id: "covered:widget",
    states: {
      fr: { state: "direct", direct: true, duplicateCount: 0 },
      de: { state: "direct", direct: true, duplicateCount: 0 },
    },
    coverage: { covered: 2, counted: 2, percent: 100, missing: [], unavailable: [] },
  }, over || {}));
}

test("help_tag and example_text rows are folded away, and the toggle says how many", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({
      sections: [makeSection("values", "Catalog Text", [
        makeRow(),
        makeRow({ id: "help:widget", aspect: "help_tag" }),
        makeRow({ id: "eg:widget", aspect: "example_text" }),
      ])],
    }),
  });

  let shadow = harness.shadow();
  const toggle = buttonContaining(shadow, "Minor rows");
  assert.ok(toggle, "the toggle is offered");
  assert.ok(toggle.textContent.includes("(2)"), "it counts what it folded: " + toggle.textContent);
  assert.strictEqual(listedRows(shadow).length, 1, "only the row worth working from is listed");

  click(toggle);
  shadow = harness.shadow();
  assert.strictEqual(listedRows(shadow).length, 3, "the toggle brings them back");
  assert.ok(buttonContaining(shadow, "Hide minor rows"), "and offers to fold them away again");
});

test("a choice row whose options come from a table is folded away with them", () => {
  const harness = load();
  openPanel(harness);
  /* What the engine now emits for a List Collector: not applicable, not
   * unverified, and flagged so the panel can fold it. */
  const tableSourced = makeRow({
    id: "choices:collector",
    aspect: "choices",
    states: {
      fr: { state: "not_applicable" },
      de: { state: "not_applicable" },
    },
    coverage: { covered: 0, counted: 0, percent: null, missing: [], unavailable: [] },
    evidence: {
      notApplicable: true,
      notApplicableReason: "this variable's options are records in another table",
      minor: true,
    },
  });
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({
      sections: [makeSection("choices", "Choices", [makeRow({ aspect: "choices" }), tableSourced])],
    }),
  });

  let shadow = harness.shadow();
  assert.strictEqual(listedRows(shadow).length, 1, "the table-sourced row is not listed");
  assert.ok(buttonContaining(shadow, "Minor rows").textContent.includes("(1)"));

  click(buttonContaining(shadow, "Minor rows"));
  shadow = harness.shadow();
  assert.strictEqual(listedRows(shadow).length, 2);
});

test("the minor toggle is disabled when a surface has nothing to fold", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({ fingerprint: "run-1", result: makeResult() });
  const toggle = buttonContaining(harness.shadow(), "Minor rows");
  assert.strictEqual(toggle.disabled, true);
  assert.ok(!toggle.textContent.includes("("), "no count is claimed: " + toggle.textContent);
});

test("folding a row away changes what is listed, never what was counted", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({
      sections: [makeSection("values", "Catalog Text", [
        coveredRow(),
        makeRow({ id: "help:widget", aspect: "help_tag" }),
      ])],
    }),
  });
  /* One row fully covered, one half covered: 3 of 4 slots, whether or not the
   * half-covered one is on screen. A hidden gap is still a gap. */
  const hidden = harness.shadow();
  assert.strictEqual(listedRows(hidden).length, 1);
  assert.deepStrictEqual(sectionScores(hidden), ["75%"], "the folded row is still counted");

  click(buttonContaining(hidden, "Minor rows"));
  assert.deepStrictEqual(sectionScores(harness.shadow()), ["75%"], "and revealing it changes nothing");
});

test("each section carries its own score in its header", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({
      sections: [
        makeSection("labels", "Field Labels", [makeRow()]),
        makeSection("choices", "Choices", [coveredRow({ aspect: "choices" })]),
      ],
    }),
  });
  assert.deepStrictEqual(
    sectionScores(harness.shadow()), ["50%", "100%"],
    "one section is half done and the other finished, and each says so"
  );
});

test("section scores follow the language selection like the headline does", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({ sections: [makeSection("labels", "Field Labels", [makeRow()])] }),
  });
  assert.deepStrictEqual(sectionScores(harness.shadow()), ["50%"]);

  const shadow = hideGerman(harness);
  assert.deepStrictEqual(
    sectionScores(shadow), ["100%"],
    "a section must never disagree with the headline above it"
  );
  assert.strictEqual(scoreText(shadow), "100%");
});

test("a row listed in both a section and its subsection is counted once", () => {
  const harness = load();
  openPanel(harness);
  /* A catalog result holds its native form rows twice on purpose: flattened
   * into form-fields.rows, which the summaries count, and again inside the
   * subsection that actually renders. A walker visiting both reports two
   * conflicts where the reader can see only one row. */
  const conflicted = makeRow({
    id: "labels:dup",
    states: {
      fr: { state: "conflict", direct: false, duplicateCount: 2 },
      de: { state: "direct", direct: true, duplicateCount: 0 },
    },
    coverage: { covered: 1, counted: 2, percent: 50, missing: [], unavailable: [] },
  });
  const inner = makeSection("labels", "Field Labels", [conflicted]);
  const outer = makeSection("form-fields", "Form fields", [conflicted]);
  outer.subsections = [inner];
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({ sections: [outer] }),
  });

  const text = harness.shadow().textContent;
  assert.ok(text.includes("1 row with a conflict"), "counted once: " + text);
  assert.ok(!text.includes("2 rows with a conflict"), "and never twice");
});

test("a section whose every match is folded says so instead of reading as empty", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({
      sections: [makeSection("values", "Catalog Text", [
        makeRow({ id: "help:a", aspect: "help_tag" }),
        makeRow({ id: "help:b", aspect: "help_tag" }),
      ])],
    }),
  });

  const text = harness.shadow().textContent;
  assert.ok(text.includes("2 matching rows are folded away"),
    "an empty list must not be confused with a folded one: " + text);
  assert.ok(!text.includes("No row in this section matches"));
});

test("the shipped engine honours the scope argument the panel sends it", () => {
  const harness = load({ withEngine: true });
  const engine = harness.sandbox.SNTranslationLens;
  assert.ok(engine, "the engine must be present in this sandbox");

  /* The contract, asserted against the real file rather than a stub: a scoped
   * call recounts, and says so, which is the flag the panel checks before it
   * dares label the number as the selected-language one. */
  const rows = [makeRow()];
  const all = engine.sectionSummary(rows);
  assert.strictEqual(all.percent, 50);
  assert.strictEqual(all.scoped, false);
  const scoped = engine.sectionSummary(rows, ["fr"]);
  assert.strictEqual(scoped.percent, 100);
  assert.strictEqual(scoped.complete, 1);
  assert.strictEqual(scoped.scoped, true);
});

test("the panel and the engine agree once both are loaded together", () => {
  const harness = load({ withEngine: true });
  openPanel(harness);
  harness.ui.showResults({ fingerprint: "run-1", result: makeResult() });
  assert.ok(harness.shadow().textContent.includes("0 complete"));

  const shadow = hideGerman(harness);
  assert.strictEqual(scoreText(shadow), "100%", "the engine's scoped answer reaches the headline");
  assert.ok(shadow.textContent.includes("1 complete"));
  assert.ok(
    shadow.textContent.includes("all 2 languages: 50%"),
    "and the all-language score is still drawn beside it: " + shadow.textContent
  );
});

test("Include inactive stays disabled while no re-run callback exists", () => {
  const harness = load();
  openPanel(harness);
  let shadow = harness.shadow();
  const toggle = buttonContaining(shadow, "Include inactive");
  assert.strictEqual(toggle.disabled, true);
  assert.ok(String(toggle.title).includes("re-run"), "the control explains why: " + toggle.title);

  const second = load();
  openPanel(second, {
    fingerprint: "run-2",
    callbacks: {
      onSetIncludeInactive: () => { second.sandbox.rerun = true; },
    },
  });
  const live = buttonContaining(second.shadow(), "Include inactive");
  assert.strictEqual(live.disabled, false);
  click(live);
  assert.strictEqual(second.sandbox.rerun, true, "the re-run request is delegated, never faked locally");
});

/* ------------------------------------------------------------------ *
 * Actions and safety
 * ------------------------------------------------------------------ */

test("list and new-record actions stay disabled until the result supplies a URL", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({ fingerprint: "run-1", result: makeResult() });
  const shadow = harness.shadow();
  const labelsButton = buttonWithText(shadow, "Field Labels");
  assert.ok(labelsButton, "the footer lists one button per store");
  assert.strictEqual(labelsButton.disabled, true, "no URL was supplied, so nothing is offered");
  ["Choices", "Translated Names / Fields", "Translated Text", "Messages"].forEach((label) => {
    const button = find(shadow, (node) => node.className === "store" && node.textContent === label);
    assert.ok(button, label + " belongs in the footer");
    assert.strictEqual(button.disabled, true);
  });
});

test("a supplied same-origin URL enables the footer button and routes through onOpenUrl", () => {
  const harness = load();
  const calls = openPanel(harness);
  const result = makeResult();
  result.links = { sys_documentation: ORIGIN + "/sys_documentation_list.do?sysparm_query=name%3Ddemo_widget" };
  harness.ui.showResults({ fingerprint: "run-1", result });
  const button = buttonWithText(harness.shadow(), "Field Labels");
  assert.strictEqual(button.disabled, false);
  click(button);
  assert.deepStrictEqual(calls.open, [result.links.sys_documentation]);
});

test("a cross-origin or malformed URL is refused rather than opened", () => {
  const harness = load();
  const calls = openPanel(harness);
  const result = makeResult();
  result.links = {
    sys_documentation: "https://elsewhere.example.com/sys_documentation_list.do",
    sys_choice: "javascript:alert(1)",
  };
  harness.ui.showResults({ fingerprint: "run-1", result });
  const shadow = harness.shadow();
  assert.strictEqual(buttonWithText(shadow, "Field Labels").disabled, true);
  assert.strictEqual(find(shadow, (node) => node.className === "store" && node.textContent === "Choices").disabled, true);
  assert.deepStrictEqual(calls.open, []);
});

test("a missing-language chip opens the prefilled new record it was given", () => {
  const harness = load();
  const calls = openPanel(harness);
  const prefill = ORIGIN + "/sys_documentation.do?sys_id=-1&sysparm_query=language%3Dde";
  const row = makeRow({ links: { newRecord: { de: prefill, fr: prefill } } });
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({ sections: [makeSection("labels", "Field Labels", [row])] }),
  });
  let shadow = harness.shadow();
  click(buttonWithText(shadow, "Expand all"));
  shadow = harness.shadow();
  const chips = findAll(shadow, (node) => node.tagName === "BUTTON" && String(node.className).startsWith("chip "));
  assert.strictEqual(chips.length, 1, "only the missing language offers a prefill");
  assert.ok(chips[0].textContent.includes("de"));
  click(chips[0]);
  assert.deepStrictEqual(calls.open, [prefill]);
});

test("Copy writes exactly what onCopyReport returned", async () => {
  const harness = load();
  const calls = openPanel(harness);
  harness.ui.showResults({ fingerprint: "run-1", result: makeResult() });
  click(buttonWithText(harness.shadow(), "Copy report"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(calls.copy, 1);
  assert.deepStrictEqual(harness.clipboard.written, ["REPORT TEXT"]);
  harness.ui.close({ fingerprint: "run-1" });
});

test("the manual message lookup goes through its callback and renders the row it returns", async () => {
  const harness = load();
  const calls = openPanel(harness);
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({
      sections: [makeSection("messages", "Messages", [], { separateHeadline: true })],
    }),
  });
  let shadow = harness.shadow();
  const input = find(shadow, (node) => node.tagName === "INPUT" && node.id.includes("lookup"));
  assert.ok(input, "a manual key box belongs at the bottom");
  input.value = "demo.manual.key";
  (input.handlers.input || []).forEach((handler) => handler({ target: input }));
  click(buttonWithText(shadow, "Look up"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(calls.lookup, ["demo.manual.key"]);
  assert.ok(harness.shadow().textContent.includes("widget_name"), "the returned row is rendered");
});

/* ------------------------------------------------------------------ *
 * Report text
 * ------------------------------------------------------------------ */

test("formatResultsAsText delegates to the engine's own safe formatter", () => {
  const harness = load();
  harness.sandbox.SNTranslationLens = {
    formatResultsAsText: (result) => "ENGINE REPORT for " + (result && result.context && result.context.table),
  };
  const text = harness.ui.formatResultsAsText(makeResult());
  assert.strictEqual(text, "ENGINE REPORT for demo_widget");
});

test("the local formatter is used when the engine is absent or throws", () => {
  const harness = load();
  const fromNothing = harness.ui.formatResultsAsText(makeResult());
  assert.ok(fromNothing.startsWith("Translation Lens"));
  harness.sandbox.SNTranslationLens = {
    formatResultsAsText: () => { throw new Error("engine reload"); },
  };
  const fromThrow = harness.ui.formatResultsAsText(makeResult());
  assert.ok(fromThrow.startsWith("Translation Lens"), "a throwing engine must not lose the report");
  assert.ok(fromThrow.includes("widget_name [label]: 1/2"));
  assert.ok(fromThrow.includes("missing=de"));
});

test("the report carries no value, URL, hostname or sys_id", () => {
  const harness = load();
  const row = makeRow({
    source: "Confidential source string",
    label: "Confidential question text",
    links: {
      list: ORIGIN + "/sys_documentation_list.do",
      newRecord: { de: ORIGIN + "/sys_documentation.do?sys_id=-1" },
    },
    evidence: { nearDuplicates: { rowCount: 1, languages: ["fr"], inactiveLanguages: [] } },
  });
  const result = makeResult({ sections: [makeSection("labels", "Field Labels", [row])] });
  const text = harness.ui.formatResultsAsText(result);
  assert.ok(!text.includes("Confidential"), "no source or label text may reach the report");
  assert.ok(!text.includes("service-now.com"), "no hostname");
  assert.ok(!text.includes("http"), "no URL");
  assert.ok(!text.includes("sys_id"), "no record identifier");
  assert.ok(text.includes("widget_name [label]: 1/2"), "counts and element names are the payload");
  assert.ok(text.includes("warnings=near-duplicate"));
});

test("a report taken mid-run says it is partial rather than implying a final score", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults({
    fingerprint: "run-1",
    section: makeSection("labels", "Field Labels", [makeRow()]),
    partial: true,
  });
  const text = harness.ui.formatResultsAsText(null);
  assert.ok(text.includes("Partial run"), "an unfinished run must be labelled: " + text);
  assert.ok(text.includes("widget_name [label]: 1/2"), "what was read is still reported");
});

/* ------------------------------------------------------------------ *
 * Catalog shapes
 * ------------------------------------------------------------------ */

test("a catalog result nests its native form fields in one collapsed group", () => {
  const harness = load();
  openPanel(harness, {
    context: { mode: "catalog", surface: "Catalog definition form", table: "sc_cat_item", isNewRecord: false },
  });
  const labelRow = makeRow({ id: "label:short_description", element: "short_description", label: "short_description" });
  const valueRow = makeRow({
    id: "value:short_description", element: "short_description", label: "short_description",
    aspect: "value", store: "sys_translated_text",
  });
  const result = makeResult({
    context: { mode: "catalog", surface: "Catalog definition form", table: "sc_cat_item", isNewRecord: false },
    sections: [
      makeSection("values", "Catalog Text", [makeRow({
        id: "catalog:q1:question_text", element: "requested_for", label: "Requested for", aspect: "source",
        store: "sys_translated",
      })]),
      makeSection("form-fields", "Form fields", [labelRow, valueRow], {
        collapsed: true,
        subsections: [
          makeSection("labels", "Field Labels", [labelRow]),
          makeSection("values", "Translated Names / Fields and Text", [valueRow]),
        ],
      }),
    ],
  });
  harness.ui.showResults({ fingerprint: "run-1", result });

  let shadow = harness.shadow();
  const names = findAll(shadow, (node) => node.className === "group-name").map((node) => node.textContent);
  assert.ok(names.includes("Form fields"), "the nested group keeps its own heading: " + names.join(" | "));
  assert.ok(!names.includes("Field Labels"), "its subsections stay closed until it is opened");
  assert.ok(shadow.textContent.includes("Requested for"), "the item's own text is not buried");
  assert.ok(!shadow.textContent.includes("short_description"), "a collapsed group renders no rows");

  click(buttonContaining(shadow, "Form fields"));
  shadow = harness.shadow();
  const opened = findAll(shadow, (node) => node.className === "group-name").map((node) => node.textContent);
  assert.ok(opened.includes("Field Labels"));
  assert.ok(opened.includes("Translated Names / Fields and Text"));
  const rows = findAll(shadow, (node) => node.className === "row" && node.textContent.includes("short_description"));
  assert.strictEqual(rows.length, 2, "one row per aspect, never the flattened copy as well");
});

test("a choices row expands to one entry per base value with its own chips", () => {
  const harness = load();
  openPanel(harness);
  const choiceRow = makeRow({
    id: "choices:state", element: "state", label: "state", aspect: "choices", store: "sys_choice",
    states: { fr: { state: "partial" }, de: { state: "missing" } },
    coverage: { covered: 0, counted: 2, percent: 0, missing: ["fr", "de"], unavailable: [] },
    evidence: {
      choiceCount: 2,
      choices: [
        {
          identity: "open\u0000", value: "open", dependentValue: "", label: "Open",
          states: { fr: { state: "direct", direct: true }, de: { state: "missing" } },
          coverage: { covered: 1, counted: 2, percent: 50, missing: ["de"], unavailable: [] },
          nearDuplicates: { rowCount: 0, languages: [], inactiveLanguages: [] },
        },
        {
          identity: "closed\u0000hardware", value: "closed", dependentValue: "hardware", label: "Closed",
          states: { fr: { state: "missing" }, de: { state: "missing" } },
          coverage: { covered: 0, counted: 2, percent: 0, missing: ["fr", "de"], unavailable: [] },
          nearDuplicates: { rowCount: 1, languages: ["fr"], inactiveLanguages: [] },
        },
      ],
    },
  });
  harness.ui.showResults({
    fingerprint: "run-1",
    result: makeResult({ sections: [makeSection("choices", "Choices", [choiceRow])] }),
  });
  let shadow = harness.shadow();
  click(buttonWithText(shadow, "Expand all"));
  shadow = harness.shadow();
  const entries = findAll(shadow, (node) => node.className === "choice");
  assert.strictEqual(entries.length, 2, "one line per base value");
  const first = entries[0].textContent;
  assert.ok(first.includes("Open"), "the base label identifies the choice");
  assert.ok(first.includes("value open"), "so does its stored value");
  assert.ok(first.includes("1/2"));
  assert.ok(first.includes("fr") && first.includes("Direct"));
  assert.ok(first.includes("de") && first.includes("Missing"));
  const second = entries[1].textContent;
  assert.ok(second.includes("under hardware"), "dependent_value is part of a choice's identity");
  assert.ok(second.includes("near-duplicate"), "case-variant rows are reported per value");
  assert.ok(shadow.textContent.includes("2 base choices were assessed."));
});

test("a manual lookup is listed apart from the scanned keys and moves no denominator", async () => {
  const harness = load();
  openPanel(harness);
  const scanned = makeRow({
    id: "message:demo.scanned", element: "demo.scanned", label: "demo.scanned",
    aspect: "message", store: "sys_ui_message",
    coverage: { covered: 1, counted: 2, percent: 50, missing: ["de"], unavailable: [] },
  });
  const result = makeResult({
    sections: [makeSection("messages", "Messages", [scanned], { separateHeadline: true })],
  });
  result.summary = { covered: 0, counted: 0, percent: null, complete: 0, partial: 0, none: 0, rowCount: 0 };
  result.messageSummary = { covered: 1, counted: 2, percent: 50, complete: 0, partial: 1, none: 0, rowCount: 1 };
  harness.ui.showResults({ fingerprint: "run-1", result });

  const shadow = harness.shadow();
  const input = find(shadow, (node) => node.tagName === "INPUT" && node.id.includes("lookup"));
  input.value = "demo.typed";
  (input.handlers.input || []).forEach((handler) => handler({ target: input }));
  click(buttonWithText(shadow, "Look up"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const text = harness.shadow().textContent;
  assert.ok(text.includes("Manual key lookups"), "a typed key gets its own group");
  assert.ok(text.includes("outside the scan's denominator"));
  assert.ok(text.includes("Messages 1/2"), "the scanned headline is unchanged");
  assert.strictEqual(
    result.sections[0].rows.length, 1,
    "the engine's own result object is never written into"
  );
});

/*
 * Tests for debug_timeline_ui.js, the Debug Timeline results panel.
 *
 *   node --test tests/debug_timeline_ui.test.js
 *
 * DEV-ONLY. The panel runs under node:vm against a small DOM shim copied from
 * tests/catalog_insight_ui.test.js: a minimal parser for the panel's own
 * static template and a selector matcher that throws on anything it does not
 * understand. tests/debug_timeline.test.js and debug_timeline_frames.test.js
 * cover the recorder; this file covers how its events are drawn.
 *
 * Every event below has the shape the recorder writes
 * (debug_timeline_main.js) after the worker's merge (background.js), with
 * synthetic names, values and ids.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const UI_SOURCE = fs.readFileSync(path.join(__dirname, "..", "debug_timeline_ui.js"), "utf8");
const HOST_ID = "snh-debug-timeline-results";

/* ------------------------------------------------------------------ *
 * The DOM shim
 * ------------------------------------------------------------------ */

const VOID_TAGS = new Set(["INPUT", "BR", "IMG", "META", "LINK", "HR"]);
const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

function parseCompound(text) {
  const out = { tag: "", classes: [], attrs: [] };
  const pattern =
    /([a-zA-Z][a-zA-Z0-9-]*)|\.([A-Za-z0-9_-]+)|\[([a-zA-Z0-9_-]+)(?:=(?:'([^']*)'|"([^"]*)"))?\]/y;
  let index = 0;
  while (index < text.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (!match) throw new Error("selector not supported by the shim: " + text);
    if (match[1]) {
      if (index) throw new Error("selector not supported by the shim: " + text);
      out.tag = match[1].toUpperCase();
    } else if (match[2]) {
      out.classes.push(match[2]);
    } else {
      out.attrs.push([match[3], match[4] !== undefined ? match[4] : match[5]]);
    }
    index = pattern.lastIndex;
  }
  return out;
}

function attributeValue(node, name) {
  if (Object.prototype.hasOwnProperty.call(node.attributes, name)) return node.attributes[name];
  if (name.startsWith("data-")) {
    const key = camel(name.slice(5));
    if (Object.prototype.hasOwnProperty.call(node.dataset, key)) return String(node.dataset[key]);
  }
  return null;
}

function matchesCompound(node, compound) {
  if (!node || !node.attributes) return false;
  if (compound.tag && node.tagName !== compound.tag) return false;
  const classes = String(node.className || "").split(/\s+/);
  if (compound.classes.some((name) => !classes.includes(name))) return false;
  return compound.attrs.every(([name, value]) => {
    const actual = attributeValue(node, name);
    return value === undefined ? actual !== null : actual === value;
  });
}

function matchesSelector(node, selector) {
  if (selector.includes(",") || /[>+~#:]/.test(selector)) {
    throw new Error("selector not supported by the shim: " + selector);
  }
  const parts = selector.trim().split(/\s+/).map(parseCompound);
  if (!matchesCompound(node, parts[parts.length - 1])) return false;
  let ancestor = node.parentNode;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesCompound(ancestor, parts[index])) ancestor = ancestor.parentNode;
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

function createDom() {
  class TextNode {
    constructor(value) {
      this.tagName = "#text";
      this.children = [];
      this.parentNode = null;
      this._text = String(value == null ? "" : value);
    }
    get textContent() { return this._text; }
  }

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = Object.create(null);
      this.handlers = Object.create(null);
      this.dataset = {};
      this.className = "";
      this.id = "";
      this.value = "";
      this.type = "";
      this.title = "";
      this.hidden = false;
      this.style = {};
      this._text = "";
    }
    get classList() {
      const node = this;
      const list = () => String(node.className || "").split(/\s+/).filter(Boolean);
      const toggle = (name, force) => {
        const has = list().includes(name);
        const want = force === undefined ? !has : Boolean(force);
        if (want && !has) node.className = list().concat([name]).join(" ");
        if (!want && has) node.className = list().filter((item) => item !== name).join(" ");
        return want;
      };
      return {
        contains: (name) => list().includes(name),
        toggle,
        add: (name) => { toggle(name, true); },
        remove: (name) => { toggle(name, false); },
      };
    }
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
    set innerHTML(markup) {
      this.textContent = "";
      parseInto(this, String(markup));
    }
    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
      return node;
    }
    append(...nodes) {
      nodes.forEach((node) => this.appendChild(typeof node === "string" ? new TextNode(node) : node));
    }
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
      node.parentNode = null;
      return node;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
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
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => (node.children || []).forEach((child) => {
        if (matchesSelector(child, selector)) out.push(child);
        visit(child);
      });
      visit(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    fire(type, event) {
      const payload = Object.assign({
        target: this,
        preventDefault() { payload.defaultPrevented = true; },
        stopPropagation() {},
      }, event || {});
      (this.handlers[type] || []).slice().forEach((handler) => handler(payload));
      return payload;
    }
  }

  function parseInto(parent, markup) {
    const token =
      /<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:\s*=\s*"[^"]*")?)*)\s*\/?>|([^<]+)/y;
    const attribute = /([^\s=>/]+)(?:\s*=\s*"([^"]*)")?/g;
    const stack = [parent];
    let index = 0;
    while (index < markup.length) {
      token.lastIndex = index;
      const match = token.exec(markup);
      if (!match) throw new Error("markup not supported by the shim at: " + markup.slice(index, index + 40));
      index = token.lastIndex;
      const current = stack[stack.length - 1];
      if (match[1]) {
        if (current.tagName !== match[1].toUpperCase()) throw new Error("mismatched </" + match[1] + ">");
        stack.pop();
      } else if (match[2]) {
        const node = new El(match[2]);
        let found;
        attribute.lastIndex = 0;
        while ((found = attribute.exec(match[3] || "")) !== null) {
          const name = found[1];
          const value = found[2] === undefined ? "" : found[2];
          if (name === "class") node.className = value;
          else if (name === "id") node.id = value;
          else {
            if (name === "type") node.type = value;
            if (name.startsWith("data-")) node.dataset[camel(name.slice(5))] = value;
            node.attributes[name] = value;
          }
        }
        current.appendChild(node);
        if (node.tagName === "STYLE") {
          const end = markup.indexOf("</style>", index);
          node._text = markup.slice(index, end);
          index = end + "</style>".length;
        } else if (!VOID_TAGS.has(node.tagName)) {
          stack.push(node);
        }
      } else if (match[4].trim()) {
        current.appendChild(new TextNode(match[4]));
      }
    }
    if (stack.length !== 1) throw new Error("unclosed element in template");
  }

  const windowHandlers = Object.create(null);
  const windowObject = {
    addEventListener(type, handler) { (windowHandlers[type] = windowHandlers[type] || []).push(handler); },
    removeEventListener(type, handler) {
      const list = windowHandlers[type] || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
  };
  windowObject.top = windowObject;
  const document = {
    createElement: (tag) => new El(tag),
    createTextNode: (value) => new TextNode(value),
    documentElement: new El("html"),
    body: new El("body"),
    execCommand: () => false,
  };
  return { document, window: windowObject };
}

function load() {
  const dom = createDom();
  const copied = [];
  const sandbox = {
    document: dom.document,
    window: dom.window,
    navigator: { clipboard: { writeText: async (text) => { copied.push(text); } } },
    chrome: { runtime: { sendMessage: async () => ({ ok: true }) } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(UI_SOURCE, sandbox, { filename: "debug_timeline_ui.js" });
  return {
    ui: sandbox.SNDebugTimelineUI,
    copied,
    shadow() {
      const host = dom.document.documentElement.children.find((node) => node.id === HOST_ID);
      return host ? host.shadowRoot : null;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ *
 * Synthetic events, in the recorder's shapes
 * ------------------------------------------------------------------ */

const PAGE = "https://example.service-now.com/com.glideapp.servicecatalog_cat_item_view.do";
const USER_ID = "0123456789abcdef0123456789abcdef";
const AJAX = { className: "ExampleAjax", method: "getManager" };
const PARAMS = { sysparm_name: "getManager", sysparm_user: USER_ID, sysparm_token: "[REDACTED]" };

const at = (n, fields) => Object.assign({
  id: n, time: 1000 + n * 100, elapsedMs: n * 100, stack: "", frameId: 0,
  frameLabel: "Top frame", frameUrl: PAGE,
}, fields);

/* The finished calls here carry no startId, as a recorder from before the
 * start link wrote them, so every start keeps its own row. pairedCall() below
 * builds the linked shape. */
function events() {
  return [
    at(0, { category: "system", action: "start", summary: "Recording started",
      details: { frameCount: 1 }, frameLabel: undefined, frameUrl: undefined }),
    at(1, { category: "field", action: "change", summary: 'change: "u_example_password"',
      details: { field: "u_example_password", value: "[REDACTED]", tag: "input", type: "password", trusted: true },
      stack: "at onChange (example.js:1:1)" }),
    at(2, { category: "glideajax", action: "start", summary: "ExampleAjax.getManager started",
      details: Object.assign({}, AJAX, { params: PARAMS }),
      stack: "at getXMLAnswer (example.js:2:1)\nat onChange (example.js:3:1)" }),
    at(3, { category: "glideajax", action: "complete", summary: "ExampleAjax.getManager completed in 440 ms",
      details: Object.assign({}, AJAX, { params: PARAMS, durationMs: 440, response: {
        status: 200, answerLength: 96, truncated: false, format: "json",
        answer: { manager: "Example Person", manager_id: USER_ID, secret_note: "[REDACTED]" },
      } }) }),
    at(4, { category: "glideajax", action: "complete", summary: "ExampleAjax.getTable completed in 12 ms",
      details: { className: "ExampleAjax", method: "getTable", params: { sysparm_name: "getTable" },
        durationMs: 12, response: { answerLength: 1200, format: "text", bodyRetained: false } } }),
    at(5, { category: "g_form", action: "setValue", summary: 'setValue("u_example_choice")',
      details: { field: "u_example_choice", arguments: ["a", "Option A"], oldValue: "", u_future_key: 7 } }),
    at(6, { category: "glideajax", action: "complete", summary: "ExampleAjax.ping completed in 5 ms",
      details: { className: "ExampleAjax", method: "ping", params: {}, durationMs: 5, u_extra: "kept",
        response: { status: 200, answerLength: 2, format: "json", answer: {}, u_new: 1 } } }),
    at(7, { category: "error", action: "unhandledrejection", summary: "Unhandled promise rejection: example",
      details: {}, frameLabel: undefined, frameUrl: undefined }),
    at(8, { category: "g_form", action: "setValue", summary: 'setValue("u_example_text")',
      details: { field: "u_example_text", arguments: ["same"], oldValue: "same", noValueChange: true } }),
  ];
}

const START_STACK = "at getXMLAnswer (example.js:2:1)\nat onChangeManager (example.js:3:1)";

/* A start and the completion that names it, as the current recorder writes
 * them: the completion's details carry startId, the start's own event id. */
function pairedCall(startN, doneN, fields) {
  const opts = Object.assign({ method: "getManager", durationMs: 440, frameId: 0, sysparmUser: USER_ID }, fields);
  const call = { className: "ExampleAjax", method: opts.method,
    params: { sysparm_name: opts.method, sysparm_user: opts.sysparmUser } };
  return [
    at(startN, { category: "glideajax", action: "start", frameId: opts.frameId,
      summary: "ExampleAjax." + opts.method + " started", details: call, stack: START_STACK }),
    at(doneN, { category: "glideajax", action: "complete", frameId: opts.frameId,
      summary: "ExampleAjax." + opts.method + " completed in " + opts.durationMs + " ms",
      details: Object.assign({}, call, { durationMs: opts.durationMs, startId: startN,
        response: { status: 200, answerLength: 2, format: "json", answer: {} } }) }),
  ];
}

const byTime = (list) => list.slice().sort((a, b) => a.time - b.time);
const summariesOf = (shadow) => rowsOf(shadow).map((row) => q(row, ".event-summary-text").textContent);

function openPanel(harness, list) {
  const result = { ok: true, frameCount: 1, startedAt: 1000, stoppedAt: 2000, events: list || events() };
  harness.ui.showResults(result);
  return { shadow: harness.shadow(), result };
}

const q = (node, selector) => node.querySelector(selector);
const rowsOf = (shadow) => shadow.querySelectorAll(".events .event");
const rowFor = (shadow, summary) =>
  rowsOf(shadow).find((row) => q(row, ".event-summary-text").textContent === summary);
const openRow = (row) => { q(row, ".event-main").fire("click"); return q(row, ".event-details"); };
/* A fact list as [label, value] pairs. */
const factsOf = (list) => {
  const out = [];
  for (let index = 0; index < list.children.length; index += 2) {
    out.push([list.children[index].textContent, list.children[index + 1].textContent]);
  }
  return out;
};
const directFacts = (node) => node.children.filter((child) => child.tagName === "DL");

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test("a finished GlideAjax call opens as a Request card and a Response card", () => {
  const { shadow } = openPanel(load());
  const details = openRow(rowFor(shadow, "ExampleAjax.getManager completed in 440 ms"));
  assert.deepStrictEqual(factsOf(directFacts(details)[0]), [["Frame", "Top frame"], ["Page", PAGE]]);

  const cards = q(details, ".sides").children;
  assert.deepStrictEqual(cards.map((card) => q(card, ".side-head").textContent),
    ["Requestwhat the form asked", "Responsewhat came back"]);
  const [request, response] = cards;
  const requestLists = request.querySelectorAll("dl");
  assert.deepStrictEqual(factsOf(requestLists[0]), [["Script Include", "ExampleAjax"], ["Method", "getManager"]]);
  assert.deepStrictEqual(factsOf(requestLists[1]).slice(0, 2),
    [["sysparm_name", "getManager"], ["sysparm_user", USER_ID]], "each parameter is its own fact");
  assert.strictEqual(requestLists[1].children[0].className, "mono");
  assert.strictEqual(requestLists[1].children[1].className, "mono");

  assert.strictEqual(response.className, "side", "nothing wrong: no coloured edge");
  assert.strictEqual(q(response, ".why"), null);
  assert.deepStrictEqual(factsOf(q(response, "dl")),
    [["Status", "200"], ["Took", "440 ms"], ["Answer", "JSON, 96 characters"]]);
  assert.strictEqual(response.querySelectorAll(".sub-head").map((n) => n.textContent).join(), "Decoded answer");
  assert.strictEqual(q(response, "pre").textContent,
    JSON.stringify({ manager: "Example Person", manager_id: USER_ID, secret_note: "[REDACTED]" }, null, 2),
    "pretty-printed, with the recorder's marker kept as it wrote it");
  assert.strictEqual(q(details, ".link"), null, "a complete carries no stack, so no toggle");
  assert.doesNotMatch(details.textContent, /Other details/);
});

test("a GlideAjax start opens as one fact list, with the stack toggle and no Response card", () => {
  const { shadow } = openPanel(load());
  const details = openRow(rowFor(shadow, "ExampleAjax.getManager started"));
  assert.strictEqual(q(details, ".sides"), null);
  const lists = directFacts(details);
  assert.deepStrictEqual(factsOf(lists[0]), [
    ["Frame", "Top frame"], ["Page", PAGE], ["Script Include", "ExampleAjax"], ["Method", "getManager"],
  ]);
  assert.strictEqual(q(details, ".sub-head").textContent, "Parameters");
  assert.deepStrictEqual(factsOf(lists[1]).map((fact) => fact[0]), ["sysparm_name", "sysparm_user", "sysparm_token"]);
  assert.ok(q(details, ".link"), "the start carries the stack");
});

test("one row per call: an answered start is left out, and the count says what is shown", () => {
  const { shadow } = openPanel(load(), pairedCall(2, 3));
  assert.deepStrictEqual(summariesOf(shadow), ["ExampleAjax.getManager completed in 440 ms"]);
  assert.strictEqual(q(shadow, "[data-count='events']").textContent, "1");
});

test("noise rows are left out, with no toggle to bring them back", () => {
  const hide = (n, field, args) => at(n, { category: "g_form", action: "hideFieldMsg",
    summary: "hideFieldMsg #" + n, details: { field, arguments: args || [] } });
  const list = [
    hide(1, "u_example_a"),
    hide(2, "u_example_a"),
    hide(3, "u_example_a", ["error"]),
    hide(4, "u_example_b"),
    events()[5],
    hide(6, "u_example_c"),
    events()[8],
    Object.assign(hide(80, "u_example_c"), { time: 1000 + 6 * 100 + 5001 }),
  ];
  const { shadow } = openPanel(load(), list);
  assert.deepStrictEqual(summariesOf(shadow), [
    "hideFieldMsg #1",
    "hideFieldMsg #3",
    "hideFieldMsg #4",
    'setValue("u_example_choice")',
    "hideFieldMsg #6",
    "hideFieldMsg #80",
  ], "#2 repeats #1 within 5 s and goes; #3 has other arguments; #4 is another field; " +
    "#80 comes over 5 s after #6; the setValue that changed nothing goes");
  assert.strictEqual(q(shadow, "[data-count='events']").textContent, "6");
  assert.strictEqual(q(shadow, "[data-action='toggle-low-signal']"), null);
  assert.doesNotMatch(UI_SOURCE, /low-signal|lowSignal/i, "no trace of the old toggle or its wording");
});

test("a finished call says when it was sent and shows its start's call stack", () => {
  const { shadow } = openPanel(load(), pairedCall(2, 6));
  const details = openRow(rowFor(shadow, "ExampleAjax.getManager completed in 440 ms"));
  const request = q(details, ".sides").children[0];
  assert.deepStrictEqual(factsOf(request.querySelectorAll("dl")[0]),
    [["Script Include", "ExampleAjax"], ["Method", "getManager"], ["Sent", "+0.200s"]]);
  assert.doesNotMatch(details.textContent, /Other details/, "the link is placed, never shown as a key");
  assert.doesNotMatch(details.textContent, /startId/);

  const toggle = q(details, ".link");
  assert.ok(toggle, "the start's stack is offered on the finished call");
  toggle.fire("click");
  assert.strictEqual(q(details, ".stack").textContent, START_STACK);
});

test("pairing follows the link, not the name: identical calls answered out of order", () => {
  const first = pairedCall(2, 5, { durationMs: 300, sysparmUser: "first" });
  const second = pairedCall(3, 4, { durationMs: 100, sysparmUser: "second" });
  const { shadow } = openPanel(load(), byTime(first.concat(second)));
  assert.deepStrictEqual(summariesOf(shadow),
    ["ExampleAjax.getManager completed in 100 ms", "ExampleAjax.getManager completed in 300 ms"]);

  const sent = (summary) => factsOf(q(q(openRow(rowFor(shadow, summary)), ".sides").children[0], "dl"))[2];
  assert.deepStrictEqual(sent("ExampleAjax.getManager completed in 100 ms"), ["Sent", "+0.300s"]);
  assert.deepStrictEqual(sent("ExampleAjax.getManager completed in 300 ms"), ["Sent", "+0.200s"]);
});

test("a start with no answer keeps its own row; a link to another frame or a missing start pairs nothing", () => {
  const [lonelyStart] = pairedCall(2, 3);
  const otherFrame = pairedCall(4, 5, { method: "elsewhere", frameId: 7 });
  otherFrame[1].details.startId = 2;
  const dropped = pairedCall(6, 8, { method: "dropped" })[1];
  dropped.details.startId = 99;
  const { shadow } = openPanel(load(), [lonelyStart, otherFrame[0], otherFrame[1], dropped]);

  assert.ok(rowFor(shadow, "ExampleAjax.getManager started"), "unanswered: still a row of its own");
  assert.ok(rowFor(shadow, "ExampleAjax.elsewhere started"), "a frame 7 completion naming id 2 is not frame 0's id 2");
  assert.strictEqual(q(shadow, "[data-count='events']").textContent, "4", "nothing left out");

  const orphan = openRow(rowFor(shadow, "ExampleAjax.dropped completed in 440 ms"));
  assert.deepStrictEqual(factsOf(q(q(orphan, ".sides").children[0], "dl")).map((fact) => fact[0]),
    ["Script Include", "Method"], "no start in the trace: no Sent fact");
  assert.strictEqual(q(orphan, ".link"), null, "and no stack to borrow");
  assert.doesNotMatch(orphan.textContent, /Other details/);
});

test("a search for the sending script finds the finished call, whose start is left out", () => {
  const { shadow } = openPanel(load(), pairedCall(2, 3).concat([at(4, { category: "g_form", action: "setValue",
    summary: 'setValue("u_example_choice")', details: { field: "u_example_choice", arguments: ["a"] } })]));
  const search = q(shadow, ".search");
  search.value = "onchangemanager";
  search.fire("input");
  assert.deepStrictEqual(rowsOf(shadow).map((row) => q(row, ".event-summary-text").textContent),
    ["ExampleAjax.getManager completed in 440 ms"]);
});

test("a body that was not kept edges the Response card amber and says why first", () => {
  const { shadow } = openPanel(load());
  const details = openRow(rowFor(shadow, "ExampleAjax.getTable completed in 12 ms"));
  const response = q(details, ".sides").children[1];
  assert.strictEqual(response.className, "side t-amber");
  assert.strictEqual(response.children[1].className, "why", "the reason is the card's first line");
  assert.match(response.children[1].textContent, /^The answer is not JSON, so it was not kept/);
  assert.deepStrictEqual(factsOf(q(response, "dl")),
    [["Status", "Not reported"], ["Took", "12 ms"], ["Answer", "Text, 1,200 characters"]]);
  assert.strictEqual(q(response, "pre"), null, "nothing to decode");

  const big = openPanel(load(), [at(1, { category: "glideajax", action: "complete", summary: "big",
    details: { className: "ExampleAjax", method: "big", params: {}, durationMs: 9,
      response: { answerLength: 250000, format: "oversized", bodyRetained: false } } })]).shadow;
  const bigResponse = q(openRow(rowFor(big, "big")), ".sides").children[1];
  assert.strictEqual(bigResponse.className, "side t-amber");
  assert.match(q(bigResponse, ".why").textContent, /over 200,000 characters, so it was not read or kept/);
});

test("a redacted value reads as redacted, and its value is never shown", () => {
  const { shadow } = openPanel(load());
  const start = openRow(rowFor(shadow, "ExampleAjax.getManager started"));
  const params = directFacts(start)[1];
  const token = params.children[5];
  assert.strictEqual(params.children[4].textContent, "sysparm_token");
  assert.strictEqual(q(token, ".redacted").textContent, "redacted — the name suggests a secret");
  assert.doesNotMatch(token.textContent, /REDACTED/);

  /* A field value is redacted for its name OR a password input, so no
   * reason is claimed. */
  const field = openRow(rowFor(shadow, 'change: "u_example_password"'));
  const facts = directFacts(field)[0];
  assert.strictEqual(facts.children[6].textContent, "Value");
  const value = q(facts.children[7], ".redacted");
  assert.strictEqual(value.textContent, "redacted");
  assert.doesNotMatch(facts.children[7].textContent, /REDACTED/);
  assert.match(UI_SOURCE, /\.redacted\{color:#e2c48a;font-style:italic\}/);
});

test("the call stack is behind a toggle with aria-expanded, and stays shown across a redraw", () => {
  const { shadow } = openPanel(load());
  const row = rowFor(shadow, "ExampleAjax.getManager started");
  const details = openRow(row);
  const toggle = q(details, ".link");
  const stack = q(details, ".stack");
  assert.strictEqual(toggle.textContent, "Show the call stack (best effort)");
  assert.strictEqual(toggle.getAttribute("aria-expanded"), "false");
  assert.strictEqual(toggle.getAttribute("aria-controls"), stack.id);
  assert.strictEqual(stack.hidden, true);
  toggle.fire("click");
  assert.strictEqual(toggle.textContent, "Hide the call stack");
  assert.strictEqual(toggle.getAttribute("aria-expanded"), "true");
  assert.strictEqual(stack.hidden, false);
  assert.strictEqual(stack.textContent, "at getXMLAnswer (example.js:2:1)\nat onChange (example.js:3:1)");

  const search = q(shadow, ".search");
  search.value = "getmanager";
  search.fire("input");
  const again = q(rowFor(shadow, "ExampleAjax.getManager started"), ".event-details");
  assert.strictEqual(again.hidden, false);
  assert.strictEqual(q(again, ".link").getAttribute("aria-expanded"), "true");
  assert.strictEqual(q(again, ".stack").hidden, false);
});

test("nothing is dropped: unknown keys show under their own name, or in Other details on a card", () => {
  const { shadow } = openPanel(load());
  const setValue = openRow(rowFor(shadow, 'setValue("u_example_choice")'));
  assert.deepStrictEqual(factsOf(directFacts(setValue)[0]), [
    ["Frame", "Top frame"], ["Page", PAGE], ["Field", "u_example_choice"],
    ["Arguments", '"a", "Option A"'], ["Value before", "empty"], ["u_future_key", "7"],
  ]);

  const ping = openRow(rowFor(shadow, "ExampleAjax.ping completed in 5 ms"));
  const heads = ping.querySelectorAll(".sub-head").map((node) => node.textContent);
  assert.ok(heads.includes("Other details"));
  const other = ping.children[ping.children.length - 1];
  assert.deepStrictEqual(JSON.parse(other.textContent), { u_extra: "kept", response: { u_new: 1 } });

  const bare = openRow(rowFor(shadow, "Unhandled promise rejection: example"));
  assert.strictEqual(bare.textContent, "No additional details.");
});

test("the row head is a disclosure button, and an open row stays open through filters and search", () => {
  const { shadow } = openPanel(load());
  const row = rowFor(shadow, "ExampleAjax.getManager completed in 440 ms");
  const main = q(row, ".event-main");
  const details = q(row, ".event-details");
  assert.strictEqual(main.getAttribute("aria-expanded"), "false");
  assert.strictEqual(main.getAttribute("aria-controls"), details.id);
  assert.strictEqual(details.hidden, true);
  assert.strictEqual(q(main, ".caret").textContent, "▸");
  assert.strictEqual(q(main, ".caret").getAttribute("aria-hidden"), "true");
  assert.strictEqual(shadow.querySelectorAll(".glideajax-status").length, 0, "no Started / Completed pills");
  assert.ok(q(main, ".category"), "the category chip stays");

  main.fire("click");
  assert.strictEqual(main.getAttribute("aria-expanded"), "true");
  assert.strictEqual(q(main, ".caret").textContent, "▾");
  assert.strictEqual(details.hidden, false);

  const isOpen = () => {
    const now = rowFor(shadow, "ExampleAjax.getManager completed in 440 ms");
    return q(now, ".event-main").getAttribute("aria-expanded") === "true" && !q(now, ".event-details").hidden;
  };
  shadow.querySelectorAll("[data-filter]").find((b) => b.dataset.filter === "glideajax").fire("click");
  assert.ok(isOpen(), "after a filter");
  const search = q(shadow, ".search");
  search.value = "manager";
  search.fire("input");
  assert.ok(isOpen(), "after a search");
  search.value = "";
  search.fire("input");
  shadow.querySelectorAll("[data-filter]").find((b) => b.dataset.filter === "all").fire("click");
  assert.ok(isOpen(), "back on All");
  assert.strictEqual(q(rowFor(shadow, "ExampleAjax.getManager started"), ".event-details").hidden, true,
    "only the row that was opened");
});

test("a row's opened content is built only when it is first opened, and kept across redraws", () => {
  const { shadow } = openPanel(load());
  rowsOf(shadow).forEach((row) => {
    const details = q(row, ".event-details");
    assert.strictEqual(details.children.length, 0, "a closed row builds nothing");
    assert.ok(details.id, "but keeps the id its head points at");
    assert.strictEqual(q(row, ".event-main").getAttribute("aria-controls"), details.id);
  });

  const summary = "ExampleAjax.getManager started";
  const details = openRow(rowFor(shadow, summary));
  assert.ok(details.children.length, "opening fills it");
  q(details, ".link").fire("click");
  q(rowFor(shadow, summary), ".event-main").fire("click");
  assert.ok(details.children.length, "closing again keeps what was built");
  q(rowFor(shadow, summary), ".event-main").fire("click");

  /* A redraw rebuilds the list: the open row is filled and open again, its
   * stack still shown, and every other row is still empty. */
  shadow.querySelectorAll("[data-filter]").find((b) => b.dataset.filter === "glideajax").fire("click");
  const search = q(shadow, ".search");
  search.value = "example";
  search.fire("input");
  rowsOf(shadow).forEach((row) => {
    const open = q(row, ".event-summary-text").textContent === summary;
    const now = q(row, ".event-details");
    assert.strictEqual(now.hidden, !open);
    assert.strictEqual(now.children.length > 0, open, (open ? "filled: " : "empty: ") + row.textContent);
  });
  assert.strictEqual(q(q(rowFor(shadow, summary), ".event-details"), ".stack").hidden, false);
});

test("the caret is large enough to read as a caret", () => {
  assert.match(UI_SOURCE, /\.caret\{color:#9a9ab3;font-size:13px/);
  assert.match(UI_SOURCE, /grid-template-columns:76px 82px minmax\(0,1fr\) 72px 16px/);
});

test("the duration column is filled only from the event's own duration", () => {
  const { shadow } = openPanel(load());
  const duration = (summary) => q(q(rowFor(shadow, summary), ".event-main"), ".duration").textContent;
  assert.strictEqual(duration("ExampleAjax.getManager completed in 440 ms"), "440 ms");
  assert.strictEqual(duration("ExampleAjax.getTable completed in 12 ms"), "12 ms");
  assert.strictEqual(duration("ExampleAjax.getManager started"), "");
  assert.strictEqual(duration('setValue("u_example_choice")'), "");
  assert.match(UI_SOURCE, /@container events \(max-width:699px\)\{[^}]*\}\s*\.duration\{display:none\}/);
});

test("the copied trace text is unchanged", async () => {
  const harness = load();
  const list = [events()[2], events()[3]];
  openPanel(harness, list);
  const copy = q(harness.shadow(), "[data-action='copy']");
  copy.fire("click");
  copy.fire("click");
  await tick();
  assert.strictEqual(harness.copied.length, 1);
  const details = (event) => "  Details: " + JSON.stringify(event.details);
  assert.strictEqual(harness.copied[0], [
    "GlideLens — Debug Timeline",
    "Best-effort trace; script and UI Policy attribution is not guaranteed.",
    "Started: " + new Date(1000).toISOString(),
    "Stopped: " + new Date(2000).toISOString(),
    "Frames: 1",
    "Events: 2",
    "",
    "+0.200s [GlideAjax] ExampleAjax.getManager started",
    "  Frame: Top frame",
    details(list[0]),
    "  at getXMLAnswer (example.js:2:1)\n  at onChange (example.js:3:1)",
    "",
    "+0.300s [GlideAjax] ExampleAjax.getManager completed in 440 ms",
    "  Frame: Top frame",
    details(list[1]),
    "",
  ].join("\n"));
});

test("the copied trace holds what the panel shows: one entry per call, with when it was sent and its stack", async () => {
  const harness = load();
  const [start, done] = pairedCall(2, 6);
  const noChange = events()[8];
  openPanel(harness, [start, done, noChange]);
  const copy = q(harness.shadow(), "[data-action='copy']");
  copy.fire("click");
  copy.fire("click");
  await tick();
  const placed = Object.assign({}, done.details);
  delete placed.startId;
  assert.strictEqual(harness.copied[0].split("\n").slice(5).join("\n"), [
    "Events: 1",
    "",
    "+0.600s [GlideAjax] ExampleAjax.getManager completed in 440 ms",
    "  Frame: Top frame",
    "  Sent: +0.200s",
    "  Details: " + JSON.stringify(placed),
    "  at getXMLAnswer (example.js:2:1)\n  at onChangeManager (example.js:3:1)",
    "",
  ].join("\n"));
  assert.doesNotMatch(harness.copied[0], /startId|Signal|u_example_text/);
});

test("the category filters say which one is chosen with aria-pressed", () => {
  const { shadow } = openPanel(load());
  const filters = shadow.querySelectorAll("[data-filter]");
  const pressed = () => filters.map((button) => [button.dataset.filter, button.getAttribute("aria-pressed")]);
  assert.deepStrictEqual(pressed(), [
    ["all", "true"], ["g_form", "false"], ["field", "false"], ["glideajax", "false"], ["error", "false"],
  ]);

  ["g_form", "field", "glideajax", "error", "all"].forEach((chosen) => {
    filters.find((button) => button.dataset.filter === chosen).fire("click");
    filters.forEach((button) => {
      assert.strictEqual(button.getAttribute("aria-pressed"), button.dataset.filter === chosen ? "true" : "false",
        button.dataset.filter + " after choosing " + chosen);
      assert.strictEqual(button.className.includes("active"), button.dataset.filter === chosen);
    });
  });
});

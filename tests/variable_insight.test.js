/*
 * Tests for Variable Insight's marks and notices, in content.js.
 *
 *   node --test tests/variable_insight.test.js
 *
 * DEV-ONLY, like its siblings. The block from buildVariableLogicIndex to
 * openList runs against a small DOM shim: elements with attributes, classes,
 * focus and closed shadow roots, and a selector matcher for exactly the
 * selectors that block uses. The matcher throws on anything else, so a test
 * cannot pass because a selector silently matched nothing.
 *
 * Every name, label and sys_id here is synthetic.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8").replace(/\r\n/g, "\n");

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, "source block not found: " + startText);
  return source.slice(start, end);
}

const BLOCK = between(contentSource, "function buildVariableLogicIndex(", "function openList(");
const ITEM_ID = "a".repeat(32);

/* ------------------------------------------------------------------ *
 * The DOM shim
 * ------------------------------------------------------------------ */

/* One compound selector: tag, classes, an id, [attr], [attr^='v'], and one
 * trailing :not([attr]). Anything else throws. */
function compound(selector) {
  let rest = selector.trim();
  const not = [];
  const notMatch = rest.match(/:not\(\[([\w-]+)\]\)$/);
  if (notMatch) {
    not.push(notMatch[1]);
    rest = rest.slice(0, notMatch.index);
  }
  const parts = { tag: "", classes: [], id: "", has: [], prefix: [] };
  const token = /^(?:([a-z]+)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)\^='([^']*)'\]|\[([\w-]+)\])/;
  while (rest) {
    const match = rest.match(token);
    if (!match) throw new Error("the shim does not understand: " + selector);
    if (match[1]) parts.tag = match[1].toUpperCase();
    else if (match[2]) parts.classes.push(match[2]);
    else if (match[3]) parts.id = match[3];
    else if (match[4]) parts.prefix.push([match[4], match[5]]);
    else parts.has.push(match[6]);
    rest = rest.slice(match[0].length);
  }
  return (node) => {
    if (!node || !node.attributes) return false;
    if (parts.tag && node.tagName !== parts.tag) return false;
    const classes = String(node.className || "").split(/\s+/);
    if (!parts.classes.every((name) => classes.includes(name))) return false;
    if (parts.id && node.id !== parts.id) return false;
    if (!parts.has.every((name) => node.hasAttribute(name))) return false;
    if (!parts.prefix.every(([name, value]) => String(node.getAttribute(name) || "").startsWith(value))) {
      return false;
    }
    return not.every((name) => !node.hasAttribute(name));
  };
}

function createDom() {
  let activeElement = null;
  const timers = [];

  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = Object.create(null);
      this.handlers = Object.create(null);
      this.className = "";
      this.id = "";
      this.hidden = false;
      this.title = "";
      this.type = "";
      this.focused = 0;
      this._text = "";
      this.shadow = null;
    }
    get textContent() {
      return this._text + this.children.map((child) => child.textContent).join("");
    }
    set textContent(value) {
      this.children.forEach((child) => { child.parentNode = null; });
      this.children = [];
      this._text = value == null ? "" : String(value);
    }
    get isConnected() {
      let node = this;
      while (node.parentNode) node = node.parentNode;
      return node === document.documentElement || (node.host && node.host.isConnected);
    }
    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
      return node;
    }
    removeChild(node) {
      const at = this.children.indexOf(node);
      if (at >= 0) this.children.splice(at, 1);
      node.parentNode = null;
      if (activeElement && !activeElement.isConnected) activeElement = null;
      return node;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    get nextElementSibling() {
      if (!this.parentNode) return null;
      const siblings = this.parentNode.children;
      return siblings.slice(siblings.indexOf(this) + 1).find((node) => node.attributes) || null;
    }
    after(node) {
      const parent = this.parentNode;
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = parent;
      parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "id") this.id = String(value);
    }
    getAttribute(name) {
      if (name === "id") return this.id || null;
      return name in this.attributes ? this.attributes[name] : null;
    }
    hasAttribute(name) {
      return name === "id" ? Boolean(this.id) : name in this.attributes;
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
    addEventListener(type, handler) {
      (this.handlers[type] = this.handlers[type] || []).push(handler);
    }
    fire(type, extra) {
      const event = Object.assign({
        type,
        target: this,
        preventDefault() { event.defaultPrevented = true; },
        stopPropagation() { event.propagationStopped = true; },
      }, extra || {});
      (this.handlers[type] || []).forEach((handler) => handler(event));
      return event;
    }
    focus() {
      if (activeElement && activeElement !== this) activeElement.fire("blur");
      activeElement = this;
      this.focused += 1;
      this.fire("focus");
    }
    attachShadow(options) {
      assert.strictEqual(options && options.mode, "closed", "a GlideLens root is always closed");
      this.shadow = new Node("#shadow-root");
      this.shadow.host = this;
      return this.shadow;
    }
    descendants() {
      const out = [];
      const walk = (node) => node.children.forEach((child) => {
        if (child.attributes) {
          out.push(child);
          walk(child);
        }
      });
      walk(this);
      return out;
    }
    querySelectorAll(selector) {
      const scoped = selector.match(/^:scope > (.+)$/);
      if (scoped) {
        const matches = compound(scoped[1]);
        return this.children.filter((child) => matches(child));
      }
      const matches = compound(selector);
      return this.descendants().filter(matches);
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    closest(selector) {
      const matches = compound(selector);
      let node = this;
      while (node && node.attributes) {
        if (matches(node)) return node;
        node = node.parentNode;
      }
      return null;
    }
  }

  class Text {
    constructor(value) {
      this.tagName = "#text";
      this.children = [];
      this.parentNode = null;
      this._text = String(value);
    }
    get textContent() { return this._text; }
  }

  const html = new Node("html");
  const head = html.appendChild(new Node("head"));
  const body = html.appendChild(new Node("body"));
  const document = {
    documentElement: html,
    head,
    body,
    get activeElement() { return activeElement || body; },
    createElement: (tag) => new Node(tag),
    createElementNS: (ns, tag) => {
      const node = new Node(tag);
      node.namespaceURI = ns;
      return node;
    },
    createTextNode: (value) => new Text(value),
    querySelectorAll: (selector) => html.querySelectorAll(selector),
    querySelector: (selector) => html.querySelector(selector),
    getElementById: (id) => html.descendants().find((node) => node.id === id) || null,
  };
  return {
    document,
    Node,
    timers,
    setTimeout(fn, ms) {
      timers.push({ fn, ms, done: false });
      return timers.length;
    },
    clearTimeout(handle) {
      if (timers[handle - 1]) timers[handle - 1].done = true;
    },
    /* Runs what is due within `ms`, oldest first, once each. */
    runTimers(ms) {
      timers.forEach((timer) => {
        if (!timer.done && timer.ms <= (ms == null ? Infinity : ms)) {
          timer.done = true;
          timer.fn();
        }
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * A catalog form and the content-script block around it
 * ------------------------------------------------------------------ */

/*
 * Five variables, as Service Portal draws them: a label span in a form group,
 * and the control container the MAIN world stamps. Two are acted on: one by
 * an onChange script and a UI policy action, one by a UI policy action.
 */
const VARIABLES = [
  { name: "requested_for", label: "Requested for", sysId: "1".repeat(32) },
  { name: "laptop_model", label: "Laptop model", sysId: "2".repeat(32) },
  { name: "cost_centre", label: "Cost centre", sysId: "3".repeat(32) },
  { name: "justification", label: "Business justification", sysId: "4".repeat(32) },
  { name: "docking", label: "Needs a docking station", sysId: "5".repeat(32), type: "boolean" },
];
const ROWS = [
  { kind: "client", variable: "1".repeat(32), variableName: "requested_for", variableLabel: "Requested for" },
  {
    kind: "uip",
    actions: [
      { variable: "1".repeat(32), variableName: "requested_for", variableLabel: "Requested for" },
      { variable: "2".repeat(32), variableName: "laptop_model", variableLabel: "Laptop model" },
    ],
  },
  { kind: "client", variable: "1".repeat(32), variableName: "requested_for", variableLabel: "Requested for" },
];

function buildForm(dom, variables) {
  const form = dom.document.body.appendChild(dom.document.createElement("form"));
  const fields = {};
  variables.forEach((variable) => {
    const group = form.appendChild(dom.document.createElement("div"));
    group.className = "form-group";
    const label = group.appendChild(dom.document.createElement("label"));
    const span = label.appendChild(dom.document.createElement("span"));
    span.id = "sp_field_label_" + variable.name;
    span.textContent = variable.label;
    const actual = group.appendChild(dom.document.createElement("span"));
    actual.className = "field-actual";
    actual.setAttribute("ng-switch", "");
    fields[variable.name] = { group, label, span, actual, variable };
  });
  return { form, fields };
}

/* A field's mark: beside its <label>, or for a checkbox inside its control. */
function markOf(field) {
  const next = field.label.nextElementSibling;
  if (next && next.tagName === "BUTTON") return next;
  return field.actual.querySelector(":scope > .snh-var-insight");
}

function stamp(fields) {
  Object.keys(fields).forEach((name) => {
    const { actual, variable } = fields[name];
    if (!actual.isConnected) return;
    actual.setAttribute("data-snh-var", variable.name);
    actual.setAttribute("data-snh-var-sysid", variable.sysId);
    actual.setAttribute("data-snh-var-type", variable.type || "string");
  });
}

function load(options) {
  const opts = options || {};
  const dom = createDom();
  const page = buildForm(dom, opts.variables || VARIABLES);
  const toasts = [];
  const opened = [];
  let reads = 0;
  const SNH = { varInsightOn: false, varInsightData: null };
  const scope = {
    SNH,
    document: dom.document,
    setTimeout: dom.setTimeout,
    clearTimeout: dom.clearTimeout,
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type !== "MAP_PORTAL_VARIABLES") return undefined;
          stamp(page.fields);
          return { ok: true, foundForm: true };
        },
      },
    },
    showToast: (text, isErr, durationMs, toastOptions) => {
      toasts.push({ text, isErr: Boolean(isErr), options: toastOptions || {} });
    },
    removeSnhElements: (selector) => dom.document.querySelectorAll(selector).forEach((node) => node.remove()),
    currentCatalogItemDefinitionSysId: () => (opts.onItem === false ? "" : ITEM_ID),
    isSysId: (value) => /^[0-9a-f]{32}$/.test(String(value || "")),
    fetchCatalogAffectingLogic: async () => {
      reads += 1;
      if (opts.readFails) throw new Error(opts.readFails);
      return { rows: opts.rows || ROWS, setCount: 0, setIds: [] };
    },
    snGetMany: async () => [],
    snFieldDisplay: () => "",
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    SNCatalogInsightUI: { showResults: (result) => opened.push(result.focusVariable) },
  };
  const names = Object.keys(scope);
  const api = new Function(
    ...names,
    /* The palette's message line, null while the palette is closed. */
    "const globalThis = { SNCatalogInsightUI };\nlet paletteToast = " + (opts.paletteOpen ? "{}" : "null") +
      ";\n" + BLOCK +
      "\nreturn { toggleVariableInsightIcons, injectVariableInsightIcons, varInsightStale," +
      " varInsightTargets, makeVariableInsightIcon, showVariableInsightNotice, openVariableInsight," +
      " setPaletteOpen: (open) => { paletteToast = open ? {} : null; } };"
  )(...names.map((name) => scope[name]));
  return Object.assign(api, {
    dom, page, toasts, opened, SNH,
    reads: () => reads,
    marks: () => dom.document.querySelectorAll(".snh-var-insight"),
    style: () => dom.document.getElementById("snh-var-insight-style"),
  });
}

/* The page-corner notice, read through its closed root as a test may. */
function pageNotice(harness) {
  const host = harness.dom.document.getElementById("snh-page-notice");
  if (!host) return null;
  const region = host.shadow.children.find((node) => node.className === "region");
  const box = region.children[0];
  return {
    host,
    region,
    box,
    kind: box.className.replace(/^box ?/, ""),
    text: box.children.find((node) => node.className === "text").textContent,
    hidden: box.hidden,
  };
}

/* ------------------------------------------------------------------ *
 * Item 1: the notices are heard on both routes
 * ------------------------------------------------------------------ */

test("with the palette closed, the read and its result are said in a page-corner notice", async () => {
  const harness = load();
  const running = harness.toggleVariableInsightIcons();
  harness.dom.runTimers(100);
  let notice = pageNotice(harness);
  assert.ok(notice, "Alt+double-click is no longer silent");
  assert.strictEqual(notice.region.getAttribute("role"), "status");
  assert.strictEqual(notice.text, "Reading this item's scripts and policies…");
  assert.strictEqual(notice.kind, "busy", "a spinner, not a timer, while it reads");

  await running;
  harness.dom.runTimers(100);
  notice = pageNotice(harness);
  assert.strictEqual(notice.text, "Marked 2 of 5 variables. Nothing acts on the other 3.");
  assert.strictEqual(notice.kind, "done");
  assert.strictEqual(notice.hidden, false);
  assert.strictEqual(harness.toasts.length, 0, "the palette is closed, so nothing is written to it");
  assert.strictEqual(harness.dom.document.querySelectorAll("#snh-page-notice").length, 1, "one notice, reused");

  harness.dom.runTimers();
  assert.strictEqual(pageNotice(harness).hidden, true, "and it goes away on its own");
  assert.strictEqual(pageNotice(harness).text, "", "leaving the status region empty, not removed");
});

test("with the palette open, the same words go to its message line", async () => {
  const harness = load({ paletteOpen: true });
  await harness.toggleVariableInsightIcons();
  assert.deepStrictEqual(harness.toasts.map((toast) => [toast.text, toast.isErr]), [
    ["Reading this item's scripts and policies…", false],
    ["Marked 2 of 5 variables. Nothing acts on the other 3.", false],
  ]);
  assert.strictEqual(harness.toasts[0].options.busy, true);
  assert.strictEqual(pageNotice(harness), null, "no page notice while the palette is open");
});

test("turning the marks off says so on both routes, and takes the stylesheet with them", async () => {
  for (const paletteOpen of [false, true]) {
    const harness = load({ paletteOpen });
    await harness.toggleVariableInsightIcons();
    assert.ok(harness.style(), "the marks bring their stylesheet");
    harness.toasts.length = 0;
    await harness.toggleVariableInsightIcons();
    harness.dom.runTimers(100);
    const said = paletteOpen ? harness.toasts[0].text : pageNotice(harness).text;
    assert.strictEqual(said, "Variable marks removed.", paletteOpen ? "palette" : "page");
    assert.strictEqual(harness.marks().length, 0);
    assert.strictEqual(harness.style(), null, "the stylesheet goes with the marks");
    assert.strictEqual(harness.SNH.varInsightOn, false);
  }
});

test("every mark says the count, and a fully marked form drops the second sentence", async () => {
  const all = load({ variables: VARIABLES.slice(0, 2) });
  await all.toggleVariableInsightIcons();
  all.dom.runTimers(100);
  assert.strictEqual(pageNotice(all).text, "Marked 2 of 2 variables.");

  const none = load({ rows: [] , variables: VARIABLES.slice(2) });
  await none.toggleVariableInsightIcons();
  none.dom.runTimers(100);
  assert.strictEqual(pageNotice(none).text, "Nothing acts on any of this form's 3 variables, so none is marked.");
  assert.strictEqual(pageNotice(none).kind, "", "no tick when nothing was marked");
  assert.strictEqual(none.SNH.varInsightOn, true, "still on: a variable set loaded later may need a mark");
});

test("the refusals keep their words, and a failed read is said, not swallowed", async () => {
  const off = load({ onItem: false });
  await off.toggleVariableInsightIcons(true);
  off.dom.runTimers(100);
  assert.deepStrictEqual([pageNotice(off).text, pageNotice(off).kind],
    ["Open a Service Portal catalog item first", "err"]);

  const empty = load({ variables: [] });
  await empty.toggleVariableInsightIcons();
  empty.dom.runTimers(100);
  assert.deepStrictEqual([pageNotice(empty).text, pageNotice(empty).kind],
    ["No catalog variables found on this form", "err"]);

  const failed = load({ readFails: "HTTP 403 reading catalog_script_client" });
  await failed.toggleVariableInsightIcons();
  failed.dom.runTimers(100);
  assert.deepStrictEqual([pageNotice(failed).text, pageNotice(failed).kind],
    ["HTTP 403 reading catalog_script_client", "err"]);
  assert.strictEqual(failed.SNH.varInsightOn, false);
});

test("a result shown in the palette clears a spinner left in the page corner", async () => {
  const harness = load();
  harness.showVariableInsightNotice("Reading this item's scripts and policies…", "busy");
  harness.dom.runTimers(100);
  assert.strictEqual(pageNotice(harness).kind, "busy");
  /* The palette opened while the read was out: the result goes there. */
  harness.setPaletteOpen(true);
  harness.showVariableInsightNotice("Marked 2 of 5 variables. Nothing acts on the other 3.", "done");
  assert.strictEqual(harness.toasts[0].text, "Marked 2 of 5 variables. Nothing acts on the other 3.");
  assert.strictEqual(pageNotice(harness).hidden, true, "no spinner left behind in the corner");

  /* And the other way: the palette closed while the read was out. */
  harness.setPaletteOpen(false);
  harness.showVariableInsightNotice("Variable marks removed.", "");
  assert.strictEqual(pageNotice(harness).text, "Variable marks removed.");
});

test("a mark whose data has gone says so in the page corner, where a palette line would be silent", async () => {
  const harness = load();
  await harness.toggleVariableInsightIcons();
  harness.dom.runTimers();
  /* The cached read is gone (as on a navigation to another item) while a mark is still on screen. */
  harness.SNH.varInsightData = null;
  harness.marks()[0].fire("click");
  harness.dom.runTimers(100);
  assert.deepStrictEqual([pageNotice(harness).text, pageNotice(harness).kind, pageNotice(harness).hidden],
    ["Turn the variable marks off and on, then try again", "err", false]);
  assert.strictEqual(harness.toasts.length, 0, "the palette is closed: nothing went to it");
  assert.deepStrictEqual(harness.opened, [], "and Catalog Logic did not open on stale data");

  harness.setPaletteOpen(true);
  harness.openVariableInsight("requested_for", "");
  assert.deepStrictEqual(harness.toasts.map((toast) => [toast.text, toast.isErr]),
    [["Turn the variable marks off and on, then try again", true]], "the same words with the palette open");
});

test("a quick second notice is never overwritten by the first", () => {
  const harness = load();
  /* Both arrive before the new status region has had its moment. */
  harness.showVariableInsightNotice("Reading this item's scripts and policies…", "busy");
  harness.showVariableInsightNotice("Marked 2 of 5 variables. Nothing acts on the other 3.", "done");
  assert.strictEqual(pageNotice(harness).text, "", "a region created this moment waits before it speaks");
  harness.dom.runTimers(100);
  assert.strictEqual(pageNotice(harness).text, "Marked 2 of 5 variables. Nothing acts on the other 3.");
  assert.strictEqual(pageNotice(harness).kind, "done");
});

/* ------------------------------------------------------------------ *
 * Item 3: the mark is a real button with its own background
 * ------------------------------------------------------------------ */

test("a mark is a real button, named by the variable's label and what a click does", async () => {
  const harness = load();
  await harness.toggleVariableInsightIcons();
  const marks = harness.marks();
  const byName = (name) => marks.find((mark) => mark.getAttribute("data-snh-var-mark") === name);
  const requested = byName("requested_for");
  assert.strictEqual(requested.tagName, "BUTTON");
  assert.strictEqual(requested.type, "button", "never a submit inside the catalog form");
  assert.strictEqual(requested.getAttribute("role"), null, "a button, not a span playing one");
  const said = "3 scripts and policies act on “Requested for”. Open them in Catalog Logic.";
  assert.strictEqual(requested.getAttribute("aria-label"), said);
  assert.strictEqual(requested.title, said);
  assert.strictEqual(byName("laptop_model").getAttribute("aria-label"),
    "1 script or policy acts on “Laptop model”. Open it in Catalog Logic.");

  /* Built node by node: an SVG drawn with createElementNS, and the count as text. */
  const [svg, count] = requested.children;
  assert.strictEqual(svg.tagName, "SVG");
  assert.strictEqual(svg.namespaceURI, "http://www.w3.org/2000/svg");
  assert.strictEqual(svg.getAttribute("aria-hidden"), "true");
  assert.strictEqual(count.tagName, "#text");
  assert.strictEqual(count.textContent, "3");

  requested.fire("click");
  assert.deepStrictEqual(harness.opened, [{ name: "requested_for", sysId: "1".repeat(32), label: "Requested for" }]);
});

test("the label falls back to the variable's name when no label was read", () => {
  const harness = load();
  const mark = harness.makeVariableInsightIcon("cost_centre", "", { count: 2, label: "" });
  assert.strictEqual(mark.getAttribute("aria-label"),
    "2 scripts and policies act on “cost_centre”. Open them in Catalog Logic.");
});

test("the marks are styled from one injected stylesheet that starts from all:initial", async () => {
  const harness = load();
  await harness.toggleVariableInsightIcons();
  await harness.injectVariableInsightIcons();
  assert.strictEqual(harness.dom.document.querySelectorAll("#snh-var-insight-style").length, 1, "once");
  const css = harness.style().textContent;
  assert.match(css, /button\.snh-var-insight\{all:initial;/, "a theme's button rules cannot reach in");
  assert.match(css, /background:#0b5f57;color:#fff/);
  assert.match(css, /box-shadow:0 0 0 1px rgba\(255,255,255,\.85\)/, "a thin white edge for dark pages");
  assert.match(css, /button\.snh-var-insight:focus-visible\{outline:2px solid #0b5f57;outline-offset:3px/,
    "its own focus ring, outside that edge");
  assert.match(css, /button\.snh-var-insight:hover\{/);
  assert.match(css, /@media \(forced-colors:active\)/);
  harness.marks().forEach((mark) => assert.strictEqual(mark.attributes.style, undefined, "no inline style"));

  const code = BLOCK.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
  assert.ok(!/mouseenter|mouseleave/.test(code), "hover is the stylesheet's, not a script's");
  assert.ok(!/innerHTML/.test(code), "the marks and the notice have no markup path");
});

test("white on the mark's teal clears 7:1", () => {
  const linear = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
  const luminance = (hex) => [0, 2, 4]
    .map((at) => linear(parseInt(hex.slice(1 + at, 3 + at), 16)))
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  assert.ok(ratio("#ffffff", "#0b5f57") >= 7, ratio("#ffffff", "#0b5f57").toFixed(2));
  assert.ok(ratio("#ffffff", "#084a44") >= 7, "and on hover");
});

/* ------------------------------------------------------------------ *
 * Item 6: no mark where nothing acts on the variable
 * ------------------------------------------------------------------ */

test("only variables something acts on get a mark", async () => {
  const harness = load();
  await harness.toggleVariableInsightIcons();
  const marked = harness.marks().map((mark) => mark.getAttribute("data-snh-var-mark")).sort();
  assert.deepStrictEqual(marked, ["laptop_model", "requested_for"]);
  const { cost_centre: cost, docking } = harness.page.fields;
  assert.strictEqual(markOf(cost), null);
  assert.strictEqual(markOf(docking), null);
  assert.strictEqual(cost.group.querySelectorAll(".snh-var-insight").length, 0);
});

test("a mark sits beside the field's label, never inside it, so the field keeps its own name", async () => {
  const rows = ROWS.concat([{ kind: "uip", actions: [{ variable: "5".repeat(32), variableName: "docking" }] }]);
  const harness = load({ rows });
  await harness.toggleVariableInsightIcons();
  const { requested_for: requested, docking } = harness.page.fields;
  const mark = markOf(requested);
  assert.ok(mark, "the mark is the label's next sibling");
  assert.strictEqual(mark.parentNode, requested.group);
  assert.strictEqual(requested.label.querySelectorAll(".snh-var-insight").length, 0,
    "inside the label, its name was read as part of the field's");
  /* A checkbox has no label span to sit beside: its mark goes in its control, as before. */
  const box = markOf(docking);
  assert.ok(box);
  assert.strictEqual(box.parentNode, docking.actual);
  assert.strictEqual(harness.varInsightStale(), false, "both placements are found again");
});

test("the staleness check skips the same variables, so the observer settles", async () => {
  const harness = load();
  await harness.toggleVariableInsightIcons();
  assert.strictEqual(harness.varInsightStale(), false,
    "three unmarked variables must not read as stale, or the observer re-applies forever");

  /* Angular drops a marked variable's mark: that IS stale. */
  markOf(harness.page.fields.laptop_model).remove();
  assert.strictEqual(harness.varInsightStale(), true);
  const { marked, total } = await harness.injectVariableInsightIcons();
  assert.deepStrictEqual([marked, total], [2, 5]);
  assert.strictEqual(harness.varInsightStale(), false);
  assert.strictEqual(harness.marks().length, 2, "re-applied once, not doubled");
});

/* ------------------------------------------------------------------ *
 * Where focus lands
 * ------------------------------------------------------------------ */

test("a focused mark that Angular re-creates takes focus back; otherwise focus is left alone", async () => {
  const harness = load();
  await harness.toggleVariableInsightIcons();
  const field = harness.page.fields.requested_for;
  markOf(field).focus();

  /* The field is re-created: the old mark goes, and focus falls to the page. */
  markOf(field).remove();
  assert.strictEqual(harness.dom.document.activeElement, harness.dom.document.body);
  await harness.injectVariableInsightIcons();
  const again = markOf(field);
  assert.strictEqual(harness.dom.document.activeElement, again, "back on the same variable's mark");

  /* Focus moved on deliberately: a re-created mark must not take it. */
  const elsewhere = harness.dom.document.body.appendChild(harness.dom.document.createElement("input"));
  elsewhere.focus();
  markOf(field).remove();
  await harness.injectVariableInsightIcons();
  assert.strictEqual(harness.dom.document.activeElement, elsewhere);
});

/* ------------------------------------------------------------------ *
 * The palette row
 * ------------------------------------------------------------------ */

test("the palette says what the command marks", () => {
  const command = between(contentSource, 'id: "toggle-variable-insight",', "},");
  assert.match(command, /description: "Mark each variable that scripts or UI policies act on"/);
});

/*
 * Tests for the counting logic in code_search_ui.js.
 *
 *   node --test tests/code_search_ui.test.js
 *
 * DEV-ONLY, like its siblings. The two numbers the panel prints are logic, and
 * they are the reason these tests began: hit identity is table+sysId+FIELD, so
 * one record matching in three fields is three findings. Printing that as "3"
 * beside a button that then opens one record is a count contradicting itself
 * one click later.
 *
 * The module assigns to globalThis and touches the DOM only inside mount(), so
 * the logic tests load it under node:vm with no browser, the same way
 * code_search.js does. The rendered tests at the end run the real panel against
 * a small DOM shim copied from tests/catalog_insight_ui.test.js. All names and
 * ids are synthetic.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadUI() {
  const file = path.join(__dirname, "..", "code_search_ui.js");
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context.SNCodeSearchUI;
}

const UI = loadUI();

const hit = (sysId, field, table) => ({
  table: table || "sys_ui_action",
  sysId,
  field,
});

test("the panel module loads without a DOM", () => {
  assert.ok(UI, "SNCodeSearchUI missing from globalThis");
  assert.strictEqual(typeof UI.countRecords, "function");
});

test("one record matching three fields counts as one record", () => {
  const hits = [hit("a", "name"), hit("a", "condition"), hit("a", "script")];
  assert.strictEqual(hits.length, 3, "three findings");
  assert.strictEqual(UI.countRecords(hits), 1, "one record");
});

test("records are counted per table, so the same sys_id in two tables is two", () => {
  const hits = [hit("same", "script", "sys_script"), hit("same", "script", "sys_ui_action")];
  assert.strictEqual(UI.countRecords(hits), 2);
});

test("counting an empty or missing list does not throw", () => {
  assert.strictEqual(UI.countRecords([]), 0);
  assert.strictEqual(UI.countRecords(null), 0);
});

test("a record's field matches are clustered together", () => {
  /* The real interleaving: Tier 1 streams its hits before the adapters do, so
   * one UI Action's `script` hit (instance index) and its `condition` hit (our
   * adapter) arrive with other records in between. */
  const hits = [
    hit("a", "script"),
    hit("b", "script"),
    hit("a", "condition"),
    hit("b", "name"),
    hit("a", "name"),
  ];
  const clustered = UI.clusterByRecord(hits).map((h) => h.sysId + "." + h.field);
  assert.deepStrictEqual(Array.from(clustered), [
    "a.script",
    "a.condition",
    "a.name",
    "b.script",
    "b.name",
  ]);
});

test("clustering keeps records in the order they first appeared", () => {
  const hits = [hit("z", "script"), hit("m", "script"), hit("z", "name")];
  const order = UI.clusterByRecord(hits).map((h) => h.sysId);
  assert.deepStrictEqual(Array.from(order), ["z", "z", "m"]);
});

test("a source that needs attention and found nothing shows its status alone", () => {
  ["denied", "absent", "timed-out", "error"].forEach((status) => {
    assert.strictEqual(
      UI.groupCountText({ hits: [], records: 0, status }),
      "",
      status + " with no hits must not read as 0 matches"
    );
  });
});

test("a source with hits keeps its count, whatever its status", () => {
  const hits = [hit("a", "name"), hit("a", "script")];
  assert.strictEqual(
    UI.groupCountText({ hits, records: 1, status: "denied" }),
    "2 matches in 1 record"
  );
  assert.strictEqual(
    UI.groupCountText({ hits: [hit("a", "name")], records: 1, status: "complete" }),
    "1 match in 1 record"
  );
});

test("the open-in-list button's rule matches where the button is appended", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "code_search_ui.js"), "utf8");
  /* The button is a child of the group, after its rows; a rule scoped under
   * .group-head never matched it and left a browser-default button. */
  assert.match(source, /group\.appendChild\(listButton\)/);
  assert.match(source, /\.group > \.open-list\{[^}]*margin:6px 20px 10px/);
  assert.doesNotMatch(source, /\.group-head \.open-list/);
  assert.doesNotMatch(source, /listButton\.style/);
});

test("clustering never loses or duplicates a hit", () => {
  const hits = [
    hit("a", "script"),
    hit("b", "script"),
    hit("a", "condition"),
    hit("c", "name"),
    hit("b", "condition"),
  ];
  const clustered = UI.clusterByRecord(hits);
  assert.strictEqual(clustered.length, hits.length);
  hits.forEach((original) => {
    assert.ok(clustered.indexOf(original) !== -1, "hit survived clustering");
  });
});

/* ------------------------------------------------------------------ *
 * One record, one head: the grouping helper
 * ------------------------------------------------------------------ */

const snip = (line, text) => ({ line, text, matchStart: 0, matchEnd: 0 });

test("grouping by record keeps record order and field order as they first appeared", () => {
  const hits = [
    hit("a", "script"),
    hit("b", "script"),
    hit("a", "condition"),
    hit("b", "name"),
    hit("a", "name"),
  ];
  const records = UI.groupHitsByRecord(hits);
  assert.deepStrictEqual(Array.from(records.map((record) => record.sysId)), ["a", "b"]);
  assert.deepStrictEqual(
    Array.from(records[0].fields.map((field) => field.field)),
    ["script", "condition", "name"]
  );
  assert.deepStrictEqual(Array.from(records[1].fields.map((field) => field.field)), ["script", "name"]);
});

test("grouping by record never loses or duplicates a hit or a snippet", () => {
  const hits = [
    Object.assign(hit("a", "script"), { snippets: [snip(4, "one"), snip(12, "two")] }),
    Object.assign(hit("b", "script"), { snippets: [snip(1, "three")] }),
    Object.assign(hit("a", "condition"), { snippets: [snip(1, "four")] }),
    Object.assign(hit("c", "name"), { snippets: [] }),
  ];
  const records = UI.groupHitsByRecord(hits);
  const grouped = [];
  const snippets = [];
  records.forEach((record) => record.fields.forEach((field) => {
    field.hits.forEach((each) => grouped.push(each));
    field.snippets.forEach((entry) => snippets.push(entry.snippet.text));
  }));
  assert.strictEqual(grouped.length, hits.length);
  hits.forEach((original) => assert.strictEqual(grouped.filter((each) => each === original).length, 1));
  assert.deepStrictEqual(snippets.sort(), ["four", "one", "three", "two"]);
  /* record.hits is the same set, in arrival order within the record. */
  assert.deepStrictEqual(Array.from(records[0].hits), [hits[0], hits[2]]);
});

test("grouping by record keeps the same sys_id in two tables as two records", () => {
  const records = UI.groupHitsByRecord([
    hit("same", "script", "sys_script"),
    hit("same", "script", "sys_ui_action"),
  ]);
  assert.strictEqual(records.length, 2);
  assert.deepStrictEqual(Array.from(records.map((record) => record.table)), ["sys_script", "sys_ui_action"]);
});

test("two hits for one record and one field merge under one label and keep every snippet", () => {
  const first = Object.assign(hit("a", "script"), { snippets: [snip(3, "from the index")] });
  const second = Object.assign(hit("a", "script"), {
    snippets: [snip(9, "from the adapter")],
    redacted: true,
  });
  const [record] = UI.groupHitsByRecord([first, second]);
  assert.strictEqual(record.fields.length, 1);
  assert.deepStrictEqual(
    Array.from(record.fields[0].snippets.map((entry) => [entry.snippet.text, entry.redacted])),
    [["from the index", false], ["from the adapter", true]],
    "each snippet keeps the redaction of the hit it came from"
  );
});

/* An instance-index hit's subtitle is the matched field's label; an adapter
 * hit's is a column of the record. The head describes the record. */
const indexHit = (sysId, field, extra) =>
  Object.assign(hit(sysId, field), { kind: "instance" }, extra);
const adapterHit = (sysId, field, extra) =>
  Object.assign(hit(sysId, field), { kind: "action" }, extra);

test("record head: an index hit first and an adapter hit later takes the adapter's subtitle", () => {
  const [record] = UI.groupHitsByRecord([
    indexHit("a", "script", { name: "Example action", subtitle: "Script" }),
    adapterHit("a", "condition", { name: "Example action", subtitle: "example_table" }),
  ]);
  assert.strictEqual(record.name, "Example action");
  assert.strictEqual(record.subtitle, "example_table", "not the first field's label");
});

test("record head: an adapter hit first keeps its own subtitle", () => {
  const [record] = UI.groupHitsByRecord([
    adapterHit("a", "condition", { name: "Example action", subtitle: "example_table" }),
    indexHit("a", "script", { name: "Example action (index)", subtitle: "Script" }),
  ]);
  assert.strictEqual(record.name, "Example action");
  assert.strictEqual(record.subtitle, "example_table");
});

test("record head: index hits only have no subtitle; the field column says which field matched", () => {
  const [record] = UI.groupHitsByRecord([
    indexHit("a", "name", { name: "Example action", subtitle: "Name" }),
    indexHit("a", "script", { name: "Example action", subtitle: "Script" }),
  ]);
  assert.strictEqual(record.name, "Example action");
  assert.strictEqual(record.subtitle, "");
});

test("record head: a name that is only the sys_id gives way to a later real name", () => {
  const sysId = "0123456789abcdef0123456789abcdef";
  const [record] = UI.groupHitsByRecord([
    indexHit(sysId, "script", { name: sysId, subtitle: "Script" }),
    adapterHit(sysId, "condition", { name: "Example action", subtitle: "" }),
    adapterHit(sysId, "name", { name: "Later name", subtitle: "example_table" }),
  ]);
  assert.strictEqual(record.name, "Example action", "the first real name");
  assert.strictEqual(record.subtitle, "", "the first non-index hit's subtitle, even when empty");

  const [alone] = UI.groupHitsByRecord([indexHit(sysId, "script", { name: sysId })]);
  assert.strictEqual(alone.name, sysId, "with no real name the sys_id stays");
});

/* ------------------------------------------------------------------ *
 * The rendered panel, against a DOM shim
 *
 * Copied from tests/catalog_insight_ui.test.js rather than shared, as the
 * panels' own helpers are. Its querySelector throws on a selector it does not
 * understand, so a test cannot pass because a selector silently matched
 * nothing.
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
  /* Focus, modelled as tests/record_search_ui.test.js does: one focused node;
   * detaching it, or anything around it, drops focus to nowhere, as Chrome
   * does; and focusing a detached node does nothing. Without the drop a
   * rebuild would "keep" focus on a node that is no longer on the page. */
  let activeElement = null;
  function dropFocusWithin(node) {
    for (let current = activeElement; current; current = current.parentNode) {
      if (current === node) {
        activeElement = null;
        return;
      }
    }
  }

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
      this.style = {};
      this.disabled = false;
      this.hidden = false;
      this.focused = 0;
      this._text = "";
    }
    get isConnected() {
      let node = this;
      while (node.parentNode) node = node.parentNode;
      if (node.host) return node.host.isConnected;
      return node.tagName === "HTML";
    }
    focus() {
      if (!this.isConnected) return;
      this.focused += 1;
      activeElement = this;
    }
    get classList() {
      const node = this;
      const list = () => String(node.className || "").split(/\s+/).filter(Boolean);
      return {
        contains: (name) => list().includes(name),
        toggle(name, force) {
          const has = list().includes(name);
          const want = force === undefined ? !has : Boolean(force);
          if (want && !has) node.className = list().concat([name]).join(" ");
          if (!want && has) node.className = list().filter((item) => item !== name).join(" ");
          return want;
        },
      };
    }
    get textContent() {
      return this._text + this.children
        .filter((child) => child.tagName !== "STYLE")
        .map((child) => child.textContent)
        .join("");
    }
    set textContent(value) {
      this.children.forEach((child) => {
        dropFocusWithin(child);
        child.parentNode = null;
      });
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
      dropFocusWithin(node);
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
      node.parentNode = null;
      return node;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
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
      /* ShadowRoot.activeElement: the focused node, if it is inside. */
      Object.defineProperty(shadow, "activeElement", {
        get() {
          let node = activeElement;
          while (node && node !== shadow) node = node.parentNode;
          return node === shadow ? activeElement : null;
        },
      });
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
            if (name === "title") node.title = value;
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

  /* Window listeners are kept, so a test can press a key the way the panel
   * hears it: on window, in the capture phase. */
  const windowHandlers = [];
  const windowObject = {
    addEventListener(type, handler) { windowHandlers.push({ type, handler }); },
    removeEventListener(type, handler) {
      const index = windowHandlers.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index >= 0) windowHandlers.splice(index, 1);
    },
  };
  windowObject.top = windowObject;
  const documentElement = new El("html");
  const body = new El("body");
  documentElement.appendChild(body);
  const document = {
    createElement: (tag) => new El(tag),
    createTextNode: (value) => new TextNode(value),
    documentElement,
    body,
    get activeElement() { return activeElement; },
  };
  const press = (key, extra) => {
    const event = Object.assign({
      key,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true; },
      stopPropagation() {},
    }, extra || {});
    windowHandlers
      .filter((entry) => entry.type === "keydown")
      .slice()
      .forEach((entry) => entry.handler(event));
    return event;
  };
  return { document, window: windowObject, press, El };
}

const HOST_ID = "sn-dev-helper-code-search";
const ORIGIN = "https://example.service-now.com";
const UI_SOURCE = fs.readFileSync(path.join(__dirname, "..", "code_search_ui.js"), "utf8");

function rendered() {
  const dom = createDom();
  const opened = [];
  const sandbox = {
    document: dom.document,
    window: dom.window,
    location: { origin: ORIGIN },
    chrome: { runtime: { sendMessage: (message) => { opened.push(message); } } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(UI_SOURCE, sandbox, { filename: "code_search_ui.js" });
  return {
    ui: sandbox.SNCodeSearchUI,
    opened,
    dom,
    shadow() {
      const host = dom.document.documentElement.children.find((node) => node.id === HOST_ID);
      return host ? host.shadowRoot : null;
    },
  };
}

const ID = (n) => String(n).padStart(32, "0");

/* A term is highlighted by offsets, so each snippet carries where it is. */
const TERM = "hasRole";
const line = (number, text) => ({
  line: number,
  text,
  matchStart: text.indexOf(TERM),
  matchEnd: text.indexOf(TERM) + TERM.length,
});

const fieldHit = (sysId, field, snippets, extra) => Object.assign({
  table: "sys_ui_action",
  sysId,
  field,
  name: sysId === ID(1) ? "Example delegate action" : "Example reset action",
  subtitle: "example_table",
  sourceLabel: "UI Actions",
  snippets,
}, extra || {});

const SUMMARY = {
  id: "ui-action",
  label: "UI Actions",
  groupKey: "sys_ui_action",
  groupLabel: "UI Actions",
  table: "sys_ui_action",
  status: "complete",
  count: 3,
};

function panelWithResults(hits) {
  const harness = rendered();
  harness.ui.open({ term: TERM });
  harness.ui.addSource(SUMMARY, hits);
  harness.ui.complete({ truncated: false });
  return harness;
}

const STANDARD_HITS = () => [
  fieldHit(ID(1), "condition", [line(1, "gs.hasRole('example_admin') && current.active")]),
  fieldHit(ID(1), "script", [
    line(4, "if (!gs.hasRole('example_delegator')) {"),
    line(12, "var allowed = gs.hasRole('example_admin');"),
  ]),
  fieldHit(ID(2), "script", [line(7, "if (gs.hasRole('example_approver')) reset();")]),
];

const recordBlocks = (shadow) => shadow.querySelectorAll(".rows .rec");
const fieldNames = (block) => block.querySelectorAll("dt").map((node) => node.textContent);

test("rendered: each record is drawn once, under one head", () => {
  const shadow = panelWithResults(STANDARD_HITS()).shadow();
  const blocks = recordBlocks(shadow);
  assert.strictEqual(blocks.length, 2, "three field matches, two records, two heads");
  assert.deepStrictEqual(
    blocks.map((block) => block.querySelector(".rec-name").textContent),
    ["Example delegate action", "Example reset action"]
  );
  blocks.forEach((block) =>
    assert.strictEqual(block.querySelectorAll("button").length, 1, "one tab stop per record"));
  /* The counts are unchanged: matches and records, and the list button. */
  assert.strictEqual(shadow.querySelector(".group-head .count").textContent, "3 matches in 2 records");
  assert.strictEqual(shadow.querySelector("[data-count='total']").textContent, "3");
  assert.strictEqual(shadow.querySelector("[data-count='records']").textContent, "2");
  assert.strictEqual(shadow.querySelector(".open-list").textContent, "Open these 2 records in a list ↗");
});

test("rendered: one dt per field, holding every snippet for that field", () => {
  const [first, second] = recordBlocks(panelWithResults(STANDARD_HITS()).shadow());
  assert.deepStrictEqual(fieldNames(first), ["condition", "script"]);
  assert.deepStrictEqual(fieldNames(second), ["script"]);
  const scriptLines = first.querySelectorAll("dd")[1].querySelectorAll(".snippet");
  assert.deepStrictEqual(
    scriptLines.map((node) => node.querySelector(".line").textContent),
    ["4", "12"],
    "a field with two matching lines says its name once"
  );
  assert.strictEqual(scriptLines[0].querySelector("mark").textContent, TERM);
});

test("rendered: the name opens the record; a click on the code does nothing", () => {
  const harness = panelWithResults(STANDARD_HITS());
  const [first] = recordBlocks(harness.shadow());
  const name = first.querySelector(".rec-name");
  assert.strictEqual(name.tagName, "BUTTON");
  assert.strictEqual(name.title, "Open sys_ui_action record");

  first.querySelector(".snippet").fire("click");
  first.fire("click");
  assert.strictEqual(harness.opened.length, 0, "the code is text to select, not a control");
  [first, first.querySelector(".fields"), first.querySelector("dd"), first.querySelector(".snippet")]
    .forEach((node) => assert.ok(!node.handlers.click, "no click handler on " + node.tagName));

  name.fire("click");
  assert.strictEqual(harness.opened.length, 1);
  assert.strictEqual(harness.opened[0].type, "OPEN_URL");
  assert.strictEqual(harness.opened[0].url, ORIGIN + "/sys_ui_action.do?sys_id=" + ID(1));
});

test("rendered: a filter leaves a record with only its fields that still match", () => {
  const harness = panelWithResults(STANDARD_HITS());
  const search = harness.shadow().querySelector(".search");
  search.value = "example_delegator";
  search.fire("input");
  const blocks = recordBlocks(harness.shadow());
  assert.strictEqual(blocks.length, 1);
  assert.deepStrictEqual(fieldNames(blocks[0]), ["script"], "the condition no longer matches");
  /* Filtering is per hit, as before: the whole script field stays with both lines. */
  assert.strictEqual(blocks[0].querySelectorAll(".snippet").length, 2);
  assert.strictEqual(harness.shadow().querySelector("[data-count='total']").textContent, "1");
});

test("rendered: a redacted field keeps its wording, field by field", () => {
  const hits = [
    fieldHit(ID(1), "condition", [line(1, "gs.hasRole('example_admin')")]),
    fieldHit(ID(1), "script", [{ line: 2, text: "var api_token = '...';" }], { redacted: true }),
  ];
  const [block] = recordBlocks(panelWithResults(hits).shadow());
  const [condition, script] = block.querySelectorAll("dd");
  assert.strictEqual(condition.querySelectorAll(".redacted").length, 0);
  const redacted = script.querySelector(".redacted");
  assert.ok(redacted, "the redacted field still says so");
  assert.strictEqual(
    redacted.textContent,
    "var api_token = '...';  (redacted — the name suggests a secret)"
  );
});

test("rendered: the same field from two sources is one label with both lines", () => {
  const harness = rendered();
  harness.ui.open({ term: TERM });
  harness.ui.addSource(SUMMARY, [fieldHit(ID(1), "script", [line(4, "gs.hasRole('a')")])]);
  harness.ui.addSource(
    Object.assign({}, SUMMARY, { id: "instance:sys_ui_action" }),
    [fieldHit(ID(1), "script", [line(9, "gs.hasRole('b')")])]
  );
  const [block] = recordBlocks(harness.shadow());
  assert.deepStrictEqual(fieldNames(block), ["script"]);
  assert.deepStrictEqual(
    block.querySelectorAll(".snippet .line").map((node) => node.textContent),
    ["4", "9"]
  );
});

test("rendered: a record found first by the index shows its record subtitle, and a field label still filters", () => {
  const harness = rendered();
  harness.ui.open({ term: TERM });
  harness.ui.addSource(SUMMARY, [
    fieldHit(ID(1), "script", [line(4, "gs.hasRole('a')")], { kind: "instance", subtitle: "Script" }),
  ]);
  harness.ui.addSource(Object.assign({}, SUMMARY, { id: "ui-action-adapter" }), [
    fieldHit(ID(1), "condition", [line(1, "gs.hasRole('b')")], { kind: "action", subtitle: "example_table" }),
  ]);
  const [block] = recordBlocks(harness.shadow());
  assert.strictEqual(block.querySelector(".row-sub").textContent, "example_table");

  const search = harness.shadow().querySelector(".search");
  search.value = "script";
  search.fire("input");
  const [filtered] = recordBlocks(harness.shadow());
  assert.deepStrictEqual(fieldNames(filtered), ["script"], "the index hit's field label is still searchable");
  assert.strictEqual(filtered.querySelector(".row-sub"), null, "left with only an index hit, the head has no subtitle");
});

test("rendered: the dead per-match row styles are gone and the narrow form is a container query", () => {
  assert.doesNotMatch(UI_SOURCE, /\.row-top|\.row-field|\.row-name|renderRow\b/);
  assert.match(UI_SOURCE, /\.rows\{[^}]*container:rows \/ inline-size/);
  assert.match(UI_SOURCE, /@container rows \(max-width:639px\)\{\s*\.fields\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(UI_SOURCE, /\.rec-name:focus-visible\{outline:2px solid var\(--teal\)/);
});

/* ------------------------------------------------------------------ *
 * Keyboard and screen reader: focus in, Tab kept inside, focus back on
 * close, focus kept across a rebuild, expanded state, one status line.
 * ------------------------------------------------------------------ */

const active = (harness) => harness.dom.document.activeElement;
const byId = (shadow, id) => shadow.querySelectorAll("div").find((node) => node.id === id) || null;
const liveText = (shadow) => shadow.querySelector("[data-live]").textContent;
const recordName = (shadow, text) =>
  shadow.querySelectorAll(".rec-name").find((node) => node.textContent === text) || null;
const groupHead = (shadow, label) =>
  shadow.querySelectorAll(".group-head").find((node) => node.textContent.includes(label)) || null;

/* An opener on the page, focused before the panel opens. */
function openedFrom(harness) {
  const opener = harness.dom.document.createElement("button");
  harness.dom.document.body.appendChild(opener);
  opener.focus();
  harness.ui.open({ term: TERM });
  return opener;
}

test("a11y: opening focuses Close, and the dialog is modal", () => {
  const harness = rendered();
  openedFrom(harness);
  const shadow = harness.shadow();
  assert.strictEqual(active(harness), shadow.querySelector(".close"));
  assert.strictEqual(shadow.querySelector(".panel").getAttribute("aria-modal"), "true");
});

test("a11y: Tab and Shift+Tab wrap inside the panel", () => {
  const harness = rendered();
  openedFrom(harness);
  harness.ui.addSource(SUMMARY, STANDARD_HITS());
  harness.ui.complete({ truncated: false });
  const shadow = harness.shadow();
  const first = shadow.querySelector(".close");
  const last = shadow.querySelector("[data-action='close']");

  first.focus();
  const back = harness.dom.press("Tab", { shiftKey: true });
  assert.ok(back.defaultPrevented);
  assert.strictEqual(active(harness), last, "Shift+Tab from the first control goes to the last");

  const forward = harness.dom.press("Tab");
  assert.ok(forward.defaultPrevented);
  assert.strictEqual(active(harness), first, "Tab from the last control goes to the first");

  harness.dom.press("Tab");
  assert.strictEqual(active(harness), shadow.querySelector(".search"), "and on to the next one");

  /* Cancel is disabled once the search has finished, so Tab passes it by. */
  shadow.querySelector(".drawer-head").focus();
  harness.dom.press("Tab");
  assert.strictEqual(active(harness), last);
});

test("a11y: closing gives focus back to what had it, by button or by Escape", () => {
  const harness = rendered();
  const opener = openedFrom(harness);
  harness.shadow().querySelector("[data-action='close']").fire("click");
  assert.strictEqual(harness.shadow(), null);
  assert.strictEqual(active(harness), opener);

  const again = openedFrom(harness);
  assert.notStrictEqual(active(harness), again);
  harness.dom.press("Escape");
  assert.strictEqual(harness.shadow(), null);
  assert.strictEqual(active(harness), again);
});

test("a11y: focus on a record name survives a source reporting, found by its key not its place", () => {
  const harness = rendered();
  openedFrom(harness);
  /* A denied source with nothing found is drawn last; when the same table
   * then reports matches, that group moves to the top, above the record. */
  harness.ui.addSource({
    id: "script-denied", label: "Business Rules", groupKey: "sys_script",
    groupLabel: "Business Rules", table: "sys_script", status: "denied", count: 0,
  }, []);
  harness.ui.addSource(SUMMARY, STANDARD_HITS());
  const shadow = harness.shadow();
  const before = recordName(shadow, "Example reset action");
  before.focus();
  const headsBefore = shadow.querySelectorAll(".group-head").map((node) => node.textContent);

  harness.ui.addSource({
    id: "script-adapter", label: "Business Rules", groupKey: "sys_script",
    groupLabel: "Business Rules", table: "sys_script", status: "complete", count: 1,
  }, [fieldHit(ID(9), "script", [line(3, "gs.hasRole('example_other')")], {
    table: "sys_script", name: "Example business rule", sourceLabel: "Business Rules",
  })]);

  const headsAfter = shadow.querySelectorAll(".group-head").map((node) => node.textContent);
  assert.notDeepStrictEqual(headsAfter, headsBefore, "the groups did move");
  const after = recordName(shadow, "Example reset action");
  assert.notStrictEqual(after, before, "the list was rebuilt");
  assert.strictEqual(before.isConnected, false);
  assert.strictEqual(active(harness), after, "focus is on the same record's new name");
});

test("a11y: focus on an open-in-list button survives a rebuild", () => {
  const harness = rendered();
  openedFrom(harness);
  harness.ui.addSource(SUMMARY, STANDARD_HITS());
  harness.shadow().querySelector(".open-list").focus();
  harness.ui.complete({ truncated: false });
  assert.strictEqual(active(harness), harness.shadow().querySelector(".open-list"));
});

test("a11y: focus on a group head survives collapsing and opening it", () => {
  const harness = rendered();
  openedFrom(harness);
  harness.ui.addSource(SUMMARY, STANDARD_HITS());
  const shadow = harness.shadow();
  const head = groupHead(shadow, "UI Actions");
  head.focus();
  head.fire("click");

  const collapsedHead = groupHead(shadow, "UI Actions");
  assert.notStrictEqual(collapsedHead, head);
  assert.strictEqual(active(harness), collapsedHead);
  assert.strictEqual(collapsedHead.getAttribute("aria-expanded"), "false");

  collapsedHead.fire("click");
  const openHead = groupHead(shadow, "UI Actions");
  assert.strictEqual(active(harness), openHead);
  assert.strictEqual(openHead.getAttribute("aria-expanded"), "true");
});

test("a11y: focus in the filter box, or outside the list, is not moved by a rebuild", () => {
  const harness = rendered();
  openedFrom(harness);
  harness.ui.addSource(SUMMARY, STANDARD_HITS());
  const shadow = harness.shadow();
  const search = shadow.querySelector(".search");
  search.focus();
  search.value = "reset";
  search.fire("input");
  assert.strictEqual(active(harness), search, "typing a filter keeps the box focused");
  harness.ui.addSource(Object.assign({}, SUMMARY, { id: "ui-action-2" }), []);
  harness.ui.complete({ truncated: false });
  assert.strictEqual(active(harness), search, "a source reporting does not take it");

  const footerClose = shadow.querySelector("[data-action='close']");
  footerClose.focus();
  harness.ui.addSource(Object.assign({}, SUMMARY, { id: "ui-action-3" }), []);
  assert.strictEqual(active(harness), footerClose);
});

test("a11y: an error that empties the list keeps focus in the panel", () => {
  const harness = rendered();
  openedFrom(harness);
  harness.ui.addSource(SUMMARY, STANDARD_HITS());
  const shadow = harness.shadow();
  recordName(shadow, "Example delegate action").focus();
  harness.ui.showError("The search could not run.");
  assert.strictEqual(active(harness), shadow.querySelector(".close"));
});

test("a11y: group heads and the source drawer say whether they are open, and what they open", () => {
  const harness = rendered();
  openedFrom(harness);
  harness.ui.addSource(SUMMARY, STANDARD_HITS());
  const shadow = harness.shadow();

  const head = groupHead(shadow, "UI Actions");
  assert.strictEqual(head.getAttribute("aria-expanded"), "true");
  const listId = head.getAttribute("aria-controls");
  assert.ok(listId);
  const list = byId(shadow, listId);
  assert.ok(list, "the head's aria-controls names an element in the panel");
  assert.strictEqual(list.querySelectorAll(".rec").length, 2, "and it is the group's list");
  assert.strictEqual(head.querySelector(".caret").getAttribute("aria-hidden"), "true");

  head.fire("click");
  const closedHead = groupHead(shadow, "UI Actions");
  assert.strictEqual(closedHead.getAttribute("aria-controls"), listId, "the same id across rebuilds");
  const closedList = byId(shadow, listId);
  assert.ok(closedList, "a collapsed group still has the element its head names");
  assert.strictEqual(closedList.hidden, true);
  assert.strictEqual(closedList.children.length, 0);

  const drawer = shadow.querySelector(".drawer-head");
  assert.strictEqual(drawer.getAttribute("aria-expanded"), "false");
  const drawerList = byId(shadow, drawer.getAttribute("aria-controls"));
  assert.ok(drawerList && drawerList.className.includes("drawer-list"));
  drawer.fire("click");
  assert.strictEqual(drawer.getAttribute("aria-expanded"), "true");
  drawer.fire("click");
  assert.strictEqual(drawer.getAttribute("aria-expanded"), "false");
});

test("a11y: the status line says the search started, then the final count once", () => {
  const harness = rendered();
  openedFrom(harness);
  const shadow = harness.shadow();
  const live = shadow.querySelector("[data-live]");
  assert.strictEqual(live.getAttribute("role"), "status");
  assert.strictEqual(live.className, "sr-only");
  assert.strictEqual(shadow.querySelector(".spinner").getAttribute("aria-hidden"), "true");
  assert.strictEqual(liveText(shadow), "Searching…");

  harness.ui.addSource(SUMMARY, STANDARD_HITS());
  harness.ui.addSource(Object.assign({}, SUMMARY, { id: "ui-action-2" }), []);
  assert.strictEqual(liveText(shadow), "Searching…", "a source reporting is not announced");

  harness.ui.complete({ truncated: false });
  assert.strictEqual(liveText(shadow), "3 matches in 2 records, 2 sources reported.");
  harness.ui.complete({ truncated: true });
  assert.strictEqual(liveText(shadow), "3 matches in 2 records, 2 sources reported.", "said once");
});

test("a11y: a cancelled search says its count once; an error says what went wrong", () => {
  const cancelled = rendered();
  openedFrom(cancelled);
  cancelled.ui.addSource(SUMMARY, STANDARD_HITS().slice(0, 1));
  cancelled.shadow().querySelector("[data-action='cancel']").fire("click");
  assert.strictEqual(liveText(cancelled.shadow()), "1 match in 1 record, 1 source reported.");
  cancelled.ui.complete({ truncated: false });
  assert.strictEqual(liveText(cancelled.shadow()), "1 match in 1 record, 1 source reported.");

  const failed = rendered();
  openedFrom(failed);
  failed.ui.showError("The search could not run.");
  assert.strictEqual(liveText(failed.shadow()),
    "The search could not run. 0 matches in 0 records, 0 sources reported.");

  const capped = rendered();
  openedFrom(capped);
  capped.ui.addSource(SUMMARY, STANDARD_HITS());
  capped.ui.complete({ truncated: true });
  assert.strictEqual(liveText(capped.shadow()),
    "3 matches in 2 records, 1 source reported. Capped — refine the term to see the rest.");
});

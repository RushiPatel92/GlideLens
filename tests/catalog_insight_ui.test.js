/*
 * Tests for catalog_insight_ui.js, the Catalog Logic panel.
 *
 *   node --test tests/catalog_insight_ui.test.js
 *
 * DEV-ONLY. There is no browser here: the panel runs under node:vm against a
 * small DOM shim in the style of tests/record_search_ui.test.js, copied rather
 * than shared as the panels' own helpers are. The panel builds its static shell
 * with innerHTML and finds its controls with querySelector, so the shim has a
 * minimal parser for that template and a selector matcher that throws on
 * anything it does not understand, so a test cannot pass because a selector
 * silently matched nothing.
 *
 * All names and ids are synthetic.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const UI_SOURCE = fs.readFileSync(path.join(__dirname, "..", "catalog_insight_ui.js"), "utf8");
const HOST_ID = "snh-catalog-insight-results";
const ORIGIN = "https://example.service-now.com";

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
  if (selector.includes(",")) return selector.split(",").some((part) => matchesSelector(node, part));
  if (/[>+~#:]/.test(selector)) {
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
      this.style = {};
      this.disabled = false;
      this._text = "";
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
    /* As Chrome does: a node that is not in a shadow root on the page is not
     * focused; one that is becomes its root's activeElement, and the page's
     * activeElement is the root's host. */
    focus() {
      let root = this;
      while (root.parentNode) root = root.parentNode;
      if (!root.host || !root.host.parentNode) return;
      root.activeElement = this;
      document.activeElement = root.host;
    }
    /* Not displayed: hidden, or display:none set inline, on it or above it. */
    checkVisibility() {
      for (let node = this; node; node = node.parentNode) {
        if (node.hidden || (node.attributes && "hidden" in node.attributes)) return false;
        if (node.style && node.style.display === "none") return false;
      }
      return true;
    }
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

  /* Enough HTML for the panel's own template: elements, quoted attributes,
   * boolean attributes, void and self-closed elements, text, a raw <style>. */
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
  /* For a test that presses a key the panel listens for on the window. */
  windowObject.fire = (type, event) => {
    const payload = Object.assign({
      preventDefault() { payload.defaultPrevented = true; },
      stopPropagation() {},
    }, event || {});
    (windowHandlers[type] || []).slice().forEach((handler) => handler(payload));
    return payload;
  };
  const document = {
    createElement: (tag) => new El(tag),
    createTextNode: (value) => new TextNode(value),
    documentElement: new El("html"),
    body: new El("body"),
    execCommand: () => false,
  };
  return { document, window: windowObject };
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

function load() {
  const dom = createDom();
  const opened = [];
  const copied = [];
  const sandbox = {
    document: dom.document,
    window: dom.window,
    location: { origin: ORIGIN },
    navigator: { clipboard: { writeText: async (text) => { copied.push(text); } } },
    chrome: { runtime: { sendMessage: (message) => { opened.push(message); } } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(UI_SOURCE, sandbox, { filename: "catalog_insight_ui.js" });
  return {
    ui: sandbox.SNCatalogInsightUI,
    dom,
    opened,
    copied,
    shadow() {
      const host = dom.document.documentElement.children.find((node) => node.id === HOST_ID);
      return host ? host.shadowRoot : null;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const ID = (n) => String(n).padStart(32, "0");
const ALL_VIEWS = { catalog: true, task: true, ritm: true };

function row(overrides) {
  return Object.assign({
    kind: "client",
    id: ID(1),
    name: "Example script",
    subtype: "onLoad",
    variable: "",
    variableName: "",
    variableLabel: "",
    boundTo: "This item",
    active: true,
    views: ALL_VIEWS,
    order: 100,
    orderKnown: true,
    conditions: "",
  }, overrides);
}

/* Four rows: one that runs, one that won't run here, one inactive, and one
 * that is both inactive and off the catalog view. */
const ROWS = [
  row({ id: ID(1), name: "Runs everywhere", subtype: "onChange", variable: ID(9), variableName: "u_example_choice" }),
  row({ id: ID(2), kind: "uip", name: "Task-only policy", subtype: "on load · 2 vars",
    views: { catalog: false, task: true, ritm: true }, conditions: "u_example_choiceSTARTSWITHa^EQ",
    boundTo: "Variable set: Example set", orderKnown: false, order: 0 }),
  row({ id: ID(3), name: "Switched off", active: false }),
  row({ id: ID(4), kind: "uip", name: "Off and RITM only", subtype: "1 var", active: false,
    views: { catalog: false, task: false, ritm: true } }),
];

function openPanel(harness, rows) {
  harness.ui.showResults({ rows: rows || ROWS, itemSysId: ID(7), itemName: "Example item", setIds: [], setCount: 0 });
  return harness.shadow();
}

const q = (node, selector) => node.querySelector(selector);
const rowsOf = (shadow) => shadow.querySelectorAll(".rows .row");
const byName = (shadow, name) => rowsOf(shadow).find((node) => q(node, ".name").textContent === name);
const badgeOf = (node) => {
  const badge = q(node, ".verdict .badge");
  return badge ? [badge.className, badge.textContent] : null;
};
const factsOf = (node) => node.querySelectorAll(".fact").map((fact) =>
  [q(fact, "dt").textContent, q(fact, "dd").textContent]);

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test("a badge appears only on a row something stops, and inactive wins over the view", () => {
  const shadow = openPanel(load());
  assert.strictEqual(badgeOf(byName(shadow, "Runs everywhere")), null, "nothing blocks it: no badge");
  assert.deepStrictEqual(badgeOf(byName(shadow, "Task-only policy")), ["badge warn", "Won't run here"]);
  assert.deepStrictEqual(badgeOf(byName(shadow, "Switched off")), ["badge off", "Inactive"]);
  assert.deepStrictEqual(badgeOf(byName(shadow, "Off and RITM only")), ["badge off", "Inactive"],
    "inactive and off the catalog view: inactive is the stronger answer");
  /* The amber edge belongs to a won't-run row, and an inactive row dims its
   * name only, never the whole row. */
  const classOf = (name) => byName(shadow, name).className;
  assert.deepStrictEqual(
    ["Runs everywhere", "Task-only policy", "Switched off", "Off and RITM only"].map(classOf),
    ["row", "row flagged", "row inactive", "row inactive"]);
  assert.doesNotMatch(UI_SOURCE, /opacity:\.55/);
  assert.match(UI_SOURCE, /\.row\.inactive \.name\{color:#9a9ab3/);
});

test("a badged row says why in a sentence that starts with the badge's words", () => {
  const shadow = openPanel(load());
  const reason = (name) => {
    const node = q(byName(shadow, name), ".reason");
    return node ? [q(node, ".v").className, node.textContent] : null;
  };
  assert.deepStrictEqual(reason("Task-only policy"),
    ["v warn", "Won't run here. It applies on Task and RITM only, not while ordering this item."]);
  assert.deepStrictEqual(reason("Switched off"), ["v off", "Inactive. This never runs."]);
  assert.strictEqual(reason("Runs everywhere"), null);
  /* The sentence carries the verdict for assistive technology; the badge is
   * for sight, so the verdict is not spoken twice. */
  shadow.querySelectorAll(".rows .badge").forEach((badge) =>
    assert.strictEqual(badge.getAttribute("aria-hidden"), "true"));
  assert.strictEqual(q(byName(shadow, "Task-only policy"), ".reason").getAttribute("aria-hidden"), null);
  const one = openPanel(load(), [row({ name: "RITM only", views: { catalog: false, task: false, ritm: true } })]);
  assert.strictEqual(q(one, ".reason").textContent,
    "Won't run here. It applies on RITM only, not while ordering this item.");
});

test("facts are labelled columns under one header: plain words, no pills", () => {
  const shadow = openPanel(load());
  const header = q(shadow, ".rows .cols");
  assert.strictEqual(header.getAttribute("aria-hidden"), "true",
    "for sight: each fact carries its own label for assistive technology");
  assert.deepStrictEqual(
    [header.children[0].textContent]
      .concat(q(header, ".vals").children.map((cell) => cell.textContent))
      .concat([header.children[2].textContent]),
    ["Name", "Type and trigger", "Applies on", "Order", "On this form"]
  );
  assert.deepStrictEqual(factsOf(byName(shadow, "Runs everywhere")), [
    ["Type and trigger", "Client scriptonChange · u_example_choice"],
    ["Applies on", "Catalog item, Task, RITM"],
    ["Order", "100"],
  ]);
  const policy = byName(shadow, "Task-only policy");
  assert.deepStrictEqual(factsOf(policy), [
    ["Type and trigger", "UI policyon load · 2 variables"],
    ["Applies on", "Task, RITM"],
    ["Order", "–not known"],
  ]);
  assert.strictEqual(q(policy, ".fact .sub").textContent, "on load · 2 variables", "the subtype is its own line");
  assert.strictEqual(q(byName(shadow, "Off and RITM only"), ".fact .sub").textContent, "1 variable");
  assert.strictEqual(q(policy, ".fact .none").getAttribute("aria-hidden"), "true");
  assert.strictEqual(shadow.querySelectorAll(".rows .tag").length, 0, "no look-alike pills");
  assert.strictEqual(shadow.querySelectorAll(".rows .badge").length, 3, "badges are verdicts only");
});

test("the name opens the record and the binding and raw condition sit under it", () => {
  const harness = load();
  const shadow = openPanel(harness);
  const policy = byName(shadow, "Task-only policy");
  const name = q(policy, ".name");
  assert.strictEqual(name.tagName, "BUTTON");
  assert.strictEqual(name.type, "button", "a native button: Enter and Space activate it");
  assert.strictEqual(q(policy, ".bound").textContent, "Variable set: Example set");
  const cond = q(policy, ".cond");
  assert.strictEqual(cond.textContent, "Ifu_example_choiceSTARTSWITHa^EQ");
  assert.strictEqual(q(cond, "code").textContent, "u_example_choiceSTARTSWITHa^EQ", "kept raw");
  assert.strictEqual(cond.title, "u_example_choiceSTARTSWITHa^EQ");

  /* The row is not a click target any more: a click on it, or on a fact,
   * opens nothing, so its text can be selected. */
  policy.fire("click");
  q(policy, ".fact dd").fire("click");
  assert.deepStrictEqual(harness.opened, []);

  name.fire("click");
  assert.deepStrictEqual(harness.opened.map((message) => [message.type, message.url]), [
    ["OPEN_URL", ORIGIN + "/catalog_ui_policy.do?sys_id=" + ID(2)],
  ]);
  q(byName(shadow, "Runs everywhere"), ".name").fire("click");
  assert.strictEqual(harness.opened[1].url, ORIGIN + "/catalog_script_client.do?sys_id=" + ID(1));
  assert.match(q(shadow, ".subtitle").textContent, /Open a record from its name\./);
  assert.doesNotMatch(q(shadow, ".subtitle").textContent, /Click a row/);
});

test("the summary's won't-run count is a toggle that filters, together with the other filters", () => {
  const shadow = openPanel(load(), ROWS.concat([
    row({ id: ID(5), name: "Script for RITM", views: { catalog: false, task: false, ritm: true } }),
  ]));
  const toggle = q(shadow, "[data-action='wont-run']");
  assert.strictEqual(toggle.tagName, "BUTTON");
  assert.strictEqual(toggle.getAttribute("aria-pressed"), "false");
  assert.strictEqual(toggle.textContent, "2won't run here");
  assert.strictEqual(rowsOf(shadow).length, 5);

  toggle.fire("click");
  assert.strictEqual(toggle.getAttribute("aria-pressed"), "true");
  assert.deepStrictEqual(rowsOf(shadow).map((node) => q(node, ".name").textContent),
    ["Task-only policy", "Script for RITM"]);

  /* With the type filter: only the won't-run UI policies. */
  shadow.querySelectorAll("[data-filter]").find((button) => button.dataset.filter === "uip").fire("click");
  assert.deepStrictEqual(rowsOf(shadow).map((node) => q(node, ".name").textContent), ["Task-only policy"]);

  /* With the search: nothing matches, and the panel says so. */
  const search = q(shadow, ".search");
  search.value = "nothing like this";
  search.fire("input");
  assert.strictEqual(rowsOf(shadow).length, 0);
  assert.strictEqual(q(shadow, ".rows .empty").textContent, "Nothing matches these filters.");

  search.value = "";
  search.fire("input");
  shadow.querySelectorAll("[data-filter]").find((button) => button.dataset.filter === "all").fire("click");
  toggle.fire("click");
  assert.strictEqual(toggle.getAttribute("aria-pressed"), "false");
  assert.strictEqual(rowsOf(shadow).length, 6 - 1);
});

test("with nothing that won't run here, the count is hidden", () => {
  const shadow = openPanel(load(), [row({})]);
  assert.strictEqual(q(shadow, "[data-action='wont-run']").style.display, "none");
});

test("the whole item opens grouped by variable, and the toggle turns it flat", () => {
  const shadow = openPanel(load());
  const toggle = q(shadow, "[data-toggle='group']");
  assert.strictEqual(toggle.getAttribute("aria-pressed"), "true");
  assert.ok(toggle.classList.contains("active"));
  /* The grouped view uses the same rows under the same header. */
  assert.strictEqual(shadow.querySelectorAll(".rows .cols").length, 1);
  assert.strictEqual(shadow.querySelectorAll(".group-rows .row").length, 4);
  assert.deepStrictEqual(shadow.querySelectorAll(".group-name").map((node) => node.textContent),
    ["Not variable-specific", "u_example_choice"], "form-level first, then the variables");
  assert.deepStrictEqual(badgeOf(byName(shadow, "Task-only policy")), ["badge warn", "Won't run here"]);

  toggle.fire("click");
  assert.strictEqual(toggle.getAttribute("aria-pressed"), "false");
  assert.ok(!toggle.classList.contains("active"));
  assert.strictEqual(shadow.querySelectorAll(".group-rows").length, 0);
  assert.strictEqual(rowsOf(shadow).length, 4);
  assert.strictEqual(shadow.querySelectorAll(".rows .cols").length, 1);
});

test("opened from a variable's icon it is flat, and Show all opens the whole item grouped", () => {
  const harness = load();
  harness.ui.showResults({
    rows: ROWS, itemSysId: ID(7), itemName: "Example item", setIds: [], setCount: 0,
    focusVariable: { sysId: ID(9), name: "u_example_choice", label: "Example choice" },
  });
  const shadow = harness.shadow();
  const toggle = q(shadow, "[data-toggle='group']");
  assert.strictEqual(toggle.getAttribute("aria-pressed"), "false");
  assert.strictEqual(shadow.querySelectorAll(".group-rows").length, 0);
  assert.deepStrictEqual(rowsOf(shadow).map((node) => q(node, ".name").textContent), ["Runs everywhere"]);

  q(shadow, "[data-action='clear-focus']").fire("click");
  assert.strictEqual(toggle.getAttribute("aria-pressed"), "true");
  assert.ok(toggle.classList.contains("active"));
  assert.strictEqual(shadow.querySelectorAll(".group-rows .row").length, 4);

  /* A fresh open of the whole item is grouped again, whatever the last one was. */
  q(shadow, "[data-toggle='group']").fire("click");
  const again = openPanel(harness);
  assert.strictEqual(q(again, "[data-toggle='group']").getAttribute("aria-pressed"), "true");
});

/* Two policies: one changes two variables, one changes none. */
const POLICY_ROWS = [
  row({ id: ID(11), name: "Watch the owner", subtype: "onChange", variable: ID(21), variableName: "u_owner",
    variableLabel: "Owner" }),
  row({ id: ID(12), kind: "uip", name: "Hide VPN fields", subtype: "on load · 2 vars", actions: [
    { variable: ID(22), variableName: "u_vpn_server", variableLabel: "VPN server", effect: "hidden" },
    { variable: ID(21), variableName: "u_owner", variableLabel: "Owner", effect: "mandatory" },
    { variable: ID(21), variableName: "u_owner", variableLabel: "Owner", effect: "read-only" },
  ] }),
  row({ id: ID(13), kind: "uip", name: "Policy with no actions", subtype: "on load", actions: [] }),
  row({ id: ID(14), name: "Set defaults", subtype: "onLoad" }),
];

const groupsOf = (shadow) => shadow.querySelectorAll(".group").map((group) => [
  q(group, ".group-name").textContent,
  q(group, ".group-count").textContent,
  q(group, ".group-rows").querySelectorAll(".row").map((node) => {
    const effect = q(node, ".effect");
    return q(node, ".name").textContent + (effect ? " " + effect.textContent : "");
  }),
]);

test("a UI policy is grouped under each variable it changes, saying what it does there", () => {
  const shadow = openPanel(load(), POLICY_ROWS);
  assert.deepStrictEqual(groupsOf(shadow), [
    ["Not variable-specific", "2", ["Policy with no actions", "Set defaults"]],
    ["u_owner", "2", ["Watch the owner", "Hide VPN fields → mandatory · read-only"]],
    ["u_vpn_server", "1", ["Hide VPN fields → hidden"]],
  ]);
  assert.deepStrictEqual(shadow.querySelectorAll(".group-head .group-label").map((node) => node.textContent), [
    "onLoad and onSubmit scripts, and UI policies that change no variable", "Owner", "VPN server",
  ]);
  /* The summary counts each record once; only the groups repeat a policy. */
  assert.strictEqual(q(shadow, "[data-count='total']").textContent, "4");

  /* The flat list has each record once, and no effect line outside a group. */
  q(shadow, "[data-toggle='group']").fire("click");
  assert.deepStrictEqual(rowsOf(shadow).map((node) => q(node, ".name").textContent),
    ["Watch the owner", "Hide VPN fields", "Policy with no actions", "Set defaults"]);
  assert.strictEqual(shadow.querySelectorAll(".rows .effect").length, 0);
});

test("scoped to one variable, a policy is grouped under that variable only", () => {
  const harness = load();
  harness.ui.showResults({
    rows: POLICY_ROWS, itemSysId: ID(7), itemName: "Example item", setIds: [], setCount: 0,
    focusVariable: { sysId: ID(22), name: "u_vpn_server", label: "VPN server" },
  });
  const shadow = harness.shadow();
  assert.deepStrictEqual(rowsOf(shadow).map((node) => q(node, ".effect").textContent),
    ["→ hidden"], "flat, with its effect on the scoped variable");
  q(shadow, "[data-toggle='group']").fire("click");
  assert.deepStrictEqual(groupsOf(shadow), [["u_vpn_server", "1", ["Hide VPN fields → hidden"]]]);
});

test("a group head is a button that opens and closes its rows in place", () => {
  const shadow = openPanel(load(), POLICY_ROWS);
  const group = shadow.querySelectorAll(".group")[1];
  const head = q(group, ".group-head");
  const body = q(group, ".group-rows");
  assert.strictEqual(head.tagName, "BUTTON");
  assert.strictEqual(head.type, "button", "a native button: Enter and Space work, and it takes focus");
  assert.strictEqual(head.getAttribute("aria-expanded"), "true");
  assert.ok(body.id, "the rows have an id");
  assert.strictEqual(head.getAttribute("aria-controls"), body.id);
  assert.strictEqual(q(head, ".group-caret").getAttribute("aria-hidden"), "true");
  assert.strictEqual(body.hidden, false);

  head.fire("click");
  assert.strictEqual(head.getAttribute("aria-expanded"), "false");
  assert.strictEqual(body.hidden, true, "closed rows stay drawn, hidden, so aria-controls has a target");
  assert.strictEqual(shadow.querySelectorAll(".group-head")[1], head,
    "nothing is redrawn, so focus stays on the head");

  /* The whole head does one thing: the label has no click of its own and
   * wraps instead of truncating. */
  const label = q(head, ".group-label");
  assert.strictEqual((label.handlers.click || []).length, 0);
  assert.strictEqual(label.title, "");
  assert.doesNotMatch(UI_SOURCE, /click to expand/);
  assert.doesNotMatch(UI_SOURCE, /\.group-label\{[^}]*(ellipsis|nowrap)/);

  /* A filter or a search redraws the list; the closed group stays closed. */
  shadow.querySelectorAll("[data-filter]").find((button) => button.dataset.filter === "all").fire("click");
  let redrawn = shadow.querySelectorAll(".group")[1];
  assert.strictEqual(q(redrawn, ".group-head").getAttribute("aria-expanded"), "false");
  assert.strictEqual(q(redrawn, ".group-rows").hidden, true);
  const search = q(shadow, ".search");
  search.value = "owner";
  search.fire("input");
  redrawn = shadow.querySelectorAll(".group").find((node) => q(node, ".group-name").textContent === "u_owner");
  assert.strictEqual(q(redrawn, ".group-head").getAttribute("aria-expanded"), "false");
  assert.strictEqual(q(redrawn, ".group-rows").hidden, true);
  search.value = "";
  search.fire("input");
  redrawn = shadow.querySelectorAll(".group")[1];

  q(redrawn, ".group-head").fire("click");
  assert.strictEqual(q(redrawn, ".group-head").getAttribute("aria-expanded"), "true");
  assert.strictEqual(q(redrawn, ".group-rows").hidden, false);
  /* Every head's controlled rows have their own id. */
  const ids = shadow.querySelectorAll(".group-rows").map((node) => node.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test("a group's count is spoken as what it counts, not a bare number", () => {
  const shadow = openPanel(load(), POLICY_ROWS);
  shadow.querySelectorAll(".group-count").forEach((count) =>
    assert.strictEqual(count.getAttribute("aria-hidden"), "true"));
  assert.deepStrictEqual(shadow.querySelectorAll(".group-head .sr-only").map((node) => node.textContent), [
    ", 1 client script, 1 UI policy",
    ", 1 client script, 1 UI policy",
    ", 1 UI policy",
  ]);
  const many = openPanel(load(), [
    row({ id: ID(31), name: "One", subtype: "onLoad" }),
    row({ id: ID(32), name: "Two", subtype: "onSubmit" }),
  ]);
  assert.strictEqual(q(many, ".group-head .sr-only").textContent, ", 2 client scripts");
});

test("a variable whose name never came back says so, with its sys_id dimmer, after the named ones", () => {
  const shadow = openPanel(load(), [
    row({ id: ID(41), name: "Watches a lost variable", subtype: "onChange", variable: ID(51) }),
    row({ id: ID(42), kind: "uip", name: "Policy on an unnamed question", subtype: "1 var", actions: [
      { variable: ID(52), variableName: "", variableLabel: "Cost centre", effect: "mandatory" },
    ] }),
    row({ id: ID(43), name: "Watches a named one", subtype: "onChange", variable: ID(53), variableName: "u_zone" }),
  ]);
  const heads = shadow.querySelectorAll(".group").map((group) => [
    q(group, ".group-name").className,
    q(group, ".group-name").textContent,
    q(group, ".group-id") ? q(group, ".group-id").textContent : "",
  ]);
  assert.deepStrictEqual(heads, [
    ["group-name", "u_zone", ""],
    ["group-name unresolved", "Cost centre", ID(52)],
    ["group-name unresolved", "Variable name not available", ID(51)],
  ]);
  /* The label stands in for the name, so it is not repeated beside it. */
  assert.strictEqual(shadow.querySelectorAll(".group-label").length, 0);
  /* A label names the group aloud, so its sys_id is not read out; with no
     label the sys_id is the only thing telling the groups apart. */
  const ids = shadow.querySelectorAll(".group-id");
  assert.strictEqual(ids[0].getAttribute("aria-hidden"), "true");
  assert.strictEqual(ids[1].getAttribute("aria-hidden"), null);
});

test("a policy is filed only under the variables its actions name", () => {
  const shadow = openPanel(load(), [
    row({ id: ID(61), kind: "uip", name: "Half-targeted policy", subtype: "2 vars", actions: [
      { variable: ID(62), variableName: "u_region", variableLabel: "Region", effect: "hides" },
      { variable: "", variableName: "", variableLabel: "", effect: "mandatory" },
    ] }),
  ]);
  assert.deepStrictEqual(groupsOf(shadow), [["u_region", "1", ["Half-targeted policy → hides"]]]);
});

test("a search for one variable finds a policy under that variable, not under the others it changes", async () => {
  const harness = load();
  const shadow = openPanel(harness, POLICY_ROWS);
  const search = q(shadow, ".search");
  const find = (text) => { search.value = text; search.fire("input"); };

  /* By name: the policy changes u_owner too, but is not shown there. */
  find("u_vpn_server");
  assert.deepStrictEqual(groupsOf(shadow), [["u_vpn_server", "1", ["Hide VPN fields → hidden"]]]);
  /* By the question's label, the same. */
  find("vpn server");
  assert.deepStrictEqual(groupsOf(shadow), [["u_vpn_server", "1", ["Hide VPN fields → hidden"]]]);
  /* A variable that a script watches and a policy changes: both, there only. */
  find("owner");
  assert.deepStrictEqual(groupsOf(shadow), [
    ["u_owner", "2", ["Watch the owner", "Hide VPN fields → mandatory · read-only"]],
  ]);
  /* The policy's own words find it everywhere it is filed. */
  find("hide vpn");
  assert.deepStrictEqual(groupsOf(shadow), [
    ["u_owner", "1", ["Hide VPN fields → mandatory · read-only"]],
    ["u_vpn_server", "1", ["Hide VPN fields → hidden"]],
  ]);

  /* Flat, a search for a variable finds the policy that changes it, once. */
  q(shadow, "[data-toggle='group']").fire("click");
  find("u_vpn_server");
  assert.deepStrictEqual(rowsOf(shadow).map((node) => q(node, ".name").textContent), ["Hide VPN fields"]);
  q(shadow, "[data-action='copy']").fire("click");
  await tick();
  assert.match(harness.copied[0], /^Rows: 1 of 4$/m, "the copy is what the search found");
});

test("a nameless variable is found by the sys_id its head shows, a named one by name only", () => {
  const shadow = openPanel(load(), [
    row({ id: ID(71), name: "Watches a lost variable", subtype: "onChange", variable: ID(81) }),
    row({ id: ID(72), name: "Watches a named one", subtype: "onChange", variable: ID(82), variableName: "u_zone" }),
  ]);
  const search = q(shadow, ".search");
  search.value = ID(81);
  search.fire("input");
  assert.deepStrictEqual(shadow.querySelectorAll(".group-id").map((node) => node.textContent), [ID(81)]);
  search.value = ID(82);
  search.fire("input");
  assert.strictEqual(q(shadow, ".rows .empty").textContent, "Nothing matches these filters.");
});

test("every way out gives focus back to what had it when the panel opened", () => {
  const harness = load();
  const focused = [];
  const opener = {
    focus(options) {
      focused.push(options);
      harness.dom.document.activeElement = opener;
    },
  };
  const openFrom = (node) => {
    harness.dom.document.activeElement = node;
    const shadow = openPanel(harness);
    /* A mouse click on a button gives that button focus first. */
    harness.dom.document.activeElement = null;
    return shadow;
  };

  q(openFrom(opener), ".header .close").fire("click");
  q(openFrom(opener), "[data-action='close']").fire("click");
  harness.dom.window.fire("keydown", { key: "Escape" });
  assert.strictEqual(harness.shadow(), null, "Escape with nothing open does nothing");
  openFrom(opener);
  harness.dom.window.fire("keydown", { key: "Escape" });
  const overlay = q(openFrom(opener), ".overlay");
  overlay.fire("click", { target: overlay });
  assert.deepStrictEqual(focused.map((options) => options && options.preventScroll), [true, true, true, true],
    "header Close, footer Close, Escape and a click outside; the page does not scroll to it");
  assert.strictEqual(harness.shadow(), null);

  /* Opened again over itself, it keeps the first opener, not its own button. */
  openFrom(opener);
  openPanel(harness);
  q(harness.shadow(), ".header .close").fire("click");
  assert.strictEqual(focused.length, 6, "back to the opener, then back to it again on close");

  /* An opener that has gone, or never could take focus, is passed over. */
  q(openFrom({ focus() { throw new Error("detached"); } }), ".header .close").fire("click");
  q(openFrom(harness.dom.document.body), ".header .close").fire("click");
  assert.strictEqual(harness.shadow(), null);
});

/* The panel's controls in Tab order, as names a test can read. */
const controlName = (node) => node.dataset.filter || node.dataset.toggle || node.dataset.action ||
  (node.className === "close" ? "header-close" : "") ||
  (node.className === "search" ? "search" : "") ||
  (node.className === "group-head" ? "head:" + node.querySelector(".group-name").textContent : "") ||
  node.textContent;

function tabCycle(harness, shiftKey) {
  const shadow = harness.shadow();
  const seen = [];
  const start = shadow.activeElement;
  do {
    const event = harness.dom.window.fire("keydown", { key: "Tab", shiftKey: Boolean(shiftKey) });
    assert.strictEqual(event.defaultPrevented, true, "the browser never moves focus itself");
    seen.push(controlName(shadow.activeElement));
  } while (shadow.activeElement !== start && seen.length < 60);
  return seen;
}

test("it takes focus as it opens, and Tab goes round its own controls only", () => {
  const harness = load();
  const shadow = openPanel(harness, POLICY_ROWS);
  assert.strictEqual(shadow.activeElement, q(shadow, ".header .close"), "Close has focus");
  assert.strictEqual(harness.dom.document.activeElement.id, HOST_ID);

  /* Round from Close and back to it, in page order. The won't-run count is
   * hidden at zero and Scripts in platform is live, so one is skipped and
   * the other is not. */
  const forward = tabCycle(harness);
  assert.deepStrictEqual(forward, [
    "all", "client", "uip", "active", "group", "search",
    "head:Not variable-specific", "Policy with no actions", "Set defaults",
    "head:u_owner", "Watch the owner", "Hide VPN fields",
    "head:u_vpn_server", "Hide VPN fields",
    "open-scripts", "open-policies", "close", "copy", "header-close",
  ]);
  assert.deepStrictEqual(tabCycle(harness, true), forward.slice(0, -1).reverse().concat(["header-close"]),
    "Shift+Tab is the same round backwards");

  /* A closed group's rows are not displayed, so Tab passes over them. */
  shadow.querySelectorAll(".group-head")[1].fire("click");
  assert.ok(!tabCycle(harness).includes("Watch the owner"));
});

test("Tab passes over a disabled button and a summary count that is hidden", () => {
  const harness = load();
  openPanel(harness, [row({ id: ID(91), kind: "uip", name: "Only a policy", subtype: "on load", actions: [],
    views: { catalog: false, task: true, ritm: false } })]);
  const cycle = tabCycle(harness);
  assert.ok(cycle.includes("wont-run"), "a won't-run count above zero is a control");
  assert.ok(!cycle.includes("open-scripts"), "no client scripts, so Scripts in platform is disabled");

  const other = load();
  openPanel(other, [row({})]);
  assert.ok(!tabCycle(other).includes("wont-run"), "hidden at zero");
});

test("Show all takes its own button away, so focus moves to the grouping it just turned on", () => {
  const harness = load();
  harness.ui.showResults({
    rows: POLICY_ROWS, itemSysId: ID(7), itemName: "Example item", setIds: [], setCount: 0,
    focusVariable: { sysId: ID(22), name: "u_vpn_server", label: "VPN server" },
  });
  const shadow = harness.shadow();
  const showAll = q(shadow, "[data-action='clear-focus']");
  /* ↗ marks a button that opens a platform list; this one only widens the panel. */
  assert.strictEqual(showAll.textContent, "Show all");
  showAll.focus();
  showAll.fire("click");
  assert.strictEqual(q(shadow, ".focus-banner"), null);
  assert.strictEqual(shadow.activeElement, q(shadow, "[data-toggle='group']"));
  assert.strictEqual(shadow.activeElement.getAttribute("aria-pressed"), "true");
});

test("from the palette, the palette closes before the panel opens, so it cannot take focus back", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const start = source.indexOf("async function showCatalogInsight()");
  const length = source.slice(start).search(/\r?\n\}\r?\n/);
  assert.ok(start >= 0 && length > 0, "the function is found, whatever the line endings");
  const body = source.slice(start, start + length);
  const closes = body.indexOf("closePalette();");
  assert.ok(closes > 0, "the palette is closed on the way");
  assert.ok(closes < body.indexOf("SNCatalogInsightUI.showResults("),
    "closePalette() hands focus back to the page, so it goes first");
});

test("the sticky header and group heads sit flush with the list's top edge, past its padding", () => {
  /* .rows has 6px of top padding; top:0 stops a sticky child under it, and a
   * scrolled row shows through the 6px band. */
  assert.match(UI_SOURCE, /\.rows\{flex:1;overflow:auto;padding:6px 0\}/);
  assert.match(UI_SOURCE, /\.cols\{position:sticky;top:-6px;[^}]*height:30px;/);
  assert.match(UI_SOURCE, /\.group-head\{top:24px\}/, "right below the 30px header");
  assert.match(UI_SOURCE, /@container rows \(max-width:759px\)\{\s*\.cols\{display:none\}\s*\.group-head\{top:-6px\}/,
    "narrow, with no header, the heads take its place");
  assert.doesNotMatch(UI_SOURCE, /position:sticky;top:0\b/);
});

test("the copied list words each verdict as the badge and its sentence do", async () => {
  const harness = load();
  const shadow = openPanel(harness);
  q(shadow, "[data-action='copy']").fire("click");
  await tick();
  assert.strictEqual(harness.copied.length, 1);
  const lines = harness.copied[0].split("\n");
  assert.ok(lines.includes(
    "UI policy — on load · 2 variables — Task-only policy — Variable set: Example set — applies on Task, RITM" +
      " — Won't run here. It applies on Task and RITM only, not while ordering this item." +
      " — If u_example_choiceSTARTSWITHa^EQ"
  ), lines.join("\n"));
  assert.ok(lines.includes(
    "Client script — onChange · u_example_choice — Runs everywhere — This item — applies on Catalog item, Task, RITM — Active"
  ));
  assert.ok(lines.includes(
    "Client script — onLoad — Switched off — This item — applies on Catalog item, Task, RITM — Inactive. This never runs."
  ));
  assert.doesNotMatch(harness.copied[0], /won't run on catalog form|Not on catalog form/);
});

test("the narrow layout restyles the same nodes, below 760px of list width", () => {
  /* One copy of each fact: the dl is both the wide columns and the narrow
   * labelled list, so assistive technology never meets two. */
  const shadow = openPanel(load());
  rowsOf(shadow).forEach((node) => {
    assert.strictEqual(node.querySelectorAll(".facts").length, 1);
    assert.strictEqual(q(node, ".facts").tagName, "DL");
  });
  assert.match(UI_SOURCE, /\.rows\{container:rows \/ inline-size\}/);
  assert.match(UI_SOURCE, /@container rows \(max-width:759px\)\{\s*\.cols\{display:none\}/);
  assert.match(UI_SOURCE, /grid-template-columns:max-content minmax\(0,1fr\)/);
});

test("the type filters say which one is chosen with aria-pressed, not by colour alone", () => {
  const shadow = openPanel(load());
  const filters = shadow.querySelectorAll("[data-filter]");
  const pressed = () => filters.map((button) => [button.dataset.filter, button.getAttribute("aria-pressed")]);
  assert.deepStrictEqual(pressed(), [["all", "true"], ["client", "false"], ["uip", "false"]]);

  filters.find((button) => button.dataset.filter === "client").fire("click");
  assert.deepStrictEqual(pressed(), [["all", "false"], ["client", "true"], ["uip", "false"]]);
  filters.find((button) => button.dataset.filter === "uip").fire("click");
  assert.deepStrictEqual(pressed(), [["all", "false"], ["client", "false"], ["uip", "true"]]);
  filters.find((button) => button.dataset.filter === "all").fire("click");
  assert.deepStrictEqual(pressed(), [["all", "true"], ["client", "false"], ["uip", "false"]]);
  filters.forEach((button) =>
    assert.strictEqual(button.className.includes("active"), button.getAttribute("aria-pressed") === "true"));
});

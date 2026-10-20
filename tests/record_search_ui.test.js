/*
 * Tests for record_search_ui.js, the Record Lens panel.
 *
 *   node --test tests/record_search_ui.test.js
 *
 * DEV-ONLY. There is no browser here: the panel runs under node:vm against a
 * small DOM shim in the style of tests/impersonate_ui.test.js. Unlike that
 * panel, this one builds its static shell with innerHTML and finds its
 * controls with querySelector, so the shim adds a minimal parser for that
 * template and a selector matcher for the selectors the panel uses. Both throw
 * on anything they do not understand, so a test cannot pass because a
 * selector silently matched nothing.
 *
 * Instance values never go through that parser: the panel assigns them with
 * textContent, and the hostile-label test below would find a parsed element
 * if one ever did.
 *
 * All table and field names are synthetic.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const UI_SOURCE = fs.readFileSync(path.join(root, "record_search_ui.js"), "utf8");
const ENGINE_SOURCE = fs.readFileSync(path.join(root, "record_search.js"), "utf8");
const HOST_ID = "sn-dev-helper-record-search";

/* ------------------------------------------------------------------ *
 * The DOM shim
 * ------------------------------------------------------------------ */

const VOID_TAGS = new Set(["INPUT", "BR", "IMG", "META", "LINK", "HR"]);

function camel(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseCompound(text) {
  const out = { tag: "", id: "", classes: [], attrs: [] };
  const pattern =
    /([a-zA-Z][a-zA-Z0-9-]*)|\.([A-Za-z0-9_-]+)|#([A-Za-z0-9_-]+)|\[([a-zA-Z0-9_-]+)(?:=(?:'([^']*)'|"([^"]*)"))?\]/y;
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
    } else if (match[3]) {
      out.id = match[3];
    } else {
      const value = match[5] !== undefined ? match[5] : match[6];
      out.attrs.push([match[4], value]);
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
  if (compound.id && node.id !== compound.id) return false;
  const classes = String(node.className || "").split(/\s+/);
  if (compound.classes.some((name) => !classes.includes(name))) return false;
  return compound.attrs.every(([name, value]) => {
    const actual = attributeValue(node, name);
    return value === undefined ? actual !== null : actual === value;
  });
}

function matchesSelector(node, selector) {
  if (selector.includes(",") || /[>+~]/.test(selector)) {
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
  let activeElement = null;

  /* As in a browser, detaching the focused node, or anything around it,
   * drops focus to nowhere. */
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
      this.checked = false;
      this.tabIndex = -1;
      this.shadowRoot = null;
      this.style = {};
      this.focused = 0;
      this._hidden = false;
      this._disabled = false;
      this._text = "";
    }
    /* As in a browser, disabling or hiding the focused control drops focus,
     * so a test can tell a panel that moves focus from one that loses it. */
    get disabled() { return this._disabled; }
    set disabled(value) {
      this._disabled = Boolean(value);
      if (this._disabled && activeElement === this) activeElement = null;
    }
    get childNodes() { return this.children; }
    /* Connected once it reaches the document, through a shadow root's host. */
    get isConnected() {
      for (let node = this; node; node = node.parentNode || node.host || null) {
        if (node === document.documentElement) return true;
      }
      return false;
    }
    get hidden() { return this._hidden; }
    set hidden(value) {
      this._hidden = Boolean(value);
      if (this._hidden && activeElement === this) activeElement = null;
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
    /* STYLE is left out: the stylesheet would make every text match
     * meaningless. */
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
      if (!node) return node;
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
      return node;
    }
    get firstChild() { return this.children[0] || null; }
    insertBefore(node, reference) {
      if (!reference) return this.appendChild(node);
      if (node.parentNode) node.parentNode.removeChild(node);
      const index = this.children.indexOf(reference);
      if (index < 0) throw new Error("insertBefore: the reference is not a child");
      node.parentNode = this;
      this.children.splice(index, 0, node);
      return node;
    }
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
      dropFocusWithin(node);
      node.parentNode = null;
      return node;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
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
    focus() {
      /* Focusing a detached node does nothing in Chrome. */
      if (!this.isConnected) return;
      this.focused += 1;
      activeElement = this;
      (this.handlers.focus || []).slice().forEach((handler) => handler({ target: this }));
    }
    scrollIntoView() {}
    select() {}
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        (node.children || []).forEach((child) => {
          if (matchesSelector(child, selector)) out.push(child);
          visit(child);
        });
      };
      visit(this);
      return out;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    closest(selector) {
      let node = this;
      while (node && node.attributes) {
        if (matchesSelector(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    }
    fire(type, event) {
      const handlers = this.handlers[type] || [];
      const payload = Object.assign({
        target: this,
        preventDefault() { payload.defaultPrevented = true; },
        stopPropagation() { payload.propagationStopped = true; },
      }, event || {});
      handlers.slice().forEach((handler) => handler(payload));
      return payload;
    }
  }

  /* Enough HTML for the panel's own static template: elements, quoted
   * attributes, boolean attributes, void elements, text, and a raw <style>. */
  function parseInto(parent, markup) {
    const token =
      /<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:\s*=\s*"[^"]*")?)*)\s*>|([^<]+)/y;
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
        const closing = match[1].toUpperCase();
        if (current.tagName !== closing) throw new Error("mismatched </" + match[1] + ">");
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
          else if (name === "hidden") node.hidden = true;
          else if (name === "disabled") node.disabled = true;
          else {
            if (name === "type") node.type = value;
            if (name.startsWith("data-")) node.dataset[camel(name.slice(5))] = value;
            node.attributes[name] = value;
          }
        }
        current.appendChild(node);
        if (node.tagName === "STYLE") {
          const end = markup.indexOf("</style>", index);
          if (end < 0) throw new Error("unterminated <style>");
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
  const document = {
    createElement: (tag) => new El(tag),
    createTextNode: (value) => new TextNode(value),
    documentElement: new El("html"),
    body: new El("body"),
    get activeElement() { return activeElement; },
    /* There is no clipboard here, so the panel's fallback copy fails, as a
     * blocked one does in a browser. */
    execCommand: () => false,
  };
  const windowObject = {
    addEventListener(type, handler) {
      (windowHandlers[type] = windowHandlers[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      const list = windowHandlers[type] || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    fire(type, event) {
      const payload = Object.assign({
        preventDefault() { payload.defaultPrevented = true; },
        stopPropagation() { payload.propagationStopped = true; },
      }, event || {});
      (windowHandlers[type] || []).slice().forEach((handler) => handler(payload));
      return payload;
    },
  };
  return { El, document, window: windowObject };
}

function findAll(node, predicate) {
  const out = [];
  const visit = (current) => (current.children || []).forEach((child) => {
    if (predicate(child)) out.push(child);
    visit(child);
  });
  visit(node);
  return out;
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

function load() {
  const dom = createDom();
  const timers = [];
  const sandbox = {
    document: dom.document,
    window: dom.window,
    location: { origin: "https://example.service-now.com" },
    navigator: {},
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cancelled: false, done: false });
      return timers.length;
    },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    Promise,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ENGINE_SOURCE, sandbox, { filename: "record_search.js" });
  vm.runInContext(UI_SOURCE, sandbox, { filename: "record_search_ui.js" });
  return {
    ui: sandbox.SNRecordSearchUI,
    dom,
    navigator: sandbox.navigator,
    runTimers() {
      timers.forEach((timer) => {
        if (!timer.cancelled && !timer.done) {
          timer.done = true;
          timer.fn();
        }
      });
    },
    shadow() {
      const host = dom.document.documentElement.children.find((node) => node.id === HOST_ID);
      return host ? host.shadowRoot : null;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let index = 0; index < 5; index += 1) await tick(); };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const EMPTY_REMEMBERED = { requested: [], verified: [], absent: [], unverifiable: [] };

function tableInfo(name, options) {
  const opts = options || {};
  const fields = (opts.fields || ["number", "short_description"]).map((field) => ({
    name: field, label: "Label " + field, type: "string", display: false, autoSelectable: true,
  }));
  return {
    table: name,
    label: opts.label || "Example " + name,
    hierarchy: [name],
    fields,
    defaultFields: fields.slice(0, 1),
    remembered: opts.remembered || EMPTY_REMEMBERED,
  };
}

/* A stand-in for the worker: applies each operation and answers with the
 * resulting list, as the real one does. */
function favoriteWorker(initial) {
  let tables = JSON.parse(JSON.stringify(initial || []));
  const calls = [];
  const op = async (request) => {
    calls.push(JSON.parse(JSON.stringify(request)));
    if (request.op === "star" && !tables.some((item) => item.name === request.name)) {
      tables.push({ name: request.name, label: request.label, fields: request.fields });
    } else if (request.op === "unstar") {
      tables = tables.filter((item) => item.name !== request.name);
    } else if (request.op === "fields") {
      tables = tables.map((item) => item.name === request.name
        ? Object.assign({}, item, { fields: request.fields }) : item);
    }
    return { ok: true, tables: JSON.parse(JSON.stringify(tables)), evicted: 0 };
  };
  return { op, calls };
}

const FAVORITES = [
  { name: "u_example_table", label: "Example table", fields: ["u_code"] },
  { name: "incident", label: "Incident", fields: [] },
];

function openPanel(harness, options) {
  const opts = options || {};
  harness.ui.open(Object.assign({
    onFindTables: async () => [],
    onResolveTable: async (name) => tableInfo(name),
    onSearch: async () => ({ stale: false, table: "incident", results: [] }),
    onFavoriteOp: favoriteWorker(opts.favorites).op,
  }, opts));
  return harness.shadow();
}

const q = (shadow, selector) => shadow.querySelector(selector);
const menu = (shadow) => q(shadow, ".table-menu");
const tableInput = (shadow) => q(shadow, "[data-input='table']");
const options = (shadow) => shadow.querySelectorAll(".table-option");
const status = (shadow) => q(shadow, ".status").textContent;
const starButton = (shadow) => q(shadow, ".star-btn");
const key = (node, name) => node.fire("keydown", { key: name });

async function type(harness, shadow, value) {
  const input = tableInput(shadow);
  input.value = value;
  input.fire("input");
  harness.runTimers();
  await tick();
}

function toggleField(shadow, name) {
  const box = shadow.querySelectorAll(".field-option input")
    .find((input) => input.dataset.field === name);
  assert.ok(box, "no checkbox for " + name);
  box.checked = !box.checked;
  box.fire("change");
}

/* ------------------------------------------------------------------ *
 * Opening
 * ------------------------------------------------------------------ */

test("starred tables are real options as soon as the panel opens, and opening writes nothing", () => {
  const harness = load();
  const worker = favoriteWorker(FAVORITES);
  const shadow = openPanel(harness, { favorites: FAVORITES, onFavoriteOp: worker.op });
  assert.strictEqual(menu(shadow).hidden, false);
  const shown = options(shadow);
  assert.deepStrictEqual(shown.map((option) => option.id), [
    "snh-rs-table-option-0",
    "snh-rs-table-option-1",
  ]);
  shown.forEach((option) => assert.strictEqual(option.getAttribute("role"), "option"));
  assert.strictEqual(tableInput(shadow).getAttribute("aria-activedescendant"), "snh-rs-table-option-0");
  assert.match(status(shadow), /Your starred tables · type to find any other/);
  assert.deepStrictEqual(worker.calls, []);
});

test("a starred option is announced as starred and its glyph is hidden from assistive tech", () => {
  const harness = load();
  const shadow = openPanel(harness, { favorites: FAVORITES });
  const first = options(shadow)[0];
  assert.match(first.textContent, /Example table, starred/);
  const glyph = first.querySelector(".table-star");
  assert.strictEqual(glyph.getAttribute("aria-hidden"), "true");
  assert.strictEqual(first.querySelector(".sr-only").textContent, ", starred");
});

test("with no favourites the panel opens exactly as before", () => {
  const harness = load();
  const shadow = openPanel(harness);
  assert.strictEqual(menu(shadow).hidden, true);
  assert.strictEqual(status(shadow), "Search for a table to begin.");
  assert.strictEqual(starButton(shadow).hidden, true);
});

test("a table detected from the URL wins; the favourites show once the box is cleared", async () => {
  const harness = load();
  const shadow = openPanel(harness, { favorites: FAVORITES, initialTable: "change_request" });
  assert.strictEqual(menu(shadow).hidden, true);
  assert.match(status(shadow), /Detected change_request/);
  await settle();
  await type(harness, shadow, "");
  assert.strictEqual(menu(shadow).hidden, false);
  assert.deepStrictEqual(options(shadow).map((option) => option.textContent.includes("starred")), [true, true]);
});

test("if the starred tables could not be read, the panel says so", () => {
  const harness = load();
  const shadow = openPanel(harness, { favoritesUnavailable: true });
  assert.match(status(shadow), /Starred tables could not be read right now/);
});

test("the toolbar keeps its promise and names what is kept", () => {
  const harness = load();
  const note = q(openPanel(harness), ".toolbar-note").textContent;
  assert.match(note, /no record or search history is stored/);
  assert.match(note, /starred tables, with their fields and columns, are kept on this device/);
});

test("a hostile favourite label renders as text, never as markup", () => {
  const harness = load();
  const hostile = "<img src=x onerror=alert(1)>";
  const shadow = openPanel(harness, {
    favorites: [{ name: "u_example_table", label: hostile, fields: [] }],
  });
  assert.ok(options(shadow)[0].textContent.includes(hostile));
  assert.strictEqual(findAll(shadow, (node) => node.tagName === "IMG").length, 0);
});

/* ------------------------------------------------------------------ *
 * The combobox with favourites in it
 * ------------------------------------------------------------------ */

test("every way of opening the menu on an empty box shows the starred tables", async () => {
  const harness = load();
  const shadow = openPanel(harness, {
    favorites: FAVORITES,
    onFindTables: async () => [{ name: "u_zz_table", label: "Zz table" }],
  });
  const input = tableInput(shadow);

  key(input, "Escape");
  assert.strictEqual(menu(shadow).hidden, true);
  input.fire("focus");
  assert.strictEqual(menu(shadow).hidden, false, "the focus path");
  assert.strictEqual(options(shadow).length, 2);

  /* Leave a live list behind, then clear the box and press ArrowDown before
   * the debounced lookup runs: the leftover list must not come back. */
  await type(harness, shadow, "zz");
  assert.deepStrictEqual(options(shadow).map((option) => option.textContent.includes("u_zz_table")), [true]);
  key(input, "Escape");
  input.value = "";
  input.fire("input");
  key(input, "ArrowDown");
  assert.strictEqual(menu(shadow).hidden, false, "the ArrowDown path");
  assert.ok(options(shadow).every((option) => option.textContent.includes("starred")));

  /* The no-anchor branch of the lookup itself. */
  key(input, "Escape");
  harness.runTimers();
  assert.strictEqual(menu(shadow).hidden, false, "the lookup's empty-box branch");
  assert.ok(options(shadow).every((option) => option.textContent.includes("starred")));
});

test("while a lookup runs, matching favourites stay selectable and nothing else is", async () => {
  const harness = load();
  const pending = deferred();
  const resolved = [];
  const shadow = openPanel(harness, {
    favorites: FAVORITES,
    onFindTables: () => pending.promise,
    onResolveTable: async (name) => { resolved.push(name); return tableInfo(name); },
  });

  await type(harness, shadow, "inc");
  assert.strictEqual(options(shadow).length, 1);
  assert.match(menu(shadow).textContent, /Finding more tables…/);
  assert.strictEqual(tableInput(shadow).getAttribute("aria-activedescendant"), "snh-rs-table-option-0");
  key(tableInput(shadow), "Enter");
  await settle();
  assert.deepStrictEqual(resolved, ["incident"], "Enter takes the favourite on screen");
});

test("while a lookup runs with no favourite matching, Enter selects nothing", async () => {
  const harness = load();
  const resolved = [];
  const shadow = openPanel(harness, {
    favorites: FAVORITES,
    onFindTables: () => new Promise(() => {}),
    onResolveTable: async (name) => { resolved.push(name); return tableInfo(name); },
  });
  assert.strictEqual(options(shadow).length, 2, "favourites were on screen first");
  await type(harness, shadow, "zzz");
  assert.strictEqual(options(shadow).length, 0);
  assert.match(menu(shadow).textContent, /Finding matching tables…/);
  assert.strictEqual(tableInput(shadow).getAttribute("aria-activedescendant"), null);
  key(tableInput(shadow), "Enter");
  await settle();
  assert.deepStrictEqual(resolved, []);
});

test("live results arrive behind the favourites, each once, with the active option kept", async () => {
  const harness = load();
  const pending = deferred();
  const favorites = [
    { name: "u_example_one", label: "Example one", fields: [] },
    { name: "u_example_two", label: "Example two", fields: [] },
  ];
  const shadow = openPanel(harness, { favorites, onFindTables: () => pending.promise });
  await type(harness, shadow, "example");
  key(tableInput(shadow), "ArrowDown");
  assert.strictEqual(tableInput(shadow).getAttribute("aria-activedescendant"), "snh-rs-table-option-1");

  pending.resolve([
    { name: "u_example_two", label: "Example two" },
    { name: "u_example_archive", label: "Example archive" },
  ]);
  await settle();
  const names = options(shadow).map((option) => option.querySelector(".table-name").textContent);
  assert.deepStrictEqual(names, ["u_example_one", "u_example_two", "u_example_archive"]);
  assert.strictEqual(tableInput(shadow).getAttribute("aria-activedescendant"), "snh-rs-table-option-1");
  assert.match(status(shadow), /3 matching tables · 2 starred, listed first/);
});

test("an import set staging table is tagged in the menu and in the summary once chosen", async () => {
  const harness = load();
  const shadow = openPanel(harness, {
    onFindTables: async () => [
      { name: "x_fin_example_payment", label: "Example Payment Information" },
      { name: "x_stage_example_payment", label: "Example Payment", staging: true },
    ],
    onResolveTable: async (name) => Object.assign(tableInfo(name, { label: "Example Payment" }), {
      staging: name === "x_stage_example_payment",
    }),
  });
  await type(harness, shadow, "example payment");
  await settle();
  const tags = options(shadow).map((option) => {
    const tag = option.querySelector(".table-tag");
    return tag ? tag.textContent : "";
  });
  assert.deepStrictEqual(tags, ["", "import set staging"]);

  key(tableInput(shadow), "ArrowDown");
  key(tableInput(shadow), "Enter");
  await settle();
  assert.match(q(shadow, ".field-summary").textContent,
    /^Example Payment \(x_stage_example_payment\) · import set staging table · Searching:/);
});

/* ------------------------------------------------------------------ *
 * Starring and unstarring
 * ------------------------------------------------------------------ */

async function chooseLiveTable(harness, shadow, name) {
  await type(harness, shadow, name);
  await settle();
  key(tableInput(shadow), "Enter");
}

test("the star is its own cell, named once, and enabled only after the table is verified", async () => {
  const harness = load();
  const worker = favoriteWorker();
  const resolving = deferred();
  const shadow = openPanel(harness, {
    onFavoriteOp: worker.op,
    onFindTables: async () => [{ name: "u_example_table", label: "Example table" }],
    onResolveTable: () => resolving.promise,
  });
  const star = starButton(shadow);
  assert.strictEqual(star.hidden, true, "nothing to star before a table");

  await chooseLiveTable(harness, shadow, "u_example");
  assert.strictEqual(star.hidden, false);
  assert.strictEqual(star.disabled, true, "disabled while the table resolves");
  assert.strictEqual(star.getAttribute("aria-label"), "Star this table");
  assert.strictEqual(star.getAttribute("aria-pressed"), "false");
  assert.strictEqual(star.parentNode.className, "field-line");
  assert.strictEqual(star.closest(".field-summary"), null, "never inside the clipping summary");

  resolving.resolve(tableInfo("u_example_table", { label: "Example table" }));
  await settle();
  assert.strictEqual(star.disabled, false);

  star.fire("click");
  await settle();
  assert.deepStrictEqual(worker.calls, [{
    op: "star", name: "u_example_table", label: "Example table", fields: ["number"], filterFields: [],
    columns: ["number"],
  }]);
  assert.strictEqual(star.getAttribute("aria-pressed"), "true");
  assert.strictEqual(star.getAttribute("aria-label"), "Star this table", "the name never changes");
  assert.match(status(shadow), /Starred Example table \(u_example_table\)/);

  star.fire("click");
  await settle();
  assert.deepStrictEqual(worker.calls[1], { op: "unstar", name: "u_example_table" });
  assert.strictEqual(star.getAttribute("aria-pressed"), "false");
  assert.match(status(shadow), /Removed Example table \(u_example_table\)/);
});

test("starring past the cap is refused with the message, and nothing changes", async () => {
  const harness = load();
  const shadow = openPanel(harness, {
    onFavoriteOp: async () => ({ ok: false, code: "cap", limit: 20, tables: [] }),
    onFindTables: async () => [{ name: "u_example_table", label: "Example table" }],
  });
  await chooseLiveTable(harness, shadow, "u_example");
  await settle();
  starButton(shadow).fire("click");
  await settle();
  assert.match(status(shadow), /You have 20 starred tables on this instance\. Unstar one first\./);
  assert.strictEqual(starButton(shadow).getAttribute("aria-pressed"), "false");
});

test("a favourite that no longer resolves can be unstarred from where it fails", async () => {
  const harness = load();
  const favorites = [{ name: "u_gone_table", label: "Gone table", fields: [] }];
  const worker = favoriteWorker(favorites);
  const failure = Object.assign(new Error("That table was not found, is inactive, or its metadata is not readable."), { code: "schema" });
  const shadow = openPanel(harness, {
    favorites,
    onFavoriteOp: worker.op,
    onResolveTable: async () => { throw failure; },
  });
  key(tableInput(shadow), "Enter");
  await settle();
  assert.match(status(shadow), /not found/);
  const star = starButton(shadow);
  assert.strictEqual(star.hidden, false);
  assert.strictEqual(star.getAttribute("aria-pressed"), "true");
  assert.strictEqual(star.disabled, false);

  star.focus();
  star.fire("click");
  await settle();
  assert.deepStrictEqual(worker.calls, [{ op: "unstar", name: "u_gone_table" }]);
  assert.strictEqual(star.hidden, true);
  assert.strictEqual(harness.dom.document.activeElement, tableInput(shadow), "focus is not lost");
  assert.strictEqual(tableInput(shadow).value, "");
  /* Focus must not reopen a list that still holds the table just removed. */
  assert.ok(!menu(shadow).textContent.includes("u_gone_table"));
  assert.match(status(shadow), /Removed Gone table \(u_gone_table\)/);
});

test("a table that is not a favourite shows no star when it fails", async () => {
  const harness = load();
  const shadow = openPanel(harness, {
    onFindTables: async () => [{ name: "u_example_table", label: "Example table" }],
    onResolveTable: async () => { throw Object.assign(new Error("No access"), { code: "access" }); },
  });
  await chooseLiveTable(harness, shadow, "u_example");
  await settle();
  assert.strictEqual(starButton(shadow).hidden, true);
});

/* ------------------------------------------------------------------ *
 * Remembered search fields
 * ------------------------------------------------------------------ */

test("a favourite's remembered fields are verified, applied, saved on change, and searched with", async () => {
  const harness = load();
  const worker = favoriteWorker(FAVORITES);
  const resolveCalls = [];
  const searches = [];
  const shadow = openPanel(harness, {
    favorites: FAVORITES,
    onFavoriteOp: worker.op,
    onResolveTable: async (name, opts) => {
      resolveCalls.push([name, opts]);
      return tableInfo(name, {
        label: "Example table",
        fields: ["number", "short_description", "u_code"],
        remembered: { requested: ["u_code"], verified: ["u_code"], absent: [], unverifiable: [] },
      });
    },
    onSearch: async (input) => { searches.push(input); return { stale: false, table: input.table, results: [] }; },
  });
  key(tableInput(shadow), "Enter");
  await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(resolveCalls)), [
    ["u_example_table", { rememberedFields: ["u_code"], rememberedColumns: [] }],
  ]);
  assert.strictEqual(q(shadow, ".fields-button").textContent, "Search 1 field");
  assert.match(q(shadow, ".field-summary").textContent, /\[u_code\]/);
  assert.match(status(shadow), /this favourite's remembered fields/);
  assert.deepStrictEqual(worker.calls, [], "selecting a favourite writes nothing");

  toggleField(shadow, "short_description");
  await settle();
  assert.deepStrictEqual(worker.calls, [{
    op: "fields", name: "u_example_table", fields: ["u_code", "short_description"],
  }]);
  assert.match(status(shadow), /Saved as this favourite's search fields/);

  q(shadow, "[data-input='term']").value = "example";
  q(shadow, ".form").fire("submit");
  await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(searches[0].rememberedFields)), ["u_code"]);
});

test("changing fields on a table that is not starred writes nothing", async () => {
  const harness = load();
  const worker = favoriteWorker();
  const shadow = openPanel(harness, {
    onFavoriteOp: worker.op,
    onFindTables: async () => [{ name: "u_example_table", label: "Example table" }],
  });
  await chooseLiveTable(harness, shadow, "u_example");
  await settle();
  toggleField(shadow, "short_description");
  await settle();
  assert.deepStrictEqual(worker.calls, []);
});

test("a remembered field that is gone is named, and the rest still apply", async () => {
  const harness = load();
  const shadow = openPanel(harness, {
    favorites: FAVORITES,
    onResolveTable: async (name) => tableInfo(name, {
      fields: ["number", "u_code"],
      remembered: {
        requested: ["u_code", "u_removed"], verified: ["u_code"], absent: ["u_removed"], unverifiable: [],
      },
    }),
  });
  key(tableInput(shadow), "Enter");
  await settle();
  assert.match(status(shadow), /no longer on this table: u_removed \(dropped when its fields are next saved\)/);
  assert.match(q(shadow, ".field-summary").textContent, /\[u_code\]/);
});

test("remembered fields that could not be verified fall back to defaults and are never overwritten", async () => {
  const harness = load();
  const worker = favoriteWorker(FAVORITES);
  const shadow = openPanel(harness, {
    favorites: FAVORITES,
    onFavoriteOp: worker.op,
    onResolveTable: async (name) => tableInfo(name, {
      fields: ["number", "short_description"],
      remembered: { requested: ["u_code"], verified: [], absent: [], unverifiable: ["u_code"] },
    }),
  });
  key(tableInput(shadow), "Enter");
  await settle();
  assert.match(status(shadow), /could not be verified right now, so defaults apply/);
  assert.match(q(shadow, ".field-summary").textContent, /\[number\]/);

  toggleField(shadow, "short_description");
  await settle();
  assert.deepStrictEqual(worker.calls, [], "a passing failure is never saved as a loss");
  assert.match(status(shadow), /Not saved/);
});

/* ------------------------------------------------------------------ *
 * Value filters
 * ------------------------------------------------------------------ */

const FILTER_FIELDS = {
  fields: [
    { name: "assignment_group", label: "Assignment group", kind: "reference", reference: "sys_user_group" },
    { name: "category", label: "Category", kind: "choice" },
    { name: "priority", label: "Priority", kind: "choice" },
    { name: "state", label: "State", kind: "choice" },
  ],
  truncated: false,
};

const FILTER_VALUES = {
  state: { kind: "choice", values: [
    { value: "1", label: "New", hint: "1" },
    { value: "2", label: "In Progress", hint: "2" },
  ], note: "Labels in the instance language (en)." },
  assignment_group: { kind: "reference", values: [
    { value: "0123456789abcdef0123456789abcdef", label: "Example group", hint: "" },
  ], truncated: true, note: "All records in sys_user_group, not the form's filtered list." },
};

function filterOptions(extra) {
  return Object.assign({
    onFindTables: async () => [{ name: "incident", label: "Incident" }],
    onFilterFields: async () => FILTER_FIELDS,
    onFilterValues: async (table, field) => FILTER_VALUES[field] || { kind: "choice", values: [] },
  }, extra || {});
}

const byId = (shadow, id) => q(shadow, "#" + id);
const menuOptions = (shadow, id) => shadow.querySelectorAll("#" + id + "-menu .option");

async function openOnTable(harness, extra) {
  const shadow = openPanel(harness, filterOptions(extra));
  await chooseLiveTable(harness, shadow, "incident");
  await settle();
  return shadow;
}

async function addRow(shadow) {
  q(shadow, ".add-filter").fire("click");
  await settle();
}

async function pick(shadow, comboId, label) {
  const option = menuOptions(shadow, comboId)
    .find((node) => node.querySelector(".option-label").textContent === label);
  assert.ok(option, "no option " + label + " in " + comboId);
  option.fire("click");
  await settle();
}

test("filters appear once a table is verified, and every row's pickers have unique ids", async () => {
  const harness = load();
  const shadow = openPanel(harness, filterOptions());
  assert.strictEqual(q(shadow, ".filters").hidden, true, "nothing to filter before a table");
  await chooseLiveTable(harness, shadow, "incident");
  await settle();
  assert.strictEqual(q(shadow, ".filters").hidden, false);

  await addRow(shadow);
  await addRow(shadow);
  await addRow(shadow);
  const ids = shadow.querySelectorAll(".filter-row input").map((input) => input.id);
  assert.deepStrictEqual(ids, [
    "snh-rs-filter-1-field", "snh-rs-filter-1-value",
    "snh-rs-filter-2-field", "snh-rs-filter-2-value",
    "snh-rs-filter-3-field", "snh-rs-filter-3-value",
  ]);
  assert.strictEqual(q(shadow, ".add-filter").disabled, true, "a fourth cannot be added");

  const remove = shadow.querySelectorAll(".filter-remove")[1];
  assert.strictEqual(remove.getAttribute("aria-label"), "Remove filter 2");
  remove.fire("click");
  assert.strictEqual(harness.dom.document.activeElement, q(shadow, ".add-filter"), "focus goes to Add filter");
  assert.strictEqual(shadow.querySelectorAll(".filter-row").length, 2);
  assert.strictEqual(shadow.querySelectorAll(".filter-remove")[1].getAttribute("aria-label"), "Remove filter 2",
    "the rows are renumbered");
  await addRow(shadow);
  assert.ok(byId(shadow, "snh-rs-filter-4-field"), "a removed row's ids are never reused");
  assert.strictEqual(byId(shadow, "snh-rs-filter-2-field"), null);
});

test("a field already used in one row is not offered in another, and a value waits for its field", async () => {
  const harness = load();
  const shadow = await openOnTable(harness);
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-1-field", "Assignment group");
  await addRow(shadow);
  const offered = menuOptions(shadow, "snh-rs-filter-2-field")
    .map((node) => node.querySelector(".option-label").textContent);
  assert.deepStrictEqual(offered, ["Category", "Priority", "State"]);
  const value = byId(shadow, "snh-rs-filter-2-value");
  assert.strictEqual(value.disabled, true);
  assert.strictEqual(value.getAttribute("placeholder"), "choose a field first");
});

test("picking a field opens its values, a value searches at once, and Enter names the empty row", async () => {
  const harness = load();
  const searches = [];
  const shadow = await openOnTable(harness, {
    onSearch: async (input) => {
      searches.push(JSON.parse(JSON.stringify(input)));
      return { stale: false, table: "incident", tableLabel: "Incident", results: [],
        filters: [{ field: "state", label: "State", value: "2" }], filterOnly: true,
        sortLabel: "most recently updated" };
    },
  });
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-1-field", "State");
  assert.strictEqual(byId(shadow, "snh-rs-filter-1-value-menu").hidden, false, "the values open by themselves");
  assert.match(byId(shadow, "snh-rs-filter-1-value-menu").textContent, /Labels in the instance language/);
  assert.strictEqual(searches.length, 0, "a field alone is half a condition");
  await pick(shadow, "snh-rs-filter-1-value", "In Progress");
  assert.strictEqual(searches.length, 1, "the value pick searched");
  assert.strictEqual(searches[0].term, "");
  assert.deepStrictEqual(searches[0].filters, [{ field: "state", value: "2" }]);
  await addRow(shadow);
  assert.strictEqual(searches.length, 1, "an empty row changes no question");

  q(shadow, ".form").fire("submit");
  await settle();
  assert.strictEqual(searches.length, 2, "Enter always asks");
  assert.deepStrictEqual(searches[1].filters, [{ field: "state", value: "2" }]);
  assert.match(status(shadow), /1 filter · sorted by most recently updated · 1 filter row has no value yet/);
  assert.match(q(shadow, ".rows").textContent, /No verified matches for these filters/);
});

test("with no text and no complete filter, nothing is searched", async () => {
  const harness = load();
  const searches = [];
  const shadow = await openOnTable(harness, { onSearch: async (input) => { searches.push(input); return null; } });
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-1-field", "State");
  q(shadow, ".form").fire("submit");
  await settle();
  assert.deepStrictEqual(searches, []);
  assert.match(status(shadow), /Choose a value for the filter, or enter text or a sys_id/);
});

test("Escape closes an open filter menu before it may close the panel", async () => {
  const harness = load();
  const shadow = await openOnTable(harness);
  await addRow(shadow);
  assert.strictEqual(byId(shadow, "snh-rs-filter-1-field-menu").hidden, false);
  harness.dom.window.fire("keydown", { key: "Escape" });
  assert.strictEqual(byId(shadow, "snh-rs-filter-1-field-menu").hidden, true);
  assert.strictEqual(harness.ui.isOpen(), true);
  harness.dom.window.fire("keydown", { key: "Escape" });
  assert.strictEqual(harness.ui.isOpen(), false);
});

test("every filter picker is busy during a search, and a value still waits for its field after", async () => {
  const harness = load();
  const searching = deferred();
  const shadow = await openOnTable(harness, { onSearch: () => searching.promise });
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-1-field", "State");
  await pick(shadow, "snh-rs-filter-1-value", "New");
  await addRow(shadow);
  q(shadow, ".form").fire("submit");
  await tick();
  shadow.querySelectorAll(".filter-row input").forEach((input) => assert.strictEqual(input.disabled, true));
  assert.strictEqual(q(shadow, ".add-filter").disabled, true);
  searching.resolve({ stale: false, table: "incident", results: [], filters: [] });
  await settle();
  assert.strictEqual(byId(shadow, "snh-rs-filter-1-value").disabled, false);
  assert.strictEqual(byId(shadow, "snh-rs-filter-2-field").disabled, false);
  assert.strictEqual(byId(shadow, "snh-rs-filter-2-value").disabled, true, "blocked is not busy");
});

test("an access answer in a value picker is shown as such, never as an empty list", async () => {
  const harness = load();
  const shadow = await openOnTable(harness, {
    onFilterValues: async () => {
      throw Object.assign(new Error("The display column of sys_user_group could not be read, so its records cannot be listed."), { code: "access" });
    },
  });
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-1-field", "Assignment group");
  assert.match(byId(shadow, "snh-rs-filter-1-value-menu").textContent, /could not be read/);
  assert.strictEqual(menuOptions(shadow, "snh-rs-filter-1-value").length, 0);
});

test("a capped reference list says to type, and names the table it lists", async () => {
  const harness = load();
  const shadow = await openOnTable(harness);
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-1-field", "Assignment group");
  const text = byId(shadow, "snh-rs-filter-1-value-menu").textContent;
  assert.match(text, /More records exist than can be listed — type at least three characters/);
  assert.match(text, /All records in sys_user_group, not the form's filtered list/);
});

test("changing the table removes its filter rows", async () => {
  const harness = load();
  const shadow = await openOnTable(harness);
  await addRow(shadow);
  await type(harness, shadow, "change");
  assert.strictEqual(shadow.querySelectorAll(".filter-row").length, 0);
  assert.strictEqual(q(shadow, ".filters").hidden, true);
});

test("a starred table restores its filter fields with empty values, and names one that is gone", async () => {
  const harness = load();
  const favorites = [{ name: "incident", label: "Incident", fields: [], filterFields: ["state", "u_removed"] }];
  const worker = favoriteWorker(favorites);
  const shadow = openPanel(harness, filterOptions({ favorites, onFavoriteOp: worker.op }));
  key(tableInput(shadow), "Enter");
  await settle();
  const fieldInputs = shadow.querySelectorAll(".filter-row input");
  assert.strictEqual(shadow.querySelectorAll(".filter-row").length, 1);
  assert.strictEqual(fieldInputs[0].value, "State");
  assert.strictEqual(fieldInputs[1].value, "", "a value is never remembered");
  assert.strictEqual(fieldInputs[1].disabled, false);
  assert.match(status(shadow), /1 remembered filter ready for a value · filter fields no longer offered: u_removed/);
  assert.deepStrictEqual(worker.calls, [], "restoring writes nothing");

  shadow.querySelectorAll(".filter-remove")[0].fire("click");
  await settle();
  assert.deepStrictEqual(worker.calls, [{ op: "filterFields", name: "incident", filterFields: [] }]);
  assert.match(status(shadow), /Saved as this favourite's filter fields/);
});

test("filter fields that could not be verified are never saved over", async () => {
  const harness = load();
  const favorites = [{ name: "incident", label: "Incident", fields: [], filterFields: ["state"] }];
  const worker = favoriteWorker(favorites);
  let fail = true;
  const shadow = openPanel(harness, filterOptions({
    favorites,
    onFavoriteOp: worker.op,
    onFilterFields: async () => {
      if (fail) throw Object.assign(new Error("timed out"), { code: "transient" });
      return FILTER_FIELDS;
    },
  }));
  key(tableInput(shadow), "Enter");
  await settle();
  assert.strictEqual(shadow.querySelectorAll(".filter-row").length, 0);
  assert.match(status(shadow), /filter fields could not be verified right now/);
  fail = false;
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-1-field", "Priority");
  assert.deepStrictEqual(worker.calls, []);
  assert.match(status(shadow), /Not saved: this favourite's filter fields/);
});

test("a search started while remembered filters restore does not lose them", async () => {
  /* The review's B1: the restore used to be abandoned by any search, and the
   * next save then wrote only the rows on screen over the remembered names. */
  const harness = load();
  const favorites = [{ name: "incident", label: "Incident", fields: [], filterFields: ["assignment_group", "state"] }];
  const worker = favoriteWorker(favorites);
  const fieldsRead = deferred();
  const shadow = openPanel(harness, filterOptions({
    favorites,
    onFavoriteOp: worker.op,
    onFilterFields: () => fieldsRead.promise,
    onSearch: async () => ({ stale: false, table: "incident", tableLabel: "Incident", results: [] }),
  }));
  key(tableInput(shadow), "Enter");
  await settle();
  q(shadow, "[data-input='term']").value = "INC0010001";
  q(shadow, ".form").fire("submit");
  await settle();
  fieldsRead.resolve(FILTER_FIELDS);
  await settle();
  assert.deepStrictEqual(
    shadow.querySelectorAll(".filter-row input").filter((input) => input.id.endsWith("-field")).map((input) => input.value),
    ["Assignment group", "State"]
  );
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-3-field", "Priority");
  assert.deepStrictEqual(worker.calls.at(-1).filterFields, ["assignment_group", "state", "priority"]);
});

test("a filter change made while the restore reads is saved after it, with every name", async () => {
  const harness = load();
  const favorites = [{ name: "incident", label: "Incident", fields: [], filterFields: ["state"] }];
  const worker = favoriteWorker(favorites);
  const fieldsRead = deferred();
  let first = true;
  const shadow = openPanel(harness, filterOptions({
    favorites,
    onFavoriteOp: worker.op,
    onFilterFields: () => {
      if (first) { first = false; return fieldsRead.promise; }
      return Promise.resolve(FILTER_FIELDS);
    },
  }));
  key(tableInput(shadow), "Enter");
  await settle();
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-1-field", "Priority");
  assert.deepStrictEqual(worker.calls, [], "nothing is written over the names still being restored");
  fieldsRead.resolve(FILTER_FIELDS);
  await settle();
  assert.deepStrictEqual(worker.calls, [{ op: "filterFields", name: "incident", filterFields: ["priority", "state"] }]);
});

test("Enter inside an open filter picker never submits the form, even while it is looking", async () => {
  const harness = load();
  const searches = [];
  const shadow = await openOnTable(harness, {
    onFilterFields: () => new Promise(() => {}),
    onSearch: async (input) => { searches.push(input); return null; },
  });
  await addRow(shadow);
  assert.match(byId(shadow, "snh-rs-filter-1-field-menu").textContent, /Looking…/);
  const event = byId(shadow, "snh-rs-filter-1-field").fire("keydown", { key: "Enter" });
  assert.strictEqual(event.defaultPrevented, true);
});

test("an empty search-field list is not saved as a favourite's choice", async () => {
  const harness = load();
  const favorites = [{ name: "incident", label: "Incident", fields: ["number"], filterFields: [] }];
  const worker = favoriteWorker(favorites);
  const shadow = openPanel(harness, {
    favorites,
    onFavoriteOp: worker.op,
    onResolveTable: async (name) => tableInfo(name, {
      remembered: { requested: ["number"], verified: ["number"], absent: [], unverifiable: [] },
    }),
  });
  key(tableInput(shadow), "Enter");
  await settle();
  toggleField(shadow, "number");
  await settle();
  assert.deepStrictEqual(worker.calls, []);
  assert.match(status(shadow), /Not saved: choose at least one field/);
});

test("starring a table saves its current filter fields", async () => {
  const harness = load();
  const worker = favoriteWorker();
  const shadow = await openOnTable(harness, { onFavoriteOp: worker.op });
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-1-field", "State");
  starButton(shadow).fire("click");
  await settle();
  assert.deepStrictEqual(worker.calls[0].filterFields, ["state"]);
});

/* ------------------------------------------------------------------ *
 * Empty results
 * ------------------------------------------------------------------ */

async function emptySearch(term, answer) {
  const harness = load();
  const shadow = openPanel(harness, {
    onFindTables: async () => [{ name: "x_example_payment", label: "Example Payment" }],
    onSearch: async (input) => Object.assign({
      stale: false, table: input.table, tableLabel: "Example Payment", results: [], filters: [],
    }, answer),
  });
  await chooseLiveTable(harness, shadow, "x_example_payment");
  await settle();
  q(shadow, "[data-input='term']").value = term;
  q(shadow, ".form").fire("submit");
  await settle();
  return q(shadow, ".rows").querySelector(".empty").textContent;
}

test("an empty sys_id search says the record is not in that table, not that fields missed", async () => {
  const text = await emptySearch("0123456789abcdef0123456789abcdef", { bySysId: true });
  assert.match(text, /^No record with this sys_id in Example Payment\./);
  assert.match(text, /only in its record's own table or a parent of it/);
  assert.ok(!/selected fields/.test(text), "a sys_id search uses no fields");
  assert.ok(!/staging/.test(text));
});

test("an empty search on a staging table says where the records probably are", async () => {
  const bySysId = await emptySearch("0123456789abcdef0123456789abcdef", { bySysId: true, staging: true });
  assert.match(bySysId, /This is an import set staging table\./);
  assert.match(bySysId, /may be in the table they were loaded into/);
  const byText = await emptySearch("example", { bySysId: false, staging: true });
  assert.match(byText, /^No verified matches in the selected fields\./);
  assert.match(byText, /This is an import set staging table\./);
});

test("an empty text search on an ordinary table reads as before", async () => {
  const text = await emptySearch("example", { bySysId: false });
  assert.strictEqual(text, "No verified matches in the selected fields." +
    "Try another term, select different verified fields, or use an exact sys_id.");
});

/* ------------------------------------------------------------------ *
 * Clearing the Table and Text boxes
 * ------------------------------------------------------------------ */

const clearButton = (shadow, which) => q(shadow, "[data-clear='" + which + "']");

test("the Table ✕ empties the box and its selection, then shows the starred tables", async () => {
  const harness = load();
  const shadow = openPanel(harness, filterOptions({ favorites: FAVORITES }));
  assert.strictEqual(clearButton(shadow, "table").hidden, true, "nothing to clear yet");
  await chooseLiveTable(harness, shadow, "incident");
  await settle();
  await addRow(shadow);
  const clear = clearButton(shadow, "table");
  assert.strictEqual(clear.hidden, false);
  assert.strictEqual(clear.getAttribute("aria-label"), "Clear table");
  assert.strictEqual(clear.fire("mousedown").defaultPrevented, true, "a press keeps focus in the box");

  clear.fire("click");
  assert.strictEqual(tableInput(shadow).value, "");
  assert.strictEqual(clear.hidden, true);
  assert.strictEqual(harness.dom.document.activeElement, tableInput(shadow));
  assert.strictEqual(q(shadow, ".filters").hidden, true, "the table's filters go with it");
  assert.strictEqual(shadow.querySelectorAll(".filter-row").length, 0);
  assert.strictEqual(q(shadow, ".fields-button").textContent, "Search 0 fields");
  assert.strictEqual(q(shadow, ".columns-button").textContent, "Show 0 columns");
  assert.strictEqual(menu(shadow).hidden, false);
  assert.strictEqual(options(shadow).length, 2);
  assert.ok(options(shadow).every((option) => option.textContent.includes("starred")));
  assert.match(status(shadow), /Your starred tables/);
});

test("with no favourites a clear asks for nothing, and a lookup it overtook is dropped", async () => {
  const harness = load();
  const pending = deferred();
  const lookups = [];
  const shadow = openPanel(harness, {
    onFindTables: (value) => { lookups.push(value); return pending.promise; },
  });
  await type(harness, shadow, "inc");
  assert.deepStrictEqual(lookups, ["inc"]);
  const input = tableInput(shadow);
  input.value = "incid";
  input.fire("input");
  clearButton(shadow, "table").fire("click");
  harness.runTimers();
  assert.deepStrictEqual(lookups, ["inc"], "the debounced lookup never runs");
  pending.resolve([{ name: "incident", label: "Incident" }]);
  await settle();
  assert.strictEqual(menu(shadow).hidden, true, "the overtaken answer is not shown");
  assert.strictEqual(options(shadow).length, 0);
  assert.strictEqual(status(shadow), "Search for a table to begin.");
});

test("the Text ✕ stays live during a search and withdraws its answer; the Table ✕ waits", async () => {
  const harness = load();
  const searching = deferred();
  const shadow = openPanel(harness, {
    onFindTables: async () => [{ name: "incident", label: "Incident" }],
    onSearch: () => searching.promise,
  });
  await chooseLiveTable(harness, shadow, "incident");
  await settle();
  const term = q(shadow, "[data-input='term']");
  const clear = clearButton(shadow, "term");
  assert.strictEqual(clear.hidden, true);
  term.value = "INC0010001";
  term.fire("input");
  assert.strictEqual(clear.hidden, false);
  assert.strictEqual(clear.getAttribute("aria-label"), "Clear text or sys_id");

  q(shadow, ".form").fire("submit");
  await tick();
  assert.strictEqual(term.disabled, false, "the text box stays live");
  assert.strictEqual(clear.disabled, false);
  assert.strictEqual(clearButton(shadow, "table").disabled, true);
  clearButton(shadow, "table").fire("click");
  assert.strictEqual(tableInput(shadow).value, "incident", "the table is not cleared under a search");

  clear.fire("click");
  assert.strictEqual(term.value, "");
  assert.strictEqual(clear.hidden, true);
  assert.strictEqual(harness.dom.document.activeElement, term);
  assert.strictEqual(status(shadow), "Ready · Example incident (incident)");
  searching.resolve({ stale: false, table: "incident", tableLabel: "Incident", results: [
    { table: "incident", sysId: "0123456789abcdef0123456789abcdef", title: "INC0010001", values: [] },
  ] });
  await settle();
  assert.strictEqual(shadow.querySelectorAll(".row").length, 0, "the answer to the cleared text is dropped");
  assert.match(q(shadow, ".rows").textContent, /^Search Example incident\./);
  assert.strictEqual(clearButton(shadow, "table").disabled, false, "the controls are released");
});

/* ------------------------------------------------------------------ *
 * Copy confirmation
 * ------------------------------------------------------------------ */

const RESULT_SYS_ID = "0123456789abcdef0123456789abcdef";

async function searchedRow(harness) {
  const shadow = openPanel(harness, {
    onFindTables: async () => [{ name: "incident", label: "Incident" }],
    onSearch: async () => ({ stale: false, table: "incident", tableLabel: "Incident", results: [
      { table: "incident", sysId: RESULT_SYS_ID, title: "INC0010001", values: [] },
    ] }),
  });
  await chooseLiveTable(harness, shadow, "incident");
  await settle();
  q(shadow, "[data-input='term']").value = "INC0010001";
  q(shadow, ".form").fire("submit");
  await settle();
  assert.match(status(shadow), /^1 verified record in Incident/);
  return shadow;
}

const resultAction = (shadow, label) => shadow.querySelectorAll(".result-action")
  .find((button) => button.textContent === label);

test("a copy is confirmed on the button pressed, which then reads as before", async () => {
  const harness = load();
  const copied = [];
  harness.navigator.clipboard = { writeText: async (text) => { copied.push(text); } };
  const shadow = await searchedRow(harness);
  const copySysId = resultAction(shadow, "Copy sys_id");
  copySysId.fire("click");
  await settle();
  assert.deepStrictEqual(copied, [RESULT_SYS_ID]);
  assert.strictEqual(copySysId.textContent, "✓ Copied");
  assert.strictEqual(copySysId.className, "result-action copied");
  assert.strictEqual(copySysId.querySelector("span").getAttribute("aria-hidden"), "true",
    "the tick is not read out");
  assert.strictEqual(status(shadow), "sys_id copied to the clipboard.", "the status line still announces it");

  /* A second press restarts the confirmation, and the label still comes back. */
  copySysId.fire("click");
  await settle();
  harness.runTimers();
  assert.strictEqual(copySysId.textContent, "Copy sys_id");
  assert.strictEqual(copySysId.className, "result-action");

  const copyUrl = resultAction(shadow, "Copy URL");
  copyUrl.fire("click");
  await settle();
  assert.strictEqual(copied[2], "https://example.service-now.com/incident.do?sys_id=" + RESULT_SYS_ID);
  assert.strictEqual(copyUrl.textContent, "✓ Copied");
  assert.strictEqual(copySysId.textContent, "Copy sys_id", "only the pressed button changes");
});

test("a blocked copy says so on the button as well as on the status line", async () => {
  const harness = load();
  harness.navigator.clipboard = { writeText: async () => { throw new Error("blocked"); } };
  const shadow = await searchedRow(harness);
  const copySysId = resultAction(shadow, "Copy sys_id");
  copySysId.fire("click");
  await settle();
  assert.strictEqual(copySysId.textContent, "Copy failed");
  assert.strictEqual(copySysId.className, "result-action copy-failed");
  assert.match(status(shadow), /Clipboard access was blocked/);
  assert.strictEqual(harness.dom.document.body.children.length, 0, "the fallback leaves nothing behind");
  harness.runTimers();
  assert.strictEqual(copySysId.textContent, "Copy sys_id");
});

/* ------------------------------------------------------------------ *
 * Searching as the question changes
 * ------------------------------------------------------------------ */

function rowFor(table, title) {
  return { table, sysId: RESULT_SYS_ID, title, values: [] };
}

const resultTitles = (shadow) => shadow.querySelectorAll(".row .title").map((node) => node.textContent);
const termInput = (shadow) => q(shadow, "[data-input='term']");

async function typeTerm(harness, value) {
  const input = termInput(harness.shadow());
  input.value = value;
  input.fire("input");
  harness.runTimers();
  await settle();
}

test("switching tables clears the results, and text already typed searches the new table", async () => {
  const harness = load();
  const searches = [];
  const shadow = openPanel(harness, {
    onFindTables: async (value) => [{ name: value, label: value }],
    onSearch: async (input) => {
      searches.push(input.table);
      return { stale: false, table: input.table, tableLabel: input.table, results: [rowFor(input.table, input.table + " row")] };
    },
  });
  await chooseLiveTable(harness, shadow, "incident");
  await settle();
  termInput(shadow).value = "INC0010001";
  q(shadow, ".form").fire("submit");
  await settle();
  assert.deepStrictEqual(resultTitles(shadow), ["incident row"]);

  await type(harness, shadow, "problem");
  assert.deepStrictEqual(resultTitles(shadow), [], "the old table's records are gone at once");
  assert.match(q(shadow, ".rows").textContent, /^Find a record/);
  assert.strictEqual(q(shadow, "[data-action='open-list']").disabled, true);

  await settle();
  key(tableInput(shadow), "Enter");
  await settle();
  assert.deepStrictEqual(searches, ["incident", "problem"]);
  assert.deepStrictEqual(resultTitles(shadow), ["problem row"]);
});

test("a table whose ready line carries a warning is not searched until asked", async () => {
  const harness = load();
  const searches = [];
  const shadow = openPanel(harness, {
    favorites: [{ name: "u_example_table", label: "Example table", fields: ["u_gone"] }],
    onResolveTable: async (name) => tableInfo(name, {
      remembered: { requested: ["u_gone"], verified: [], absent: ["u_gone"], unverifiable: [] },
    }),
    onSearch: async (input) => { searches.push(input); return { stale: false, table: input.table, results: [] }; },
  });
  termInput(shadow).value = "INC0010001";
  options(shadow)[0].fire("click");
  await settle();
  assert.deepStrictEqual(searches, []);
  assert.match(status(shadow), /no longer on this table: u_gone/);
});

test("a pause in typing searches; a short term says what is needed and withdraws the answer", async () => {
  const harness = load();
  const searches = [];
  const shadow = openPanel(harness, {
    onFindTables: async () => [{ name: "incident", label: "Incident" }],
    onSearch: async (input) => {
      searches.push({ term: input.term, fields: JSON.parse(JSON.stringify(input.fields)) });
      return { stale: false, table: "incident", tableLabel: "Incident", results: [rowFor("incident", input.term)] };
    },
  });
  await chooseLiveTable(harness, shadow, "incident");
  await settle();
  const input = termInput(shadow);
  input.value = "INC001";
  input.fire("input");
  await settle();
  assert.deepStrictEqual(searches, [], "nothing before the pause");
  harness.runTimers();
  await settle();
  assert.deepStrictEqual(searches.map((search) => search.term), ["INC001"]);
  assert.deepStrictEqual(resultTitles(shadow), ["INC001"]);

  await typeTerm(harness, "INC001 ");
  assert.strictEqual(searches.length, 1, "a pause that changed nothing asks nothing");

  toggleField(shadow, "short_description");
  await settle();
  assert.strictEqual(searches.length, 1, "a field change waits for the pause too");
  harness.runTimers();
  await settle();
  assert.deepStrictEqual(searches[1].fields, ["number", "short_description"]);

  await typeTerm(harness, "IN");
  assert.strictEqual(searches.length, 2);
  assert.strictEqual(status(shadow), "Enter at least 3 consecutive letters, numbers, or underscores.");
  assert.strictEqual(q(shadow, ".status").className, "status", "said neutrally, not as an error");
  assert.deepStrictEqual(resultTitles(shadow), [], "the longer term's answer is withdrawn");
  assert.match(q(shadow, ".rows").textContent, /^Keep typing to search\./);
  assert.strictEqual(q(shadow, "[data-action='open-list']").disabled, true);

  await typeTerm(harness, "");
  assert.strictEqual(status(shadow), "Ready · Example incident (incident)");
  assert.match(q(shadow, ".rows").textContent, /^Search Example incident\./);
  assert.strictEqual(searches.length, 2);
});

test("one search at a time: text typed during a search waits, and only the latest is asked", async () => {
  const harness = load();
  const calls = [];
  const shadow = openPanel(harness, {
    onFindTables: async () => [{ name: "incident", label: "Incident" }],
    onSearch: (input) => {
      const pending = deferred();
      calls.push({ term: input.term, pending });
      return pending.promise;
    },
  });
  await chooseLiveTable(harness, shadow, "incident");
  await settle();
  await typeTerm(harness, "alpha");
  await typeTerm(harness, "bravo");
  await typeTerm(harness, "charlie");
  assert.deepStrictEqual(calls.map((call) => call.term), ["alpha"], "the others wait");
  assert.strictEqual(termInput(shadow).disabled, false);

  calls[0].pending.resolve({ stale: false, table: "incident", results: [rowFor("incident", "alpha")] });
  await settle();
  assert.deepStrictEqual(calls.map((call) => call.term), ["alpha", "charlie"], "only the latest is asked");
  assert.deepStrictEqual(resultTitles(shadow), [], "the outdated answer is never shown");
  assert.strictEqual(q(shadow, ".search-btn").disabled, true, "still busy for the next one");

  calls[1].pending.resolve({ stale: false, table: "incident", results: [rowFor("incident", "charlie")] });
  await settle();
  assert.deepStrictEqual(resultTitles(shadow), ["charlie"]);
  assert.strictEqual(q(shadow, ".search-btn").disabled, false);
});

test("clearing a value or removing a complete row asks again; the last one gone returns to ready", async () => {
  const harness = load();
  const searches = [];
  const shadow = await openOnTable(harness, {
    onSearch: async (input) => {
      searches.push(JSON.parse(JSON.stringify(input.filters.map((filter) => filter.field))));
      return { stale: false, table: "incident", tableLabel: "Incident", results: [], filters: [] };
    },
  });
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-1-field", "State");
  await pick(shadow, "snh-rs-filter-1-value", "New");
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-2-field", "Assignment group");
  await pick(shadow, "snh-rs-filter-2-value", "Example group");
  assert.deepStrictEqual(searches, [["state"], ["state", "assignment_group"]]);

  shadow.querySelectorAll(".filter-remove")[1].fire("click");
  await settle();
  assert.deepStrictEqual(searches[2], ["state"], "removing a complete row asks again");

  /* Clearing the field takes its value with it: the last condition is gone. */
  const field = byId(shadow, "snh-rs-filter-1-field");
  field.parentNode.querySelector(".combo-clear").fire("click");
  await settle();
  assert.strictEqual(searches.length, 3, "with nothing left there is nothing to ask");
  assert.strictEqual(status(shadow), "Ready · Example incident (incident)");
  assert.match(q(shadow, ".rows").textContent, /^Search Example incident\./);

  field.fire("focus");
  await settle();
  await pick(shadow, "snh-rs-filter-1-field", "State");
  await pick(shadow, "snh-rs-filter-1-value", "New");
  assert.deepStrictEqual(searches[3], ["state"]);
  byId(shadow, "snh-rs-filter-1-value").parentNode.querySelector(".combo-clear").fire("click");
  await settle();
  assert.strictEqual(searches.length, 4);
  assert.strictEqual(status(shadow), "Ready · Example incident (incident)", "clearing the value does the same");
});

/* ------------------------------------------------------------------ *
 * Review findings (B1, S3, S4)
 * ------------------------------------------------------------------ */

const searchAnswer = { stale: false, table: "incident", tableLabel: "Incident", results: [], filters: [] };

test("a starred table chosen under typed text is searched once its filter rows are back", async () => {
  const harness = load();
  const searches = [];
  const shadow = openPanel(harness, filterOptions({
    favorites: [{ name: "incident", label: "Incident", fields: [], filterFields: ["state"] }],
    onSearch: async (input) => { searches.push(input.term); return searchAnswer; },
  }));
  termInput(shadow).value = "INC0010001";
  options(shadow)[0].fire("click");
  await settle();
  assert.deepStrictEqual(searches, ["INC0010001"]);
  assert.match(status(shadow), /1 filter row has no value yet/, "the restored row is counted");
});

test("a starred table whose filter field is gone keeps the warning on screen and still saves", async () => {
  const harness = load();
  const favorites = [{ name: "incident", label: "Incident", fields: [], filterFields: ["state", "u_gone"] }];
  const worker = favoriteWorker(favorites);
  const searches = [];
  const shadow = openPanel(harness, filterOptions({
    favorites,
    onFavoriteOp: worker.op,
    onSearch: async (input) => { searches.push(input.term); return searchAnswer; },
  }));
  termInput(shadow).value = "INC0010001";
  options(shadow)[0].fire("click");
  await settle();
  assert.deepStrictEqual(searches, [], "the warning is read first");
  assert.match(status(shadow), /filter fields no longer offered: u_gone/);

  byId(shadow, "snh-rs-filter-1-field").parentNode.querySelector(".combo-clear").fire("click");
  await settle();
  assert.ok(worker.calls.some((call) => call.op === "filterFields"),
    "the favourite still saves: nothing was held back unannounced");
});

test("focus on a result row a search replaced goes to the text box, not the page", async () => {
  const harness = load();
  const shadow = openPanel(harness, {
    onFindTables: async () => [{ name: "incident", label: "Incident" }],
    onSearch: async (input) => ({ stale: false, table: "incident", results: [rowFor("incident", input.term)] }),
  });
  await chooseLiveTable(harness, shadow, "incident");
  await settle();
  await typeTerm(harness, "alpha");
  const input = termInput(shadow);
  input.value = "alphabet";
  input.fire("input");
  const row = shadow.querySelector(".row");
  row.focus();
  assert.strictEqual(harness.dom.document.activeElement, row);
  harness.runTimers();
  await settle();
  assert.deepStrictEqual(resultTitles(shadow), ["alphabet"]);
  assert.strictEqual(harness.dom.document.activeElement, input);
});

test("clearing a filter field on a starred table leaves the status to the search it starts", async () => {
  const harness = load();
  const calls = [];
  const shadow = openPanel(harness, filterOptions({
    favorites: [{ name: "incident", label: "Incident", fields: [], filterFields: ["state", "assignment_group"] }],
    onSearch: () => {
      const pending = deferred();
      calls.push(pending);
      return pending.promise;
    },
  }));
  options(shadow)[0].fire("click");
  await settle();
  for (const [id, label] of [["snh-rs-filter-1-value", "New"], ["snh-rs-filter-2-value", "Example group"]]) {
    byId(shadow, id).fire("focus");
    await settle();
    await pick(shadow, id, label);
    calls[calls.length - 1].resolve(searchAnswer);
    await settle();
  }
  assert.strictEqual(calls.length, 2);

  byId(shadow, "snh-rs-filter-1-field").parentNode.querySelector(".combo-clear").fire("click");
  await settle();
  assert.strictEqual(calls.length, 3);
  assert.match(status(shadow), /^Searching with 1 filter/, "the save's note does not replace the spinner");
  calls[2].resolve(searchAnswer);
  await settle();
});

/* ------------------------------------------------------------------ *
 * Search in vs Show: the columns each row displays
 * ------------------------------------------------------------------ */

/* A synthetic many-to-many: no display field, two references, one text
 * field and one shown-only flag. */
function linkInfo(name, extra) {
  const field = (fieldName, label, kind) => ({
    name: fieldName,
    label,
    type: kind === "reference" ? "reference" : kind === "other" ? "boolean" : "string",
    kind,
    searchable: kind !== "other",
    display: false,
    autoSelectable: true,
  });
  const fields = [
    field("u_company", "Company", "reference"),
    field("u_supplier", "Supplier", "reference"),
    field("u_currency", "Currency", "text"),
    field("u_active", "Active", "other"),
  ];
  return Object.assign({
    table: name,
    label: "Example link",
    hierarchy: [name],
    fields,
    defaultFields: fields.slice(0, 2),
    remembered: EMPTY_REMEMBERED,
    rememberedColumns: EMPTY_REMEMBERED,
  }, extra || {});
}

function toggleColumn(shadow, name) {
  const box = shadow.querySelectorAll(".column-option input")
    .find((input) => input.dataset.column === name);
  assert.ok(box, "no column checkbox for " + name);
  box.checked = !box.checked;
  box.fire("change");
}

/* Ticked columns with the position each one shows, in that position's order. */
const shownOrder = (shadow) => shadow.querySelectorAll(".column-option")
  .filter((option) => option.querySelector("input").checked)
  .map((option) => [option.querySelector("input").dataset.column, option.querySelector(".order").textContent])
  .sort((a, b) => Number(a[1]) - Number(b[1]));

function linkPanel(harness, extra) {
  return openPanel(harness, Object.assign({
    onFindTables: async () => [{ name: "u_example_link", label: "Example link" }],
    onResolveTable: async (name) => linkInfo(name),
  }, extra || {}));
}

test("Show starts as what is searched, keeps the order ticked, and asks again after the pause", async () => {
  const harness = load();
  const searches = [];
  const shadow = linkPanel(harness, {
    onSearch: async (input) => {
      searches.push(JSON.parse(JSON.stringify(input)));
      return { stale: false, table: input.table, results: [] };
    },
  });
  await chooseLiveTable(harness, shadow, "u_example_link");
  await settle();
  assert.strictEqual(q(shadow, ".fields-button").textContent, "Search 2 fields");
  assert.strictEqual(q(shadow, ".columns-button").textContent, "Show 2 columns");
  assert.deepStrictEqual(shownOrder(shadow), [["u_company", "1"], ["u_supplier", "2"]]);
  assert.match(status(shadow), /searching 2 fields · showing 2 columns/);

  assert.deepStrictEqual(shadow.querySelectorAll(".field-option input").map((input) => input.dataset.field),
    ["u_company", "u_supplier", "u_currency"], "a shown-only field is never offered for search");
  const company = shadow.querySelectorAll(".field-option")
    .find((option) => option.querySelector("input").dataset.field === "u_company");
  assert.match(company.textContent, /by name/);
  assert.deepStrictEqual(shadow.querySelectorAll(".column-option input").map((input) => input.dataset.column),
    ["u_company", "u_supplier", "u_currency", "u_active"]);

  termInput(shadow).value = "acme";
  toggleColumn(shadow, "u_active");
  toggleColumn(shadow, "u_company");
  assert.deepStrictEqual(shownOrder(shadow), [["u_supplier", "1"], ["u_active", "2"]]);
  assert.match(q(shadow, ".field-summary").textContent, / · Showing: Supplier, Active$/);
  assert.strictEqual(searches.length, 0, "a column change waits for the pause");
  harness.runTimers();
  await settle();
  assert.deepStrictEqual(searches.map((search) => search.columns), [["u_supplier", "u_active"]]);
  assert.deepStrictEqual(searches[0].fields, ["u_company", "u_supplier"], "what is searched is untouched");

  /* With an answer on screen, a column change still asks again: the new
   * column's values were never read. */
  toggleColumn(shadow, "u_supplier");
  harness.runTimers();
  await settle();
  assert.deepStrictEqual(searches.map((search) => search.columns), [["u_supplier", "u_active"], ["u_active"]]);

  toggleColumn(shadow, "u_active");
  assert.deepStrictEqual(shownOrder(shadow), [["u_active", "1"]], "the last column stays");
  assert.strictEqual(status(shadow), "Keep at least one column to show.");
});

test("Show is capped at six, and both pickers are busy during a search", async () => {
  const harness = load();
  const searching = deferred();
  const extra = ["u_one", "u_two", "u_three", "u_four", "u_five"].map((name) => ({
    name, label: name, type: "integer", kind: "other", searchable: false, display: false, autoSelectable: true,
  }));
  const shadow = linkPanel(harness, {
    onResolveTable: async (name) => {
      const info = linkInfo(name);
      return Object.assign(info, { fields: info.fields.concat(extra) });
    },
    onSearch: () => searching.promise,
  });
  await chooseLiveTable(harness, shadow, "u_example_link");
  await settle();
  ["u_currency", "u_active", "u_one", "u_two"].forEach((name) => toggleColumn(shadow, name));
  assert.strictEqual(shownOrder(shadow).length, 6);
  toggleColumn(shadow, "u_three");
  assert.strictEqual(shownOrder(shadow).length, 6);
  assert.strictEqual(status(shadow), "Show no more than six columns.");

  termInput(shadow).value = "acme";
  q(shadow, ".form").fire("submit");
  await tick();
  assert.strictEqual(q(shadow, ".columns-button").disabled, true);
  assert.ok(shadow.querySelectorAll(".column-option input").every((input) => input.disabled));
  searching.resolve({ stale: false, table: "u_example_link", results: [] });
  await settle();
  assert.strictEqual(q(shadow, ".columns-button").disabled, false);
  assert.ok(shadow.querySelectorAll(".column-option input").every((input) => !input.disabled));
});

/* A picker's visible rows, group by group. */
const pickerGroups = (shadow, menuSelector) => {
  const names = (group) => q(shadow, menuSelector + " " + group).children
    .filter((option) => !option.hidden)
    .map((option) => option.dataset.name);
  return { chosen: names(".picker-chosen"), rest: names(".picker-rest") };
};

test("a picker lists what is ticked first, in shown order, and re-sorts only when it opens", async () => {
  const harness = load();
  const shadow = linkPanel(harness);
  await chooseLiveTable(harness, shadow, "u_example_link");
  await settle();
  assert.deepStrictEqual(pickerGroups(shadow, ".column-menu"),
    { chosen: ["u_company", "u_supplier"], rest: ["u_currency", "u_active"] });

  const columns = q(shadow, ".columns-button");
  columns.fire("click");
  toggleColumn(shadow, "u_active");
  toggleColumn(shadow, "u_company");
  assert.deepStrictEqual(pickerGroups(shadow, ".column-menu"),
    { chosen: ["u_company", "u_supplier"], rest: ["u_currency", "u_active"] },
    "while the list is open, a pressed row stays where it is");

  columns.fire("click");
  columns.fire("click");
  assert.deepStrictEqual(pickerGroups(shadow, ".column-menu"),
    { chosen: ["u_supplier", "u_active"], rest: ["u_company", "u_currency"] },
    "reopened: ticked columns in shown order, then the rest in list order");
  assert.deepStrictEqual(shownOrder(shadow), [["u_supplier", "1"], ["u_active", "2"]]);
  toggleColumn(shadow, "u_company");
  columns.fire("click");
  columns.fire("click");
  assert.deepStrictEqual(pickerGroups(shadow, ".column-menu").chosen, ["u_supplier", "u_active", "u_company"],
    "shown order, not list order, where the two differ");

  const fields = q(shadow, ".fields-button");
  fields.fire("click");
  assert.strictEqual(q(shadow, ".column-menu").hidden, true, "opening one picker closes the other");
  toggleField(shadow, "u_company");
  fields.fire("click");
  fields.fire("click");
  assert.deepStrictEqual(pickerGroups(shadow, ".field-menu"),
    { chosen: ["u_supplier"], rest: ["u_company", "u_currency"] });
});

test("the find box narrows a picker by label or technical name, and Enter in it never submits", async () => {
  const harness = load();
  const shadow = linkPanel(harness);
  await chooseLiveTable(harness, shadow, "u_example_link");
  await settle();
  const fields = q(shadow, ".fields-button");
  fields.fire("click");
  const find = q(shadow, ".field-menu .picker-find");
  assert.strictEqual(harness.dom.document.activeElement, find, "opening puts the cursor in the find box");
  const headings = () => ["chosen", "rest"].map((name) => q(shadow, ".field-menu .picker-heading." + name).hidden);
  assert.deepStrictEqual(headings(), [false, false]);

  find.value = "CURR";
  find.fire("input");
  assert.deepStrictEqual(pickerGroups(shadow, ".field-menu"), { chosen: [], rest: ["u_currency"] });
  assert.deepStrictEqual(headings(), [true, true], "a single plain group needs no headings");

  find.value = " u_sup ";
  find.fire("input");
  assert.deepStrictEqual(pickerGroups(shadow, ".field-menu"), { chosen: ["u_supplier"], rest: [] });
  assert.deepStrictEqual(headings(), [false, true]);

  find.value = "zzz";
  find.fire("input");
  const none = q(shadow, ".field-menu .picker-none");
  assert.strictEqual(none.hidden, false);
  assert.strictEqual(none.textContent, "No field label or name contains “zzz”.");

  termInput(shadow).value = "acme";
  assert.strictEqual(key(find, "Enter").defaultPrevented, true, "Enter would submit the search form");

  fields.fire("click");
  fields.fire("click");
  assert.strictEqual(find.value, "", "a reopened picker starts unfiltered");
  assert.deepStrictEqual(pickerGroups(shadow, ".field-menu"),
    { chosen: ["u_company", "u_supplier"], rest: ["u_currency"] });
  assert.strictEqual(none.hidden, true);
});

test("Escape in a picker closes it and hands focus back to its button", async () => {
  const harness = load();
  const shadow = linkPanel(harness);
  await chooseLiveTable(harness, shadow, "u_example_link");
  await settle();
  q(shadow, ".columns-button").fire("click");
  assert.strictEqual(harness.dom.document.activeElement, q(shadow, ".column-menu .picker-find"));
  harness.dom.window.fire("keydown", { key: "Escape" });
  assert.strictEqual(q(shadow, ".column-menu").hidden, true);
  assert.strictEqual(harness.dom.document.activeElement, q(shadow, ".columns-button"));
  assert.strictEqual(harness.ui.isOpen(), true, "the first Escape closes the list, not the panel");
});

test("a starred table's columns come back in order and are saved when changed", async () => {
  const harness = load();
  const favorites = [{ name: "u_example_link", label: "Example link", fields: [], columns: ["u_active", "u_company"] }];
  const worker = favoriteWorker(favorites);
  const resolveCalls = [];
  const shadow = linkPanel(harness, {
    favorites,
    onFavoriteOp: worker.op,
    onResolveTable: async (name, opts) => {
      resolveCalls.push(JSON.parse(JSON.stringify(opts)));
      return linkInfo(name, { rememberedColumns: {
        requested: ["u_active", "u_company"], verified: ["u_active", "u_company"], absent: [], unverifiable: [],
      } });
    },
  });
  options(shadow)[0].fire("click");
  await settle();
  assert.deepStrictEqual(resolveCalls, [{ rememberedFields: [], rememberedColumns: ["u_active", "u_company"] }]);
  assert.deepStrictEqual(shownOrder(shadow), [["u_active", "1"], ["u_company", "2"]]);
  assert.match(status(shadow), /showing 2 columns · its remembered columns/);
  assert.deepStrictEqual(worker.calls, [], "selecting a favourite writes nothing");

  toggleColumn(shadow, "u_currency");
  await settle();
  assert.deepStrictEqual(worker.calls, [
    { op: "columns", name: "u_example_link", columns: ["u_active", "u_company", "u_currency"] },
  ]);
  assert.strictEqual(status(shadow), "Saved as this favourite's columns");
});

test("a remembered column that is gone is named; ones that could not be verified are never saved over", async () => {
  const favorites = [{ name: "u_example_link", label: "Example link", fields: [], columns: ["u_active", "u_gone"] }];
  const opened = async (rememberedColumns) => {
    const harness = load();
    const worker = favoriteWorker(favorites);
    const shadow = linkPanel(harness, {
      favorites,
      onFavoriteOp: worker.op,
      onResolveTable: async (name) => linkInfo(name, { rememberedColumns }),
    });
    options(shadow)[0].fire("click");
    await settle();
    return { shadow, worker };
  };
  const gone = await opened({ requested: ["u_active", "u_gone"], verified: ["u_active"], absent: ["u_gone"], unverifiable: [] });
  assert.match(status(gone.shadow), /columns no longer on this table: u_gone \(dropped when its columns are next saved\)/);
  assert.strictEqual(q(gone.shadow, ".status").className, "status validation");
  assert.deepStrictEqual(shownOrder(gone.shadow), [["u_active", "1"]]);

  const unsure = await opened({ requested: ["u_active", "u_gone"], verified: [], absent: [], unverifiable: ["u_active", "u_gone"] });
  assert.match(status(unsure.shadow), /remembered columns could not be verified right now, so the searched fields are shown/);
  assert.deepStrictEqual(shownOrder(unsure.shadow), [["u_company", "1"], ["u_supplier", "2"]]);
  toggleColumn(unsure.shadow, "u_currency");
  await settle();
  assert.deepStrictEqual(unsure.worker.calls, [], "a passing failure is never saved as a loss");
  assert.match(status(unsure.shadow), /Not saved: this favourite's columns could not be verified/);
});

test("a row marks a match found in a field it does not show", async () => {
  const harness = load();
  const shadow = linkPanel(harness, {
    onSearch: async () => ({ stale: false, table: "u_example_link", tableLabel: "Example link", results: [{
      table: "u_example_link",
      sysId: RESULT_SYS_ID,
      title: "FR01",
      values: [
        { field: "u_company", label: "Company", value: "FR01" },
        { field: "u_active", label: "Active", value: "true" },
        { field: "u_supplier", label: "Supplier", value: "Acme Ltd", matched: true },
      ],
    }] }),
  });
  await chooseLiveTable(harness, shadow, "u_example_link");
  await settle();
  termInput(shadow).value = "acme";
  q(shadow, ".form").fire("submit");
  await settle();
  assert.deepStrictEqual(resultTitles(shadow), ["FR01"]);
  const values = shadow.querySelectorAll(".row .value");
  assert.deepStrictEqual(values.map((node) => [node.className, node.textContent]), [
    ["value", "Active: true"],
    ["value matched", "Supplier: Acme Ltd match"],
  ], "the tag is its own word when read aloud");
  assert.strictEqual(values[1].title, "Matched your text. Not one of the shown columns.");
});

test("a column's position is its own word when read aloud", async () => {
  const harness = load();
  const shadow = linkPanel(harness);
  await chooseLiveTable(harness, shadow, "u_example_link");
  await settle();
  const company = shadow.querySelectorAll(".column-option")
    .find((option) => option.querySelector("input").dataset.column === "u_company");
  assert.match(company.textContent, /^1 Company/);
});

test("a table that opens with nothing to search says Show follows what is searched", async () => {
  const harness = load();
  const shadow = linkPanel(harness, {
    onResolveTable: async (name) => linkInfo(name, { defaultFields: [] }),
  });
  await chooseLiveTable(harness, shadow, "u_example_link");
  await settle();
  assert.strictEqual(q(shadow, ".fields-button").textContent, "Search 0 fields");
  assert.strictEqual(q(shadow, ".columns-button").textContent, "Show 0 columns");
  toggleField(shadow, "u_currency");
  assert.strictEqual(q(shadow, ".columns-button").textContent, "Show searched fields",
    "not zero: an empty Show list shows what is searched");
  assert.match(q(shadow, ".field-summary").textContent, / · Showing: the searched fields$/);
  toggleColumn(shadow, "u_active");
  assert.strictEqual(q(shadow, ".columns-button").textContent, "Show 1 column");
});

test("the Search list follows the engine's rule: a shown-only kind is never offered", async () => {
  const harness = load();
  const shadow = linkPanel(harness, {
    onResolveTable: async (name) => {
      const info = linkInfo(name);
      /* A field object whose kind says shown-only but which carries no flag. */
      info.fields.push({ name: "u_opened", label: "Opened", kind: "other", display: false, autoSelectable: true });
      return info;
    },
  });
  await chooseLiveTable(harness, shadow, "u_example_link");
  await settle();
  assert.ok(!shadow.querySelectorAll(".field-option input").some((input) => input.dataset.field === "u_opened"));
  assert.ok(shadow.querySelectorAll(".column-option input").some((input) => input.dataset.column === "u_opened"));
});

test("opening one picker closes the other, and Escape or a click elsewhere closes both", async () => {
  const harness = load();
  const shadow = linkPanel(harness);
  await chooseLiveTable(harness, shadow, "u_example_link");
  await settle();
  const fieldMenu = q(shadow, ".field-menu");
  const columnMenu = q(shadow, ".column-menu");
  q(shadow, ".fields-button").fire("click");
  assert.deepStrictEqual([fieldMenu.hidden, columnMenu.hidden], [false, true]);
  q(shadow, ".columns-button").fire("click");
  assert.deepStrictEqual([fieldMenu.hidden, columnMenu.hidden], [true, false]);
  assert.strictEqual(q(shadow, ".columns-button").getAttribute("aria-expanded"), "true");

  shadow.fire("click", { target: q(shadow, ".column-option") });
  assert.strictEqual(columnMenu.hidden, false, "a click inside its own list keeps it open");
  shadow.fire("click", { target: q(shadow, ".status") });
  assert.strictEqual(columnMenu.hidden, true);

  q(shadow, ".columns-button").fire("click");
  harness.dom.window.fire("keydown", { key: "Escape" });
  assert.strictEqual(columnMenu.hidden, true);
  assert.strictEqual(harness.ui.isOpen(), true, "Escape closed the list, not the panel");
});

test("focus a search took goes back to the picker that had it, without reopening its list", async () => {
  const harness = load();
  const shadow = await openOnTable(harness);
  await addRow(shadow);
  await pick(shadow, "snh-rs-filter-1-field", "State");
  const value = byId(shadow, "snh-rs-filter-1-value");
  assert.strictEqual(harness.dom.document.activeElement, value);
  key(value, "Enter");
  await settle();
  assert.strictEqual(value.disabled, false);
  assert.strictEqual(harness.dom.document.activeElement, value);
  assert.strictEqual(byId(shadow, "snh-rs-filter-1-value-menu").hidden, true);
});

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
      this.children.forEach((child) => { child.parentNode = null; });
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
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
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
      this.focused += 1;
      activeElement = this;
      (this.handlers.focus || []).slice().forEach((handler) => handler({ target: this }));
    }
    scrollIntoView() {}
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
  assert.match(note, /starred tables and their fields are kept on this device/);
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
    ["u_example_table", { rememberedFields: ["u_code"] }],
  ]);
  assert.strictEqual(q(shadow, ".fields-button").textContent, "1 field");
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

test("picking a field opens its values; a search sends only complete rows and names the rest", async () => {
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
  await pick(shadow, "snh-rs-filter-1-value", "In Progress");
  await addRow(shadow);

  q(shadow, ".form").fire("submit");
  await settle();
  assert.strictEqual(searches.length, 1);
  assert.strictEqual(searches[0].term, "");
  assert.deepStrictEqual(searches[0].filters, [{ field: "state", value: "2" }]);
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

/*
 * Tests for update_set_lens_ui.js, the Update Set Lens panel.
 *
 *   node --test tests/update_set_lens_ui.test.js
 *
 * DEV-ONLY, like its siblings. The panel runs under node:vm against the same
 * deliberately small DOM shim the Impersonate suite uses. The panel has no
 * innerHTML path at all, so the shim needs no parser, and a test that passes
 * here cannot be passing because markup was interpolated somewhere the shim
 * ignored.
 *
 * Synthetic data only.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const UI_SOURCE = fs.readFileSync(path.join(root, "update_set_lens_ui.js"), "utf8");
const HOST_ID = "sn-dev-helper-update-set-lens";
const ORIGIN = "https://example.service-now.com";
const plain = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ *
 * The DOM shim
 * ------------------------------------------------------------------ */

function createDom() {
  let activeElement = null;
  const documentElement = { tagName: "HTML" };

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = Object.create(null);
      this.handlers = Object.create(null);
      this.className = "";
      this.id = "";
      this.value = "";
      this.hidden = false;
      this.style = {};
      this.shadowRoot = null;
      this.focused = 0;
      this._text = "";
    }
    get disabled() { return Boolean(this._disabled); }
    set disabled(value) {
      this._disabled = Boolean(value);
      if (this._disabled && activeElement === this) activeElement = null;
    }
    get isConnected() {
      let node = this;
      while (node) {
        if (node === dom.document.documentElement) return true;
        node = node.parentNode || node.host || null;
      }
      return false;
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
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }
    addEventListener(type, handler) {
      (this.handlers[type] = this.handlers[type] || []).push(handler);
    }
    attachShadow() {
      const shadow = new El("#shadow");
      shadow.host = this;
      this.shadowRoot = shadow;
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
      /* As in Chrome: a detached node takes no focus. */
      if (!this.isConnected) return;
      this.focused += 1;
      activeElement = this;
    }
    fire(type, event) {
      const handlers = this.handlers[type] || [];
      const payload = Object.assign({
        target: this,
        preventDefault() { payload.defaultPrevented = true; },
        stopPropagation() { payload.propagationStopped = true; },
      }, event || {});
      handlers.forEach((handler) => handler(payload));
      return payload;
    }
    click() { return this.fire("click"); }
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

  const windowHandlers = Object.create(null);
  const dom = {
    El,
    document: {
      createElement: (tag) => new El(tag),
      createTextNode: (value) => new TextNode(value),
      documentElement: null,
      get activeElement() { return activeElement; },
    },
    window: {
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
    },
  };
  dom.document.documentElement = new El("html");
  void documentElement;
  return dom;
}

function walk(node, visit) {
  (node.children || []).forEach((child) => {
    visit(child);
    walk(child, visit);
  });
}

function findAll(node, predicate) {
  const out = [];
  walk(node, (child) => { if (predicate(child)) out.push(child); });
  return out;
}

const hasClass = (node, name) => String(node.className || "").split(/\s+/).includes(name);
const byClass = (node, name) => findAll(node, (child) => hasClass(child, name));
const buttons = (node, label) => findAll(node, (child) => child.tagName === "BUTTON" && child.textContent === label);
const buttonsStarting = (node, prefix) =>
  findAll(node, (child) => child.tagName === "BUTTON" && child.textContent.startsWith(prefix));

function load() {
  const dom = createDom();
  const timers = [];
  const sandbox = {
    document: dom.document,
    window: dom.window,
    location: { origin: ORIGIN },
    URL,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cancelled: false });
      return timers.length;
    },
    clearTimeout: (handle) => { if (timers[handle - 1]) timers[handle - 1].cancelled = true; },
    Promise,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(UI_SOURCE, sandbox, { filename: "update_set_lens_ui.js" });
  return {
    ui: sandbox.SNUpdateSetLensUI,
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
    text() {
      const shadow = this.shadow();
      return shadow ? shadow.textContent : "";
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

let counter = 0;
function row(verdict, extra) {
  counter += 1;
  return Object.assign({
    key: "k" + counter,
    sysId: String(counter).padStart(32, "0"),
    name: "sys_script_include_" + String(counter).padStart(32, "0"),
    type: "Script Include",
    target: "Utility " + counter,
    action: "Update",
    setId: "1".padStart(32, "0"),
    verdict,
    reason: "",
    text: verdict === "stale" ? "Newer version in “Next release”" : verdict === "cant" ? "Can't tell: Couldn't read versions." : "This set's version is the one that runs here.",
    flags: verdict === "stale" ? [{ label: "In progress", kind: "progress" }] : [],
    who: verdict === "stale" ? "Version by dev.two at 21 Oct 2026" : "",
    notes: [],
    links: [
      { label: "Open update", url: ORIGIN + "/sys_update_xml.do?sys_id=" + String(counter).padStart(32, "0") },
      { label: "Version history", url: ORIGIN + "/sys_update_version_list.do?sysparm_query=x" },
    ],
    asRetrieved: false,
    childSet: "",
    newerSetId: verdict === "stale" ? "2".padStart(32, "0") : "",
    newerSetName: verdict === "stale" ? "Next release" : "",
    newerSetState: verdict === "stale" ? "In progress" : "",
  }, extra);
}

function view(rows, extra) {
  return Object.assign({
    phase: "done",
    busy: false,
    error: "",
    progress: "",
    retrieved: null,
    subject: {
      sysId: "1".padStart(32, "0"), name: "Approval fix", stateLabel: "Complete", scope: "Global",
      createdBy: "dev.one", createdOn: "18 Oct 2026", isDefault: false, parentName: "", ownTotal: rows.length,
    },
    banners: [],
    batch: null,
    rows,
    totals: { checked: rows.length, total: rows.length, exact: true },
    canContinue: false,
  }, extra);
}

function open(harness, theView, callbacks, extra) {
  harness.ui.open(Object.assign({ view: theView, origins: [], callbacks: callbacks || {} }, extra || {}));
  return harness.shadow();
}

const visibleRows = (shadow) => byClass(shadow, "row");
/* What opens and folds a row: its head, never the whole row. */
const headOf = (node) => byClass(node, "row-head")[0];
/* An opened row's card for the instance checked. */
const thereCards = (node) => byClass(node, "side").filter((card) => /checked instance$/.test(card.getAttribute("aria-label") || ""));
const factsOf = (node) => byClass(node, "facts")[0].children.map((child) => child.textContent);
const chip = (shadow, label) => findAll(shadow, (node) => hasClass(node, "chip") && node.textContent.startsWith(label + " "))[0];

/* ------------------------------------------------------------------ *
 * Shell and safety
 * ------------------------------------------------------------------ */

test("the panel opens into a closed shadow root, headed Update Set Lens, with no markup path", () => {
  const harness = load();
  let mode = null;
  const realAttach = harness.dom.El.prototype.attachShadow;
  harness.dom.El.prototype.attachShadow = function (init) {
    mode = init && init.mode;
    return realAttach.call(this, init);
  };
  const shadow = open(harness, view([]));
  assert.strictEqual(mode, "closed");
  assert.ok(shadow);
  assert.strictEqual(findAll(shadow, (node) => node.tagName === "H2")[0].textContent, "Update Set Lens");
  assert.doesNotMatch(UI_SOURCE, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.strictEqual(harness.ui.isOpen(), true);
});

test("hostile names and set names render as text", () => {
  const harness = load();
  const hostile = "<img src=x onerror=alert(1)>";
  const shadow = open(harness, view([row("stale", { target: hostile, newerSetName: hostile, text: "Newer version in “" + hostile + "”" })],
    { subject: { name: hostile, stateLabel: "Complete" } }));
  assert.ok(harness.text().includes(hostile));
  assert.strictEqual(findAll(shadow, (node) => node.tagName === "IMG").length, 0);
});

/* ------------------------------------------------------------------ *
 * Filters, counts and paging (U2, U3)
 * ------------------------------------------------------------------ */

test("it opens on Needs attention, the badges count every row, and a badge filters to its rows", () => {
  const harness = load();
  const rows = [row("current"), row("stale"), row("same"), row("cant"), row("current")];
  const shadow = open(harness, view(rows));
  assert.strictEqual(visibleRows(shadow).length, 2, "Stale and Can't tell only");
  assert.strictEqual(chip(shadow, "Needs attention").getAttribute("aria-pressed"), "true");
  const badges = byClass(shadow, "sum-badge").map((node) => node.textContent);
  assert.deepStrictEqual(badges, ["1 stale", "1 can't tell", "1 same content", "2 current"]);
  /* Stale sorts first, then Can't tell. */
  assert.deepStrictEqual(visibleRows(shadow).map((node) => byClass(node, "badge")[0].textContent), ["STALE", "CAN'T TELL"]);
  byClass(shadow, "sum-badge").find((node) => node.textContent === "2 current").click();
  assert.strictEqual(visibleRows(shadow).length, 2);
  assert.ok(visibleRows(shadow).every((node) => byClass(node, "badge")[0].textContent === "CURRENT"));
  assert.strictEqual(chip(shadow, "Current").getAttribute("aria-pressed"), "true");
  chip(shadow, "All").click();
  assert.strictEqual(visibleRows(shadow).length, 5);
});

test("with nothing needing attention it opens on All, and a zero badge is dimmed", () => {
  const harness = load();
  const shadow = open(harness, view([row("current"), row("same")]));
  assert.strictEqual(visibleRows(shadow).length, 2);
  assert.strictEqual(chip(shadow, "All").getAttribute("aria-pressed"), "true");
  assert.ok(hasClass(byClass(shadow, "sum-badge")[0], "zero"));
});

test("rows are drawn 100 at a time, and the filters count every checked row", () => {
  const harness = load();
  const rows = Array.from({ length: 250 }, (_, index) => row(index < 230 ? "stale" : "current"));
  const shadow = open(harness, view(rows));
  assert.strictEqual(visibleRows(shadow).length, 100);
  assert.strictEqual(chip(shadow, "Stale").textContent, "Stale 230");
  const more = buttonsStarting(shadow, "Show 100 more")[0];
  assert.strictEqual(more.textContent, "Show 100 more (130 left)");
  more.click();
  assert.strictEqual(visibleRows(shadow).length, 200);
  buttonsStarting(shadow, "Show 30 more")[0].click();
  assert.strictEqual(visibleRows(shadow).length, 230);
});

/* ------------------------------------------------------------------ *
 * Rows (U4, U6) and links
 * ------------------------------------------------------------------ */

test("Stale and Can't tell show their details; other rows are one line and open on click or Enter", () => {
  const harness = load();
  const stale = row("stale");
  const current = row("current", { notes: ["later save in this set"] });
  const shadow = open(harness, view([stale, current]));
  chip(shadow, "All").click();
  const [staleNode, currentNode] = visibleRows(shadow);
  assert.ok(staleNode.textContent.includes("Newer version in “Next release”"));
  assert.ok(staleNode.textContent.includes("Version by dev.two at 21 Oct 2026"));
  assert.ok(staleNode.textContent.includes("In progress"));
  assert.strictEqual(byClass(staleNode, "b-stale").length, 1, "a coloured badge with its word");
  assert.ok(!currentNode.textContent.includes("later save in this set"));
  assert.strictEqual(headOf(currentNode).getAttribute("aria-expanded"), "false");
  assert.strictEqual(headOf(currentNode).getAttribute("role"), "button");
  assert.strictEqual(headOf(staleNode).getAttribute("role"), null, "a row that is always open is no button");
  headOf(currentNode).click();
  const opened = visibleRows(shadow)[1];
  assert.ok(opened.textContent.includes("later save in this set"));
  assert.strictEqual(headOf(opened).getAttribute("aria-expanded"), "true");
  /* The cards are the head's sibling, which it names as what it controls. */
  const detail = byClass(opened, "r-detail")[0];
  assert.strictEqual(detail.parentNode, opened);
  assert.strictEqual(headOf(opened).getAttribute("aria-controls"), detail.id);
  assert.ok(detail.id);
  assert.strictEqual(byClass(headOf(opened), "side").length + byClass(headOf(opened), "link").length, 0,
    "no card or link inside the button");
  opened.click();
  assert.strictEqual(headOf(visibleRows(shadow)[1]).getAttribute("aria-expanded"), "true", "a click on the cards folds nothing");
  headOf(opened).fire("keydown", { key: "Enter" });
  assert.ok(!visibleRows(shadow)[1].textContent.includes("later save in this set"));
});

test("a link opens only a same-origin URL, through the callback", () => {
  const harness = load();
  const opened = [];
  const shadow = open(harness, view([row("stale", {
    links: [
      { label: "Open update", url: ORIGIN + "/sys_update_xml.do?sys_id=1" },
      { label: "Elsewhere", url: "https://elsewhere.service-now.com/sys_update_xml.do?sys_id=1" },
      { label: "Script", url: "javascript:alert(1)" },
    ],
  })]), { onOpenUrl: (url) => opened.push(url) });
  buttons(shadow, "Open update")[0].click();
  buttons(shadow, "Elsewhere")[0].click();
  buttons(shadow, "Script")[0].click();
  assert.deepStrictEqual(opened, [ORIGIN + "/sys_update_xml.do?sys_id=1"]);
});

test("a middle-click or Ctrl-click opens a link's page behind this tab; a middle press never starts autoscroll", async () => {
  const harness = load();
  const there = "https://exampletest.service-now.com";
  const record = "sys_script_include_" + "7".padStart(32, "0");
  const calls = [];
  const stale = row("stale", { links: [
    { label: "Open update", url: ORIGIN + "/sys_update_xml.do?sys_id=1" },
    { label: "Open record", record },
  ] });
  const shadow = open(harness, view([stale]), {
    onOpenUrl: (url, opts) => calls.push(["url", plain(opts)]),
    onOpenRecord: (name, opts) => { calls.push(["record", plain(opts)]); return Promise.resolve({ ok: true }); },
    onOpenRemote: (target, opts) => { calls.push(["remote", plain(opts)]); return Promise.resolve({ ok: true }); },
    onOpenVersionLens: () => { calls.push(["lens"]); return Promise.resolve({ ok: true }); },
    onCheckRemote: () => {},
  }, { origins: [{ origin: there, label: "exampletest" }] });
  const link = (label) => buttons(harness.shadow(), label)[0];
  link("Open update").click();
  link("Open update").fire("click", { ctrlKey: true });
  link("Open update").fire("click", { metaKey: true });
  assert.ok(link("Open update").fire("auxclick", { button: 1 }).defaultPrevented);
  link("Open update").fire("auxclick", { button: 2 });
  assert.ok(link("Open update").fire("mousedown", { button: 1 }).defaultPrevented, "no autoscroll from a middle press");
  assert.ok(!link("Open update").fire("mousedown", { button: 0 }).defaultPrevented, "a left press is left alone");
  link("Open record").fire("auxclick", { button: 1 });
  link("Other sets holding it").fire("auxclick", { button: 1 });
  assert.deepStrictEqual(calls, [
    ["url", { background: false }],
    ["url", { background: true }],
    ["url", { background: true }],
    ["url", { background: true }],
    ["record", { background: true }],
  ], "a right-click opens nothing; Other sets holding it replaces the panel, so a middle-click leaves it alone");

  buttons(shadow, "Check")[0].click();
  harness.ui.showRemote({
    state: "done", lines: [], perRow: {}, parts: {}, counts: {},
    links: { [stale.key]: [{ label: "Open version", remote: { origin: there, table: "sys_update_version", sysId: "8".padStart(32, "0") } }] },
  }, 1);
  calls.length = 0;
  link("Open version").fire("auxclick", { button: 1 });
  link("Open version").click();
  link("Other sets holding it").fire("click", { ctrlKey: true });
  await flush();
  assert.deepStrictEqual(calls, [["remote", { background: true }], ["remote", { background: false }], ["lens"]],
    "a link there too; a Ctrl-click on a panel link just follows it");
});

test("a batch row names its child set, and a retrieved-only row says so: beside its name when closed, in its card when open", () => {
  const harness = load();
  const shadow = open(harness, view([
    row("stale", { childSet: "Child A", asRetrieved: true }),
    row("current", { childSet: "Child B", asRetrieved: true }),
  ]));
  chip(shadow, "All").click();
  const [opened, closed] = visibleRows(shadow);
  assert.strictEqual(byClass(opened, "r-sub").length, 0, "opened, the set moves into the card");
  assert.deepStrictEqual(factsOf(opened), ["Set", "Child A", "Read from", "the retrieved copy"]);
  assert.strictEqual(byClass(closed, "r-sub")[0].textContent, "in Child B · as retrieved");
});

/* ------------------------------------------------------------------ *
 * Progressive fill, late results, closing
 * ------------------------------------------------------------------ */

test("a new snapshot keeps the filter, the open rows and the focus", () => {
  const harness = load();
  const first = [row("current"), row("stale")];
  const shadow = open(harness, view(first, { busy: true, phase: "running", progress: "Checking versions… 2 read" }));
  chip(shadow, "Current").click();
  headOf(visibleRows(shadow)[0]).click();
  assert.strictEqual(headOf(visibleRows(shadow)[0]).getAttribute("aria-expanded"), "true");
  chip(shadow, "Current").focus();
  harness.ui.update(view(first.concat([row("current"), row("current")]), { busy: true, phase: "running" }));
  assert.strictEqual(visibleRows(shadow).length, 3, "still filtered to Current");
  assert.deepStrictEqual(visibleRows(shadow).map((node) => headOf(node).getAttribute("aria-expanded")), ["true", "false", "false"],
    "the row that was open is still open, and only it");
  const focused = shadow.activeElement;
  assert.ok(focused && focused.textContent === "Current 3", "focus is on the redrawn chip");
});

test("Enter or Space on a link inside an open row is the link's: the row stays open", () => {
  const harness = load();
  const current = row("current");
  const shadow = open(harness, view([current]));
  headOf(visibleRows(shadow)[0]).fire("keydown", { key: "Enter" });
  const opened = visibleRows(shadow)[0];
  assert.strictEqual(headOf(opened).getAttribute("aria-expanded"), "true");
  const link = buttons(opened, "Open update")[0];
  for (const key of ["Enter", " "]) {
    /* The link sits outside the head; were a key on it to reach the head,
     * it is still the link's. */
    const event = headOf(visibleRows(shadow)[0]).fire("keydown", { key, target: link });
    assert.ok(!event.defaultPrevented, "the link's own click is not cancelled");
    assert.strictEqual(headOf(visibleRows(shadow)[0]).getAttribute("aria-expanded"), "true", JSON.stringify(key) + " keeps the row open");
  }
  headOf(visibleRows(shadow)[0]).fire("keydown", { key: " " });
  assert.strictEqual(headOf(visibleRows(shadow)[0]).getAttribute("aria-expanded"), "false", "on the head itself it still folds");
});

test("the progress line is polite and reads Checked N of up to M until exact", () => {
  const harness = load();
  const shadow = open(harness, view([row("current")], { totals: { checked: 1, total: 40, exact: false } }));
  const progress = byClass(shadow, "progress")[0];
  assert.strictEqual(progress.getAttribute("aria-live"), "polite");
  assert.strictEqual(progress.textContent, "Checked 1 of up to 40.");
  harness.ui.update(view([row("current")], { totals: { checked: 1, total: null, exact: false } }));
  assert.strictEqual(byClass(harness.shadow(), "progress")[0].textContent, "Checked 1.");
});

test("a finished run with nothing to look at says so, with a tick that screen readers skip", () => {
  const harness = load();
  const shadow = open(harness, view([row("current"), row("same"), row("current")]));
  const progress = byClass(shadow, "progress")[0];
  assert.strictEqual(progress.textContent, "✓Checked 3 of 3. Nothing needs attention before promoting.");
  assert.strictEqual(byClass(progress, "ok").length, 1);
  assert.strictEqual(byClass(progress, "mark")[0].getAttribute("aria-hidden"), "true");
  const line = (theView) => {
    harness.ui.update(theView);
    return byClass(harness.shadow(), "progress")[0];
  };
  const warn = { kind: "warn", text: "The update count and the updates read disagree; the list may be incomplete.", links: [] };
  for (const [why, theView] of [
    ["a stale row", view([row("current"), row("stale")])],
    ["a can't tell row", view([row("cant")])],
    ["more to check", view([row("current")], { totals: { checked: 1, total: 40, exact: false }, canContinue: true })],
    ["a warning banner", view([row("current")], { banners: [warn] })],
    ["no rows", view([])],
    ["still running", view([row("current")], { phase: "classifying" })],
  ]) {
    assert.strictEqual(byClass(line(theView), "ok").length, 0, why);
  }
  const info = { kind: "info", text: "Committed here from a retrieved set (a loaded XML file).", links: [] };
  assert.strictEqual(byClass(line(view([row("current")], { banners: [info] })), "ok").length, 1, "an info banner doesn't stop it");
});

test("Escape closes the panel, calls onClose, restores focus, and a late snapshot paints nothing", () => {
  const harness = load();
  const opener = harness.dom.document.createElement("button");
  harness.dom.document.documentElement.appendChild(opener);
  let closed = 0;
  open(harness, view([row("current")]), { onClose: () => { closed += 1; } }, { opener });
  harness.dom.window.fire("keydown", { key: "Escape" });
  assert.strictEqual(harness.ui.isOpen(), false);
  assert.strictEqual(closed, 1);
  assert.strictEqual(opener.focused, 1);
  harness.ui.update(view([row("stale")]));
  harness.ui.showRemote({ state: "done", lines: [] }, 1);
  assert.strictEqual(harness.shadow(), null);
});

test("Tab stays inside the panel", () => {
  const harness = load();
  const shadow = open(harness, view([row("current")]));
  const event = harness.dom.window.fire("keydown", { key: "Tab", shiftKey: true });
  assert.ok(event.defaultPrevented);
  assert.ok(shadow.activeElement, "focus moved to a control inside");
});

/* ------------------------------------------------------------------ *
 * Check on another instance (U5, U7)
 * ------------------------------------------------------------------ */

test("Check on is hidden, with the hint, until another instance is open", () => {
  const harness = load();
  const shadow = open(harness, view([row("current")]));
  const select = findAll(shadow, (node) => node.tagName === "SELECT")[0];
  assert.strictEqual(byClass(shadow, "check-row")[0].hidden, true);
  assert.ok(harness.text().includes("To check another instance, open it in a tab and sign in, then reopen Update Set Lens."));
  harness.ui.setOrigins([{ origin: "https://exampletest.service-now.com", label: "exampletest" }]);
  assert.strictEqual(byClass(shadow, "check-row")[0].hidden, false);
  assert.strictEqual(select.children.length, 1);
  assert.strictEqual(select.value, "https://exampletest.service-now.com");
});

test("a check shows the other instance's answer, and on a row only where it differs", () => {
  const harness = load();
  const asked = [];
  const stale = row("stale");
  const current = row("current");
  const other = row("current");
  const shadow = open(harness, view([stale, current, other]), {
    onCheckRemote: (origin, token) => asked.push({ origin, token }),
  }, { origins: [{ origin: "https://exampletest.service-now.com", label: "exampletest" }] });
  buttons(shadow, "Check")[0].click();
  assert.deepStrictEqual(asked, [{ origin: "https://exampletest.service-now.com", token: 1 }]);
  assert.strictEqual(buttons(shadow, "Check")[0].disabled, true, "one check at a time");
  harness.ui.showRemote({ state: "busy", message: "Comparing versions… 1 read" }, 1);
  assert.ok(harness.text().includes("Comparing versions… 1 read"));
  harness.ui.showRemote({
    state: "done",
    lines: [{ kind: "state", text: "Previewed, not committed on exampletest." }],
    perRow: { [stale.key]: { kind: "other", text: "On exampletest: runs another version (already stale here)" } },
    parts: {
      [stale.key]: { kind: "other", say: "Runs another version", notes: ["already stale here"], saved: null, then: "" },
      [current.key]: { kind: "runs", say: "Runs this set's version", notes: [], saved: null, then: "" },
      [other.key]: { kind: "runs", say: "Runs this set's version", notes: [], saved: null, then: "" },
    },
    counts: { runs: 2, same: 0, other: 1, otherStale: 1, none: 0, cant: 0 },
  }, 1);
  assert.ok(harness.text().includes("Previewed, not committed on exampletest."));
  /* The Stale row is open, so its card says it. */
  const cards = thereCards(shadow);
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].getAttribute("aria-label"), "exampletest, checked instance");
  assert.strictEqual(byClass(cards[0], "say")[0].textContent, "Runs another version. (already stale here)");
  assert.ok(hasClass(cards[0], "t-amber"));
  assert.strictEqual(byClass(shadow, "remote-tag").length, 0, "an opened row has no one-line note");
  /* Progress that arrives after the answer never replaces it. */
  harness.ui.showRemote({ state: "busy", message: "late" }, 1);
  assert.ok(!harness.text().includes("late"));
});

test("a check where every record matches says so with a tick", () => {
  const harness = load();
  const shadow = open(harness, view([row("current")]), { onCheckRemote: () => {} },
    { origins: [{ origin: "https://exampletest.service-now.com", label: "exampletest" }] });
  buttons(shadow, "Check")[0].click();
  harness.ui.showRemote({
    state: "done",
    lines: [
      { kind: "state", text: "exampletest: committed on 30 Oct 2026." },
      { kind: "ok", text: "exampletest matches: it runs this set's version for its one record." },
    ],
    perRow: {},
    counts: { runs: 1, same: 0, other: 0, otherStale: 0, none: 0, cant: 0 },
  }, 1);
  const ok = byClass(byClass(shadow, "check-out")[0], "ok");
  assert.strictEqual(ok.length, 1);
  assert.strictEqual(ok[0].textContent, "✓exampletest matches: it runs this set's version for its one record.");
  assert.strictEqual(byClass(ok[0], "mark")[0].getAttribute("aria-hidden"), "true");
  assert.ok(!chip(shadow, "Differs on exampletest"), "nothing differs, so no chip");
});

test("where the other instance differs, the row says so in amber with its own badge, and a chip lists those rows", () => {
  const harness = load();
  const there = "https://exampletest.service-now.com";
  const other = row("current");
  const same = row("current");
  const none = row("current");
  const cant = row("current");
  const fine = row("current");
  const shadow = open(harness, view([other, same, none, cant, fine]), { onCheckRemote: () => {} },
    { origins: [{ origin: there, label: "exampletest" }] });
  buttons(shadow, "Check")[0].click();
  const summary = "exampletest runs this set's version for 1 of 5 records; 1 has the same content under another update; " +
    "1 runs another version; 1 has no readable current version there; 1 can't tell.";
  harness.ui.showRemote({
    state: "done",
    lines: [{ kind: "differs", text: summary }],
    perRow: {
      [other.key]: { kind: "other", text: "On exampletest: runs another version" },
      [same.key]: { kind: "same", text: "On exampletest: same content under another update" },
      [none.key]: { kind: "none", text: "On exampletest: no readable current version" },
      [cant.key]: { kind: "cant", text: "On exampletest: can't tell" },
    },
    counts: { runs: 1, same: 1, other: 1, otherStale: 0, none: 1, cant: 1 },
  }, 1);
  const line = byClass(byClass(shadow, "check-out")[0], "differs")[0];
  assert.strictEqual(line.textContent, "≠" + summary);
  assert.strictEqual(byClass(line, "mark")[0].getAttribute("aria-hidden"), "true");

  const rowFor = (fixture) => visibleRows(harness.shadow()).find((node) => byClass(node, "r-name")[0].textContent === fixture.target);
  const badges = (fixture) => byClass(rowFor(fixture), "badge").map((badge) => badge.textContent);
  assert.deepStrictEqual(badges(other), ["CURRENT", "OTHER VERSION THERE"]);
  assert.deepStrictEqual(badges(same), ["CURRENT", "SAME CONTENT THERE"]);
  assert.deepStrictEqual(badges(none), ["CURRENT", "NO CURRENT VERSION THERE"]);
  assert.deepStrictEqual(badges(cant), ["CURRENT", "CAN'T TELL THERE"]);
  assert.deepStrictEqual(badges(fine), ["CURRENT"], "a row that matches there gets no second badge");
  const thereBadge = (fixture) => byClass(rowFor(fixture), "b-there")[0];
  assert.strictEqual(thereBadge(other).title, "On exampletest: runs another version");
  assert.ok(!hasClass(thereBadge(other), "same"), "amber");
  assert.ok(hasClass(thereBadge(same), "same"), "grey: the content matches");
  assert.ok(hasClass(byClass(rowFor(other), "remote-tag")[0], "warn"));
  assert.ok(!hasClass(byClass(rowFor(same), "remote-tag")[0], "warn"));

  const labels = byClass(shadow, "chip").map((node) => node.textContent);
  assert.deepStrictEqual(labels.slice(-2), ["Differs on exampletest 4", "All 5"], "just before All");
  assert.ok(hasClass(chip(shadow, "Differs on exampletest"), "there"));
  chip(shadow, "Differs on exampletest").click();
  assert.strictEqual(visibleRows(harness.shadow()).length, 4);
  assert.ok(!rowFor(fine));

  /* A new check drops the answer, so its filter lapses with it. */
  buttons(harness.shadow(), "Check")[0].click();
  assert.strictEqual(visibleRows(harness.shadow()).length, 5);
  assert.ok(!chip(harness.shadow(), "Differs on exampletest"));
  assert.strictEqual(chip(harness.shadow(), "All").getAttribute("aria-pressed"), "true");
});

test("placed in its history: the version it was built on and an earlier save are teal, older, diverged and changed since amber", async () => {
  const harness = load();
  const there = "https://exampletest.service-now.com";
  const built = row("current");
  const earlier = row("current");
  const behind = row("current");
  const diverged = row("current");
  const moved = row("current");
  const copied = [];
  const shadow = open(harness, view([built, earlier, behind, diverged, moved]), {
    onCheckRemote: () => {},
    onCopy: async (text) => { copied.push(text); return true; },
  }, { origins: [{ origin: there, label: "exampletest" }] });
  buttons(shadow, "Check")[0].click();
  harness.ui.showRemote({
    state: "done",
    lines: [{ kind: "differs", text: "exampletest runs this set's version for 0 of 4 records." }],
    perRow: {
      [built.key]: { kind: "built", text: "On exampletest: runs the version this set was built on" },
      [earlier.key]: { kind: "earlier", text: "On exampletest: runs an earlier save of this set" },
      [behind.key]: { kind: "behind", text: "On exampletest: runs an older version of this update" },
      [diverged.key]: { kind: "diverged", text: "On exampletest: runs a version that isn't in this update's history" },
      [moved.key]: { kind: "moved", text: "On exampletest: had this set's version, and it has since been changed" },
    },
    counts: { runs: 0, same: 0, built: 1, earlier: 1, behind: 1, diverged: 1, moved: 1, other: 0, otherStale: 0, none: 0, cant: 0 },
  }, 1);
  const rowFor = (fixture) => visibleRows(harness.shadow()).find((node) => byClass(node, "r-name")[0].textContent === fixture.target);
  const badge = (fixture) => byClass(rowFor(fixture), "b-there")[0];
  const tag = (fixture) => byClass(rowFor(fixture), "remote-tag")[0];
  assert.strictEqual(badge(built).textContent, "PREVIOUS VERSION THERE");
  assert.strictEqual(badge(earlier).textContent, "EARLIER SAVE THERE");
  assert.strictEqual(badge(behind).textContent, "OLDER VERSION THERE");
  assert.strictEqual(badge(diverged).textContent, "DIVERGED THERE");
  assert.strictEqual(badge(moved).textContent, "CHANGED THERE SINCE");
  [built, earlier].forEach((fixture) => {
    assert.ok(hasClass(badge(fixture), "ok") && !hasClass(badge(fixture), "same"), "teal");
    assert.ok(hasClass(tag(fixture), "ok") && !hasClass(tag(fixture), "warn"));
  });
  [behind, diverged, moved].forEach((fixture) => {
    assert.ok(!hasClass(badge(fixture), "ok") && !hasClass(badge(fixture), "same"), "amber");
    assert.ok(hasClass(tag(fixture), "warn"));
  });
  buttons(shadow, "Copy summary")[0].click();
  await flush();
  assert.match(copied[0], /On the other instance: runs this set's version 0, same content 0, the version it was built on 1, an earlier save of it 1, an older version 1, a version not in its history 1, had this set's version, since changed 1, another version 0, no readable current version 0, can't tell 0\./);
});

test("a row its batch replaces, where the other instance runs another update of the batch, is grey", async () => {
  const harness = load();
  const there = "https://exampletest.service-now.com";
  const replaced = row("batch");
  const elsewhere = row("batch");
  const copied = [];
  const shadow = open(harness, view([replaced, elsewhere]), {
    onCheckRemote: () => {},
    onCopy: async (text) => { copied.push(text); return true; },
  }, { origins: [{ origin: there, label: "exampletest" }] });
  buttons(shadow, "Check")[0].click();
  harness.ui.showRemote({
    state: "done",
    lines: [{ kind: "differs", text: "exampletest runs this set's version for 0 of 2 records." }],
    perRow: {
      [replaced.key]: { kind: "inbatch", text: "On exampletest: runs this batch's newest update of it" },
      [elsewhere.key]: { kind: "other", text: "On exampletest: runs another version" },
    },
    counts: { runs: 0, same: 0, inBatch: 1, inBatchNewest: 1, built: 0, earlier: 0, behind: 0, diverged: 0, moved: 0, other: 1,
      otherStale: 0, none: 0, cant: 0 },
  }, 1);
  chip(shadow, "All").click();
  const rowFor = (fixture) => visibleRows(harness.shadow()).find((node) => byClass(node, "r-name")[0].textContent === fixture.target);
  const badge = (fixture) => byClass(rowFor(fixture), "b-there")[0];
  const tag = (fixture) => byClass(rowFor(fixture), "remote-tag")[0];
  assert.strictEqual(badge(replaced).textContent, "BATCH VERSION THERE");
  assert.ok(hasClass(badge(replaced), "same") && !hasClass(badge(replaced), "ok"), "grey");
  assert.ok(!hasClass(tag(replaced), "warn") && !hasClass(tag(replaced), "ok"));
  assert.strictEqual(badge(elsewhere).textContent, "OTHER VERSION THERE");
  assert.ok(hasClass(tag(elsewhere), "warn"));
  buttons(shadow, "Copy summary")[0].click();
  await flush();
  assert.match(copied[0], /On the other instance: runs this set's version 0, same content 0, another update of this batch 1, another version 1,/);
});

test("an opened row links to its record and, after a check, to the record, version and history there", async () => {
  const harness = load();
  const records = [];
  const remotes = [];
  const other = "https://exampletest.service-now.com";
  const stale = row("stale", {
    links: [
      { label: "Open update", url: ORIGIN + "/sys_update_xml.do?sys_id=1" },
      { label: "Open record", record: "sys_script_include_" + "7".padStart(32, "0") },
    ],
  });
  const current = row("current");
  const shadow = open(harness, view([stale, current]), {
    onCheckRemote: () => {},
    onOpenRecord: (name) => { records.push(name); return Promise.resolve({ ok: true }); },
    onOpenRemote: (target) => { remotes.push(target); return Promise.resolve({ ok: true }); },
  }, { origins: [{ origin: other, label: "exampletest" }] });
  chip(shadow, "All").click();
  buttons(shadow, "Open record")[0].click();
  assert.deepStrictEqual(records, ["sys_script_include_" + "7".padStart(32, "0")]);

  buttons(shadow, "Check")[0].click();
  harness.ui.showRemote({
    state: "done",
    lines: [],
    perRow: { [stale.key]: { kind: "other", text: "On exampletest: runs another version" } },
    counts: { runs: 1, same: 0, other: 1, otherStale: 1, none: 0, cant: 0 },
    links: {
      [stale.key]: [
        { label: "Open record", remote: { origin: other, table: "sys_script_include", sysId: "7".padStart(32, "0") } },
        { label: "Open version", remote: { origin: other, table: "sys_update_version", sysId: "8".padStart(32, "0") } },
        { label: "Version history", remote: { origin: other, name: "sys_script_include_" + "7".padStart(32, "0") } },
      ],
      [current.key]: [{ label: "Version history", remote: { origin: other, name: current.name } }],
    },
  }, 1);
  const staleNode = visibleRows(shadow)[0];
  const there = thereCards(staleNode);
  assert.strictEqual(there.length, 1);
  const thereLinks = byClass(there[0], "link");
  assert.deepStrictEqual(thereLinks.map((link) => link.textContent), ["Open record", "Open version", "Version history"],
    "that instance's links sit in its own card");
  thereLinks.find((child) => child.textContent === "Open version").click();
  assert.deepStrictEqual(plain(remotes), [{ origin: other, table: "sys_update_version", sysId: "8".padStart(32, "0") }]);
  remotes.length = 0;
  buttons(staleNode, "Open record")[1].click();
  assert.strictEqual(remotes.length, 1, "the second Open record is the one there");
  await flush();
  assert.strictEqual(byClass(shadow, "link-note").length, 0, "an open that worked says nothing");

  /* A closed row shows its links only once it is opened, like its own; one
   * that matches there says so in teal. */
  const closed = visibleRows(shadow)[1];
  assert.strictEqual(thereCards(closed).length, 0);
  headOf(closed).click();
  const matched = thereCards(visibleRows(shadow)[1]);
  assert.strictEqual(matched.length, 1);
  assert.strictEqual(byClass(matched[0], "say")[0].textContent, "Runs this set's version.");
  assert.ok(hasClass(matched[0], "t-teal"));
});

test("an opened row has a card for this instance and one for the instance checked, each named in bold and edged in its colour", () => {
  const harness = load();
  const there = "https://exampletest.service-now.com";
  const stale = row("stale", {
    explain: "Newer version in “Next release”",
    newerSave: { by: "dev.two", on: "21-10-2026 10:02:47", committedHere: false },
  });
  const cant = row("cant", { explain: "Couldn't read versions." });
  const shadow = open(harness, view([stale, cant]), { onCheckRemote: () => {} },
    { origins: [{ origin: there, label: "exampletest" }], here: "examplehere" });
  const [staleNode, cantNode] = visibleRows(shadow);
  /* Before a check: this instance's card alone, at reading width. */
  assert.strictEqual(byClass(staleNode, "side").length, 1);
  assert.ok(hasClass(byClass(staleNode, "sides")[0], "single"));
  const here = byClass(staleNode, "side")[0];
  assert.strictEqual(here.getAttribute("role"), "group");
  assert.strictEqual(here.getAttribute("aria-label"), "examplehere, this instance");
  assert.strictEqual(findAll(here, (node) => node.tagName === "B")[0].textContent, "examplehere");
  assert.strictEqual(byClass(here, "role")[0].textContent, "this instance");
  assert.ok(hasClass(here, "t-pink"));
  const verdict = byClass(here, "v")[0];
  assert.strictEqual(verdict.textContent, "Stale.");
  assert.ok(hasClass(verdict, "pink"));
  assert.ok(byClass(here, "say")[0].textContent.startsWith("Stale. Newer version in “Next release”"));
  assert.ok(byClass(here, "say")[0].textContent.includes("In progress"), "the newer set's flags follow");
  assert.deepStrictEqual(factsOf(here), ["Saved", "21-10-2026 10:02:47", "By", "dev.two"]);
  assert.ok(hasClass(byClass(here, "facts")[0].children[1], "time"));
  assert.ok(!here.textContent.includes("Version by dev.two"), "the facts replace the sentence");
  const cantCard = byClass(cantNode, "side")[0];
  assert.ok(hasClass(cantCard, "t-amber"));
  assert.strictEqual(byClass(cantCard, "say")[0].textContent, "Can't tell. Couldn't read versions.");

  buttons(shadow, "Check")[0].click();
  harness.ui.showRemote({
    state: "done",
    lines: [],
    perRow: {
      [stale.key]: { kind: "behind", text: "On exampletest: runs an older version of this update (matched by content)" },
      [cant.key]: { kind: "earlier", text: "On exampletest: runs an earlier save of this set" },
    },
    parts: {
      [stale.key]: {
        kind: "behind", say: "Runs an older version of this update", notes: ["matched by content"],
        saved: { on: "18-10-2025 10:23:56", set: "Earlier work", from: "" },
        then: "Missing the change saved here in “Earlier work”; promoting this set brings it too",
      },
      [cant.key]: { kind: "earlier", say: "Runs an earlier save of this set", notes: [], saved: { on: "", set: "", from: "an upgrade" }, then: "" },
    },
    counts: { runs: 0, same: 0, built: 0, earlier: 1, behind: 1, diverged: 0, moved: 0, other: 0, otherStale: 0, none: 0, cant: 0 },
    links: { [stale.key]: [{ label: "Version history", remote: { origin: there, name: stale.name } }] },
  }, 1);
  const behindRow = visibleRows(shadow)[0];
  assert.ok(!hasClass(byClass(behindRow, "sides")[0], "single"), "side by side once there is a second card");
  const behind = thereCards(behindRow)[0];
  assert.strictEqual(behind.getAttribute("aria-label"), "exampletest, checked instance");
  assert.strictEqual(findAll(behind, (node) => node.tagName === "B")[0].textContent, "exampletest");
  assert.ok(hasClass(behind, "t-amber"));
  assert.strictEqual(byClass(behind, "say")[0].textContent, "Runs an older version of this update. (matched by content)");
  assert.deepStrictEqual(factsOf(behind), ["Saved", "18-10-2025 10:23:56", "Set", "Earlier work"]);
  assert.strictEqual(byClass(behind, "then")[0].textContent,
    "Missing the change saved here in “Earlier work”; promoting this set brings it too.");
  assert.deepStrictEqual(byClass(behind, "link").map((link) => link.textContent), ["Version history"]);
  const earlier = thereCards(visibleRows(shadow)[1])[0];
  assert.ok(hasClass(earlier, "t-teal"));
  assert.deepStrictEqual(factsOf(earlier), ["From", "an upgrade"]);
  assert.strictEqual(byClass(earlier, "then").length, 0);
});

test("a closed row's note names the instance checked in bold, and an answer in grey gets a grey card", () => {
  const harness = load();
  const there = "https://exampletest.service-now.com";
  const other = row("current");
  const twin = row("batch");
  const shadow = open(harness, view([other, twin]), { onCheckRemote: () => {} }, { origins: [{ origin: there, label: "exampletest" }] });
  buttons(shadow, "Check")[0].click();
  harness.ui.showRemote({
    state: "done",
    lines: [],
    perRow: {
      [other.key]: { kind: "other", text: "On exampletest: runs another version (already stale here)" },
      [twin.key]: { kind: "inbatch", text: "On exampletest: runs this batch's newest update of it" },
    },
    parts: {
      [other.key]: { kind: "other", say: "Runs another version", notes: ["already stale here"], saved: null, then: "" },
      [twin.key]: { kind: "inbatch", say: "Runs this batch's newest update of it", notes: [], saved: null, then: "" },
    },
    counts: { runs: 0, same: 0, inBatch: 1, other: 1, otherStale: 1, none: 0, cant: 0 },
  }, 1);
  const rowFor = (fixture) => visibleRows(harness.shadow()).find((node) => byClass(node, "r-name")[0].textContent === fixture.target);
  const note = byClass(rowFor(other), "remote-tag")[0];
  assert.strictEqual(note.textContent, "exampletest runs another version (already stale here)");
  assert.strictEqual(findAll(note, (node) => node.tagName === "B")[0].textContent, "exampletest");
  assert.ok(hasClass(note, "warn"));
  headOf(rowFor(twin)).click();
  const card = thereCards(rowFor(twin))[0];
  assert.ok(!hasClass(card, "t-amber") && !hasClass(card, "t-teal"), "grey");
  assert.strictEqual(byClass(card, "v")[0].textContent, "Runs this batch's newest update of it.");
  assert.ok(hasClass(byClass(card, "v")[0], "grey"));
  assert.strictEqual(byClass(rowFor(twin), "remote-tag").length, 0, "opened, the card says it");
});

test("a link that can't open says why beside the row's links, then clears", async () => {
  const harness = load();
  const stale = row("stale", { links: [{ label: "Open record", record: "sys_ui_list_task_null" }] });
  const shadow = open(harness, view([stale]), {
    onOpenRecord: () => Promise.resolve({ ok: false, message: "No record found for this update." }),
  });
  buttons(shadow, "Open record")[0].click();
  await flush();
  const notes = byClass(shadow, "link-note");
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].textContent, "No record found for this update.");
  assert.ok(visibleRows(shadow)[0].textContent.includes("No record found for this update."), "on the row it was clicked on");
  assert.strictEqual(buttons(shadow, "Open record").length, 1, "the link keeps its label");
  /* Read out by the panel's one live region, which no repaint replaces. */
  const liveRegion = () => byClass(shadow, "sr-only").filter((node) => node.getAttribute("role") === "status");
  const live = liveRegion();
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].getAttribute("aria-live"), "polite");
  assert.strictEqual(live[0].textContent, "No record found for this update.");
  assert.strictEqual(byClass(shadow, "link-note")[0].getAttribute("role"), null, "the visible note isn't a second live region");
  harness.ui.update(view([stale]));
  assert.strictEqual(liveRegion()[0], live[0], "the same node after a repaint");
  harness.runTimers();
  assert.strictEqual(byClass(shadow, "link-note").length, 0);
  assert.strictEqual(live[0].textContent, "");
});

test("rows past what a check compared are marked Not compared there, in grey, and never counted as differing", () => {
  const harness = load();
  const there = "https://exampletest.service-now.com";
  const compared = row("current");
  const past = row("current");
  const shadow = open(harness, view([compared, past]), { onCheckRemote: () => {} }, { origins: [{ origin: there, label: "exampletest" }] });
  buttons(shadow, "Check")[0].click();
  harness.ui.showRemote({
    state: "done",
    lines: [{ kind: "note", text: "Compared the first 2,000 checked updates there." }],
    perRow: {},
    parts: {
      [compared.key]: { kind: "runs", say: "Runs this set's version", notes: [], saved: null, then: "" },
      [past.key]: { kind: "unsent", say: "Not compared", notes: [], saved: null, then: "Check on compares the first 2,000 updates checked here" },
    },
    counts: { runs: 1, same: 0, other: 0, otherStale: 0, none: 0, cant: 0 },
    links: { [compared.key]: [{ label: "Version history", remote: { origin: there, name: compared.name } }] },
  }, 1);
  const rowFor = (fixture) => visibleRows(harness.shadow()).find((node) => byClass(node, "r-name")[0].textContent === fixture.target);
  assert.deepStrictEqual(byClass(rowFor(compared), "badge").map((badge) => badge.textContent), ["CURRENT"], "a match needs no mark");
  const mark = byClass(rowFor(past), "b-there")[0];
  assert.strictEqual(mark.textContent, "NOT COMPARED THERE");
  assert.ok(hasClass(mark, "same"), "grey");
  assert.strictEqual(mark.title, "Check on compares the first 2,000 updates checked here");
  assert.ok(!chip(shadow, "Differs on exampletest"), "not a difference");
  headOf(rowFor(past)).click();
  const card = thereCards(rowFor(past))[0];
  assert.strictEqual(byClass(card, "say")[0].textContent, "Not compared.");
  assert.strictEqual(byClass(card, "then")[0].textContent, "Check on compares the first 2,000 updates checked here.");
  assert.ok(!hasClass(card, "t-amber") && !hasClass(card, "t-teal"));
});

test("an answer for an earlier press, or after the instance was changed, is dropped", () => {
  const harness = load();
  const shadow = open(harness, view([row("current")]), { onCheckRemote: () => {} }, {
    origins: [
      { origin: "https://exampletest.service-now.com", label: "exampletest" },
      { origin: "https://examplesbx.service-now.com", label: "examplesbx" },
    ],
  });
  buttons(shadow, "Check")[0].click();
  const select = findAll(shadow, (node) => node.tagName === "SELECT")[0];
  select.value = "https://examplesbx.service-now.com";
  select.fire("change");
  harness.ui.showRemote({ state: "done", lines: [{ kind: "state", text: "Committed on exampletest." }] }, 1);
  assert.ok(!harness.text().includes("Committed on exampletest."));
});

/* ------------------------------------------------------------------ *
 * Batch, continue, copy, retrieved screen
 * ------------------------------------------------------------------ */

test("the batch checkbox reflects the view and asks for the other choice", () => {
  const harness = load();
  const toggled = [];
  const shadow = open(harness, view([row("batch", { childSet: "Child A" })], {
    batch: { children: 2, included: true, setCount: 3 },
  }), { onToggleBatch: (on) => toggled.push(on) });
  const box = findAll(shadow, (node) => node.tagName === "INPUT" && node.getAttribute("type") === "checkbox")[0];
  assert.strictEqual(box.checked, true);
  assert.ok(harness.text().includes("Include its 2 direct child sets · + 3 sets in this batch"));
  assert.ok(chip(shadow, "In this batch"), "the batch chip appears in batch mode");
  box.checked = false;
  box.fire("change");
  assert.deepStrictEqual(toggled, [false]);
});

/* A check answers for the rows it was sent, so a change of scope drops it,
 * and an answer still on its way, as a change of instance does. */
test("switching the batch or checking the next 2,000 drops the other instance's answer, and a late one", () => {
  const harness = load();
  const there = "https://exampletest.service-now.com";
  const child = row("batch", { childSet: "Child A" });
  const answer = (token) => harness.ui.showRemote({
    state: "done",
    lines: [{ kind: "state", text: "Base and 2 child sets on exampletest: committed 3." }],
    perRow: { [child.key]: { kind: "other", text: "On exampletest: runs another version" } },
    counts: { runs: 0, same: 0, other: 1, otherStale: 0, none: 0, cant: 0 },
    links: { [child.key]: [{ label: "Version history", remote: { origin: there, name: child.name } }] },
  }, token);
  const batchView = (included, extra) => view([child], Object.assign({ batch: { children: 2, included, setCount: 3 } }, extra));
  const shadow = open(harness, batchView(true, { canContinue: true }), {
    onCheckRemote: () => {}, onToggleBatch: () => {}, onContinue: () => {},
  }, { origins: [{ origin: there, label: "exampletest" }] });
  chip(shadow, "All").click();
  headOf(visibleRows(shadow)[0]).click();

  buttons(shadow, "Check")[0].click();
  answer(1);
  assert.ok(harness.text().includes("Base and 2 child sets on exampletest: committed 3."));
  assert.strictEqual(thereCards(shadow).length, 1);
  const box = findAll(shadow, (node) => node.tagName === "INPUT" && node.getAttribute("type") === "checkbox")[0];
  box.checked = false;
  box.fire("change");
  harness.ui.update(batchView(false, { canContinue: true }));
  assert.ok(!harness.text().includes("Base and 2 child sets"), "the old scope's presence line is gone");
  assert.strictEqual(byClass(shadow, "remote-tag").length, 0);
  assert.strictEqual(thereCards(shadow).length, 0);
  assert.strictEqual(buttons(shadow, "Check")[0].disabled, false, "a new check can start");

  buttons(shadow, "Check")[0].click();
  const inFlight = 3;
  buttons(shadow, "Check the next 2,000")[0].click();
  answer(inFlight);
  assert.ok(!harness.text().includes("Base and 2 child sets"), "an answer for the rows before Continue is dropped");
  assert.strictEqual(byClass(shadow, "remote-tag").length, 0);
  assert.strictEqual(thereCards(shadow).length, 0);
});

test("Check the next 2,000 shows only when more rows wait", () => {
  const harness = load();
  let continued = 0;
  const shadow = open(harness, view([row("current")], { canContinue: true }), { onContinue: () => { continued += 1; } });
  const next = buttons(shadow, "Check the next 2,000")[0];
  assert.strictEqual(next.hidden, false);
  next.click();
  assert.strictEqual(continued, 1);
  harness.ui.update(view([row("current")], { canContinue: false }));
  assert.strictEqual(buttons(shadow, "Check the next 2,000")[0].hidden, true);
});

test("the copy summary holds counts only: no name, id, origin or URL", async () => {
  const harness = load();
  const copied = [];
  const rows = [row("stale"), row("cant"), row("current")];
  const shadow = open(harness, view(rows), { onCopy: async (text) => { copied.push(text); return true; } });
  buttons(shadow, "Copy summary")[0].click();
  await flush();
  assert.strictEqual(copied.length, 1);
  const text = copied[0];
  assert.match(text, /^Update Set Lens: one update set\.\nChecked 3 of 3 updates\.\nStale 1, can't tell 1, same content 0, current 1\.$/);
  assert.doesNotMatch(text, /Approval fix|Next release|Utility|sys_script_include|https?:|service-now|[0-9a-f]{32}|dev\./);
  assert.strictEqual(buttons(shadow, "✓ Copied").length, 1);
  harness.runTimers();
  assert.strictEqual(buttons(shadow, "Copy summary").length, 1);
});

test("a retrieved set that is not committed shows its state and links, and no verdicts", () => {
  const harness = load();
  const opened = [];
  const shadow = open(harness, view([], {
    subject: null,
    phase: "retrieved",
    retrieved: {
      name: "Approval fix",
      stateLabel: "Previewed",
      loadedOn: "27 Oct 2026",
      source: "example source",
      message: "Not committed on this instance; ServiceNow's Preview checks it here.",
      note: "Its updates aren't applied here, so there's nothing to call stale.",
      links: [
        { label: "Open retrieved set", url: ORIGIN + "/sys_remote_update_set.do?sys_id=4" },
        { label: "Open preview problems", url: ORIGIN + "/sys_update_preview_problem_list.do?sysparm_query=x" },
      ],
    },
  }), { onOpenUrl: (url) => opened.push(url) });
  assert.ok(harness.text().includes("Not committed on this instance; ServiceNow's Preview checks it here."));
  assert.ok(harness.text().includes("Its updates aren't applied here, so there's nothing to call stale."));
  assert.ok(harness.text().includes("retrieved set · Previewed · loaded 27 Oct 2026 from example source"));
  assert.strictEqual(byClass(shadow, "summary")[0].hidden, true);
  assert.strictEqual(byClass(shadow, "check")[0].hidden, true);
  buttons(shadow, "Open preview problems")[0].click();
  assert.strictEqual(opened.length, 1);
});

test("a committed retrieved set with no linked local set never says its updates aren't applied", () => {
  const harness = load();
  open(harness, view([], {
    subject: null,
    phase: "retrieved",
    retrieved: {
      name: "Approval fix",
      stateLabel: "Committed",
      loadedOn: "27 Oct 2026",
      source: "",
      message: "Committed here; its local set isn't linked.",
      note: "",
      links: [],
    },
  }));
  assert.ok(harness.text().includes("Committed here; its local set isn't linked."));
  assert.doesNotMatch(harness.text(), /aren't applied|nothing to call stale/);
});

test("banners render as text with their links", () => {
  const harness = load();
  const opened = [];
  const shadow = open(harness, view([row("current")], {
    banners: [
      { kind: "warn", text: "Default sets aren't meant to be moved; this is a snapshot.", links: [] },
      { kind: "info", text: "Retrieved set, showing its local copy.", links: [{ label: "Open retrieved set", url: ORIGIN + "/sys_remote_update_set.do?sys_id=4" }] },
    ],
  }), { onOpenUrl: (url) => opened.push(url) });
  const banners = byClass(shadow, "banner");
  assert.strictEqual(banners.length, 2);
  assert.ok(hasClass(banners[0], "warn"));
  buttons(shadow, "Open retrieved set")[0].click();
  assert.deepStrictEqual(opened, [ORIGIN + "/sys_remote_update_set.do?sys_id=4"]);
  void plain;
});

/* ------------------------------------------------------------------ *
 * Sets checked together: one story's separate sets
 * ------------------------------------------------------------------ */

const GID = (n) => String(n).padStart(32, "0");
const GSETS = [
  { sysId: GID(11), name: "Team_V1", stateLabel: "Complete", createdOn: "1 Oct 2026", isDefault: false },
  { sysId: GID(12), name: "Team_V2", stateLabel: "Complete", createdOn: "3 Oct 2026", isDefault: false },
  { sysId: GID(13), name: "Team_V3", stateLabel: "In progress", createdOn: "5 Oct 2026", isDefault: false },
];

/* V1 holds a record's newest version that V2 also changed: V2 goes first. */
function reordered(extra) {
  return Object.assign({
    sets: [
      Object.assign({}, GSETS[1], { after: [], held: 0 }),
      Object.assign({}, GSETS[0], { after: [{ sysId: GID(12), name: "Team_V2", records: 1 }], held: 1 }),
      Object.assign({}, GSETS[2], {
        after: [{ sysId: GID(11), name: "Team_V1", records: 2 }, { sysId: GID(12), name: "Team_V2", records: 1 }],
        held: 2,
      }),
    ],
    rules: 2,
    records: 3,
    matchesCreation: false,
    against: [{ firstId: GID(12), first: "Team_V2", thenId: GID(11), then: "Team_V1", records: 1 }],
    cycle: null,
    soFar: false,
  }, extra);
}

function groupView(rows, order, extra) {
  return view(rows, Object.assign({
    subject: null,
    unit: "group",
    group: { story: "STRY0000101", included: true, fixed: true, more: false, others: 3, sets: GSETS, order },
  }, extra));
}

const orderText = (shadow) => {
  const block = byClass(shadow, "order")[0];
  return block ? block.textContent : "";
};

test("sets checked together: the story heads the panel, the commit order is listed, and a sibling's row is in these sets", () => {
  const harness = load();
  const sibling = row("batch", { childSet: "Team_V1", text: "Newer version is in “Team_V3”, one of the sets checked together" });
  const shadow = open(harness, groupView([sibling, row("current", { childSet: "Team_V3" })], reordered()));
  assert.strictEqual(byClass(shadow, "subtitle")[0].textContent, "STRY0000101 · 3 update sets checked together · 2 updates");
  const text = orderText(shadow);
  assert.ok(text.startsWith("Commit in this order"));
  assert.ok(text.includes("Not the order they were created in: commit 2 after 1."), "by number in the list, never by name");
  assert.ok(!harness.text().includes("Nothing needs attention"), "an order to change is something to look at");
  const items = findAll(byClass(shadow, "order-list")[0], (node) => node.tagName === "LI");
  assert.deepStrictEqual(items.map((item) => byClass(item, "o-name")[0].textContent), ["Team_V2", "Team_V1", "Team_V3"]);
  const late = byClass(items[1], "o-after")[0];
  assert.strictEqual(late.textContent, "After 1: it holds the newer version of 1 record that set also changed.");
  assert.ok(hasClass(late, "warn"), "the move creation order gets wrong is amber");
  const right = byClass(items[2], "o-after")[0];
  assert.strictEqual(right.textContent, "After 1 and 2: it holds the newer version of 2 records those sets also changed.",
    "sets it follows by their number, records counted once");
  assert.ok(!hasClass(right, "warn"), "one creation order already gets right is not");
  assert.ok(byClass(items[2], "o-meta")[0].textContent.startsWith("In progress · created 5 Oct 2026"));
  assert.ok(findAll(shadow, (node) => hasClass(node, "badge") && node.textContent === "IN THESE SETS").length);
  assert.ok(chip(shadow, "In these sets"), "the sibling chip says these sets");
  assert.ok(findAll(shadow, (node) => hasClass(node, "sum-badge") && node.textContent === "1 in these sets").length);
  assert.ok(!byClass(shadow, "check")[0].hidden, "Check on works for sets checked together");
  assert.ok(!findAll(shadow, (node) => node.tagName === "INPUT" && node.getAttribute("type") === "checkbox").length,
    "picked in the palette: nothing to untick");
});

test("the commit order line: creation order works, no order needed, no order works, and so far", () => {
  const harness = load();
  const rows = [row("current", { childSet: "Team_V1" })];
  const shadow = open(harness, groupView(rows, reordered({ matchesCreation: true, against: [] })));
  assert.ok(orderText(shadow).includes("Commit them in the order they were created."));
  assert.ok(byClass(shadow, "order-status")[0] && hasClass(byClass(shadow, "order-status")[0], "ok"));
  assert.ok(harness.text().includes("Nothing needs attention before promoting."));

  harness.ui.update(groupView(rows, reordered({ rules: 0, records: 0, matchesCreation: true, against: [],
    sets: GSETS.map((set) => Object.assign({}, set, { after: [] })) })));
  assert.ok(orderText(harness.shadow()).startsWith("Sets checked together"));
  assert.ok(orderText(harness.shadow()).includes("No record is changed by two of these sets with different content, so the order doesn't matter."));

  harness.ui.update(groupView(rows, reordered({ matchesCreation: false, against: [], cycle: ["Team_V1", "Team_V2"],
    cycleIds: [GID(11), GID(12)] })));
  assert.ok(orderText(harness.shadow()).includes("No order works for sets 1 and 2: each holds the newest version of a record " +
    "the other also changed. Make them one batch: ServiceNow then commits only the newest version of each record."));
  assert.ok(orderText(harness.shadow()).startsWith("Sets checked together"), "no \"Commit in this order\" above an order that can't work");
  assert.ok(!harness.text().includes("Nothing needs attention"), "sets no order can place need attention");

  harness.ui.update(groupView(rows, reordered({ soFar: true })));
  assert.ok(orderText(harness.shadow()).includes("So far: Not the order they were created in"));

  /* Records two sets changed whose order can't be told: amber, and never
   * "doesn't matter" or a tick. */
  harness.ui.update(groupView(rows, reordered({ rules: 0, records: 0, unplaced: 2, matchesCreation: true, against: [],
    sets: GSETS.map((set) => Object.assign({}, set, { after: [] })) })));
  let text = orderText(harness.shadow());
  assert.ok(text.includes("2 records were changed differently by two of these sets, and which set should go last for them " +
    "can't be told here. Show them"));
  assert.ok(!text.includes("doesn't matter") && !text.includes("✓"));
  assert.ok(!harness.text().includes("Nothing needs attention"));
  harness.ui.update(groupView(rows, reordered({ unplaced: 1, matchesCreation: true, against: [] })));
  text = orderText(harness.shadow());
  assert.ok(text.includes("Where the order is known, commit them in the order they were created."));
  assert.ok(!text.includes("✓"));

  /* Sets committed here from elsewhere: the order is the order they ran here. */
  harness.ui.update(groupView(rows, reordered({ matchesCreation: true, against: [],
    sets: reordered().sets.map((set) => Object.assign({}, set, { arrived: true })) })));
  assert.ok(orderText(harness.shadow()).includes("Read the order on the instance where the work was done."));
  assert.ok(!orderText(harness.shadow()).includes("created 1 Oct 2026"), "no dates while creation order works");

  harness.ui.update(groupView(rows, null, { phase: "running", busy: true }));
  assert.ok(orderText(harness.shadow()).startsWith("Sets checked together"), "before the run ends, the sets oldest first");
  assert.ok(!byClass(harness.shadow(), "order-status").length);
});

test("a set named for a story offers its other sets behind a tick box", () => {
  const harness = load();
  const toggled = [];
  const single = (others, included) => view([row("stale")], {
    unit: included ? "group" : "set",
    group: { story: "STRY0000101", included, fixed: false, more: false, others, sets: GSETS, order: null },
  });
  const shadow = open(harness, single(2, false), { onToggleStory: (on) => toggled.push(on) });
  const box = findAll(shadow, (node) => node.tagName === "INPUT" && node.getAttribute("type") === "checkbox")[0];
  assert.strictEqual(box.checked, false);
  assert.ok(harness.text().includes("Also check the 2 other sets for STRY0000101"));
  assert.strictEqual(orderText(shadow), "", "no order until they are checked together");
  box.checked = true;
  box.fire("change");
  assert.deepStrictEqual(toggled, [true]);
  harness.ui.update(single(1, false));
  assert.ok(harness.text().includes("Also check the other set for STRY0000101"));
  harness.ui.update(single(2, true));
  assert.ok(orderText(harness.shadow()).startsWith("Sets checked together"));
});

test("records whose order can't be told: the amber line's Show them and the Order unknown chip list just their rows", () => {
  const harness = load();
  const note = "which of these sets should go last for it can't be told: this set's version was backed out here";
  const unknownA = row("batch", { childSet: "Team_V2", orderUnknown: true, notes: [note] });
  const unknownB = row("current", { childSet: "Team_V1", orderUnknown: true, notes: [note] });
  const plainRow = row("current", { childSet: "Team_V3" });
  const shadow = open(harness, groupView([unknownA, unknownB, plainRow], reordered({ rules: 0, records: 0, unplaced: 1,
    matchesCreation: true, against: [], sets: GSETS.map((set) => Object.assign({}, set, { after: [] })) })));
  assert.ok(orderText(shadow).includes("1 record was changed differently by two of these sets, and which set should go last for it " +
    "can't be told here. Show it"));
  assert.ok(chip(shadow, "Order unknown"), "a chip while there are any");
  assert.strictEqual(chip(shadow, "Order unknown").textContent, "Order unknown 2");
  buttons(shadow, "Show it")[0].click();
  const shown = visibleRows(harness.shadow()).map((node) => byClass(node, "r-name")[0].textContent.replace(/in .*$/, ""));
  assert.deepStrictEqual(shown.sort(), [unknownA.target, unknownB.target].sort());
  assert.strictEqual(chip(harness.shadow(), "Order unknown").getAttribute("aria-pressed"), "true");
  /* Opened, the row's card says why. */
  headOf(visibleRows(harness.shadow())[0]).click();
  assert.ok(harness.text().includes(note));
  /* Gone once nothing is unplaced, and the filter lapses with it. */
  harness.ui.update(groupView([plainRow], reordered({ matchesCreation: true, against: [] })));
  assert.ok(!chip(harness.shadow(), "Order unknown"));
  assert.strictEqual(visibleRows(harness.shadow()).length, 1);
});

test("unticking the story while a check runs drops that check's late answer", () => {
  const harness = load();
  const there = "https://exampletest.service-now.com";
  const sibling = row("batch", { childSet: "Team_V1" });
  const toggled = [];
  const shadow = open(harness, groupView([sibling], reordered(), {
    subject: view([]).subject,
    group: { story: "STRY0000101", included: true, fixed: false, more: false, others: 2, sets: GSETS, order: reordered() },
  }), { onCheckRemote: () => {}, onToggleStory: (on) => toggled.push(on) }, { origins: [{ origin: there, label: "exampletest" }] });
  buttons(shadow, "Check")[0].click();
  const box = findAll(shadow, (node) => node.tagName === "INPUT" && node.getAttribute("type") === "checkbox")[0];
  box.checked = false;
  box.fire("change");
  assert.deepStrictEqual(toggled, [false]);
  harness.ui.showRemote({
    state: "done",
    lines: [{ kind: "ok", text: "exampletest matches." }],
    perRow: { [sibling.key]: { kind: "other", text: "On exampletest: runs another version" } },
    counts: {},
  }, 1);
  assert.ok(!byClass(harness.shadow(), "b-there").length, "the answer for the old scope is dropped");
  assert.ok(!harness.text().includes("exampletest matches."));
});

test("the copy summary of sets checked together holds counts and the order's outcome, no names", async () => {
  const harness = load();
  const copied = [];
  const shadow = open(harness, groupView([row("batch", { childSet: "Team_V1" }), row("current", { childSet: "Team_V3" })], reordered()),
    { onCopy: async (text) => { copied.push(text); return true; } });
  buttons(shadow, "Copy summary")[0].click();
  await flush();
  assert.strictEqual(copied[0], "Update Set Lens: a group of 3 update sets checked together.\nChecked 2 of 2 updates.\n" +
    "Stale 0, can't tell 0, in these sets 1, same content 0, current 1.\n" +
    "Commit order: differs from creation order for 1 pair of sets.");
  assert.doesNotMatch(copied[0], /Team_|STRY|Utility|sys_script_include|https?:|service-now|[0-9a-f]{32}/);
});

/* The palette's list of sets lives in content.js; it is lifted out by its
 * anchors and run against the same shim. */
const CONTENT_SOURCE = fs.readFileSync(path.join(root, "content.js"), "utf8").replace(/\r\n/g, "\n");

function loadChooser() {
  const dom = createDom();
  const start = CONTENT_SOURCE.indexOf("/* Every listed set has a tick box");
  const end = CONTENT_SOURCE.indexOf("async function runUpdateSetLensInput(", start);
  assert.ok(start >= 0 && end > start, "the chooser's source block moved");
  const chooser = dom.document.createElement("div");
  dom.document.documentElement.appendChild(chooser);
  const input = dom.document.createElement("input");
  dom.document.documentElement.appendChild(input);
  const state = { chooser, hint: dom.document.createElement("div"), input, keydown: () => {}, typed: null };
  const started = [];
  let closed = 0;
  const show = new Function(
    "document", "updateSetChooser", "closePalette", "startUpdateSetLens", "updateSetChoiceMeta",
    CONTENT_SOURCE.slice(start, end) + "\nreturn showUpdateSetChoices;"
  )(dom.document, state, () => { closed += 1; }, (resolution) => started.push(resolution), (set) => set.stateLabel || "");
  return { show, chooser, state, started, closed: () => closed };
}

test("the palette lists a story's sets with tick boxes: its live ones ticked, checked together from one button", () => {
  const chooser = loadChooser();
  const set = (n, name, stateLabel) => ({ sysId: GID(n), name, stateLabel, isDefault: false });
  const sets = [set(14, "Team_old", "Ignore"), set(11, "Team_V1", "Complete"), set(12, "Team_V2", "Complete"), set(13, "Team_V3", "In progress")];
  chooser.show({ kind: "story", typed: "stry0000101", story: "STRY0000101", sets, preselected: [GID(11), GID(12), GID(13)], more: false });
  const boxes = findAll(chooser.chooser, (node) => node.tagName === "INPUT");
  assert.deepStrictEqual(boxes.map((box) => box.checked), [false, true, true, true]);
  assert.strictEqual(boxes[1].getAttribute("aria-label"), "Include “Team_V1”");
  const together = byClass(chooser.chooser, "usl-together")[0];
  assert.strictEqual(together.textContent, "Check the 3 ticked sets together");
  assert.ok(chooser.chooser.textContent.startsWith("4 sets for STRY0000101, oldest first."));

  boxes[2].checked = false;
  boxes[2].fire("change");
  boxes[3].checked = false;
  boxes[3].fire("change");
  assert.strictEqual(together.textContent, "Tick two or more sets to check them together");
  assert.strictEqual(together.disabled, true);
  together.click();
  assert.strictEqual(chooser.started.length, 0, "one ticked set is not a group");

  boxes[3].checked = true;
  boxes[3].fire("change");
  assert.strictEqual(together.textContent, "Check the 2 ticked sets together");
  together.click();
  assert.strictEqual(chooser.closed(), 1);
  assert.deepStrictEqual(plain(chooser.started), [{ kind: "group", sets: [sets[1], sets[3]], story: "STRY0000101" }]);

  /* A name still opens that one set alone. */
  const option = byClass(chooser.chooser, "usl-option")[2];
  option.click();
  assert.deepStrictEqual(plain(chooser.started[1]), { kind: "set", set: sets[2] });
  assert.ok(hasClass(chooser.chooser, "story"), "a story's list is the taller one");
});

test("the palette list moves by arrow keys along a column and across a row; Enter ticks a box", () => {
  const chooser = loadChooser();
  const sets = [1, 2, 3].map((n) => ({ sysId: GID(30 + n), name: "Set " + n, stateLabel: "Complete" }));
  chooser.show({ kind: "story", typed: "stry0000303", story: "STRY0000303", sets, preselected: sets.map((set) => set.sysId), more: false });
  const options = byClass(chooser.chooser, "usl-option");
  const boxes = findAll(chooser.chooser, (node) => node.tagName === "INPUT");
  const together = byClass(chooser.chooser, "usl-together")[0];
  const key = (node, name) => node.onkeydown({ key: name, preventDefault() {}, stopPropagation() {} });
  const reset = () => [].concat(options, boxes, [together, chooser.state.input]).forEach((node) => { node.focused = 0; });

  options[0].focus();
  reset();
  key(options[0], "ArrowDown");
  assert.strictEqual(options[1].focused, 1, "Down moves along the names");
  reset();
  key(options[1], "ArrowLeft");
  assert.strictEqual(boxes[1].focused, 1, "Left crosses to the row's tick box");
  reset();
  key(boxes[1], "ArrowUp");
  assert.strictEqual(boxes[0].focused, 1, "Up moves along the tick boxes");
  reset();
  key(boxes[0], "ArrowRight");
  assert.strictEqual(options[0].focused, 1, "Right crosses back to the name");
  reset();
  key(options[0], "ArrowUp");
  assert.strictEqual(chooser.state.input.focused, 1, "Up from the first row returns to the input");
  reset();
  key(options[2], "ArrowDown");
  assert.strictEqual(together.focused, 1, "Down from the last name reaches the button");
  reset();
  key(together, "ArrowUp");
  assert.strictEqual(options[2].focused, 1);

  /* Enter on a box ticks it (the shim's click does not toggle, so the change
   * is fired the way Chrome fires it after a click). */
  let clicked = 0;
  boxes[2].addEventListener("click", () => { clicked += 1; boxes[2].checked = !boxes[2].checked; boxes[2].fire("change"); });
  key(boxes[2], "Enter");
  assert.strictEqual(clicked, 1);
  assert.strictEqual(together.textContent, "Check the 2 ticked sets together");
});

test("a name search's list starts with nothing ticked, and two ticked sets check together with no story", () => {
  const chooser = loadChooser();
  const sets = [{ sysId: GID(21), name: "Approval fix", stateLabel: "Complete" }, { sysId: GID(22), name: "Approval fix 2", stateLabel: "Complete" }];
  chooser.show({ kind: "suggest", typed: "approval", sets, more: false });
  const boxes = findAll(chooser.chooser, (node) => node.tagName === "INPUT");
  assert.deepStrictEqual(boxes.map((box) => box.checked), [false, false]);
  boxes.forEach((box) => { box.checked = true; box.fire("change"); });
  byClass(chooser.chooser, "usl-together")[0].click();
  assert.deepStrictEqual(plain(chooser.started), [{ kind: "group", sets, story: "" }]);
});

/* The input row as the palette mounts it, from the chooser's mount through
 * the typed lookup, with the engine's lookup answered by the test. */
function loadInputRow() {
  const dom = createDom();
  const start = CONTENT_SOURCE.indexOf("/* U1: when a name matches several sets");
  const end = CONTENT_SOURCE.indexOf("async function loadUpdateSetCheckOrigins(", start);
  assert.ok(start >= 0 && end > start, "the input row's source block moved");
  const timers = [];
  const asked = [];
  const started = [];
  const toasts = [];
  let closed = 0;
  let hidden = 0;
  const engine = {
    resolveUpdateSetInput(text, ctx) {
      let answer;
      const promise = new Promise((resolve) => { answer = resolve; });
      asked.push({ text, answer, ctx });
      return promise;
    },
  };
  const api = new Function(
    "document", "updateSetChooser", "closePalette", "startUpdateSetLens", "paletteHost", "showToast",
    "hidePaletteToast", "updateSetLensContext", "globalThis", "setTimeout", "clearTimeout",
    CONTENT_SOURCE.slice(start, end) +
      "\nreturn { mount: mountUpdateSetChooser, run: runUpdateSetLensInput, state: () => updateSetChooser };"
  )(
    dom.document, null, () => { closed += 1; }, (resolution) => started.push(resolution), {},
    (text, isError) => toasts.push({ text, isError }), () => { hidden += 1; }, (extra) => Object.assign({}, extra),
    { SNUpdateSetLens: engine },
    (fn, ms) => { timers.push({ fn, ms, cancelled: false }); return timers.length; },
    (handle) => { if (timers[handle - 1]) timers[handle - 1].cancelled = true; }
  );
  const row = dom.document.createElement("div");
  dom.document.documentElement.appendChild(row);
  const input = dom.document.createElement("input");
  row.appendChild(input);
  api.mount({ row, input, keydown: () => {} });
  const state = api.state();
  return {
    api, state, asked, started, toasts, timers, dom, row, input,
    closed: () => closed,
    hidden: () => hidden,
    type(value) {
      input.value = value;
      input.fire("input");
    },
    pause() {
      timers.forEach((timer) => {
        if (!timer.cancelled && !timer.done) {
          timer.done = true;
          timer.fn();
        }
      });
    },
    enter() { return api.run(input.value); },
  };
}

test("a pause in typing lists the matching sets, without Enter", async () => {
  const typed = loadInputRow();
  assert.ok(typed.state.hint.textContent.startsWith("Type a set's name or a story number: matching sets are listed as you type."));
  typed.type("appr");
  typed.type("approval");
  assert.strictEqual(typed.asked.length, 0, "nothing is asked while typing goes on");
  assert.deepStrictEqual(typed.timers.map((timer) => [timer.ms, timer.cancelled]), [[500, true], [500, false]]);
  typed.pause();
  assert.deepStrictEqual(typed.asked.map((entry) => entry.text), ["approval"], "one lookup, for the whole word");
  assert.strictEqual(typed.state.hint.textContent, "Looking for sets…");
  const sets = [{ sysId: GID(41), name: "Approval fix", stateLabel: "Complete" }, { sysId: GID(42), name: "Approval fix 2", stateLabel: "Complete" }];
  typed.asked[0].answer({ kind: "suggest", typed: "approval", sets, more: false });
  await flush();
  assert.strictEqual(typed.state.chooser.hidden, false);
  assert.deepStrictEqual(byClass(typed.state.chooser, "usl-option-name").map((node) => node.textContent), ["Approval fix", "Approval fix 2"]);
  assert.strictEqual(typed.started.length + typed.closed(), 0, "a list opens nothing");

  /* Enter on the same text leaves the list standing, as before. */
  await typed.enter();
  assert.strictEqual(typed.asked.length, 1);
  assert.strictEqual(typed.state.chooser.hidden, false);
});

test("a pause never opens a lone match: the hint names it and Enter opens it without asking again", async () => {
  const typed = loadInputRow();
  typed.type("Fix");
  typed.pause();
  const set = { sysId: GID(51), name: "Fix", stateLabel: "In progress" };
  typed.asked[0].answer({ kind: "set", set });
  await flush();
  assert.strictEqual(typed.started.length + typed.closed(), 0, "\"Fix\" may be the start of a longer name");
  assert.strictEqual(typed.state.chooser.hidden, true);
  assert.strictEqual(typed.state.hint.textContent, "Press Enter to open “Fix”.");
  await typed.enter();
  assert.strictEqual(typed.asked.length, 1, "Enter uses what the pause found");
  assert.strictEqual(typed.closed(), 1);
  assert.deepStrictEqual(plain(typed.started), [{ kind: "set", set }]);
});

test("a pause on a retrieved set's sys_id says it is the retrieved set", async () => {
  const typed = loadInputRow();
  typed.type(GID(61));
  typed.pause();
  typed.asked[0].answer({ kind: "retrieved", remote: { sysId: GID(61), name: "Imported fixes" } });
  await flush();
  assert.strictEqual(typed.state.hint.textContent, "Press Enter to open the retrieved set “Imported fixes”.");
  assert.strictEqual(typed.started.length, 0);
});

test("short text lists nothing, clearing the field puts the first hint back, and a miss is said in the hint", async () => {
  const typed = loadInputRow();
  const idle = typed.state.hint.textContent;
  typed.type("ap");
  typed.pause();
  assert.strictEqual(typed.asked.length, 0, "two characters ask nothing");
  assert.strictEqual(typed.state.hint.textContent, "Keep typing: sets are listed from 3 characters.");
  typed.type("");
  typed.pause();
  assert.strictEqual(typed.state.hint.textContent, idle);
  typed.type("zzzz");
  typed.pause();
  typed.asked[0].answer({ kind: "none", message: "No update set named \"zzzz\" here, or you can't read it." });
  await flush();
  assert.strictEqual(typed.state.hint.textContent, "No update set named \"zzzz\" here, or you can't read it.");
  assert.strictEqual(typed.toasts.length, 0, "a pause's miss is no red line");
});

test("an answer for text since typed over, or overtaken by Enter, is dropped", async () => {
  const typed = loadInputRow();
  const sets = [{ sysId: GID(71), name: "Old A" }, { sysId: GID(72), name: "Old B" }];
  typed.type("old");
  typed.pause();
  typed.type("older");
  typed.asked[0].answer({ kind: "suggest", typed: "old", sets, more: false });
  await flush();
  assert.strictEqual(typed.state.chooser.hidden, true, "the list for \"old\" never shows under \"older\"");

  /* Enter while a pause's lookup runs: Enter's answer is the one that counts. */
  typed.pause();
  const enter = typed.enter();
  assert.deepStrictEqual(typed.asked.map((entry) => entry.text), ["old", "older", "older"]);
  typed.asked[1].answer({ kind: "suggest", typed: "older", sets, more: false });
  await flush();
  assert.strictEqual(typed.state.chooser.hidden, true, "the pause's answer is dropped");
  const set = { sysId: GID(73), name: "older" };
  typed.asked[2].answer({ kind: "set", set });
  await enter;
  assert.deepStrictEqual(plain(typed.started), [{ kind: "set", set }]);
});

test("typing on after Enter drops Enter's answer for the older text, before the next pause asks", async () => {
  const typed = loadInputRow();
  typed.type("Fix");
  const enter = typed.enter();
  const hiddenBefore = typed.hidden();
  typed.type("Fix login");
  assert.ok(typed.hidden() > hiddenBefore, "the keystroke takes Enter's busy line away");
  assert.strictEqual(typed.asked[0].ctx.shouldStop(), true, "Enter's reads stop at the next one");
  /* Answered inside the 500 ms, before any pause. */
  typed.asked[0].answer({ kind: "set", set: { sysId: GID(81), name: "Fix" } });
  await enter;
  assert.strictEqual(typed.started.length + typed.closed(), 0, "\"Fix\" is not opened under \"Fix login\"");
  typed.pause();
  const sets = [{ sysId: GID(82), name: "Fix login V1" }, { sysId: GID(83), name: "Fix login V2" }];
  typed.asked[1].answer({ kind: "suggest", typed: "Fix login", sets, more: false });
  await flush();
  assert.strictEqual(typed.state.chooser.hidden, false);
});

test("a list replaced or hidden while in use hands focus back to the input, not to a set never chosen", async () => {
  const typed = loadInputRow();
  const sets = (...names) => names.map((name, index) => ({ sysId: GID(90 + index), name, stateLabel: "Complete" }));
  typed.type("STRY00123");
  typed.pause();
  typed.asked[0].answer({ kind: "suggest", typed: "STRY00123", sets: sets("STRY0012345 V1", "STRY0012399 V1"), more: false });
  await flush();
  const oldBox = findAll(typed.state.chooser, (node) => node.tagName === "INPUT")[0];
  typed.type("STRY0012345");
  /* ArrowDown, or a click on a tick box, before the new list lands. */
  oldBox.focus();
  typed.pause();
  typed.asked[1].answer({ kind: "story", typed: "STRY0012345", story: "STRY0012345",
    sets: sets("STRY0012345 V1", "STRY0012345 V2"), preselected: [GID(90), GID(91)], more: false });
  await flush();
  assert.strictEqual(oldBox.isConnected, false, "the old list is gone");
  /* Not the new list's first name: a Space or Enter already on its way
   * would open that set alone. */
  assert.strictEqual(typed.dom.document.activeElement, typed.input, "focus goes back to the input, not the page");
  await typed.enter();
  assert.strictEqual(typed.started.length + typed.closed(), 0, "Enter in the input opens nothing while the list stands");
  assert.strictEqual(typed.asked.length, 2);

  typed.type("STRY0012345 V2");
  byClass(typed.state.chooser, "usl-option")[0].focus();
  typed.pause();
  typed.asked[2].answer({ kind: "set", set: { sysId: GID(91), name: "STRY0012345 V2" } });
  await flush();
  assert.strictEqual(typed.dom.document.activeElement, typed.input, "a list hidden under focus hands it to the input");
});

test("the hint follows the text at once: it stops naming a set Enter would not open, and comes back with the text", async () => {
  const typed = loadInputRow();
  const idle = typed.state.hint.textContent;
  typed.type("Fix");
  typed.pause();
  typed.asked[0].answer({ kind: "set", set: { sysId: GID(140), name: "Fix" } });
  await flush();
  assert.strictEqual(typed.state.hint.textContent, "Press Enter to open “Fix”.");
  typed.type("Fix login");
  assert.strictEqual(typed.state.hint.textContent, idle, "before any pause, Enter would no longer open \"Fix\"");
  typed.type("Fix");
  assert.strictEqual(typed.state.hint.textContent, "Press Enter to open “Fix”.", "typed back, the line names it again");

  typed.type("appr");
  typed.pause();
  typed.asked[1].answer({ kind: "suggest", typed: "appr", sets: [{ sysId: GID(141), name: "Approval fix" }, { sysId: GID(142), name: "Approval fix 2" }], more: false });
  await flush();
  const listHint = typed.state.hint.textContent;
  typed.type("apprx");
  typed.pause();
  assert.strictEqual(typed.state.hint.textContent, "Looking for sets…");
  typed.type("appr");
  assert.strictEqual(typed.state.hint.textContent, listHint, "nothing is read for \"appr\", so the list's line comes back at once");
  typed.type("apprxy");
  assert.strictEqual(typed.state.hint.textContent, listHint, "typing on past a list does not swap the line on every key");
  assert.strictEqual(typed.asked.length, 3);
});

test("a hidden list holds no rows, so Tab from the input has nowhere hidden to go", async () => {
  const typed = loadInputRow();
  typed.type("appr");
  typed.pause();
  typed.asked[0].answer({ kind: "suggest", typed: "appr", sets: [{ sysId: GID(101), name: "Approval fix" }, { sysId: GID(102), name: "Approval fix 2" }], more: false });
  await flush();
  assert.ok(typed.state.chooser.children.length > 0);
  typed.type("Approval fix 2");
  typed.pause();
  typed.asked[1].answer({ kind: "set", set: { sysId: GID(102), name: "Approval fix 2" } });
  await flush();
  assert.strictEqual(typed.state.chooser.hidden, true);
  assert.strictEqual(typed.state.chooser.children.length, 0, "a lone match empties the list");
  typed.type("zz");
  typed.pause();
  assert.strictEqual(typed.state.chooser.children.length, 0, "short text leaves it empty");
});

test("the same text asked again reads nothing and keeps the ticks", async () => {
  const typed = loadInputRow();
  const sets = [1, 2, 3].map((n) => ({ sysId: GID(110 + n), name: "Team_V" + n, stateLabel: "Complete" }));
  typed.type("STRY0000101");
  typed.pause();
  typed.asked[0].answer({ kind: "story", typed: "STRY0000101", story: "STRY0000101", sets,
    preselected: sets.map((set) => set.sysId), more: false });
  await flush();
  const listHint = typed.state.hint.textContent;
  const boxes = findAll(typed.state.chooser, (node) => node.tagName === "INPUT");
  boxes[1].checked = false;
  boxes[1].fire("change");
  typed.type("STRY0000101 ");
  typed.pause();
  typed.type("STRY0000101x");
  typed.pause();
  assert.strictEqual(typed.state.hint.textContent, "Looking for sets…");
  typed.type("STRY0000101");
  typed.pause();
  assert.strictEqual(typed.asked.length, 2, "only the different text asked");
  assert.strictEqual(typed.state.hint.textContent, listHint, "the list's own line comes back");
  assert.deepStrictEqual(findAll(typed.state.chooser, (node) => node.tagName === "INPUT").map((box) => box.checked), [true, false, true]);
  assert.strictEqual(byClass(typed.state.chooser, "usl-together")[0].textContent, "Check the 2 ticked sets together");
  await typed.enter();
  assert.strictEqual(typed.asked.length, 2, "Enter on that text leaves the list standing");

  /* A lone match typed away from and back to is not asked again either. */
  typed.type("Fix");
  typed.pause();
  typed.asked[2].answer({ kind: "set", set: { sysId: GID(120), name: "Fix" } });
  await flush();
  typed.type("Fix ");
  typed.pause();
  assert.strictEqual(typed.asked.length, 3);
  assert.strictEqual(typed.state.hint.textContent, "Press Enter to open “Fix”.");
});

test("Enter's answer after Esc went back to the commands opens nothing, and is not drawn into a row opened again", async () => {
  const typed = loadInputRow();
  typed.type("Fix");
  const enter = typed.enter();
  typed.row.remove();
  const hiddenBefore = typed.hidden();
  typed.asked[0].answer({ kind: "set", set: { sysId: GID(130), name: "Fix" } });
  await enter;
  assert.strictEqual(typed.started.length + typed.closed(), 0, "Esc meant go back, not open");
  assert.ok(typed.hidden() > hiddenBefore, "and its busy line goes");

  /* Esc, then Update Set Lens chosen again while Enter still runs. */
  const again = loadInputRow();
  again.type("approval");
  const second = again.enter();
  const row = again.dom.document.createElement("div");
  again.dom.document.documentElement.appendChild(row);
  const input = again.dom.document.createElement("input");
  row.appendChild(input);
  again.row.remove();
  again.api.mount({ row, input, keydown: () => {} });
  const fresh = again.api.state();
  const hiddenNow = again.hidden();
  again.asked[0].answer({ kind: "suggest", typed: "approval", sets: [{ sysId: GID(131), name: "Approval fix" }, { sysId: GID(132), name: "Approval fix 2" }], more: false });
  await second;
  assert.strictEqual(fresh.chooser.hidden, true, "the old answer is not drawn into the new row");
  assert.strictEqual(fresh.chooser.children.length, 0);
  assert.strictEqual(again.hidden(), hiddenNow, "the new row's line is not the old Enter's to clear");
});

test("checked together, a row whose sibling's update runs there says so in these sets' words, in grey", () => {
  const harness = load();
  const there = "https://exampletest.service-now.com";
  const replaced = row("batch", { childSet: "Team_V1" });
  const shadow = open(harness, groupView([replaced], reordered()), { onCheckRemote: () => {} },
    { origins: [{ origin: there, label: "exampletest" }] });
  buttons(shadow, "Check")[0].click();
  harness.ui.showRemote({
    state: "done",
    lines: [{ kind: "ok", text: "exampletest matches: every record runs the newest update of it in these sets." }],
    perRow: { [replaced.key]: { kind: "inbatch", text: "On exampletest: runs the newest update of it in these sets" } },
    counts: { runs: 0, same: 0, inBatch: 1, inBatchNewest: 1, built: 0, earlier: 0, behind: 0, diverged: 0, moved: 0, other: 0,
      otherStale: 0, none: 0, cant: 0 },
  }, 1);
  chip(shadow, "All").click();
  const badge = byClass(visibleRows(harness.shadow())[0], "b-there")[0];
  assert.strictEqual(badge.textContent, "OTHER SET'S VERSION THERE");
  assert.ok(hasClass(badge, "same"));
});

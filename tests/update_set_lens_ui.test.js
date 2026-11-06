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
  assert.strictEqual(currentNode.getAttribute("aria-expanded"), "false");
  currentNode.click();
  const opened = visibleRows(shadow)[1];
  assert.ok(opened.textContent.includes("later save in this set"));
  assert.strictEqual(opened.getAttribute("aria-expanded"), "true");
  opened.fire("keydown", { key: "Enter" });
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

test("a batch row names its child set, and a retrieved-only row says so", () => {
  const harness = load();
  const shadow = open(harness, view([row("stale", { childSet: "Child A", asRetrieved: true })]));
  assert.ok(byClass(shadow, "r-sub")[0].textContent === "in Child A · as retrieved");
});

/* ------------------------------------------------------------------ *
 * Progressive fill, late results, closing
 * ------------------------------------------------------------------ */

test("a new snapshot keeps the filter, the open rows and the focus", () => {
  const harness = load();
  const first = [row("current"), row("stale")];
  const shadow = open(harness, view(first, { busy: true, phase: "running", progress: "Checking versions… 2 read" }));
  chip(shadow, "Current").click();
  visibleRows(shadow)[0].click();
  assert.strictEqual(visibleRows(shadow)[0].getAttribute("aria-expanded"), "true");
  chip(shadow, "Current").focus();
  harness.ui.update(view(first.concat([row("current"), row("current")]), { busy: true, phase: "running" }));
  assert.strictEqual(visibleRows(shadow).length, 3, "still filtered to Current");
  assert.deepStrictEqual(visibleRows(shadow).map((node) => node.getAttribute("aria-expanded")), ["true", "false", "false"],
    "the row that was open is still open, and only it");
  const focused = shadow.activeElement;
  assert.ok(focused && focused.textContent === "Current 3", "focus is on the redrawn chip");
});

test("Enter or Space on a link inside an open row is the link's: the row stays open", () => {
  const harness = load();
  const current = row("current");
  const shadow = open(harness, view([current]));
  const node = visibleRows(shadow)[0];
  node.fire("keydown", { key: "Enter" });
  const opened = visibleRows(shadow)[0];
  assert.strictEqual(opened.getAttribute("aria-expanded"), "true");
  const link = buttons(opened, "Open update")[0];
  for (const key of ["Enter", " "]) {
    /* The shim does not bubble, so the row's handler is fired as the
     * browser would reach it: with the link as the target. */
    const event = visibleRows(shadow)[0].fire("keydown", { key, target: link });
    assert.ok(!event.defaultPrevented, "the link's own click is not cancelled");
    assert.strictEqual(visibleRows(shadow)[0].getAttribute("aria-expanded"), "true", JSON.stringify(key) + " keeps the row open");
  }
  visibleRows(shadow)[0].fire("keydown", { key: " " });
  assert.strictEqual(visibleRows(shadow)[0].getAttribute("aria-expanded"), "false", "on the row itself it still folds");
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
    counts: { runs: 2, same: 0, other: 1, otherStale: 1, none: 0, cant: 0 },
  }, 1);
  assert.ok(harness.text().includes("Previewed, not committed on exampletest."));
  assert.strictEqual(byClass(shadow, "remote-tag").length, 1);
  assert.strictEqual(byClass(shadow, "remote-tag")[0].textContent, "On exampletest: runs another version (already stale here)");
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
  const there = byClass(staleNode, "links-on");
  assert.strictEqual(there.length, 1);
  assert.strictEqual(there[0].textContent, "exampletest:");
  assert.ok(there[0].parentNode.textContent.endsWith("exampletest:Open recordOpen versionVersion history"));
  there[0].parentNode.children.find((child) => child.textContent === "Open version").click();
  assert.deepStrictEqual(plain(remotes), [{ origin: other, table: "sys_update_version", sysId: "8".padStart(32, "0") }]);
  remotes.length = 0;
  buttons(staleNode, "Open record")[1].click();
  assert.strictEqual(remotes.length, 1, "the second Open record is the one there");
  await flush();
  assert.strictEqual(byClass(shadow, "link-note").length, 0, "an open that worked says nothing");

  /* A closed row shows its links only once it is opened, like its own. */
  const closed = visibleRows(shadow)[1];
  assert.strictEqual(byClass(closed, "links-on").length, 0);
  closed.click();
  assert.strictEqual(byClass(visibleRows(shadow)[1], "links-on").length, 1);
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
  assert.strictEqual(notes[0].getAttribute("role"), "status");
  assert.ok(visibleRows(shadow)[0].textContent.includes("No record found for this update."), "on the row it was clicked on");
  assert.strictEqual(buttons(shadow, "Open record").length, 1, "the link keeps its label");
  harness.runTimers();
  assert.strictEqual(byClass(shadow, "link-note").length, 0);
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
  visibleRows(shadow)[0].click();

  buttons(shadow, "Check")[0].click();
  answer(1);
  assert.ok(harness.text().includes("Base and 2 child sets on exampletest: committed 3."));
  assert.strictEqual(byClass(shadow, "remote-tag").length, 1);
  const box = findAll(shadow, (node) => node.tagName === "INPUT" && node.getAttribute("type") === "checkbox")[0];
  box.checked = false;
  box.fire("change");
  harness.ui.update(batchView(false, { canContinue: true }));
  assert.ok(!harness.text().includes("Base and 2 child sets"), "the old scope's presence line is gone");
  assert.strictEqual(byClass(shadow, "remote-tag").length, 0);
  assert.strictEqual(byClass(shadow, "links-on").length, 0);
  assert.strictEqual(buttons(shadow, "Check")[0].disabled, false, "a new check can start");

  buttons(shadow, "Check")[0].click();
  const inFlight = 3;
  buttons(shadow, "Check the next 2,000")[0].click();
  answer(inFlight);
  assert.ok(!harness.text().includes("Base and 2 child sets"), "an answer for the rows before Continue is dropped");
  assert.strictEqual(byClass(shadow, "remote-tag").length, 0);
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

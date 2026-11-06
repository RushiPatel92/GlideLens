/*
 * Tests for version_lens_ui.js, the Version Lens panel.
 *
 *   node --test tests/version_lens_ui.test.js
 *
 * DEV-ONLY, like its siblings. The panel runs under node:vm against the same
 * deliberately small DOM shim the Update Set Lens and Impersonate suites use.
 * The panel has no innerHTML path at all, so the shim needs no parser, and a
 * test that passes here cannot be passing because markup was interpolated
 * somewhere the shim ignored. One test paints a snapshot the real engine made
 * from the simulated instance, so the two cannot drift apart unnoticed.
 *
 * Synthetic data only.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { plain, id, guid, fakeInstance, setRow, versionRow } = require("./update_set_sim.js");

const root = path.join(__dirname, "..");
const UI_SOURCE = fs.readFileSync(path.join(root, "version_lens_ui.js"), "utf8");
const USL_UI_SOURCE = fs.readFileSync(path.join(root, "update_set_lens_ui.js"), "utf8");
const HOST_ID = "sn-dev-helper-version-lens";
const ORIGIN = "https://example.service-now.com";

/* ------------------------------------------------------------------ *
 * The DOM shim (as in update_set_lens_ui.test.js)
 * ------------------------------------------------------------------ */

function createDom() {
  let activeElement = null;

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

function load(sources) {
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
  (sources || [[UI_SOURCE, "version_lens_ui.js"]]).forEach(([source, filename]) => vm.runInContext(source, sandbox, { filename }));
  return {
    ui: sandbox.SNVersionLensUI,
    usl: sandbox.SNUpdateSetLensUI,
    dom,
    runTimers() {
      timers.forEach((timer) => {
        if (!timer.cancelled && !timer.done) {
          timer.done = true;
          timer.fn();
        }
      });
    },
    shadow(hostId) {
      const host = dom.document.documentElement.children.find((node) => node.id === (hostId || HOST_ID));
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
 * Fixtures: snapshots in the engine's shape
 * ------------------------------------------------------------------ */

const NAME = "sys_script_include_" + id(77);
let counter = 0;
function row(group, verdict, extra) {
  counter += 1;
  const setId = id(counter);
  return Object.assign({
    key: "k" + counter,
    sysId: id(500 + counter),
    name: NAME,
    guid: guid(counter),
    hash: String(counter),
    setId,
    setName: "Set " + counter,
    stateLabel: group === "open" ? "In progress" : "Complete",
    group,
    stateBadge: { open: "OPEN", default: "DEFAULT", complete: "COMPLETE", ignore: "IGNORE", merged: "MERGED", unreadable: "CAN'T READ" }[group],
    pinned: group === "open",
    verdict,
    reason: "",
    text: verdict === "stale" ? "Newer version in “Set 1”" : "This set's version is the one that runs here.",
    action: "Update",
    line1: "Last saved by dev.one on 21 Oct 2026",
    line2: "",
    savedOn: "21 Oct 2026 10:00",
    savedBy: "dev.one",
    notes: [],
    links: [
      { label: "Open update", url: ORIGIN + "/sys_update_xml.do?sys_id=" + id(500 + counter) },
      { label: "Open set", url: ORIGIN + "/sys_update_set.do?sys_id=" + setId },
      { label: "Check this set", set: { sysId: setId, name: "Set " + counter, state: "complete" } },
    ],
    set: { sysId: setId, name: "Set " + counter },
    updatedOnRaw: "2026-10-21 10:00:00",
  }, extra);
}

function countsOf(rows) {
  const counts = { open: 0, default: 0, complete: 0, ignore: 0, merged: 0, unreadable: 0 };
  new Map(rows.map((entry) => [entry.setId, entry.group])).forEach((group) => { counts[group] += 1; });
  return counts;
}

function snapshot(rows, extra) {
  return Object.assign({
    phase: "done",
    busy: false,
    progress: "",
    target: { name: NAME, how: "record", cls: "sys_script_include", clsLabel: "", display: "Approval utils", scope: "Global", howWords: [] },
    record: null,
    headline: { id: "H7", lead: "No competing sets:", rest: "only “Set 1” holds it open.", mark: "ok", word: "No competing sets" },
    sublines: [],
    attention: [],
    runsHere: "Runs here: the version from “Set 1” (In progress), version by dev.one at 21 Oct 2026.",
    loadedLine: "",
    banners: [],
    counts: countsOf(rows),
    rows,
    clear: true,
    links: [
      { label: "Version history", url: ORIGIN + "/sys_update_version_list.do?sysparm_query=x" },
      { label: "Captures list", url: ORIGIN + "/sys_update_xml_list.do?sysparm_query=y" },
    ],
    current: { name: NAME, guid: guid(1), hash: "1", source: id(1), sourceTable: "sys_update_set" },
    copyLines: ["Version Lens: one record.", "Captured in 1 set on this instance: open 1, Default 0, complete 0, Ignore 0, merged 0.", "No competing sets."],
    check: { shown: true, ready: true, blocked: "" },
  }, extra);
}

function open(harness, view, callbacks, extra) {
  harness.ui.open(Object.assign({ view, origins: [], callbacks: callbacks || {} }, extra || {}));
  return harness.shadow();
}

const headlineNode = (shadow) => byClass(shadow, "headline")[0];

/* ------------------------------------------------------------------ *
 * 50. Shell and safety
 * ------------------------------------------------------------------ */

test("50: a closed shadow root headed Version Lens, with no markup path; hostile names are text", () => {
  const harness = load();
  let mode = null;
  const realAttach = harness.dom.El.prototype.attachShadow;
  harness.dom.El.prototype.attachShadow = function (init) {
    mode = init && init.mode;
    return realAttach.call(this, init);
  };
  const hostile = "<img src=x onerror=alert(1)>";
  const shadow = open(harness, snapshot([row("open", "current", { setName: hostile, line1: "Last saved by " + hostile })], {
    target: { name: NAME, how: "record", cls: "x", display: hostile, scope: hostile, howWords: [] },
    headline: { id: "H7", lead: "No competing sets:", rest: "only “" + hostile + "” holds it open.", mark: "ok" },
  }));
  assert.strictEqual(mode, "closed");
  assert.strictEqual(findAll(shadow, (node) => node.tagName === "H2")[0].textContent, "Version Lens");
  assert.doesNotMatch(UI_SOURCE, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.ok(harness.text().includes(hostile));
  assert.strictEqual(findAll(shadow, (node) => node.tagName === "IMG").length, 0);
  assert.ok(harness.text().includes("tracked as " + NAME));
  assert.strictEqual(harness.ui.isOpen(), true);
});

/* ------------------------------------------------------------------ *
 * 51. The verdict block
 * ------------------------------------------------------------------ */

test("51: each headline wears its mark; the tick only on a clear run; attention lines are amber", () => {
  const cases = [
    [{ id: "H7", lead: "No competing sets:", rest: "only “Set 1” holds it open.", mark: "ok" }, true, "✓"],
    [{ id: "H7", lead: "No competing sets found so far:", rest: "only “Set 1” holds it open.", mark: "ok" }, false, ""],
    [{ id: "H5", lead: "Potential collision:", rest: "2 open sets hold different versions of this record.", mark: "differs" }, false, "≠"],
    [{ id: "H9", lead: "Captured only outside a named set:", rest: "…", mark: "warn" }, false, "⚠"],
    [{ id: "H8", lead: "History only:", rest: "no open update set holds it. 2 sets captured it.", mark: "" }, false, ""],
  ];
  for (const [headline, clear, mark] of cases) {
    const harness = load();
    const shadow = open(harness, snapshot([row("open", "current")], { headline, clear }));
    const node = headlineNode(shadow);
    const marks = byClass(node, "mark");
    assert.strictEqual(marks.length ? marks[0].textContent : "", mark, headline.lead);
    if (marks.length) assert.strictEqual(marks[0].getAttribute("aria-hidden"), "true");
    assert.ok(node.textContent.includes(headline.lead), headline.lead);
  }

  /* A Partial banner with a would-be tick: the banner shows, the tick does not. */
  const harness = load();
  const shadow = open(harness, snapshot([row("open", "current")], {
    clear: false,
    banners: [{ kind: "warn", text: "Partial: 1 of the sets that captured it can't be read here; any of them may be open." }],
    attention: [{ id: "A1", text: "“Set 2” holds a version that no longer runs here.", links: [{ label: "Open newer set", url: ORIGIN + "/sys_update_set.do?sys_id=" + id(1) }] }],
  }));
  assert.strictEqual(byClass(headlineNode(shadow), "mark").length, 0);
  assert.strictEqual(byClass(shadow, "banner").length, 1);
  assert.ok(hasClass(byClass(shadow, "banner")[0], "warn"));
  const attn = byClass(shadow, "attn");
  assert.strictEqual(attn.length, 1);
  assert.strictEqual(byClass(attn[0], "mark")[0].textContent, "⚠");
  assert.strictEqual(buttons(attn[0], "Open newer set").length, 1, "each A1 carries Open newer set");
  assert.ok(harness.text().includes("Runs here: the version from “Set 1”"));
});

/* ------------------------------------------------------------------ *
 * 52. Rows, groups and the count badges
 * ------------------------------------------------------------------ */

test("52: groups in order with their counts; badges filter and dim at zero; open rows stay open; others toggle", () => {
  const harness = load();
  const rows = [row("open", "current"), row("open", "stale"), row("default", "same"), row("complete", "stale"), row("unreadable", "cant")];
  const shadow = open(harness, snapshot(rows));
  assert.deepStrictEqual(byClass(shadow, "group").map((node) => node.textContent),
    ["Open sets (2)", "Default sets (1)", "Complete (1)", "Can't read (1)"]);
  const badges = byClass(shadow, "sum-badge");
  assert.deepStrictEqual(badges.map((node) => node.textContent), ["2 Open", "1 Default", "1 Complete", "0 Ignored", "1 Can't read"]);
  assert.ok(hasClass(badges[3], "zero"));
  assert.ok(!badges.some((node) => node.textContent.endsWith("Merged")), "Merged only when there is one");

  /* Open rows are always open; the others are one line until clicked. */
  const rowNodes = byClass(shadow, "row");
  assert.strictEqual(rowNodes.length, 5);
  assert.strictEqual(byClass(rowNodes[0], "r-detail").length, 1);
  assert.strictEqual(rowNodes[0].getAttribute("tabindex"), null);
  assert.strictEqual(byClass(rowNodes[2], "r-detail").length, 0);
  assert.strictEqual(rowNodes[2].getAttribute("aria-expanded"), "false");
  rowNodes[2].click();
  const reopened = byClass(harness.shadow(), "row")[2];
  assert.strictEqual(byClass(reopened, "r-detail").length, 1);
  assert.strictEqual(reopened.getAttribute("aria-expanded"), "true");
  const enter = reopened.fire("keydown", { key: "Enter" });
  assert.ok(enter.defaultPrevented);
  assert.strictEqual(byClass(byClass(harness.shadow(), "row")[2], "r-detail").length, 0, "Enter folds it again");

  /* Enter or Space on a link inside an opened row belongs to the link. */
  byClass(harness.shadow(), "row")[3].click();
  const opened = byClass(harness.shadow(), "row")[3];
  const link = buttons(opened, "Open update")[0];
  for (const key of ["Enter", " "]) {
    const pressed = opened.fire("keydown", { key, target: link });
    assert.ok(!pressed.defaultPrevented, key);
  }
  assert.strictEqual(byClass(byClass(harness.shadow(), "row")[3], "r-detail").length, 1, "the row stays open");

  /* A badge filters to its group, and pressing it again shows all. */
  buttons(harness.shadow(), "1 Complete")[0].click();
  assert.deepStrictEqual(byClass(harness.shadow(), "group").map((node) => node.textContent), ["Complete (1)"]);
  assert.strictEqual(buttons(harness.shadow(), "1 Complete")[0].getAttribute("aria-pressed"), "true");
  buttons(harness.shadow(), "1 Complete")[0].click();
  assert.strictEqual(byClass(harness.shadow(), "group").length, 4);
});

test("52b: a Delete is said in the row, and the second line and notes show when there are any", () => {
  const harness = load();
  const shadow = open(harness, snapshot([row("open", "current", {
    action: "Delete", line2: "First captured by dev.two on 1 Oct 2026 · scope x_app", notes: ["merged into “Release”", "captured 2 times in this set"],
  })]));
  const detail = byClass(shadow, "r-detail")[0];
  assert.ok(detail.textContent.startsWith("Last saved by dev.one on 21 Oct 2026 · Delete"));
  assert.strictEqual(findAll(detail, (node) => node.tagName === "B")[0].textContent, "Delete");
  assert.ok(detail.textContent.includes("First captured by dev.two on 1 Oct 2026 · scope x_app"));
  assert.ok(detail.textContent.includes("merged into “Release” · captured 2 times in this set"));
});

test("52c: a run with no rows says why in the list, and a busy run says it is checking", () => {
  const harness = load();
  open(harness, snapshot([], { headline: { id: "H4", lead: "No update on this instance captured this record.", rest: "", mark: "" }, counts: countsOf([]) }));
  assert.ok(harness.text().includes("Nothing to list: no update set here holds a capture of it."));
  harness.ui.update(snapshot([], { headline: { id: "H8", lead: "No open update set found so far:", rest: "the captures read don't match their count.", mark: "" }, counts: countsOf([]) }));
  assert.ok(harness.text().includes("Nothing to list: no capture could be read in full."), "covers unplaced rows and a count that disagrees");
  harness.ui.update(snapshot([], { headline: { id: "H4", lead: "No update on this instance captured this record.", rest: "", mark: "" }, counts: countsOf([]) }));
  assert.strictEqual(byClass(harness.shadow(), "sum-badge").length, 0);
  harness.ui.update(snapshot([], { phase: "running", busy: true, progress: "Reading its updates…", headline: null, counts: null }));
  assert.ok(harness.text().includes("Reading its updates…"));
  assert.strictEqual(byClass(harness.shadow(), "progress")[0].getAttribute("aria-live"), "polite");
});

/* ------------------------------------------------------------------ *
 * 53. Links
 * ------------------------------------------------------------------ */

test("53: links open same-origin URLs only; Check this set hands the set; links there go to onOpenRemote", async () => {
  const harness = load();
  const opened = [];
  const sets = [];
  const remote = [];
  const shadow = open(harness, snapshot([row("open", "current", {
    links: [
      { label: "Open update", url: ORIGIN + "/sys_update_xml.do?sys_id=" + id(1) },
      { label: "Elsewhere", url: "https://other.service-now.com/x.do" },
      { label: "Check this set", set: { sysId: id(1), name: "Set 1" } },
    ],
  })]), {
    onOpenUrl: (url) => opened.push(url),
    onOpenSetLens: (set) => { sets.push(plain(set)); return Promise.resolve({ ok: false, message: "Couldn't load Update Set Lens." }); },
    onOpenRemote: (target) => { remote.push(plain(target)); return Promise.resolve({ ok: true }); },
    onCheckRemote: () => {},
  }, { origins: [{ origin: "https://test.service-now.com", label: "TEST" }] });
  buttons(shadow, "Open update")[0].click();
  buttons(shadow, "Elsewhere")[0].click();
  assert.deepStrictEqual(opened, [ORIGIN + "/sys_update_xml.do?sys_id=" + id(1)]);
  buttons(shadow, "Version history")[0].click();
  assert.strictEqual(opened.length, 2, "the footer's links too");
  buttons(shadow, "Check this set")[0].click();
  assert.deepStrictEqual(sets, [{ sysId: id(1), name: "Set 1" }]);
  await flush();
  assert.ok(harness.text().includes("Couldn't load Update Set Lens."), "a link that can't open says why beside it");

  buttons(harness.shadow(), "Check")[0].click();
  harness.ui.showRemote({ state: "done", lines: [{ kind: "ok", text: "TEST runs the same version as this instance." }],
    perRow: {}, links: [{ label: "Open record", remote: { origin: "https://test.service-now.com", table: "sys_script_include", sysId: id(9) } }],
    copyLine: "On the other instance: runs the same version." }, 1);
  buttons(harness.shadow(), "Open record")[0].click();
  assert.deepStrictEqual(remote, [{ origin: "https://test.service-now.com", table: "sys_script_include", sysId: id(9) }]);
});

/* ------------------------------------------------------------------ *
 * 54. Check on
 * ------------------------------------------------------------------ */

test("54: Check on is hidden with its hint until an instance is open; late, earlier or other-instance answers are dropped", () => {
  const harness = load();
  const checks = [];
  const rows = [row("open", "current"), row("complete", "stale")];
  open(harness, snapshot(rows), {
    onCheckRemote: (origin, token) => checks.push([origin, token]),
  });
  let shadow = harness.shadow();
  assert.ok(byClass(shadow, "check-row")[0].hidden);
  assert.ok(harness.text().includes("To check another instance, open it in a tab and sign in, then reopen Version Lens."));

  harness.ui.setOrigins([{ origin: "https://test.service-now.com", label: "TEST" }, { origin: "https://uat.service-now.com", label: "UAT" }]);
  shadow = harness.shadow();
  assert.ok(!byClass(shadow, "check-row")[0].hidden);
  buttons(shadow, "Check")[0].click();
  assert.deepStrictEqual(checks, [["https://test.service-now.com", 1]]);
  assert.ok(buttons(harness.shadow(), "Check")[0].disabled, "one check at a time");

  /* Progress, then the answer; progress after the answer is ignored. */
  harness.ui.showRemote({ state: "busy", message: "Comparing versions… 3 reads" }, 1);
  assert.ok(harness.text().includes("Comparing versions… 3 reads"));
  harness.ui.showRemote({
    state: "done",
    lines: [{ kind: "differs", text: "TEST runs another version." }, { kind: "state", text: "Sets on TEST: committed 1, not found or not visible 1." }],
    perRow: { [rows[0].key]: { content: "runs", presence: "On TEST: committed on 30 Oct" } },
    links: [],
    copyLine: "On the other instance: runs another version; sets there: committed 1, not found 1.",
  }, 1);
  harness.ui.showRemote({ state: "busy", message: "late progress" }, 1);
  assert.ok(!harness.text().includes("late progress"));
  assert.ok(harness.text().includes("TEST runs another version."));
  assert.strictEqual(byClass(harness.shadow(), "differs")[0].textContent, "≠TEST runs another version.");
  /* The first row's answer there. */
  const first = byClass(harness.shadow(), "row")[0];
  assert.strictEqual(byClass(first, "there")[0].textContent, "On TEST: committed on 30 Oct · runs this set's version there");

  /* An answer to an earlier press is dropped. */
  harness.ui.showRemote({ state: "done", lines: [{ kind: "ok", text: "stale answer" }], perRow: {} }, 0);
  assert.ok(!harness.text().includes("stale answer"));
  /* Another instance chosen: the old answer goes, and a late one for it too. */
  const select = harness.shadow() && byClass(harness.shadow(), "check-row")[0].children.find((node) => node.tagName === "SELECT");
  select.value = "https://uat.service-now.com";
  select.fire("change");
  assert.ok(!harness.text().includes("TEST runs another version."));
  harness.ui.showRemote({ state: "done", lines: [{ kind: "ok", text: "late for TEST" }], perRow: {} }, 1);
  assert.ok(!harness.text().includes("late for TEST"));
});

test("54a: one column header for every row; Last saved always; the checked instance's column once a check is done", () => {
  const harness = load();
  const rows = [row("open", "current"), row("default", "same"), row("complete", "stale", { savedOn: "", savedBy: "" }), row("complete", "current")];
  open(harness, snapshot(rows), { onCheckRemote: () => {} }, { origins: [{ origin: "https://test.service-now.com", label: "TEST" }] });
  const header = () => byClass(harness.shadow(), "cols")[0];
  const cellsOf = (index) => byClass(byClass(harness.shadow(), "row")[index], "row-top")[0].children;
  assert.deepStrictEqual(header().children.map((node) => node.textContent), ["Update set", "Last saved", "Set state", "Version here", ""]);
  assert.strictEqual(header().getAttribute("aria-hidden"), "true");
  assert.ok(!hasClass(byClass(harness.shadow(), "rows")[0], "there"));
  /* Each row has as many cells as the header, so the columns line up. */
  rows.forEach((entry, index) => assert.strictEqual(cellsOf(index).length, header().children.length, entry.setName));
  const saved = byClass(byClass(harness.shadow(), "row")[0], "r-saved")[0];
  assert.strictEqual(saved.textContent, "Last saved 21 Oct 2026 10:00dev.one");
  assert.ok(hasClass(saved.children[0], "sr"), "the column's name is there for a screen reader");
  assert.strictEqual(byClass(byClass(harness.shadow(), "row")[2], "r-saved")[0].textContent, "Last saved —");

  /* A failed check adds no column. */
  buttons(harness.shadow(), "Check")[0].click();
  harness.ui.showRemote({ state: "error", message: "You're not signed in to TEST." }, 1);
  assert.ok(!hasClass(byClass(harness.shadow(), "rows")[0], "there"));
  assert.strictEqual(byClass(harness.shadow(), "r-there").length, 0);

  buttons(harness.shadow(), "Check")[0].click();
  harness.ui.showRemote({
    state: "done",
    lines: [{ kind: "differs", text: "TEST runs another version." }],
    perRow: {
      [rows[0].key]: { presence: "On TEST: not found or not visible", there: "missing", thereWord: "Not found" },
      [rows[2].key]: { content: "runs", presence: "On TEST: committed on 30 Oct", there: "committed", thereWord: "Committed" },
      [rows[3].key]: { content: "same" },
    },
    tally: [{ there: "committed", word: "Committed", count: 1 }, { there: "missing", word: "Not found", count: 1 }],
    links: [],
    copyLine: "On the other instance: runs another version; sets there: committed 1, not found 1.",
  }, 2);
  assert.ok(hasClass(byClass(harness.shadow(), "rows")[0], "there"));
  assert.deepStrictEqual(header().children.map((node) => node.textContent), ["Update set", "Last saved", "Set state", "Version here", "On TEST", ""]);
  rows.forEach((entry, index) => assert.strictEqual(cellsOf(index).length, header().children.length, entry.setName));
  const there = (index) => byClass(byClass(harness.shadow(), "row")[index], "r-there")[0];
  const badgesIn = (node) => byClass(node, "badge").map((badge) => badge.textContent);
  assert.deepStrictEqual(badgesIn(there(0)), ["NOT FOUND"]);
  assert.ok(hasClass(byClass(there(0), "badge")[0], "missing"));
  assert.deepStrictEqual(badgesIn(there(2)), ["COMMITTED", "RUNS THERE"]);
  assert.strictEqual(byClass(there(2), "b-there")[0].title, "On TEST: committed on 30 Oct", "the full words on hover");
  assert.ok(there(2).textContent.startsWith("On TEST: "), "the column's name is there for a screen reader");
  assert.strictEqual(byClass(there(1), "r-none")[0].textContent, "Not checked");
  assert.match(byClass(there(1), "r-none")[0].title, /Default sets are never promoted/);
  assert.deepStrictEqual(badgesIn(there(3)), ["RUNS SAME CONTENT"], "content without a state");
  assert.strictEqual(byClass(there(3), "r-none")[0].textContent, "Not checked");

  /* The counts, labelled with the instance checked. */
  const tally = byClass(harness.shadow(), "tally")[0];
  assert.strictEqual(byClass(tally, "tally-label")[0].textContent, "Sets on TEST:");
  assert.deepStrictEqual(byClass(tally, "t-badge").map((node) => node.textContent), ["1 Committed", "1 Not found"]);
  assert.strictEqual(buttons(tally, "1 Committed").length, 0, "counts there don't filter");

  /* Another instance chosen: the column goes with the answer. */
  harness.ui.setOrigins([{ origin: "https://test.service-now.com", label: "TEST" }, { origin: "https://uat.service-now.com", label: "UAT" }]);
  const select = byClass(harness.shadow(), "check-row")[0].children.find((node) => node.tagName === "SELECT");
  select.value = "https://uat.service-now.com";
  select.fire("change");
  assert.ok(!hasClass(byClass(harness.shadow(), "rows")[0], "there"));
  assert.strictEqual(byClass(harness.shadow(), "tally").length, 0);
});

test("54b: Check waits for the run, and says when there is nothing to look for there", () => {
  const harness = load();
  open(harness, snapshot([row("open", "current")], { phase: "running", busy: true, check: { shown: true, ready: false, blocked: "" } }), {},
    { origins: [{ origin: "https://test.service-now.com", label: "TEST" }] });
  assert.ok(buttons(harness.shadow(), "Check")[0].disabled);
  harness.ui.update(snapshot([row("open", "current")], { check: { shown: true, ready: false, blocked: "Nothing here to look for there." } }));
  assert.ok(buttons(harness.shadow(), "Check")[0].disabled);
  assert.ok(harness.text().includes("Nothing here to look for there."));
  harness.ui.update(snapshot([], { target: null, record: { cls: "sys_ui_element" }, check: { shown: false, ready: false, blocked: "" } }));
  assert.ok(byClass(harness.shadow(), "check")[0].hidden, "no name, no check");
});

test("54c: Copy summary copies the engine's lines and the check's, counts only", async () => {
  const harness = load();
  const copied = [];
  open(harness, snapshot([row("open", "current")]), {
    onCopy: (text) => { copied.push(text); return Promise.resolve(true); },
    onCheckRemote: () => {},
  }, { origins: [{ origin: "https://test.service-now.com", label: "TEST" }] });
  buttons(harness.shadow(), "Check")[0].click();
  harness.ui.showRemote({ state: "done", lines: [], perRow: {}, links: [], copyLine: "On the other instance: runs the same version." }, 1);
  buttons(harness.shadow(), "Copy summary")[0].click();
  await flush();
  assert.strictEqual(copied[0], [
    "Version Lens: one record.",
    "Captured in 1 set on this instance: open 1, Default 0, complete 0, Ignore 0, merged 0.",
    "No competing sets.",
    "On the other instance: runs the same version.",
  ].join("\n"));
  assert.strictEqual(buttons(harness.shadow(), "✓ Copied").length, 1);
});

/* ------------------------------------------------------------------ *
 * 55. Keyboard and lifetime
 * ------------------------------------------------------------------ */

test("55: Escape closes, calls onClose and restores focus; a late snapshot paints nothing; Tab stays inside", () => {
  const harness = load();
  const openerNode = harness.dom.document.createElement("button");
  harness.dom.document.documentElement.appendChild(openerNode);
  let closed = 0;
  open(harness, snapshot([row("open", "current"), row("complete", "current")]), { onClose: () => { closed += 1; } }, { opener: openerNode });
  const shadow = harness.shadow();
  const focusables = findAll(shadow, (node) => node.getAttribute &&
    (node.tagName === "BUTTON" || node.tagName === "SELECT" || node.getAttribute("tabindex") === "0") && !node.hidden && !node.disabled);
  focusables[focusables.length - 1].focus();
  const tab = harness.dom.window.fire("keydown", { key: "Tab" });
  assert.ok(tab.defaultPrevented);
  assert.strictEqual(harness.dom.document.activeElement.snhFocusKey, "close", "Tab wraps to the first control");
  harness.dom.window.fire("keydown", { key: "Escape" });
  assert.strictEqual(closed, 1);
  assert.strictEqual(harness.ui.isOpen(), false);
  assert.strictEqual(harness.shadow(), null);
  assert.ok(openerNode.focused > 0, "focus goes back to the opener");
  harness.ui.update(snapshot([row("open", "current")]));
  assert.strictEqual(harness.shadow(), null, "a late snapshot paints nothing");
});

/* ------------------------------------------------------------------ *
 * 56. The shared palette, and the engine's own snapshot
 * ------------------------------------------------------------------ */

test("56: the file wears the shared tokens and stops page inheritance at the host", () => {
  assert.match(UI_SOURCE, /--teal:#31d4c4;--pink:#ff6fae/);
  assert.match(UI_SOURCE, /:host\{[^}]*all:initial/);
  assert.match(UI_SOURCE, /\.panel\{width:min\(1800px,calc\(100vw - 48px\)\);height:calc\(100vh - 48px\)/);
});

test("the panel paints a snapshot the real engine made", async () => {
  const sandbox = { URL, URLSearchParams, Promise, console, encodeURIComponent, decodeURIComponent };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "update_set_lens.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "version_lens.js"), "utf8"), sandbox);
  const meta = { sys_id: id(77), sys_class_name: "sys_script_include", sys_update_name: NAME, sys_name: "Approval utils", sys_scope: "global" };
  const capture = (setId, g, hash, updated) => ({
    sys_id: id(800 + Number(hash)), name: NAME, update_set: setId, remote_update_set: "", action: "INSERT_OR_UPDATE",
    type: "Script Include", target_name: "Approval utils", update_guid: g, payload_hash: hash, application: "global",
    category: "customer", sys_created_by: "dev.one", sys_created_on: updated, sys_updated_by: "dev.one", sys_updated_on: updated,
  });
  const instance = fakeInstance({
    metadata: [meta],
    sets: [setRow(1, { state: "in progress", name: "Open 1" }), setRow(2, { state: "in progress", name: "Open 2" })],
    xml: [capture(id(1), guid(1), "1", "2026-10-05 10:00:00"), capture(id(2), guid(2), "2", "2026-10-04 10:00:00")],
    versions: [
      versionRow(NAME, id(1), "current", guid(1), "1", "2026-10-05 10:00:00"),
      versionRow(NAME, id(2), "previous", guid(2), "2", "2026-10-04 10:00:00"),
    ],
  });
  const ctx = { origin: ORIGIN, transport: instance.transport };
  const session = sandbox.SNVersionLens.createSession(await sandbox.SNVersionLens.resolveRecord(id(77), "", ctx), ctx);
  await session.run();
  const harness = load();
  open(harness, plain(session.view()));
  const text = harness.text();
  assert.ok(text.includes("Potential collision: 2 open sets hold different versions of this record."));
  assert.ok(text.includes("“Open 2” holds a version that no longer runs here."));
  assert.ok(text.includes("Runs here: the version from “Open 1” (In progress)"));
  assert.deepStrictEqual(byClass(harness.shadow(), "group").map((node) => node.textContent), ["Open sets (2)"]);
  assert.deepStrictEqual(byClass(harness.shadow(), "r-name").map((node) => node.textContent), ["Open 1", "Open 2"]);
  assert.strictEqual(buttons(harness.shadow(), "Open newer set").length, 2, "on the A1 line and on the stale row");
});

/* ------------------------------------------------------------------ *
 * Step 6: Update Set Lens rows open Version Lens on their update's name
 * ------------------------------------------------------------------ */

test("an opened Update Set Lens row offers Other sets holding it, which hands the update's name to Version Lens", async () => {
  const harness = load([[USL_UI_SOURCE, "update_set_lens_ui.js"]]);
  const names = [];
  const uslRow = {
    key: "u1", sysId: id(1), name: NAME, type: "Script Include", target: "Approval utils", action: "Update", setId: id(2),
    verdict: "stale", reason: "", text: "Newer version in “Next”", flags: [], who: "", notes: [], links: [],
    asRetrieved: false, childSet: "", newerSetId: "", newerSetName: "", newerSetState: "",
  };
  const uslView = {
    phase: "done", busy: false, error: "", progress: "", retrieved: null,
    subject: { sysId: id(2), name: "Approval fix", stateLabel: "Complete", scope: "Global", createdBy: "dev.one", createdOn: "", isDefault: false, parentName: "", ownTotal: 1 },
    banners: [], batch: null, rows: [uslRow], totals: { checked: 1, total: 1, exact: true }, canContinue: false,
  };
  harness.usl.open({ view: uslView, origins: [], callbacks: { onOpenVersionLens: (name) => { names.push(name); return Promise.resolve({ ok: true }); } } });
  const shadow = harness.shadow("sn-dev-helper-update-set-lens");
  buttons(shadow, "Other sets holding it")[0].click();
  assert.deepStrictEqual(names, [NAME]);

  /* Without the callback the link is not offered at all. */
  const bare = load([[USL_UI_SOURCE, "update_set_lens_ui.js"]]);
  bare.usl.open({ view: uslView, origins: [], callbacks: {} });
  assert.strictEqual(buttons(bare.shadow("sn-dev-helper-update-set-lens"), "Other sets holding it").length, 0);
});

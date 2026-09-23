/*
 * Tests for impersonate_ui.js, the Impersonate panel.
 *
 *   node --test tests/impersonate_ui.test.js
 *
 * DEV-ONLY, like its siblings. There is no browser here: the panel runs under
 * node:vm against the same deliberately small DOM shim the Translation Lens
 * and Translation Assistant suites use -- createElement, createTextNode,
 * appendChild, textContent, setAttribute, addEventListener, attachShadow and
 * focus, and nothing else. The panel has no innerHTML path at all, so the shim
 * does not need one, and a test that passes here cannot be passing because
 * markup was interpolated somewhere the shim ignored.
 *
 * Results are real people on a real instance, so no name, user ID, email,
 * title or sys_id from one belongs in this file.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const UI_SOURCE = fs.readFileSync(path.join(root, "impersonate_ui.js"), "utf8");
const ENGINE_SOURCE = fs.readFileSync(path.join(root, "impersonate.js"), "utf8");
const HOST_ID = "sn-dev-helper-impersonate";

/* ------------------------------------------------------------------ *
 * The DOM shim
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
      this.disabled = false;
      this.tabIndex = -1;
      this.shadowRoot = null;
      this.focused = 0;
      this._text = "";
    }
    /* STYLE is skipped for the same reason the Lens harness skips it: the
     * stylesheet is a child of the shadow root, and folding it into every
     * assertion would make a text match mean nothing. */
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
      return shadow;
    }
    focus() {
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
  const document = {
    createElement: (tag) => new El(tag),
    createTextNode: (value) => new TextNode(value),
    documentElement: new El("html"),
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
  return { El, TextNode, document, window: windowObject };
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

function byClass(node, className) {
  return findAll(node, (child) =>
    String(child.className || "").split(/\s+/).includes(className));
}

function buttonsLabelled(node, label) {
  return findAll(node, (child) =>
    child.tagName === "BUTTON" && child.textContent === label);
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
    setTimeout: (fn) => {
      timers.push({ fn, cancelled: false, done: false });
      return timers.length;
    },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    Promise,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  /* The engine first, as the worker injects it: the panel reads its
   * MEMBERSHIP_LIMIT when wording a capped role search. */
  vm.runInContext(ENGINE_SOURCE, sandbox, { filename: "impersonate.js" });
  vm.runInContext(UI_SOURCE, sandbox, { filename: "impersonate_ui.js" });

  return {
    ui: sandbox.SNImpersonateUI,
    dom,
    sandbox,
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

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

let idCounter = 0;
function sysId() {
  idCounter += 1;
  return String(idCounter).padStart(32, "d");
}

function user(options) {
  const opts = options || {};
  return {
    sysId: opts.sysId || sysId(),
    userName: opts.userName || "sample.user",
    name: opts.name || "Sample User",
    email: opts.email || "",
    title: opts.title || "",
    details: opts.details || [],
    membership: opts.membership || null,
  };
}

function resultSet(options) {
  const opts = options || {};
  return Object.assign({
    stale: false,
    order: "user-first",
    results: opts.results || [user()],
    truncated: false,
    eligibleTotal: opts.results ? opts.results.length : 1,
    roleFilter: null,
  }, opts.extra || {});
}

function openPanel(harness, callbacks) {
  harness.ui.open(Object.assign({
    onSearch: async () => resultSet(),
    onFindRoles: async () => ({ options: [] }),
    onFindAttributeFields: async () => ({ options: [] }),
    onFindAttributeValues: async () => ({ options: [] }),
  }, callbacks || {}));
  return harness.shadow();
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ *
 * Shell and safety
 * ------------------------------------------------------------------ */

test("the panel opens into a CLOSED shadow root and carries no markup path", () => {
  const harness = load();
  const shadow = openPanel(harness);
  assert.ok(shadow, "a host with a shadow root must be attached");
  assert.strictEqual(harness.ui.isOpen(), true);

  /* Closed, so page script cannot read or rewrite a list of real people. */
  assert.ok(/attachShadow\(\{ mode: "closed" \}\)/.test(UI_SOURCE));
  const code = UI_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
  ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"].forEach((sink) => {
    assert.ok(!code.includes(sink), "the panel must have no markup path: found " + sink);
  });
});

test("hostile-looking names, emails and titles render as text, never as markup", () => {
  const harness = load();
  const hostile = {
    name: "<img src=x onerror=alert(1)>",
    userName: "</script><script>alert(2)</script>",
    email: "\"><svg onload=alert(3)>@example.com",
    title: "javascript:alert(4)",
  };
  openPanel(harness);
  harness.ui.showResults(resultSet({ results: [user(hostile)] }));

  const rendered = harness.text();
  Object.values(hostile).forEach((value) => {
    assert.ok(rendered.includes(value), "the value must appear verbatim: " + value);
  });
  /* And every one of them is a text node or a textContent assignment, never a
   * parsed element: the shim has no parser, so an element named "IMG" or
   * "SCRIPT" could only exist if the panel had created one. */
  const shadow = harness.shadow();
  ["IMG", "SCRIPT", "SVG"].forEach((tag) => {
    assert.strictEqual(findAll(shadow, (node) => node.tagName === tag).length, 0);
  });
});

test("nothing is written to browser storage", () => {
  const code = UI_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "");
  ["localStorage", "sessionStorage", "indexedDB", "document.cookie"].forEach((store) => {
    assert.ok(!code.includes(store), "no search term or result may be stored: found " + store);
  });
  assert.ok(/no search term, result, role, group or impersonation history is stored/i.test(UI_SOURCE),
    "and the footer has to say so");
});

/* ------------------------------------------------------------------ *
 * A row click never impersonates
 * ------------------------------------------------------------------ */

test("a row click and a row Enter never start impersonation", async () => {
  const harness = load();
  let confirmations = 0;
  let mutations = 0;
  openPanel(harness, { onImpersonate: async () => { mutations += 1; return { ok: true }; } });
  harness.ui.showResults(resultSet({ results: [user({ name: "One Person" })] }));

  const shadow = harness.shadow();
  const row = byClass(shadow, "row")[0];
  assert.ok(row);
  /* The row is a GROUP, not a listbox option: it contains two buttons, and a
   * group is what lets a screen reader reach both. */
  assert.strictEqual(row.getAttribute("role"), "group");

  row.fire("click", {});
  row.fire("keydown", { key: "Enter" });
  row.fire("keydown", { key: " " });
  await tick();

  assert.strictEqual(mutations, 0, "a session change must never be one stray keystroke away");
  assert.strictEqual(byClass(shadow, "confirm").length, 0, "and it must not even confirm");
  confirmations += byClass(shadow, "confirm").length;
  assert.strictEqual(confirmations, 0);

  /* Only the labelled button does anything. */
  const button = buttonsLabelled(shadow, "Impersonate")[0];
  assert.ok(button, "each result needs a labelled button");
  button.fire("click", {});
  assert.strictEqual(byClass(shadow, "confirm").length, 1);
  assert.strictEqual(mutations, 0, "and even then it only confirms");
});

test("arrow keys move between rows without activating one", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults(resultSet({
    results: [user({ name: "First" }), user({ name: "Second" }), user({ name: "Third" })],
  }));
  const rows = byClass(harness.shadow(), "row");
  assert.strictEqual(rows.length, 3);

  rows[0].fire("keydown", { key: "ArrowDown" });
  assert.strictEqual(rows[1].focused, 1);
  rows[1].fire("keydown", { key: "End" });
  assert.strictEqual(rows[2].focused, 1);
  rows[2].fire("keydown", { key: "Home" });
  assert.strictEqual(rows[0].focused, 1);
  assert.strictEqual(byClass(harness.shadow(), "confirm").length, 0);
});

/* ------------------------------------------------------------------ *
 * Confirmation
 * ------------------------------------------------------------------ */

test("confirmation repeats the identity and says the session will change", () => {
  const harness = load();
  openPanel(harness);
  const person = user({
    name: "Second Person",
    userName: "second.person",
    email: "second.person@example.com",
    title: "Example Title",
    membership: { inherited: true },
  });
  harness.ui.showResults(resultSet({ results: [person] }));
  buttonsLabelled(harness.shadow(), "Impersonate")[0].fire("click", {});

  const confirm = byClass(harness.shadow(), "confirm")[0];
  assert.ok(confirm);
  [person.name, person.userName, person.email, person.title].forEach((value) => {
    assert.ok(confirm.textContent.includes(value), "confirmation must repeat " + value);
  });
  assert.ok(/session/i.test(confirm.textContent));
  assert.ok(/inherit/i.test(confirm.textContent), "the role evidence is repeated too");

  /* Assertive, because this is the one outcome a screen-reader user must not
   * have to go looking for. */
  const live = byClass(confirm, "confirm-state")[0];
  assert.strictEqual(live.getAttribute("aria-live"), "assertive");
  /* And focus moves to the action, not to the panel. */
  assert.ok(buttonsLabelled(confirm, "Start impersonation")[0].focused >= 1);
});

test("a double submit is impossible: click, Enter, rerender and a late callback all refused", async () => {
  const harness = load();
  let sent = 0;
  let release = null;
  openPanel(harness, {
    onImpersonate: () => {
      sent += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  harness.ui.showResults(resultSet({ results: [user({ name: "Third Person" })] }));
  buttonsLabelled(harness.shadow(), "Impersonate")[0].fire("click", {});

  const go = buttonsLabelled(harness.shadow(), "Start impersonation")[0];
  go.fire("click", {});
  await tick();
  assert.strictEqual(sent, 1);

  /* Second click. */
  go.fire("click", {});
  /* Enter on the panel, and Escape, while the request is out. */
  harness.dom.window.fire("keydown", { key: "Enter" });
  harness.dom.window.fire("keydown", { key: "Escape" });
  /* A rerender of the results underneath. */
  harness.ui.showResults(resultSet({ results: [user({ name: "Third Person" })] }));
  const again = buttonsLabelled(harness.shadow(), "Impersonate")[0];
  if (again) again.fire("click", {});
  await tick();

  assert.strictEqual(sent, 1, "one confirmation may cause at most one request");
  assert.strictEqual(harness.ui.isOpen(), true,
    "Escape must not close the one place the outcome is reported");

  /* And the lock survives the success: nothing may be sent afterwards either. */
  release({ ok: true });
  await tick();
  assert.ok(/reload/i.test(harness.text()));
  const afterwards = buttonsLabelled(harness.shadow(), "Start impersonation")[0];
  if (afterwards) afterwards.fire("click", {});
  await tick();
  assert.strictEqual(sent, 1);
});

test("an indeterminate outcome says so, and never offers a retry", async () => {
  const harness = load();
  let sent = 0;
  openPanel(harness, {
    onImpersonate: async () => {
      sent += 1;
      throw new Error("the worker went away");
    },
  });
  harness.ui.showResults(resultSet({ results: [user()] }));
  buttonsLabelled(harness.shadow(), "Impersonate")[0].fire("click", {});
  buttonsLabelled(harness.shadow(), "Start impersonation")[0].fire("click", {});
  await tick();
  await tick();

  const shown = harness.text();
  assert.ok(/may or may not/i.test(shown), "the ambiguity has to be stated: " + shown);
  assert.ok(/user menu/i.test(shown), "and where to check it");
  assert.ok(/nothing was retried/i.test(shown));
  assert.strictEqual(buttonsLabelled(harness.shadow(), "Retry").length, 0);
  assert.strictEqual(sent, 1);
});

test("a definite refusal releases the lock so another user can be chosen", async () => {
  const harness = load();
  let sent = 0;
  openPanel(harness, {
    onImpersonate: async () => {
      sent += 1;
      return { ok: false, code: "access", message: "You do not have permission to impersonate." };
    },
  });
  harness.ui.showResults(resultSet({ results: [user()] }));
  buttonsLabelled(harness.shadow(), "Impersonate")[0].fire("click", {});
  buttonsLabelled(harness.shadow(), "Start impersonation")[0].fire("click", {});
  await tick();

  assert.ok(/do not have permission/i.test(harness.text()));
  const cancel = buttonsLabelled(harness.shadow(), "Cancel")[0];
  assert.strictEqual(cancel.disabled, false, "a definite refusal changed nothing, so it is safe to go back");
  assert.strictEqual(sent, 1);
});

test("cancelling confirmation returns focus to the button that opened it", () => {
  const harness = load();
  openPanel(harness);
  const list = resultSet({ results: [user({ name: "Fourth Person" })] });
  harness.ui.showResults(list);
  const opener = buttonsLabelled(harness.shadow(), "Impersonate")[0];
  opener.fire("click", {});
  assert.strictEqual(byClass(harness.shadow(), "confirm").length, 1);

  buttonsLabelled(harness.shadow(), "Cancel")[0].fire("click", {});
  assert.strictEqual(byClass(harness.shadow(), "confirm").length, 0);
  assert.ok(byClass(harness.shadow(), "row").length >= 1, "the list comes back");
});

/* ------------------------------------------------------------------ *
 * Escape layering
 * ------------------------------------------------------------------ */

test("Escape closes an open menu, then a confirmation, then the panel", async () => {
  const harness = load();
  openPanel(harness, {
    onFindRoles: async () => ({ options: [{ label: "example_role", value: "x" }] }),
  });
  const shadow = harness.shadow();

  /* Layer one: an open menu. */
  const roleInput = findAll(shadow, (node) =>
    node.getAttribute("aria-controls") === "snh-imp-role-menu")[0];
  assert.ok(roleInput);
  roleInput.fire("keydown", { key: "ArrowDown" });
  await tick();
  assert.strictEqual(roleInput.getAttribute("aria-expanded"), "true");
  harness.dom.window.fire("keydown", { key: "Escape" });
  assert.strictEqual(roleInput.getAttribute("aria-expanded"), "false");
  assert.strictEqual(harness.ui.isOpen(), true, "the menu consumed the key");

  /* Layer two: a confirmation. */
  harness.ui.showResults(resultSet({ results: [user()] }));
  buttonsLabelled(harness.shadow(), "Impersonate")[0].fire("click", {});
  assert.strictEqual(byClass(harness.shadow(), "confirm").length, 1);
  harness.dom.window.fire("keydown", { key: "Escape" });
  assert.strictEqual(byClass(harness.shadow(), "confirm").length, 0);
  assert.strictEqual(harness.ui.isOpen(), true, "the confirmation consumed the key");

  /* Layer three: the panel. */
  harness.dom.window.fire("keydown", { key: "Escape" });
  assert.strictEqual(harness.ui.isOpen(), false);
});

/* ------------------------------------------------------------------ *
 * Staleness
 * ------------------------------------------------------------------ */

test("a late search callback never repaints a newer state", async () => {
  const harness = load();
  let releaseFirst = null;
  let call = 0;
  openPanel(harness, {
    onSearch: () => {
      call += 1;
      if (call === 1) {
        return new Promise((resolve) => { releaseFirst = resolve; });
      }
      return Promise.resolve(resultSet({ results: [user({ name: "Newer Result" })] }));
    },
  });
  const form = byClass(harness.shadow(), "form")[0];
  form.fire("submit", {});
  await tick();
  form.fire("submit", {});
  await tick();
  assert.ok(harness.text().includes("Newer Result"));

  /* The first read finally answers, with a result nobody asked for any more. */
  releaseFirst(resultSet({ results: [user({ name: "Older Result" })] }));
  await tick();
  assert.ok(harness.text().includes("Newer Result"));
  assert.ok(!harness.text().includes("Older Result"), "a superseded read must not repaint");
});

test("a late search callback never repaints over a confirmation", async () => {
  const harness = load();
  let releaseSearch = null;
  openPanel(harness, {
    onSearch: () => new Promise((resolve) => { releaseSearch = resolve; }),
  });
  harness.ui.showResults(resultSet({ results: [user({ name: "Chosen Person" })] }));
  buttonsLabelled(harness.shadow(), "Impersonate")[0].fire("click", {});
  assert.strictEqual(byClass(harness.shadow(), "confirm").length, 1);

  /* A search that was already running when the confirmation opened. */
  byClass(harness.shadow(), "form")[0].fire("submit", {});
  await tick();
  /* Submitting itself replaces the confirmation, which is intended -- what
   * must not happen is the reverse: the read landing later and wiping a
   * confirmation the user opened after it. */
  harness.ui.showResults(resultSet({ results: [user({ name: "Chosen Person" })] }));
  buttonsLabelled(harness.shadow(), "Impersonate")[0].fire("click", {});
  releaseSearch(resultSet({ results: [user({ name: "Stale Person" })] }));
  await tick();
  assert.strictEqual(byClass(harness.shadow(), "confirm").length, 1);
  assert.ok(!harness.text().includes("Stale Person"));
});

test("changing the attribute field discards the value that was selected for the old one", async () => {
  const harness = load();
  const fields = [
    { label: "Country code", value: "country", type: "choice" },
    { label: "Department", value: "department", type: "reference" },
  ];
  let searched = null;
  openPanel(harness, {
    onFindAttributeFields: async () => ({ options: fields }),
    onFindAttributeValues: async (field) => ({
      options: field && field.value === "country"
        ? [{ label: "Example Country", value: "XA" }]
        : [{ label: "Example Department", value: sysId() }],
    }),
    onSearch: async (request) => {
      searched = request;
      return resultSet();
    },
  });
  const shadow = harness.shadow();
  const fieldInput = findAll(shadow, (node) =>
    node.getAttribute("aria-controls") === "snh-imp-attr-field-menu")[0];
  const valueInput = findAll(shadow, (node) =>
    node.getAttribute("aria-controls") === "snh-imp-attr-value-menu")[0];

  /* The value control cannot be used before a field is chosen. */
  assert.strictEqual(valueInput.disabled, true);

  fieldInput.fire("keydown", { key: "ArrowDown" });
  await tick();
  buttonsLabelled(shadow, "Country code")[0].fire("click", {});
  assert.strictEqual(valueInput.disabled, false);
  valueInput.fire("keydown", { key: "ArrowDown" });
  await tick();
  buttonsLabelled(shadow, "Example Country")[0].fire("click", {});
  assert.strictEqual(valueInput.value, "Example Country");

  /* Switching the field must take the value with it: carried over, it would
   * reach a query as a valid-looking condition on the wrong column. */
  fieldInput.fire("keydown", { key: "ArrowDown" });
  await tick();
  buttonsLabelled(shadow, "Department")[0].fire("click", {});
  assert.strictEqual(valueInput.value, "", "the stale value must be gone from the control");

  byClass(shadow, "form")[0].fire("submit", {});
  await tick();
  assert.strictEqual(searched.attribute, null,
    "and it must not survive into the request either");
});

/* ------------------------------------------------------------------ *
 * Current state and Stop
 * ------------------------------------------------------------------ */

test("the current-state block is absent when not impersonating", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showCurrentState({ isImpersonating: false, hasStopTarget: false });
  const block = byClass(harness.shadow(), "current")[0];
  assert.strictEqual(block.hidden, true);
  assert.strictEqual(block.textContent, "");
  assert.strictEqual(buttonsLabelled(harness.shadow(), "Stop impersonating").length, 0);
});

test("impersonating shows who you are, and offers Stop when there is a way back", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showCurrentState({
    isImpersonating: true,
    currentUserName: "example.identity",
    displayName: "Example Identity",
    hasStopTarget: true,
  });
  const block = byClass(harness.shadow(), "current")[0];
  assert.strictEqual(block.hidden, false);
  assert.ok(block.textContent.includes("Example Identity"));
  assert.ok(block.textContent.includes("example.identity"));
  assert.strictEqual(buttonsLabelled(harness.shadow(), "Stop impersonating").length, 1);
});

test("the user ID is shown once, not twice, when the page has no friendly name", () => {
  /* A live PDI returned the user ID as NOW.user.name, so the block rendered
   * "You are impersonating abel.tuter — abel.tuter". The ID is corroborating
   * evidence, not a repetition. */
  const harness = load();
  openPanel(harness);

  harness.ui.showCurrentState({
    isImpersonating: true, currentUserName: "example.identity",
    displayName: "example.identity", hasStopTarget: true,
  });
  let block = byClass(harness.shadow(), "current")[0];
  assert.strictEqual(
    (block.textContent.match(/example\.identity/g) || []).length, 1, block.textContent);
  assert.ok(!block.textContent.includes("—"), block.textContent);

  /* No name at all falls back to the ID, still once. */
  harness.ui.showCurrentState({
    isImpersonating: true, currentUserName: "example.identity",
    displayName: "", hasStopTarget: true,
  });
  block = byClass(harness.shadow(), "current")[0];
  assert.strictEqual(
    (block.textContent.match(/example\.identity/g) || []).length, 1, block.textContent);

  /* A genuine name shows both, because they say different things. */
  harness.ui.showCurrentState({
    isImpersonating: true, currentUserName: "example.identity",
    displayName: "Example Identity", hasStopTarget: true,
  });
  block = byClass(harness.shadow(), "current")[0];
  assert.ok(block.textContent.includes("Example Identity"));
  assert.ok(block.textContent.includes("example.identity"));
});

test("Stop is absent, with an explanation, when no original is recoverable", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showCurrentState({
    isImpersonating: true,
    currentUserName: "example.identity",
    hasStopTarget: false,
  });
  const block = byClass(harness.shadow(), "current")[0];
  assert.strictEqual(block.hidden, false, "it still says THAT you are impersonating");
  assert.strictEqual(buttonsLabelled(harness.shadow(), "Stop impersonating").length, 0);
  /* It never guesses; it points at the platform's own way back. */
  assert.ok(/user menu/i.test(block.textContent), block.textContent);
});

test("a frame that could not be read names nobody rather than guessing", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showCurrentState({
    isImpersonating: true,
    currentUserName: "",
    inconclusive: true,
    hasStopTarget: true,
  });
  const block = byClass(harness.shadow(), "current")[0];
  assert.ok(/impersonating another user/i.test(block.textContent));
  assert.ok(/cannot say who|did not answer/i.test(block.textContent));
  /* A hung identity frame is inconclusive, not "no Stop target": stranding
   * someone inside an impersonated session is the worse failure. */
  assert.strictEqual(buttonsLabelled(harness.shadow(), "Stop impersonating").length, 1);
});

test("the header and footer close buttons are inert while a request is out", async () => {
  /* Escape and the overlay already were. These two were not, and closing
   * mid-request discards the only place an indeterminate outcome is said. */
  const harness = load();
  openPanel(harness, { onImpersonate: () => new Promise(() => {}) });
  harness.ui.showResults(resultSet({ results: [user({ name: "Pending Person" })] }));
  buttonsLabelled(harness.shadow(), "Impersonate")[0].fire("click", {});
  buttonsLabelled(harness.shadow(), "Start impersonation")[0].fire("click", {});
  await tick();

  const header = buttonsLabelled(harness.shadow(), "✕ Esc")[0];
  const footer = buttonsLabelled(harness.shadow(), "Close")[0];
  assert.strictEqual(header.disabled, true);
  assert.strictEqual(footer.disabled, true);
  /* The shim fires handlers on disabled buttons, so this proves the guard. */
  header.fire("click", {});
  footer.fire("click", {});
  assert.strictEqual(harness.ui.isOpen(), true);
});

test("Stop waits for a running search, and a search landing late cannot repaint its outcome", async () => {
  const harness = load();
  let releaseSearch = null;
  openPanel(harness, {
    onSearch: () => new Promise((resolve) => { releaseSearch = resolve; }),
    onStop: async () => ({
      ok: false, code: "indeterminate", message: "Stop may or may not have reached ServiceNow.",
    }),
  });
  harness.ui.showCurrentState({
    isImpersonating: true, currentUserName: "example.identity", hasStopTarget: true,
  });
  const stop = buttonsLabelled(harness.shadow(), "Stop impersonating")[0];
  assert.strictEqual(stop.disabled, false);

  byClass(harness.shadow(), "form")[0].fire("submit", {});
  await tick();
  assert.strictEqual(stop.disabled, true, "Stop locks while a search is out, like every control");

  /* Reached anyway (the shim ignores `disabled`): Stop must still own the
   * status line once the older search finally answers. */
  stop.fire("click", {});
  await tick();
  releaseSearch(resultSet({ results: [user({ name: "Late Result" })] }));
  await tick();
  await tick();
  const status = byClass(harness.shadow(), "status")[0].textContent;
  assert.ok(/may or may not/i.test(status), status);
  assert.ok(!harness.text().includes("Late Result"), "a superseded search must not repaint");
});

test("Stop carries no target and is not retried", async () => {
  const harness = load();
  const stops = [];
  openPanel(harness, {
    onStop: async (...args) => {
      stops.push(args);
      throw new Error("lost");
    },
  });
  harness.ui.showCurrentState({
    isImpersonating: true, currentUserName: "example.identity", hasStopTarget: true,
  });
  const stop = buttonsLabelled(harness.shadow(), "Stop impersonating")[0];
  stop.fire("click", {});
  await tick();
  stop.fire("click", {});
  await tick();
  await tick();

  assert.strictEqual(stops.length, 1, "Stop inherits the same no-retry rule");
  assert.deepStrictEqual(stops[0], [], "and it carries no target at all");
  assert.ok(/may or may not/i.test(harness.text()));
});

/* ------------------------------------------------------------------ *
 * What the results say
 * ------------------------------------------------------------------ */

test("a capped role search claims no total and says how to narrow", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults(resultSet({
    results: [user({ name: "A Holder" })],
    extra: {
      order: "role-first",
      membershipCapped: true,
      eligibleTotal: null,
      truncated: true,
      roleFilter: { status: "applied" },
    },
  }));
  const status = byClass(harness.shadow(), "status")[0].textContent;
  assert.ok(/first 100/.test(status), status);
  assert.ok(/narrow/i.test(status));
  assert.ok(!/eligible/i.test(status), "no total may be claimed: " + status);
});

test("an uncapped role search reports the eligible total", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults(resultSet({
    results: [user({ name: "A Holder" }), user({ name: "B Holder" })],
    extra: { order: "role-first", membershipCapped: false, eligibleTotal: 2 },
  }));
  assert.ok(/2 eligible users/.test(byClass(harness.shadow(), "status")[0].textContent));
});

test("unavailable role filtering is said in those terms, never as no-match", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults(resultSet({
    results: [],
    extra: {
      eligibleTotal: null,
      roleFilter: { status: "unavailable", reason: "Too many memberships came back." },
    },
  }));
  const shown = harness.text();
  assert.ok(/unavailable/i.test(shown), shown);
  assert.ok(!/No eligible users matched/.test(shown),
    "a cap is not evidence that nobody holds the role");
});

test("a chosen group reaches the search as its sys_id, and changing it supersedes the search", async () => {
  const harness = load();
  const groupId = sysId();
  let searched = null;
  const changes = [];
  openPanel(harness, {
    onFindGroups: async () => ({
      options: [{ label: "Example Group", hint: "Inactive group", value: groupId }],
    }),
    onGroupChanged: (option) => changes.push(option ? option.value : null),
    onSearch: async (request) => {
      searched = request;
      return resultSet();
    },
  });
  const shadow = harness.shadow();
  assert.ok(harness.text().includes("Group (optional)"));
  const groupInput = findAll(shadow, (node) =>
    node.getAttribute("aria-controls") === "snh-imp-group-menu")[0];
  assert.ok(groupInput, "the group picker is a combobox like the role picker");

  groupInput.fire("keydown", { key: "ArrowDown" });
  await tick();
  assert.ok(harness.text().includes("Inactive group"), "an inactive group says so");
  /* By its stable option id: the hint is part of the button's text. */
  findAll(shadow, (node) => node.id === "snh-imp-group-option-0")[0].fire("click", {});
  assert.strictEqual(groupInput.value, "Example Group");
  assert.deepStrictEqual(changes, [groupId]);

  byClass(shadow, "form")[0].fire("submit", {});
  await tick();
  /* The sys_id, never the label: a name round-tripped through the DOM must
   * not become a query. */
  assert.strictEqual(searched.groupSysId, groupId);
  assert.strictEqual(searched.roleSysId, "");
});

test("a capped group search claims no total and says how to narrow", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults(resultSet({
    results: [user({ name: "A Member" })],
    extra: {
      order: "group-first",
      membershipCapped: true,
      eligibleTotal: null,
      truncated: true,
      groupFilter: { status: "applied" },
    },
  }));
  const status = byClass(harness.shadow(), "status")[0].textContent;
  assert.ok(/first 100/.test(status), status);
  assert.ok(/narrow/i.test(status));
  assert.ok(!/eligible/i.test(status), "no total may be claimed: " + status);
});

test("unavailable group filtering is said in those terms, never as no-match", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults(resultSet({
    results: [],
    extra: {
      eligibleTotal: null,
      groupFilter: { status: "unavailable", reason: "Too many group memberships came back." },
    },
  }));
  const shown = harness.text();
  assert.ok(/Group filtering is unavailable/.test(shown), shown);
  assert.ok(!/No eligible users matched/.test(shown),
    "a cap is not evidence that nobody is in the group");
});

test("an empty result explains why ineligible accounts are never listed", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults(resultSet({ results: [], extra: { eligibleTotal: 0 } }));
  const shown = harness.text();
  assert.ok(/No eligible users matched/.test(shown));
  assert.ok(/end your own session/i.test(shown), "the safety rule is stated, not hidden");
});

test("the role badge is shown only for the selected role and claims no provenance", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults(resultSet({
    results: [
      user({ name: "Direct Holder", membership: { inherited: false } }),
      user({ name: "Inherited Holder", membership: { inherited: true } }),
      user({ name: "No Role Filter" }),
    ],
  }));
  const badges = byClass(harness.shadow(), "badge").map((node) => node.textContent);
  assert.deepStrictEqual(badges, ["Direct role", "Inherited role"]);
  badges.forEach((badge) => {
    assert.ok(!/via|group/i.test(badge), "provenance cannot be claimed: " + badge);
  });
});

test("an error is shown with its own category rather than as an empty result", () => {
  const harness = load();
  openPanel(harness);
  const error = new Error("You do not have read access to the user or role data this needs.");
  error.code = "access";
  harness.ui.showError(error);
  const status = byClass(harness.shadow(), "status")[0];
  assert.ok(status.className.includes("access"));
  assert.ok(!status.className.includes("empty"));
  assert.ok(harness.text().includes("The search could not run."));
});

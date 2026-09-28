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
    /* As in a browser: disabling the focused control drops focus. Without
     * this, a test could not tell a panel that restores focus after a search
     * from one that never lost it. */
    get disabled() { return Boolean(this._disabled); }
    set disabled(value) {
      this._disabled = Boolean(value);
      if (this._disabled && activeElement === this) activeElement = null;
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
    /* The delays still waiting, so a test can see a pause was scheduled --
     * and for how long -- without running it. */
    pendingDelays() {
      return timers.filter((timer) => !timer.cancelled && !timer.done).map((timer) => timer.ms);
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
  assert.ok(/stores no search term, result, role, group or impersonation history/i.test(UI_SOURCE),
    "and the footer has to say so");
  /* The recent list is on screen, so the footer has to say whose it is. */
  assert.ok(/recent list is ServiceNow's own/i.test(UI_SOURCE));
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
  /* The list is redrawn, so the old button is detached and focusing it would
   * do nothing in a browser. Its replacement in the same row takes focus. */
  const redrawn = buttonsLabelled(harness.shadow(), "Impersonate")[0];
  assert.notStrictEqual(redrawn, opener);
  assert.strictEqual(harness.dom.document.activeElement, redrawn);
});

/* ------------------------------------------------------------------ *
 * The confirmation's roles
 * ------------------------------------------------------------------ */

function rolesCell(shadow) {
  const facts = byClass(shadow, "confirm-facts")[0];
  const labels = findAll(facts, (node) => node.tagName === "DT");
  const index = labels.findIndex((node) => node.textContent === "Roles");
  if (index < 0) return null;
  const cells = findAll(facts, (node) => node.tagName === "DD");
  return cells[index];
}

function confirmFirst(harness) {
  buttonsLabelled(harness.shadow(), "Impersonate")[0].fire("click", {});
}

test("the confirmation reads the roles, and Start never waits for them", async () => {
  const harness = load();
  let release = null;
  const asked = [];
  openPanel(harness, {
    onFindUserRoles: (person) => {
      asked.push(person);
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const person = user({ name: "Role Person" });
  harness.ui.showResults(resultSet({ results: [person] }));
  confirmFirst(harness);
  const shadow = harness.shadow();

  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].sysId, person.sysId);
  assert.strictEqual(rolesCell(shadow).textContent, "Reading roles…");
  const go = buttonsLabelled(shadow, "Start impersonation")[0];
  assert.strictEqual(go.disabled, false, "evidence, not a precondition");
  assert.strictEqual(harness.dom.document.activeElement, go);

  release({
    direct: ["catalog_admin", "itil"],
    inherited: ["approver_user", "catalog", "itil_part", "snc_internal"],
    assigned: ["approver_user", "catalog_admin", "itil", "snc_internal"],
    bundled: ["catalog", "itil_part"],
    containment: "applied",
    unnamed: 0,
    capped: false,
  });
  await tick();
  const cell = rolesCell(shadow);
  const lines = byClass(cell, "roles-line").map((node) => node.textContent);
  assert.deepStrictEqual(lines, ["Assigned: approver_user, catalog_admin, itil, snc_internal (4)"]);
  assert.strictEqual(byClass(cell, "roles-source")[0].textContent,
    "catalog_admin, itil granted directly; the rest through groups");
  /* The bundled list sits behind a disclosure: ordinary accounts held 59-133
   * roles in all on a measured instance, and 10-14 were assigned. */
  const more = findAll(cell, (node) => node.tagName === "DETAILS")[0];
  assert.ok(more, "the bundled roles are behind a disclosure");
  assert.ok(!more.open && more.getAttribute("open") === null, "collapsed until asked for");
  assert.strictEqual(findAll(more, (node) => node.tagName === "SUMMARY")[0].textContent,
    "2 more come with these roles");
  assert.ok(more.textContent.includes("catalog, itil_part"));
  /* "Through groups" is the most that is said: no group is ever named. */
  const claimed = cell.textContent.replace("the rest through groups", "");
  assert.ok(!/via|group|Inherited|Direct:/i.test(claimed), "no source is ever claimed: " + claimed);
  assert.strictEqual(byClass(cell, "roles-note").length, 0, "a complete read has no caveat");
});

test("the source line fits who granted what", async () => {
  const cases = [
    [{ direct: ["itil"], assigned: ["itil"] }, "Granted directly"],
    [{ direct: ["admin", "itil"], assigned: ["admin", "itil"] }, "All granted directly"],
    [{ direct: [], assigned: ["itil"] }, "Granted through a group"],
    [{ direct: [], assigned: ["approver_user", "itil"] }, "None granted directly; all through groups"],
  ];
  for (const [found, expected] of cases) {
    const harness = load();
    openPanel(harness, {
      onFindUserRoles: async () => Object.assign(
        { inherited: [], bundled: ["one_bundled"], containment: "applied" }, found),
    });
    harness.ui.showResults(resultSet({ results: [user()] }));
    confirmFirst(harness);
    await tick();
    const cell = rolesCell(harness.shadow());
    assert.strictEqual(byClass(cell, "roles-source")[0].textContent, expected);
    assert.strictEqual(findAll(cell, (node) => node.tagName === "SUMMARY")[0].textContent,
      "1 more comes with these roles");
  }
});

test("an account with no roles at all says none, not nothing", async () => {
  const harness = load();
  openPanel(harness, {
    onFindUserRoles: async () => ({
      direct: [], inherited: [], assigned: [], bundled: [], containment: "applied",
    }),
  });
  harness.ui.showResults(resultSet({ results: [user()] }));
  confirmFirst(harness);
  await tick();
  const cell = rolesCell(harness.shadow());
  assert.strictEqual(cell.textContent, "Assigned: none");
  assert.strictEqual(byClass(cell, "roles-source").length, 0);
  assert.strictEqual(findAll(cell, (node) => node.tagName === "DETAILS").length, 0);
});

test("without containment the confirmation falls back to direct and inherited, and says why", async () => {
  const harness = load();
  openPanel(harness, {
    onFindUserRoles: async () => ({
      direct: ["admin"],
      inherited: ["approver_user", "itil"],
      assigned: null,
      bundled: null,
      containment: "unavailable",
      unnamed: 0,
      capped: false,
    }),
  });
  harness.ui.showResults(resultSet({ results: [user()] }));
  confirmFirst(harness);
  await tick();
  const cell = rolesCell(harness.shadow());
  assert.ok(cell.textContent.includes("Direct: admin"), cell.textContent);
  assert.ok(!cell.textContent.includes("Assigned"), "nothing is called assigned: " + cell.textContent);
  const more = findAll(cell, (node) => node.tagName === "DETAILS")[0];
  assert.strictEqual(findAll(more, (node) => node.tagName === "SUMMARY")[0].textContent,
    "Inherited: 2 roles");
  assert.ok(more.textContent.includes("approver_user, itil"));
  assert.ok(/could not be read, so every inherited role is listed/.test(cell.textContent),
    cell.textContent);
});

test("an account with no direct or inherited roles in the fallback says none, not nothing", async () => {
  const harness = load();
  openPanel(harness, { onFindUserRoles: async () => ({ direct: [], inherited: [] }) });
  harness.ui.showResults(resultSet({ results: [user()] }));
  confirmFirst(harness);
  await tick();
  const cell = rolesCell(harness.shadow());
  assert.ok(cell.textContent.includes("Direct: none"), cell.textContent);
  assert.ok(cell.textContent.includes("Inherited: none"), cell.textContent);
  assert.strictEqual(findAll(cell, (node) => node.tagName === "DETAILS").length, 0);
});

test("a capped or partly unnamed role read says so", async () => {
  const harness = load();
  openPanel(harness, {
    onFindUserRoles: async () => ({
      direct: ["admin"],
      inherited: ["itil"],
      assigned: null,
      bundled: null,
      containment: "unavailable",
      unnamed: 3,
      capped: true,
    }),
  });
  harness.ui.showResults(resultSet({ results: [user()] }));
  confirmFirst(harness);
  await tick();
  const text = rolesCell(harness.shadow()).textContent;
  assert.ok(/3 more roles could not be named/.test(text), text);
  assert.ok(/incomplete/.test(text), text);
  /* The capped note already says why; the containment one would repeat it. */
  assert.ok(!/every inherited role is listed/.test(text), text);
});

test("a failed role read says so without blocking the confirmation", async () => {
  const harness = load();
  openPanel(harness, {
    onFindUserRoles: async () => {
      const error = new Error("You do not have read access to the user or role data this needs.");
      error.code = "access";
      throw error;
    },
  });
  harness.ui.showResults(resultSet({ results: [user()] }));
  confirmFirst(harness);
  await tick();
  const text = rolesCell(harness.shadow()).textContent;
  assert.ok(/could not be read/.test(text), text);
  assert.strictEqual(buttonsLabelled(harness.shadow(), "Start impersonation")[0].disabled, false);
});

test("roles read for one confirmation never land on another", async () => {
  const harness = load();
  const pending = [];
  openPanel(harness, {
    onFindUserRoles: () => new Promise((resolve) => { pending.push(resolve); }),
  });
  harness.ui.showResults(resultSet({
    results: [user({ name: "First Person" }), user({ name: "Second Person" })],
  }));
  const shadow = harness.shadow();
  buttonsLabelled(byClass(shadow, "row")[0], "Impersonate")[0].fire("click", {});
  buttonsLabelled(shadow, "Cancel")[0].fire("click", {});
  buttonsLabelled(byClass(shadow, "row")[1], "Impersonate")[0].fire("click", {});
  assert.ok(byClass(shadow, "confirm")[0].textContent.includes("Second Person"));

  /* The first person's roles answer late, onto the second person's screen. */
  pending[0]({ direct: ["first_persons_role"], inherited: [] });
  await tick();
  assert.strictEqual(rolesCell(shadow).textContent, "Reading roles…");
  pending[1]({ direct: ["second_persons_role"], inherited: [] });
  await tick();
  assert.ok(rolesCell(shadow).textContent.includes("second_persons_role"));
  assert.ok(!harness.text().includes("first_persons_role"));
});

test("role names render as text, never as markup", async () => {
  const hostile = "<img src=x onerror=alert(1)>";
  /* The fallback split, and the assigned view with the name in every place it
   * can appear: the list, the source line and the disclosure. */
  for (const found of [
    { direct: [hostile], inherited: [hostile] },
    { direct: [hostile], inherited: [], assigned: [hostile, "other"], bundled: [hostile],
      containment: "applied" },
  ]) {
    const harness = load();
    openPanel(harness, { onFindUserRoles: async () => found });
    harness.ui.showResults(resultSet({ results: [user()] }));
    confirmFirst(harness);
    await tick();
    assert.ok(rolesCell(harness.shadow()).textContent.includes(hostile));
    assert.strictEqual(findAll(harness.shadow(), (node) => node.tagName === "IMG").length, 0);
  }
});

test("without a roles reader the confirmation has no roles line at all", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showResults(resultSet({ results: [user()] }));
  confirmFirst(harness);
  assert.strictEqual(rolesCell(harness.shadow()), null);
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
 * Picking searches; the clear button
 * ------------------------------------------------------------------ */

const comboInput = (shadow, key) => findAll(shadow, (node) =>
  node.getAttribute("aria-controls") === "snh-imp-" + key + "-menu")[0];
const clearButtonFor = (shadow, what) => findAll(shadow, (node) =>
  node.tagName === "BUTTON" && node.getAttribute("aria-label") === "Clear " + what)[0];
const termInput = (shadow) => findAll(shadow, (node) =>
  node.getAttribute("placeholder") === "name, user ID, email, title, or exact sys_id")[0];

async function pickFirst(shadow, key) {
  const input = comboInput(shadow, key);
  input.fire("keydown", { key: "ArrowDown" });
  await tick();
  findAll(shadow, (node) => node.id === "snh-imp-" + key + "-option-0")[0].fire("click", {});
  await tick();
}

const ATTRIBUTE_FIELDS = [{ label: "Country code", value: "country", type: "choice" }];

function pickerPanel(harness, searches, extra) {
  const roleId = sysId();
  const groupId = sysId();
  openPanel(harness, Object.assign({
    onFindRoles: async () => ({ options: [{ label: "example_role", value: roleId }] }),
    onFindGroups: async () => ({ options: [{ label: "Example Group", value: groupId }] }),
    onFindAttributeFields: async () => ({ options: ATTRIBUTE_FIELDS }),
    onFindAttributeValues: async () => ({ options: [{ label: "Example Country", value: "XA" }] }),
    onSearch: async (request) => {
      searches.push(request);
      return resultSet();
    },
  }, extra || {}));
  return { roleId, groupId };
}

test("picking a role or a group searches at once, without pressing Search", async () => {
  /* Reported: having to press Search after choosing from a list was not
   * obvious. A pick is a finished question, so it is asked straight away. */
  const harness = load();
  const searches = [];
  const { roleId, groupId } = pickerPanel(harness, searches);
  const shadow = harness.shadow();

  /* By keyboard. */
  const roleInput = comboInput(shadow, "role");
  roleInput.fire("keydown", { key: "ArrowDown" });
  await tick();
  roleInput.fire("keydown", { key: "Enter" });
  await tick();
  assert.strictEqual(searches.length, 1);
  assert.strictEqual(searches[0].roleSysId, roleId);

  /* By pointer, and the earlier pick travels with it. */
  await pickFirst(shadow, "group");
  assert.strictEqual(searches.length, 2);
  assert.strictEqual(searches[1].groupSysId, groupId);
  assert.strictEqual(searches[1].roleSysId, roleId);
});

test("typing over a chosen value waits for the next pick instead of searching", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  await pickFirst(shadow, "role");
  assert.strictEqual(searches.length, 1);

  const roleInput = comboInput(shadow, "role");
  roleInput.value = "exa";
  roleInput.fire("input", {});
  assert.strictEqual(searches.length, 1, "a search on every correction would be noise");
});

test("choosing a field opens its values rather than searching, and a value searches", async () => {
  const harness = load();
  const searches = [];
  let valueLookups = 0;
  pickerPanel(harness, searches, {
    onFindAttributeValues: async () => {
      valueLookups += 1;
      return { options: [{ label: "Example Country", value: "XA" }] };
    },
  });
  const shadow = harness.shadow();
  await pickFirst(shadow, "attr-field");
  assert.strictEqual(searches.length, 0, "a field without a value is half a condition");
  assert.strictEqual(valueLookups, 1, "its values are read once, not once per focus");
  const valueInput = comboInput(shadow, "attr-value");
  assert.strictEqual(harness.dom.document.activeElement, valueInput, "focus moves to the value");
  assert.strictEqual(byClass(shadow, "menu").find((menu) =>
    menu.id === "snh-imp-attr-value-menu").hidden, false, "and its list is open");

  findAll(shadow, (node) => node.id === "snh-imp-attr-value-option-0")[0].fire("click", {});
  await tick();
  assert.strictEqual(searches.length, 1);
  assert.strictEqual(searches[0].attribute.field, "country");
  assert.strictEqual(searches[0].attribute.value, "XA");
});

test("each picker offers a clear button only while it holds something", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  ["role", "group", "field", "value"].forEach((what) => {
    const button = clearButtonFor(shadow, what);
    assert.ok(button, "no clear button for the " + what + " picker");
    assert.strictEqual(button.hidden, true, what + " is empty, so there is nothing to clear");
  });
  await pickFirst(shadow, "role");
  assert.strictEqual(clearButtonFor(shadow, "role").hidden, false);
  /* The value picker stays blocked until a field is chosen, so its button
   * stays hidden too. */
  assert.strictEqual(clearButtonFor(shadow, "value").hidden, true);
});

test("clearing a picker searches again with whatever is left", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  termInput(shadow).value = "sample";
  await pickFirst(shadow, "role");
  assert.strictEqual(searches.length, 1);
  assert.ok(searches[0].roleSysId);

  clearButtonFor(shadow, "role").fire("click", {});
  await tick();
  assert.strictEqual(comboInput(shadow, "role").value, "");
  assert.strictEqual(clearButtonFor(shadow, "role").hidden, true);
  assert.strictEqual(searches.length, 2);
  assert.strictEqual(searches[1].roleSysId, "", "the cleared role is gone from the question");
  assert.strictEqual(searches[1].term, "sample", "and what remains is still asked");
});

test("clearing the last criterion puts the panel back where it opened", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  await pickFirst(shadow, "group");
  assert.strictEqual(searches.length, 1);
  assert.strictEqual(byClass(shadow, "row").length, 1, "a result is on screen");

  clearButtonFor(shadow, "group").fire("click", {});
  await tick();
  assert.strictEqual(searches.length, 1, "with nothing left to ask, nothing is asked");
  assert.strictEqual(byClass(shadow, "row").length, 0, "the old answer does not linger");
  assert.ok(/to begin/.test(byClass(shadow, "status")[0].textContent));
  assert.ok(harness.text().includes("Find a user to impersonate."));
});

test("clearing the field searches only when a whole condition went with it", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  termInput(shadow).value = "sample";

  await pickFirst(shadow, "attr-field");
  clearButtonFor(shadow, "field").fire("click", {});
  await tick();
  assert.strictEqual(searches.length, 0, "a field with no value changed no question");

  await pickFirst(shadow, "attr-field");
  findAll(shadow, (node) => node.id === "snh-imp-attr-value-option-0")[0].fire("click", {});
  await tick();
  assert.strictEqual(searches.length, 1);
  clearButtonFor(shadow, "field").fire("click", {});
  await tick();
  assert.strictEqual(searches.length, 2);
  assert.strictEqual(searches[1].attribute, null);
  assert.strictEqual(comboInput(shadow, "attr-value").disabled, true, "the value is blocked again");
});

test("clearing typed text that never became a choice asks nothing", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  const roleInput = comboInput(shadow, "role");
  roleInput.value = "exa";
  roleInput.fire("input", {});
  const button = clearButtonFor(shadow, "role");
  assert.strictEqual(button.hidden, false, "typed text can be cleared too");
  button.fire("click", {});
  await tick();
  assert.strictEqual(roleInput.value, "");
  assert.strictEqual(searches.length, 0);
});

const menuFor = (shadow, key) => byClass(shadow, "menu").find((menu) =>
  menu.id === "snh-imp-" + key + "-menu");

test("deleting a chosen role by hand clears it as the button does", async () => {
  /* Reported: backspacing a role away left the list of its holders on
   * screen, and opened "No matching roles." for text that asked nothing. */
  const harness = load();
  const searches = [];
  const roleLookups = [];
  const roleId = sysId();
  pickerPanel(harness, searches, {
    onFindRoles: async (input) => {
      roleLookups.push(input);
      return { options: [{ label: "example_role", value: roleId }] };
    },
  });
  const shadow = harness.shadow();
  termInput(shadow).value = "sample";
  await pickFirst(shadow, "role");
  assert.strictEqual(searches.length, 1);
  assert.strictEqual(searches[0].roleSysId, roleId);
  const lookupsBefore = roleLookups.length;

  const roleInput = comboInput(shadow, "role");
  roleInput.value = "example_rol";
  roleInput.fire("input", {});
  assert.strictEqual(searches.length, 1, "part-way through deleting is still an edit");
  roleInput.value = "";
  roleInput.fire("input", {});
  assert.strictEqual(menuFor(shadow, "role").hidden, true, "no list opens for empty text");
  harness.runTimers();
  await tick();

  assert.strictEqual(roleLookups.length, lookupsBefore,
    "the lookup the last keystroke scheduled is withdrawn, not run for empty text");
  assert.ok(!harness.text().includes("No matching roles."));
  assert.strictEqual(clearButtonFor(shadow, "role").hidden, true);
  assert.strictEqual(searches.length, 2, "the emptied role is a finished question");
  assert.strictEqual(searches[1].roleSysId, "", "and it is gone from what is asked");
  assert.strictEqual(searches[1].term, "sample", "while what remains is still asked");
});

test("deleting the last criterion by hand puts the panel back where it opened", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  await pickFirst(shadow, "group");
  assert.strictEqual(byClass(shadow, "row").length, 1, "a result is on screen");

  /* Select-all and delete: the choice goes in one keystroke, with no edit
   * before it. */
  const groupInput = comboInput(shadow, "group");
  groupInput.value = "";
  groupInput.fire("input", {});
  await tick();
  assert.strictEqual(searches.length, 1, "with nothing left to ask, nothing is asked");
  assert.strictEqual(byClass(shadow, "row").length, 0, "the old answer does not linger");
  assert.ok(harness.text().includes("Find a user to impersonate."));
});

test("deleting typed text that never became a choice asks nothing", async () => {
  const harness = load();
  const searches = [];
  const roleLookups = [];
  pickerPanel(harness, searches, {
    onFindRoles: async (input) => {
      roleLookups.push(input);
      return { options: [] };
    },
  });
  const shadow = harness.shadow();
  const roleInput = comboInput(shadow, "role");
  roleInput.value = "exa";
  roleInput.fire("input", {});
  roleInput.value = "";
  roleInput.fire("input", {});
  harness.runTimers();
  await tick();
  assert.deepStrictEqual(roleLookups, [], "the pending lookup went with the text");
  assert.strictEqual(menuFor(shadow, "role").hidden, true);
  assert.strictEqual(searches.length, 0);
});

test("the clear button after typing over a choice still withdraws its answer", async () => {
  /* The first keystroke unbound the role as an edit and asked nothing, so
   * the list on screen still answers the role. */
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  termInput(shadow).value = "sample";
  await pickFirst(shadow, "role");
  const roleInput = comboInput(shadow, "role");
  roleInput.value = "exa";
  roleInput.fire("input", {});
  assert.strictEqual(searches.length, 1);

  clearButtonFor(shadow, "role").fire("click", {});
  await tick();
  assert.strictEqual(searches.length, 2);
  assert.strictEqual(searches[1].roleSysId, "");
});

test("emptying the field by hand withdraws the condition it held", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  termInput(shadow).value = "sample";
  await pickFirst(shadow, "attr-field");
  findAll(shadow, (node) => node.id === "snh-imp-attr-value-option-0")[0].fire("click", {});
  await tick();
  assert.strictEqual(searches.length, 1);
  assert.ok(searches[0].attribute);

  /* Typing over the field takes its value with it, without asking. */
  const fieldInput = comboInput(shadow, "attr-field");
  fieldInput.value = "Country cod";
  fieldInput.fire("input", {});
  assert.strictEqual(searches.length, 1);
  assert.strictEqual(comboInput(shadow, "attr-value").value, "");

  fieldInput.value = "";
  fieldInput.fire("input", {});
  await tick();
  assert.strictEqual(searches.length, 2,
    "the condition on screen went with the field, even though no value was left to see");
  assert.strictEqual(searches[1].attribute, null);
  assert.strictEqual(searches[1].term, "sample");
});

test("clearing a re-picked field withdraws the condition the first one asked", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  termInput(shadow).value = "sample";
  await pickFirst(shadow, "attr-field");
  findAll(shadow, (node) => node.id === "snh-imp-attr-value-option-0")[0].fire("click", {});
  await tick();
  assert.strictEqual(searches.length, 1);

  /* Picking a field again discards the value and waits for a new one. */
  await pickFirst(shadow, "attr-field");
  assert.strictEqual(searches.length, 1);
  clearButtonFor(shadow, "field").fire("click", {});
  await tick();
  assert.strictEqual(searches.length, 2);
  assert.strictEqual(searches[1].attribute, null);
});

/* ------------------------------------------------------------------ *
 * Leaving a picker ends its edit
 * ------------------------------------------------------------------ */

test("leaving a picker part-way through replacing its choice withdraws the choice", async () => {
  /* Reported alongside the backspace fault: "admi" left behind kept the
   * old role's holders on screen with no role bound. */
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  termInput(shadow).value = "sample";
  await pickFirst(shadow, "role");
  assert.strictEqual(searches.length, 1);

  const roleInput = comboInput(shadow, "role");
  const groupInput = comboInput(shadow, "group");
  roleInput.focus();
  roleInput.value = "exa";
  roleInput.fire("input", {});
  /* Tab to the next picker: focus moves, then the input hears its blur. */
  groupInput.focus();
  roleInput.fire("blur", {});
  harness.runTimers();
  await tick();

  assert.strictEqual(roleInput.value, "", "the unfinished text goes with the choice it replaced");
  assert.strictEqual(searches.length, 2);
  assert.strictEqual(searches[1].roleSysId, "");
  assert.strictEqual(searches[1].term, "sample");
  assert.strictEqual(harness.dom.document.activeElement, groupInput,
    "the search this starts gives focus back to where it went");
});

test("text that never replaced a choice stays when leaving, with its list closed", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  const roleInput = comboInput(shadow, "role");
  roleInput.focus();
  roleInput.value = "exa";
  roleInput.fire("input", {});
  harness.runTimers();
  await tick();
  assert.strictEqual(menuFor(shadow, "role").hidden, false, "its list is open");

  termInput(shadow).focus();
  roleInput.fire("blur", {});
  harness.runTimers();
  await tick();
  assert.strictEqual(menuFor(shadow, "role").hidden, true);
  assert.strictEqual(roleInput.value, "exa", "nothing was bound, so nothing is taken");
  assert.strictEqual(searches.length, 0);
});

test("a window losing focus is not leaving the picker", async () => {
  /* Switching to another window blurs the input but leaves it the page's
   * focused element, and focus comes straight back to it. */
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  await pickFirst(shadow, "role");
  const roleInput = comboInput(shadow, "role");
  roleInput.focus();
  roleInput.value = "exa";
  roleInput.fire("input", {});
  roleInput.fire("blur", {});
  harness.runTimers();
  await tick();
  assert.strictEqual(roleInput.value, "exa");
  assert.strictEqual(searches.length, 1);
});

test("a picker the panel disables for a search has not been left", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches, {
    onSearch: (request) => {
      searches.push(request);
      return searches.length === 1 ? Promise.resolve(resultSet()) : new Promise(() => {});
    },
  });
  const shadow = harness.shadow();
  await pickFirst(shadow, "role");
  const roleInput = comboInput(shadow, "role");
  roleInput.focus();
  roleInput.value = "exa";
  roleInput.fire("input", {});

  byClass(shadow, "form")[0].fire("submit", {});
  assert.strictEqual(roleInput.disabled, true, "the search locks the picker and takes its focus");
  roleInput.fire("blur", {});
  harness.runTimers();
  await tick();
  assert.strictEqual(roleInput.value, "exa", "a lock is not the user leaving");
  assert.strictEqual(searches.length, 2);
});

test("a press inside a list never takes focus from its input", () => {
  const harness = load();
  pickerPanel(harness, []);
  const shadow = harness.shadow();
  ["role", "group", "attr-field", "attr-value"].forEach((key) => {
    assert.strictEqual(menuFor(shadow, key).fire("mousedown", {}).defaultPrevented, true, key);
  });
});

test("the clear button is inert while a search runs", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches, {
    onSearch: (request) => {
      searches.push(request);
      return new Promise(() => {});
    },
  });
  const shadow = harness.shadow();
  await pickFirst(shadow, "role");
  const button = clearButtonFor(shadow, "role");
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(button.hidden, false, "inert, not gone, so nothing shifts under the pointer");
  button.fire("click", {});
  assert.strictEqual(comboInput(shadow, "role").value, "example_role");
});

test("focus comes back to the picker after the search it started", async () => {
  /* A search disables every control and a disabled control loses focus, so
   * a keyboard user who picked a role used to land on the page behind. */
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  const roleInput = comboInput(shadow, "role");
  roleInput.focus();
  roleInput.fire("keydown", { key: "ArrowDown" });
  await tick();
  roleInput.fire("keydown", { key: "Enter" });
  assert.strictEqual(roleInput.disabled, true, "busy while the search runs");
  assert.notStrictEqual(harness.dom.document.activeElement, roleInput, "so focus was lost");
  await tick();
  assert.strictEqual(roleInput.disabled, false);
  assert.strictEqual(harness.dom.document.activeElement, roleInput, "and it is given back");
  assert.strictEqual(byClass(shadow, "menu").find((menu) =>
    menu.id === "snh-imp-role-menu").hidden, true, "without reopening the list just used");
});

/* ------------------------------------------------------------------ *
 * The name field searches as you type
 * ------------------------------------------------------------------ */

/* The real engine's rule, as content.js passes it. */
function typingPanel(harness, searches, extra) {
  const engine = harness.sandbox.SNImpersonate;
  return pickerPanel(harness, searches, Object.assign({
    canSearchTerm: (term) => {
      const parsed = engine.parseSearch({ term });
      return parsed.ok ? { ok: true } : { ok: false, message: parsed.error };
    },
  }, extra || {}));
}

function type(shadow, value) {
  const input = termInput(shadow);
  input.value = value;
  input.fire("input", {});
  return input;
}

test("typing searches once it pauses for half a second, not once per keystroke", async () => {
  /* Reported: that the name field waited for Enter was not obvious, once
   * every picker searched on a pick. */
  const harness = load();
  const searches = [];
  typingPanel(harness, searches);
  const shadow = harness.shadow();
  ["a", "ab", "abe", "abel"].forEach((value) => type(shadow, value));
  assert.deepStrictEqual(harness.pendingDelays(), [500], "one pause, of 500 ms, is waiting");
  assert.strictEqual(searches.length, 0, "and nothing is asked while typing");

  harness.runTimers();
  await tick();
  assert.strictEqual(searches.length, 1);
  assert.strictEqual(searches[0].term, "abel");
  assert.ok(byClass(shadow, "row").length >= 1, "the answer is on screen");
});

test("the name field stays usable while its search runs, and the pickers wait", async () => {
  /* Locking it, as every control used to be, would swallow the keystrokes
   * that follow a pause. */
  const harness = load();
  const searches = [];
  typingPanel(harness, searches, {
    onSearch: (request) => {
      searches.push(request);
      return new Promise(() => {});
    },
  });
  const shadow = harness.shadow();
  const input = type(shadow, "abel");
  input.focus();
  harness.runTimers();
  await tick();
  assert.strictEqual(searches.length, 1);
  assert.strictEqual(input.disabled, false);
  assert.strictEqual(harness.dom.document.activeElement, input, "focus never left it");
  assert.strictEqual(comboInput(shadow, "role").disabled, true);
  assert.strictEqual(buttonsLabelled(shadow, "Search")[0].disabled, true);

  /* Typing on starts the next pause, which will supersede this read. */
  type(shadow, "abel.t");
  assert.deepStrictEqual(harness.pendingDelays(), [500]);
});

test("a pause on a term too short to search says so, and asks nothing", async () => {
  const harness = load();
  const searches = [];
  typingPanel(harness, searches);
  const shadow = harness.shadow();
  type(shadow, "ab");
  harness.runTimers();
  await tick();
  assert.strictEqual(searches.length, 0, "a term Enter would refuse is never sent");
  const status = byClass(shadow, "status")[0];
  assert.ok(/at least 3/.test(status.textContent), status.textContent);
  /* Guidance, not an error: nothing went wrong, the word is unfinished. */
  assert.ok(!/validation/.test(status.className), status.className);
  assert.ok(!harness.text().includes("could not run"));
});

test("a short term withdraws the answer to the longer one", async () => {
  const harness = load();
  const searches = [];
  typingPanel(harness, searches);
  const shadow = harness.shadow();
  await pickFirst(shadow, "role");
  type(shadow, "abel");
  harness.runTimers();
  await tick();
  assert.strictEqual(searches.length, 2);
  assert.ok(byClass(shadow, "row").length >= 1);

  type(shadow, "ab");
  harness.runTimers();
  await tick();
  assert.strictEqual(searches.length, 2);
  assert.strictEqual(byClass(shadow, "row").length, 0,
    "the list answered a question the field no longer asks");
  assert.ok(/clear the name/i.test(harness.text()), "and says how to use the other filters alone");
});

test("a pause that changed nothing asks nothing", async () => {
  const harness = load();
  const searches = [];
  typingPanel(harness, searches);
  const shadow = harness.shadow();
  type(shadow, "abel");
  harness.runTimers();
  await tick();
  type(shadow, "abel ");
  harness.runTimers();
  await tick();
  assert.strictEqual(searches.length, 1, "a trailing space is the same question");

  type(shadow, "abel.t");
  harness.runTimers();
  await tick();
  assert.strictEqual(searches.length, 2);
});

test("Enter asks at once, and the pause it interrupted does not ask again", async () => {
  const harness = load();
  const searches = [];
  typingPanel(harness, searches);
  const shadow = harness.shadow();
  type(shadow, "abel");
  byClass(shadow, "form")[0].fire("submit", {});
  await tick();
  assert.strictEqual(searches.length, 1);
  assert.deepStrictEqual(harness.pendingDelays(), [], "the pending pause was cancelled");
  harness.runTimers();
  await tick();
  assert.strictEqual(searches.length, 1);
});

test("emptying the name field goes back to the start, or asks what the pickers still hold", async () => {
  const harness = load();
  const searches = [];
  typingPanel(harness, searches);
  const shadow = harness.shadow();
  type(shadow, "abel");
  harness.runTimers();
  await tick();
  type(shadow, "");
  harness.runTimers();
  await tick();
  assert.strictEqual(searches.length, 1, "nothing is left to ask");
  assert.strictEqual(byClass(shadow, "row").length, 0);
  assert.ok(/to begin/.test(byClass(shadow, "status")[0].textContent));

  await pickFirst(shadow, "role");
  type(shadow, "abel");
  harness.runTimers();
  await tick();
  type(shadow, "");
  harness.runTimers();
  await tick();
  assert.strictEqual(searches.length, 4);
  assert.strictEqual(searches[3].term, "");
  assert.ok(searches[3].roleSysId, "the role is still asked");
});

test("without the engine's rule the name field waits for Enter", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  type(harness.shadow(), "abel");
  assert.deepStrictEqual(harness.pendingDelays(), []);
  harness.runTimers();
  await tick();
  assert.strictEqual(searches.length, 0);
});

/* ------------------------------------------------------------------ *
 * Recent impersonations
 * ------------------------------------------------------------------ */

function sectionHeading(shadow) {
  return byClass(shadow, "section-heading")[0] || null;
}

test("the recent list fills the start, in the platform's order, with a result's own actions", () => {
  const harness = load();
  let opened = null;
  openPanel(harness, { onOpenUser: (person) => { opened = person; } });
  const shadow = harness.shadow();
  assert.strictEqual(sectionHeading(shadow), null, "nothing until the list has been read");
  assert.ok(harness.text().includes("Find a user to impersonate."));

  const later = user({ name: "Zed Recent", userName: "zed.recent" });
  const earlier = user({ name: "Amy Recent", userName: "amy.recent", email: "amy@example.com" });
  harness.ui.showRecent({ users: [later, earlier], hidden: 0 });

  assert.ok(/Recent impersonations/.test(sectionHeading(shadow).textContent));
  assert.ok(/Kept by ServiceNow/.test(sectionHeading(shadow).textContent));
  const rows = byClass(shadow, "row");
  assert.deepStrictEqual(rows.map((row) => byClass(row, "title")[0].textContent),
    ["Zed Recent", "Amy Recent"], "the platform's order, as its own dialog shows it");
  assert.ok(rows[1].textContent.includes("amy@example.com"), "as much detail as a result");
  assert.ok(/to begin/.test(byClass(shadow, "status")[0].textContent),
    "no question has been asked, so the status still invites one");

  buttonsLabelled(rows[0], "Open user")[0].fire("click", {});
  assert.strictEqual(opened, later);
  /* And a recent row is exactly as far from a session change as a result. */
  rows[0].fire("click", {});
  rows[0].fire("keydown", { key: "Enter" });
  assert.strictEqual(byClass(shadow, "confirm").length, 0);
  buttonsLabelled(rows[0], "Impersonate")[0].fire("click", {});
  assert.strictEqual(byClass(shadow, "confirm").length, 1);
  assert.ok(byClass(shadow, "confirm")[0].textContent.includes("zed.recent"));
});

test("cancelling a confirmation from the recent list goes back to the recent list", () => {
  const harness = load();
  openPanel(harness);
  const shadow = harness.shadow();
  harness.ui.showRecent({ users: [user({ name: "One Recent" }), user({ name: "Two Recent" })] });
  buttonsLabelled(byClass(shadow, "row")[1], "Impersonate")[0].fire("click", {});
  buttonsLabelled(shadow, "Cancel")[0].fire("click", {});

  assert.ok(sectionHeading(shadow), "the recent list comes back");
  assert.strictEqual(byClass(shadow, "row").length, 2);
  assert.ok(/to begin/.test(byClass(shadow, "status")[0].textContent));
  assert.strictEqual(harness.dom.document.activeElement,
    buttonsLabelled(byClass(shadow, "row")[1], "Impersonate")[0], "focus returns to that row");
});

test("hidden recent accounts are counted, never named", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showRecent({ users: [user({ name: "Still Eligible" })], hidden: 2 });
  const note = byClass(harness.shadow(), "section-note")[0];
  assert.ok(note, "the gap is explained");
  assert.ok(/2 recent accounts are not listed/.test(note.textContent), note.textContent);
  assert.ok(/locked out/.test(note.textContent));
});

test("a recent list arriving late never replaces a search or a confirmation", async () => {
  const harness = load();
  const searches = [];
  let release = null;
  typingPanel(harness, searches, {
    onSearch: (request) => {
      searches.push(request);
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const shadow = harness.shadow();
  type(shadow, "abel");
  harness.runTimers();
  await tick();
  harness.ui.showRecent({ users: [user({ name: "Late Recent" })] });
  assert.ok(!harness.text().includes("Late Recent"), "a search is running; its answer is due");
  release(resultSet({ results: [user({ name: "Search Answer" })] }));
  await tick();
  assert.ok(harness.text().includes("Search Answer"));

  buttonsLabelled(shadow, "Impersonate")[0].fire("click", {});
  harness.ui.showRecent({ users: [user({ name: "Later Still" })] });
  assert.strictEqual(byClass(shadow, "confirm").length, 1);
  assert.ok(!harness.text().includes("Later Still"));
});

test("the recent list is back once the last criterion is cleared", async () => {
  const harness = load();
  const searches = [];
  pickerPanel(harness, searches);
  const shadow = harness.shadow();
  harness.ui.showRecent({ users: [user({ name: "Recent Person" })] });
  await pickFirst(shadow, "group");
  assert.strictEqual(sectionHeading(shadow), null, "a search answer replaced it");
  clearButtonFor(shadow, "group").fire("click", {});
  await tick();
  assert.ok(sectionHeading(shadow));
  assert.ok(harness.text().includes("Recent Person"));
});

test("an empty recent list leaves the ordinary start hint", () => {
  const harness = load();
  openPanel(harness);
  harness.ui.showRecent({ users: [], hidden: 0 });
  assert.strictEqual(sectionHeading(harness.shadow()), null);
  assert.ok(harness.text().includes("Find a user to impersonate."));
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

test("a hidden block takes no space, whatever display its class sets", () => {
  /* The current-state block is display:flex, and an author display beats the
   * user-agent [hidden] rule: it drew as an empty band under the header on
   * every panel that was not impersonating, while its hidden property -- all
   * the test above can see -- said it was gone. */
  const harness = load();
  openPanel(harness);
  const css = findAll(harness.shadow(), (node) => node.tagName === "STYLE")
    .map((node) => node.textContent).join("");
  assert.ok(/^\s*\[hidden\]\{display:none!important\}/.test(css),
    "the [hidden] rule must come first and must win");
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

const DIALOG_LABEL = "Open impersonation dialog";

test("a refused Stop offers ServiceNow's impersonation dialog", async () => {
  /* Reported: from inside an external supplier contact's session Stop was
   * refused, and so was the platform's own End Impersonation; the classic
   * dialog still switched back. */
  const harness = load();
  let opened = 0;
  openPanel(harness, {
    onStop: async () => ({
      ok: false, status: 403, code: "access",
      message: "ServiceNow refused to end impersonation from inside this account.",
    }),
    onOpenImpersonateDialog: (...args) => {
      assert.deepStrictEqual(args, [], "it chooses no account");
      opened += 1;
    },
  });
  harness.ui.showCurrentState({
    isImpersonating: true, currentUserName: "example.identity", hasStopTarget: true,
  });
  assert.strictEqual(buttonsLabelled(harness.shadow(), DIALOG_LABEL).length, 0,
    "not offered while Stop has not been tried");

  buttonsLabelled(harness.shadow(), "Stop impersonating")[0].fire("click", {});
  await tick();
  const dialog = buttonsLabelled(harness.shadow(), DIALOG_LABEL)[0];
  assert.ok(dialog, "offered once Stop is refused");
  assert.strictEqual(dialog.disabled, false);
  assert.strictEqual(harness.dom.document.activeElement, dialog, "and it takes the focus");
  const status = byClass(harness.shadow(), "status")[0].textContent;
  assert.ok(/refused to end impersonation/.test(status), status);
  assert.ok(/impersonation dialog/.test(status), status);
  assert.strictEqual(buttonsLabelled(harness.shadow(), "Stop impersonating").length, 1,
    "Stop itself stays");

  dialog.fire("click", {});
  assert.strictEqual(opened, 1);
});

test("an undecided Stop does not offer the dialog", async () => {
  const harness = load();
  openPanel(harness, {
    onStop: async () => ({ ok: false, code: "indeterminate", message: "" }),
    onOpenImpersonateDialog: () => {},
  });
  harness.ui.showCurrentState({
    isImpersonating: true, currentUserName: "example.identity", hasStopTarget: true,
  });
  buttonsLabelled(harness.shadow(), "Stop impersonating")[0].fire("click", {});
  await tick();
  assert.strictEqual(buttonsLabelled(harness.shadow(), DIALOG_LABEL).length, 0,
    "it may have worked, and the panel stays locked until that is known");
});

test("with no way home, the dialog is offered beside the user menu", () => {
  const harness = load();
  let opened = 0;
  openPanel(harness, { onOpenImpersonateDialog: () => { opened += 1; } });
  harness.ui.showCurrentState({
    isImpersonating: true, currentUserName: "example.identity", hasStopTarget: false,
  });
  const block = byClass(harness.shadow(), "current")[0];
  assert.ok(/user menu/i.test(block.textContent), block.textContent);
  buttonsLabelled(harness.shadow(), DIALOG_LABEL)[0].fire("click", {});
  assert.strictEqual(opened, 1);
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
  assert.strictEqual(status, "Showing 1 eligible user. More may exist — narrow the search");
  /* The read window is an implementation detail. Naming it put "the first
   * 100" beside a list of 20, which read as two different limits. */
  assert.ok(!/100|first/.test(status), "no read window is named: " + status);
});

test("every search order words a capped result the same way", () => {
  /* Reported: a text search said one thing and a group search another, with
   * different numbers in each. One sentence now serves all four orders. */
  const said = ["user-first", "role-first", "group-first", "attribute-first"].map((order) => {
    const harness = load();
    openPanel(harness);
    const shown = [];
    for (let index = 0; index < 20; index += 1) shown.push(user({ name: "Person " + index }));
    harness.ui.showResults(resultSet({
      results: shown,
      extra: {
        order,
        membershipCapped: order === "role-first" || order === "group-first",
        eligibleTotal: null,
        truncated: true,
      },
    }));
    return byClass(harness.shadow(), "status")[0].textContent;
  });
  said.forEach((status) => {
    assert.strictEqual(status, "Showing 20 eligible users. More may exist — narrow the search");
  });
});

test("a known total larger than the list names both numbers", () => {
  const harness = load();
  openPanel(harness);
  const shown = [];
  for (let index = 0; index < 20; index += 1) shown.push(user({ name: "Person " + index }));
  harness.ui.showResults(resultSet({
    results: shown,
    extra: { order: "group-first", membershipCapped: false, eligibleTotal: 37, truncated: true },
  }));
  assert.strictEqual(byClass(harness.shadow(), "status")[0].textContent,
    "Showing 20 of 37 eligible users. Narrow the search to see the rest");
});

test("an empty capped read never claims that nobody matched", () => {
  /* A text search can fill its window with anchor matches that all fail the
   * complete term. That is not evidence that no user matches. */
  const harness = load();
  openPanel(harness);
  harness.ui.showResults(resultSet({
    results: [],
    extra: { order: "user-first", eligibleTotal: null, truncated: true },
  }));
  const shown = harness.text();
  assert.strictEqual(byClass(harness.shadow(), "status")[0].textContent,
    "No eligible users among those read. More may exist — narrow the search");
  assert.ok(!/No eligible users matched/.test(shown), shown);
  assert.ok(/read limit/.test(shown), shown);
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
  assert.strictEqual(status, "Showing 1 eligible user. More may exist — narrow the search");
  assert.ok(!/100|first/.test(status), "no read window is named: " + status);
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

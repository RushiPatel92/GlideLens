/*
 * Impersonate runtime-boundary tests. No browser and no live instance.
 *
 * The engine suite covers what is a pure function and the panel suite covers
 * what is on screen. This covers what is neither: the worker's three routes,
 * the frame rules, the private original-account state, the panel contract
 * content.js depends on, the palette entry and the packaging allowlist.
 *
 * Mutation-transport assertions live HERE rather than in
 * tests/search_transport_frames.test.js, so read-retry semantics can never be
 * applied to the write path by accident.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const backgroundSource = read("background.js");
const contentSource = read("content.js");
const packageSource = read("package.mjs");
const uiSource = read("impersonate_ui.js");
const engineSource = read("impersonate.js");

/* Comments stripped, for assertions that must look at code rather than at the
 * prose describing it -- these files document the prohibitions they keep, so a
 * search for "allFrames" finds the sentence promising not to use it. */
const stripComments = (source) =>
  String(source).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

/* Line endings are normalised before any search: a Windows working copy has
 * CRLF while the repository stores LF, so a sentinel spanning a newline would
 * match or fail on how the tree was checked out rather than on the code. */
function between(source, startText, endText) {
  const text = String(source).replace(/\r\n/g, "\n");
  const start = text.indexOf(startText);
  const end = text.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, "source block not found: " + startText);
  return text.slice(start, end);
}

/* ------------------------------------------------------------------ *
 * The worker, loaded in isolation
 * ------------------------------------------------------------------ */

/*
 * background.js is a service worker, so it cannot simply be required. The
 * impersonation block is self-contained, so it is evaluated on its own against
 * a chrome stub -- which is what makes the storage rules, the frame selection
 * and the no-retry invariant executable rather than merely grepped for.
 */
function loadWorkerBlock(options) {
  const opts = options || {};
  const block = between(
    backgroundSource,
    "const IMPERSONATE_STATE_KEY",
    "// Content scripts can't call chrome.tabs.create"
  );
  const session = Object.create(null);
  const calls = { executeScript: [], discovery: 0 };
  const chrome = {
    storage: {
      session: {
        get: async (key) => (key in session ? { [key]: session[key] } : {}),
        set: async (item) => { Object.assign(session, item); },
      },
    },
    scripting: {
      executeScript: async (request) => {
        calls.executeScript.push(request);
        if (typeof opts.executeScript === "function") return opts.executeScript(request);
        return [{ result: null }];
      },
    },
  };
  const sandbox = {
    chrome,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    URL,
    Number,
    Object,
    String,
    Boolean,
    Error,
    JSON,
    Date,
    Math,
    /* The two helpers the block borrows from the rest of the worker. */
    withTimeout: (promise, ms, label) => {
      let timer;
      return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + " timed out")), ms);
        }),
      ]);
    },
    discoverTokenFrame: async () => {
      calls.discovery += 1;
      if (typeof opts.discoverTokenFrame === "function") return opts.discoverTokenFrame();
      return 7;
    },
    injectInDiscoveredFrames: async () => {
      if (typeof opts.injectInDiscoveredFrames === "function") {
        return opts.injectInDiscoveredFrames();
      }
      return [];
    },
  };
  /* Page globals, for running a MAIN-world function against a given surface. */
  Object.assign(sandbox, opts.globals || {});
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox, { filename: "background.js#impersonate" });
  return { api: sandbox, session, calls };
}

const ORIGIN = "https://example.service-now.com";

function frameAnswer(frameId, value) {
  return { frameId, ok: true, results: [{ result: value }] };
}

function frameFailure(frameId) {
  return { frameId, ok: false, error: "timed out" };
}

/* What readImpersonationState hands the selector, after it has flattened each
 * frame's executeScript results down to the one value that frame returned. */
function selectable(frameId, value) {
  return { frameId, ok: true, value };
}

/* ------------------------------------------------------------------ *
 * The three routes, and what may cross them
 * ------------------------------------------------------------------ */

test("the worker exposes exactly four impersonation routes, and none is a proxy", () => {
  const listener = between(
    backgroundSource,
    'if (msg && msg.type === "INJECT_IMPERSONATE"',
    'if (msg && msg.type === "SN_RECORD_SEARCH_GET"'
  );
  const routes = ["SN_IMPERSONATE_STATE", "SN_IMPERSONATE_RECENT", "SN_IMPERSONATE_START",
    "SN_IMPERSONATE_STOP"];
  routes.forEach((route) => {
    assert.ok(listener.includes(route), "missing route " + route);
  });
  assert.deepStrictEqual(
    Array.from(new Set(listener.match(/SN_IMPERSONATE_[A-Z]+/g))).sort(),
    routes.slice().sort()
  );

  /* START reads exactly one field off the message, and STATE, RECENT and STOP
   * read none. No url, method, table, query, body or header crosses this
   * boundary. */
  const fromMessage = listener.match(/msg\.[A-Za-z_]+/g) || [];
  assert.deepStrictEqual(
    Array.from(new Set(fromMessage)).sort(),
    ["msg.type", "msg.userName"]
  );
  ["msg.url", "msg.method", "msg.table", "msg.query", "msg.body", "msg.headers", "msg.target"]
    .forEach((field) => {
      assert.ok(!listener.includes(field), "content code must not be able to supply " + field);
    });
});

test("the start route hands the worker a username and nothing else", async () => {
  const worker = loadWorkerBlock({
    executeScript: async () => [{
      result: { ok: true, status: 201, originalUserName: "null", impersonatedUserName: "someone" },
    }],
  });
  await worker.api.startImpersonation(1, ORIGIN, "someone");
  const request = worker.calls.executeScript[0];
  assert.deepStrictEqual(Array.from(request.args), ["someone"]);
  assert.strictEqual(request.world, "MAIN");
  /* Exactly one frame, named by discovery -- not allFrames, not a list. */
  assert.deepStrictEqual(Array.from(request.target.frameIds), [7]);
});

test("the mutation response reaching content code carries no identity at all", async () => {
  const worker = loadWorkerBlock({
    executeScript: async () => [{
      result: {
        ok: true,
        status: 201,
        originalUserName: "original.account",
        impersonatedUserName: "target.account",
      },
    }],
  });
  const reply = await worker.api.startImpersonation(1, ORIGIN, "target.account");
  assert.deepStrictEqual(
    Object.keys(reply).sort(),
    ["code", "message", "ok", "status"]
  );
  const serialized = JSON.stringify(reply);
  ["original.account", "target.account", "service-now.com", "g_ck", "X-UserToken"]
    .forEach((secret) => {
      assert.ok(!serialized.includes(secret), "leaked to content code: " + secret);
    });

  /* The worker still knows it. Redaction governs what crosses back, not what
   * the worker may hold. */
  assert.strictEqual(
    await worker.api.storedImpersonationOriginal(ORIGIN),
    "original.account"
  );
});

test("the literal string null is never stored and never POSTed", async () => {
  const worker = loadWorkerBlock({
    executeScript: async () => [{
      result: { ok: true, status: 201, originalUserName: "null", impersonatedUserName: "someone" },
    }],
  });
  await worker.api.startImpersonation(1, ORIGIN, "someone");
  /* "null" means there was no original, so there is no way home to record. */
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "");
  assert.strictEqual(worker.api.validImpersonationUserName("null"), false);

  const stop = await worker.api.stopImpersonation(1, ORIGIN);
  assert.strictEqual(stop.ok, false);
  assert.strictEqual(stop.code, "validation");
  assert.strictEqual(worker.calls.executeScript.length, 1, "no second request was sent");
});

test("stop carries no target and cannot be steered at another account", async () => {
  const sent = [];
  const worker = loadWorkerBlock({
    executeScript: async (request) => {
      sent.push(request.args[0]);
      return [{ result: { ok: true, status: 201, originalUserName: "null" } }];
    },
  });
  await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");
  /* Whatever a caller passes, stopImpersonation takes only (tabId, origin) --
   * the destination comes from the worker's own state. */
  await worker.api.stopImpersonation(1, ORIGIN, "attacker.account");
  assert.deepStrictEqual(sent, ["original.account"]);

  /* And it is keyed per origin, so one instance's original can never be
   * POSTed at another. */
  const other = await worker.api.stopImpersonation(1, "https://other.service-now.com");
  assert.strictEqual(other.ok, false);
  assert.strictEqual(other.code, "validation");
  assert.deepStrictEqual(sent, ["original.account"]);
});

test("stored state clears on a successful stop but survives an indeterminate one", async () => {
  let mode = "indeterminate";
  const worker = loadWorkerBlock({
    executeScript: async () => {
      if (mode === "indeterminate") throw new Error("the worker was torn down");
      return [{ result: { ok: true, status: 201, originalUserName: "null" } }];
    },
  });
  await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");

  const ambiguous = await worker.api.stopImpersonation(1, ORIGIN);
  assert.strictEqual(ambiguous.code, "indeterminate");
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "original.account",
    "we do not know that it succeeded, so the way home is kept");

  mode = "ok";
  const done = await worker.api.stopImpersonation(1, ORIGIN);
  assert.strictEqual(done.ok, true);
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "");
});

test("a refused stop is not worded as a missing permission to impersonate", async () => {
  /* Reported: Stop from inside an external supplier contact's session was
   * refused with a 403 and said "You do not have permission to impersonate"
   * -- to someone who had just impersonated. */
  const worker = loadWorkerBlock({
    executeScript: stopScript({ dialog: { sent: false, reason: "no-way-home" } }),
  });
  await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");
  const stop = await worker.api.stopImpersonation(1, ORIGIN);
  assert.strictEqual(stop.code, "access");
  assert.ok(!/permission/i.test(stop.message), stop.message);
  assert.ok(/end impersonation/i.test(stop.message), stop.message);
  assert.ok(!stop.message.includes("original.account"), "the way home never crosses back");
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "original.account",
    "a definite refusal keeps the way home");

  /* A start keeps its own wording: there, it IS the operator's permission. */
  const start = await worker.api.startImpersonation(1, ORIGIN, "someone");
  assert.ok(/permission/i.test(start.message), start.message);
});

/* ------------------------------------------------------------------ *
 * A refused Stop goes round through ServiceNow's dialog
 * ------------------------------------------------------------------ */

/* One executeScript answer per page function, so a test can say what the
 * REST POST, the dialog submit and the session header each report. */
function stopScript({ rest = { ok: false, status: 403 }, dialog, header, dialogThrows } = {}) {
  return async (request) => {
    const name = request.func && request.func.name;
    if (name === "impersonateInPage") return [{ result: rest }];
    if (name === "unimpersonateThroughDialogInPage") {
      if (dialogThrows) throw new Error("the frame went away");
      return [{ result: dialog }];
    }
    if (name === "fetchImpersonationStateInPage") return [{ result: header }];
    throw new Error("unexpected page function " + name);
  };
}

const called = (worker) => worker.calls.executeScript.map((request) => request.func.name);

test("a Stop refused with 403 ends the impersonation through the dialog", async () => {
  /* Reported: from inside an external supplier contact's session the REST
   * endpoint refused Stop; the stock dialog still switched back, and a live
   * PDI run of this exact page function did so from an external account. */
  const worker = loadWorkerBlock({
    executeScript: stopScript({
      dialog: { sent: true, status: 0, redirected: true },
      header: { isImpersonating: false, preferenceOriginal: "" },
    }),
  });
  await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");
  const stop = await worker.api.stopImpersonation(1, ORIGIN);
  assert.strictEqual(stop.ok, true);
  assert.strictEqual(stop.code, "ok");
  assert.deepStrictEqual(called(worker),
    ["impersonateInPage", "unimpersonateThroughDialogInPage", "fetchImpersonationStateInPage"],
    "the REST POST, one dialog submit, then the session header decides");
  const dialog = worker.calls.executeScript[1];
  assert.deepStrictEqual(Array.from(dialog.args), ["original.account"],
    "the worker's own way home, never anything from content code");
  assert.strictEqual(dialog.world, "MAIN");
  assert.deepStrictEqual(Array.from(dialog.target.frameIds), [7], "one frame, not allFrames");
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "",
    "a confirmed end clears the way home");
  assert.deepStrictEqual(Object.keys(stop).sort(), ["code", "message", "ok", "status"]);
});

test("a dialog that offered no way home leaves the refusal standing", async () => {
  const worker = loadWorkerBlock({
    executeScript: stopScript({ dialog: { sent: false, reason: "no-way-home" } }),
  });
  await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");
  const stop = await worker.api.stopImpersonation(1, ORIGIN);
  assert.strictEqual(stop.ok, false);
  assert.strictEqual(stop.code, "access");
  assert.ok(/refused to end impersonation/.test(stop.message), stop.message);
  assert.deepStrictEqual(called(worker), ["impersonateInPage", "unimpersonateThroughDialogInPage"],
    "nothing was submitted, so there is nothing to check");
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "original.account");
});

test("a submitted dialog is judged by the session header alone", async () => {
  const cases = [
    { name: "still impersonating", header: { isImpersonating: true, preferenceOriginal: "original.account" },
      code: "access" },
    { name: "no answer", header: null, code: "indeterminate" },
  ];
  for (const scenario of cases) {
    const worker = loadWorkerBlock({
      executeScript: stopScript({ dialog: { sent: true, status: 0, redirected: true }, header: scenario.header }),
    });
    await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");
    const stop = await worker.api.stopImpersonation(1, ORIGIN);
    assert.strictEqual(stop.ok, false, scenario.name);
    assert.strictEqual(stop.code, scenario.code, scenario.name);
    assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "original.account",
      scenario.name + ": the way home is kept until a probe says it is over");
  }
});

test("a dialog submit that may or may not have gone out is indeterminate", async () => {
  for (const options of [
    { dialogThrows: true },
    { dialog: { sent: true, failed: true } },
  ]) {
    const worker = loadWorkerBlock({ executeScript: stopScript(options) });
    await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");
    const stop = await worker.api.stopImpersonation(1, ORIGIN);
    assert.strictEqual(stop.code, "indeterminate", JSON.stringify(options));
    assert.strictEqual(called(worker).filter((name) => name === "unimpersonateThroughDialogInPage").length, 1,
      "never submitted twice");
  }
});

test("only a definite 403 goes round through the dialog", async () => {
  /* Anything else either did not change the session for a reason the dialog
   * would not fix, or may already have changed it. */
  const refusals = [400, 401, 404, 429, 500].map((status) => ({ rest: { ok: false, status } }));
  const ambiguous = [{ rest: { failed: true } }, { rest: null }];
  for (const options of refusals.concat(ambiguous)) {
    const worker = loadWorkerBlock({ executeScript: stopScript(options) });
    await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");
    await worker.api.stopImpersonation(1, ORIGIN);
    assert.deepStrictEqual(called(worker), ["impersonateInPage"], JSON.stringify(options));
  }
});

/* The page function itself, against a stand-in for the rendered dialog. */
function dialogPage({ first = "original.account", action = "ui_page_process.do?sys_id=abc", status = 200,
  hasForm = true } = {}) {
  const requests = [];
  const form = {
    attributes: { action, method: "post" },
    getAttribute(name) { return this.attributes[name] == null ? null : this.attributes[name]; },
    entries: [["sysparm_ck", "page-token"], ["imp_type", ""], ["sys_action", "none"], ["sys_display.QUERY:x", ""]],
  };
  const recent = { form: hasForm ? form : null, options: [{ value: first }, { value: "d".repeat(32) }] };
  const ok = { form };
  class FakeFormData {
    constructor(owner) { this.list = owner ? owner.entries.map((pair) => pair.slice()) : []; }
    set(name, value) {
      this.list = this.list.filter((pair) => pair[0] !== name);
      this.list.push([name, String(value)]);
    }
    [Symbol.iterator]() { return this.list[Symbol.iterator](); }
  }
  const globals = {
    location: { origin: ORIGIN },
    URL,
    URLSearchParams,
    FormData: FakeFormData,
    DOMParser: class {
      parseFromString() {
        return { getElementById: (id) => (id === "imp_recent" ? recent : id === "ok_button" ? ok : null) };
      }
    },
    fetch: async (url, init) => {
      requests.push({ url, init: init || {} });
      if (!init || !init.method) return { ok: status === 200, status, text: async () => "<html></html>" };
      return { status: 0, type: "opaqueredirect" };
    },
  };
  return { globals, requests };
}

test("the dialog is sent back as rendered, with the original chosen, to the platform's processor only", async () => {
  const page = dialogPage();
  const worker = loadWorkerBlock({ globals: page.globals });
  const result = await worker.api.unimpersonateThroughDialogInPage("original.account");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), { sent: true, status: 0, redirected: true });
  assert.strictEqual(page.requests.length, 2, "one read, one submit");
  assert.strictEqual(page.requests[0].url, ORIGIN + "/impersonate_dialog.do");
  const submit = page.requests[1];
  assert.strictEqual(submit.url, ORIGIN + "/ui_page_process.do?sys_id=abc");
  assert.strictEqual(submit.init.method, "POST");
  assert.strictEqual(submit.init.redirect, "manual", "the redirect is not followed");
  assert.strictEqual(submit.init.credentials, "same-origin");
  const sent = new URLSearchParams(submit.init.body.toString());
  assert.strictEqual(sent.get("sysparm_ck"), "page-token", "the form's own token travels with it");
  assert.strictEqual(sent.get("sys_action"), "none");
  assert.strictEqual(sent.get("imp_recent"), "original.account");
  assert.strictEqual(sent.get("sys_user"), "", "the user search is empty, as when a recent entry is chosen");
});

test("the dialog is never submitted unless it offers the original account first", async () => {
  const cases = [
    { name: "a different first entry", page: { first: "someone.else" }, reason: "no-way-home" },
    { name: "not impersonating: a sys_id first", page: { first: "d".repeat(32) }, reason: "no-way-home" },
    { name: "no form", page: { hasForm: false }, reason: "no-form" },
    { name: "an unreadable dialog", page: { status: 403 }, reason: "dialog-status" },
    { name: "another page as the action", page: { action: "sys_user.do" }, reason: "unexpected-action" },
    { name: "another host as the action", page: { action: "https://elsewhere.example/ui_page_process.do" },
      reason: "unexpected-action" },
  ];
  for (const scenario of cases) {
    const page = dialogPage(scenario.page);
    const worker = loadWorkerBlock({ globals: page.globals });
    const result = await worker.api.unimpersonateThroughDialogInPage("original.account");
    assert.strictEqual(result.sent, false, scenario.name);
    assert.strictEqual(result.reason, scenario.reason, scenario.name);
    assert.strictEqual(page.requests.filter((request) => request.init.method).length, 0,
      scenario.name + ": nothing was posted");
  }
});

test("the dialog fallback posts once, with no loop and no retry", () => {
  const code = stripComments(between(backgroundSource,
    "async function unimpersonateThroughDialogInPage(", "async function runDialogUnimpersonation("));
  assert.strictEqual((code.match(/method: "POST"/g) || []).length, 1);
  assert.ok(!/for\s*\(|while\s*\(|retry/i.test(code), "no loop and no retry in the page writer");
  assert.ok(code.includes('"/ui_page_process.do"'), "the destination is pinned");
  const stop = stripComments(between(backgroundSource,
    "async function stopImpersonation(", "* ServiceNow's own recent-impersonations list"));
  assert.ok(/outcome\.status === 403/.test(stop), "the fallback is gated on a definite 403");
});

test("a state probe reporting isImpersonating false clears the stored original", async () => {
  const worker = loadWorkerBlock({
    injectInDiscoveredFrames: async () => [
      frameAnswer(0, { isImpersonating: false, currentUserName: "", preferenceOriginal: "" }),
    ],
  });
  await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");
  const state = await worker.api.readImpersonationState(1, ORIGIN);
  assert.strictEqual(state.isImpersonating, false);
  assert.strictEqual(state.hasStopTarget, false);
  /* Otherwise a later panel would offer a Stop into a session that already
   * returned. */
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "");
});

test("the live preference wins over stored session state when they disagree", async () => {
  const worker = loadWorkerBlock({
    injectInDiscoveredFrames: async () => [
      frameAnswer(2, {
        isImpersonating: true,
        currentUserName: "current.identity",
        /* Another tool re-impersonated between our write and this read, which
         * makes the platform right and our stored value stale. */
        preferenceOriginal: "fresher.original",
      }),
    ],
  });
  await worker.api.rememberImpersonationOriginal(ORIGIN, "stale.original");
  const state = await worker.api.readImpersonationState(1, ORIGIN);
  assert.strictEqual(state.hasStopTarget, true);
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "fresher.original");
  /* And the panel still learns only a boolean. */
  assert.deepStrictEqual(
    Object.keys(state).sort(),
    ["currentUserName", "displayName", "hasStopTarget", "inconclusive", "isImpersonating", "ok"]
  );
  assert.ok(!JSON.stringify(state).includes("fresher.original"));
});

/* ------------------------------------------------------------------ *
 * Frame selection
 * ------------------------------------------------------------------ */

test("the state route never uses allFrames", () => {
  const reader = between(
    backgroundSource,
    "async function readImpersonationState(",
    "async function impersonateInPage("
  );
  const code = stripComments(reader);
  assert.ok(!/allFrames/.test(code),
    "allFrames never settles on this platform's about:blank frames, so a .catch would not save us");
  assert.ok(code.includes("injectInDiscoveredFrames"), "per-frame injection, through discovery");
  assert.ok(code.includes('world: "MAIN"'),
    "NOW.user and the preference scripts are unreachable from the isolated world");

  /* And neither does the mutation. */
  const mutation = between(backgroundSource, "async function runImpersonation(", "async function startImpersonation(");
  assert.ok(!/allFrames/.test(stripComments(mutation)));
});

test("frame selection prefers identity, falls back to the boolean, and never invents a Stop", async () => {
  const worker = loadWorkerBlock();
  const select = worker.api.selectImpersonationStateFrame;

  /* Top frame only: the boolean is a complete answer to "are you
   * impersonating", and nobody is named. */
  const topOnly = select([
    selectable(0, { isImpersonating: true, currentUserName: "", preferenceOriginal: "" }),
  ]);
  assert.strictEqual(topOnly.frame.frameId, 0);
  assert.strictEqual(topOnly.inconclusive, false);

  /* Two frames disagreeing resolve deterministically to the one that answered
   * in full; the boolean alone never overrides it. */
  const both = select([
    selectable(0, { isImpersonating: true, currentUserName: "", preferenceOriginal: "" }),
    selectable(3, {
      isImpersonating: true,
      currentUserName: "named.identity",
      preferenceOriginal: "original.account",
    }),
  ]);
  assert.strictEqual(both.frame.frameId, 3);
  assert.strictEqual(both.frame.value.currentUserName, "named.identity");

  /* Reversed arrival order gives the same answer. */
  const reversed = select([
    selectable(3, {
      isImpersonating: true, currentUserName: "named.identity", preferenceOriginal: "",
    }),
    selectable(0, { isImpersonating: true, currentUserName: "", preferenceOriginal: "" }),
  ]);
  assert.strictEqual(reversed.frame.frameId, 3);
});

test("a hung identity frame is inconclusive, never 'no Stop target'", async () => {
  const worker = loadWorkerBlock({
    injectInDiscoveredFrames: async () => [
      /* The top frame answers with the boolean; the frame that would have
       * carried the identity never answers at all. */
      frameAnswer(0, { isImpersonating: true, currentUserName: "", preferenceOriginal: "" }),
      frameFailure(4),
    ],
  });
  await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");
  const state = await worker.api.readImpersonationState(1, ORIGIN);

  assert.strictEqual(state.isImpersonating, true);
  assert.strictEqual(state.inconclusive, true, "the frame that timed out may be the one that knows");
  assert.strictEqual(state.currentUserName, "", "and it names nobody rather than guessing");
  /* Reading that silence as an absence would strand someone inside an
   * impersonated session with no offered way back. */
  assert.strictEqual(state.hasStopTarget, true);
});

test("no frame answering at all is inconclusive rather than 'not impersonating'", async () => {
  const worker = loadWorkerBlock({
    injectInDiscoveredFrames: async () => [frameFailure(0), frameFailure(2)],
  });
  const state = await worker.api.readImpersonationState(1, ORIGIN);
  assert.strictEqual(state.inconclusive, true);
  assert.strictEqual(state.hasStopTarget, false);
});

/* ------------------------------------------------------------------ *
 * A surface whose frames cannot answer: Service Portal
 * ------------------------------------------------------------------ */

/* What a portal page's top frame answers, measured on /sp and /esc: no
 * NOW.user, no g_user, and the current user ID on NOW itself. */
const PORTAL_FRAME = {
  answered: true,
  hasNowUser: false,
  isImpersonating: null,
  currentUserName: "portal.identity",
  displayName: "Portal Identity",
  preferenceOriginal: "",
};

test("a portal page names the current user from NOW, and never claims the boolean", () => {
  const worker = loadWorkerBlock({
    globals: {
      /* user_impersonating is present on a portal and `undefined` whether or
       * not the session is impersonated, so it must not be read as an answer. */
      NOW: { user_name: "portal.identity", user_display_name: "Portal Identity", user_impersonating: undefined },
      document: { scripts: [] },
    },
  });
  const read = worker.api.readImpersonationStateInPage();
  assert.strictEqual(read.hasNowUser, false);
  assert.strictEqual(read.isImpersonating, null);
  assert.strictEqual(read.currentUserName, "portal.identity");
  assert.strictEqual(read.displayName, "Portal Identity");

  /* A classic frame keeps its own sources: NOW.user_name is a portal global
   * and is never consulted where NOW.user exists. */
  const classic = loadWorkerBlock({
    globals: {
      NOW: { user: { isImpersonating: false, name: "classic.name" }, user_name: "stray.value" },
      document: { scripts: [] },
    },
  });
  const classicRead = classic.api.readImpersonationStateInPage();
  assert.strictEqual(classicRead.isImpersonating, false);
  assert.strictEqual(classicRead.currentUserName, "");
});

test("when no frame can say, the classic header is fetched for the boolean and the way home", async () => {
  const worker = loadWorkerBlock({
    injectInDiscoveredFrames: async () => [frameAnswer(0, PORTAL_FRAME)],
    executeScript: async () => [{
      result: { isImpersonating: true, preferenceOriginal: "original.account" },
    }],
  });
  const state = await worker.api.readImpersonationState(1, ORIGIN);

  /* The reported defect: this read as "not impersonating" and Stop vanished. */
  assert.strictEqual(state.isImpersonating, true);
  assert.strictEqual(state.inconclusive, false);
  assert.strictEqual(state.hasStopTarget, true);
  assert.strictEqual(state.currentUserName, "portal.identity");
  assert.strictEqual(state.displayName, "Portal Identity");
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "original.account");
  assert.ok(!JSON.stringify(state).includes("original.account"),
    "the panel still learns only a boolean");

  /* One MAIN-world read, in the one token-bearing frame discovery named. */
  assert.strictEqual(worker.calls.executeScript.length, 1);
  const request = worker.calls.executeScript[0];
  assert.strictEqual(request.func, worker.api.fetchImpersonationStateInPage);
  assert.strictEqual(request.world, "MAIN");
  assert.deepStrictEqual(Array.from(request.target.frameIds), [7]);
  assert.strictEqual(request.args, undefined, "the fetch takes nothing from the caller");
});

test("the fetched 'no' clears the stored way home, exactly as an in-page 'no' does", async () => {
  const worker = loadWorkerBlock({
    injectInDiscoveredFrames: async () => [frameAnswer(0, PORTAL_FRAME)],
    executeScript: async () => [{ result: { isImpersonating: false, preferenceOriginal: "" } }],
  });
  await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");
  const state = await worker.api.readImpersonationState(1, ORIGIN);
  assert.strictEqual(state.isImpersonating, false);
  assert.strictEqual(state.hasStopTarget, false);
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "");
});

test("an unreadable header leaves the state unknown, and keeps the way home", async () => {
  for (const reply of [
    [{ result: { isImpersonating: null, preferenceOriginal: "" } }],
    [{ result: null }],
    [],
  ]) {
    const worker = loadWorkerBlock({
      injectInDiscoveredFrames: async () => [frameAnswer(0, PORTAL_FRAME)],
      executeScript: async () => reply,
    });
    await worker.api.rememberImpersonationOriginal(ORIGIN, "original.account");
    const state = await worker.api.readImpersonationState(1, ORIGIN);
    assert.strictEqual(state.inconclusive, true, JSON.stringify(reply));
    /* Unknown is not "no": clearing here would discard the only way back. */
    assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "original.account");
  }

  const thrown = loadWorkerBlock({
    injectInDiscoveredFrames: async () => [frameAnswer(0, PORTAL_FRAME)],
    executeScript: async () => { throw new Error("frame is gone"); },
  });
  const state = await thrown.api.readImpersonationState(1, ORIGIN);
  assert.strictEqual(state.inconclusive, true);
});

test("a classic surface that answers both facts in-page costs no request", async () => {
  for (const answer of [
    { isImpersonating: false, currentUserName: "", preferenceOriginal: "" },
    { isImpersonating: true, currentUserName: "target.identity", preferenceOriginal: "original.account" },
  ]) {
    const worker = loadWorkerBlock({
      injectInDiscoveredFrames: async () => [frameAnswer(0, answer)],
    });
    await worker.api.readImpersonationState(1, ORIGIN);
    assert.strictEqual(worker.calls.executeScript.length, 0, JSON.stringify(answer));
    assert.strictEqual(worker.calls.discovery, 0);
  }
});

/* The Workspace top frame exactly as /now/sow/home exposed it: NOW.user holds
 * isImpersonating and userID and nothing else, with no g_user anywhere. */
const WORKSPACE_GLOBALS = {
  NOW: { user: { isImpersonating: true, userID: "a".repeat(32) } },
  document: { scripts: [] },
};

test("a Workspace page says impersonating but names no way home, so the header supplies it", async () => {
  /* Reported by the live probe: after a first impersonation from a Workspace
   * page, the panel said it did not know which account to return to and
   * offered no Stop. The endpoint's `user` is "null" on a first
   * impersonation, so nothing had been stored either. */
  const page = loadWorkerBlock({ globals: WORKSPACE_GLOBALS }).api.readImpersonationStateInPage();
  assert.strictEqual(page.isImpersonating, true);
  assert.strictEqual(page.currentUserName, "");
  assert.strictEqual(page.preferenceOriginal, "");

  const worker = loadWorkerBlock({
    injectInDiscoveredFrames: async () => [frameAnswer(0, page)],
    executeScript: async () => [{
      result: { isImpersonating: true, preferenceOriginal: "original.account" },
    }],
  });
  const state = await worker.api.readImpersonationState(1, ORIGIN);
  assert.strictEqual(state.isImpersonating, true);
  assert.strictEqual(state.hasStopTarget, true, "Stop is offered");
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "original.account");
  assert.ok(!JSON.stringify(state).includes("original.account"),
    "the panel still learns only a boolean");
  assert.strictEqual(worker.calls.executeScript.length, 1);
  assert.strictEqual(worker.calls.executeScript[0].func, worker.api.fetchImpersonationStateInPage);
});

test("the header supplies only the way home: the frame's boolean still stands", async () => {
  /* A header read a moment later that disagrees -- the session ended in
   * between -- does not overturn what the page said, and supplies nothing. */
  const worker = loadWorkerBlock({
    injectInDiscoveredFrames: async () => [
      frameAnswer(0, { isImpersonating: true, currentUserName: "", preferenceOriginal: "" }),
    ],
    executeScript: async () => [{ result: { isImpersonating: false, preferenceOriginal: "" } }],
  });
  await worker.api.rememberImpersonationOriginal(ORIGIN, "stored.account");
  const state = await worker.api.readImpersonationState(1, ORIGIN);
  assert.strictEqual(state.isImpersonating, true);
  assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "stored.account",
    "a fetched 'no' clears nothing when the page itself said yes");
  assert.strictEqual(state.hasStopTarget, true, "the stored way home survives");

  /* And an unreadable header leaves the stored way home as it was. */
  const unreadable = loadWorkerBlock({
    injectInDiscoveredFrames: async () => [
      frameAnswer(0, { isImpersonating: true, currentUserName: "", preferenceOriginal: "" }),
    ],
    executeScript: async () => { throw new Error("frame is gone"); },
  });
  const unknown = await unreadable.api.readImpersonationState(1, ORIGIN);
  assert.strictEqual(unknown.isImpersonating, true);
  assert.strictEqual(unknown.hasStopTarget, false, "nothing stored, nothing fetched, no guess");
});

/* The header exactly as the PDI rendered it, trimmed to the lines that matter. */
function classicHeader(impersonating, original) {
  return [
    "\twindow.NOW.user.lastName = 'Identity';",
    "\twindow.NOW.user.name = 'target.identity';",
    "  \twindow.NOW.user.isImpersonating = " + impersonating + ";",
    "\twindow.NOW.batch_glide_ajax_requests = 'true' === 'true';",
    "CustomEvent.fireTop('user.impersonation', '" + original + "');}try {",
  ].join("\n");
}

test("the fetch parses the measured header into two facts and returns nothing else", async () => {
  const fetches = [];
  const respond = (response) => loadWorkerBlock({
    globals: {
      location: { origin: ORIGIN },
      fetch: async (url, init) => {
        fetches.push({ url, init });
        if (response instanceof Error) throw response;
        return response;
      },
    },
  }).api.fetchImpersonationStateInPage();
  const page = (text, ok) => ({ ok: ok !== false, text: async () => text });

  const on = await respond(page(classicHeader("true", "original.account")));
  assert.strictEqual(JSON.stringify(on), JSON.stringify({
    isImpersonating: true, preferenceOriginal: "original.account",
  }));
  const off = await respond(page(classicHeader("false", "")));
  assert.strictEqual(JSON.stringify(off), JSON.stringify({ isImpersonating: false, preferenceOriginal: "" }));

  /* A login page (signed out), an error status and a failed request all leave
   * the answer unknown -- never "no". */
  for (const response of [
    page("<html><form id='login'></form></html>"),
    page(classicHeader("false", ""), false),
    new Error("offline"),
  ]) {
    const unknown = await respond(response);
    assert.strictEqual(unknown.isImpersonating, null);
  }

  /* One fixed same-origin GET: no method, no body, no token, nothing cached. */
  fetches.forEach(({ url, init }) => {
    assert.strictEqual(url, ORIGIN + "/glidelens_session_state.do");
    assert.strictEqual(init.credentials, "same-origin");
    assert.strictEqual(init.cache, "no-store");
    assert.strictEqual(init.method, undefined);
    assert.strictEqual(init.body, undefined);
    assert.ok(!("X-UserToken" in (init.headers || {})), "a GET of a page needs no token");
  });
});

test("the fallback fetch is one async GET that never writes to the page", () => {
  const fetcher = stripComments(between(
    backgroundSource,
    "async function fetchImpersonationStateInPage(",
    "async function readImpersonationStateFromShell("
  ));
  /* snUtils reads this page with a SYNCHRONOUS XHR, which freezes the tab. */
  assert.ok(!/XMLHttpRequest|GlideAjax|\$\.ajax/.test(fetcher));
  assert.strictEqual((fetcher.match(/fetch\(/g) || []).length, 1);
  assert.ok(!/method:|body:/.test(fetcher));
  assert.ok(!/for\s*\(|while\s*\(|retry/i.test(fetcher), "no loop and no retry");
  assert.ok(!/NOW(\.[A-Za-z_$]+)*\s*=[^=]|setPreference\(|document\.write|location\.href\s*=/.test(fetcher),
    "it reads a response, and never the page's own state");

  const runner = stripComments(between(
    backgroundSource,
    "async function readImpersonationStateFromShell(",
    "async function readImpersonationState("
  ));
  assert.ok(!/allFrames/.test(runner));
  assert.ok(runner.includes("discoverTokenFrame"));
  assert.ok(runner.includes("withTimeout"), "a hung frame must not hold the panel open");
  assert.ok(!/args:/.test(runner), "no caller-supplied value reaches the fetch");
});

/* ------------------------------------------------------------------ *
 * The recent-impersonations list
 * ------------------------------------------------------------------ */

test("the recent list is one fixed GET that returns ids and nothing else", async () => {
  const fetches = [];
  const worker = loadWorkerBlock({
    globals: {
      location: { origin: ORIGIN },
      g_ck: "page-token",
      fetch: async (url, init) => {
        fetches.push({ url, init });
        return {
          ok: true,
          json: async () => ({
            result: [
              { user_sys_id: "a".repeat(32), user_name: "someone", user_display_value: "Some One" },
              { user_name: "no.id" },
            ],
          }),
        };
      },
    },
  });
  const answer = await worker.api.recentImpersonationsInPage();
  assert.strictEqual(JSON.stringify(answer), JSON.stringify({ ok: true, sysIds: ["a".repeat(32), ""] }),
    "no name, user ID or avatar crosses back");
  assert.strictEqual(fetches.length, 1);
  assert.strictEqual(fetches[0].url, ORIGIN + "/api/now/ui/impersonate/recent");
  assert.strictEqual(fetches[0].init.method, undefined, "a GET");
  assert.strictEqual(fetches[0].init.body, undefined);
  assert.strictEqual(fetches[0].init.credentials, "same-origin");
  /* A REST read, unlike the header page, needs the session token. */
  assert.strictEqual(fetches[0].init.headers["X-UserToken"], "page-token");

  const code = stripComments(between(
    backgroundSource,
    "async function recentImpersonationsInPage(",
    "async function readRecentImpersonations("
  ));
  assert.strictEqual((code.match(/fetch\(/g) || []).length, 1);
  assert.ok(!/for\s*\(|while\s*\(|retry/i.test(code), "no loop and no retry");
});

test("the recent route validates, deduplicates and bounds the ids before they cross", async () => {
  const valid = [];
  for (let index = 0; index < 14; index += 1) valid.push(String(index).padStart(32, "b"));
  const worker = loadWorkerBlock({
    executeScript: async () => [{
      result: { ok: true, sysIds: [valid[0].toUpperCase(), valid[0], "nope", ""].concat(valid) },
    }],
  });
  const reply = await worker.api.readRecentImpersonations(1);
  assert.strictEqual(reply.ok, true);
  assert.deepStrictEqual(Array.from(reply.sysIds), valid.slice(0, 10));
  const request = worker.calls.executeScript[0];
  assert.strictEqual(request.world, "MAIN");
  assert.deepStrictEqual(Array.from(request.target.frameIds), [7], "one frame, not allFrames");
  assert.strictEqual(request.args, undefined, "no caller-supplied value reaches the fetch");
});

test("an unreadable recent list is an empty answer, never an error", async () => {
  for (const executeScript of [
    async () => { throw new Error("frame is gone"); },
    async () => [{ result: { ok: false, status: 403 } }],
    async () => [],
  ]) {
    const worker = loadWorkerBlock({ executeScript });
    const reply = await worker.api.readRecentImpersonations(1);
    assert.strictEqual(JSON.stringify(reply), JSON.stringify({ ok: false, sysIds: [] }));
  }
});

test("the confirmation's roles are read through the engine, by sys_id alone", () => {
  const hook = stripComments(between(contentSource, "onFindUserRoles: (user) =>", "onOpenUser:"));
  assert.ok(hook.includes("engine.readUserRoles(user && user.sysId,"),
    "the engine validates the sys_id and owns the query");
  assert.ok(!/sys_user_has_role|sys_user_role_contains|query|fields|chrome\.runtime/.test(hook),
    "content code names no table or query and sends no message of its own");
  assert.ok(hook.includes("panelClosed"), "a closed panel stops the read");
});

test("content code asks for the recent list by type alone and verifies it through the engine", () => {
  const loader = stripComments(between(
    contentSource,
    "async function loadImpersonateRecent(",
    "async function refreshImpersonateState("
  ));
  assert.ok(loader.includes('{ type: "SN_IMPERSONATE_RECENT" }'), "the message carries nothing else");
  assert.ok(loader.includes("engine.readRecentUsers(recent.sysIds"),
    "every id is re-read through the eligibility gate before it is shown");
  assert.ok(loader.includes("isClosed()"), "a closed panel is never repainted");
});

/* ------------------------------------------------------------------ *
 * Exactly once, and never retried
 * ------------------------------------------------------------------ */

test("one confirmation causes exactly one executeScript and one fetch", async () => {
  const worker = loadWorkerBlock({
    executeScript: async () => [{ result: { ok: true, status: 201, originalUserName: "null" } }],
  });
  await worker.api.startImpersonation(1, ORIGIN, "someone");
  assert.strictEqual(worker.calls.executeScript.length, 1);

  /* And the page-side function issues one fetch, with no loop or fallback. */
  const page = between(backgroundSource, "async function impersonateInPage(", "function impersonationFailureMessage(");
  const code = stripComments(page);
  assert.strictEqual((code.match(/fetch\(/g) || []).length, 1);
  assert.strictEqual((code.match(/method: "POST"/g) || []).length, 1);
  assert.ok(!/for\s*\(|while\s*\(|retry/i.test(code), "no loop and no retry in the page writer");
  /* Keyed by user_name and encoded, because usernames are commonly
   * email-shaped and are interpolated raw by the tool this betters. */
  assert.ok(code.includes("encodeURIComponent(userName)"));
  assert.ok(code.includes("/api/now/ui/impersonate/"));
  /* No request body at all: the verified contract sent none and got 201. */
  assert.ok(!/body:/.test(code));
});

test("the mutation resolves a frame fresh and never reuses the cached read frame", () => {
  const runner = between(backgroundSource, "async function runImpersonation(", "async function startImpersonation(");
  const code = stripComments(runner);
  assert.ok(code.includes("discoverTokenFrame"), "fresh discovery per confirmed action");
  assert.ok(!code.includes("resolveTokenFrame"),
    "resolveTokenFrame caches, which is safe for repeated reads and wrong for a mutation");
  assert.ok(!code.includes("codeSearchFrameGet"),
    "that path retries on 401 and on a lost frame; a mutation must not");
  assert.ok(!code.includes("SN_TABLE_GET"));
});

test("nothing is sent a second time after a rejection, a timeout or a missing result", async () => {
  const cases = [
    { name: "rejection", executeScript: async () => { throw new Error("frame is gone"); } },
    { name: "no result", executeScript: async () => [] },
    { name: "empty result", executeScript: async () => [{ result: null }] },
    { name: "page fetch threw", executeScript: async () => [{ result: { failed: true } }] },
  ];
  for (const scenario of cases) {
    const worker = loadWorkerBlock({ executeScript: scenario.executeScript });
    const reply = await worker.api.startImpersonation(1, ORIGIN, "someone");
    assert.strictEqual(reply.code, "indeterminate", scenario.name + " must be indeterminate");
    assert.strictEqual(worker.calls.executeScript.length, 1, scenario.name + " must not retry");
    assert.ok(/may or may not/i.test(reply.message), scenario.name);
    assert.ok(/user menu/i.test(reply.message), scenario.name);
    /* And nothing was recorded, because we do not know what happened. */
    assert.strictEqual(await worker.api.storedImpersonationOriginal(ORIGIN), "");
  }
});

test("a 401 is an access refusal, not a stale-frame retry", async () => {
  const worker = loadWorkerBlock({
    executeScript: async () => [{ result: { ok: false, status: 401 } }],
  });
  const reply = await worker.api.startImpersonation(1, ORIGIN, "someone");
  assert.strictEqual(reply.code, "access");
  /* The read path re-resolves the frame and tries again on a 401. This one
   * must not: the request already reached ServiceNow. */
  assert.strictEqual(worker.calls.executeScript.length, 1);
  assert.strictEqual(worker.calls.discovery, 1);
});

test("every status maps to a safe category and a message that names nothing", async () => {
  const expected = {
    400: "validation", 401: "access", 403: "access", 404: "validation",
    429: "transient", 500: "transient", 503: "transient",
  };
  for (const status of Object.keys(expected)) {
    const worker = loadWorkerBlock({
      executeScript: async () => [{ result: { ok: false, status: Number(status) } }],
    });
    const reply = await worker.api.startImpersonation(1, ORIGIN, "someone");
    assert.strictEqual(reply.code, expected[status], "status " + status);
    assert.strictEqual(reply.ok, false);
    assert.ok(!/service-now|https?:|someone|[0-9a-f]{32}/.test(reply.message),
      "status " + status + " leaked: " + reply.message);
  }

  /* A malformed body is a success status with nothing usable in it: the
   * session DID change, so it is not an error. */
  const malformed = loadWorkerBlock({
    executeScript: async () => [{ result: { ok: true, status: 201, originalUserName: "" } }],
  });
  const reply = await malformed.api.startImpersonation(1, ORIGIN, "someone");
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(await malformed.api.storedImpersonationOriginal(ORIGIN), "",
    "and an unreadable original leaves no Stop target rather than a guessed one");
});

/* ------------------------------------------------------------------ *
 * Username validation
 * ------------------------------------------------------------------ */

test("an invalid username is refused before any frame discovery", async () => {
  for (const value of ["", "   ", "null", "x".repeat(41), "bad" + String.fromCharCode(10)]) {
    const worker = loadWorkerBlock();
    const reply = await worker.api.startImpersonation(1, ORIGIN, value);
    assert.strictEqual(reply.ok, false, JSON.stringify(value));
    assert.strictEqual(reply.code, "validation", JSON.stringify(value));
    assert.strictEqual(worker.calls.discovery, 0,
      "an invalid value must never get as far as a token-bearing frame");
    assert.strictEqual(worker.calls.executeScript.length, 0);
  }
});

test("email-shaped and non-ASCII user IDs pass, and arrive byte for byte", async () => {
  const sent = [];
  const worker = loadWorkerBlock({
    executeScript: async (request) => {
      sent.push(request.args[0]);
      return [{ result: { ok: true, status: 201, originalUserName: "null" } }];
    },
  });
  /* A character allowlist such as [A-Za-z0-9._-]+ would reject both, and the
   * failure would surface first on a customer instance with international
   * users. This platform also distinguishes identifiers differing only by a
   * trailing space, so nothing here may trim or case-fold. */
  const identities = [
    "first.last@example.com",
    "Захаров",
    "Mixed.Case",
    "trailing ",
  ];
  for (const identity of identities) {
    assert.strictEqual(worker.api.validImpersonationUserName(identity), true, identity);
    await worker.api.startImpersonation(1, ORIGIN, identity);
  }
  assert.deepStrictEqual(sent, identities);
});

/* ------------------------------------------------------------------ *
 * Injection, wiring and the panel contract
 * ------------------------------------------------------------------ */

test("injection loads the engine's dependency, the engine and the panel, in that order", () => {
  const inject = between(
    backgroundSource,
    'if (msg && msg.type === "INJECT_IMPERSONATE"',
    'if (msg && msg.type === "SN_IMPERSONATE_STATE"'
  );
  assert.ok(inject.includes(
    'files: ["record_search.js", "impersonate.js", "impersonate_ui.js"]'
  ), "record_search.js supplies the anchors, ranking and transport this reuses");
  /* Its PANEL is deliberately absent: a generic table picker and read-only
   * record actions do not belong in a flow that changes the session. */
  assert.ok(!inject.includes("record_search_ui.js"));
  assert.ok(inject.includes("frameIds: [sender.frameId || 0]"),
    "into the frame that asked, not into every frame");
});

test("the content script pins the complete panel contract it depends on", () => {
  const declared = between(contentSource, "const IMPERSONATE_UI_METHODS = [", "];");
  const ui = uiSource.replace(/\r\n/g, "\n");
  [
    "open", "showSearchBusy", "showResults", "showError", "showConfirmation",
    "showMutationState", "showCurrentState", "showRecent", "close", "isOpen",
  ].forEach((method) => {
    assert.ok(declared.includes('"' + method + '"'), method + " must be in the pinned contract");
    assert.ok(
      new RegExp("^\\s{4}" + method + "[,:]", "m").test(ui),
      method + " must actually be exported by the panel"
    );
  });
});

test("content code names no table, url, method or body anywhere in this flow", () => {
  const block = between(
    contentSource,
    "async function ensureImpersonateLoaded(",
    "/* ====================================================================="
  );
  const code = stripComments(block);
  ["sys_user", "sys_user_role", "sys_user_has_role", "sys_user_role_contains", "sys_user_group",
    "sys_user_grmember", "/api/", "fetch(", "method:", "body:"]
    .forEach((needle) => {
      assert.ok(!code.includes(needle), "content code must not name " + needle);
    });
  /* The only thing it sends is a username, and only for a start. */
  assert.ok(code.includes("type: \"SN_IMPERSONATE_START\""));
  assert.ok(code.includes("userName: valid.userName"));
  const stop = between(block, "onStop: async () => {", "},");
  assert.ok(stop.includes('type: "SN_IMPERSONATE_STOP"'));
  assert.ok(!/userName|sysId|target/.test(stripComments(stop)),
    "Stop must carry no target from content code");
});

test("the impersonation dialog opens through the validated tab route and is never submitted", () => {
  const hook = stripComments(between(contentSource, "onOpenImpersonateDialog: () => {", "},"));
  assert.ok(hook.includes('type: "OPEN_URL"'),
    "the worker's OPEN_URL checks the destination is this instance");
  assert.ok(hook.includes("engine.buildImpersonateDialogUrl(location.origin)"),
    "the engine builds the address, as it does the user record link");
  assert.ok(!/fetch\(|method:|body:|SN_IMPERSONATE|userName|sysId/.test(hook),
    "opening the dialog sends nothing and chooses no account");
});

test("picker lookups and searches supersede themselves, not each other", () => {
  const block = between(
    contentSource,
    "async function ensureImpersonateLoaded(",
    "/* ====================================================================="
  );
  /* One tracker each. Sharing one would let a suggestion lookup silently
   * discard a search already in flight, and would make a superseded lookup
   * render "no matches" -- a different and untrue statement. */
  assert.ok(block.includes("impersonateLookupSession"));
  ["onFindRoles", "onFindGroups", "onFindAttributeFields", "onFindAttributeValues"]
    .forEach((name) => {
      assert.ok(new RegExp(name + ":[^\\n]*runLookup").test(block),
        name + " must use the lookup tracker");
    });
  assert.ok(/onSearch: \(request\) => runCurrent/.test(block),
    "the search keeps the tracker that role, group and attribute changes cancel");
  /* And changing any filter cancels the search, per the cancellation rule. */
  assert.ok(/onRoleChanged: \(\) => impersonateSession\.cancel\(\)/.test(block));
  assert.ok(/onGroupChanged: \(\) => impersonateSession\.cancel\(\)/.test(block));
  assert.ok(/onAttributeFieldChanged: \(\) => impersonateSession\.cancel\(\)/.test(block));
});

test("the chosen row is revalidated against the rendered list before anything is sent", () => {
  const handler = between(contentSource, "onImpersonate: async (user) => {", "onStop:");
  assert.ok(handler.includes("impersonateRenderedResults"),
    "a stale row from a superseded search must not become the target");
  /* The only other list a row may come from is the recent list this panel
   * verified, which is cleared with the panel like the results are. */
  assert.ok(handler.includes(".concat(impersonateRecentUsers || [])"));
  const cancel = between(contentSource, "onCancel: () => {", "},");
  assert.ok(cancel.includes("impersonateRecentUsers = [];"));
  assert.ok(handler.includes("validateUserName"));
  /* Nothing is re-read from the DOM on the way to the worker. */
  assert.ok(!/querySelector|textContent|getAttribute/.test(stripComments(handler)));
});

test("the tab reloads only after a definite success", () => {
  const block = between(
    contentSource,
    "async function ensureImpersonateLoaded(",
    "/* ====================================================================="
  );
  /* Call sites only -- the helper's own declaration is in this block too. */
  const reloads = stripComments(block)
    .match(/if \(outcome && outcome\.ok\) reloadAfterSessionChange\(\)/g) || [];
  assert.strictEqual(reloads.length, 2, "once for start, once for stop");
  ["onImpersonate", "onStop"].forEach((name) => {
    const handler = between(block, name + ":", "\n    },");
    assert.ok(/if \(outcome && outcome\.ok\) reloadAfterSessionChange\(\)/.test(handler),
      name + " must reload only on outcome.ok");
  });
  /* An indeterminate outcome must not reload: that would destroy the one
   * place the ambiguity is explained. */
  assert.ok(!/indeterminate[\s\S]{0,120}reloadAfterSessionChange/.test(block));
});

test("the palette lists one Impersonate command, in Tools", () => {
  const command = between(contentSource, 'id: "impersonate",', "},");
  assert.ok(command.includes('label: "Impersonate"'));
  assert.ok(command.includes(
    'description: "Find a user by identity, role or group and start impersonation"'
  ));
  /* Tools, not Record: it changes the session, not the open record. */
  assert.ok(command.includes('group: "Tools"'));
  assert.ok(command.includes("run: openImpersonate"));
  ["user", "username", "email", "role", "group", "member", "country", "test", "impersonator",
    "switch user"]
    .forEach((keyword) => {
      assert.ok(command.includes('"' + keyword + '"'), "missing keyword " + keyword);
    });

  /* The command is offered before authority is known: the endpoint is
   * authoritative, and its denial becomes an access error. */
  assert.ok(!/isAdmin|hasRole|canImpersonate/.test(command),
    "authority must not be inferred from a client global");
});

test("both new files ship, and the manifest gains no permission", () => {
  const ship = between(packageSource, "const SHIP = [", "];");
  assert.ok(ship.includes('"impersonate.js"'));
  assert.ok(ship.includes('"impersonate_ui.js"'));

  const manifest = JSON.parse(read("manifest.json"));
  assert.deepStrictEqual(manifest.permissions, ["scripting", "storage", "clipboardWrite"]);
  assert.deepStrictEqual(manifest.host_permissions, ["https://*.service-now.com/*"]);
  /* Neither new file is a content script: both are injected on demand. */
  const declared = manifest.content_scripts[0].js;
  assert.ok(!declared.includes("impersonate.js"));
  assert.ok(!declared.includes("impersonate_ui.js"));
});

/* ------------------------------------------------------------------ *
 * What the page reader may do
 * ------------------------------------------------------------------ */

test("the state reader never writes to the page and never fires an XHR", () => {
  const reader = between(
    backgroundSource,
    "function readImpersonationStateInPage(",
    "function selectImpersonationStateFrame("
  );
  const code = stripComments(reader);
  /*
   * snUtils regex-scrapes a script tag and, on a miss, fires a SYNCHRONOUS XHR
   * at a deliberate 404 and regexes the response. Our reader runs in the page,
   * where a blocking call freezes the tab -- the defect class this codebase
   * already has a timing test for.
   */
  ["XMLHttpRequest", "fetch(", "$.ajax", "GlideAjax"].forEach((call) => {
    assert.ok(!code.includes(call), "the state read must not call out: found " + call);
  });
  ["setPreference(", "location.href =", "document.write"].forEach((write) => {
    assert.ok(!code.includes(write), "the state read must not write: found " + write);
  });
  /* Reading NOW.user is the whole point; assigning to it is not. */
  assert.ok(!/NOW\.user(\.[A-Za-z_$]+)*\s*=[^=]/.test(code),
    "the state read must not assign to the page's own user object");
  assert.ok(!/g_user(\.[A-Za-z_$]+)*\s*=[^=]/.test(code));
  /* It reads the already-parsed DOM and the globals, each in its own guard,
   * because a torn-down or cross-origin frame throws on any of them. */
  assert.ok(code.includes("NOW.user.isImpersonating"));
  assert.ok(code.includes("g_user.userName"));
  assert.ok(code.includes("document.scripts"));
  assert.strictEqual((code.match(/catch \(error\)/g) || []).length, 3,
    "each of the three reads needs its own guard");
});

test("the engine is DOM-free, so the suite can run the real one", () => {
  const code = stripComments(engineSource);
  ["document.", "window.", "innerHTML", "addEventListener", "querySelector"]
    .forEach((api) => {
      assert.ok(!code.includes(api), "the engine must stay DOM-free: found " + api);
    });
});

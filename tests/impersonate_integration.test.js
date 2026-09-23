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

test("the worker exposes exactly three impersonation routes, and none is a proxy", () => {
  const listener = between(
    backgroundSource,
    'if (msg && msg.type === "INJECT_IMPERSONATE"',
    'if (msg && msg.type === "SN_RECORD_SEARCH_GET"'
  );
  ["SN_IMPERSONATE_STATE", "SN_IMPERSONATE_START", "SN_IMPERSONATE_STOP"].forEach((route) => {
    assert.ok(listener.includes(route), "missing route " + route);
  });

  /* START reads exactly one field off the message, and STATE and STOP read
   * none. No url, method, table, query, body or header crosses this boundary. */
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
    "showMutationState", "showCurrentState", "close", "isOpen",
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
  ["sys_user", "sys_user_role", "sys_user_has_role", "sys_user_group", "sys_user_grmember",
    "/api/", "fetch(", "method:", "body:"]
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

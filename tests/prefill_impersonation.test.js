/*
 * Variable Prefill while impersonating.
 *
 *   node --test tests/prefill_impersonation.test.js
 *
 * DEV-ONLY, like its siblings. Prefill reads its source ticket as whoever the
 * session is. Measured on the PDI and on a configured customer instance, an
 * impersonated requester without itil, sn_request_read, variable_reader or
 * catalog_admin is refused every catalog-variable table. So when a read is
 * refused while impersonating, Prefill offers to end the impersonation, read,
 * impersonate the same account again and only then fill -- and does it only
 * from an explicit click, because it changes the session and writes to the
 * instance's audit log.
 *
 * The first half runs the worker's real impersonation block against a
 * simulated server that tracks who the session is. The second runs the real
 * content-script command against a simulated instance and worker.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8").replace(/\r\n/g, "\n");
const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8").replace(/\r\n/g, "\n");

const stripComments = (source) =>
  String(source).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, "source block not found: " + startText);
  return source.slice(start, end);
}

const ORIGIN = "https://example.service-now.com";
const SELF = "admin.self";
const TARGET = "abel.tuter";

/* ------------------------------------------------------------------ *
 * The worker
 * ------------------------------------------------------------------ */

/*
 * A server that knows who the session is. Each in-page function the worker
 * injects is answered from it, so a switch the worker makes is a switch the
 * next read sees -- and the page's own globals, rendered at load, do not move.
 */
function makeServer(overrides) {
  return Object.assign({
    original: SELF,
    current: TARGET,
    /* What NOW.user_name said when the page loaded. */
    pageUserName: TARGET,
    endpointRefusesStop: false,
    refuseImpersonate: false,
    hideCurrentUser: false,
    posts: [],
    dialogSubmits: 0,
  }, overrides);
}

function loadWorker(server) {
  const block = between(
    backgroundSource,
    "const IMPERSONATE_STATE_KEY",
    "// Content scripts can't call chrome.tabs.create"
  );
  const session = Object.create(null);
  const answer = (value) => [{ result: value }];
  const chrome = {
    storage: {
      session: {
        get: async (key) => (key in session ? { [key]: session[key] } : {}),
        set: async (item) => { Object.assign(session, item); },
      },
    },
    scripting: {
      executeScript: async (request) => {
        const name = request.func && request.func.name;
        if (name === "impersonateInPage") {
          const userName = request.args[0];
          server.posts.push(userName);
          const toSelf = userName === server.original;
          if (server.refuseImpersonate || (toSelf && server.endpointRefusesStop)) {
            return answer({ ok: false, status: 403, originalUserName: "", impersonatedUserName: "" });
          }
          const wasImpersonating = server.current !== server.original;
          server.current = userName;
          return answer({
            ok: true,
            status: 200,
            originalUserName: wasImpersonating ? server.original : "null",
            impersonatedUserName: userName,
          });
        }
        if (name === "sessionUserNameInPage") {
          return answer(server.hideCurrentUser ? "" : server.current);
        }
        if (name === "fetchImpersonationStateInPage") {
          const impersonating = server.current !== server.original;
          return answer({
            isImpersonating: impersonating,
            preferenceOriginal: impersonating ? server.original : "",
          });
        }
        if (name === "unimpersonateThroughDialogInPage") {
          server.dialogSubmits += 1;
          server.current = server.original;
          return answer({ sent: true, status: 302, redirected: true });
        }
        if (name === "recentImpersonationsInPage") return answer({ ok: true, sysIds: [] });
        return answer(null);
      },
    },
  };
  const sandbox = {
    chrome, console, setTimeout, clearTimeout, Promise, URL, Number, Object, String,
    Boolean, Error, JSON, Date, Math, Map, Set, Array,
    withTimeout: (promise) => promise,
    discoverTokenFrame: async () => 0,
    /* A Service Portal page: no NOW.user, so the boolean comes from the shell
     * fetch, and NOW.user_name names whoever the page was loaded as. */
    injectInDiscoveredFrames: async () => [{
      frameId: 0,
      ok: true,
      results: [{
        result: {
          answered: true,
          hasNowUser: false,
          isImpersonating: null,
          currentUserName: server.pageUserName,
          displayName: "",
          preferenceOriginal: "",
        },
      }],
    }],
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox, { filename: "background.js#impersonate" });
  return { api: sandbox, session };
}

const storedOriginal = (worker) => (worker.session.impersonateOriginals || {})[ORIGIN];

test("a confirmed switch reads as you and puts the same impersonation back", async () => {
  const server = makeServer();
  const worker = loadWorker(server);

  const begin = await worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(begin)), { ok: true, code: "ok" });
  assert.strictEqual(server.current, SELF, "the read happens as you");

  const end = await worker.api.endPrefillSwap(1, ORIGIN);
  assert.strictEqual(end.ok, true);
  assert.strictEqual(server.current, TARGET, "and the fill as the impersonated account");
  assert.deepStrictEqual(server.posts, [SELF, TARGET], "exactly one request per switch");
  assert.strictEqual(storedOriginal(worker), SELF, "Stop still knows the way home afterwards");
});

test("your own account never crosses back to content code", async () => {
  const server = makeServer();
  const worker = loadWorker(server);
  const replies = [
    await worker.api.beginPrefillSwap(1, ORIGIN, TARGET),
    await worker.api.endPrefillSwap(1, ORIGIN),
  ];
  replies.forEach((reply) => assert.ok(!JSON.stringify(reply).includes(SELF)));
});

test("nothing is switched when the session is not the account the person confirmed", async () => {
  const server = makeServer({ current: "someone.else", pageUserName: "someone.else" });
  const worker = loadWorker(server);
  const begin = await worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  assert.strictEqual(begin.ok, false);
  assert.strictEqual(begin.code, "changed");
  assert.deepStrictEqual(server.posts, []);
});

test("the server's answer about who you are wins over the page's stale one", async () => {
  /* The page was loaded as the target, but the session has since moved. */
  const server = makeServer({ current: "someone.else", pageUserName: TARGET });
  const worker = loadWorker(server);
  const begin = await worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  assert.strictEqual(begin.code, "changed");
  assert.deepStrictEqual(server.posts, []);
});

test("nothing is switched when the session is not impersonating", async () => {
  const server = makeServer({ current: SELF, pageUserName: SELF });
  const worker = loadWorker(server);
  const begin = await worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  assert.strictEqual(begin.code, "not-impersonating");
  assert.deepStrictEqual(server.posts, []);
});

test("an endpoint that refuses the way back is answered through the stock dialog", async () => {
  const server = makeServer({ endpointRefusesStop: true });
  const worker = loadWorker(server);
  const begin = await worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  assert.strictEqual(begin.ok, true);
  assert.strictEqual(server.dialogSubmits, 1);
  assert.strictEqual(server.current, SELF);
});

test("a refused re-impersonation says you are now yourself, and is not sent twice", async () => {
  const server = makeServer();
  const worker = loadWorker(server);
  await worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  server.refuseImpersonate = true;
  const end = await worker.api.endPrefillSwap(1, ORIGIN);
  assert.strictEqual(end.ok, false);
  assert.match(end.message, /did not impersonate abel\.tuter again, so you are now yourself\. Nothing was filled\./);
  assert.deepStrictEqual(server.posts, [SELF, TARGET]);
  const again = await worker.api.endPrefillSwap(1, ORIGIN);
  assert.strictEqual(again.code, "lost");
  assert.deepStrictEqual(server.posts, [SELF, TARGET], "a second END sends nothing");
});

test("an end with no switch in progress sends nothing", async () => {
  const server = makeServer();
  const worker = loadWorker(server);
  const end = await worker.api.endPrefillSwap(1, ORIGIN);
  assert.strictEqual(end.code, "lost");
  assert.deepStrictEqual(server.posts, []);
});

test("a second switch on the same tab waits for the first", async () => {
  const server = makeServer();
  const worker = loadWorker(server);
  await worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  const second = await worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  assert.strictEqual(second.code, "busy");
  assert.deepStrictEqual(server.posts, [SELF]);
});

test("two switches started together send one request between them", async () => {
  const server = makeServer();
  const worker = loadWorker(server);
  const replies = await Promise.all([
    worker.api.beginPrefillSwap(1, ORIGIN, TARGET),
    worker.api.beginPrefillSwap(1, ORIGIN, TARGET),
  ]);
  assert.deepStrictEqual(replies.map((reply) => reply.code), ["ok", "busy"]);
  assert.deepStrictEqual(server.posts, [SELF]);
});

test("a refused first switch leaves the tab free for the next attempt", async () => {
  const server = makeServer({ current: SELF, pageUserName: SELF });
  const worker = loadWorker(server);
  assert.strictEqual((await worker.api.beginPrefillSwap(1, ORIGIN, TARGET)).code, "not-impersonating");
  server.current = TARGET;
  server.pageUserName = TARGET;
  assert.strictEqual((await worker.api.beginPrefillSwap(1, ORIGIN, TARGET)).ok, true);
});

test("the switch is held until the switch back has settled", async () => {
  const server = makeServer();
  const worker = loadWorker(server);
  await worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  const ending = worker.api.endPrefillSwap(1, ORIGIN);
  const begin = await worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  const endAgain = await worker.api.endPrefillSwap(1, ORIGIN);
  assert.strictEqual(begin.code, "busy", "nothing new starts while the session may still be yours");
  assert.strictEqual(endAgain.code, "lost", "and a second switch back sends nothing");
  assert.strictEqual((await ending).ok, true);
  assert.deepStrictEqual(server.posts, [SELF, TARGET]);
});

test("a switch back from another page leaves the switch for its own page", async () => {
  const server = makeServer();
  const worker = loadWorker(server);
  await worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  const stray = await worker.api.endPrefillSwap(1, "https://other.example.com");
  assert.strictEqual(stray.code, "lost");
  assert.deepStrictEqual(server.posts, [SELF]);
  assert.strictEqual((await worker.api.endPrefillSwap(1, ORIGIN)).ok, true);
  assert.strictEqual(server.current, TARGET);
});

test("a switch back cannot start while the first switch is still in flight", async () => {
  const server = makeServer();
  const worker = loadWorker(server);
  const beginning = worker.api.beginPrefillSwap(1, ORIGIN, TARGET);
  const early = await worker.api.endPrefillSwap(1, ORIGIN);
  assert.strictEqual(early.code, "lost");
  assert.strictEqual((await beginning).ok, true);
  assert.deepStrictEqual(server.posts, [SELF], "no impersonation raced the Stop");
  assert.strictEqual((await worker.api.endPrefillSwap(1, ORIGIN)).ok, true);
});

test("an account the server will not describe is confirmed by the impersonation flag", async () => {
  const server = makeServer({ hideCurrentUser: true });
  const worker = loadWorker(server);
  assert.strictEqual((await worker.api.beginPrefillSwap(1, ORIGIN, TARGET)).ok, true);
  assert.strictEqual((await worker.api.endPrefillSwap(1, ORIGIN)).ok, true);
  assert.strictEqual(server.current, TARGET);
});

test("the switch routes read one checked field and nothing that could steer them", () => {
  const listener = between(
    backgroundSource,
    'if (msg && msg.type === "PREFILL_SWAP_BEGIN"',
    'if (msg && msg.type === "GET_PORTAL_VARIABLE_DEBUG"'
  );
  const fromMessage = Array.from(new Set(stripComments(listener).match(/msg\.[A-Za-z_]+/g) || [])).sort();
  assert.deepStrictEqual(fromMessage, ["msg.expectedTarget", "msg.type"]);
  /* The four Impersonate routes stay four. */
  assert.ok(!/SN_IMPERSONATE_[A-Z]+/.test(listener));
});

test("a refused table read tells content its status, so a 403 is not mistaken for a fault", () => {
  const route = stripComments(between(
    backgroundSource,
    'if (msg && msg.type === "SN_TABLE_GET"',
    'if (msg && msg.type === "SN_TRANSLATION_GET"'
  ));
  assert.match(route, /item\.status === 403/);
  assert.match(route, /reply\.status = error\.status/);
});

/* ------------------------------------------------------------------ *
 * The command
 * ------------------------------------------------------------------ */

const id = (n) => Number(n).toString(16).padStart(32, "0");
const CASE_ID = id(1);
const RITM_ID = id(2);
const ITEM_ID = id(3);
const field = (value) => ({ value, display_value: value });

function answerRow(n, name, value) {
  return {
    sys_id: field(id(100 + n)),
    value: field(value),
    table_name: field("sn_slm_case"),
    table_sys_id: field(CASE_ID),
    question: field(id(200 + n)),
    "question.active": field("true"),
    "question.name": field(name),
    "question.question_text": field(name + " label"),
    "question.type": field("6"),
    "question.order": field(String(100 * n)),
    "question.variable_set": field(""),
    "question.reference": field(""),
    "question.lookup_table": field(""),
    "question.list_table": field(""),
  };
}

const RITM2_ID = id(4);

function catalogRow(n, name, value) {
  const option = (column, v) => ["sc_item_option." + column, field(v)];
  return Object.fromEntries([
    option("sys_id", id(400 + n)),
    option("value", value),
    option("item_option_new", id(500 + n)),
    option("item_option_new.name", name),
    option("item_option_new.question_text", name + " label"),
    option("item_option_new.type", "6"),
    option("item_option_new.order", String(100 * n)),
    option("item_option_new.variable_set", ""),
    option("item_option_new.reference", ""),
    option("item_option_new.lookup_table", ""),
    option("item_option_new.list_table", ""),
  ]);
}

function namelessRow(row) {
  const copy = Object.assign({}, row);
  Object.keys(copy)
    .filter((key) => key.startsWith("question."))
    .forEach((key) => { copy[key] = field(""); });
  return copy;
}

/*
 * The instance as each account sees it, from the two live measurements:
 *   - a producer-backed case: the requester can see the case row but is
 *     refused question_answer and the multi-row table (customer instance);
 *   - a request item: the requester cannot see the row at all (PDI).
 * An admin reads everything. page.fault(table) can replace any answer, for a
 * read that times out or fails on the server. RITM0002 is a request item an
 * itil requester reads (customer instance): its own answers, but a 403 from
 * question_answer, which holds nothing for request items there.
 * page.readsAnswers / page.readsMultiRow let the requester read those tables.
 */
function tableAnswer(page, msg) {
  const fault = page.fault && page.fault(msg.table);
  if (fault) return fault;
  const asYou = page.session === "you";
  const refused = { ok: false, status: 403, error: "HTTP 403 reading " + msg.table };
  if (msg.table === "task") {
    if (msg.query === "number=SCASE0001") {
      return { ok: true, result: [{ sys_id: CASE_ID, number: "SCASE0001", sys_class_name: "sn_slm_case" }] };
    }
    if (msg.query === "number=RITM0001") {
      return { ok: true, result: asYou ? [{ sys_id: RITM_ID, number: "RITM0001", sys_class_name: "sc_req_item" }] : [] };
    }
    if (msg.query === "number=SCASE0002") {
      return { ok: true, result: [{ sys_id: id(9), number: "SCASE0002", sys_class_name: "sn_slm_case" }] };
    }
    if (msg.query === "number=RITM0002") {
      return { ok: true, result: [{ sys_id: RITM2_ID, number: "RITM0002", sys_class_name: "sc_req_item" }] };
    }
    return { ok: true, result: [] };
  }
  if (msg.table === "sc_item_option_mtom" && msg.query === "request_item=" + RITM2_ID) {
    return { ok: true, result: [catalogRow(1, "laptop_model", "X1"), catalogRow(2, "justification", "Travel")] };
  }
  if (msg.table === "question_answer" && msg.query.includes(RITM2_ID)) {
    return asYou ? { ok: true, result: [] } : refused;
  }
  if (msg.table === "sc_multi_row_question_answer" && page.readsMultiRow) {
    return { ok: true, result: [] };
  }
  if (msg.table === "sc_cat_item" || msg.table === "sc_cat_item_producer") {
    return { ok: true, result: msg.table === "sc_cat_item" && msg.query === "sys_id=" + ITEM_ID
      ? [{ sys_id: field(ITEM_ID), name: field("Laptop"), sys_class_name: field("sc_cat_item") }] : [] };
  }
  if (msg.table === "question_answer") {
    const rows = [answerRow(1, "supplier_name", "Acme"), answerRow(2, "country", "FR")];
    /* variable_reader alone, as measured: every answer row and value, and a
     * blank question.* on every one, because the questions are not readable. */
    if (!asYou && page.hideDefinitions) return { ok: true, result: rows.map(namelessRow) };
    if (!asYou && !page.readsAnswers) return refused;
    if (msg.query.includes(id(9))) return { ok: true, result: [] };
    /* A deleted question: its answer row survives with a dangling reference. */
    if (page.deletedQuestion) rows.push(namelessRow(answerRow(3, "", "orphaned")));
    return { ok: true, result: rows };
  }
  if (msg.table === "sc_multi_row_question_answer" || msg.table === "sc_item_option_mtom") {
    return asYou || page.hideDefinitions ? { ok: true, result: [] } : refused;
  }
  return { ok: true, result: [] };
}

function makePage(overrides) {
  return Object.assign({
    /* Who the session is: "target" while impersonating, "you" otherwise. */
    session: "target",
    impersonating: true,
    hasStopTarget: true,
    beginFails: null,
    endFails: null,
    formOpen: true,
    sent: [],
    toasts: [],
    toastStates: [],
    confirmations: [],
    filled: null,
    paletteOpen: true,
    reopened: 0,
  }, overrides);
}

function loadCommand(page) {
  const block = between(contentSource, "async function snGetMany(", "async function copyPortalVariableDebugInfo");
  const chromeStub = {
    runtime: {
      sendMessage: async (msg) => {
        page.sent.push(msg.type + (msg.type === "SN_TABLE_GET" ? ":" + msg.table + "@" + page.session : ""));
        if (msg.type === "SN_TABLE_GET" && page.session === "you" && page.duringReadAsYou) {
          const hook = page.duringReadAsYou;
          page.duringReadAsYou = null;
          hook();
        }
        if (msg.type === "SN_TABLE_GET") return tableAnswer(page, msg);
        if (msg.type === "SN_IMPERSONATE_STATE") {
          return { ok: true, isImpersonating: page.impersonating, inconclusive: false,
            currentUserName: page.impersonating ? TARGET : SELF, hasStopTarget: page.hasStopTarget };
        }
        if (msg.type === "PREFILL_SWAP_BEGIN") {
          page.beginTarget = msg.expectedTarget;
          if (page.beginFails) return { ok: false, code: "refused", message: page.beginFails };
          page.session = "you";
          return { ok: true, code: "ok" };
        }
        if (msg.type === "PREFILL_SWAP_END") {
          if (page.endFails) return { ok: false, code: "refused", message: page.endFails };
          page.session = "target";
          return { ok: true, code: "ok", target: TARGET };
        }
        if (msg.type === "FILL_PORTAL_VARIABLES") {
          page.filled = { variables: msg.variables, as: page.session };
          if (!page.formOpen) return { ok: true, foundForm: false };
          return { ok: true, foundForm: true, filled: msg.variables.length, alreadySet: 0, skipped: 0, unmatched: 0 };
        }
        return undefined;
      },
    },
  };
  return new Function(
    "chrome", "showToast", "SNH", "PREFILL_REPLY_CEILING_MS", "sysIdFromText", "location", "document",
    "showPaletteConfirmation", "clearPaletteConfirmation", "openPalette", "paletteToast",
    block + "\nprefillPortalVariablesFromTicket.showPrefillProgress = showPrefillProgress;" +
      "\nreturn prefillPortalVariablesFromTicket;"
  )(
    chromeStub,
    (text, isErr, durationMs, options) => {
      page.toasts.push({ text, isErr: Boolean(isErr) });
      page.toastStates.push(options || {});
    },
    { lastPrefillVariables: [], lastPrefillSource: null, lastPrefillResult: null },
    /* The real 15-minute backstop would hold the test process open. */
    500,
    () => null,
    { href: ORIGIN + "/sp?id=sc_cat_item&sys_id=" + ITEM_ID, origin: ORIGIN, hostname: "example.service-now.com" },
    { querySelector: () => null },
    (options) => {
      page.confirmations.push(options);
      return true;
    },
    () => {},
    () => { page.reopened += 1; },
    page.paletteOpen ? {} : null
  );
}

const lastToast = (page) => page.toasts[page.toasts.length - 1];
const filledNames = (page) => (page.filled ? page.filled.variables.map((v) => v.name).sort() : null);
/* Let a confirmation's click handler run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("a read your session can make fills as before, with no impersonation check", async () => {
  const page = makePage({ session: "you", impersonating: false });
  await loadCommand(page)("SCASE0001");
  assert.deepStrictEqual(filledNames(page), ["country", "supplier_name"]);
  assert.strictEqual(lastToast(page).text,
    "Done. Filled 2 of 2 variables.\nYou can close this (Esc) and review the form.");
  assert.ok(!page.sent.includes("SN_IMPERSONATE_STATE"));
  assert.strictEqual(page.confirmations.length, 0);
});

test("a refused read while impersonating offers the switch and does nothing else", async () => {
  const page = makePage();
  await loadCommand(page)("SCASE0001");
  assert.strictEqual(page.confirmations.length, 1);
  const offer = page.confirmations[0];
  assert.strictEqual(offer.title, "abel.tuter can't read SCASE0001's variables. To prefill, GlideLens will:");
  assert.deepStrictEqual(offer.steps, [
    "switch your session back to your own account",
    "read SCASE0001",
    "impersonate abel.tuter again",
    "fill this form as abel.tuter",
  ]);
  assert.match(offer.note, /audit log/);
  assert.strictEqual(offer.confirmLabel, "Switch, read and fill");
  assert.ok(!page.sent.includes("PREFILL_SWAP_BEGIN"), "nothing switches before the click");
  assert.strictEqual(page.filled, null);
});

test("a hidden request item is offered too, without claiming it exists", async () => {
  const page = makePage();
  await loadCommand(page)("RITM0001");
  assert.strictEqual(page.confirmations.length, 1);
  assert.strictEqual(page.confirmations[0].title,
    "abel.tuter can't see RITM0001, which may be hidden from them or may not exist. " +
      "To prefill, GlideLens will:");
});

test("an account that reads the answers but not the questions is offered the switch", async () => {
  const page = makePage({ hideDefinitions: true });
  await loadCommand(page)("SCASE0001");
  assert.strictEqual(page.confirmations.length, 1, "not \"No copyable variables found\"");
  assert.strictEqual(page.confirmations[0].title,
    "abel.tuter can't read SCASE0001's variables. To prefill, GlideLens will:");
  page.confirmations[0].onConfirm();
  await settle();
  assert.deepStrictEqual(filledNames(page), ["country", "supplier_name"]);
  assert.strictEqual(page.filled.as, "target");
});

test("not impersonating, answers with no readable questions say this account can't read them", async () => {
  const page = makePage({ hideDefinitions: true, impersonating: false });
  await loadCommand(page)("SCASE0001");
  assert.deepStrictEqual(lastToast(page), {
    text: "This account can't read SCASE0001's variables.",
    isErr: true,
  });
});

test("a deleted question among readable ones is skipped, not taken for a refusal", async () => {
  const page = makePage({ session: "you", impersonating: false, deletedQuestion: true });
  await loadCommand(page)("SCASE0001");
  assert.deepStrictEqual(filledNames(page), ["country", "supplier_name"]);
  assert.strictEqual(lastToast(page).text,
    "Done. Filled 2 of 2 variables.\nYou can close this (Esc) and review the form.");
});

test("while impersonating, a partly refused read offers the switch instead of filling a part", async () => {
  /* The answers are readable, the multi-row sets are not. */
  const page = makePage({ readsAnswers: true });
  await loadCommand(page)("SCASE0001");
  assert.strictEqual(page.confirmations.length, 1);
  assert.strictEqual(page.confirmations[0].title,
    "abel.tuter can't read all of SCASE0001's variables. To prefill, GlideLens will:");
  assert.strictEqual(page.filled, null, "nothing is filled before the click");
  page.confirmations[0].onConfirm();
  await settle();
  assert.deepStrictEqual(filledNames(page), ["country", "supplier_name"]);
  assert.strictEqual(page.filled.as, "target");
  assert.match(lastToast(page).text, /^Done\. Filled 2 of 2 variables as abel\.tuter\.\n/);
});

test("a partly refused read with no way home fills what it read, and says the form may have gaps", async () => {
  const page = makePage({ readsAnswers: true, hasStopTarget: false });
  await loadCommand(page)("SCASE0001");
  assert.strictEqual(page.confirmations.length, 0);
  assert.deepStrictEqual(filledNames(page), ["country", "supplier_name"]);
  assert.match(lastToast(page).text, /check the form for gaps/);
});

test("an itil requester's request item fills straight away: question_answer's refusal is not a gap there", async () => {
  const page = makePage({ readsMultiRow: true });
  await loadCommand(page)("RITM0002");
  assert.strictEqual(page.confirmations.length, 0);
  assert.ok(!page.sent.includes("SN_IMPERSONATE_STATE"), "nothing was refused that matters");
  assert.deepStrictEqual(filledNames(page), ["justification", "laptop_model"]);
  assert.strictEqual(page.filled.as, "target");
  assert.strictEqual(lastToast(page).text,
    "Done. Filled 2 of 2 variables.\nYou can close this (Esc) and review the form.");
});

test("a request item whose multi-row sets are refused still counts as partly refused", async () => {
  const page = makePage();
  await loadCommand(page)("RITM0002");
  assert.strictEqual(page.confirmations.length, 1);
  assert.match(page.confirmations[0].title, /^abel\.tuter can't read all of RITM0002's variables\./);
});

test("a variable read that timed out is reported as that, and never offered the switch", async () => {
  const page = makePage({
    fault: (table) => table === "question_answer" || table === "sc_multi_row_question_answer"
      ? { ok: false, error: "No frame answered read " + table + " (timed out)" }
      : null,
  });
  await loadCommand(page)("SCASE0001");
  assert.strictEqual(page.confirmations.length, 0);
  assert.ok(!page.sent.includes("SN_IMPERSONATE_STATE"));
  assert.deepStrictEqual(lastToast(page), {
    text: "Couldn't read SCASE0001's variables: No frame answered read question_answer (timed out). Try again.",
    isErr: true,
  });
});

test("a server error looking the ticket up is reported as that, and never offered the switch", async () => {
  const page = makePage({
    fault: (table) => table === "task" ? { ok: false, status: 500, error: "HTTP 500 reading task" } : null,
  });
  await loadCommand(page)("SCASE0001");
  assert.strictEqual(page.confirmations.length, 0);
  assert.deepStrictEqual(lastToast(page), { text: "HTTP 500 reading task", isErr: true });
});

test("a read that is partly refused fills what it read and says the form may have gaps", async () => {
  const page = makePage({
    session: "you",
    impersonating: false,
    fault: (table) => table === "sc_multi_row_question_answer"
      ? { ok: false, status: 403, error: "HTTP 403 reading " + table }
      : null,
  });
  await loadCommand(page)("SCASE0001");
  assert.deepStrictEqual(filledNames(page), ["country", "supplier_name"]);
  assert.strictEqual(lastToast(page).text,
    "Done. Filled 2 of 2 variables.\n" +
      "Some of the ticket's variables couldn't be read, so check the form for gaps.\n" +
      "You can close this (Esc) and review the form.");
});

test("a second run during the switch is refused, so nothing is read or filled as you", async () => {
  const page = makePage();
  const command = loadCommand(page);
  await command("SCASE0001");
  let second = null;
  page.duringReadAsYou = () => { second = command("SCASE0001"); };
  page.confirmations[0].onConfirm();
  await settle();
  await second;

  assert.ok(page.toasts.some((t) =>
    t.text === "Step 2 of 4 · Prefill is already running. Wait for it to finish."));
  assert.strictEqual(page.sent.filter((t) => t === "SN_TABLE_GET:question_answer@you").length, 1);
  assert.strictEqual(page.sent.filter((t) => t === "FILL_PORTAL_VARIABLES").length, 1);
  assert.strictEqual(page.filled.as, "target");
  assert.match(lastToast(page).text, /^Done\. Filled 2 of 2 variables as abel\.tuter\./);
});

test("progress arriving after a run has ended does not replace its last message", async () => {
  const page = makePage({ session: "you", impersonating: false });
  const command = loadCommand(page);
  await command("SCASE0001");
  const shown = page.toasts.length;
  command.showPrefillProgress("Filling portal form… 3 of 9");
  assert.strictEqual(page.toasts.length, shown);
});

test("confirming switches, reads as you, switches back, and only then fills", async () => {
  const page = makePage();
  await loadCommand(page)("SCASE0001");
  page.confirmations[0].onConfirm();
  await settle();

  const order = page.sent.filter((type) =>
    /^(PREFILL_SWAP|FILL_PORTAL|SN_TABLE_GET:question_answer)/.test(type));
  assert.deepStrictEqual(order, [
    "SN_TABLE_GET:question_answer@target",
    "PREFILL_SWAP_BEGIN",
    "SN_TABLE_GET:question_answer@you",
    "PREFILL_SWAP_END",
    "FILL_PORTAL_VARIABLES",
  ]);
  assert.strictEqual(page.beginTarget, TARGET, "the worker is told whom the person agreed to");
  assert.strictEqual(page.filled.as, "target", "the form's scripts run as the impersonated account");
  assert.deepStrictEqual(filledNames(page), ["country", "supplier_name"]);
  assert.deepStrictEqual(lastToast(page), {
    text: "Done. Filled 2 of 2 variables as abel.tuter.\n" +
      "Read SCASE0001 as you; you're impersonating abel.tuter again.\n" +
      "You can close this (Esc) and review the form.",
    isErr: false,
  });
});

test("every message during the switch names its step and spins, and the last one stays", async () => {
  const page = makePage();
  await loadCommand(page)("SCASE0001");
  const from = page.toasts.length;
  page.confirmations[0].onConfirm();
  await settle();

  const during = page.toasts.slice(from, -1);
  const states = page.toastStates.slice(from, -1);
  assert.ok(during.length >= 4);
  during.forEach((toast, index) => {
    assert.match(toast.text, /^Step [1-4] of 4 · /, toast.text);
    assert.strictEqual(states[index].busy, true, "a spinner while " + toast.text);
  });
  const steps = during.map((toast) => Number(toast.text.charAt(5)));
  assert.deepStrictEqual(Array.from(new Set(steps)), [1, 2, 3, 4], "in order, none skipped");
  assert.ok(during.some((t) => t.text === "Step 3 of 4 · Impersonating abel.tuter again…"));
  assert.ok(during.some((t) => t.text === "Step 4 of 4 · Found 2 variables. Filling the form as abel.tuter…"));
  const last = page.toastStates[page.toastStates.length - 1];
  assert.strictEqual(last.done, true, "the result stays until the palette is closed");
  assert.ok(!last.busy && !last.sticky);
});

test("a run that ends in a problem leaves its message up too", async () => {
  const page = makePage({ impersonating: false });
  await loadCommand(page)("SCASE0001");
  assert.deepStrictEqual(page.toastStates[page.toastStates.length - 1], { sticky: true });
});

test("cancelling changes nothing", async () => {
  const page = makePage();
  await loadCommand(page)("SCASE0001");
  page.confirmations[0].onCancel();
  await settle();
  assert.ok(!page.sent.includes("PREFILL_SWAP_BEGIN"));
  assert.strictEqual(page.filled, null);
  assert.strictEqual(lastToast(page).text, "Nothing was switched.");
});

test("a refused first switch reads nothing more and fills nothing", async () => {
  const page = makePage({ beginFails: "ServiceNow did not switch your session back." });
  await loadCommand(page)("SCASE0001");
  page.confirmations[0].onConfirm();
  await settle();
  assert.ok(!page.sent.includes("PREFILL_SWAP_END"));
  assert.strictEqual(page.sent.filter((t) => t.endsWith("@you")).length, 0);
  assert.strictEqual(page.filled, null);
  assert.deepStrictEqual(lastToast(page), { text: "ServiceNow did not switch your session back.", isErr: true });
});

test("a failed switch back fills nothing and says so, even with the palette closed", async () => {
  const message = "ServiceNow did not impersonate abel.tuter again, so you are now yourself. Nothing was filled.";
  const page = makePage({ endFails: message, paletteOpen: false });
  await loadCommand(page)("SCASE0001");
  page.confirmations[0].onConfirm();
  await settle();
  assert.strictEqual(page.filled, null);
  assert.deepStrictEqual(lastToast(page), { text: message, isErr: true });
  assert.strictEqual(page.reopened, 1, "the palette is reopened so the message is seen");
});

test("a read that fails even as you still switches back, and fills nothing", async () => {
  const page = makePage();
  await loadCommand(page)("SCASE0002");
  page.confirmations[0].onConfirm();
  await settle();
  assert.ok(page.sent.includes("PREFILL_SWAP_END"));
  assert.strictEqual(page.filled, null);
  assert.strictEqual(lastToast(page).text,
    "No copyable variables found.\nRead SCASE0002 as you; you're impersonating abel.tuter again.");
});

test("not impersonating, a refused read says this account can't read it", async () => {
  const page = makePage({ impersonating: false });
  await loadCommand(page)("SCASE0001");
  assert.strictEqual(page.confirmations.length, 0);
  assert.deepStrictEqual(lastToast(page), {
    text: "This account can't read SCASE0001's variables.",
    isErr: true,
  });
});

test("not impersonating, a hidden ticket no longer reads as missing", async () => {
  const page = makePage({ impersonating: false });
  await loadCommand(page)("RITM0001");
  assert.deepStrictEqual(lastToast(page), {
    text: "No task found for RITM0001 that this account can read.",
    isErr: true,
  });
});

test("without a way home it explains instead of offering", async () => {
  const page = makePage({ hasStopTarget: false });
  await loadCommand(page)("SCASE0001");
  assert.strictEqual(page.confirmations.length, 0);
  assert.match(lastToast(page).text,
    /^abel\.tuter can't read SCASE0001's variables, and GlideLens doesn't know which account to return you to\./);
});

test("a mistake in what was typed is reported as that, with no impersonation check", async () => {
  const page = makePage();
  await loadCommand(page)(ITEM_ID);
  assert.match(lastToast(page).text, /^That sys_id is the catalog item\/record producer definition \(Laptop\)/);
  assert.ok(!page.sent.includes("SN_IMPERSONATE_STATE"));
  assert.strictEqual(page.confirmations.length, 0);
});

test("a read that was allowed and found nothing is not treated as a refusal", async () => {
  const page = makePage({ session: "you" });
  await loadCommand(page)("SCASE0002");
  assert.deepStrictEqual(lastToast(page), { text: "No copyable variables found.", isErr: true });
  assert.ok(!page.sent.includes("SN_IMPERSONATE_STATE"));
});

/* ------------------------------------------------------------------ *
 * The palette around it
 * ------------------------------------------------------------------ */

/*
 * Just enough DOM for the palette's input row, its confirmation and its toast:
 * a tree with ids, focus, clicks and removal.
 */
function fakePalette() {
  let active = null;
  let root = null;
  const make = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parent: null,
      style: {},
      dataset: {},
      clicks: [],
      className: "",
      textContent: "",
      value: "",
      appendChild(child) {
        child.parent = el;
        el.children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        child.parent = el;
        const at = el.children.indexOf(ref);
        el.children.splice(at < 0 ? el.children.length : at, 0, child);
        return child;
      },
      remove() {
        if (!el.parent) return;
        el.parent.children = el.parent.children.filter((c) => c !== el);
        el.parent = null;
      },
      setAttribute() {},
      addEventListener(type, fn) {
        if (type === "click") el.clicks.push(fn);
      },
      click() {
        el.clicks.forEach((fn) => fn({}));
      },
      focus() {
        active = el;
      },
      get isConnected() {
        let node = el;
        while (node.parent) node = node.parent;
        return node === root;
      },
    };
    return el;
  };
  const find = (node, test) => {
    if (test(node)) return node;
    for (const child of node.children) {
      const hit = find(child, test);
      if (hit) return hit;
    }
    return null;
  };
  root = make("#shadow-root");
  root.getElementById = (id) => find(root, (node) => node.id === id);
  const box = root.appendChild(make("div"));
  box.id = "box";
  const search = box.appendChild(make("input"));
  search.id = "search";
  const list = box.appendChild(make("div"));
  list.id = "results";
  const toast = box.appendChild(make("div"));
  toast.id = "toast";
  return {
    root, search, list, toast, make,
    active: () => active,
    button: (label) => find(root, (node) => node.tagName === "BUTTON" && node.textContent === label),
  };
}

function loadPaletteUi(dom, closePalette) {
  const block =
    between(contentSource, "function showToast(", "async function copyText(") +
    between(contentSource, "function showArgInput(", "function clampPalettePosition(");
  return new Function(
    "paletteShadow", "paletteList", "paletteInput", "paletteToast", "activeInputCmd",
    "closePalette", "document",
    block + "\nreturn { showToast, showArgInput, showPaletteConfirmation };"
  )(dom.root, dom.list, dom.search, dom.toast, null, closePalette, { createElement: dom.make });
}

const escapeKey = () => ({ key: "Escape", preventDefault() {}, stopPropagation() {} });

for (const label of ["Switch, read and fill", "Cancel"]) {
  test("after " + label + " is clicked, focus is back in the input, where Esc reaches the palette", () => {
    const dom = fakePalette();
    const ui = loadPaletteUi(dom, () => {});
    ui.showArgInput({ inputLabel: "Source ticket, sys_id or link" });
    const input = dom.root.getElementById("arg-input");
    assert.strictEqual(dom.active(), input);

    const ran = [];
    ui.showPaletteConfirmation({
      title: "abel.tuter can't read SCASE0001's variables. To prefill, GlideLens will:",
      steps: ["a", "b", "c", "d"],
      note: "audit log",
      confirmLabel: "Switch, read and fill",
      onConfirm: () => ran.push("confirm"),
      onCancel: () => ran.push("cancel"),
    });
    assert.strictEqual(dom.active(), input, "showing the confirmation takes no focus");

    const button = dom.button(label);
    button.focus(); // a mouse click focuses the button it lands on
    button.click();
    assert.deepStrictEqual(ran, [label === "Cancel" ? "cancel" : "confirm"]);
    assert.strictEqual(dom.root.getElementById("palette-confirm"), null);
    assert.strictEqual(dom.active(), input, "focus is not left on a button that is gone");
  });
}

test("Esc in the input closes the palette once a run has ended, and goes back a step before that", () => {
  const dom = fakePalette();
  let closed = 0;
  const ui = loadPaletteUi(dom, () => { closed += 1; });

  ui.showArgInput({ inputLabel: "Source ticket, sys_id or link" });
  ui.showToast("Step 2 of 4 · Reading SCASE0001 as you…", false, 0, { busy: true });
  dom.root.getElementById("arg-input").onkeydown(escapeKey());
  assert.strictEqual(closed, 0, "mid-run, Esc goes back to the command list as before");
  assert.strictEqual(dom.root.getElementById("arg-input"), null);
  assert.strictEqual(dom.active(), dom.search);

  for (const options of [{ done: true }, { sticky: true }]) {
    closed = 0;
    ui.showArgInput({ inputLabel: "Source ticket, sys_id or link" });
    ui.showToast("Done. Filled 2 of 2 variables.", Boolean(options.sticky), 0, options);
    dom.root.getElementById("arg-input").onkeydown(escapeKey());
    assert.strictEqual(closed, 1, "a run's last message: " + JSON.stringify(options));
  }
});

test("the confirmation runs only from a button click, and never takes focus", () => {
  const ui = stripComments(between(contentSource, "function showPaletteConfirmation(", "function clearPaletteConfirmation("));
  assert.ok(!ui.includes(".focus("), "focus stays in the input, so Enter there cannot confirm");
  assert.ok(!/keydown|keyup|keypress/.test(ui), "no key handler can confirm it");
  assert.strictEqual((ui.match(/addEventListener\("click"/g) || []).length, 2, "one click handler per button");
});

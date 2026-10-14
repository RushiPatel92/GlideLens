/*
 * Variable Prefill from another instance.
 *
 *   node --test tests/prefill_cross_instance.test.js
 *
 * DEV-ONLY, like its siblings. The form is on one instance and the ticket on
 * another. The worker finds a tab the person has open on the other instance
 * and asks GlideLens's own content script there to make the read Prefill
 * already makes at home, on that tab's session. The form's tab then checks
 * every sys_id-valued answer against its own instance before filling.
 *
 * The real worker routes, the real shared reader, the real content-script
 * command and export, and the real palette row run here against simulated
 * tabs, instances and a minimal DOM.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

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

const HERE = "https://exampledev.service-now.com";
const SANDBOX = "https://examplesbx.service-now.com";
const TEST_INSTANCE = "https://exampletest.service-now.com";
const id = (n) => Number(n).toString(16).padStart(32, "0");
const ITEM_ID = id(3);
const HEX32 = /[0-9a-f]{32}/i;
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 0));

const sysIdFromText = new Function(
  between(contentSource, "function sysIdFromText(", "async function getCurrentRecordSysId(") +
    "\nreturn sysIdFromText;"
)();

/* ------------------------------------------------------------------ *
 * The content script's Prefill block
 * ------------------------------------------------------------------ */

const PREFILL_EXPORTS = [
  "prefillPortalVariablesFromTicket",
  "parsePrefillSource",
  "prefillLinkIn",
  "prefillInstanceLabel",
  "prepareCrossInstanceVariables",
  "exportPrefillSource",
  "serialisePrefillError",
  "resolveVariableSource",
  "addMultiRowVariablesFromAnswerRows",
  "snGetManyListeners",
];

/*
 * opts.answer(msg, page) answers every runtime message the block sends;
 * anything it leaves undefined falls to the defaults below. page.sent keeps
 * every message, in order.
 */
function loadPrefill(options) {
  const opts = options || {};
  const page = { sent: [], toasts: [], toastStates: [], filled: null, confirmations: [] };
  const answer = async (msg) => {
    const custom = opts.answer ? await opts.answer(msg, page) : undefined;
    if (custom !== undefined) return custom;
    if (msg.type === "SN_TABLE_GET") return { ok: true, result: [] };
    if (msg.type === "FILL_PORTAL_VARIABLES") {
      page.filled = msg.variables;
      return { ok: true, foundForm: true, filled: msg.variables.length, alreadySet: 0, skipped: 0, unmatched: 0 };
    }
    if (msg.type === "SN_IMPERSONATE_STATE") {
      return { ok: true, isImpersonating: false, currentUserName: "", hasStopTarget: false };
    }
    return undefined;
  };
  const chromeStub = {
    runtime: {
      id: "glidelens",
      sendMessage: (msg) => {
        page.sent.push(msg);
        return answer(msg);
      },
    },
  };
  const SNH = { lastPrefillVariables: [], lastPrefillSource: null, lastPrefillResult: null };
  const block = between(contentSource, "async function snGetMany(", "async function copyPortalVariableDebugInfo");
  const api = new Function(
    "chrome", "showToast", "SNH", "PREFILL_REPLY_CEILING_MS", "sysIdFromText", "location", "document",
    "showPaletteConfirmation", "clearPaletteConfirmation", "openPalette", "paletteToast",
    block + "\nreturn { " + PREFILL_EXPORTS.join(", ") + ", running: () => prefillRunning };"
  )(
    chromeStub,
    (text, isErr, durationMs, toastOptions) => {
      page.toasts.push({ text, isErr: Boolean(isErr) });
      page.toastStates.push(toastOptions || {});
    },
    SNH,
    500,
    sysIdFromText,
    { href: HERE + "/sp?id=sc_cat_item&sys_id=" + ITEM_ID, origin: opts.origin || HERE },
    { querySelector: () => null },
    (confirmation) => {
      page.confirmations.push(confirmation);
      return true;
    },
    () => {},
    () => {},
    {}
  );
  return Object.assign(api, { page, SNH });
}

const lastToast = (page) => page.toasts[page.toasts.length - 1];
const sentTypes = (page) => page.sent.map((msg) => msg.type);
const tableReads = (page, table) =>
  page.sent.filter((msg) => msg.type === "SN_TABLE_GET" && (!table || msg.table === table));

/* A picker as the palette's Read from gives the command. */
function fakePicker(chosen, others) {
  const shown = [];
  return {
    shown,
    chosenOrigin: () => chosen || "",
    show: (origin) => shown.push(origin),
    othersOpen: () => Boolean(others),
  };
}

/* ------------------------------------------------------------------ *
 * Naming the source instance
 * ------------------------------------------------------------------ */

const RITM_ID = id(0xabc);
const RITM_LINK = SANDBOX + "/sc_req_item.do?sys_id=" + RITM_ID;

test("a link to another instance names that instance, with the link's sys_id as the ticket", () => {
  const { parsePrefillSource } = loadPrefill();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(parsePrefillSource(RITM_LINK, ""))), {
    origin: SANDBOX,
    remote: true,
    input: RITM_ID,
    label: "the linked ticket",
  });
});

test("a link to this instance runs exactly as before, with the text as typed", () => {
  const { parsePrefillSource } = loadPrefill();
  const link = HERE + "/sc_req_item.do?sys_id=" + RITM_ID;
  const parsed = parsePrefillSource(link, SANDBOX);
  assert.strictEqual(parsed.remote, false, "a link wins over the drop-down, both ways");
  assert.strictEqual(parsed.origin, HERE);
  assert.strictEqual(parsed.input, link);
});

test("Workspace, classic, nav_to and portal links all give up their sys_id", () => {
  const { parsePrefillSource } = loadPrefill();
  const links = [
    SANDBOX + "/now/sow/record/sc_req_item/" + RITM_ID,
    SANDBOX + "/sc_req_item.do?sys_id=" + RITM_ID + "&sysparm_view=",
    SANDBOX + "/nav_to.do?uri=" + encodeURIComponent("sc_req_item.do?sys_id=" + RITM_ID),
    SANDBOX + "/now/nav/ui/classic/params/target/" + encodeURIComponent("sc_req_item.do?sys_id=" + RITM_ID),
    SANDBOX + "/sp?id=ticket&table=sc_req_item&sys_id=" + RITM_ID,
  ];
  links.forEach((link) => {
    const parsed = parsePrefillSource(link, "");
    assert.strictEqual(parsed.origin, SANDBOX, link);
    assert.strictEqual(parsed.input, RITM_ID, link);
  });
});

test("only *.service-now.com links over https without credentials may be read", () => {
  const { parsePrefillSource } = loadPrefill();
  const refused = [
    "https://servicedesk.example.com/sc_req_item.do?sys_id=" + RITM_ID,
    "https://user:secret@examplesbx.service-now.com/sc_req_item.do?sys_id=" + RITM_ID,
    "http://examplesbx.service-now.com/sc_req_item.do?sys_id=" + RITM_ID,
    "https://examplesbx.service-now.com.evil.example/sc_req_item.do?sys_id=" + RITM_ID,
  ];
  refused.forEach((link) => {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(parsePrefillSource(link, ""))),
      { origin: "", error: "GlideLens can only read from *.service-now.com instances." },
      link
    );
  });
});

test("a link that names no record is refused rather than guessed from its text", () => {
  const { parsePrefillSource } = loadPrefill();
  const parsed = parsePrefillSource(SANDBOX + "/sc_req_item_list.do", "");
  assert.strictEqual(parsed.origin, SANDBOX);
  assert.match(parsed.error, /^That link doesn't open a ticket\./);
});

test("a typed number is read where Read from says, and here by default", () => {
  const { parsePrefillSource } = loadPrefill();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(parsePrefillSource("RITM0010001", ""))),
    { origin: HERE, remote: false, input: "RITM0010001" });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(parsePrefillSource("RITM0010001", HERE))),
    { origin: HERE, remote: false, input: "RITM0010001" });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(parsePrefillSource("RITM0010001", SANDBOX))),
    { origin: SANDBOX, remote: true, input: "RITM0010001", label: "RITM0010001" });
  assert.strictEqual(parsePrefillSource(RITM_ID, SANDBOX).label, "that record",
    "a typed sys_id is never repeated back in a message");
});

test("a pasted link wins over the drop-down, and the drop-down is moved to match", async () => {
  const prefill = loadPrefill({
    answer: (msg) => (msg.type === "PREFILL_REMOTE_READ" ? { ok: false, code: "not-open" } : undefined),
  });
  const picker = fakePicker(TEST_INSTANCE, true);
  await prefill.prefillPortalVariablesFromTicket(RITM_LINK, picker);
  const read = prefill.page.sent.find((msg) => msg.type === "PREFILL_REMOTE_READ");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(read)), {
    type: "PREFILL_REMOTE_READ",
    origin: SANDBOX,
    input: RITM_ID,
  });
  assert.deepStrictEqual(picker.shown, [SANDBOX]);
});

test("a ticket not found here is never looked for elsewhere, only pointed at Read from", async () => {
  const prefill = loadPrefill();
  await prefill.prefillPortalVariablesFromTicket("RITM0099999", fakePicker("", true));
  assert.ok(!sentTypes(prefill.page).includes("PREFILL_REMOTE_READ"));
  assert.deepStrictEqual(lastToast(prefill.page), {
    text: "No task found for RITM0099999 that this account can read.\n" +
      "Is it on another instance? Choose it under Read from.",
    isErr: true,
  });
});

test("with no other instance open, a ticket not found here says only that", async () => {
  const prefill = loadPrefill();
  await prefill.prefillPortalVariablesFromTicket("RITM0099999", fakePicker("", false));
  assert.strictEqual(lastToast(prefill.page).text, "No task found for RITM0099999 that this account can read.");
});

/* ------------------------------------------------------------------ *
 * Ambiguous ticket numbers (the shared reader, so both paths)
 * ------------------------------------------------------------------ */

test("two records with one number are refused instead of taking the first", async () => {
  const prefill = loadPrefill({
    answer: (msg) => msg.type === "SN_TABLE_GET" && msg.table === "task"
      ? { ok: true, result: [
        { sys_id: id(1), number: "RITM0010001", sys_class_name: "sc_req_item" },
        { sys_id: id(2), number: "RITM0010001", sys_class_name: "sc_req_item" },
      ] }
      : undefined,
  });
  await assert.rejects(prefill.resolveVariableSource("RITM0010001"), (error) => {
    assert.strictEqual(error.code, "ambiguous");
    assert.strictEqual(error.message,
      "Two records have number RITM0010001 on exampledev. Paste the ticket's link instead.");
    return true;
  });
});

test("a row whose number is not the one typed is never used", async () => {
  /* The platform ignores a query it doesn't understand and answers with any
   * rows, so the answer alone proves nothing. */
  const prefill = loadPrefill({
    answer: (msg) => msg.type === "SN_TABLE_GET" && msg.table === "task"
      ? { ok: true, result: [{ sys_id: id(1), number: "RITM0000001", sys_class_name: "sc_req_item" }] }
      : undefined,
  });
  await assert.rejects(prefill.resolveVariableSource("RITM0010001"), (error) => {
    assert.strictEqual(error.access, "hidden");
    return true;
  });
  assert.strictEqual(tableReads(prefill.page, "sc_item_option_mtom").length, 0);
});

test("a number matches whatever its capitalisation", async () => {
  const prefill = loadPrefill({
    answer: (msg) => msg.type === "SN_TABLE_GET" && msg.table === "task"
      ? { ok: true, result: [{ sys_id: id(1), number: "RITM0010001", sys_class_name: "sc_req_item" }] }
      : undefined,
  });
  const source = await prefill.resolveVariableSource("ritm0010001");
  assert.strictEqual(source.requestItemId, id(1));
});

/* ------------------------------------------------------------------ *
 * The worker
 * ------------------------------------------------------------------ */

const SENDER = { tab: { id: 1, url: HERE + "/sp?id=sc_cat_item", incognito: false }, frameId: 0, origin: HERE };

function sourceTab(overrides) {
  return Object.assign({ id: 20, url: SANDBOX + "/now/nav/ui/home", active: false, incognito: false }, overrides);
}

function exportReply(variables, extra) {
  return Object.assign({
    ok: true,
    variables,
    skipped: 0,
    readRefused: false,
    readFailure: null,
    source: { mode: "catalog", number: "RITM0010001", table: "sc_req_item" },
  }, extra);
}

/*
 * opts.tabs: what tabs.query can see. opts.answer(tabId, message, worker)
 * answers the export message sent to a source tab; worker.heartbeat(tabId,
 * requestId, text) sends that tab's progress.
 */
function loadWorker(options) {
  const opts = options || {};
  const block = between(backgroundSource, "const PREFILL_REMOTE_IDLE_MS", "// Content scripts can't call chrome.tabs.create")
    .replace("const PREFILL_REMOTE_IDLE_MS = 45000;", "const PREFILL_REMOTE_IDLE_MS = " + (opts.idleMs || 200) + ";")
    .replace("const PREFILL_REMOTE_CEILING_MS = 180000;",
      "const PREFILL_REMOTE_CEILING_MS = " + (opts.ceilingMs || 5000) + ";")
    .replace("const PREFILL_REMOTE_TICK_MS = 1000;", "const PREFILL_REMOTE_TICK_MS = 5;");
  const origins = between(backgroundSource, "const SN_TAB_HOST", "/* Returns a URL rebuilt from its parsed form");
  const state = {
    tabs: opts.tabs || [],
    queries: [],
    sent: [],
    relayed: [],
    impersonationReads: [],
    swaps: opts.swaps || new Map(),
    remote: new Map(),
  };
  const matches = (pattern, url) =>
    pattern === "https://*.service-now.com/*" ? /^https:\/\/[^/]+\.service-now\.com\//.test(url)
      : url.startsWith(pattern.slice(0, -1));
  let api;
  const worker = {
    heartbeat: (tabId, requestId, message) =>
      api.notePrefillRemoteProgress({ requestId, message }, { tab: { id: tabId }, frameId: 0 }),
  };
  const chrome = {
    tabs: {
      query: async (query) => {
        state.queries.push(query);
        return state.tabs.filter((tab) => matches(query.url, tab.url));
      },
      sendMessage: (tabId, message, sendOptions) => {
        state.sent.push({ tabId, message, options: sendOptions });
        return opts.answer ? opts.answer(tabId, message, worker) : Promise.resolve(undefined);
      },
    },
  };
  api = new Function(
    "chrome", "discoverContentFrames", "probeTokenFrame", "readImpersonationState",
    "prefillSwapByTab", "prefillRemoteByTab", "sendToTab",
    origins + block +
      "\nreturn { readPrefillFromOtherInstance, prefillSourceInstances, notePrefillRemoteProgress, " +
      "checkedPrefillExport, prefillRemoteByRequest };"
  )(
    chrome,
    async () => [0],
    async (tabId, frameId) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      return { frameId, hasToken: !tab || tab.hasToken !== false };
    },
    async (tabId, origin) => {
      state.impersonationReads.push({ tabId, origin });
      return { isImpersonating: Boolean(opts.sourceImpersonating) };
    },
    state.swaps,
    state.remote,
    (tabId, message, sendOptions) => state.relayed.push({ tabId, message, options: sendOptions })
  );
  return Object.assign(api, { state, worker });
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const sentTabs = (worker) => worker.state.sent.map((entry) => entry.tabId);

test("the Read from list is every other instance open in this browsing context, as origins only", async () => {
  const worker = loadWorker({
    tabs: [
      sourceTab({ id: 2, url: HERE + "/incident.do" }),
      sourceTab({ id: 3, url: TEST_INSTANCE + "/sp" }),
      sourceTab({ id: 4, url: SANDBOX + "/now/sow/home" }),
      sourceTab({ id: 5, url: SANDBOX + "/sp?id=index" }),
      sourceTab({ id: 6, url: "https://exampleprivate.service-now.com/", incognito: true }),
    ],
  });
  const answer = plain(await worker.prefillSourceInstances(SENDER));
  assert.deepStrictEqual(answer, {
    ok: true,
    origins: [
      { origin: SANDBOX, label: "examplesbx" },
      { origin: TEST_INSTANCE, label: "exampletest" },
    ],
  });
});

test("an incognito tab is never offered to a normal window, nor a normal one to incognito", async () => {
  const tabs = [sourceTab({ incognito: true })];
  const worker = loadWorker({ tabs, answer: async () => exportReply([]) });
  assert.deepStrictEqual(plain(await worker.prefillSourceInstances(SENDER)).origins, []);
  const read = await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM0010001" }, SENDER);
  assert.strictEqual(read.code, "not-open");
  assert.deepStrictEqual(worker.state.sent, []);

  const incognitoSender = Object.assign({}, SENDER, { tab: Object.assign({}, SENDER.tab, { incognito: true }) });
  const allowed = await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM0010001" }, incognitoSender);
  assert.strictEqual(allowed.ok, true);
});

test("only a ServiceNow origin other than the sender's, from the top frame, with a bounded ticket", async () => {
  const worker = loadWorker({ tabs: [sourceTab()], answer: async () => exportReply([]) });
  const refusals = [
    [{ origin: "https://servicedesk.example.com", input: "RITM0010001" }, SENDER],
    [{ origin: HERE, input: "RITM0010001" }, SENDER],
    [{ origin: SANDBOX + "/", input: "RITM0010001" }, SENDER],
    [{ origin: "http://examplesbx.service-now.com", input: "RITM0010001" }, SENDER],
    [{ origin: SANDBOX, input: "RITM0010001" }, Object.assign({}, SENDER, { frameId: 3 })],
    [{ origin: SANDBOX, input: "" }, SENDER],
    [{ origin: SANDBOX, input: 42 }, SENDER],
    [{ origin: SANDBOX, input: "x".repeat(2001) }, SENDER],
  ];
  for (const [msg, sender] of refusals) {
    assert.strictEqual((await worker.readPrefillFromOtherInstance(msg, sender)).code, "invalid", JSON.stringify(msg));
  }
  assert.deepStrictEqual(worker.state.sent, [], "no tab is messaged for a refused request");
});

test("the read goes to the source tab's top frame only, with the ticket and nothing else", async () => {
  const worker = loadWorker({ tabs: [sourceTab()], answer: async () => exportReply([]) });
  await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM0010001" }, SENDER);
  assert.strictEqual(worker.state.sent.length, 1);
  const sent = worker.state.sent[0];
  assert.deepStrictEqual(sent.options, { frameId: 0 });
  assert.deepStrictEqual(Object.keys(sent.message).sort(), ["input", "requestId", "type"]);
  assert.strictEqual(sent.message.type, "PREFILL_EXPORT_SOURCE");
  assert.strictEqual(sent.message.input, "RITM0010001");
});

test("no tab on the instance is not-open; only sleeping tabs are asleep; neither is messaged", async () => {
  const none = loadWorker({ tabs: [sourceTab({ url: TEST_INSTANCE + "/sp" })] });
  assert.strictEqual((await none.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)).code, "not-open");
  const asleep = loadWorker({ tabs: [sourceTab({ discarded: true })] });
  assert.strictEqual((await asleep.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)).code, "asleep");
  assert.deepStrictEqual(none.state.sent.concat(asleep.state.sent), []);
});

test("a tab with no token frame, such as the instance's favicon, is skipped", async () => {
  const worker = loadWorker({
    tabs: [
      sourceTab({ id: 21, url: SANDBOX + "/favicon.ico", active: true, hasToken: false }),
      sourceTab({ id: 22 }),
    ],
    answer: async () => exportReply([]),
  });
  const read = await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER);
  assert.strictEqual(read.ok, true);
  assert.deepStrictEqual(sentTabs(worker), [22]);

  const only = loadWorker({ tabs: [sourceTab({ hasToken: false })] });
  assert.strictEqual((await only.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)).code, "not-open");
  assert.deepStrictEqual(only.state.sent, []);
});

test("a tab active in any window is tried first, then the most recently used", async () => {
  const worker = loadWorker({
    tabs: [
      sourceTab({ id: 31, lastAccessed: 100 }),
      sourceTab({ id: 32, lastAccessed: 300 }),
      sourceTab({ id: 33, active: true, lastAccessed: 50 }),
      sourceTab({ id: 34, lastAccessed: 200 }),
    ],
    answer: async () => undefined,
  });
  await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER);
  assert.deepStrictEqual(sentTabs(worker), [33, 32, 34], "and at most three are tried");
});

test("a reply of undefined, before any heartbeat, means nothing there was listening", async () => {
  const worker = loadWorker({ tabs: [sourceTab()], answer: async () => undefined });
  const read = await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER);
  assert.strictEqual(read.code, "no-receiver");
});

test("a send that fails before the first heartbeat tries the next tab", async () => {
  const worker = loadWorker({
    tabs: [sourceTab({ id: 41, active: true }), sourceTab({ id: 42 })],
    answer: (tabId) => (tabId === 41
      ? Promise.reject(new Error("Could not establish connection. Receiving end does not exist."))
      : Promise.resolve(exportReply([]))),
  });
  const read = await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER);
  assert.strictEqual(read.ok, true);
  assert.deepStrictEqual(sentTabs(worker), [41, 42]);
});

test("a send that fails after a heartbeat means the source changed, and no other tab is tried", async () => {
  const worker = loadWorker({
    tabs: [sourceTab({ id: 41, active: true }), sourceTab({ id: 42 })],
    answer: (tabId, message, w) => {
      w.heartbeat(tabId, message.requestId);
      return Promise.reject(new Error("The message port closed before a response was received."));
    },
  });
  const read = await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER);
  assert.strictEqual(read.code, "source-changed");
  assert.deepStrictEqual(sentTabs(worker), [41]);
});

test("the source's progress reaches the form's top frame, and nobody else's does", async () => {
  const worker = loadWorker({
    tabs: [sourceTab({ id: 51 })],
    answer: async (tabId, message, w) => {
      w.heartbeat(tabId, message.requestId);
      w.heartbeat(tabId, message.requestId, "Reading catalog variables…");
      worker.notePrefillRemoteProgress(
        { requestId: message.requestId, message: "from the wrong tab" },
        { tab: { id: 99 }, frameId: 0 }
      );
      worker.notePrefillRemoteProgress(
        { requestId: message.requestId, message: "from a sub-frame" },
        { tab: { id: 51 }, frameId: 4 }
      );
      worker.notePrefillRemoteProgress({ requestId: "made-up", message: "unknown read" }, { tab: { id: 51 }, frameId: 0 });
      return exportReply([]);
    },
  });
  await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER);
  assert.deepStrictEqual(plain(worker.state.relayed), [
    { tabId: 1, message: { type: "PREFILL_PROGRESS", message: "Reading catalog variables…" }, options: { frameId: 0 } },
  ]);
  assert.strictEqual(worker.prefillRemoteByRequest.size, 0, "nothing is kept once the read settles");
});

test("a read that keeps sending heartbeats survives several slow reads in a row", async () => {
  /* Margins wide enough for a loaded machine running every suite at once:
   * 100 ms between beats against a 400 ms bound, 500 ms in all. */
  const worker = loadWorker({
    idleMs: 400,
    tabs: [sourceTab()],
    answer: async (tabId, message, w) => {
      w.heartbeat(tabId, message.requestId);
      for (let read = 0; read < 5; read += 1) {
        await tick(100);
        w.heartbeat(tabId, message.requestId);
      }
      return exportReply([]);
    },
  });
  const read = await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER);
  assert.strictEqual(read.ok, true, "500 ms in all, longer than the bound, never silent for it");
});

test("a read that falls silent times out, and so does one that never stops", async () => {
  const silent = loadWorker({
    idleMs: 60,
    tabs: [sourceTab()],
    answer: (tabId, message, w) => {
      w.heartbeat(tabId, message.requestId);
      return new Promise(() => {});
    },
  });
  assert.strictEqual((await silent.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)).code, "timeout");

  let beating = true;
  const endless = loadWorker({
    idleMs: 300,
    ceilingMs: 600,
    tabs: [sourceTab()],
    answer: (tabId, message, w) => {
      const beat = () => {
        if (!beating) return;
        w.heartbeat(tabId, message.requestId);
        setTimeout(beat, 20);
      };
      beat();
      return new Promise(() => {});
    },
  });
  const started = Date.now();
  assert.strictEqual((await endless.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)).code, "timeout");
  beating = false;
  assert.ok(Date.now() - started >= 550, "the ceiling, not the inactivity bound, ended it");
});

const MRVS_VARIABLE = {
  name: "devices",
  label: "Devices",
  type: "34",
  value: JSON.stringify([{ device: id(70), note: "spare" }]),
  displayValue: JSON.stringify([{ device: id(70), note: "spare" }]),
  variableSet: id(71),
  rowCount: 1,
  columns: ["device", "note"],
  columnMeta: {
    device: { type: "8", reference: "cmdb_ci", lookupTable: "", listTable: "" },
    note: { type: "6", reference: "", lookupTable: "", listTable: "" },
  },
  sourceIndex: 2,
  orderKnown: false,
  order: 0,
};

test("a reply holding a multi-row variable passes the shape check", () => {
  const worker = loadWorker();
  const checked = worker.checkedPrefillExport(exportReply([
    { name: "short_description", label: "Short description", type: "6", value: "Laptop", orderKnown: true, order: 100 },
    MRVS_VARIABLE,
    { name: "doc", type: "33", value: id(80), attachments: [{ sysId: id(80), fileName: "a.pdf", sizeBytes: "12" }] },
  ]));
  assert.ok(checked, "not refused");
  assert.deepStrictEqual(plain(checked.variables[1]), MRVS_VARIABLE);
});

test("a known field of the wrong type refuses the reply; an unknown one is dropped", () => {
  const worker = loadWorker();
  const wrong = [
    { name: 7 },
    { name: "a", order: "100" },
    { name: "a", order: Infinity },
    { name: "a", orderKnown: "true" },
    { name: "a", columns: [1] },
    { name: "a", columnMeta: { device: { type: 8 } } },
    { name: "a", columnMeta: { device: "8" } },
    { name: "a", attachments: [{ sysId: 1 }] },
    "not an object",
  ];
  wrong.forEach((variable) => {
    assert.strictEqual(worker.checkedPrefillExport(exportReply([variable])), null, JSON.stringify(variable));
  });
  assert.strictEqual(worker.checkedPrefillExport(exportReply([], { readRefused: "yes" })), null);
  assert.strictEqual(worker.checkedPrefillExport(exportReply([], { source: { number: 5 } })), null);

  const checked = worker.checkedPrefillExport(exportReply(
    [{ name: "a", value: "b", script: "alert(1)", sourceSysId: null }],
    { extra: true }
  ));
  assert.deepStrictEqual(plain(checked.variables), [{ name: "a", value: "b" }]);
  assert.ok(!("extra" in checked));
});

test("an oversized reply, or one with more than 1,000 variables, is refused", () => {
  const worker = loadWorker();
  assert.strictEqual(worker.checkedPrefillExport(exportReply([{ name: "a", value: "x".repeat(5 * 1024 * 1024) }])), null);
  const many = Array.from({ length: 1001 }, (_, index) => ({ name: "v" + index, value: "x" }));
  assert.strictEqual(worker.checkedPrefillExport(exportReply(many)), null);
});

test("a malformed reply from the source is reported as one", async () => {
  const worker = loadWorker({ tabs: [sourceTab()], answer: async () => exportReply([{ name: 7 }]) });
  assert.deepStrictEqual(plain(await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)),
    { ok: false, code: "malformed" });
});

test("one read per form tab, released once it settles", async () => {
  let release;
  let calls = 0;
  const worker = loadWorker({
    tabs: [sourceTab()],
    answer: (tabId, message, w) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(exportReply([]));
      w.heartbeat(tabId, message.requestId);
      return new Promise((resolve) => { release = () => resolve(exportReply([])); });
    },
  });
  const first = worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER);
  await tick(5);
  assert.strictEqual((await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)).code, "busy");
  release();
  assert.strictEqual((await first).ok, true);
  assert.strictEqual(worker.state.remote.size, 0);
  assert.strictEqual((await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)).ok, true);
});

test("a navigation or a closed tab releases its read", () => {
  const updated = stripComments(between(backgroundSource, "chrome.tabs.onUpdated.addListener(", "\n});"));
  assert.ok(updated.includes("prefillRemoteByTab.delete(tabId)"));
  const removed = stripComments(between(backgroundSource, "chrome.tabs.onRemoved.addListener(", "\n});"));
  assert.ok(removed.includes("prefillRemoteByTab.delete(tabId)"));
});

test("nothing is read from an instance whose session Prefill is switching", async () => {
  const worker = loadWorker({
    tabs: [sourceTab()],
    swaps: new Map([[77, { origin: SANDBOX, switched: true }]]),
    answer: async () => exportReply([]),
  });
  assert.strictEqual((await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)).code, "switching");
  assert.deepStrictEqual(worker.state.sent, []);
});

test("only an access answer reads the source tab's impersonation state", async () => {
  const refused = loadWorker({
    tabs: [sourceTab({ id: 61 })],
    sourceImpersonating: true,
    answer: async () => ({ ok: false, error: { message: "Couldn't read variables.", access: "refused", status: 403 } }),
  });
  assert.deepStrictEqual(plain(await refused.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)),
    { ok: false, code: "refused", status: 403, access: "refused", sourceImpersonating: true });
  assert.deepStrictEqual(refused.state.impersonationReads, [{ tabId: 61, origin: SANDBOX }]);

  const partial = loadWorker({ tabs: [sourceTab()], answer: async () => exportReply([{ name: "a", value: "b" }], { readRefused: true }) });
  assert.strictEqual((await partial.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)).sourceImpersonating, false);
  assert.strictEqual(partial.state.impersonationReads.length, 1);

  const plainRead = loadWorker({ tabs: [sourceTab()], answer: async () => exportReply([]) });
  await plainRead.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER);
  const other = loadWorker({
    tabs: [sourceTab()],
    answer: async () => ({ ok: false, error: { message: "HTTP 500 reading task", status: 500 } }),
  });
  assert.deepStrictEqual(plain(await other.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)),
    { ok: false, code: "read-error", status: 500, message: "HTTP 500 reading task" });
  assert.deepStrictEqual(plainRead.state.impersonationReads.concat(other.state.impersonationReads), []);
});

test("signed out and ambiguous answers keep their codes", async () => {
  for (const code of ["signed-out", "ambiguous"]) {
    const worker = loadWorker({
      tabs: [sourceTab()],
      answer: async () => ({ ok: false, error: { message: "x", code, status: code === "signed-out" ? 401 : undefined } }),
    });
    assert.strictEqual((await worker.readPrefillFromOtherInstance({ origin: SANDBOX, input: "RITM1" }, SENDER)).code, code);
  }
});

test("the read route takes an origin and a ticket, and nothing that could steer it", () => {
  const route = stripComments(between(
    backgroundSource,
    'if (msg && msg.type === "PREFILL_REMOTE_READ"',
    'if (msg && msg.type === "PREFILL_REMOTE_PROGRESS"'
  ));
  const fromMessage = Array.from(new Set(route.match(/msg\.[A-Za-z_]+/g) || [])).sort();
  assert.deepStrictEqual(fromMessage, ["msg.input", "msg.origin", "msg.type"]);
  assert.ok(!/PREFILL_SWAP|stopImpersonation|runImpersonation/.test(
    between(backgroundSource, "const PREFILL_REMOTE_IDLE_MS", "// Content scripts can't call chrome.tabs.create")
  ), "the remote read never switches anyone's session");
});

/* ------------------------------------------------------------------ *
 * The shared reader
 * ------------------------------------------------------------------ */

function loadReader(page) {
  const fetches = [];
  const reader = new Function(
    "location", "g_ck", "fetch",
    between(backgroundSource, "async function tableApiGetInPage(", "async function codeSearchApiGetInPage(") +
      "\nreturn tableApiGetInPage;"
  )(
    { origin: page.origin || SANDBOX },
    page.token,
    async (url, init) => {
      fetches.push({ url, headers: init.headers });
      if (page.fetchThrows) throw new TypeError("Failed to fetch");
      return {
        ok: (page.status || 200) < 400,
        status: page.status || 200,
        json: async () => {
          if (page.html) throw new SyntaxError("Unexpected token <");
          return { result: page.rows || [] };
        },
      };
    }
  );
  return { reader, fetches };
}

const READ = { table: "task", query: "number=RITM1", fields: "sys_id", limit: 2 };

test("a frame on another instance is refused before anything is fetched", async () => {
  const { reader, fetches } = loadReader({ origin: TEST_INSTANCE, token: "tok" });
  assert.deepStrictEqual(await reader(Object.assign({ options: { expectedOrigin: SANDBOX } }, READ)),
    { ok: false, status: 0, wrongOrigin: true, error: "wrong origin" });
  assert.deepStrictEqual(fetches, []);
});

test("with requireToken and no g_ck, no request is made at all", async () => {
  const { reader, fetches } = loadReader({ token: undefined });
  const answer = await reader(Object.assign({ options: { requireToken: true } }, READ));
  assert.strictEqual(answer.noToken, true);
  assert.strictEqual(answer.ok, false);
  assert.deepStrictEqual(fetches, [], "a token-less request would raise the browser's sign-in dialog");
});

test("other callers are untouched: no requireToken, no token, the read still goes", async () => {
  const { reader, fetches } = loadReader({ token: undefined, rows: [{ sys_id: "a" }] });
  assert.deepStrictEqual(await reader(Object.assign({ options: {} }, READ)), { ok: true, result: [{ sys_id: "a" }] });
  assert.strictEqual(fetches.length, 1);
  assert.ok(!("X-UserToken" in fetches[0].headers));
});

test("a 401 to a request sent with a token comes back as a 401", async () => {
  const { reader, fetches } = loadReader({ token: "tok", status: 401 });
  const answer = await reader(Object.assign({ options: { requireToken: true, expectedOrigin: SANDBOX } }, READ));
  assert.deepStrictEqual(answer, { ok: false, status: 401, error: "HTTP 401 reading task" });
  assert.strictEqual(fetches[0].headers["X-UserToken"], "tok");
});

test("a body that is not JSON is a failure, not signed out, and a thrown fetch still throws", async () => {
  const html = loadReader({ token: "tok", html: true });
  assert.deepStrictEqual(await html.reader(Object.assign({ options: {} }, READ)),
    { ok: false, status: 200, nonJson: true, error: "Unreadable answer reading task" });
  const thrown = loadReader({ token: "tok", fetchThrows: true });
  await assert.rejects(thrown.reader(Object.assign({ options: {} }, READ)), /Failed to fetch/);
});

function runTableGetRoute(results) {
  const route = between(
    backgroundSource,
    'if (msg && msg.type === "SN_TABLE_GET" && sender.tab) {',
    'if (msg && msg.type === "SN_TRANSLATION_GET"'
  );
  return new Promise((resolve) => {
    new Function(
      "msg", "sender", "sendResponse", "readFromPageFrames", "tableApiGetInPage",
      "PAGE_READ_TIMEOUT_MS", "noResultError",
      route + "\nreturn false;"
    )(
      { type: "SN_TABLE_GET", table: "task", query: "", options: {} },
      { tab: { id: 1 } },
      resolve,
      async () => ({ results, failures: [] }),
      () => {},
      1000,
      () => "no frame answered"
    );
  });
}

test("when nothing succeeds, this instance's failure wins over a frame from another", async () => {
  const wrong = { ok: false, status: 0, wrongOrigin: true, error: "wrong origin" };
  assert.deepStrictEqual(plain(await runTableGetRoute([wrong, { ok: false, status: 500, error: "HTTP 500 reading task" }])),
    { ok: false, error: "HTTP 500 reading task", status: 500 });
  assert.deepStrictEqual(plain(await runTableGetRoute([{ ok: false, status: 500, error: "HTTP 500" },
    { ok: false, status: 403, error: "HTTP 403" }])).status, 403, "a 403 still speaks for every frame");
  assert.deepStrictEqual(plain(await runTableGetRoute([wrong, { ok: false, status: 0, noToken: true, error: "No token" }])).error,
    "No token");
  assert.deepStrictEqual(plain(await runTableGetRoute([wrong])).error, "wrong origin", "the last resort");
});

test("a 401 still reaches the content script", async () => {
  assert.strictEqual((await runTableGetRoute([{ ok: false, status: 401, error: "HTTP 401 reading task" }])).status, 401);
});

/* ------------------------------------------------------------------ *
 * The source tab's export
 * ------------------------------------------------------------------ */

function catalogRow(n, name, value, type) {
  const option = (column, v) => ["sc_item_option." + column, { value: v, display_value: v }];
  return Object.fromEntries([
    option("sys_id", id(400 + n)),
    option("value", value),
    option("item_option_new", id(500 + n)),
    option("item_option_new.name", name),
    option("item_option_new.question_text", name + " label"),
    option("item_option_new.type", type || "6"),
    option("item_option_new.order", String(100 * n)),
    option("item_option_new.variable_set", ""),
    option("item_option_new.reference", type === "8" ? "cmn_location" : ""),
    option("item_option_new.lookup_table", ""),
    option("item_option_new.list_table", ""),
  ]);
}

const SOURCE_RITM = id(0x5ce);

function sourceInstance(overrides) {
  const opts = overrides || {};
  return async (msg) => {
    if (msg.type !== "SN_TABLE_GET") return undefined;
    if (opts.fail && opts.fail(msg)) return opts.fail(msg);
    if (msg.table === "task") {
      if (opts.slowTaskMs) await tick(opts.slowTaskMs);
      return { ok: true, result: [{ sys_id: SOURCE_RITM, number: "RITM0010001", sys_class_name: "sc_req_item" }] };
    }
    if (msg.table === "sc_item_option_mtom") {
      return { ok: true, result: [catalogRow(1, "laptop_model", "X1"), catalogRow(2, "location", id(90), "8")] };
    }
    return { ok: true, result: [] };
  };
}

test("the export reads with this instance's origin and a token on every request", async () => {
  const prefill = loadPrefill({ origin: SANDBOX, answer: sourceInstance() });
  const reply = await prefill.exportPrefillSource({ input: "RITM0010001", requestId: "r1" });
  assert.strictEqual(reply.ok, true);
  assert.deepStrictEqual(reply.variables.map((variable) => variable.name), ["laptop_model", "location"]);
  assert.deepStrictEqual(plain(reply.source), { mode: "catalog", number: "RITM0010001", table: "sc_req_item" });
  const reads = tableReads(prefill.page);
  assert.ok(reads.length >= 3);
  reads.forEach((read) => {
    assert.strictEqual(read.options.expectedOrigin, SANDBOX, read.table);
    assert.strictEqual(read.options.requireToken, true, read.table);
  });
});

test("the export says it started before its first read, and beats after reads", async () => {
  /* A read slower than the 250 ms throttle, as a real one is: the beat after
   * it goes out at once. */
  const prefill = loadPrefill({ origin: SANDBOX, answer: sourceInstance({ slowTaskMs: 300 }) });
  await prefill.exportPrefillSource({ input: "RITM0010001", requestId: "r1" });
  const types = sentTypes(prefill.page);
  assert.strictEqual(types[0], "PREFILL_REMOTE_PROGRESS", "the heartbeat goes before any read");
  assert.strictEqual(prefill.page.sent[0].requestId, "r1");
  assert.ok(!("message" in prefill.page.sent[0]));
  const beats = prefill.page.sent.filter((msg) => msg.type === "PREFILL_REMOTE_PROGRESS");
  assert.ok(beats.length >= 2, "more than the first one");
  assert.ok(beats.every((beat) => beat.requestId === "r1"));
});

test("the export never touches the tab's own Prefill run or its debug copy", async () => {
  const prefill = loadPrefill({ origin: SANDBOX, answer: sourceInstance() });
  await prefill.exportPrefillSource({ input: "RITM0010001", requestId: "r1" });
  assert.strictEqual(prefill.running(), false);
  assert.deepStrictEqual(prefill.SNH, { lastPrefillVariables: [], lastPrefillSource: null, lastPrefillResult: null });
  assert.deepStrictEqual(prefill.page.toasts, []);
});

test("the export's heartbeat listener is removed even when a read throws", async () => {
  const prefill = loadPrefill({
    origin: SANDBOX,
    answer: sourceInstance({ fail: (msg) => (msg.table === "task" ? { ok: false, status: 500, error: "HTTP 500 reading task" } : null) }),
  });
  const reply = await prefill.exportPrefillSource({ input: "RITM0010001", requestId: "r1" });
  assert.deepStrictEqual(plain(reply), { ok: false, error: { message: "HTTP 500 reading task", status: 500 } });
  assert.strictEqual(prefill.snGetManyListeners.size, 0);
});

test("errors keep access, status and code through messaging", async () => {
  const prefill = loadPrefill();
  const error = new Error("No task found for RITM1 that this account can read.");
  error.access = "hidden";
  error.status = 403;
  error.code = "ambiguous";
  error.secret = "dropped";
  assert.deepStrictEqual(plain(prefill.serialisePrefillError(error)), {
    message: "No task found for RITM1 that this account can read.",
    access: "hidden",
    status: 403,
    code: "ambiguous",
  });
});

test("a 401 to a read sent with a token is signed out", async () => {
  const prefill = loadPrefill({
    origin: SANDBOX,
    answer: sourceInstance({ fail: (msg) => (msg.table === "task" ? { ok: false, status: 401, error: "HTTP 401 reading task" } : null) }),
  });
  const reply = await prefill.exportPrefillSource({ input: "RITM0010001", requestId: "r1" });
  assert.strictEqual(reply.error.code, "signed-out");
});

test("the export answers only the extension, and only from the top frame", async () => {
  const branch = between(
    contentSource,
    'if (msg && msg.type === "PREFILL_EXPORT_SOURCE") {',
    'if (msg && msg.type === "TOGGLE_PALETTE")'
  );
  const run = (sender, isTop) => {
    const top = {};
    const exported = [];
    const result = new Function(
      "msg", "sender", "sendResponse", "window", "chrome", "exportPrefillSource", "serialisePrefillError",
      branch + "\nreturn 'not handled';"
    )(
      { type: "PREFILL_EXPORT_SOURCE", input: "RITM1", requestId: "r1" },
      sender,
      () => {},
      isTop ? Object.assign(top, { top }) : { top },
      { runtime: { id: "glidelens" } },
      async (msg) => { exported.push(msg); return { ok: true }; },
      () => null
    );
    return { result, exported };
  };
  assert.deepStrictEqual(run({ id: "glidelens" }, true).result, true);
  assert.strictEqual(run({ id: "glidelens" }, true).exported.length, 1);
  for (const [sender, isTop] of [
    [{ id: "glidelens" }, false],
    [{ id: "glidelens", tab: { id: 3 } }, true],
    [{ id: "another-extension" }, true],
  ]) {
    const outcome = run(sender, isTop);
    assert.strictEqual(outcome.result, false);
    assert.deepStrictEqual(outcome.exported, []);
  }
});

/* ------------------------------------------------------------------ *
 * Values that don't travel: the check on the form's instance
 * ------------------------------------------------------------------ */

const ref = (name, value, table, extra) =>
  Object.assign({ name, label: name.replace(/_/g, " "), type: "8", value, displayValue: value, referenceTable: table }, extra);

/* The form's instance: which records exist, and which tables refuse. */
function formInstance(present, overrides) {
  const opts = overrides || {};
  return (msg) => {
    if (msg.type !== "SN_TABLE_GET" || !/^sys_idIN/.test(msg.query)) return undefined;
    if ((opts.refused || []).includes(msg.table)) return { ok: false, status: 403, error: "HTTP 403 reading " + msg.table };
    const asked = msg.query.slice("sys_idIN".length).split(",");
    return { ok: true, result: asked.filter((sysId) => present.includes(sysId)).map((sysId) => ({ sys_id: sysId })) };
  };
}

test("a reference found here is kept; one missing, refused or tableless is left empty and named", async () => {
  const prefill = loadPrefill({ answer: formInstance([id(1)], { refused: ["cmn_cost_center"] }) });
  const prepared = await prefill.prepareCrossInstanceVariables([
    ref("location", id(1), "cmn_location"),
    ref("building", id(2), "cmn_location"),
    ref("cost_centre", id(3), "cmn_cost_center"),
    ref("configuration_item", id(4), ""),
    { name: "summary", label: "Summary", type: "6", value: id(5) },
  ]);
  assert.deepStrictEqual(prepared.variables.map((variable) => variable.name), ["location", "summary"],
    "a text variable holding a sys_id is copied as it is");
  assert.strictEqual(prepared.withheld, 3);
  assert.deepStrictEqual(prepared.notes, [
    "Not filled, because the record isn't on this instance or this account can't see it: building.",
    "Not filled, because GlideLens couldn't check the record here: cost centre, configuration item.",
  ]);
  const reads = tableReads(prefill.page).map((msg) => msg.table + ":" + msg.fields);
  assert.deepStrictEqual(reads.sort(), ["cmn_cost_center:sys_id", "cmn_location:sys_id"],
    "one read per table, sys_id only, and none for a table with no name");
  tableReads(prefill.page).forEach((msg) => {
    assert.strictEqual(msg.options.expectedOrigin, HERE,
      "a frame embedded from another instance must not answer for this one");
  });
});

test("ids are checked a hundred at a time", async () => {
  const ids = Array.from({ length: 250 }, (_, index) => id(1000 + index));
  const prefill = loadPrefill({ answer: formInstance(ids) });
  const prepared = await prefill.prepareCrossInstanceVariables(
    ids.map((sysId, index) => ref("r" + index, sysId, "sys_user"))
  );
  assert.strictEqual(prepared.variables.length, 250);
  assert.deepStrictEqual(tableReads(prefill.page).map((msg) => msg.query.split(",").length), [100, 100, 50]);
});

test("a list collector keeps the records found here and says how many", async () => {
  const prefill = loadPrefill({ answer: formInstance([id(11), id(13)]) });
  const watchList = { name: "watch_list", label: "Watch list", type: "21", value: [id(11), id(12), id(13)].join(","),
    displayValue: [id(11), id(12), id(13)].join(","), referenceTable: "sys_user" };
  const prepared = await prefill.prepareCrossInstanceVariables([watchList]);
  assert.strictEqual(prepared.variables[0].value, id(11) + "," + id(13));
  assert.strictEqual(prepared.variables[0].displayValue, id(11) + "," + id(13));
  assert.strictEqual(watchList.value.split(",").length, 3, "the read itself is not changed");
  assert.strictEqual(prepared.withheld, 0);
  assert.deepStrictEqual(prepared.notes, ["Watch list: kept 2 of 3; the rest aren't on this instance."]);

  const none = await loadPrefill({ answer: formInstance([]) }).prepareCrossInstanceVariables([watchList]);
  assert.deepStrictEqual(none.variables, []);
  assert.strictEqual(none.withheld, 1);
});

test("a lookup holding a sys_id is checked like a reference; one holding text is not", async () => {
  const prefill = loadPrefill({ answer: formInstance([]) });
  const prepared = await prefill.prepareCrossInstanceVariables([
    { name: "model", label: "Model", type: "18", value: id(21), referenceTable: "cmdb_model" },
    { name: "size", label: "Size", type: "18", value: "Large", referenceTable: "u_sizes" },
  ]);
  assert.deepStrictEqual(prepared.variables.map((variable) => variable.name), ["size"]);
  assert.deepStrictEqual(tableReads(prefill.page).map((msg) => msg.table), ["cmdb_model"]);
});

test("an attachment is never filled, and is named", async () => {
  const prefill = loadPrefill({ answer: formInstance([]) });
  const prepared = await prefill.prepareCrossInstanceVariables([
    { name: "doc", label: "Supporting document", type: "33", value: id(31) },
  ]);
  assert.deepStrictEqual(prepared.variables, []);
  assert.strictEqual(prepared.withheld, 1);
  assert.deepStrictEqual(prepared.notes, ["Attachments aren't copied between instances: Supporting document."]);
  assert.deepStrictEqual(tableReads(prefill.page), [], "an attachment's record is not looked for");
});

test("a multi-row reference cell missing here is cleared, the rest of the set filled, and counted", async () => {
  const rows = [
    { device: id(41), note: "kept" },
    { device: id(42), note: "also kept" },
    { device: id(43), note: "" },
  ];
  const set = Object.assign({}, MRVS_VARIABLE, { value: JSON.stringify(rows), displayValue: JSON.stringify(rows) });
  const prefill = loadPrefill({ answer: formInstance([id(41)]) });
  const prepared = await prefill.prepareCrossInstanceVariables([set]);
  assert.strictEqual(prepared.withheld, 0, "the set is filled, not held back");
  assert.deepStrictEqual(JSON.parse(prepared.variables[0].value), [
    { device: id(41), note: "kept" },
    { device: "", note: "also kept" },
    { device: "", note: "" },
  ]);
  assert.deepStrictEqual(JSON.parse(prepared.variables[0].displayValue), JSON.parse(prepared.variables[0].value));
  assert.deepStrictEqual(prepared.notes, ["Devices: 2 cells left empty, because their records aren't on this instance."]);
  assert.deepStrictEqual(tableReads(prefill.page).map((msg) => msg.table), ["cmdb_ci"],
    "the column's own referenced table");
});

test("attachment cells in a multi-row set are cleared and named as attachments, not as missing records", async () => {
  /* Measured on the customer pair: a bank account set holds two attachment
   * questions beside its references, and the first live run called them
   * "records that aren't on this instance". */
  const rows = [{ bank_country: id(51), call_back_confirmation: id(52), bank_certificate: id(53), bank_name: "Example" }];
  const set = {
    name: "bank_accounts",
    label: "Bank Accounts",
    type: "34",
    value: JSON.stringify(rows),
    displayValue: JSON.stringify(rows),
    columns: Object.keys(rows[0]),
    columnMeta: {
      bank_country: { type: "8", reference: "core_country", lookupTable: "", listTable: "" },
      call_back_confirmation: { type: "33", reference: "", lookupTable: "", listTable: "" },
      bank_certificate: { type: "33", reference: "", lookupTable: "", listTable: "" },
      bank_name: { type: "6", reference: "", lookupTable: "", listTable: "" },
    },
  };
  const prefill = loadPrefill({ answer: formInstance([id(51)]) });
  const prepared = await prefill.prepareCrossInstanceVariables([set]);
  assert.deepStrictEqual(JSON.parse(prepared.variables[0].value), [
    { bank_country: id(51), call_back_confirmation: "", bank_certificate: "", bank_name: "Example" },
  ]);
  assert.strictEqual(prepared.withheld, 0, "the set itself is filled");
  assert.deepStrictEqual(prepared.notes, [
    "Bank Accounts: 2 attachments left empty, because attachments aren't copied between instances.",
  ]);
  assert.deepStrictEqual(tableReads(prefill.page).map((msg) => msg.table), ["core_country"],
    "an attachment's record is never looked for");
});

test("the withheld list stops at five names", async () => {
  const prefill = loadPrefill({ answer: formInstance([]) });
  const prepared = await prefill.prepareCrossInstanceVariables(
    ["A", "B", "C", "D", "E", "F", "G"].map((name, index) => ref(name, id(600 + index), "cmn_location"))
  );
  assert.deepStrictEqual(prepared.notes, [
    "Not filled, because the record isn't on this instance or this account can't see it: A, B, C, D, E (+2 more).",
  ]);
});

/* ------------------------------------------------------------------ *
 * The run, end to end on the form's tab
 * ------------------------------------------------------------------ */

const REMOTE_VARIABLES = [
  { name: "short_description", label: "Short description", type: "6", value: "Acme laptop", order: 100, orderKnown: true },
  ref("location", id(81), "cmn_location", { label: "Location", order: 200, orderKnown: true }),
  ref("cost_centre", id(82), "cmn_cost_center", { label: "Cost centre", order: 300, orderKnown: true }),
  { name: "doc", label: "Supporting document", type: "33", value: id(83), order: 400, orderKnown: true },
  { name: "watch_list", label: "Watch list", type: "21", value: id(84) + "," + id(85), referenceTable: "sys_user",
    order: 500, orderKnown: true },
  Object.assign({}, MRVS_VARIABLE, {
    value: JSON.stringify([{ device: id(86), note: "Acme spare" }, { device: id(87), note: "" }]),
  }),
];

function remoteRun(reply, present) {
  const formAnswer = formInstance(present || [id(82), id(84), id(86)]);
  return loadPrefill({
    answer: (msg) => {
      if (msg.type === "PREFILL_REMOTE_READ") return reply;
      return formAnswer(msg);
    },
  });
}

test("a read from another instance fills what travels and names what didn't", async () => {
  const prefill = remoteRun(exportReply(REMOTE_VARIABLES));
  await prefill.prefillPortalVariablesFromTicket("RITM0010001", fakePicker(SANDBOX, true));

  assert.deepStrictEqual(prefill.page.filled.map((variable) => variable.name),
    ["short_description", "cost_centre", "watch_list", "devices"],
    "in this form's order, with the multi-row set last");
  assert.deepStrictEqual(prefill.page.toasts.filter((toast) => !toast.isErr).map((toast) => toast.text).slice(0, 2), [
    "Reading RITM0010001 from examplesbx…",
    "Checking referenced records on this instance…",
  ]);
  assert.deepStrictEqual(lastToast(prefill.page), {
    text: [
      "Done. Filled 4 of 6 variables from RITM0010001 on examplesbx (2 not filled).",
      "Not filled, because the record isn't on this instance or this account can't see it: Location.",
      "Watch list: kept 1 of 2; the rest aren't on this instance.",
      "Attachments aren't copied between instances: Supporting document.",
      "Devices: 1 cell left empty, because its record isn't on this instance.",
      "You can close this (Esc) and review the form.",
    ].join("\n"),
    isErr: false,
  });
  assert.strictEqual(prefill.SNH.lastPrefillSource.origin, SANDBOX, "the debug copy says which instance was read");
});

test("the counts add up to the number read, with the withheld counted as not filled", async () => {
  const prefill = loadPrefill({
    answer: (msg) => {
      if (msg.type === "PREFILL_REMOTE_READ") return exportReply(REMOTE_VARIABLES);
      if (msg.type === "FILL_PORTAL_VARIABLES") {
        return { ok: true, foundForm: true, filled: 2, alreadySet: 1, skipped: 0, unmatched: 1 };
      }
      return formInstance([id(82), id(84), id(86)])(msg);
    },
  });
  await prefill.prefillPortalVariablesFromTicket("RITM0010001", fakePicker(SANDBOX, true));
  const summary = lastToast(prefill.page).text.split("\n")[0];
  assert.strictEqual(summary,
    "Done. Filled 2 of 6 variables from RITM0010001 on examplesbx (1 already set, 1 not on this form, 2 not filled).");
  const [filled, total] = summary.match(/Filled (\d+) of (\d+)/).slice(1).map(Number);
  const details = summary.match(/\(([^)]*)\)/)[1].match(/\d+/g).map(Number);
  assert.strictEqual(filled + details.reduce((sum, count) => sum + count, 0), total);
});

test("the finished message's notes are neutral and its summary keeps the success colour", async () => {
  const prefill = remoteRun(exportReply(REMOTE_VARIABLES));
  await prefill.prefillPortalVariablesFromTicket("RITM0010001", fakePicker(SANDBOX, true));
  const state = prefill.page.toastStates[prefill.page.toastStates.length - 1];
  assert.strictEqual(state.done, true);
  assert.deepStrictEqual(state.lines.map((line) => line.kind), ["", "note", "note", "note", "note", "hint"]);
});

test("no message names a value or a sys_id, from a link or a typed sys_id", async () => {
  for (const input of [RITM_LINK, RITM_ID]) {
    const prefill = remoteRun(exportReply(REMOTE_VARIABLES, { source: { mode: "producer", number: "", table: "" } }));
    await prefill.prefillPortalVariablesFromTicket(input, fakePicker(SANDBOX, true));
    const texts = prefill.page.toasts.map((toast) => toast.text);
    texts.forEach((text) => {
      assert.ok(!HEX32.test(text), text);
      assert.ok(!/Acme/.test(text), text);
    });
    const label = input === RITM_LINK ? "the linked ticket" : "that record";
    assert.strictEqual(texts[0], "Reading " + label + " from examplesbx…");
    assert.match(lastToast(prefill.page).text, new RegExp("^Done\\. Filled 4 of 6 variables from " + label + " on examplesbx"));
  }
});

test("once the read answers, the Done line names the ticket by its number", async () => {
  const prefill = remoteRun(exportReply(REMOTE_VARIABLES));
  await prefill.prefillPortalVariablesFromTicket(RITM_LINK, fakePicker("", true));
  assert.strictEqual(prefill.page.toasts[0].text, "Reading the linked ticket from examplesbx…");
  assert.match(lastToast(prefill.page).text, /^Done\. Filled 4 of 6 variables from RITM0010001 on examplesbx /);
});

test("each refusal from the other instance is told in its own words", async () => {
  const cases = [
    [{ ok: false, code: "not-open" }, "examplesbx.service-now.com isn't open in this browser. Open it in a tab, sign in, then try again."],
    [{ ok: false, code: "asleep" }, "Your examplesbx tab is asleep. Click it once, then try again."],
    [{ ok: false, code: "no-receiver" }, "GlideLens isn't running in your examplesbx tab yet. Reload that tab, then try again."],
    [{ ok: false, code: "signed-out" }, "You're not signed in to examplesbx. Sign in there, then try again."],
    [{ ok: false, code: "switching" }, "Prefill is switching your session on examplesbx in another tab. Wait for it to finish."],
    [{ ok: false, code: "hidden", access: "hidden" }, "RITM0010001 wasn't found on examplesbx, or your session there can't see it."],
    [{ ok: false, code: "refused", access: "refused" }, "Your session on examplesbx can't read RITM0010001's variables."],
    [{ ok: false, code: "ambiguous" }, "Two records have number RITM0010001 on examplesbx. Paste the ticket's link instead."],
    [{ ok: false, code: "malformed" }, "GlideLens couldn't read RITM0010001 from examplesbx. Try again."],
    [undefined, "GlideLens couldn't read RITM0010001 from examplesbx. Try again."],
  ];
  for (const [reply, text] of cases) {
    const prefill = remoteRun(reply);
    await prefill.prefillPortalVariablesFromTicket("RITM0010001", fakePicker(SANDBOX, true));
    assert.deepStrictEqual(lastToast(prefill.page), { text, isErr: true }, JSON.stringify(reply));
  }
});

test("a refusal while the other session impersonates says so, and never offers or makes a switch", async () => {
  const prefill = remoteRun({ ok: false, code: "refused", access: "refused", sourceImpersonating: true });
  await prefill.prefillPortalVariablesFromTicket("RITM0010001", fakePicker(SANDBOX, true));
  assert.strictEqual(lastToast(prefill.page).text,
    "Your session on examplesbx can't read RITM0010001's variables. " +
      "You're impersonating someone there: stop that in its tab, then try again.");
  assert.deepStrictEqual(prefill.page.confirmations, []);
  assert.ok(!sentTypes(prefill.page).some((type) => /^SN_IMPERSONATE_|^PREFILL_SWAP_/.test(type)));
  const branch = stripComments(
    between(contentSource, "async function prefillFromOtherInstance(", "async function offerPrefillSessionSwitch(")
  );
  assert.ok(!branch.includes("offerPrefillSessionSwitch("), "unreachable from the remote branch");
  assert.ok(!branch.includes("PREFILL_SWAP_"));
});

test("a part-refused remote read fills what it read, and says why the rest is missing", async () => {
  const prefill = remoteRun(exportReply([REMOTE_VARIABLES[0]], { readRefused: true, sourceImpersonating: true }));
  await prefill.prefillPortalVariablesFromTicket("RITM0010001", fakePicker(SANDBOX, true));
  assert.deepStrictEqual(lastToast(prefill.page), {
    text: "Done. Filled 1 of 1 variables from RITM0010001 on examplesbx.\n" +
      "Some of the ticket's variables couldn't be read, so check the form for gaps.\n" +
      "You're impersonating someone there: stop that in its tab, then try again.\n" +
      "You can close this (Esc) and review the form.",
    isErr: false,
  });
  assert.deepStrictEqual(prefill.page.confirmations, []);
});

test("a part-refused remote read that matches nothing names the refusal, not the form", async () => {
  /* Measured on the customer pair: a sandbox session impersonating a requester
   * read only the multi-row sets, under names the form doesn't use, and the
   * run said only "No matching variables on this form". */
  const reply = exportReply([REMOTE_VARIABLES[0]], { readRefused: true, sourceImpersonating: true });
  const prefill = loadPrefill({
    answer: (msg) => {
      if (msg.type === "PREFILL_REMOTE_READ") return reply;
      if (msg.type === "FILL_PORTAL_VARIABLES") {
        return { ok: true, foundForm: true, filled: 0, alreadySet: 0, skipped: 0, unmatched: msg.variables.length };
      }
      return undefined;
    },
  });
  await prefill.prefillPortalVariablesFromTicket("RITM0010001", fakePicker(SANDBOX, true));
  assert.deepStrictEqual(lastToast(prefill.page), {
    text: "Your session on examplesbx can't read all of RITM0010001's variables, and what it read isn't on this form. " +
      "You're impersonating someone there: stop that in its tab, then try again.",
    isErr: true,
  });

  const whole = loadPrefill({
    answer: (msg) => {
      if (msg.type === "PREFILL_REMOTE_READ") return exportReply([REMOTE_VARIABLES[0]]);
      if (msg.type === "FILL_PORTAL_VARIABLES") {
        return { ok: true, foundForm: true, filled: 0, alreadySet: 0, skipped: 0, unmatched: msg.variables.length };
      }
      return undefined;
    },
  });
  await whole.prefillPortalVariablesFromTicket("RITM0010001", fakePicker(SANDBOX, true));
  assert.strictEqual(lastToast(whole.page).text, "No matching variables on this form (1 not found).",
    "a read that was not refused still says the form is the reason");
});

test("a run that matches nothing still names what was held back before the fill", async () => {
  const unmatched = (msg) => ({ ok: true, foundForm: true, filled: 0, alreadySet: 0, skipped: 0,
    unmatched: msg.variables.length });
  const variables = [REMOTE_VARIABLES[0], REMOTE_VARIABLES[1], REMOTE_VARIABLES[3]];
  const heldBack =
    "Not filled, because the record isn't on this instance or this account can't see it: Location.\n" +
    "Attachments aren't copied between instances: Supporting document.";

  const whole = loadPrefill({
    answer: (msg) => {
      if (msg.type === "PREFILL_REMOTE_READ") return exportReply(variables);
      if (msg.type === "FILL_PORTAL_VARIABLES") return unmatched(msg);
      return formInstance([])(msg);
    },
  });
  await whole.prefillPortalVariablesFromTicket("RITM0010001", fakePicker(SANDBOX, true));
  assert.deepStrictEqual(lastToast(whole.page), {
    text: "No matching variables on this form (1 not found).\n" + heldBack,
    isErr: true,
  });

  const refused = loadPrefill({
    answer: (msg) => {
      if (msg.type === "PREFILL_REMOTE_READ") {
        return exportReply(variables, { readRefused: true, sourceImpersonating: true });
      }
      if (msg.type === "FILL_PORTAL_VARIABLES") return unmatched(msg);
      return formInstance([])(msg);
    },
  });
  await refused.prefillPortalVariablesFromTicket("RITM0010001", fakePicker(SANDBOX, true));
  assert.deepStrictEqual(lastToast(refused.page), {
    text: "Your session on examplesbx can't read all of RITM0010001's variables, and what it read isn't on this form. " +
      "You're impersonating someone there: stop that in its tab, then try again.\n" + heldBack,
    isErr: true,
  }, "the impersonation line is said once");
});

test("a read where nothing can travel fills nothing and says why", async () => {
  const prefill = remoteRun(exportReply([REMOTE_VARIABLES[3]]));
  await prefill.prefillPortalVariablesFromTicket("RITM0010001", fakePicker(SANDBOX, true));
  assert.strictEqual(prefill.page.filled, null);
  assert.deepStrictEqual(lastToast(prefill.page), {
    text: "Nothing from RITM0010001 can be filled on this instance.\n" +
      "Attachments aren't copied between instances: Supporting document.",
    isErr: true,
  });
});

test("a run on this instance checks nothing and fills as before", async () => {
  const prefill = loadPrefill({
    answer: (msg) => {
      if (msg.type !== "SN_TABLE_GET") return undefined;
      if (msg.table === "task") {
        return { ok: true, result: [{ sys_id: SOURCE_RITM, number: "RITM0010001", sys_class_name: "sc_req_item" }] };
      }
      if (msg.table === "sc_item_option_mtom") {
        return { ok: true, result: [catalogRow(1, "laptop_model", "X1"), catalogRow(2, "location", id(90), "8")] };
      }
      return undefined;
    },
  });
  await prefill.prefillPortalVariablesFromTicket("RITM0010001", fakePicker("", true));
  assert.deepStrictEqual(prefill.page.filled.map((variable) => variable.name), ["laptop_model", "location"]);
  assert.ok(!prefill.page.sent.some((msg) => msg.type === "PREFILL_REMOTE_READ" || /^sys_idIN/.test(msg.query || "")));
  assert.strictEqual(lastToast(prefill.page).text, "Done. Filled 2 of 2 variables.\nYou can close this (Esc) and review the form.");
  assert.strictEqual(prefill.SNH.lastPrefillSource.origin, HERE);
});

test("the multi-row read keeps each column's type and referenced tables", () => {
  const prefill = loadPrefill();
  const variables = new Map();
  const cell = (row, column, type, reference, value) => ({
    sys_id: { value: id(700 + row * 10 + column.length) },
    parent_id: { value: SOURCE_RITM },
    row_index: { value: String(row) },
    variable_set: { value: id(71) },
    "variable_set.internal_name": { value: "devices" },
    "variable_set.title": { value: "Devices", display_value: "Devices" },
    item_option_new: { value: id(800 + column.length) },
    "item_option_new.name": { value: column },
    "item_option_new.type": { value: type },
    "item_option_new.reference": { value: reference },
    "item_option_new.lookup_table": { value: "" },
    "item_option_new.list_table": { value: "" },
    value: { value, display_value: value },
  });
  prefill.addMultiRowVariablesFromAnswerRows(variables, [
    cell(1, "device", "8", "cmdb_ci", id(41)),
    cell(1, "note", "6", "", "spare"),
    cell(2, "device", "8", "cmdb_ci", id(42)),
  ], {});
  assert.deepStrictEqual(plain(variables.get("devices").columnMeta), {
    device: { type: "8", reference: "cmdb_ci", lookupTable: "", listTable: "" },
    note: { type: "6", reference: "", lookupTable: "", listTable: "" },
  });
});

/* ------------------------------------------------------------------ *
 * The palette row
 * ------------------------------------------------------------------ */

/*
 * Enough DOM for the palette's input row, its select and its toast: a tree
 * with ids, focus, listeners, options and removal. Setting textContent drops
 * the children, as it does in a browser.
 */
function fakeShadow() {
  let active = null;
  let root = null;
  const make = (tag) => {
    const listeners = {};
    let ownText = "";
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parent: null,
      id: "",
      hidden: false,
      disabled: false,
      className: "",
      value: "",
      title: "",
      htmlFor: "",
      style: {},
      dataset: {},
      appendChild(child) {
        if (child.parent) child.remove();
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
      setAttribute(name, value) {
        el[name] = value;
      },
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      dispatch(type, event) {
        (listeners[type] || []).forEach((fn) => fn(event || {}));
      },
      focus() {
        active = el;
      },
      get textContent() {
        return ownText + el.children.map((child) => child.textContent).join("");
      },
      set textContent(text) {
        ownText = String(text);
        el.children.forEach((child) => { child.parent = null; });
        el.children = [];
      },
      get options() {
        return el.children.filter((child) => child.tagName === "OPTION");
      },
      get isConnected() {
        let node = el;
        while (node.parent) node = node.parent;
        return node === root;
      },
    };
    return el;
  };
  const walk = (node, out) => {
    out.push(node);
    node.children.forEach((child) => walk(child, out));
    return out;
  };
  root = make("#shadow-root");
  root.getElementById = (elementId) => walk(root, []).find((node) => node.id === elementId) || null;
  /* Honours the tag names in the selector it is given, so the focus trap's
   * own selector decides what Tab can reach: drop `select` from it and the
   * Tab tests fail, as they should. */
  root.querySelectorAll = (selector) => {
    const tags = String(selector)
      .split(",")
      .map((part) => part.trim().split(/[:[]/)[0].toUpperCase())
      .filter(Boolean);
    return walk(root, []).filter((node) => tags.includes(node.tagName) && !node.disabled);
  };
  Object.defineProperty(root, "activeElement", { get: () => active });
  const box = root.appendChild(make("div"));
  box.id = "box";
  const search = box.appendChild(make("input"));
  search.id = "search";
  const list = box.appendChild(make("div"));
  list.id = "results";
  const toast = box.appendChild(make("div"));
  toast.id = "toast";
  return { root, search, list, toast, make, active: () => active };
}

function loadPaletteRow(dom, options) {
  const opts = options || {};
  const helpers = loadPrefill();
  const sent = [];
  const instances = opts.instances;
  const closed = { count: 0 };
  if (opts.contextGone) {
    opts.send = () => {
      throw new Error("Extension context invalidated.");
    };
  }
  const block =
    between(contentSource, "function showToast(", "async function copyText(") +
    between(contentSource, "function showArgInput(", "function clampPalettePosition(") +
    between(contentSource, "function trapPaletteFocus(", "function openPalette(");
  const ui = new Function(
    "paletteShadow", "paletteList", "paletteInput", "paletteToast", "activeInputCmd", "closePalette",
    "document", "chrome", "location", "prefillInstanceLabel", "prefillLinkIn",
    block + "\nreturn { showToast, showArgInput, trapPaletteFocus, mountPrefillSourcePicker, prefillSourcePicker };"
  )(
    dom.root, dom.list, dom.search, dom.toast, null, () => { closed.count += 1; },
    { createElement: dom.make },
    {
      runtime: {
        sendMessage: (msg) => {
          sent.push(msg);
          if (opts.send) return opts.send(msg);
          if (msg.type !== "PREFILL_SOURCE_INSTANCES") return Promise.resolve(undefined);
          return opts.pending || Promise.resolve(instances ? { ok: true, origins: instances } : { ok: true, origins: [] });
        },
      },
    },
    { origin: HERE },
    helpers.prefillInstanceLabel,
    helpers.prefillLinkIn
  );
  const runs = [];
  const cmd = {
    inputLabel: "Source ticket, sys_id or link",
    keepOpen: true,
    argExtras: (context) => ui.mountPrefillSourcePicker(context),
    run: (value) => runs.push({ value, picker: ui.prefillSourcePicker() }),
  };
  return { ui, cmd, runs, sent, closed };
}

const key = (name, extra) => Object.assign({
  key: name,
  shiftKey: false,
  defaultPrevented: false,
  propagationStopped: false,
  preventDefault() { this.defaultPrevented = true; },
  stopPropagation() { this.propagationStopped = true; },
}, extra);

const OTHER_INSTANCES = [
  { origin: SANDBOX, label: "examplesbx" },
  { origin: TEST_INSTANCE, label: "exampletest" },
];

async function openRow(options) {
  const dom = fakeShadow();
  const row = loadPaletteRow(dom, options);
  row.ui.showArgInput(row.cmd);
  await tick();
  return Object.assign(row, {
    dom,
    input: dom.root.getElementById("arg-input"),
    select: dom.root.getElementById("arg-source"),
    hint: dom.root.getElementById("arg-hint"),
  });
}

test("Read from sits under the input with its own label, and lists the other instances", async () => {
  const row = await openRow({ instances: OTHER_INSTANCES });
  const children = row.dom.root.getElementById("arg-row").children;
  assert.deepStrictEqual(children.map((child) => child.id || child.tagName), [
    "LABEL", "arg-input", "LABEL", "arg-source", "arg-hint",
  ]);
  assert.strictEqual(children[2].htmlFor, "arg-source");
  assert.strictEqual(children[2].textContent, "Read from");
  assert.strictEqual(children[2].hidden, false);
  assert.strictEqual(row.select.hidden, false);
  assert.deepStrictEqual(row.select.options.map((option) => [option.value, option.textContent, option.title]), [
    [HERE, "This instance (exampledev)", ""],
    [SANDBOX, "examplesbx", "examplesbx.service-now.com"],
    [TEST_INSTANCE, "exampletest", "exampletest.service-now.com"],
  ]);
  assert.strictEqual(row.select.value, HERE, "this instance, every time the row opens");
  assert.strictEqual(row.hint.textContent,
    "Lists the instances open in this browser. To add one, open it in a tab, sign in, then reopen Variable Prefill.");
});

test("with no other instance open, the select stays hidden and the hint says how to add one", async () => {
  const row = await openRow({ instances: [] });
  assert.strictEqual(row.select.hidden, true);
  assert.strictEqual(row.hint.textContent,
    "To copy from another instance, open it in a tab and sign in, then reopen Variable Prefill.");
  row.input.value = "RITM0010001";
  row.input.onkeydown(key("Enter"));
  assert.strictEqual(row.runs[0].picker.chosenOrigin(), "");
  assert.strictEqual(row.runs[0].picker.othersOpen(), false);
});

test("a run before the list arrives is local", async () => {
  const row = await openRow({ pending: new Promise(() => {}) });
  row.input.value = "RITM0010001";
  row.input.onkeydown(key("Enter"));
  assert.strictEqual(row.runs[0].picker.chosenOrigin(), "");
});

test("a pasted link moves Read from at once; text, other hosts and closed instances leave it alone", async () => {
  const row = await openRow({ instances: OTHER_INSTANCES });
  const paste = (text) => {
    row.input.value = text;
    row.input.dispatch("input");
    return row.select.value;
  };
  assert.strictEqual(paste(RITM_LINK), SANDBOX);
  assert.strictEqual(paste(HERE + "/sc_req_item.do?sys_id=" + RITM_ID), HERE);
  row.select.value = TEST_INSTANCE; // the person's own choice
  assert.strictEqual(paste("RITM0010001"), TEST_INSTANCE);
  assert.strictEqual(paste("https://servicedesk.example.com/sc_req_item.do?sys_id=" + RITM_ID), TEST_INSTANCE);
  assert.strictEqual(paste("https://exampleclosed.service-now.com/sc_req_item.do?sys_id=" + RITM_ID), TEST_INSTANCE);
});

test("the run's own parse still moves Read from to the link's instance", async () => {
  const row = await openRow({ instances: OTHER_INSTANCES });
  row.select.value = TEST_INSTANCE;
  row.input.value = RITM_LINK;
  row.input.onkeydown(key("Enter"));
  const picker = row.runs[0].picker;
  assert.strictEqual(picker.chosenOrigin(), TEST_INSTANCE);
  picker.show(SANDBOX);
  assert.strictEqual(row.select.value, SANDBOX);
  picker.show("https://exampleclosed.service-now.com");
  assert.strictEqual(row.select.value, SANDBOX, "an instance that isn't listed doesn't move it");
});

test("Tab moves from the input to Read from and wraps; Shift+Tab goes back", async () => {
  const row = await openRow({ instances: OTHER_INSTANCES });
  const tab = key("Tab");
  row.input.onkeydown(tab);
  assert.strictEqual(tab.propagationStopped, false, "Tab reaches the box's focus trap");
  row.ui.trapPaletteFocus(tab);
  assert.strictEqual(row.dom.active(), row.select);

  const next = key("Tab");
  row.select.onkeydown(next);
  assert.strictEqual(next.propagationStopped, false);
  row.ui.trapPaletteFocus(next);
  assert.strictEqual(row.dom.active(), row.dom.search, "wraps inside the palette");

  row.select.focus();
  row.ui.trapPaletteFocus(key("Tab", { shiftKey: true }));
  assert.strictEqual(row.dom.active(), row.input);
});

test("a hidden Read from is skipped by Tab", async () => {
  const row = await openRow({ instances: [] });
  row.input.focus();
  row.ui.trapPaletteFocus(key("Tab"));
  assert.strictEqual(row.dom.active(), row.dom.search);
});

test("Esc on Read from goes back to the list, never through to the palette's own close", async () => {
  const row = await openRow({ instances: OTHER_INSTANCES });
  row.select.focus();
  const esc = key("Escape");
  row.select.onkeydown(esc);
  assert.strictEqual(esc.propagationStopped, true);
  assert.strictEqual(row.closed.count, 0);
  assert.strictEqual(row.dom.root.getElementById("arg-row"), null);
  assert.strictEqual(row.dom.active(), row.dom.search);
});

test("Esc on Read from closes the palette once a run has ended", async () => {
  const row = await openRow({ instances: OTHER_INSTANCES });
  row.ui.showToast("Done. Filled 2 of 2 variables.", false, 0, { done: true });
  const esc = key("Escape");
  row.select.onkeydown(esc);
  assert.strictEqual(esc.propagationStopped, true);
  assert.strictEqual(row.closed.count, 1);
});

test("Esc in the input still goes back a step without reaching the palette's close", async () => {
  const row = await openRow({ instances: OTHER_INSTANCES });
  const esc = key("Escape");
  row.input.onkeydown(esc);
  assert.strictEqual(esc.propagationStopped, true);
  assert.strictEqual(row.closed.count, 0);
  assert.strictEqual(row.dom.root.getElementById("arg-row"), null);
});

test("Enter in Read from runs nothing; Enter in the input runs", async () => {
  const row = await openRow({ instances: OTHER_INSTANCES });
  const enter = key("Enter");
  row.select.onkeydown(enter);
  assert.deepStrictEqual(row.runs, []);
  assert.strictEqual(enter.propagationStopped, true);
  row.input.value = "RITM0010001";
  row.input.onkeydown(key("Enter"));
  assert.strictEqual(row.runs.length, 1);
  assert.strictEqual(row.runs[0].value, "RITM0010001");
});

test("a page left open across an extension reload still opens the row, on this instance", async () => {
  const row = await openRow({ contextGone: true });
  assert.ok(row.input, "the row is there");
  assert.strictEqual(row.select.hidden, true);
  assert.strictEqual(row.hint.textContent,
    "To copy from another instance, open it in a tab and sign in, then reopen Variable Prefill.");
});

test("the focus trap's selector reaches a select", () => {
  const trap = between(contentSource, "function trapPaletteFocus(", "function openPalette(");
  assert.match(trap, /select:not\(\[disabled\]\)/);
});

test("a command with no extras gets no Read from", async () => {
  const dom = fakeShadow();
  const row = loadPaletteRow(dom, { instances: OTHER_INSTANCES });
  row.ui.showArgInput({ inputLabel: "Record sys_id or URL", run: () => {} });
  await tick();
  assert.strictEqual(dom.root.getElementById("arg-source"), null);
  assert.deepStrictEqual(row.sent, []);
});

test("finished lines are drawn by kind, each as text", async () => {
  const dom = fakeShadow();
  const row = loadPaletteRow(dom);
  const markup = "<img src=x onerror=alert(1)>";
  row.ui.showToast("ignored when lines are given", false, 0, {
    done: true,
    lines: [
      { text: "Done. Filled 1 of 2 variables.", kind: "" },
      { text: "Not filled …: " + markup, kind: "note" },
      { text: "You can close this (Esc) and review the form.", kind: "hint" },
    ],
  });
  const spans = dom.toast.children;
  assert.deepStrictEqual(spans.map((span) => span.className), ["", "toast-note", "toast-hint"]);
  assert.strictEqual(spans[1].textContent, "\nNot filled …: " + markup, "markup stays text");
  assert.strictEqual(dom.toast.className, "done");
  assert.strictEqual(dom.toast.textContent,
    "Done. Filled 1 of 2 variables.\nNot filled …: " + markup + "\nYou can close this (Esc) and review the form.");

  row.ui.showToast("Couldn't read.", true, 0, { sticky: true });
  assert.deepStrictEqual(dom.toast.children, [], "an error is one colour throughout");
  assert.strictEqual(dom.toast.textContent, "Couldn't read.");
});

test("a note reads in the body colour and the close hint in the muted one", () => {
  assert.match(contentSource, /#toast \.toast-note\{color:var\(--palette-body\)\}/);
  assert.match(contentSource, /#toast \.toast-hint\{color:var\(--palette-muted\)\}/);
  assert.match(contentSource, /#arg-source\{[^}]*color-scheme:dark/);
});

test("the command's text names the new ways to give a source", () => {
  const command = between(contentSource, 'id: "prefill-variables",', "},");
  assert.match(command, /inputLabel: "Source ticket, sys_id or link"/);
  assert.match(command, /placeholder: "RITM\/SCTASK\/REQ\/case number, sys_id, or a ticket link"/);
  assert.match(command, /description: "Copy catalog-variable values from another ticket, on this or another open instance…"/);
  assert.match(command, /"instance", "case"/);
});

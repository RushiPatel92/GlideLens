/*
 * Update Set Lens: the runtime boundary.
 *
 *   node --test tests/update_set_lens_integration.test.js
 *
 * DEV-ONLY, like its siblings. The worker's real Check on route runs against
 * simulated tabs, the shared reader's withTotal against a simulated fetch,
 * and the content script's real exporter against a simulated instance --
 * each lifted from its file by the same kind of anchors the Prefill suite
 * uses, so moving one fails loudly instead of testing nothing. Plus the
 * routes, the injection and the packaging allowlist, read as source.
 *
 * Synthetic data only.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8").replace(/\r\n/g, "\n");
const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8").replace(/\r\n/g, "\n");
const packageSource = fs.readFileSync(path.join(root, "package.mjs"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const stripComments = (source) =>
  String(source).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, "source block not found: " + startText);
  return source.slice(start, end);
}

const HERE = "https://exampledev.service-now.com";
const THERE = "https://exampletest.service-now.com";
const id = (n) => Number(n).toString(16).padStart(32, "0");
const guid = (n) => "b" + Number(n).toString(16).padStart(31, "0");
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 0));
const SENDER = { tab: { id: 1, url: HERE + "/sys_update_set.do?sys_id=" + id(1), incognito: false }, frameId: 0, origin: HERE };

/* ------------------------------------------------------------------ *
 * The worker
 * ------------------------------------------------------------------ */

function otherTab(overrides) {
  return Object.assign({ id: 20, url: THERE + "/now/nav/ui/home", active: false, incognito: false }, overrides);
}

function loadWorker(options) {
  const opts = options || {};
  const block = between(backgroundSource, "const REMOTE_READ_IDLE_MS", "// Content scripts can't call chrome.tabs.create")
    .replace("const REMOTE_READ_IDLE_MS = 45000;", "const REMOTE_READ_IDLE_MS = " + (opts.idleMs || 200) + ";")
    .replace("const REMOTE_READ_CEILING_MS = 180000;", "const REMOTE_READ_CEILING_MS = 5000;")
    .replace("const REMOTE_READ_TICK_MS = 1000;", "const REMOTE_READ_TICK_MS = 5;");
  const origins = between(backgroundSource, "const SN_TAB_HOST", "/* Returns a URL rebuilt from its parsed form");
  const tabOptions = between(backgroundSource, "function openUrlTabOptions(", "\n}\n") + "\n}\n";
  const state = {
    tabs: opts.tabs || [otherTab()],
    created: [],
    sent: [],
    relayed: [],
    impersonationReads: [],
    swaps: opts.swaps || new Map(),
    running: new Map(),
  };
  const matches = (pattern, url) =>
    pattern === "https://*.service-now.com/*" ? /^https:\/\/[^/]+\.service-now\.com\//.test(url)
      : url.startsWith(pattern.slice(0, -1));
  let api;
  const worker = {
    heartbeat: (tabId, requestId, message) =>
      api.noteRemoteReadProgress({ requestId, message }, { tab: { id: tabId }, frameId: 0 }),
  };
  const chrome = {
    tabs: {
      query: async (query) => state.tabs.filter((tab) => matches(query.url, tab.url)),
      create: async (createOptions) => {
        state.created.push(createOptions);
        return { id: 99 };
      },
      sendMessage: (tabId, message, sendOptions) => {
        state.sent.push({ tabId, message, options: sendOptions });
        return opts.answer ? opts.answer(tabId, message, worker) : Promise.resolve(undefined);
      },
    },
  };
  api = new Function(
    "chrome", "discoverContentFrames", "probeTokenFrame", "readImpersonationState",
    "prefillSwapByTab", "prefillRemoteByTab", "updateSetRemoteByTab", "sendToTab",
    origins + tabOptions + block +
      "\nreturn { checkUpdateSetOnOtherInstance, checkedUpdateSetRequest, checkedUpdateSetExport, " +
      "noteRemoteReadProgress, remoteReadByRequest, openOnOtherInstance };"
  )(
    chrome,
    async () => [0],
    async (tabId, frameId) => ({ frameId, hasToken: true }),
    async (tabId, origin) => {
      state.impersonationReads.push({ tabId, origin });
      return { isImpersonating: Boolean(opts.impersonating) };
    },
    state.swaps,
    new Map(),
    state.running,
    (tabId, message, sendOptions) => state.relayed.push({ tabId, message, options: sendOptions })
  );
  return Object.assign(api, { state, worker });
}

const RECORD = { name: "sys_script_include_" + id(77), guid: guid(1), hash: "-1234567" };
const check = (extra) => Object.assign({ type: "UPDATE_SET_REMOTE_CHECK", origin: THERE, setIds: [id(1)], records: [RECORD] }, extra);
const okReply = (extra) => Object.assign({ ok: true, copies: [], clones: [], content: ["runs"] }, extra);

test("the check takes an origin, set ids and records, and refuses anything else before any tab is messaged", async () => {
  const worker = loadWorker({ answer: async () => okReply() });
  const refusals = [
    check({ table: "sys_user" }),
    check({ query: "active=true" }),
    check({ origin: HERE }),
    check({ origin: "https://example.com" }),
    check({ origin: THERE + "/" }),
    check({ setIds: [] }),
    check({ setIds: Array.from({ length: 1001 }, (_, index) => id(index + 1)) }),
    check({ setIds: [id(1), id(1)] }),
    check({ setIds: ["undefined"] }),
    check({ records: Array.from({ length: 2001 }, () => RECORD) }),
    check({ records: [Object.assign({}, RECORD, { name: "sys_choice_a,b" })] }),
    check({ records: [Object.assign({}, RECORD, { name: "a^b" })] }),
    check({ records: [Object.assign({}, RECORD, { guid: guid(1).toUpperCase() })] }),
    check({ records: [Object.assign({}, RECORD, { guid: guid(1).slice(1) })] }),
    check({ records: [Object.assign({}, RECORD, { hash: "a1b2c3" })] }),
    check({ records: [Object.assign({}, RECORD, { hash: "" })] }),
    check({ records: [Object.assign({}, RECORD, { hash: "12.5" })] }),
    check({ records: [Object.assign({}, RECORD, { hash: "12345678901" })] }),
    check({ records: [Object.assign({}, RECORD, { hash: -1234567 })] }),
    check({ records: [Object.assign({}, RECORD, { table: "sys_user" })] }),
  ];
  for (const msg of refusals) {
    assert.strictEqual((await worker.checkUpdateSetOnOtherInstance(msg, SENDER)).code, "invalid", JSON.stringify(msg).slice(0, 160));
  }
  const subFrame = Object.assign({}, SENDER, { frameId: 3 });
  assert.strictEqual((await worker.checkUpdateSetOnOtherInstance(check(), subFrame)).code, "invalid");
  assert.deepStrictEqual(worker.state.sent, []);
});

test("signed decimals of every width are accepted and kept as the exact strings", () => {
  const worker = loadWorker();
  for (const hash of ["-2147483648", "2147483647", "0", "-1", "7", "-1234567890"]) {
    const request = worker.checkedUpdateSetRequest(check({ records: [Object.assign({}, RECORD, { hash })] }));
    assert.ok(request, hash);
    assert.strictEqual(request.records[0].hash, hash);
  }
});

test("the export goes to the other tab's top frame with the ids and records only", async () => {
  const worker = loadWorker({ answer: async () => okReply() });
  const answer = await worker.checkUpdateSetOnOtherInstance(check(), SENDER);
  assert.strictEqual(answer.ok, true);
  assert.strictEqual(worker.state.sent.length, 1);
  const sent = worker.state.sent[0];
  assert.deepStrictEqual(sent.options, { frameId: 0 });
  assert.deepStrictEqual(Object.keys(sent.message).sort(), ["records", "requestId", "setIds", "type"]);
  assert.strictEqual(sent.message.type, "UPDATE_SET_EXPORT_STATUS");
  assert.deepStrictEqual(plain(sent.message.records), [RECORD]);
});

test("the other tab's progress reaches the asking tab's top frame as Update Set Lens progress", async () => {
  const worker = loadWorker({
    answer: async (tabId, message, w) => {
      w.heartbeat(tabId, message.requestId);
      w.heartbeat(tabId, message.requestId, "Comparing versions… 3 reads");
      return okReply();
    },
  });
  await worker.checkUpdateSetOnOtherInstance(check(), SENDER);
  assert.deepStrictEqual(plain(worker.state.relayed), [
    { tabId: 1, message: { type: "UPDATE_SET_LENS_PROGRESS", message: "Comparing versions… 3 reads" }, options: { frameId: 0 } },
  ]);
  assert.strictEqual(worker.remoteReadByRequest.size, 0);
});

test("the reply is rebuilt from an allowlist: a wrong type refuses it, an unknown field is dropped", () => {
  const worker = loadWorker();
  const request = worker.checkedUpdateSetRequest(check());
  const copy = { set: 0, match: "remote", state: "committed", stateLabel: "Committed", retrievedOn: "1 Oct", committedOn: "2 Oct", collisions: "0" };
  const wrong = [
    okReply({ copies: [Object.assign({}, copy, { set: "0" })] }),
    okReply({ copies: [Object.assign({}, copy, { set: 1 })] }),
    okReply({ copies: [Object.assign({}, copy, { match: "name" })] }),
    okReply({ copies: [Object.assign({}, copy, { state: 5 })] }),
    okReply({ copies: [Object.assign({}, copy, { linked: "yes" })] }),
    okReply({ copies: Array.from({ length: 21 }, () => copy) }),
    okReply({ clones: [3] }),
    okReply({ content: ["runs", "runs"] }),
    okReply({ content: ["maybe"] }),
    okReply({ presenceFailure: { code: "teapot" } }),
    okReply({ contentFailure: { code: "refused", status: "403" } }),
    okReply({ saved: [null, null] }),
    okReply({ saved: "x" }),
    okReply({ content: ["other"], saved: [{ on: 5 }] }),
    okReply({ content: ["other"], saved: ["30 Oct"] }),
    okReply({ content: null, saved: [null] }),
    okReply({ found: [null, null] }),
    okReply({ found: "x" }),
    okReply({ content: null, found: [null] }),
    okReply({ found: ["sys_script_include"] }),
    okReply({ found: [{ table: 5, record: id(2) }] }),
    okReply({ found: [{ table: "Bad Table", record: id(2) }] }),
    okReply({ found: [{ table: "sys_script_include.do?x=", record: id(2) }] }),
    okReply({ found: [{ table: "sys_script_include", record: id(0xabc).toUpperCase() }] }),
    okReply({ found: [{ table: "sys_script_include" }] }),
    okReply({ found: [{ record: id(2) }] }),
    okReply({ found: [{ version: "javascript:alert(1)" }] }),
  ];
  wrong.forEach((reply) => assert.strictEqual(worker.checkedUpdateSetExport(reply, request), null, JSON.stringify(reply).slice(0, 120)));

  const note = worker.checkedUpdateSetExport(okReply({
    content: ["other"],
    saved: [{ on: "30 Oct 2026 12:32", set: "S".repeat(300), from: "", sysId: id(9) }],
  }), request);
  assert.deepStrictEqual(plain(note.saved), [{ on: "30 Oct 2026 12:32", set: "S".repeat(200) }], "cut, emptied and unknown fields gone");
  assert.deepStrictEqual(plain(worker.checkedUpdateSetExport(okReply({ saved: [{ on: "30 Oct", set: "A" }] }), request).saved), [null],
    "a row that runs this set's version carries no note");
  assert.strictEqual(worker.checkedUpdateSetExport(okReply(), request).saved, null);
  assert.deepStrictEqual(plain(worker.checkedUpdateSetExport(okReply({
    found: [{ table: "sys_script_fix", record: id(2), version: id(3), url: "https://elsewhere.example.com/" }],
  }), request).found), [{ table: "sys_script_fix", record: id(2), version: id(3) }], "ids only; a URL never survives");
  assert.deepStrictEqual(plain(worker.checkedUpdateSetExport(okReply({ found: [{ table: "", record: "", version: id(3) }] }), request).found),
    [{ version: id(3) }], "emptied fields are gone");
  assert.deepStrictEqual(plain(worker.checkedUpdateSetExport(okReply({ found: [null] }), request).found), [null]);
  assert.strictEqual(worker.checkedUpdateSetExport(okReply(), request).found, null);

  const checked = worker.checkedUpdateSetExport(okReply({
    copies: [Object.assign({}, copy, { name: "Some set", sysId: id(9), linked: true })],
    extra: "dropped",
  }), request);
  assert.ok(checked);
  assert.deepStrictEqual(plain(checked.copies), [Object.assign({}, copy, { linked: true })]);
  assert.ok(!("extra" in checked));

  const huge = okReply({ copies: [Object.assign({}, copy, { stateLabel: "x".repeat(300 * 1024) })] });
  assert.strictEqual(worker.checkedUpdateSetExport(huge, request), null, "over 256 KiB");
  const many = worker.checkedUpdateSetRequest(check({ setIds: Array.from({ length: 11 }, (_, index) => id(index + 1)) }));
  const tooMany = okReply({ copies: Array.from({ length: 201 }, (_, index) => Object.assign({}, copy, { set: index % 11 })) });
  assert.strictEqual(worker.checkedUpdateSetExport(tooMany, many), null, "over 200 copies");
});

test("status codes: not open, asleep, signed out, busy, switching, changed under the read", async () => {
  assert.strictEqual((await loadWorker({ tabs: [] }).checkUpdateSetOnOtherInstance(check(), SENDER)).code, "not-open");
  assert.strictEqual((await loadWorker({ tabs: [otherTab({ discarded: true })] }).checkUpdateSetOnOtherInstance(check(), SENDER)).code, "asleep");
  const signedOut = loadWorker({ answer: async () => ({ ok: false, error: { code: "signed-out", status: 401 } }) });
  assert.strictEqual((await signedOut.checkUpdateSetOnOtherInstance(check(), SENDER)).code, "signed-out");
  const switching = loadWorker({ swaps: new Map([[9, { origin: THERE }]]), answer: async () => okReply() });
  assert.strictEqual((await switching.checkUpdateSetOnOtherInstance(check(), SENDER)).code, "switching");
  assert.deepStrictEqual(switching.state.sent, []);
  const changed = loadWorker({
    answer: (tabId, message, w) => {
      w.heartbeat(tabId, message.requestId);
      return Promise.reject(new Error("The message port closed before a response was received."));
    },
  });
  assert.strictEqual((await changed.checkUpdateSetOnOtherInstance(check(), SENDER)).code, "source-changed");
  const deaf = loadWorker({ tabs: [otherTab({ id: 21 }), otherTab({ id: 22 })] });
  assert.strictEqual((await deaf.checkUpdateSetOnOtherInstance(check(), SENDER)).code, "no-receiver");

  let release;
  const busy = loadWorker({
    answer: (tabId, message, w) => {
      w.heartbeat(tabId, message.requestId);
      return new Promise((resolve) => { release = () => resolve(okReply()); });
    },
  });
  const first = busy.checkUpdateSetOnOtherInstance(check(), SENDER);
  await tick(5);
  assert.strictEqual((await busy.checkUpdateSetOnOtherInstance(check(), SENDER)).code, "busy");
  release();
  assert.strictEqual((await first).ok, true);
  assert.strictEqual(busy.state.running.size, 0, "released once it settles");
});

test("a link there opens only a URL the worker builds, and only on an instance open in a tab here", async () => {
  const open = (extra) => Object.assign({ type: "UPDATE_SET_REMOTE_OPEN", origin: THERE }, extra);
  const worker = loadWorker();
  const placed = Object.assign({}, SENDER, { tab: Object.assign({}, SENDER.tab, { windowId: 4, index: 2 }) });
  assert.deepStrictEqual(await worker.openOnOtherInstance(open({ table: "sys_script_fix", sysId: id(5) }), placed), { ok: true });
  assert.deepStrictEqual(await worker.openOnOtherInstance(open({ table: "sys_update_version", sysId: id(6) }), placed), { ok: true });
  assert.deepStrictEqual(await worker.openOnOtherInstance(open({ name: RECORD.name }), placed), { ok: true });
  assert.deepStrictEqual(plain(worker.state.created), [
    { url: THERE + "/sys_script_fix.do?sys_id=" + id(5), active: true, windowId: 4, index: 3, openerTabId: 1 },
    { url: THERE + "/sys_update_version.do?sys_id=" + id(6), active: true, windowId: 4, index: 3, openerTabId: 1 },
    {
      url: THERE + "/sys_update_version_list.do?sysparm_query=" + encodeURIComponent("name=" + RECORD.name + "^ORDERBYDESCsys_recorded_at"),
      active: true, windowId: 4, index: 3, openerTabId: 1,
    },
  ]);

  const refused = loadWorker();
  const refusals = [
    open({ origin: HERE, table: "sys_script_fix", sysId: id(5) }),
    open({ origin: "https://example.com", table: "sys_script_fix", sysId: id(5) }),
    open({ origin: THERE + "/", table: "sys_script_fix", sysId: id(5) }),
    open({ origin: "http://exampletest.service-now.com", table: "sys_script_fix", sysId: id(5) }),
    open({ table: "sys_script_fix.do?sys_id=x&", sysId: id(5) }),
    open({ table: "../sys_user", sysId: id(5) }),
    open({ table: "Sys_Script", sysId: id(5) }),
    open({ table: "sys_script_fix", sysId: "javascript:alert(1)" }),
    open({ table: "sys_script_fix", sysId: id(0xabc).toUpperCase() }),
    open({ table: "sys_script_fix" }),
    open({ name: "a^b" }),
    open({ name: RECORD.name, table: "sys_script_fix", sysId: id(5) }),
    open({ url: THERE + "/sys_user_list.do" }),
    open({ table: "sys_script_fix", sysId: id(5), query: "active=true" }),
  ];
  for (const msg of refusals) {
    assert.deepStrictEqual(await refused.openOnOtherInstance(msg, SENDER), { ok: false, code: "invalid" }, JSON.stringify(msg));
  }
  const subFrame = Object.assign({}, SENDER, { frameId: 3 });
  assert.strictEqual((await refused.openOnOtherInstance(open({ table: "sys_script_fix", sysId: id(5) }), subFrame)).code, "invalid");
  const offInstance = { tab: { id: 1, url: "https://example.com/", incognito: false }, frameId: 0, origin: "https://example.com" };
  assert.strictEqual((await refused.openOnOtherInstance(open({ table: "sys_script_fix", sysId: id(5) }), offInstance)).code, "invalid");
  assert.deepStrictEqual(refused.state.created, []);

  /* Closed since the check, or only open in the other kind of window. */
  for (const tabs of [[], [otherTab({ incognito: true })]]) {
    const gone = loadWorker({ tabs });
    assert.deepStrictEqual(await gone.openOnOtherInstance(open({ table: "sys_script_fix", sysId: id(5) }), SENDER),
      { ok: false, code: "not-open" });
    assert.deepStrictEqual(gone.state.created, []);
  }

  const route = stripComments(between(backgroundSource, 'if (msg && msg.type === "UPDATE_SET_REMOTE_OPEN"', "return true;"));
  assert.match(route, /openOnOtherInstance\(msg, sender\)/);
});

test("the impersonation state is read only after an access answer", async () => {
  const refused = loadWorker({ impersonating: true, answer: async () => okReply({ presenceFailure: { code: "refused", status: 403 } }) });
  const answer = await refused.checkUpdateSetOnOtherInstance(check(), SENDER);
  assert.strictEqual(answer.sourceImpersonating, true);
  assert.deepStrictEqual(refused.state.impersonationReads, [{ tabId: 20, origin: THERE }]);
  const fine = loadWorker({ answer: async () => okReply() });
  await fine.checkUpdateSetOnOtherInstance(check(), SENDER);
  assert.deepStrictEqual(fine.state.impersonationReads, []);
});

test("the routes: the check takes the whole message, the read passes options through under a timeout", () => {
  const checkRoute = stripComments(between(backgroundSource,
    'if (msg && msg.type === "UPDATE_SET_REMOTE_CHECK"', "return true;"));
  assert.match(checkRoute, /checkUpdateSetOnOtherInstance\(msg, sender\)/);
  const readRoute = stripComments(between(backgroundSource,
    'if (msg && msg.type === "SN_UPDATE_SET_LENS_GET"', "return true;"));
  assert.match(readRoute, /updateSetLensTableGet\(sender\.tab\.id/);
  assert.match(readRoute, /options: msg\.options \|\| \{\}/);
  const getter = between(backgroundSource, "function updateSetLensTableGet(", "\n}\n");
  assert.match(getter, /withTimeout\(\s*tokenFrameGet\(tabId, tableApiGetInPage, request, request\.table\),\s*PAGE_READ_TIMEOUT_MS/);
  assert.ok(!/SN_TABLE_GET|readFromPageFrames/.test(getter), "never the fan-out route");
  const updated = stripComments(between(backgroundSource, "chrome.tabs.onUpdated.addListener(", "\n});"));
  const removed = stripComments(between(backgroundSource, "chrome.tabs.onRemoved.addListener(", "\n});"));
  assert.ok(updated.includes("updateSetRemoteByTab.delete(tabId)"), "a navigation releases the check");
  assert.ok(removed.includes("updateSetRemoteByTab.delete(tabId)"), "a closed tab releases the check");
  assert.ok(!/PREFILL_SWAP|stopImpersonation|runImpersonation/.test(
    between(backgroundSource, "const UPDATE_SET_REMOTE_MAX_SETS", "// Content scripts can't call chrome.tabs.create")
  ), "the check never switches anyone's session");
});

test("injection, packaging and the manifest", () => {
  const inject = between(backgroundSource, 'if (msg && msg.type === "INJECT_UPDATE_SET_LENS"', "return true;");
  assert.match(inject, /files: \["update_set_lens\.js", "update_set_lens_ui\.js"\]/);
  assert.match(inject, /frameIds: \[sender\.frameId \|\| 0\]/);
  assert.match(packageSource, /"update_set_lens\.js",\s*"update_set_lens_ui\.js",/);
  const listed = JSON.stringify(manifest);
  assert.ok(!listed.includes("update_set_lens"), "lazily injected, never a manifest content script");
});

/* ------------------------------------------------------------------ *
 * The shared reader's withTotal
 * ------------------------------------------------------------------ */

function loadReader(page) {
  const reader = new Function(
    "location", "g_ck", "fetch",
    between(backgroundSource, "async function tableApiGetInPage(", "async function codeSearchApiGetInPage(") +
      "\nreturn tableApiGetInPage;"
  )(
    { origin: HERE },
    "tok",
    async () => ({
      ok: true,
      status: 200,
      headers: page.headers === false ? undefined : { get: (name) => (name === "X-Total-Count" ? page.total : null) },
      json: async () => ({ result: [{ sys_id: "a" }] }),
    })
  );
  return reader;
}

test("withTotal returns X-Total-Count as a number, null when missing; other callers get what they always got", async () => {
  const request = { table: "sys_update_xml", query: "update_set=" + id(1), fields: "sys_id", limit: 1 };
  assert.deepStrictEqual(await loadReader({ total: "724" })(Object.assign({ options: { withTotal: true } }, request)),
    { ok: true, result: [{ sys_id: "a" }], total: 724 });
  assert.strictEqual((await loadReader({ total: null })(Object.assign({ options: { withTotal: true } }, request))).total, null);
  assert.strictEqual((await loadReader({ total: "lots" })(Object.assign({ options: { withTotal: true } }, request))).total, null);
  assert.strictEqual((await loadReader({ headers: false })(Object.assign({ options: { withTotal: true } }, request))).total, null);
  assert.deepStrictEqual(await loadReader({ total: "724" })(Object.assign({ options: {} }, request)),
    { ok: true, result: [{ sys_id: "a" }] }, "byte-identical without the option");
});

/* ------------------------------------------------------------------ *
 * The exporter, in a tab of the other instance
 * ------------------------------------------------------------------ */

const LABEL = { committed: "Committed", previewed: "Previewed", complete: "Complete", current: "Current" };

function loadExporter(data, options) {
  const opts = options || {};
  const sent = [];
  const tables = {
    sys_remote_update_set: data.remote || [],
    sys_update_set: data.sets || [],
    sys_update_version: data.versions || [],
    sys_metadata: data.metadata || [],
  };
  const evaluate = (row, part) => {
    const match = part.match(/^([a-z_]+?)(IN|=)(.*)$/);
    const value = String(row[match[1]] || "");
    return match[2] === "IN" ? match[3].split(",").includes(value) : value === match[3];
  };
  const answer = async (msg) => {
    if (msg.type !== "SN_UPDATE_SET_LENS_GET") return undefined;
    if (opts.slowMs) await tick(opts.slowMs);
    if (opts.fail) {
      const failure = opts.fail(msg);
      if (failure) return failure;
    }
    const parts = msg.query.split("^").filter((part) => !part.startsWith("ORDERBY"));
    const newestFirst = msg.query.split("^").filter((part) => part.startsWith("ORDERBYDESC")).map((part) => part.slice(11));
    let rows = (tables[msg.table] || []).filter((row) => parts.every((part) => evaluate(row, part)));
    newestFirst.forEach((field) => { rows = rows.slice().sort((a, b) => String(b[field] || "").localeCompare(String(a[field] || ""))); });
    rows = rows.slice(0, msg.limit);
    const fields = msg.fields.split(",");
    return {
      ok: true,
      result: rows.map((row) => Object.fromEntries(fields.map((field) => {
        const value = row[field] == null ? "" : String(row[field]);
        const shown = row.display && row.display[field] != null ? row.display[field] : field === "state" ? LABEL[value] || value : value;
        return [field, msg.options.displayAll ? { value, display_value: shown } : value];
      }))),
    };
  };
  const chrome = {
    runtime: {
      id: "glidelens",
      sendMessage: (msg) => {
        sent.push(plain(msg));
        return Promise.resolve(answer(msg));
      },
    },
  };
  const limit = "const UPDATE_SET_EXPORT_LINKS_BY_MS = 120 * 1000;";
  const source = between(contentSource, "const UPDATE_SET_EXPORT_PROGRESS_MS",
    "/* =====================================================================\n * IMPERSONATE");
  assert.ok(source.includes(limit), "the links time limit is where the suite expects it");
  const block = opts.linksByMs == null ? source : source.replace(limit, "const UPDATE_SET_EXPORT_LINKS_BY_MS = " + opts.linksByMs + ";");
  const api = new Function("chrome", "location", block + "\nreturn { exportUpdateSetStatus, updateSetExportStatus };")(
    chrome, { origin: THERE }
  );
  return Object.assign(api, { sent });
}

function remoteRow(n, extra) {
  return Object.assign({
    sys_id: id(400 + n), name: "Copy " + n, state: "previewed", remote_sys_id: id(1), origin_sys_id: id(1),
    update_set: "", update_source: "", commit_date: "", collisions: "0", sys_created_on: "2026-10-2" + n + " 10:00:00",
  }, extra);
}

const NAMES = [1, 2, 3, 4, 5, 6].map((n) => "sys_script_include_" + id(70 + n));
function exportData() {
  return {
    remote: [
      remoteRow(1, { state: "committed", update_set: id(600), commit_date: "2026-10-22 11:00:00" }),
      remoteRow(2, { state: "previewed" }),
      remoteRow(3, { remote_sys_id: id(999), origin_sys_id: id(2), state: "loaded" }),
      remoteRow(4, { remote_sys_id: id(998), origin_sys_id: id(998), state: "committed", update_set: "undefined" }),
    ],
    sets: [
      { sys_id: id(600), state: "complete", remote_sys_id: id(401) },
      { sys_id: id(3), state: "complete", remote_sys_id: "" },
    ],
    versions: [
      { sys_id: id(800), name: NAMES[0], state: "current", update_guid: guid(1), payload_hash: "-1", source: id(700),
        source_table: "sys_update_set", sys_created_on: "2026-10-30 12:24:41", display: { source: "Update Set: The set itself" } },
      { sys_id: id(801), name: NAMES[1], state: "current", update_guid: guid(9), payload_hash: "2", source: id(701),
        source_table: "sys_update_set", sys_created_on: "2026-10-30 12:32:27",
        display: { source: "Update Set: Fixes: phase 2", sys_created_on: "30-10-2026 12:32:27" } },
      { sys_id: id(802), name: NAMES[2], state: "current", update_guid: guid(9), payload_hash: "99", source: id(702),
        source_table: "sys_upgrade_history", sys_created_on: "2026-10-01 08:00:00",
        display: { source: "Upgrade History: an upgrade", sys_created_on: "01-10-2026 08:00:00" } },
      { name: NAMES[3], state: "current", update_guid: guid(4), payload_hash: "99" },
      /* NAMES[4]: no current version there. NAMES[5]: two. */
      { sys_id: id(805), name: NAMES[5], state: "current", update_guid: guid(6), payload_hash: "6" },
      { sys_id: id(806), name: NAMES[5], state: "current", update_guid: guid(6), payload_hash: "6" },
    ],
    /* NAMES[0] twice: the latest updated is the record. NAMES[2]'s class
     * fails its pattern; NAMES[4] is there with no version history. */
    metadata: [
      { sys_id: id(900), sys_class_name: "sys_script_include", sys_update_name: NAMES[0], sys_updated_on: "2026-10-01 10:00:00" },
      { sys_id: id(901), sys_class_name: "sys_script_include", sys_update_name: NAMES[0], sys_updated_on: "2026-10-30 12:24:41" },
      { sys_id: id(902), sys_class_name: "sys_script_include", sys_update_name: NAMES[1], sys_updated_on: "2026-10-30 12:32:27" },
      { sys_id: id(903), sys_class_name: "Bad Class", sys_update_name: NAMES[2], sys_updated_on: "2026-10-30 12:32:27" },
      { sys_id: id(904), sys_class_name: "sys_script_include", sys_update_name: NAMES[4], sys_updated_on: "2026-10-30 12:32:27" },
    ],
  };
}

const EXPORT_RECORDS = NAMES.map((name, index) => ({ name, guid: guid(index + 1), hash: index === 0 ? "-1" : String(index + 1) }));

test("the export reads only through the timed route, with this origin and a token, and names nothing back", async () => {
  const exporter = loadExporter(exportData());
  const reply = await exporter.exportUpdateSetStatus({
    requestId: "r1",
    setIds: [id(1), id(2), id(3)],
    records: EXPORT_RECORDS,
  });
  assert.strictEqual(reply.ok, true);
  const reads = exporter.sent.filter((msg) => msg.type !== "REMOTE_READ_PROGRESS");
  assert.ok(reads.length >= 5);
  reads.forEach((read) => {
    assert.strictEqual(read.type, "SN_UPDATE_SET_LENS_GET", "never snGetMany's SN_TABLE_GET");
    assert.strictEqual(read.options.expectedOrigin, THERE);
    assert.strictEqual(read.options.requireToken, true);
  });
  assert.ok(reads.every((read) => !/undefined/.test(read.query)), "an invalid update_set never reaches a query");
  const text = JSON.stringify(reply);
  NAMES.forEach((name) => assert.ok(!text.includes(name), "names are never echoed back"));

  assert.deepStrictEqual(plain(reply.content), ["runs", "same", "other", "conflict", "none", "unknown"]);
  assert.ok(reads.filter((read) => read.table === "sys_update_version").every((read) => read.options.displayAll === true));
  assert.deepStrictEqual(plain(reply.saved), [
    null,
    { on: "30-10-2026 12:32:27", set: "Fixes: phase 2" },
    { on: "01-10-2026 08:00:00", from: "Upgrade History: an upgrade" },
    null,
    null,
    null,
  ], "only a row that differs says where its version was saved; a set keeps its whole name");
  assert.deepStrictEqual(plain(reply.found), [
    { table: "sys_script_include", record: id(901), version: id(800) },
    { table: "sys_script_include", record: id(902), version: id(801) },
    { version: id(802) },
    null,
    { table: "sys_script_include", record: id(904) },
    null,
  ], "each row's ids: the latest-updated record, and the version only when exactly one runs there");
  const lookups = reads.filter((read) => read.table === "sys_metadata");
  assert.strictEqual(lookups.length, 1);
  assert.match(lookups[0].query, /^sys_update_nameIN[^^]+\^ORDERBYDESCsys_updated_on$/);
  assert.strictEqual(lookups[0].fields, "sys_id,sys_class_name,sys_update_name");
  assert.strictEqual(lookups[0].options.displayAll, false);
  const bySet = (index) => reply.copies.filter((copy) => copy.set === index);
  assert.deepStrictEqual(bySet(0).map((copy) => copy.state).sort(), ["committed", "previewed"]);
  const committed = bySet(0).find((copy) => copy.state === "committed");
  assert.strictEqual(committed.localState, "complete");
  assert.strictEqual(committed.linked, true, "its local set points back");
  assert.deepStrictEqual(bySet(1).map((copy) => copy.match), ["origin"]);
  assert.deepStrictEqual(plain(reply.clones), [2], "the same id as a set there");
  assert.strictEqual(reply.presenceFailure, null);
});

test("the export beats before its first read and after reads, without snGetMany's listeners", async () => {
  const exporter = loadExporter(exportData(), { slowMs: 300 });
  await exporter.exportUpdateSetStatus({ requestId: "r2", setIds: [id(1)], records: EXPORT_RECORDS.slice(0, 1) });
  assert.strictEqual(exporter.sent[0].type, "REMOTE_READ_PROGRESS");
  assert.strictEqual(exporter.sent[0].requestId, "r2");
  const beats = exporter.sent.filter((msg) => msg.type === "REMOTE_READ_PROGRESS");
  assert.ok(beats.length >= 3, "a beat after reads, not only the first");
  const block = between(contentSource, "const UPDATE_SET_EXPORT_PROGRESS_MS", "/* =====================================================================\n * IMPERSONATE");
  assert.ok(!/snGetMany|SN_TABLE_GET/.test(stripComments(block)));
});

test("a 401 is signed out; a refused presence read still compares content; every version read refused is a content failure", async () => {
  const signedOut = loadExporter(exportData(), { fail: () => ({ ok: false, status: 401, error: "HTTP 401" }) });
  assert.deepStrictEqual(plain(await signedOut.exportUpdateSetStatus({ requestId: "r", setIds: [id(1)], records: [] })),
    { ok: false, error: { code: "signed-out", status: 401, message: "Not signed in" } });

  const presence = loadExporter(exportData(), {
    fail: (msg) => (msg.table === "sys_remote_update_set" ? { ok: false, status: 403, error: "HTTP 403" } : null),
  });
  const partial = await presence.exportUpdateSetStatus({ requestId: "r", setIds: [id(1)], records: EXPORT_RECORDS });
  assert.deepStrictEqual(plain(partial.presenceFailure), { code: "refused", status: 403 });
  assert.strictEqual(partial.content.length, EXPORT_RECORDS.length);

  const versions = loadExporter(exportData(), {
    fail: (msg) => (msg.table === "sys_update_version" ? { ok: false, status: 403, error: "HTTP 403" } : null),
  });
  const noContent = await versions.exportUpdateSetStatus({ requestId: "r", setIds: [id(1)], records: EXPORT_RECORDS });
  assert.strictEqual(noContent.content, null);
  assert.deepStrictEqual(plain(noContent.contentFailure), { code: "refused", status: 403 });
  assert.strictEqual(noContent.found, null, "nothing compared, nothing to link");
  assert.ok(!versions.sent.some((msg) => msg.table === "sys_metadata"), "and no record lookup");

  const lookups = loadExporter(exportData(), {
    fail: (msg) => (msg.table === "sys_metadata" ? { ok: false, status: 403, error: "HTTP 403" } : null),
  });
  const noRecords = await lookups.exportUpdateSetStatus({ requestId: "r", setIds: [id(1)], records: EXPORT_RECORDS });
  assert.deepStrictEqual(plain(noRecords.content), ["runs", "same", "other", "conflict", "none", "unknown"],
    "a refused record lookup costs only the record links");
  assert.strictEqual(noRecords.contentFailure, null);
  assert.deepStrictEqual(plain(noRecords.found), [{ version: id(800) }, { version: id(801) }, { version: id(802) }, null, null, null]);

  /* Past the time limit the record lookup is never started: the statuses
   * reach the worker inside its ceiling, and only the record links go. */
  const late = loadExporter(exportData(), { linksByMs: 0 });
  const unlinked = await late.exportUpdateSetStatus({ requestId: "r", setIds: [id(1)], records: EXPORT_RECORDS });
  assert.deepStrictEqual(plain(unlinked.content), ["runs", "same", "other", "conflict", "none", "unknown"]);
  assert.ok(!late.sent.some((msg) => msg.table === "sys_metadata"));
  assert.deepStrictEqual(plain(unlinked.found), [{ version: id(800) }, { version: id(801) }, { version: id(802) }, null, null, null]);
});

test("content reads hold at most 40 names, and a record that fails its pattern is never queried", async () => {
  const names = Array.from({ length: 95 }, (_, index) => "sys_script_include_" + id(1000 + index));
  const records = names.map((name, index) => ({ name, guid: guid(index + 1), hash: String(index) }))
    .concat([{ name: "bad,name", guid: guid(1), hash: "1" }]);
  const exporter = loadExporter({ versions: [] });
  const reply = await exporter.exportUpdateSetStatus({ requestId: "r", setIds: [id(1)], records });
  const reads = exporter.sent.filter((msg) => msg.table === "sys_update_version");
  assert.ok(reads.every((read) => read.query.replace(/^state=current\^name(IN|=)/, "").split(",").length <= 40));
  assert.ok(reads.every((read) => !read.query.includes("bad,name")));
  const lookups = exporter.sent.filter((msg) => msg.table === "sys_metadata");
  assert.strictEqual(lookups.length, 3);
  assert.ok(lookups.every((read) =>
    read.query.replace(/^sys_update_name(IN|=)/, "").replace(/\^ORDERBYDESCsys_updated_on$/, "").split(",").length <= 40));
  assert.ok(lookups.every((read) => !read.query.includes("bad,name")));
  assert.strictEqual(reply.content[95], "unknown");
  assert.ok(reply.content.slice(0, 95).every((status) => status === "none"));
});

test("where-saved notes and link ids stop at their budgets, so 2,000 differing rows still pass the worker's reply cap", async () => {
  const names = Array.from({ length: 2000 }, (_, index) => "sys_script_include_" + id(3000 + index));
  const exporter = loadExporter({
    versions: names.map((name, index) => ({
      sys_id: id(5000 + index), name, state: "current", update_guid: guid(2), payload_hash: "2", source: id(700),
      source_table: "sys_update_set", sys_created_on: "2026-10-30 12:32:27", display: { source: "Update Set: " + "S".repeat(300) },
    })),
    metadata: names.map((name, index) => ({
      sys_id: id(7000 + index), sys_class_name: "x_" + "a".repeat(78), sys_update_name: name, sys_updated_on: "2026-10-30 12:32:27",
    })),
  });
  const records = names.map((name) => ({ name, guid: guid(1), hash: "1" }));
  const reply = await exporter.exportUpdateSetStatus({ requestId: "r", setIds: [id(1)], records });
  assert.ok(reply.content.every((status) => status === "other"), "every status stands");
  assert.strictEqual(reply.saved[0].set.length, 200, "a set name is cut at 200");
  assert.strictEqual(reply.saved[1999], null, "past the budget a row loses only its note");
  assert.ok(JSON.stringify(reply.saved).length < 80 * 1024);
  assert.deepStrictEqual(plain(reply.found[0]), { table: "x_" + "a".repeat(78), record: id(7000), version: id(5000) });
  assert.strictEqual(reply.found[1999], null, "past the budget a row loses only its links");
  assert.ok(JSON.stringify(reply.found).length < 80 * 1024);
  const worker = loadWorker();
  const checked = worker.checkedUpdateSetExport(reply, worker.checkedUpdateSetRequest(check({ records })));
  assert.ok(checked, "under the 256 KiB cap");
  assert.strictEqual(checked.saved.length, 2000);
  assert.strictEqual(checked.found.length, 2000);
});

test("the content-script listener answers the export only for the extension, from the top frame", () => {
  const listener = between(contentSource, 'if (msg && msg.type === "UPDATE_SET_EXPORT_STATUS")', "return true;");
  assert.match(listener, /window !== window\.top \|\| !sender \|\| sender\.tab \|\| sender\.id !== chrome\.runtime\.id/);
  assert.match(listener, /exportUpdateSetStatus\(msg\)/);
});

test("a remote verdict needs guid and hash together, and makes no newer or older claim", () => {
  const exporter = loadExporter({});
  const record = { name: "x", guid: guid(1), hash: "5" };
  assert.strictEqual(exporter.updateSetExportStatus(record, [{ guid: guid(1), hash: "5" }]), "runs");
  assert.strictEqual(exporter.updateSetExportStatus(record, [{ guid: guid(1), hash: "6" }]), "conflict");
  assert.strictEqual(exporter.updateSetExportStatus(record, [{ guid: guid(2), hash: "5" }]), "same");
  assert.strictEqual(exporter.updateSetExportStatus(record, [{ guid: guid(2), hash: "6" }]), "other");
  assert.strictEqual(exporter.updateSetExportStatus(record, []), "none");
  assert.strictEqual(exporter.updateSetExportStatus(record, [{ guid: "", hash: "5" }]), "unknown");
});

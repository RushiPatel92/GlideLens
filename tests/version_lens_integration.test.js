/*
 * Version Lens: the runtime boundary.
 *
 *   node --test tests/version_lens_integration.test.js
 *
 * DEV-ONLY, like its siblings. The worker's injection route and its Check on
 * request check, the content script's Version Lens section and the shared
 * check slot, and the Update Set Lens exporter answering a record-centric
 * request -- each lifted from its file by anchors, the way the Update Set
 * Lens suite does it, so moving one fails loudly instead of testing nothing.
 * Plus what step 1 promised to leave alone: the Update Set Lens export
 * surface, classifyRows' rows and normalizeSet.
 *
 * Synthetic data only.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { plain, id, guid, fakeInstance, setRow, xmlRow, versionRow } = require("./update_set_sim.js");

const root = path.join(__dirname, "..");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8").replace(/\r\n/g, "\n");
const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8").replace(/\r\n/g, "\n");
const packageSource = fs.readFileSync(path.join(root, "package.mjs"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const USL_SOURCE = fs.readFileSync(path.join(root, "update_set_lens.js"), "utf8");
const ENGINE_SOURCE = fs.readFileSync(path.join(root, "version_lens.js"), "utf8");

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
const NAME = "sys_script_include_" + id(77);
const SECTION_START = "/* =====================================================================\n * VERSION LENS";
const SECTION_END = "/* =====================================================================\n * CODE SEARCH";
const SECTION = between(contentSource, SECTION_START, SECTION_END);

function loadEngines() {
  const sandbox = { URL, URLSearchParams, Promise, console, encodeURIComponent, decodeURIComponent };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(USL_SOURCE, sandbox, { filename: "update_set_lens.js" });
  vm.runInContext(ENGINE_SOURCE, sandbox, { filename: "version_lens.js" });
  return sandbox;
}

/* ------------------------------------------------------------------ *
 * 57. Injection, packaging and the manifest
 * ------------------------------------------------------------------ */

test("57: INJECT_VERSION_LENS injects the three files in order into the asking frame; packaged, never a manifest script", () => {
  const inject = between(backgroundSource, 'if (msg && msg.type === "INJECT_VERSION_LENS"', "return true;");
  assert.match(inject, /files: \["update_set_lens\.js", "version_lens\.js", "version_lens_ui\.js"\]/);
  assert.match(inject, /frameIds: \[sender\.frameId \|\| 0\]/);
  assert.match(inject, /&& sender\.tab\)/);
  assert.match(packageSource, /"update_set_lens\.js",\s*"update_set_lens_ui\.js",\s*"version_lens\.js",\s*"version_lens_ui\.js",/);
  assert.ok(!JSON.stringify(manifest).includes("version_lens"), "lazily injected, never a manifest content script");

  /* Each file no-ops when already present, and the engine waits for its reader. */
  const sandbox = { URL, URLSearchParams, Promise, console, encodeURIComponent, decodeURIComponent };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ENGINE_SOURCE, sandbox);
  assert.strictEqual(sandbox.SNVersionLens, undefined, "without update_set_lens.js it leaves its global unset");
  vm.runInContext(USL_SOURCE, sandbox);
  vm.runInContext(ENGINE_SOURCE, sandbox);
  const first = sandbox.SNVersionLens;
  vm.runInContext(ENGINE_SOURCE, sandbox);
  assert.strictEqual(sandbox.SNVersionLens, first);
});

/* ------------------------------------------------------------------ *
 * 58. Step 1 changed nothing Update Set Lens relies on
 * ------------------------------------------------------------------ */

test("58: the Update Set Lens export surface is a superset; classifyRows adds only `current`; normalizeSet only completedOn", async () => {
  const { SNUpdateSetLens: usl } = loadEngines();
  const shipped = [
    "LIMITS", "REMOTE_NAME", "REMOTE_GUID", "REMOTE_HASH", "VERDICT_ORDER", "CANT_TELL", "isListRoute", "nameQueryKind",
    "readUrlLength", "chunkForUrl", "normalizeSet", "normalizeRetrieved", "resolveUpdateSetInput", "pageUpdateSet",
    "firstPass", "appliedGuard", "classifyRows", "recordUrl", "walkBatch", "createSession", "remoteRequest", "remoteView",
    "remoteProblem", "retrievedScreen",
  ];
  const shared = [
    "TABLE_NAME", "NAMED_RECORD", "SET_FIELDS", "MEMBER_FIELDS", "VERSION_FIELDS", "readTable", "raw", "shown", "isSysId",
    "foldName", "decodedVariants", "inClause", "linkIn", "normalizeVersion", "normalizeMember", "readCurrentVersions",
    "readSetsById", "staleText", "lowerFirst", "presenceWords", "savedWords", "bestCopy", "remoteLinks",
    "presenceFailureText", "contentFailureText",
  ];
  shipped.concat(shared).forEach((name) => assert.ok(usl[name] !== undefined, name));

  const before = ["sysId", "name", "state", "stateLabel", "isDefault", "scope", "parent", "parentName", "base", "mergedTo",
    "mergedToName", "remoteSysId", "originSysId", "createdBy", "createdOn", "updatedOn", "updatedOnRaw"];
  assert.deepStrictEqual(Object.keys(usl.normalizeSet(setRow(1, { completed_on: "2026-10-03 10:00:00" }))), before.concat(["completedOn"]));
  assert.ok(usl.SET_FIELDS.split(",").includes("completed_on"));

  /* The rows themselves, pinned field by field, and one more key beside them. */
  const SET = id(1);
  const instance = fakeInstance({
    sets: [setRow(1), setRow(2, { name: "Newer", state: "in progress" })],
    versions: [
      versionRow(NAME, id(2), "current", guid(2), "2", "2026-10-05 10:00:00"),
      versionRow(NAME, SET, "previous", guid(1), "1", "2026-10-01 10:00:00"),
    ],
  });
  const member = Object.assign(usl.normalizeMember(xmlRow(SET, NAME, guid(1), "1"), SET, false), { key: "k1" });
  const result = await usl.classifyRows([member], { origin: HERE, transport: instance.transport }, { sets: new Map() });
  assert.deepStrictEqual(Object.keys(result), ["rows", "versionsRefused", "current"]);
  assert.deepStrictEqual(Object.keys(result.current), ["byName", "failed", "saturated"]);
  const row = plain(result.rows[0]);
  assert.deepStrictEqual(Object.keys(row), ["key", "sysId", "name", "type", "target", "action", "setId", "verdict", "reason",
    "text", "flags", "who", "notes", "links", "asRetrieved", "newerSetId", "newerSetName", "newerSetState", "guid", "hash"]);
  assert.strictEqual(row.verdict, "stale");
  assert.strictEqual(row.text, "Newer version in “Newer”");
  assert.strictEqual(row.newerSetState, "In progress");
  assert.strictEqual(result.versionsRefused, false);
});

/* ------------------------------------------------------------------ *
 * 59. The pagination header: opt-in in the reader, always on for this
 * feature's reads
 * ------------------------------------------------------------------ */

function loadReader(urls) {
  return new Function(
    "location", "g_ck", "fetch",
    between(backgroundSource, "async function tableApiGetInPage(", "async function codeSearchApiGetInPage(") +
      "\nreturn tableApiGetInPage;"
  )({ origin: HERE }, "tok", async (url) => {
    urls.push(url);
    return { ok: true, status: 200, headers: { get: () => "3" }, json: async () => ({ result: [] }) };
  });
}

test("59: suppressPagination reaches the URL only when asked; every Version Lens read asks; the exporter's reads still do", async () => {
  const urls = [];
  const request = { table: "sys_update_xml", query: "name=" + NAME + "^category=customer", fields: "sys_id", limit: 201 };
  await loadReader(urls)(Object.assign({ options: { withTotal: true, suppressPagination: true } }, request));
  await loadReader(urls)(Object.assign({ options: { withTotal: true } }, request));
  assert.strictEqual(new URL(urls[0]).searchParams.get("sysparm_suppress_pagination_header"), "true");
  assert.strictEqual(urls[0].replace("&sysparm_suppress_pagination_header=true", ""), urls[1], "byte-identical otherwise");

  const sandbox = loadEngines();
  const instance = fakeInstance({
    metadata: [{ sys_id: id(77), sys_class_name: "sys_script_include", sys_update_name: NAME, sys_name: "x", sys_scope: "global" }],
    sets: [setRow(1, { state: "in progress" })],
    xml: [xmlRow(id(1), NAME, guid(1), "1", { sys_updated_by: "dev.one", sys_updated_on: "2026-10-01 10:00:00" })],
    versions: [versionRow(NAME, id(1), "current", guid(1), "1", "2026-10-01 10:00:00")],
  });
  const ctx = { origin: HERE, transport: instance.transport };
  const session = sandbox.SNVersionLens.createSession(await sandbox.SNVersionLens.resolveRecord(id(77), "", ctx), ctx);
  await session.run();
  assert.ok(instance.requests.length >= 4);
  instance.requests.forEach((read) => assert.strictEqual(read.options.suppressPagination, true, read.table + " " + read.query));

  const exporter = between(contentSource, "async function exportUpdateSetStatus(", "\n}\n");
  assert.match(exporter, /suppressPagination: true/);
});

/* ------------------------------------------------------------------ *
 * 60. The check slot the two panels share
 * ------------------------------------------------------------------ */

function loadSlot() {
  const helpers = between(contentSource, "let updateSetCheckPanel = null;", "async function ensureUpdateSetLensLoaded(");
  const branch = between(contentSource, 'if (msg && msg.type === "UPDATE_SET_LENS_PROGRESS") {', "\n    return false;\n  }");
  const win = {};
  win.top = win;
  return new Function("window",
    helpers +
      "\nfunction listener(msg, sendResponse) {\n" + branch + "\n    return false;\n  }\n  return undefined;\n}\n" +
      "return { claimUpdateSetCheckPanel, releaseUpdateSetCheckPanel, listener, slot: () => updateSetCheckPanel };"
  )(win);
}

function fakeUi() {
  const calls = [];
  return { calls, showRemote: (remote, token) => calls.push([plain(remote), token]) };
}

test("60: progress goes to whichever panel started the check; closing one never clears the other's slot, even on equal tokens", () => {
  const slot = loadSlot();
  const setLens = fakeUi();
  const versionLens = fakeUi();
  const relay = (message) => {
    let answer = null;
    slot.listener({ type: "UPDATE_SET_LENS_PROGRESS", message }, (reply) => { answer = reply; });
    return answer;
  };
  assert.deepStrictEqual(relay("nothing running"), { ok: true, shown: false });

  slot.claimUpdateSetCheckPanel("update-set-lens", setLens, 1, 4);
  relay("first");
  slot.claimUpdateSetCheckPanel("version-lens", versionLens, 1, 2);
  assert.deepStrictEqual(relay("second"), { ok: true, shown: true });
  assert.deepStrictEqual(setLens.calls, [[{ state: "busy", message: "first" }, 4]]);
  assert.deepStrictEqual(versionLens.calls, [[{ state: "busy", message: "second" }, 2]]);

  /* Both panels hold token 1: Update Set Lens closing leaves Version Lens's check alone. */
  slot.releaseUpdateSetCheckPanel(setLens, 1);
  assert.strictEqual(slot.slot().ui, versionLens);
  relay("third");
  assert.strictEqual(versionLens.calls.length, 2);
  slot.releaseUpdateSetCheckPanel(versionLens, 2);
  assert.strictEqual(slot.slot().ui, versionLens, "the same ui with another token is another panel");
  slot.releaseUpdateSetCheckPanel(versionLens, 1);
  assert.strictEqual(slot.slot(), null);

  /* Both commands release on close through the same rule, and claim when a check starts. */
  const usl = between(contentSource, "function startUpdateSetLens(", "\n}\n");
  const vl = between(SECTION, "function startVersionLens(", "\n}\n");
  [usl, vl].forEach((source) => assert.match(source, /releaseUpdateSetCheckPanel\(ui, token\)/));
  assert.match(between(contentSource, "async function checkUpdateSetElsewhere(", "\n}\n"),
    /claimUpdateSetCheckPanel\("update-set-lens", ui, panelToken, remoteToken\)/);
  assert.match(between(SECTION, "async function checkVersionsElsewhere(", "\n}\n"),
    /claimUpdateSetCheckPanel\("version-lens", ui, panelToken, remoteToken\)/);
  assert.ok(!/updateSetLensActive/.test(contentSource), "the old single-panel slot is gone");
});

/* ------------------------------------------------------------------ *
 * 61. A record-centric request through the shipped worker and exporter
 * ------------------------------------------------------------------ */

function loadWorker() {
  const block = between(backgroundSource, "const REMOTE_READ_IDLE_MS", "// Content scripts can't call chrome.tabs.create");
  const origins = between(backgroundSource, "const SN_TAB_HOST", "/* Returns a URL rebuilt from its parsed form");
  const tabOptions = between(backgroundSource, "function openUrlTabOptions(", "\n}\n") + "\n}\n";
  return new Function(
    "chrome", "discoverContentFrames", "probeTokenFrame", "readImpersonationState",
    "prefillSwapByTab", "prefillRemoteByTab", "updateSetRemoteByTab", "sendToTab",
    origins + tabOptions + block + "\nreturn { checkedUpdateSetRequest, checkedUpdateSetExport };"
  )({ tabs: {} }, async () => [0], async () => ({}), async () => ({}), new Map(), new Map(), new Map(), () => {});
}

function loadExporter(data) {
  const tables = { sys_remote_update_set: [], sys_update_set: [], sys_update_version: data.versions || [], sys_metadata: [] };
  const evaluate = (row, part) => {
    const match = part.match(/^([a-z_]+?)(IN|=)(.*)$/);
    const value = String(row[match[1]] || "");
    return match[2] === "IN" ? match[3].split(",").includes(value) : value === match[3];
  };
  const chrome = {
    runtime: {
      id: "glidelens",
      sendMessage: async (msg) => {
        if (msg.type !== "SN_UPDATE_SET_LENS_GET") return undefined;
        const parts = msg.query.split("^").filter((part) => !part.startsWith("ORDERBY"));
        const rows = (tables[msg.table] || []).filter((row) => parts.every((part) => evaluate(row, part))).slice(0, msg.limit);
        const fields = msg.fields.split(",");
        return {
          ok: true,
          result: rows.map((row) => Object.fromEntries(fields.map((field) => {
            const value = row[field] == null ? "" : String(row[field]);
            return [field, msg.options.displayAll ? { value, display_value: value } : value];
          }))),
        };
      },
    },
  };
  const source = between(contentSource, "const UPDATE_SET_EXPORT_PROGRESS_MS", "/* =====================================================================\n * IMPERSONATE");
  return new Function("chrome", "location", source + "\nreturn { exportUpdateSetStatus };")(chrome, { origin: THERE });
}

test("61: records that share a name pass the worker's request check, and the exporter answers each by index", async () => {
  const worker = loadWorker();
  const records = [
    { name: NAME, guid: guid(1), hash: "1" },
    { name: NAME, guid: guid(2), hash: "-2147483648" },
    { name: NAME, guid: guid(3), hash: "1" },
    { name: NAME, guid: guid(1), hash: "1" },
  ];
  const message = { type: "UPDATE_SET_REMOTE_CHECK", origin: THERE, setIds: [id(1), id(2), id(3)], records };
  const checked = worker.checkedUpdateSetRequest(message);
  assert.ok(checked, "repeated names are not a reason to refuse");
  assert.deepStrictEqual(plain(checked.records), records);

  const exporter = loadExporter({ versions: [{ sys_id: id(800), name: NAME, state: "current", update_guid: guid(1), payload_hash: "1",
    source: id(700), source_table: "sys_update_set", sys_created_on: "2026-10-30 12:00:00" }] });
  const reply = await exporter.exportUpdateSetStatus({ requestId: "r", setIds: checked.setIds, records: checked.records });
  assert.deepStrictEqual(plain(reply.content), ["runs", "other", "same", "runs"]);
  assert.ok(worker.checkedUpdateSetExport(reply, checked), "and the reply passes the worker's allowlist");
});

/* ------------------------------------------------------------------ *
 * 62. The content-script section
 * ------------------------------------------------------------------ */

function loadSection(deps) {
  const names = Object.keys(deps);
  const body = between(contentSource, "const VERSION_LENS_UI_METHODS", SECTION_END) +
    "\nreturn { checkVersionsElsewhere, startVersionLens, sequence: () => versionLensPanelSequence };";
  return new Function(...names, body)(...names.map((name) => deps[name]));
}

test("62: the section reads only through the shared route, sends the check with its four fields, and sits outside the exporter span", async () => {
  const code = stripComments(SECTION);
  assert.ok(!/SN_TABLE_GET|snGetMany|readFromPageFrames/.test(code), "never the fan-out reads");
  assert.ok(!/\bfetch\(|\bmethod\s*:|POST|PATCH|PUT\b/.test(code), "no write");
  const types = Array.from(code.matchAll(/type: "([A-Z_]+)"/g)).map((match) => match[1]);
  assert.deepStrictEqual(Array.from(new Set(types)).sort(), ["INJECT_VERSION_LENS", "OPEN_URL", "UPDATE_SET_REMOTE_CHECK"]);

  /* Placement: after IMPERSONATE, so the exporter harness's span never holds it. */
  const exporterSpan = between(contentSource, "const UPDATE_SET_EXPORT_PROGRESS_MS", "/* =====================================================================\n * IMPERSONATE");
  assert.ok(!exporterSpan.includes("VERSION LENS"));
  assert.ok(contentSource.indexOf(" * IMPERSONATE") < contentSource.indexOf(" * VERSION LENS"));

  /* The real section, the real engine and the real worker check, end to end. */
  const sandbox = loadEngines();
  const instance = fakeInstance({
    metadata: [{ sys_id: id(77), sys_class_name: "sys_script_include", sys_update_name: NAME, sys_name: "x", sys_scope: "global" }],
    sets: [setRow(1, { state: "in progress", name: "Open 1" }), setRow(2, { state: "in progress", name: "Open 2" }),
      setRow(3, { state: "in progress", is_default: "true", name: "Default" })],
    xml: [
      xmlRow(id(1), NAME, guid(1), "1", { sys_updated_by: "dev.one", sys_updated_on: "2026-10-05 10:00:00" }),
      xmlRow(id(2), NAME, guid(2), "2", { sys_updated_by: "dev.two", sys_updated_on: "2026-10-04 10:00:00" }),
      xmlRow(id(3), NAME, guid(3), "3", { sys_updated_by: "dev.one", sys_updated_on: "2026-10-03 10:00:00" }),
    ],
    versions: [versionRow(NAME, id(1), "current", guid(1), "1", "2026-10-05 10:00:00")],
  });
  const ctx = { origin: HERE, transport: instance.transport };
  const session = sandbox.SNVersionLens.createSession(await sandbox.SNVersionLens.resolveRecord(id(77), "", ctx), ctx);
  await session.run();

  const sent = [];
  const claims = [];
  const ui = fakeUi();
  ui.isOpen = () => true;
  const worker = loadWorker();
  const section = loadSection({
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          sent.push(plain(msg));
          assert.ok(worker.checkedUpdateSetRequest(msg), "the worker takes it as it is");
          return { ok: true, copies: [], clones: [], content: ["runs", "runs", "other", "other"] };
        },
      },
    },
    location: { origin: HERE },
    globalThis: { SNVersionLens: sandbox.SNVersionLens, SNVersionLensUI: ui },
    prefillInstanceLabel: () => "TEST",
    claimUpdateSetCheckPanel: (...args) => claims.push(args.slice(0, 2).concat(args.slice(2))),
    releaseUpdateSetCheckPanel: () => {},
    UPDATE_SET_REMOTE_REPLY_CEILING_MS: 1000,
  });
  await section.checkVersionsElsewhere(session, THERE, 7, section.sequence());
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(Object.keys(sent[0]), ["type", "origin", "setIds", "records"]);
  assert.strictEqual(sent[0].type, "UPDATE_SET_REMOTE_CHECK");
  assert.deepStrictEqual(sent[0].setIds, [id(1), id(2)], "Default sets are not asked about while a named one is");
  assert.deepStrictEqual(sent[0].records[0], { name: NAME, guid: guid(1), hash: "1" });
  assert.deepStrictEqual(claims, [["version-lens", ui, 0, 7]]);
  const [answer, token] = ui.calls[0];
  assert.strictEqual(token, 7);
  assert.strictEqual(answer.state, "done");
  assert.strictEqual(answer.lines[0].text, "TEST runs the same version as this instance.");
  assert.ok(answer.copyLine.startsWith("On the other instance: runs the same version"));
  const names = JSON.stringify(sent);
  assert.ok(!/Open 1|dev\.one|"x"/.test(names), "only ids and { name, guid, hash } leave");

  /* A request with nothing to look for never leaves. */
  const empty = sandbox.SNVersionLens.createSession({ kind: "identity", headline: "H1", reason: "x", record: null }, ctx);
  await section.checkVersionsElsewhere(empty, THERE, 8, section.sequence());
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(ui.calls[1], [{ state: "error", message: "Nothing here to look for there." }, 8]);
});

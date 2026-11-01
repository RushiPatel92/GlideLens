/*
 * Update Set Lens engine.
 *
 *   node --test tests/update_set_lens.test.js
 *
 * DEV-ONLY, like its siblings. The real engine runs under node:vm against a
 * simulated instance: an in-memory sys_update_set, sys_update_xml,
 * sys_update_version and sys_remote_update_set behind a small encoded-query
 * evaluator that answers the way the Table API does, including the two
 * behaviours that shaped the plan -- `name=` ignores case and trailing
 * spaces, and X-Total-Count only when asked for. Every request is kept, so a
 * test can see what was read as well as what was concluded.
 *
 * Synthetic data only: no set, user, record or instance here is real.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const ENGINE_SOURCE = fs.readFileSync(path.join(root, "update_set_lens.js"), "utf8");
const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8").replace(/\r\n/g, "\n");
const ORIGIN = "https://example.service-now.com";

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, "source block not found: " + startText);
  return source.slice(start, end);
}

const sysIdFromText = new Function(
  between(contentSource, "function sysIdFromText(", "async function getCurrentRecordSysId(") +
    "\nreturn sysIdFromText;"
)();

function loadEngine() {
  const sandbox = { URL, URLSearchParams, Promise, console, encodeURIComponent, decodeURIComponent };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ENGINE_SOURCE, sandbox, { filename: "update_set_lens.js" });
  return sandbox.SNUpdateSetLens;
}

const lens = loadEngine();
const plain = (value) => JSON.parse(JSON.stringify(value));
const id = (n) => Number(n).toString(16).padStart(32, "0");
const guid = (n) => "a" + Number(n).toString(16).padStart(31, "0");
const SET = id(1);

/* ------------------------------------------------------------------ *
 * A simulated instance
 * ------------------------------------------------------------------ */

const LABELS = {
  "in progress": "In progress",
  complete: "Complete",
  ignore: "Ignore",
  committed: "Committed",
  previewed: "Previewed",
  loaded: "Loaded",
  backedout: "Backed out",
  partial: "Partial",
  current: "Current",
  previous: "Previous",
};

function parseQuery(query) {
  const conditions = [];
  const order = [];
  String(query || "").split("^").filter(Boolean).forEach((part) => {
    if (part.startsWith("ORDERBYDESC")) return order.push({ field: part.slice(11), desc: true });
    if (part.startsWith("ORDERBY")) return order.push({ field: part.slice(7), desc: false });
    const match = part.match(/^([a-z_]+?)(IN|LIKE|>|=)(.*)$/);
    assert.ok(match, "the simulated instance does not understand " + part);
    conditions.push({ field: match[1], op: match[2], value: match[3] });
  });
  return { conditions, order };
}

function test1(row, condition) {
  const value = String(row[condition.field] == null ? "" : row[condition.field]);
  if (condition.op === "IN") return condition.value.split(",").includes(value);
  if (condition.op === "LIKE") return value.toLowerCase().includes(condition.value.toLowerCase());
  if (condition.op === ">") return value > condition.value;
  /* ServiceNow's name match ignores case and trailing spaces (G3). */
  if (condition.field === "name") return value.trimEnd().toLowerCase() === condition.value.trimEnd().toLowerCase();
  return value === condition.value;
}

function fakeInstance(data, options) {
  const opts = options || {};
  const tables = {
    sys_update_set: data.sets || [],
    sys_update_xml: data.xml || [],
    sys_update_version: data.versions || [],
    sys_remote_update_set: data.remote || [],
  };
  Object.assign(tables, data.tables || {});
  const names = new Map((data.sets || []).map((row) => [row.sys_id, row.name]));
  const requests = [];
  const display = (table, field, row) => {
    const value = row[field] == null ? "" : String(row[field]);
    if (field === "state") return LABELS[value] || value;
    if (["parent", "merged_to", "base_update_set"].includes(field)) return names.get(value) || "";
    if (field === "application") return value === "global" ? "Global" : value;
    if (field === "update_source") return value ? "Source " + value.slice(-2) : "";
    if (/_on$|_date$/.test(field)) return value ? "D(" + value + ")" : "";
    return value;
  };
  const transport = async (request) => {
    requests.push(plain(request));
    if (opts.answer) {
      const custom = await opts.answer(request);
      if (custom !== undefined) return custom;
    }
    const rows = tables[request.table];
    assert.ok(rows, "unknown table " + request.table);
    const { conditions, order } = parseQuery(request.query);
    let hit = rows.filter((row) => conditions.every((condition) => test1(row, condition)));
    order.slice().reverse().forEach(({ field, desc }) => {
      hit = hit.slice().sort((a, b) => {
        const left = String(a[field] || "");
        const right = String(b[field] || "");
        return (left < right ? -1 : left > right ? 1 : 0) * (desc ? -1 : 1);
      });
    });
    const total = hit.length;
    hit = hit.slice(0, request.limit);
    const fields = String(request.fields).split(",");
    const displayAll = request.options && request.options.displayAll;
    const result = hit.map((row) => {
      const out = {};
      fields.forEach((field) => {
        const value = row[field] == null ? "" : String(row[field]);
        out[field] = displayAll ? { value, display_value: display(request.table, field, row) } : value;
      });
      return out;
    });
    const reply = { ok: true, result };
    if (request.options && request.options.withTotal && !opts.noTotals) reply.total = total;
    return reply;
  };
  return { transport, requests, tables };
}

function ctxFor(instance, extra) {
  return Object.assign({ origin: ORIGIN, transport: instance.transport, sysIdFromText }, extra || {});
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function setRow(n, extra) {
  return Object.assign({
    sys_id: id(n),
    name: "Set " + n,
    state: "complete",
    is_default: "false",
    application: "global",
    parent: "",
    base_update_set: "",
    merged_to: "",
    remote_sys_id: "",
    origin_sys_id: "",
    sys_created_by: "dev.one",
    sys_created_on: "2026-10-01 10:00:00",
    sys_updated_on: "2026-10-02 10:00:" + String(n % 60).padStart(2, "0"),
  }, extra);
}

let xmlCounter = 5000;
function xmlRow(setId, name, g, hash, extra) {
  xmlCounter += 1;
  return Object.assign({
    sys_id: id(xmlCounter),
    name,
    update_set: setId,
    remote_update_set: "",
    action: "INSERT_OR_UPDATE",
    type: "Script Include",
    target_name: name.replace(/_[0-9a-f]{32}$/, ""),
    update_guid: g,
    payload_hash: hash,
    category: "customer",
  }, extra);
}

function versionRow(name, setId, state, g, hash, created, extra) {
  return Object.assign({
    name,
    state,
    source: setId,
    source_table: "sys_update_set",
    update_guid: g,
    payload_hash: hash,
    action: "INSERT_OR_UPDATE",
    reverted_from: "",
    sys_created_by: "dev.one",
    sys_created_on: created,
  }, extra);
}

/* One member row as the engine normalises it, for the pure rule tests. */
function member(extra) {
  return Object.assign({
    key: "k",
    sysId: id(900),
    name: "sys_script_include_" + id(77),
    setId: SET,
    action: "INSERT_OR_UPDATE",
    guid: guid(1),
    hash: "-1234567",
  }, extra);
}

function current(extra) {
  return Object.assign({
    name: "sys_script_include_" + id(77),
    state: "current",
    source: SET,
    sourceTable: "sys_update_set",
    guid: guid(1),
    hash: "-1234567",
    action: "INSERT_OR_UPDATE",
    revertedFrom: "",
    createdBy: "dev.two",
    createdOn: "D(2026-10-05 10:00:00)",
    createdOnRaw: "2026-10-05 10:00:00",
  }, extra);
}

function own(extra) {
  return Object.assign(current({ state: "previous", createdOnRaw: "2026-10-01 10:00:00" }), extra);
}

const found = (versions) => ({ versions, error: null, unsafe: false, saturated: false });
const OTHER = id(2);

/* ------------------------------------------------------------------ *
 * 1. The rule, row by row (§5.1)
 * ------------------------------------------------------------------ */

test("rule 1: no current version, two of them, a failed read or a blank is Can't tell", () => {
  assert.strictEqual(lens.firstPass(member(), found([]), null).reason, "no-version");
  assert.strictEqual(lens.firstPass(member(), found([current(), current()]), null).reason, "several-current");
  assert.strictEqual(lens.firstPass(member(), { versions: [], error: { code: "transport" } }, null).reason, "versions-failed");
  assert.strictEqual(lens.firstPass(member(), { versions: [], error: { code: "access" } }, null).reason, "versions-refused");
  for (const blank of [{ guid: "" }, { hash: "" }]) {
    const onRow = lens.firstPass(member(blank), found([current()]), null);
    const onVersion = lens.firstPass(member(), found([current(blank)]), null);
    assert.strictEqual(onRow.verdict, "cant");
    assert.strictEqual(onVersion.verdict, "cant");
    assert.strictEqual(onRow.reason, "incomplete");
  }
  assert.strictEqual(lens.firstPass(member(), found([current({ source: "" })]), null).reason, "incomplete");
  /* A source with no source table names nothing: never Stale "outside update
   * sets", never Same content. */
  for (const hash of ["-1234567", "999"]) {
    const noTable = lens.firstPass(member(), found([current({ source: OTHER, sourceTable: "", guid: guid(2), hash })]), null);
    assert.deepStrictEqual([noTable.verdict, noTable.reason], ["cant", "incomplete"], hash);
  }
  /* Two blank guids are not equal: never Current, never Stale. */
  const bothBlank = lens.firstPass(member({ guid: "" }), found([current({ guid: "" })]), null);
  assert.strictEqual(bothBlank.verdict, "cant");
});

test("rule 2: the same guid and hash is Current wherever the version is credited", () => {
  const here = lens.firstPass(member(), found([current()]), null);
  assert.strictEqual(here.verdict, "current");
  assert.ok(!here.elsewhere);
  const elsewhere = lens.firstPass(member(), found([current({ source: OTHER })]), null);
  assert.strictEqual(elsewhere.verdict, "current");
  assert.strictEqual(elsewhere.elsewhere, true, "the moved-capture note, not a verdict");
  const upgrade = lens.firstPass(member(), found([current({ sourceTable: "sys_upgrade_history", source: id(3) })]), null);
  assert.strictEqual(upgrade.verdict, "current");
});

test("rule 2b: the same guid with different content is Can't tell, never Current", () => {
  const outcome = lens.firstPass(member(), found([current({ hash: "998877" })]), null);
  assert.strictEqual(outcome.verdict, "cant");
  assert.strictEqual(outcome.reason, "same-id-different-content");
});

test("rule 3: a later save in this set is Current with equal content and Can't tell without", () => {
  const same = lens.firstPass(member(), found([current({ guid: guid(9) })]), null);
  assert.strictEqual(same.verdict, "current");
  assert.strictEqual(same.laterSave, true);
  const differs = lens.firstPass(member(), found([current({ guid: guid(9), hash: "5" })]), null);
  assert.strictEqual(differs.verdict, "cant");
  assert.strictEqual(differs.reason, "later-version-here");
});

test("rules 4 and 5: a batch sibling is In this batch; equal content elsewhere is Same content", () => {
  const sibling = id(4);
  const inBatch = lens.firstPass(member(), found([current({ guid: guid(9), hash: "5", source: sibling })]), new Set([SET, sibling]));
  assert.strictEqual(inBatch.verdict, "batch");
  const notBatch = lens.firstPass(member(), found([current({ guid: guid(9), hash: "5", source: sibling })]), null);
  assert.ok(notBatch.candidate, "outside batch mode the same row is a stale candidate");
  const same = lens.firstPass(member(), found([current({ guid: guid(9), source: OTHER })]), null);
  assert.strictEqual(same.verdict, "same");
});

test("rule 6: Stale needs a `previous` version of this capture under the row's own set", () => {
  const row = member();
  const c = current({ guid: guid(9), hash: "5", source: OTHER });
  assert.strictEqual(lens.appliedGuard(row, c, [own()]).verdict, "stale");
  const byContent = lens.appliedGuard(row, c, [own({ guid: guid(30) })]);
  assert.strictEqual(byContent.verdict, "stale");
  assert.strictEqual(byContent.matchedByContent, true);
  assert.strictEqual(lens.appliedGuard(row, c, [own()]).matchedByContent, false);
  /* An earlier save from its own set, with neither this guid nor this hash:
   * the case Sol's second review raised. Never Stale. */
  const earlier = lens.appliedGuard(row, c, [own({ guid: guid(31), hash: "42" })]);
  assert.strictEqual(earlier.verdict, "cant");
  assert.strictEqual(earlier.reason, "own-versions-differ");
  assert.strictEqual(lens.appliedGuard(row, c, [own({ state: "backedout" })]).reason, "backed-out-here");
  assert.strictEqual(lens.appliedGuard(row, c, [own({ state: "history" })]).reason, "never-loaded");
  assert.strictEqual(lens.appliedGuard(row, c, [own({ state: "history_collision" })]).reason, "never-loaded");
  const none = lens.appliedGuard(row, c, []);
  assert.strictEqual(none.verdict, "cant");
  assert.strictEqual(none.reason, "not-applied");
  assert.match(lens.CANT_TELL["not-applied"], /skipped at commit/);
});

test("rule 6b: a current version older than the baseline is Can't tell; the same second or later is Stale", () => {
  const row = member();
  const older = current({ guid: guid(9), hash: "5", source: OTHER, createdOnRaw: "2026-09-30 10:00:00" });
  assert.strictEqual(lens.appliedGuard(row, older, [own()]).reason, "runs-older");
  const sameSecond = current({ guid: guid(9), hash: "5", source: OTHER, createdOnRaw: "2026-10-01 10:00:00" });
  assert.strictEqual(lens.appliedGuard(row, sameSecond, [own()]).verdict, "stale");
  /* skip_collision: a `previous` own-guid version under the local set, with a
   * later current version elsewhere, is Stale (G15: 125 of 125). */
  const later = current({ guid: guid(9), hash: "5", source: OTHER, createdOnRaw: "2026-10-09 10:00:00" });
  assert.strictEqual(lens.appliedGuard(row, later, [own()]).verdict, "stale");
});

/* ------------------------------------------------------------------ *
 * Classification against the simulated instance
 * ------------------------------------------------------------------ */

const NAME = (n) => "sys_script_include_" + id(n);

function staleWorld(extra) {
  const ex = extra || {};
  const newer = setRow(2, Object.assign({ name: "Newer work", state: "in progress" }, ex.newerSet || {}));
  const subject = setRow(1, { name: "Approval fix" });
  const row = xmlRow(SET, NAME(77), guid(1), "-1234567", ex.row || {});
  return {
    sets: [subject, newer].concat(ex.sets || []),
    xml: [row].concat(ex.xml || []),
    versions: [
      versionRow(NAME(77), SET, "previous", guid(1), "-1234567", "2026-10-01 10:00:00"),
      versionRow(NAME(77), id(2), "current", guid(2), "555", "2026-10-05 10:00:00", ex.current || {}),
    ].concat(ex.versions || []),
  };
}

async function classifyWorld(world, options) {
  const instance = fakeInstance(world);
  const set = lens.normalizeSet(world.sets[0]);
  const session = lens.createSession({ kind: "set", set }, ctxFor(instance), options || {});
  await session.prepare();
  await session.start();
  return { view: session.view(), instance, session };
}

test("a stale row names the newer set, its state, who and when, and its links", async () => {
  const { view } = await classifyWorld(staleWorld());
  assert.strictEqual(view.rows.length, 1);
  const row = view.rows[0];
  assert.strictEqual(row.verdict, "stale");
  assert.strictEqual(row.text, "Newer version in “Newer work”");
  assert.deepStrictEqual(plain(row.flags), [{ label: "In progress", kind: "progress" }]);
  assert.strictEqual(row.who, "Version by dev.one at D(2026-10-05 10:00:00)");
  assert.deepStrictEqual(plain(row.links.map((link) => link.label)), ["Open update", "Open record", "Open newer set", "Version history"]);
  /* Open record carries the update's name and no URL: its record is looked
   * up when it is clicked. */
  assert.deepStrictEqual(plain(row.links[1]), { label: "Open record", record: NAME(77) });
  assert.ok(row.links.filter((link) => !link.record).every((link) => link.url.startsWith(ORIGIN + "/")));
  assert.strictEqual(row.links[2].url, ORIGIN + "/sys_update_set.do?sys_id=" + id(2));
  assert.strictEqual(
    row.links[3].url,
    ORIGIN + "/sys_update_version_list.do?sysparm_query=" + encodeURIComponent("name=" + NAME(77) + "^ORDERBYDESCsys_recorded_at")
  );
  assert.strictEqual(row.newerSetName, "Newer work");
});

test("delete, re-create and revert wordings", async () => {
  const deleted = await classifyWorld(staleWorld({ current: { action: "DELETE" } }));
  assert.strictEqual(deleted.view.rows[0].text, "Deleted in “Newer work”");
  const recreated = await classifyWorld(staleWorld({ row: { action: "DELETE" } }));
  assert.strictEqual(recreated.view.rows[0].text, "Re-created in “Newer work”");
  assert.strictEqual(recreated.view.rows[0].action, "Delete");
  const bothDeletes = await classifyWorld(staleWorld({ row: { action: "DELETE" }, current: { action: "DELETE" } }));
  assert.strictEqual(bothDeletes.view.rows[0].text, "Deleted in “Newer work”");
  const revert = await classifyWorld(staleWorld({ current: { reverted_from: id(60) } }));
  assert.strictEqual(revert.view.rows[0].text, "Newer version in “Newer work” — a revert to that set's earlier content");
  assert.ok(revert.view.rows[0].flags.some((flag) => flag.label === "Revert"));
});

test("an upgrade, an application install and another source table are Stale with their own wording", async () => {
  const cases = [
    ["sys_upgrade_history", "Replaced by an upgrade"],
    ["sys_store_app", "Replaced by an application install"],
    ["sys_plugin_thing", "Replaced outside update sets (sys_plugin_thing)"],
  ];
  for (const [table, text] of cases) {
    const { view } = await classifyWorld(staleWorld({ current: { source_table: table, source: id(70) } }));
    assert.strictEqual(view.rows[0].verdict, "stale", table);
    assert.strictEqual(view.rows[0].text, text);
    assert.ok(!view.rows[0].links.some((link) => link.label === "Open newer set"));
  }
});

test("every newer-set flag: Default, Ignore, committed from another instance", async () => {
  const defaultSet = await classifyWorld(staleWorld({ newerSet: { is_default: "true", name: "Default" } }));
  assert.deepStrictEqual(plain(defaultSet.view.rows[0].flags), [{ label: "Default set: changed outside a named set", kind: "default" }]);
  const ignore = await classifyWorld(staleWorld({ newerSet: { state: "ignore" } }));
  assert.deepStrictEqual(plain(ignore.view.rows[0].flags), [{ label: "Ignore", kind: "ignore" }]);
  const committed = await classifyWorld(staleWorld({ newerSet: { remote_sys_id: id(88), state: "complete" } }));
  assert.ok(committed.view.rows[0].flags.some((flag) => flag.label === "Committed here from another instance"));
  assert.strictEqual(committed.view.rows[0].who, "Version by dev.one, committed here D(2026-10-05 10:00:00)");
});

test("a newer set that can't be read is named as such, and its link still opens it", async () => {
  const world = staleWorld();
  world.sets = [world.sets[0]];
  const { view } = await classifyWorld(world);
  assert.strictEqual(view.rows[0].text, "Newer version in “an update set you can't read”");
  assert.ok(view.rows[0].links.some((link) => link.label === "Open newer set"));
});

test("a skipped update on a committed arrival is Can't tell, never 'Newer version in'", async () => {
  /* The local set was committed from a retrieved set; one update stayed under
   * the retrieved set (skipped at commit) and never became a version here,
   * while an older version from another set is still current. */
  const retrievedId = id(40);
  const local = setRow(1, { name: "Arrival", remote_sys_id: retrievedId });
  const older = setRow(2, { name: "Older work" });
  const world = {
    sets: [local, older],
    remote: [{
      sys_id: retrievedId, name: "Arrival", state: "committed", remote_sys_id: id(500), origin_sys_id: "",
      update_set: SET, update_source: id(41), commit_date: "2026-10-10 09:00:00", collisions: "0",
      parent: "", remote_base_update_set: "", sys_created_on: "2026-10-09 09:00:00",
    }],
    xml: [xmlRow("", NAME(80), guid(5), "11", { remote_update_set: retrievedId, category: "retrieved" })],
    versions: [versionRow(NAME(80), id(2), "current", guid(6), "22", "2026-09-01 10:00:00")],
  };
  const { view } = await classifyWorld(world);
  assert.strictEqual(view.rows.length, 1);
  assert.strictEqual(view.rows[0].verdict, "cant");
  assert.strictEqual(view.rows[0].reason, "not-applied");
  assert.strictEqual(view.rows[0].asRetrieved, true);
  assert.doesNotMatch(view.rows[0].text, /Newer version in/);
  assert.ok(view.banners.some((banner) => banner.text ===
    "Committed here from a retrieved set (update source Source " + id(41).slice(-2) + ") on D(2026-10-10 09:00:00)."));
});

test("a version read that fills its limit is split, and a single name that still fills it never yields a verdict", async () => {
  const names = Array.from({ length: 6 }, (_, index) => NAME(100 + index));
  const subject = setRow(1);
  const world = {
    sets: [subject],
    xml: names.map((name, index) => xmlRow(SET, name, guid(index + 1), String(index + 1))),
    /* Every name's current version is this capture, except one with twelve
     * current rows: enough to fill the six-name read (limit 14), and then a
     * single-name read (limit 4) too. */
    versions: names.map((name, index) => versionRow(name, SET, "current", guid(index + 1), String(index + 1), "2026-10-01 10:00:00"))
      .concat(Array.from({ length: 11 }, () => versionRow(names[2], SET, "current", guid(3), "3", "2026-10-01 10:00:00"))),
  };
  const { view, instance } = await classifyWorld(world);
  const verdicts = Object.fromEntries(view.rows.map((row) => [row.name, row.verdict]));
  assert.strictEqual(verdicts[names[2]], "cant");
  assert.strictEqual(view.rows.find((row) => row.name === names[2]).reason, "several-current");
  names.filter((name) => name !== names[2]).forEach((name) => assert.strictEqual(verdicts[name], "current", name));
  const versionReads = instance.requests.filter((request) => request.table === "sys_update_version" && /state=current/.test(request.query));
  assert.ok(versionReads.length > 1, "the full read was split");
});

/* ------------------------------------------------------------------ *
 * 2. Membership (§4.3)
 * ------------------------------------------------------------------ */

test("members are listed by update_set with no category filter, so mixed categories all count", async () => {
  const subject = setRow(1);
  const world = {
    sets: [subject],
    xml: [
      xmlRow(SET, NAME(1), guid(1), "1", { category: "customer" }),
      xmlRow(SET, NAME(2), guid(2), "2", { category: "retrieved" }),
    ],
    versions: [
      versionRow(NAME(1), SET, "current", guid(1), "1", "2026-10-01 10:00:00"),
      versionRow(NAME(2), SET, "current", guid(2), "2", "2026-10-01 10:00:00"),
    ],
  };
  const { view, instance } = await classifyWorld(world);
  assert.strictEqual(view.rows.length, 2);
  assert.ok(instance.requests.every((request) => !/category/.test(request.query)));
});

function arrivalWorld(attached, retrievedOnly, both) {
  const retrievedId = id(40);
  const local = setRow(1, { name: "Arrival", remote_sys_id: retrievedId });
  const xml = [];
  const versions = [];
  attached.forEach((n) => {
    xml.push(xmlRow(SET, NAME(n), guid(n), String(n)));
    versions.push(versionRow(NAME(n), SET, "current", guid(n), String(n), "2026-10-01 10:00:00"));
  });
  retrievedOnly.forEach((n) => {
    xml.push(xmlRow("", NAME(n), guid(n), String(n), { remote_update_set: retrievedId, category: "retrieved" }));
    versions.push(versionRow(NAME(n), SET, "current", guid(n), String(n), "2026-10-01 10:00:00"));
  });
  (both || []).forEach(([n, differs]) => {
    xml.push(xmlRow(SET, NAME(n), guid(n), String(n)));
    xml.push(xmlRow("", NAME(n), differs ? guid(n + 500) : guid(n), String(n), { remote_update_set: retrievedId }));
    versions.push(versionRow(NAME(n), SET, "current", guid(n), String(n), "2026-10-01 10:00:00"));
  });
  return { sets: [local], xml, versions, remote: [] };
}

test("an arrival's members are the union of both shapes, attached rows kept, the local id still this set", async () => {
  const onlyRetrieved = await classifyWorld(arrivalWorld([], [1, 2]));
  assert.strictEqual(onlyRetrieved.view.rows.length, 2, "population A: nothing attached");
  assert.ok(onlyRetrieved.view.rows.every((row) => row.asRetrieved && row.verdict === "current"));
  assert.ok(onlyRetrieved.view.rows.every((row) => row.setId === SET));

  const onlyAttached = await classifyWorld(arrivalWorld([1, 2], []));
  assert.ok(onlyAttached.view.rows.every((row) => !row.asRetrieved));

  const mixed = await classifyWorld(arrivalWorld([1], [2], [[3, false], [4, true]]));
  assert.strictEqual(mixed.view.rows.length, 4, "a name in both lists is one row");
  const byName = Object.fromEntries(mixed.view.rows.map((row) => [row.name, row]));
  assert.strictEqual(byName[NAME(2)].asRetrieved, true);
  assert.strictEqual(byName[NAME(3)].asRetrieved, false, "the attached row is the one kept");
  assert.ok(!byName[NAME(3)].notes.includes("the retrieved copy differs"));
  assert.ok(byName[NAME(4)].notes.includes("the retrieved copy differs"));
  assert.ok(mixed.view.banners.some((banner) => banner.text === "1 update is listed only under the retrieved set."));
});

test("Checked N of up to M until both lists are read, then exact", async () => {
  const world = arrivalWorld(Array.from({ length: 3 }, (_, index) => index + 1), [], [[10, false]]);
  const instance = fakeInstance(world);
  const set = lens.normalizeSet(world.sets[0]);
  const session = lens.createSession({ kind: "set", set }, ctxFor(instance), {});
  const seen = [];
  session.onChange((view) => seen.push(plain(view.totals)));
  await session.prepare();
  await session.start();
  assert.ok(seen.some((totals) => totals.total === 5 && totals.exact === false), "4 attached + 1 retrieved, as an upper bound");
  assert.deepStrictEqual(plain(session.view().totals), { checked: 4, total: 4, exact: true });
});

test("the same record captured twice in one set keeps both rows, flagged, each classified", async () => {
  const subject = setRow(1);
  const world = {
    sets: [subject],
    xml: [xmlRow(SET, NAME(1), guid(1), "1"), xmlRow(SET, NAME(1), guid(2), "2")],
    versions: [versionRow(NAME(1), SET, "current", guid(2), "2", "2026-10-01 10:00:00")],
  };
  const { view } = await classifyWorld(world);
  assert.strictEqual(view.rows.length, 2);
  assert.strictEqual(new Set(view.rows.map((row) => row.key)).size, 2, "distinct keys");
  assert.ok(view.rows.some((row) => row.notes.includes("captured twice in this set")));
  assert.deepStrictEqual(plain(view.rows.map((row) => row.verdict).sort()), ["cant", "current"]);
});

test("a count with no readable rows says the updates can't be read; a refused version read is Partial", async () => {
  const subject = setRow(1);
  const hidden = fakeInstance({ sets: [subject], xml: [] }, {
    answer: (request) => (request.table === "sys_update_xml" && request.options.withTotal
      ? { ok: true, result: [{ sys_id: { value: id(9000), display_value: id(9000) } }], total: 7 }
      : undefined),
  });
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(subject) }, ctxFor(hidden), {});
  await session.prepare();
  await session.start();
  assert.ok(session.view().banners.some((banner) => /Can't read this set's updates/.test(banner.text)));
  assert.strictEqual(session.view().canContinue, false);

  const world = staleWorld();
  const refused = fakeInstance(world, {
    answer: (request) => (request.table === "sys_update_version" ? { ok: false, status: 403, error: "HTTP 403" } : undefined),
  });
  const partial = lens.createSession({ kind: "set", set: lens.normalizeSet(world.sets[0]) }, ctxFor(refused), {});
  await partial.prepare();
  await partial.start();
  const view = partial.view();
  assert.ok(view.banners.some((banner) => /^Partial: can't check staleness/.test(banner.text)));
  assert.ok(view.rows.every((row) => row.verdict === "cant"), "no row is shown as Current");
});

/* ------------------------------------------------------------------ *
 * 3. Input (§3.3)
 * ------------------------------------------------------------------ */

function inputWorld() {
  return {
    sets: [
      setRow(1, { name: "Approval fix", state: "complete", sys_updated_on: "2026-10-03 10:00:00" }),
      setRow(2, { name: "Approval fix", state: "in progress", sys_updated_on: "2026-10-01 10:00:00" }),
      setRow(3, { name: "approval fix ", state: "ignore", sys_updated_on: "2026-10-05 10:00:00" }),
      setRow(4, { name: "Approval fix", state: "in progress", is_default: "true", sys_updated_on: "2026-10-09 10:00:00" }),
      setRow(5, { name: "Approval fix v2", state: "complete" }),
      setRow(6, { name: "Unique release" }),
    ],
    remote: [{
      sys_id: id(40), name: "Retrieved one", state: "previewed", remote_sys_id: id(500), origin_sys_id: "",
      update_set: "", update_source: id(41), commit_date: "", collisions: "2", parent: "",
      remote_base_update_set: "", sys_created_on: "2026-10-09 09:00:00",
    }],
  };
}

test("a 32-hex id and the set's own links resolve here; a retrieved set's id resolves to it", async () => {
  const instance = fakeInstance(inputWorld());
  const ctx = ctxFor(instance);
  assert.strictEqual((await lens.resolveUpdateSetInput(id(6), ctx)).set.name, "Unique release");
  assert.strictEqual((await lens.resolveUpdateSetInput(id(6).toUpperCase(), ctx)).set.sysId, id(6));
  const links = [
    ORIGIN + "/sys_update_set.do?sys_id=" + id(6),
    ORIGIN + "/nav_to.do?uri=sys_update_set.do%3Fsys_id%3D" + id(6),
    ORIGIN + "/now/nav/ui/classic/params/target/sys_update_set.do%3Fsys_id%3D" + id(6),
  ];
  for (const link of links) {
    const resolved = await lens.resolveUpdateSetInput(link, ctx);
    assert.strictEqual(resolved.kind, "set", link);
    assert.strictEqual(resolved.set.sysId, id(6));
  }
  const retrieved = await lens.resolveUpdateSetInput(ORIGIN + "/sys_remote_update_set.do?sys_id=" + id(40), ctx);
  assert.strictEqual(retrieved.kind, "retrieved");
  assert.strictEqual(retrieved.remote.state, "previewed");
  const none = await lens.resolveUpdateSetInput(id(99), ctx);
  assert.strictEqual(none.kind, "none");
  assert.match(none.message, /or you can't read it/);
});

test("a link to another instance is refused and nothing is read here", async () => {
  const instance = fakeInstance(inputWorld());
  const answer = await lens.resolveUpdateSetInput("https://exampletest.service-now.com/sys_update_set.do?sys_id=" + id(6), ctxFor(instance));
  assert.strictEqual(answer.kind, "refused");
  assert.match(answer.message, /^This link is to exampletest\.service-now\.com\. Update history belongs to each instance; run Update Set Lens there\.$/);
  assert.deepStrictEqual(instance.requests, [], "never read a same-sys_id set here");
  const list = await lens.resolveUpdateSetInput(ORIGIN + "/sys_update_set_list.do?sysparm_query=remote_sys_id%3D" + id(6), ctxFor(instance));
  assert.strictEqual(list.kind, "refused");
  assert.deepStrictEqual(instance.requests, []);
});

test("names: one match runs, several go to the chooser, none suggests, and the server's answer is checked", async () => {
  const instance = fakeInstance(inputWorld());
  const ctx = ctxFor(instance);
  const one = await lens.resolveUpdateSetInput("Unique release", ctx);
  assert.strictEqual(one.kind, "set");
  /* Case and trailing spaces fold, as the server's own match does (G3). */
  assert.strictEqual((await lens.resolveUpdateSetInput("unique RELEASE", ctx)).kind, "set");
  const several = await lens.resolveUpdateSetInput("Approval fix", ctx);
  assert.strictEqual(several.kind, "choose", "never picked silently");
  assert.deepStrictEqual(plain(several.sets.map((set) => set.sysId)), [id(2), id(1), id(3), id(4)],
    "in progress, then complete, then Ignore, and the Default set last");
  assert.strictEqual(several.sets[3].isDefault, true, "the tag comes from is_default");
  assert.strictEqual(several.more, false);
  const suggest = await lens.resolveUpdateSetInput("release", ctx);
  assert.strictEqual(suggest.kind, "suggest");
  assert.deepStrictEqual(plain(suggest.sets.map((set) => set.name)), ["Unique release"]);
  const nothing = await lens.resolveUpdateSetInput("No such set", ctx);
  assert.strictEqual(nothing.kind, "none");

  /* A server that ignores the condition returns other sets: the code check
   * drops every one whose name differs by more than case and spaces. */
  const ignoring = fakeInstance(inputWorld(), {
    answer: (request) => (request.table === "sys_update_set" && /^name=/.test(request.query)
      ? { ok: true, result: inputWorld().sets.map((row) => ({ sys_id: row.sys_id, name: row.name, state: row.state, is_default: row.is_default })) }
      : undefined),
  });
  const checked = await lens.resolveUpdateSetInput("Unique release", ctxFor(ignoring));
  assert.strictEqual(checked.kind, "set");
  assert.strictEqual(checked.set.sysId, id(6));
});

test("more than 20 sets with one name says so", async () => {
  const sets = Array.from({ length: 25 }, (_, index) => setRow(100 + index, { name: "Generated" }));
  const answer = await lens.resolveUpdateSetInput("Generated", ctxFor(fakeInstance({ sets })));
  assert.strictEqual(answer.kind, "choose");
  assert.strictEqual(answer.sets.length, 20);
  assert.strictEqual(answer.more, true);
});

test("a caret, a line break and a javascript: value are refused before any read", async () => {
  const instance = fakeInstance(inputWorld());
  for (const text of ["fix^ORDERBYname", "fix\nsecond", "javascript:gs.getUserID()", "JavaScript:x"]) {
    const answer = await lens.resolveUpdateSetInput(text, ctxFor(instance));
    assert.strictEqual(answer.kind, "refused", text);
    assert.strictEqual(answer.message, "Use the sys_id or a link.");
  }
  assert.deepStrictEqual(instance.requests, []);
});

/* ------------------------------------------------------------------ *
 * 4. Page context (§3.2)
 * ------------------------------------------------------------------ */

test("a nav_to.do page is decided by a read, never taken as a table called nav_to", async () => {
  const instance = fakeInstance(inputWorld());
  const page = await lens.pageUpdateSet(ORIGIN + "/nav_to.do?uri=sys_update_set.do%3Fsys_id%3D" + id(6), ctxFor(instance, {
    pageTable: "nav_to",
    currentSysId: async () => id(6),
  }));
  assert.strictEqual(page.kind, "set");
  assert.strictEqual(page.pageSysId, id(6));
  const retrieved = await lens.pageUpdateSet(ORIGIN + "/sys_remote_update_set.do?sys_id=" + id(40), ctxFor(instance, {
    pageTable: "sys_remote_update_set",
    currentSysId: async () => id(40),
  }));
  assert.strictEqual(retrieved.kind, "retrieved");
  const other = await lens.pageUpdateSet(ORIGIN + "/nav_to.do?uri=foo.do", ctxFor(instance, {
    pageTable: "nav_to",
    currentSysId: async () => id(77),
  }));
  assert.strictEqual(other.kind, "none", "some other record: the input row");
});

test("a list, or a nav_to.do wrapping one, opens with the input row and makes no read", async () => {
  const instance = fakeInstance(inputWorld());
  let asked = 0;
  const ctx = ctxFor(instance, { pageTable: "sys_update_set", currentSysId: async () => { asked += 1; return id(6); } });
  const lists = [
    ORIGIN + "/sys_update_set_list.do?sysparm_query=remote_sys_id%3D" + id(6),
    ORIGIN + "/sys_update_set_list.do?sysparm_query=origin_sys_id%3D" + id(6),
    ORIGIN + "/nav_to.do?uri=sys_update_set_list.do%3Fsysparm_query%3Dremote_sys_id%253D" + id(6),
    ORIGIN + "/nav_to.do?uri=%2Fsys_update_set_list.do%3Fsysparm_query%3Dorigin_sys_id%3D" + id(6),
    ORIGIN + "/now/nav/ui/classic/params/target/sys_update_set_list.do%3Fsysparm_query%3Dremote_sys_id%253D" + id(6),
  ];
  for (const url of lists) {
    assert.strictEqual((await lens.pageUpdateSet(url, ctx)).kind, "none", url);
  }
  assert.strictEqual(asked, 0);
  assert.deepStrictEqual(instance.requests, []);
  /* Some other table's form costs nothing either. */
  const incident = await lens.pageUpdateSet(ORIGIN + "/incident.do?sys_id=" + id(6), ctxFor(instance, {
    pageTable: "incident",
    currentSysId: async () => { asked += 1; return id(6); },
  }));
  assert.strictEqual(incident.kind, "none");
  assert.strictEqual(asked, 0);
});

test("the retrieved-set form's line follows its state", () => {
  const remote = (state, updateSet) => lens.normalizeRetrieved({
    sys_id: id(40), name: "Retrieved", state: { value: state, display_value: LABELS[state] || "Some label" },
    update_set: updateSet || "", sys_created_on: "2026-10-09 09:00:00",
  });
  const screen = (state, updateSet, page) => lens.retrievedScreen(remote(state, updateSet), page || "", ORIGIN);
  assert.strictEqual(screen("committed", id(1)).message, "Committed here, but its local set can't be read.");
  assert.strictEqual(screen("committed").message, "Committed here; its local set isn't linked.");
  for (const state of ["loaded", "in_hierarchy", "previewing", "previewed", "previewed_in_hierarchy"]) {
    assert.strictEqual(screen(state).message, "Not committed on this instance; ServiceNow's Preview checks it here.", state);
  }
  for (const state of ["backedout", "backedout_in_hierarchy"]) {
    assert.strictEqual(screen(state).message, "Backed out on this instance; its updates are no longer applied here.");
  }
  assert.strictEqual(screen("partial").message, "Partial.");
  assert.strictEqual(screen("committing").message, "Some label.", "an unknown state is shown by its label, no claim");
  /* Links: Open retrieved set unless this is that form; preview problems for
   * a previewed set only. */
  const labels = (shown) => plain(shown.links.map((link) => link.label));
  assert.deepStrictEqual(labels(screen("previewed")), ["Open retrieved set", "Open preview problems"]);
  assert.deepStrictEqual(labels(screen("previewed", "", id(40))), ["Open preview problems"]);
  assert.deepStrictEqual(labels(screen("loaded")), ["Open retrieved set"]);
  assert.strictEqual(screen("previewed").links[1].url,
    ORIGIN + "/sys_update_preview_problem_list.do?sysparm_query=" + encodeURIComponent("remote_update_set=" + id(40)));
});

test("a committed retrieved set opens on its local copy and says so", async () => {
  const world = staleWorld();
  world.remote = [{
    sys_id: id(40), name: "Approval fix", state: "committed", remote_sys_id: id(500), origin_sys_id: "",
    update_set: SET, update_source: "", commit_date: "2026-10-10 09:00:00", collisions: "0", parent: "",
    remote_base_update_set: "", sys_created_on: "2026-10-09 09:00:00",
  }];
  const instance = fakeInstance(world);
  const resolved = await lens.resolveUpdateSetInput(id(40), ctxFor(instance));
  const session = lens.createSession(resolved, ctxFor(instance), { pageSysId: id(40) });
  await session.prepare();
  await session.start();
  const view = session.view();
  assert.strictEqual(view.subject.sysId, SET);
  const banner = view.banners.find((entry) => entry.text === "Retrieved set, showing its local copy.");
  assert.ok(banner);
  assert.deepStrictEqual(plain(banner.links), [], "hidden when the page already is that form");
  assert.strictEqual(view.rows[0].verdict, "stale");
});

/* ------------------------------------------------------------------ *
 * 5. Batches (§3.4)
 * ------------------------------------------------------------------ */

function batchWorld() {
  const parent = setRow(1, { name: "Release batch" });
  const childA = setRow(2, { name: "Child A", parent: SET });
  const childB = setRow(3, { name: "Child B", parent: SET });
  const grandchild = setRow(4, { name: "Grandchild", parent: id(2) });
  return {
    sets: [parent, childA, childB, grandchild],
    xml: [
      xmlRow(id(2), NAME(1), guid(1), "1"),
      xmlRow(id(3), NAME(1), guid(2), "2"),
      xmlRow(id(4), NAME(2), guid(3), "3"),
    ],
    versions: [
      versionRow(NAME(1), id(3), "current", guid(2), "2", "2026-10-03 10:00:00"),
      versionRow(NAME(1), id(2), "previous", guid(1), "1", "2026-10-02 10:00:00"),
      versionRow(NAME(2), id(4), "current", guid(3), "3", "2026-10-03 10:00:00"),
    ],
  };
}

test("an empty parent offers its direct child sets, on by default, then counts the whole batch", async () => {
  const world = batchWorld();
  const instance = fakeInstance(world);
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(world.sets[0]) }, ctxFor(instance), {});
  await session.prepare();
  let view = session.view();
  assert.deepStrictEqual(plain(view.batch), { children: 2, included: true, setCount: null }, "N direct child sets before the walk");
  await session.start();
  view = session.view();
  assert.strictEqual(view.batch.setCount, 3, "the walk found the grandchild too");
  const byName = Object.fromEntries(view.rows.map((row) => [row.setId + row.name, row]));
  assert.strictEqual(byName[id(2) + NAME(1)].verdict, "batch", "the sibling's newer version is In this batch");
  assert.strictEqual(byName[id(2) + NAME(1)].childSet, "Child A");
  assert.strictEqual(byName[id(3) + NAME(1)].verdict, "current");
  assert.strictEqual(byName[id(4) + NAME(2)].childSet, "Grandchild");
});

test("a parent that holds rows itself starts with its children off", async () => {
  const world = batchWorld();
  world.xml.push(xmlRow(SET, NAME(9), guid(9), "9"));
  world.versions.push(versionRow(NAME(9), SET, "current", guid(9), "9", "2026-10-01 10:00:00"));
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(world.sets[0]) }, ctxFor(fakeInstance(world)), {});
  await session.prepare();
  assert.strictEqual(session.view().batch.included, false);
  await session.start();
  assert.strictEqual(session.view().rows.length, 1);
});

test("a root that is its own base is read once by base_update_set", async () => {
  const world = batchWorld();
  world.sets = world.sets.map((row) => Object.assign({}, row, { base_update_set: SET }));
  const instance = fakeInstance(world);
  const walked = await lens.walkBatch(lens.normalizeSet(world.sets[0]), ctxFor(instance));
  assert.deepStrictEqual(plain(walked.sets.map((set) => set.sysId).sort()), [id(2), id(3), id(4)]);
  const setReads = instance.requests.filter((request) => request.table === "sys_update_set");
  assert.strictEqual(setReads.length, 1);
  assert.match(setReads[0].query, /^base_update_set=/);
});

test("the walk stops at 6 levels and 1,000 sets, and a cycle cannot loop", async () => {
  const chain = [setRow(1)];
  for (let level = 2; level <= 9; level += 1) chain.push(setRow(level, { parent: id(level - 1) }));
  const deep = await lens.walkBatch(lens.normalizeSet(chain[0]), ctxFor(fakeInstance({ sets: chain })));
  assert.strictEqual(deep.sets.length, 6);
  assert.strictEqual(deep.depthCapped, true);

  const wide = [setRow(1)].concat(Array.from({ length: 1005 }, (_, index) => setRow(10 + index, { parent: SET })));
  const many = await lens.walkBatch(lens.normalizeSet(wide[0]), ctxFor(fakeInstance({ sets: wide })));
  assert.strictEqual(many.sets.length, 1000);
  assert.strictEqual(many.capped, true);

  const cycle = [setRow(1, { parent: id(3) }), setRow(2, { parent: SET }), setRow(3, { parent: id(2) })];
  const looped = await lens.walkBatch(lens.normalizeSet(cycle[0]), ctxFor(fakeInstance({ sets: cycle })));
  assert.deepStrictEqual(plain(looped.sets.map((set) => set.sysId)), [id(2), id(3)]);
});

/* ------------------------------------------------------------------ *
 * 6. Paging, chunking and the cap (§9)
 * ------------------------------------------------------------------ */

function bigWorld(count) {
  const subject = setRow(1);
  const xml = [];
  const versions = [];
  for (let index = 0; index < count; index += 1) {
    const name = NAME(10000 + index);
    xml.push(xmlRow(SET, name, guid(index + 1), String(index)));
    versions.push(versionRow(name, SET, "current", guid(index + 1), String(index), "2026-10-01 10:00:00"));
  }
  return { sets: [subject], xml, versions };
}

test("membership pages are keyed on sys_id, 200 a page, and a run stops at 2,000 until Continue", async () => {
  const world = bigWorld(2150);
  const instance = fakeInstance(world);
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(world.sets[0]) }, ctxFor(instance), {});
  await session.prepare();
  await session.start();
  let view = session.view();
  assert.strictEqual(view.rows.length, 2000);
  assert.deepStrictEqual(plain(view.totals), { checked: 2000, total: 2150, exact: false });
  assert.strictEqual(view.canContinue, true);
  assert.strictEqual(session.remoteRequest().partial, true, "a check now compares only what was checked so far");
  const pages = instance.requests.filter((request) => request.table === "sys_update_xml" && /ORDERBYsys_id/.test(request.query));
  assert.ok(pages.every((request) => request.limit <= 200));
  assert.match(pages[1].query, /\^sys_id>[0-9a-f]{32}\^ORDERBYsys_id$/);
  const versionReads = instance.requests.filter((request) => request.table === "sys_update_version" && /state=current/.test(request.query));
  assert.ok(versionReads.every((request) => request.query.split(",").length <= 40), "40 names a read");
  await session.continue();
  view = session.view();
  assert.strictEqual(view.rows.length, 2150);
  assert.deepStrictEqual(plain(view.totals), { checked: 2150, total: 2150, exact: true });
  assert.strictEqual(view.canContinue, false);
  assert.strictEqual(session.remoteRequest().partial, false);
  assert.strictEqual(new Set(view.rows.map((row) => row.name)).size, 2150, "no row twice across runs");
});

/* ServiceNow answers HTTP 400 "Pagination not supported" when a long query
 * matches more rows than its limit, unless the pagination header is
 * suppressed (measured: 2,007 characters passed, 2,667 failed). This fake
 * fails from 2,048 characters. */
function paginatingInstance(world) {
  const sn = fakeInstance(world);
  const requests = [];
  const transport = async (request) => {
    requests.push(plain(request));
    const options = request.options || {};
    const full = await sn.transport(Object.assign({}, request, { options: Object.assign({}, options, { withTotal: true }) }));
    if (!options.suppressPagination && String(request.query).length > 2048 && full.ok && full.total > request.limit) {
      return { ok: false, status: 400, error: "HTTP 400 reading " + request.table };
    }
    if (!options.withTotal) delete full.total;
    return full;
  };
  return { transport, requests };
}

test("a batch of 80 child sets is counted and read: every read suppresses the pagination header", async () => {
  const children = Array.from({ length: 80 }, (_, index) => setRow(100 + index, { parent: SET }));
  const world = {
    sets: [setRow(1, { name: "Release batch" })].concat(children),
    xml: [],
    versions: [],
  };
  /* Two updates a child: the 80-id chunk then matches 160 rows, which
   * overflows the 1-row count read. */
  children.forEach((child, index) => {
    [[NAME(5000 + index), guid(index + 1), String(index)], [NAME(6000 + index), guid(index + 200), String(1000 + index)]]
      .forEach(([name, g, hash]) => {
        world.xml.push(xmlRow(child.sys_id, name, g, hash));
        world.versions.push(versionRow(name, child.sys_id, "current", g, hash, "2026-10-01 10:00:00"));
      });
  });
  const instance = paginatingInstance(world);
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(world.sets[0]) }, ctxFor(instance), {});
  await session.prepare();
  await session.start();
  const view = session.view();
  assert.strictEqual(view.phase, "done", "the run finishes rather than ending in an error");
  assert.deepStrictEqual(plain(view.totals), { checked: 160, total: 160, exact: true });
  assert.strictEqual(view.rows.length, 160);
  const long = instance.requests.filter((request) => request.query.length > 2048);
  assert.ok(long.some((request) => request.table === "sys_update_xml"), "the 80-id chunk is long enough to fail");
  assert.ok(instance.requests.every((request) => request.options.suppressPagination === true),
    "every Update Set Lens read sends the parameter");
});

test("version reads stay under the 6,000-character URL cap with 250-character names", () => {
  const names = Array.from({ length: 40 }, (_, index) => "x".repeat(246) + String(index).padStart(4, "0"));
  const build = (group) => "state=current^nameIN" + group.join(",");
  const measure = (group) => lens.readUrlLength(ORIGIN, "sys_update_version", build(group),
    "name,state,source,source_table,update_guid,payload_hash,action,reverted_from,sys_created_by,sys_created_on", group.length * 2 + 2);
  const chunks = lens.chunkForUrl(names, 40, measure);
  assert.ok(chunks.length >= 2, "40 such names never share one read");
  chunks.forEach((group) => assert.ok(measure(group) <= 6000, String(measure(group))));
  assert.deepStrictEqual(plain(chunks.flat()), names);
  const short = Array.from({ length: 41 }, (_, index) => "sys_script_" + index);
  assert.deepStrictEqual(plain(lens.chunkForUrl(short, 40, () => 100).map((group) => group.length)), [40, 1]);
});

test("a comma name is read alone through name=, and a caret name is never queried", async () => {
  const subject = setRow(1);
  const comma = "sys_choice_a,b";
  const caret = "sys_choice_a^b";
  const world = {
    sets: [subject],
    xml: [xmlRow(SET, comma, guid(1), "1"), xmlRow(SET, caret, guid(2), "2"), xmlRow(SET, NAME(3), guid(3), "3")],
    versions: [
      versionRow(comma, SET, "current", guid(1), "1", "2026-10-01 10:00:00"),
      versionRow(NAME(3), SET, "current", guid(3), "3", "2026-10-01 10:00:00"),
    ],
  };
  const { view, instance } = await classifyWorld(world);
  const reads = instance.requests.filter((request) => request.table === "sys_update_version" && /state=current/.test(request.query));
  assert.ok(reads.some((request) => request.query === "state=current^name=" + comma));
  assert.ok(reads.every((request) => !request.query.includes("a^b")));
  const byName = Object.fromEntries(view.rows.map((row) => [row.name, row]));
  assert.strictEqual(byName[comma].verdict, "current");
  assert.strictEqual(byName[caret].verdict, "cant");
  assert.strictEqual(byName[caret].reason, "unqueryable");
  assert.ok(!byName[caret].links.some((link) => link.label === "Version history"));
});

test("with no X-Total-Count the header says Checked N, never a guessed total", async () => {
  const world = bigWorld(250);
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(world.sets[0]) },
    ctxFor(fakeInstance(world, { noTotals: true })), {});
  await session.prepare();
  const seen = [];
  session.onChange((view) => seen.push(plain(view.totals)));
  await session.start();
  assert.ok(seen.some((totals) => totals.checked === 200 && totals.total === null), "unknown while reading");
  assert.ok(seen.every((totals) => totals.total !== 0), "never a guessed zero before the count");
  assert.deepStrictEqual(plain(session.view().totals), { checked: 250, total: 250, exact: true }, "the union, once read");
});

/* ------------------------------------------------------------------ *
 * 7. Static rules on the engine and the exporter
 * ------------------------------------------------------------------ */

test("no field list holds payload, or table on sys_update_xml, and no read is keyed by guid or hash", () => {
  const exporter = between(contentSource, "const UPDATE_SET_EXPORT_PROGRESS_MS", "/* =====================================================================\n * IMPERSONATE");
  for (const [label, source] of [["engine", ENGINE_SOURCE], ["exporter", exporter]]) {
    for (const fields of source.match(/_FIELDS =[\s\S]*?;/g) || []) {
      assert.doesNotMatch(fields, /["',]\s*payload\s*["',]/, label + ": " + fields);
    }
    for (const forbidden of ["update_guid=", "update_guidIN", "payload_hash=", "payload_hashIN", "category="]) {
      assert.ok(!source.includes(forbidden), label + " must not build " + forbidden);
    }
    assert.ok(!/\bfetch\(/.test(source), label + " reads only through the timed route");
    assert.ok(!/\bmethod\s*:/.test(source), label + " names no HTTP method");
  }
  const memberFields = ENGINE_SOURCE.match(/const MEMBER_FIELDS = \[([\s\S]*?)\]/)[1];
  assert.doesNotMatch(memberFields, /"table"/);
});

test("a set name that merely contains the fingerprint words is searched as a name", async () => {
  const instance = fakeInstance({ sets: [setRow(1, { name: "notes on update_guid=x" })] });
  const answer = await lens.resolveUpdateSetInput("notes on update_guid=x", ctxFor(instance));
  assert.strictEqual(answer.kind, "set");
  assert.strictEqual(instance.requests[0].query, "name=notes on update_guid=x^ORDERBYDESCsys_updated_on");
});

test("the engine refuses at run time a read keyed by a version fingerprint or naming payload", async () => {
  const ctx = { origin: ORIGIN, transport: async () => ({ ok: true, result: [] }) };
  const set = lens.normalizeSet(setRow(1));
  /* Reached through the public classifier with a hostile row name would be
   * refused earlier; here the guard itself is driven through a session. */
  const session = lens.createSession({ kind: "set", set }, Object.assign({}, ctx, {
    transport: async (request) => {
      assert.doesNotMatch(request.query, /update_guid|payload_hash/);
      assert.doesNotMatch(request.fields, /(?:^|,)payload(?:,|$)/);
      return { ok: true, result: [], total: 0 };
    },
  }), {});
  await session.prepare();
  await session.start();
  assert.strictEqual(session.view().rows.length, 0);
});

/* ------------------------------------------------------------------ *
 * 9-10. Reading the other instance's answer
 * ------------------------------------------------------------------ */

function remoteRequestFor(rows, setIds) {
  return {
    setIds: setIds || [SET],
    records: rows.map((row, index) => ({ name: NAME(100 + index), guid: guid(100 + index), hash: String(index) })),
    keys: rows.map((row) => row.key),
    filtered: [],
    unsent: 0,
  };
}

const copy = (state, extra) => Object.assign({ set: 0, match: "remote", state, stateLabel: LABELS[state] || state,
  retrievedOn: "27 Oct 2026", committedOn: "", collisions: "", localState: "", localStateLabel: "" }, extra);

test("presence: every state, several copies with the most advanced named, origin-only, clone, and not found", () => {
  const rows = [];
  const view = (reply, setIds) => lens.remoteView(Object.assign({ copies: [], clones: [], content: [] }, reply),
    remoteRequestFor(rows, setIds), rows, "exampletest").lines[0].text;
  assert.strictEqual(view({ copies: [copy("committed", { committedOn: "12 Oct 2026", localStateLabel: "Complete", linked: true })] }),
    "exampletest: committed on 12 Oct 2026 (its local set is complete).");
  assert.strictEqual(view({ copies: [copy("committed", { committedOn: "12 Oct 2026", linked: false })] }),
    "exampletest: committed on 12 Oct 2026, but its local set doesn't point back.");
  assert.strictEqual(view({ copies: [copy("previewed", { collisions: "0" })] }),
    "exampletest: previewed, not committed (retrieved 27 Oct 2026, 0 collisions).");
  assert.strictEqual(view({ copies: [copy("loaded")] }), "exampletest: retrieved, not previewed.");
  assert.strictEqual(view({ copies: [copy("backedout")] }), "exampletest: backed out.", "an empty update_set is fine");
  assert.strictEqual(view({ copies: [copy("partial", { stateLabel: "Partial" })] }), "exampletest: partial.");
  const several = view({ copies: [copy("previewed"), copy("committed", { committedOn: "1 Oct 2026" })] });
  assert.match(several, /^exampletest: committed on 1 Oct 2026\. Also 1 other copy: previewed, not committed/);
  assert.match(view({ copies: [copy("previewed", { match: "origin" })] }), /^Arrived on exampletest through another instance; it names this set as its origin\./);
  assert.match(view({ clones: [0] }), /because the instance was copied, not because the set was moved/);
  assert.strictEqual(view({}), "Not found on exampletest, or not visible to your account there: no retrieved copy with this set's id.");
});

test("content: runs needs guid and hash, conflict and failures are Can't tell, and nothing says 'not there'", () => {
  const rows = ["stale", "current", "current", "current", "current", "current"].map((verdict, index) => ({ key: "k" + index, verdict }));
  const request = remoteRequestFor(rows);
  const shown = lens.remoteView({ copies: [], clones: [], content: ["other", "runs", "same", "conflict", "none", "unknown"] },
    request, rows, "exampletest");
  assert.deepStrictEqual(plain(shown.counts), { runs: 1, same: 1, other: 1, otherStale: 1, none: 1, cant: 2 });
  assert.strictEqual(shown.perRow.k0.text, "On exampletest: runs another version (already stale here)");
  assert.ok(!shown.perRow.k1, "Runs this set's version stays in the summary only");
  assert.strictEqual(shown.perRow.k2.text, "On exampletest: same content under another update");
  assert.strictEqual(shown.perRow.k3.text, "On exampletest: can't tell");
  assert.strictEqual(shown.perRow.k4.text, "On exampletest: no readable current version");
  const text = JSON.stringify(shown);
  assert.doesNotMatch(text, /not there|aren't there|isn't there/);
  assert.doesNotMatch(text, /newer|older/i, "no claim about which version is newer");
  assert.match(shown.lines[1].text, /^exampletest runs this set's version for 1 of 6 records/);
});

test("a row that differs there says when and in which set that version was saved", () => {
  const rows = ["stale", "current", "current", "current", "current"].map((verdict, index) => ({ key: "k" + index, verdict }));
  const shown = lens.remoteView({
    copies: [],
    clones: [],
    content: ["other", "same", "other", "other", "runs"],
    saved: [
      { on: "30-10-2026 12:32:27", set: "Default" },
      { on: "29-10-2026 09:00:00", set: "Hotfix" },
      { on: "1-10-2026 08:00:00", from: "Upgrade History: an upgrade" },
      null,
      { on: "30-10-2026 12:32:27", set: "Ignored" },
    ],
  }, remoteRequestFor(rows), rows, "exampletest");
  assert.strictEqual(shown.perRow.k0.text,
    "On exampletest: runs another version (already stale here), saved there 30-10-2026 12:32:27 in Default");
  assert.strictEqual(shown.perRow.k1.text, "On exampletest: same content under another update, saved there 29-10-2026 09:00:00 in Hotfix");
  assert.strictEqual(shown.perRow.k2.text,
    "On exampletest: runs another version, saved there 1-10-2026 08:00:00 from Upgrade History: an upgrade");
  assert.strictEqual(shown.perRow.k3.text, "On exampletest: runs another version", "no note, no clause");
  assert.ok(!shown.perRow.k4, "a row that runs this set's version still gets no note");
  assert.doesNotMatch(JSON.stringify(shown), /newer|older/i);
});

test("the content line counts in the singular when there is one", () => {
  const rows = [{ key: "k0", verdict: "stale" }];
  const line = (content) => lens.remoteView({ copies: [], clones: [], content }, remoteRequestFor(rows), rows, "exampletest").lines[1].text;
  assert.strictEqual(line(["other"]), "exampletest runs this set's version for 0 of 1 record; 1 runs another version (already stale here).");
  assert.strictEqual(line(["same"]), "exampletest runs this set's version for 0 of 1 record; 1 has the same content under another update.");
  assert.strictEqual(line(["none"]), "exampletest runs this set's version for 0 of 1 record; 1 has no readable current version there.");
  const two = [{ key: "a", verdict: "stale" }, { key: "b", verdict: "current" }];
  assert.strictEqual(lens.remoteView({ copies: [], clones: [], content: ["other", "other"] }, remoteRequestFor(two), two, "exampletest").lines[1].text,
    "exampletest runs this set's version for 0 of 2 records; 2 run another version (1 already stale here).");
});

test("every record running this set's version there is said as a match, and only a match so far when some weren't compared", () => {
  const rows = ["current", "stale", "current"].map((verdict, index) => ({ key: "k" + index, verdict }));
  const line = (request, content) =>
    lens.remoteView({ copies: [], clones: [], content: content || ["runs", "runs", "runs"] }, request, rows, "exampletest").lines[1];
  assert.deepStrictEqual(plain(line(remoteRequestFor(rows))),
    { kind: "ok", text: "exampletest matches: it runs this set's version for all 3 records." });
  assert.deepStrictEqual(plain(line(Object.assign(remoteRequestFor(rows), { partial: true }))),
    { kind: "ok", text: "exampletest matches so far: it runs this set's version for all 3 records compared." });
  const capped = lens.remoteView({ copies: [], clones: [], content: ["runs", "runs", "runs"] },
    Object.assign(remoteRequestFor(rows), { unsent: 5 }), rows, "exampletest");
  assert.strictEqual(capped.lines[1].text, "exampletest matches so far: it runs this set's version for all 3 records compared.");
  assert.match(capped.lines[2].text, /^Compared the first /);
  const one = [{ key: "k0", verdict: "current" }];
  assert.strictEqual(lens.remoteView({ copies: [], clones: [], content: ["runs"] }, remoteRequestFor(one), one, "exampletest").lines[1].text,
    "exampletest matches: it runs this set's version for its one record.");
  /* Not a match: flagged as differing, except same content, which is told. */
  for (const [status, kind] of [["same", "content"], ["other", "differs"], ["none", "differs"], ["unknown", "differs"]]) {
    const mixed = line(remoteRequestFor(rows), ["runs", "runs", status]);
    assert.strictEqual(mixed.kind, kind, status);
    assert.match(mixed.text, /^exampletest runs this set's version for 2 of 3 records; /);
  }
  const filtered = Object.assign(remoteRequestFor(rows.slice(0, 2)), { filtered: ["k2"] });
  assert.strictEqual(lens.remoteView({ copies: [], clones: [], content: ["runs", "runs"] }, filtered, rows, "exampletest").lines[1].kind,
    "differs", "a row that couldn't be sent is Can't tell, so not a match");
});

test("a checked row links to its record, the version that runs there, and its version history there", () => {
  const rows = ["current", "stale", "current", "current"].map((verdict, index) => ({ key: "k" + index, verdict }));
  const request = remoteRequestFor(rows);
  const other = "https://exampletest.service-now.com";
  const shown = lens.remoteView({
    copies: [],
    clones: [],
    content: ["runs", "other", "none", "unknown"],
    found: [
      { table: "sys_script_fix", record: id(70), version: id(80) },
      { version: id(81) },
      { table: "sys_script_fix", record: id(72) },
      null,
    ],
  }, request, rows, "exampletest", other);
  const labels = (key) => plain(shown.links[key].map((link) => link.label));
  assert.deepStrictEqual(labels("k0"), ["Open record", "Open version", "Version history"]);
  assert.deepStrictEqual(plain(shown.links.k0[0]), {
    label: "Open record", remote: { origin: other, table: "sys_script_fix", sysId: id(70) },
  });
  assert.deepStrictEqual(plain(shown.links.k0[1].remote), { origin: other, table: "sys_update_version", sysId: id(80) });
  assert.deepStrictEqual(plain(shown.links.k0[2].remote), { origin: other, name: request.records[0].name });
  assert.deepStrictEqual(labels("k1"), ["Open version", "Version history"], "no record found there, no record link");
  assert.deepStrictEqual(labels("k2"), ["Open record"], "no current version there: no version link, and no empty history");
  assert.deepStrictEqual(labels("k3"), ["Version history"]);
  /* A link is an origin and ids, never a URL the worker would have to trust. */
  assert.doesNotMatch(JSON.stringify(shown.links), /"url"|\.do\?/);

  assert.deepStrictEqual(plain(lens.remoteView({ copies: [], clones: [], content: ["runs", "other", "none", "unknown"] },
    request, rows, "exampletest").links), {}, "no origin, no links");
  assert.deepStrictEqual(plain(lens.remoteView({ copies: [], clones: [], content: null, contentFailure: { code: "refused" } },
    request, rows, "exampletest", other).links), {}, "nothing compared, nothing linked");
  const odd = lens.remoteView({
    copies: [], clones: [], content: ["runs", "runs", "runs", "runs"],
    found: [{ table: "Bad Table", record: id(1) }, { table: "sys_script", record: "nope" }, { version: "nope" }, "junk"],
  }, request, rows, "exampletest", other);
  ["k0", "k1", "k2", "k3"].forEach((key) => assert.deepStrictEqual(plain(odd.links[key].map((link) => link.label)),
    ["Version history"], key + ": an id that fails its pattern makes no link"));
});

test("a deleted record has no Open record link, and nor does a name that can't be queried", async () => {
  const deleted = await classifyWorld(staleWorld({ row: { action: "DELETE" } }));
  assert.ok(!deleted.view.rows[0].links.some((link) => link.record));
  const refused = await lens.recordUrl("sys_script_" + id(1) + "^ORnameLIKEx", ctxFor(fakeInstance({})));
  assert.deepStrictEqual(plain(refused), { ok: false, message: "This update's name can't be looked up safely." });
});

test("Open record finds the record the way Show Related Record does: sys_metadata, latest updated first", async () => {
  const name = "sys_script_fix_" + id(9);
  const instance = fakeInstance({
    tables: {
      sys_metadata: [
        { sys_id: id(10), sys_class_name: "sys_script_fix", sys_update_name: name, sys_updated_on: "2026-10-01 10:00:00" },
        { sys_id: id(11), sys_class_name: "sys_script_fix", sys_update_name: name, sys_updated_on: "2026-10-30 12:32:27" },
        { sys_id: id(12), sys_class_name: "sys_script", sys_update_name: "sys_script_" + id(12), sys_updated_on: "2026-10-31 00:00:00" },
      ],
    },
  });
  const found = await lens.recordUrl(name, ctxFor(instance));
  assert.deepStrictEqual(plain(found), { ok: true, url: ORIGIN + "/sys_script_fix.do?sys_id=" + id(11) });
  assert.deepStrictEqual(instance.requests.map((request) => [request.table, request.query, request.fields, request.options.displayAll]), [
    ["sys_metadata", "sys_update_name=" + name + "^ORDERBYDESCsys_updated_on", "sys_id,sys_class_name,sys_update_name", false],
  ]);
  /* A list layout's name names no sys_id, so a missing one costs no second read. */
  const layout = fakeInstance({ tables: { sys_metadata: [] } });
  assert.deepStrictEqual(plain(await lens.recordUrl("sys_ui_list_task_null", ctxFor(layout))),
    { ok: false, message: "No record found for this update." });
  assert.strictEqual(layout.requests.length, 1);
});

test("Open record falls back to the table and sys_id in the name only when a read finds the record", async () => {
  const instance = fakeInstance({
    tables: {
      sys_metadata: [],
      x_example_data: [{ sys_id: id(20) }],
    },
  }, {
    answer: (request) => (request.table === "sys_ui_form_sections" ? { ok: false, status: 400, error: "Invalid table" } : undefined),
  });
  const ctx = ctxFor(instance);
  assert.deepStrictEqual(plain(await lens.recordUrl("x_example_data_" + id(20), ctx)),
    { ok: true, url: ORIGIN + "/x_example_data.do?sys_id=" + id(20) });
  assert.deepStrictEqual(instance.requests[1], {
    table: "x_example_data", query: "sys_id=" + id(20), fields: "sys_id", limit: 1,
    options: { displayAll: false, suppressPagination: true },
  });
  assert.deepStrictEqual(plain(await lens.recordUrl("x_example_data_" + id(21), ctx)),
    { ok: false, message: "No record found for this update." }, "gone: nothing to open");
  assert.deepStrictEqual(plain(await lens.recordUrl("sys_ui_form_sections_" + id(22), ctx)),
    { ok: false, message: "No record found for this update." }, "not a table: nothing to open");
  const refused = fakeInstance({}, { answer: () => ({ ok: false, status: 403, error: "Forbidden" }) });
  assert.deepStrictEqual(plain(await lens.recordUrl("sys_script_" + id(1), ctxFor(refused))),
    { ok: false, message: "This account can't look up records here." });
});

test("a remote row the panel left out is Can't tell; a failed content read marks no row", () => {
  const rows = [{ key: "a", verdict: "current" }];
  const request = { setIds: [SET], keys: [], filtered: ["a"], unsent: 0 };
  const shown = lens.remoteView({ copies: [], clones: [], content: [] }, request, rows, "exampletest");
  assert.strictEqual(shown.perRow.a.text, "On exampletest: can't tell");
  const failed = lens.remoteView({ copies: [], clones: [], content: null, contentFailure: { code: "refused" } },
    remoteRequestFor(rows), rows, "exampletest");
  assert.deepStrictEqual(plain(failed.perRow), {});
  assert.match(failed.lines[1].text, /can't read version history/);
});

test("the request leaves out every row whose name, guid or hash fails its pattern; hashes are signed decimals", async () => {
  const subject = setRow(1);
  const names = { good: NAME(1), negative: NAME(2), comma: "sys_choice_a,b", hex: NAME(4), long: NAME(5), dot: NAME(6), min: NAME(7) };
  const world = {
    sets: [subject],
    xml: [
      xmlRow(SET, names.good, guid(1), "1234567"),
      xmlRow(SET, names.negative, guid(2), "-987654321"),
      xmlRow(SET, names.comma, guid(3), "5"),
      xmlRow(SET, names.hex, guid(4), "a1b2c3"),
      xmlRow(SET, names.long, guid(5), "12345678901"),
      xmlRow(SET, names.dot, guid(6), "12.5"),
      xmlRow(SET, names.min, guid(7), "-2147483648"),
    ],
    versions: [],
  };
  const { session } = await classifyWorld(world);
  const request = session.remoteRequest();
  assert.deepStrictEqual(plain(request.records.map((record) => record.name).sort()), [names.good, names.negative, names.min].sort());
  assert.ok(request.records.every((record) => typeof record.hash === "string"));
  assert.ok(request.records.some((record) => record.hash === "-2147483648"), "kept as the exact string");
  assert.strictEqual(request.filtered.length, 4);
  assert.deepStrictEqual(plain(request.setIds), [SET]);
});

test("why a check could not run, by the worker's code", () => {
  const cases = {
    "not-open": /isn't open in this browser/,
    asleep: /is asleep/,
    "no-receiver": /Reload that tab/,
    "signed-out": /not signed in to exampletest/,
    busy: /already running/,
    switching: /switching your session/,
    timeout: /timed out; the answer may be incomplete/,
    "source-changed": /changed while GlideLens was reading it/,
    refused: /can't read update sets/,
    malformed: /wasn't in the expected shape/,
  };
  for (const [code, pattern] of Object.entries(cases)) {
    assert.match(lens.remoteProblem({ ok: false, code }, "exampletest", "exampletest.service-now.com"), pattern, code);
  }
  assert.match(lens.remoteProblem({ ok: false, code: "refused", sourceImpersonating: true }, "exampletest"), /impersonating someone there/);
});

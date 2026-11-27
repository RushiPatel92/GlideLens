/*
 * Update Set Lens engine.
 *
 *   node --test tests/update_set_lens.test.js
 *
 * DEV-ONLY, like its siblings. The real engine runs under node:vm against a
 * simulated instance (tests/update_set_sim.js, shared with Version Lens): an
 * in-memory sys_update_set, sys_update_xml, sys_update_version and
 * sys_remote_update_set behind a small encoded-query evaluator that answers
 * the way the Table API does, including the two behaviours that shaped the
 * plan -- `name=` ignores case and trailing spaces, and X-Total-Count only
 * when asked for. Every request is kept, so a test can see what was read as
 * well as what was concluded.
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
/* The simulated instance and its row fixtures, shared with Version Lens. */
const { LABELS, plain, id, guid, fakeInstance, setRow, xmlRow, versionRow } = require("./update_set_sim.js");
const SET = id(1);

function ctxFor(instance, extra) {
  return Object.assign({ origin: ORIGIN, transport: instance.transport, sysIdFromText }, extra || {});
}

/* ------------------------------------------------------------------ *
 * Fixtures (set, update and version rows come from update_set_sim.js)
 * ------------------------------------------------------------------ */

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

test("fewer updates read than the count says is a list that may be incomplete, and a check then matches only so far", async () => {
  /* A page that comes back short (rows an ACL removed, say) ends its chunk:
   * the count is the only sign some were never read. */
  const world = staleWorld();
  world.versions = [versionRow(NAME(77), SET, "current", guid(1), "-1234567", "2026-10-01 10:00:00")];
  const short = fakeInstance(world, {
    answer: (request) => (request.table === "sys_update_xml" && request.options.withTotal
      ? { ok: true, result: [{ sys_id: { value: id(9000), display_value: id(9000) } }], total: 3 }
      : undefined),
  });
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(world.sets[0]) }, ctxFor(short), {});
  await session.prepare();
  await session.start();
  const view = session.view();
  assert.strictEqual(view.rows.length, 1);
  assert.strictEqual(view.rows[0].verdict, "current");
  assert.ok(view.banners.some((banner) => /disagree; the list may be incomplete/.test(banner.text)));
  const request = session.remoteRequest();
  assert.strictEqual(request.partial, true);
  assert.ok(short.requests.length && short.requests.every((read) => read.options.expectedOrigin === ORIGIN),
    "every read here names the instance it expects to answer");
  const shown = lens.remoteView({ copies: [], clones: [], content: ["runs"] }, request, view.rows, "exampletest", ORIGIN);
  assert.strictEqual(shown.lines[shown.lines.length - 1].text,
    "exampletest matches so far: it runs this set's version for its one record compared.");
  /* The same set, every row read: a match. */
  const whole = lens.createSession({ kind: "set", set: lens.normalizeSet(world.sets[0]) }, ctxFor(fakeInstance(world)), {});
  await whole.prepare();
  await whole.start();
  assert.strictEqual(whole.remoteRequest().partial, false);
});

test("a batch past its depth limit is only a match so far", async () => {
  const chain = [setRow(1, { name: "Release batch" })];
  for (let level = 2; level <= 9; level += 1) chain.push(setRow(level, { parent: id(level - 1) }));
  const world = {
    sets: chain,
    xml: [xmlRow(id(2), NAME(5), guid(5), "5")],
    versions: [versionRow(NAME(5), id(2), "current", guid(5), "5", "2026-10-01 10:00:00")],
  };
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(chain[0]) }, ctxFor(fakeInstance(world)), {});
  await session.prepare();
  await session.start();
  assert.ok(session.view().banners.some((banner) => /nested more than 6 levels/.test(banner.text)));
  assert.strictEqual(session.remoteRequest().partial, true);
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
  /* "Not applied here" only where it is true: a committed set's updates are
   * applied, and an unknown state makes no claim. */
  const notApplied = "Its updates aren't applied here, so there's nothing to call stale.";
  for (const state of ["loaded", "in_hierarchy", "previewing", "previewed", "previewed_in_hierarchy", "backedout", "backedout_in_hierarchy"]) {
    assert.strictEqual(screen(state).note, notApplied, state);
  }
  assert.strictEqual(screen("committed", id(1)).note, "");
  assert.strictEqual(screen("committed").note, "");
  for (const state of ["partial", "committing", "stash_committed"]) {
    assert.strictEqual(screen(state).note, "", state);
  }
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
  assert.deepStrictEqual(plain(shown.counts),
    { runs: 1, same: 1, inBatch: 0, inBatchNewest: 0, built: 0, earlier: 0, behind: 0, diverged: 0, moved: 0, other: 1,
      otherStale: 1, none: 1, cant: 2 });
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
    options: { displayAll: false, suppressPagination: true, expectedOrigin: ORIGIN },
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

/* ------------------------------------------------------------------ *
 * 11. Placing what runs there in the update's own history
 * ------------------------------------------------------------------ */

/* sys_recorded_at: hexadecimal, a fixed width here, growing with n. */
const REC = (n) => "1a1b" + String(n).padStart(14, "0");
const LV = (n, extra) => Object.assign({
  name: NAME(77), state: "previous", source: SET, sourceTable: "sys_update_set",
  guid: guid(n), hash: String(n), recordedAt: REC(n * 10),
}, extra);
const HIST = (...ns) => ns.map((n) => ({ guid: guid(n), hash: String(n) }));
const THIS = { guid: guid(12), hash: "12", setId: SET };
const OWN = new Set([SET]);
/* This set saved twice (12, 11) on top of 9 from another set; 8 is a save
 * made on another instance, so no version here; 7 and 5 are older still. */
const LINEAGE = HIST(12, 11, 9, 8, 7, 5);
const LOCAL = [
  LV(12, { state: "current" }),
  LV(11),
  LV(9, { source: OTHER }),
  LV(7, { source: id(3) }),
  LV(5, { source: id(4) }),
];
const place = (there, history, versions) =>
  plain(lens.placeThere(THIS, there, history || LINEAGE, versions || LOCAL, OWN));

test("an update's history parses as guid:hash entries, newest first, and an odd entry refuses all of it", () => {
  const text = guid(2) + ":-2147483648," + guid(1) + ":17,";
  assert.deepStrictEqual(plain(lens.parseLineage(text)), [{ guid: guid(2), hash: "-2147483648" }, { guid: guid(1), hash: "17" }]);
  assert.deepStrictEqual(plain(lens.parseLineage("")), []);
  assert.strictEqual(lens.parseLineage(guid(1) + ":17," + guid(2).toUpperCase() + ":3"), null);
  assert.strictEqual(lens.parseLineage(guid(1) + ":0x1f"), null, "never hex");
  assert.strictEqual(lens.parseLineage(guid(1)), null, "a guid without its hash");
});

test("placing: the version it was built on, an earlier save of this set, an older version, and a diverged one", () => {
  assert.deepStrictEqual(place({ guid: guid(9), hash: "9" }), { kind: "built", byContent: false });
  assert.deepStrictEqual(place({ guid: guid(11), hash: "11" }), { kind: "earlier", byContent: false });
  const one = place({ guid: guid(8), hash: "8" });
  assert.strictEqual(one.kind, "behind");
  assert.deepStrictEqual(one.since.map((version) => version.guid), [guid(9)], "a save with no version here is not counted");
  const two = place({ guid: guid(5), hash: "5" });
  assert.deepStrictEqual(two.since.map((version) => version.guid), [guid(9), guid(7)]);
  assert.deepStrictEqual(place({ guid: guid(99), hash: "99" }), { kind: "diverged" });
});

test("placing by content: the parent's content is built on, an older one is behind, both flagged", () => {
  assert.deepStrictEqual(place({ guid: guid(99), hash: "9" }), { kind: "built", byContent: true });
  assert.deepStrictEqual(place({ guid: guid(99), hash: "11" }), { kind: "earlier", byContent: true });
  const behind = place({ guid: guid(99), hash: "7" });
  assert.strictEqual(behind.kind, "behind");
  assert.strictEqual(behind.byContent, true);
  /* A save made elsewhere with the parent's content is the parent's content. */
  const twin = HIST(12, 11, 9, 8, 7, 5);
  twin[3].hash = "9";
  assert.deepStrictEqual(place({ guid: guid(8), hash: "9" }, twin), { kind: "built", byContent: true });
});

test("the history is trusted only when its parent is the newest version that ran here before this set's first save", () => {
  const there = { guid: guid(9), hash: "9" };
  assert.strictEqual(place(there, HIST(13, 11, 9)), null, "its first entry must be this capture");
  /* Another set saved the record between this set's two saves. */
  const interleaved = LOCAL.concat([LV(10, { source: OTHER, recordedAt: REC(115) })]);
  assert.strictEqual(place(there, HIST(12, 10, 11, 9, 7, 5), interleaved), null);
  /* The parent it names has no version here. */
  assert.strictEqual(place(there, HIST(12, 11, 8, 9, 7, 5)), null);
  /* A version here older than this set that the history doesn't name. */
  assert.strictEqual(place({ guid: guid(99), hash: "99" }, HIST(12, 11)), null);
  assert.strictEqual(place(there, LINEAGE, LOCAL.map((version, index) => (index === 2 ? Object.assign({}, version, { recordedAt: "" }) : version))), null,
    "a version that can't be ordered");
  assert.strictEqual(place(there, LINEAGE, LOCAL.concat([LV(6, { source: id(5), recordedAt: REC(90) })])), null,
    "two versions recorded at the same moment can't be ordered");
  assert.strictEqual(place(there, LINEAGE, []), null);
  /* A backed-out version between the parent and this set never ran last. */
  const backedOut = LOCAL.concat([LV(10, { source: id(6), state: "backedout", recordedAt: REC(100) })]);
  assert.deepStrictEqual(place(there, LINEAGE, backedOut), { kind: "built", byContent: false });
  /* A record this set creates: no parent and nothing ran here before. */
  assert.deepStrictEqual(place({ guid: guid(99), hash: "99" }, HIST(12, 11), LOCAL.slice(0, 2)), { kind: "diverged" });
});

test("in a batch, saves in any of its sets are its own", () => {
  const batch = new Set([SET, OTHER]);
  const history = HIST(12, 11, 9, 7, 5);
  assert.deepStrictEqual(plain(lens.placeThere(THIS, { guid: guid(9), hash: "9" }, history, LOCAL, batch)),
    { kind: "earlier", byContent: false });
  assert.deepStrictEqual(plain(lens.placeThere(THIS, { guid: guid(7), hash: "7" }, history, LOCAL, batch)),
    { kind: "built", byContent: false });
  /* After the batch's saves comes a save with no version here: not trusted. */
  assert.strictEqual(lens.placeThere(THIS, { guid: guid(7), hash: "7" }, LINEAGE, LOCAL, batch), null);
});

test("a version saved here after this set began, that its history doesn't name, is never placed by content", () => {
  /* 13 reverted the record to its parent's content, after this set's saves;
   * that instance runs 13 and never had 12. Content-matching it to the
   * parent would call undoing the revert safe. */
  const reverted = LOCAL.concat([LV(13, { source: id(7), hash: "9", recordedAt: REC(130) })]);
  assert.deepStrictEqual(place({ guid: guid(13), hash: "9" }, LINEAGE, reverted), { kind: "diverged" });
  /* An older copy of the parent's content, from before this set: still the
   * parent's content. */
  const copy = LOCAL.concat([LV(6, { source: id(8), hash: "9", recordedAt: REC(60) })]);
  assert.deepStrictEqual(place({ guid: guid(6), hash: "9" }, LINEAGE, copy), { kind: "built", byContent: true });
});

test("what runs there is its guid, however that instance wrote it; this capture's own entry must match its content", () => {
  /* Measured from a development instance to its sandbox: 28 rows ran a guid
   * of the history with another hash, and the payloads differed only in how
   * they were written (a currency attribute, the order of related records). */
  assert.deepStrictEqual(place({ guid: guid(9), hash: "99" }), { kind: "built", byContent: false }, "the parent, written differently");
  assert.deepStrictEqual(place({ guid: guid(11), hash: "99" }, HIST(12, 11, 8, 9, 7, 5)), null,
    "with an untrusted parent, an own save placed past the check must match exactly");
  assert.strictEqual(place({ guid: guid(8), hash: "99" }).kind, "behind");
  assert.strictEqual(plain(lens.placeThere({ guid: guid(12), hash: "999", setId: SET }, { guid: guid(9), hash: "9" }, LINEAGE, LOCAL, OWN)),
    null, "a history whose first entry isn't this capture's content: the same instance writes the same way");
});

test("one of its own saves there, exactly, is an earlier save even when the parent can't be trusted", () => {
  /* The parent this history names, 8, has no version here: nothing past it is placed. */
  const untrusted = HIST(12, 11, 8, 9, 7, 5);
  assert.strictEqual(place({ guid: guid(9), hash: "9" }, untrusted), null);
  assert.deepStrictEqual(place({ guid: guid(11), hash: "11" }, untrusted), { kind: "earlier", byContent: false });
  assert.strictEqual(place({ guid: guid(11), hash: "99" }, untrusted), null, "its guid with other content");
  assert.strictEqual(place({ guid: guid(99), hash: "11" }, untrusted), null, "its content under another guid");
  assert.strictEqual(place({ guid: guid(12), hash: "12" }, untrusted), null, "this capture itself");
  /* Another set saved the record between, so 11 is past the first save that isn't its own. */
  const interleaved = LOCAL.concat([LV(10, { source: OTHER, recordedAt: REC(115) })]);
  assert.strictEqual(place({ guid: guid(11), hash: "11" }, HIST(12, 10, 11, 8, 7, 5), interleaved), null);
  /* In a batch: another set's update of the record. */
  const batch = new Set([SET, OTHER]);
  assert.deepStrictEqual(plain(lens.placeThere(THIS, { guid: guid(9), hash: "9" }, HIST(12, 9, 8, 7, 5), LOCAL, batch)),
    { kind: "earlier", byContent: false });
});

const historyText = (...ns) => ns.map((n) => guid(n) + ":" + n).join(",");

function placingWorld() {
  const rec = (n) => ({ sys_recorded_at: REC(n) });
  const v = (name, set, state, n) => versionRow(name, set, state, guid(n), String(n), "2026-10-01 10:00:00", rec(n * 10));
  return {
    sets: [setRow(1, { name: "This work" }), setRow(2, { name: "Earlier work" }), setRow(3, { name: "Between work" })],
    xml: [
      xmlRow(SET, NAME(301), guid(12), "12", { update_guid_history: historyText(12, 11, 9) }),
      xmlRow(SET, NAME(302), guid(22), "22", { update_guid_history: historyText(22, 21, 20, 19) }),
      xmlRow(SET, NAME(303), guid(32), "32", { update_guid_history: historyText(32, 31) }),
      xmlRow(SET, NAME(304), guid(42), "42", { update_guid_history: historyText(42) }),
      xmlRow(SET, NAME(305), guid(52), "52", { update_guid_history: historyText(52) }),
    ],
    versions: [
      v(NAME(301), SET, "current", 12), v(NAME(301), SET, "previous", 11), v(NAME(301), id(2), "previous", 9),
      v(NAME(302), SET, "current", 22), v(NAME(302), id(2), "previous", 21), v(NAME(302), id(3), "previous", 20),
      v(NAME(302), id(2), "previous", 19),
      v(NAME(303), SET, "current", 32), v(NAME(303), SET, "previous", 31),
      v(NAME(304), SET, "current", 42),
      v(NAME(305), SET, "current", 52),
    ],
  };
}

/* The other instance's answer, by name: a status, what runs there, and
 * whether this update's own version was there (false, read and never there,
 * unless given). */
function placingReply(request, byName) {
  const content = request.records.map((record) => (byName[record.name] || ["runs"])[0]);
  return {
    copies: [],
    clones: [],
    content,
    running: request.records.map((record) => (byName[record.name] || [])[1] || null),
    moved: request.records.map((record, index) => {
      const given = (byName[record.name] || [])[2];
      return given !== undefined ? given : content[index] === "other" ? false : null;
    }),
  };
}

const keyOf = (view, name) => view.rows.find((row) => row.name === name).key;

test("after a check, rows that run another version are placed from reads here, never by guid or hash", async () => {
  const { session, instance, view } = await classifyWorld(placingWorld());
  assert.ok(view.rows.every((row) => row.verdict === "current"));
  const request = session.remoteRequest();
  const reply = placingReply(request, {
    [NAME(301)]: ["other", guid(9) + ":9"],
    [NAME(302)]: ["other", guid(19) + ":19"],
    [NAME(303)]: ["other", guid(99) + ":99"],
    [NAME(305)]: ["other", null],
  });
  const before = instance.requests.length;
  let calls = 0;
  const placed = await session.placeRemote(reply, request, () => { calls += 1; });
  assert.strictEqual(calls, 1, "told once, before its first read");
  assert.strictEqual(placed.get(keyOf(view, NAME(301))).kind, "built");
  const behind = placed.get(keyOf(view, NAME(302)));
  assert.strictEqual(behind.kind, "behind");
  assert.deepStrictEqual(plain(behind.since), { count: 2, sources: ["“Earlier work”", "“Between work”"] });
  assert.strictEqual(placed.get(keyOf(view, NAME(303))).kind, "diverged");
  assert.ok(!placed.has(keyOf(view, NAME(304))), "runs this set's version: nothing to place");
  assert.ok(!placed.has(keyOf(view, NAME(305))), "no version named there: nothing to place");

  const reads = instance.requests.slice(before);
  const xmlReads = reads.filter((read) => read.table === "sys_update_xml");
  assert.strictEqual(xmlReads.length, 1);
  assert.match(xmlReads[0].query, /^sys_idIN[0-9a-f,]+$/);
  assert.strictEqual(xmlReads[0].fields, "sys_id,update_guid,update_guid_history");
  assert.strictEqual(xmlReads[0].options.displayAll, false);
  const versionReads = reads.filter((read) => read.table === "sys_update_version");
  assert.strictEqual(versionReads.length, 1);
  assert.strictEqual(versionReads[0].query, "nameIN" + [NAME(301), NAME(302), NAME(303)].join(","), "every state, by name");
  assert.ok(versionReads[0].fields.split(",").includes("sys_recorded_at"));
  assert.ok(reads.every((read) => !/(?:^|\^)(?:update_guid|payload_hash)(?:=|IN)/.test(read.query)));
  assert.ok(reads.every((read) => read.options.suppressPagination === true));
  assert.ok(reads.some((read) => read.table === "sys_update_set" && /sys_id(IN|=)/.test(read.query)), "the sets between, by id");

  const shown = lens.remoteView(reply, request, session.view().rows, "exampletest", ORIGIN, placed);
  assert.strictEqual(shown.perRow[keyOf(view, NAME(301))].text, "On exampletest: runs the version this set was built on");
  assert.strictEqual(shown.perRow[keyOf(view, NAME(302))].text,
    "On exampletest: runs an older version of this update. Missing on exampletest: 2 changes saved here since, " +
    "in “Earlier work” and “Between work”; promoting this set brings them too");
  assert.strictEqual(shown.perRow[keyOf(view, NAME(303))].text,
    "On exampletest: runs a version that isn't in this update's history. Promoting this set replaces it");
  assert.strictEqual(shown.perRow[keyOf(view, NAME(305))].text, "On exampletest: runs another version");
});

test("nothing to place reads nothing; a capture saved again since, or a failed read, leaves its row unplaced", async () => {
  const quiet = await classifyWorld(placingWorld());
  const request = quiet.session.remoteRequest();
  const before = quiet.instance.requests.length;
  let calls = 0;
  const none = await quiet.session.placeRemote(placingReply(request, {}), request, () => { calls += 1; });
  assert.strictEqual(none.size, 0);
  assert.strictEqual(calls, 0);
  assert.strictEqual(quiet.instance.requests.length, before, "no read at all");

  const world = placingWorld();
  const moved = await classifyWorld(world);
  /* Saved again after the run: the row on screen is no longer this capture. */
  world.xml[0].update_guid = guid(13);
  const movedRequest = moved.session.remoteRequest();
  const movedPlaced = await moved.session.placeRemote(
    placingReply(movedRequest, { [NAME(301)]: ["other", guid(9) + ":9"], [NAME(303)]: ["other", guid(99) + ":99"] }), movedRequest);
  assert.ok(!movedPlaced.has(keyOf(moved.view, NAME(301))));
  assert.strictEqual(movedPlaced.get(keyOf(moved.view, NAME(303))).kind, "diverged");

  const failing = fakeInstance(placingWorld(), {
    answer: (read) => (read.table === "sys_update_xml" && /update_guid_history/.test(read.fields)
      ? { ok: false, status: 500, error: "HTTP 500" } : undefined),
  });
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(placingWorld().sets[0]) }, ctxFor(failing), {});
  await session.prepare();
  await session.start();
  const failedRequest = session.remoteRequest();
  const failed = await session.placeRemote(placingReply(failedRequest, { [NAME(301)]: ["other", guid(9) + ":9"] }), failedRequest);
  assert.strictEqual(failed.size, 0);
});

test("placed rows read as such, keep the stale mark and the where-saved note, and say what an older one is missing", () => {
  const rows = ["stale", "current", "current", "current", "current", "current"].map((verdict, index) => ({ key: "k" + index, verdict }));
  const placed = new Map([
    ["k0", { kind: "built", byContent: false }],
    ["k1", { kind: "earlier", byContent: true }],
    ["k2", { kind: "behind", byContent: false, since: { count: 1, sources: ["“Earlier work”"] } }],
    ["k3", { kind: "diverged" }],
  ]);
  const shown = lens.remoteView({
    copies: [],
    clones: [],
    content: ["other", "other", "other", "other", "other", "runs"],
    saved: [{ on: "18-10-2025 10:23:56", set: "Earlier work" }, null, null, { on: "1-11-2026 09:00:00", set: "Default" }, null, null],
    moved: [false, false, false, false, false, null],
  }, remoteRequestFor(rows), rows, "exampletest", ORIGIN, placed);
  assert.strictEqual(shown.perRow.k0.kind, "built");
  assert.strictEqual(shown.perRow.k0.text,
    "On exampletest: runs the version this set was built on (already stale here), saved there 18-10-2025 10:23:56 in Earlier work");
  assert.strictEqual(shown.perRow.k1.text, "On exampletest: runs an earlier save of this set (matched by content)");
  assert.strictEqual(shown.perRow.k2.text,
    "On exampletest: runs an older version of this update. Missing on exampletest: the change saved here in “Earlier work”; " +
    "promoting this set brings it too");
  assert.strictEqual(shown.perRow.k3.text,
    "On exampletest: runs a version that isn't in this update's history, saved there 1-11-2026 09:00:00 in Default. " +
    "Promoting this set replaces it");
  assert.strictEqual(shown.perRow.k4.text, "On exampletest: runs another version");
  assert.deepStrictEqual(plain(shown.counts),
    { runs: 1, same: 0, inBatch: 0, inBatchNewest: 0, built: 1, earlier: 1, behind: 1, diverged: 1, moved: 0, other: 1,
      otherStale: 0, none: 0, cant: 0 });
  assert.deepStrictEqual(plain(shown.lines.slice(1)), [{
    kind: "differs",
    text: "exampletest runs this set's version for 1 of 6 records; 1 runs the version this set was built on; " +
      "1 runs an earlier save of this set; 1 runs an older version, missing changes saved here since; " +
      "1 runs a version that isn't in its update's history; 1 runs another version.",
  }], "no all-clear while anything is older, diverged or unplaced");
});

test("each answer also comes in parts for the panel's card: what it runs, notes, where it was saved, and what promoting does", () => {
  const rows = ["stale", "current", "current", "current", "current", "current", "current", "current"]
    .map((verdict, index) => ({ key: "k" + index, verdict }));
  const placed = new Map([
    ["k0", { kind: "built", byContent: false }],
    ["k1", { kind: "earlier", byContent: true, batch: true }],
    ["k2", { kind: "behind", byContent: false, since: { count: 2, sources: ["“A”", "“B”", "“C”"] } }],
    ["k3", { kind: "diverged" }],
  ]);
  const request = remoteRequestFor(rows);
  request.filtered = ["k8"];
  const shown = lens.remoteView({
    copies: [],
    clones: [],
    content: ["other", "other", "other", "other", "other", "runs", "same", "none"],
    saved: [{ on: "18-10-2025 10:23:56", set: "Earlier work" }, null, null, { on: "1-11-2026 09:00:00", from: "an upgrade" }, null, null,
      { on: "2-11-2026 08:00:00", set: "Twin" }, null],
    moved: [false, false, false, false, true, null, null, null],
  }, request, rows.concat([{ key: "k8", verdict: "current" }, { key: "k9", verdict: "current" }]), "exampletest", ORIGIN, placed);
  assert.deepStrictEqual(plain(shown.parts.k9), { kind: "unsent", say: "Not compared", notes: [], saved: null,
    then: "Check on compares the first 2,000 updates checked here" }, "a row past what the check sent");
  assert.strictEqual(shown.perRow.k9, undefined, "and never a difference");
  const part = (key) => plain(shown.parts[key]);
  assert.deepStrictEqual(part("k0"), { kind: "built", say: "Runs the version this set was built on", notes: ["already stale here"],
    saved: { on: "18-10-2025 10:23:56", set: "Earlier work", from: "" }, then: "" });
  assert.deepStrictEqual(part("k1"), { kind: "earlier", say: "Runs an earlier save of this batch", notes: ["matched by content"],
    saved: null, then: "" });
  assert.deepStrictEqual(part("k2"), { kind: "behind", say: "Runs an older version of this update", notes: [], saved: null,
    then: "Missing 2 changes saved here since, in “A”, “B” and 1 more; promoting this set brings them too" });
  assert.deepStrictEqual(part("k3"), { kind: "diverged", say: "Runs a version that isn't in this update's history", notes: [],
    saved: { on: "1-11-2026 09:00:00", set: "", from: "an upgrade" }, then: "Promoting this set replaces it" });
  assert.deepStrictEqual(part("k4"), { kind: "moved", say: "Had this set's version, and it has since been changed", notes: [],
    saved: null, then: "Promoting this set again undoes that change" });
  assert.deepStrictEqual(part("k5"), { kind: "runs", say: "Runs this set's version", notes: [], saved: null, then: "" },
    "a row that matches has parts, but no sentence");
  assert.strictEqual(shown.perRow.k5, undefined);
  assert.deepStrictEqual(part("k6"), { kind: "same", say: "Same content under another update", notes: [],
    saved: { on: "2-11-2026 08:00:00", set: "Twin", from: "" }, then: "" });
  assert.deepStrictEqual(part("k7"), { kind: "none", say: "No readable current version", notes: [], saved: null, then: "" });
  assert.deepStrictEqual(part("k8"), { kind: "cant", say: "Can't tell", notes: [], saved: null, then: "" }, "a row left out of the request");
  /* The sentence is the same pieces with the instance named first. */
  assert.strictEqual(shown.perRow.k2.text, "On exampletest: runs an older version of this update. Missing on exampletest: " +
    "2 changes saved here since, in “A”, “B” and 1 more; promoting this set brings them too");
  assert.strictEqual(shown.perRow.k3.text, "On exampletest: runs a version that isn't in this update's history, " +
    "saved there 1-11-2026 09:00:00 from an upgrade. Promoting this set replaces it");
  assert.strictEqual(shown.perRow.k4.text,
    "On exampletest: had this set's version, and it has since been changed. Promoting this set again undoes that change");
  assert.deepStrictEqual(plain(lens.remoteView({ copies: [], clones: [] }, request, rows, "exampletest", ORIGIN).parts), {},
    "nothing compared, nothing in parts");
});

test("a row also hands the panel its explanation without the verdict word, and the newer save as facts", async () => {
  const { view } = await classifyWorld(staleWorld());
  const stale = view.rows[0];
  assert.strictEqual(stale.verdict, "stale");
  assert.strictEqual(stale.explain, stale.text);
  assert.deepStrictEqual(plain(stale.newerSave), { by: "dev.one", on: "D(2026-10-05 10:00:00)", committedHere: false },
    "the time as the instance displays it");
  const committed = (await classifyWorld(staleWorld({ newerSet: { remote_sys_id: id(40) } }))).view.rows[0];
  assert.strictEqual(committed.newerSave.committedHere, true);
  const unversioned = staleWorld();
  unversioned.versions = [];
  const cant = (await classifyWorld(unversioned)).view.rows[0];
  assert.strictEqual(cant.verdict, "cant");
  assert.strictEqual(cant.text, "Can't tell: No readable version history.");
  assert.strictEqual(cant.explain, "No readable version history.");
  assert.strictEqual(cant.newerSave, null);
});

test("when every record there runs this set's version or one it was built on, promoting replaces nothing there", () => {
  const rows = ["current", "current", "current"].map((verdict, index) => ({ key: "k" + index, verdict }));
  const placed = new Map([["k1", { kind: "built", byContent: false }], ["k2", { kind: "earlier", byContent: false, batch: true }]]);
  const reply = { copies: [], clones: [], content: ["runs", "other", "other"], moved: [null, false, false] };
  const lines = (request) => plain(lens.remoteView(reply, request, rows, "exampletest", ORIGIN, placed).lines.slice(1));
  assert.deepStrictEqual(lines(remoteRequestFor(rows, [SET, OTHER])), [
    { kind: "ok", text: "Promoting this set replaces nothing changed on exampletest: every record there runs this set's version or one it was built on." },
    { kind: "content", text: "exampletest runs this set's version for 1 of 3 records; 1 runs the version this set was built on; 1 runs an earlier save of this batch." },
  ]);
  assert.strictEqual(lines(Object.assign(remoteRequestFor(rows), { partial: true }))[0].text,
    "So far, promoting this set replaces nothing changed on exampletest: every record compared runs this set's version or one it was built on.");
  const many = lens.remoteView({ copies: [], clones: [], content: ["other"] }, remoteRequestFor(rows.slice(0, 1)), rows.slice(0, 1),
    "exampletest", ORIGIN, new Map([["k0", { kind: "behind", since: { count: 3, sources: ["“A”", "“B”", "an upgrade"] } }]]));
  assert.strictEqual(many.perRow.k0.text, "On exampletest: runs an older version of this update. Missing on exampletest: " +
    "3 changes saved here since, in “A”, “B” and 1 more; promoting this set brings them too");
  assert.strictEqual(many.lines[1].kind, "differs");
});

test("a row whose own version was there and has since been changed says so, whatever its history places", () => {
  /* Measured on a test instance's release batches: a set committed there
   * after a newer one names that newer version as its parent, so the
   * history alone showed 7 rows as safe that had run this version first. */
  const rows = ["stale", "current", "current", "current", "current"].map((verdict, index) => ({ key: "k" + index, verdict }));
  const placed = new Map([
    ["k0", { kind: "built", byContent: false }],
    ["k1", { kind: "earlier", byContent: false }],
    ["k2", { kind: "diverged" }],
    ["k3", { kind: "behind", byContent: false, since: { count: 1, sources: ["“A”"] } }],
  ]);
  const shown = lens.remoteView({
    copies: [],
    clones: [],
    content: ["other", "other", "other", "other", "other"],
    saved: [{ on: "12-10-2026 05:44:43", set: "Newer work" }, null, null, null, null],
    moved: [true, true, true, false, true],
  }, remoteRequestFor(rows), rows, "exampletest", ORIGIN, placed);
  assert.deepStrictEqual(["k0", "k1", "k2", "k3", "k4"].map((key) => shown.perRow[key].kind),
    ["moved", "moved", "moved", "behind", "moved"]);
  assert.strictEqual(shown.perRow.k0.text,
    "On exampletest: had this set's version, and it has since been changed (already stale here), " +
    "saved there 12-10-2026 05:44:43 in Newer work. Promoting this set again undoes that change");
  assert.strictEqual(shown.counts.moved, 4);
  assert.strictEqual(shown.counts.built + shown.counts.earlier, 0);
  assert.deepStrictEqual(plain(shown.lines.slice(1)), [{
    kind: "differs",
    text: "exampletest runs this set's version for 0 of 5 records; 1 runs an older version, missing changes saved here since; " +
      "4 had this set's version and changed it since.",
  }], "no all-clear");
});

test("built and earlier need the other instance's word that this version was never there", () => {
  const rows = ["current", "current"].map((verdict, index) => ({ key: "k" + index, verdict }));
  const placed = new Map([["k0", { kind: "built", byContent: false }], ["k1", { kind: "earlier", byContent: false }]]);
  const shown = (moved) => lens.remoteView(Object.assign({ copies: [], clones: [], content: ["other", "other"] }, moved),
    remoteRequestFor(rows), rows, "exampletest", ORIGIN, placed);
  const kinds = (view) => [view.perRow.k0.kind, view.perRow.k1.kind];
  assert.deepStrictEqual(kinds(shown({ moved: [false, false] })), ["built", "earlier"]);
  assert.strictEqual(shown({ moved: [false, false] }).lines[1].kind, "ok");
  /* Not read there (a failed or overfull read, or no answer at all): unknown. */
  assert.deepStrictEqual(kinds(shown({ moved: [null, false] })), ["other", "earlier"]);
  assert.deepStrictEqual(kinds(shown({})), ["other", "other"]);
  assert.deepStrictEqual(kinds(shown({ moved: null })), ["other", "other"]);
  assert.ok(shown({}).lines.every((line) => line.kind !== "ok"), "no all-clear without that word");
  assert.strictEqual(shown({}).perRow.k0.text, "On exampletest: runs another version");
});

test("a row whose own version was there is never placed, so it costs no read here", async () => {
  const { session, instance, view } = await classifyWorld(placingWorld());
  const request = session.remoteRequest();
  const before = instance.requests.length;
  const placed = await session.placeRemote(placingReply(request, {
    [NAME(301)]: ["other", guid(9) + ":9", true],
    [NAME(303)]: ["other", guid(99) + ":99"],
  }), request);
  assert.ok(!placed.has(keyOf(view, NAME(301))));
  assert.strictEqual(placed.get(keyOf(view, NAME(303))).kind, "diverged");
  const versionReads = instance.requests.slice(before).filter((read) => read.table === "sys_update_version");
  assert.deepStrictEqual(versionReads.map((read) => read.query), ["name=" + NAME(303)], "only the row still to place");
  const none = await session.placeRemote(placingReply(request, { [NAME(301)]: ["other", guid(9) + ":9", true] }), request);
  assert.strictEqual(none.size, 0);
});

/* The other instance's answer for a batch, by each row's own guid: a
 * status, what runs there, and whether this update's own version was there. */
function batchReply(request, byGuid, saved) {
  const at = (record, index) => (byGuid[record.guid] || ["runs", null, null])[index];
  return {
    copies: [],
    clones: [],
    content: request.records.map((record) => at(record, 0)),
    running: request.records.map((record) => at(record, 1)),
    moved: request.records.map((record) => at(record, 2)),
    saved: request.records.map((record) => (saved && saved[record.guid]) || null),
  };
}

test("a row its batch replaces, where the other instance runs the batch's newer update, is told so in grey and costs no read", async () => {
  /* Measured on a test instance's release batches: 165 of 273 rows that
   * instance had once run were rows like this one, running the batch's own
   * newer update, and each was told "changed there since". */
  const world = batchWorld();
  const instance = fakeInstance(world);
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(world.sets[0]) }, ctxFor(instance), {});
  await session.prepare();
  await session.start();
  const replaced = session.view().rows.find((row) => row.guid === guid(1));
  assert.strictEqual(replaced.verdict, "batch");
  const request = session.remoteRequest();
  const reply = batchReply(request, { [guid(1)]: ["other", guid(2) + ":2", true] },
    { [guid(1)]: { on: "29-10-2026 07:34:36", set: "Child B" } });
  const before = instance.requests.length;
  let calls = 0;
  const placed = await session.placeRemote(reply, request, () => { calls += 1; });
  assert.strictEqual(placed.size, 0);
  assert.strictEqual(calls, 0);
  assert.strictEqual(instance.requests.length, before, "no read for a row its batch replaces");
  /* Nor when that instance never had this update's own version. */
  const neverThere = batchReply(request, { [guid(1)]: ["other", guid(2) + ":2", false] });
  assert.strictEqual((await session.placeRemote(neverThere, request)).size, 0);
  assert.strictEqual(instance.requests.length, before);

  const shown = lens.remoteView(reply, request, session.view().rows, "exampletest", ORIGIN, placed);
  assert.deepStrictEqual(plain(shown.perRow[replaced.key]), {
    kind: "inbatch",
    text: "On exampletest: runs this batch's newest update of it, saved there 29-10-2026 07:34:36 in Child B",
  });
  assert.strictEqual(shown.counts.moved, 0, "had this update's version, but the batch itself moved it on");
  assert.strictEqual(shown.counts.inBatch, 1);
  assert.deepStrictEqual(plain(shown.lines[shown.lines.length - 1]),
    { kind: "ok", text: "exampletest matches: every record runs this batch's newest update of it." });
});

test("a row its batch replaces is never told it changed there, nor placed: only the batch's own update there is grey", () => {
  const R = (key, verdict, n, g) => ({ key, verdict, name: NAME(n), guid: guid(g), hash: String(g) });
  const rows = [
    R("k0", "batch", 1, 200), // there runs k1, the batch's newest
    R("k1", "current", 1, 201),
    R("k2", "batch", 2, 210), // there runs k3, which the batch replaces too
    R("k3", "batch", 2, 211),
    R("k4", "current", 2, 212), // the newest, and there runs an older one: another version
    R("k5", "batch", 3, 220), // there runs a version from outside the batch, and once ran this one
    R("k6", "batch", 4, 230), // k7's guid there, with other content, and once ran this one
    R("k7", "current", 4, 231),
    R("k8", "batch", 5, 240), // k1's update there, but k1 is another record
    R("k9", "batch", 6, 250), // a reply naming this row's own update: not a sibling
  ];
  const request = {
    setIds: [SET, OTHER],
    records: rows.map((row) => ({ name: row.name, guid: row.guid, hash: row.hash })),
    keys: rows.map((row) => row.key),
    filtered: [],
    unsent: 0,
  };
  const there = (g, hash) => guid(g) + ":" + hash;
  const placed = new Map([["k2", { kind: "built", byContent: false }], ["k5", { kind: "diverged" }]]);
  const shown = lens.remoteView({
    copies: [],
    clones: [],
    content: ["other", "runs", "other", "runs", "other", "other", "other", "runs", "other", "other"],
    running: [there(201, 201), null, there(211, 211), null, there(211, 211), there(999, 999), there(231, 999), null,
      there(201, 201), there(250, 250)],
    moved: [true, null, false, null, false, true, true, null, false, false],
  }, request, rows, "exampletest", ORIGIN, placed);
  assert.deepStrictEqual(["k0", "k2", "k4", "k5", "k6", "k8", "k9"].map((key) => shown.perRow[key].kind),
    ["inbatch", "inbatch", "other", "moved", "moved", "other", "other"]);
  assert.strictEqual(shown.perRow.k0.text, "On exampletest: runs this batch's newest update of it");
  assert.strictEqual(shown.perRow.k2.text, "On exampletest: runs another update of this batch");
  /* Moved off this version to something outside the batch: said, whatever
   * its batch does, and never placed (k5's placing is ignored). */
  assert.strictEqual(shown.perRow.k5.text,
    "On exampletest: had this set's version, and it has since been changed. Promoting this set again undoes that change");
  assert.deepStrictEqual(plain(shown.counts), {
    runs: 3, same: 0, inBatch: 2, inBatchNewest: 1, built: 0, earlier: 0, behind: 0, diverged: 0, moved: 2, other: 3,
    otherStale: 0, none: 0, cant: 0,
  });
  assert.deepStrictEqual(plain(shown.lines.slice(1)), [{
    kind: "differs",
    text: "exampletest runs this set's version for 3 of 10 records; 2 run another update of this batch; " +
      "2 had this set's version and changed it since; 3 run another version.",
  }]);
});

test("the batch's own update there counts towards a match, and towards replacing nothing", () => {
  const R = (key, verdict, g) => ({ key, verdict, name: NAME(1), guid: guid(g), hash: String(g) });
  const request = (rows, extra) => Object.assign({
    setIds: [SET, OTHER],
    records: rows.map((row) => ({ name: row.name, guid: row.guid, hash: row.hash })),
    keys: rows.map((row) => row.key),
    filtered: [],
    unsent: 0,
  }, extra);
  const reply = (content, running, moved) => ({ copies: [], clones: [], content, running, moved });

  const newest = [R("k0", "batch", 300), R("k1", "current", 301)];
  const matched = reply(["other", "runs"], [guid(301) + ":301", null], [true, null]);
  assert.deepStrictEqual(plain(lens.remoteView(matched, request(newest), newest, "exampletest", ORIGIN).lines.slice(1)),
    [{ kind: "ok", text: "exampletest matches: every record runs this batch's newest update of it." }]);
  assert.strictEqual(lens.remoteView(matched, request(newest, { partial: true }), newest, "exampletest", ORIGIN).lines[1].text,
    "exampletest matches so far: every record compared runs this batch's newest update of it.");
  /* There runs an update the batch replaces, and the newest wasn't compared:
   * not a match, even so far. */
  const older = [R("k0", "batch", 320), R("k1", "batch", 321)];
  const unsure = lens.remoteView(reply(["runs", "other"], [null, guid(320) + ":320"], [null, false]),
    request(older, { unsent: 1 }), older, "exampletest", ORIGIN);
  assert.strictEqual(unsure.perRow.k1.kind, "inbatch");
  assert.ok(unsure.lines.every((line) => line.kind !== "ok"));

  /* There runs the batch's first update: no match, but promoting moves it
   * forward through the batch's own work. */
  const first = [R("k0", "batch", 310), R("k1", "batch", 311), R("k2", "current", 312)];
  const shown = lens.remoteView(
    reply(["runs", "other", "other"], [null, guid(310) + ":310", guid(310) + ":310"], [null, false, false]),
    request(first), first, "exampletest", ORIGIN, new Map([["k2", { kind: "earlier", byContent: false, batch: true }]]));
  assert.deepStrictEqual(plain(shown.lines.slice(1)), [
    { kind: "ok", text: "Promoting this set replaces nothing changed on exampletest: every record there runs this set's version or one it was built on." },
    { kind: "content", text: "exampletest runs this set's version for 1 of 3 records; 1 runs another update of this batch; 1 runs an earlier save of this batch." },
  ]);
});

test("the batch's newest update, where the other instance runs an older update of the batch, is an earlier save of it", async () => {
  /* Measured on a test instance's release batches: 12 of 16 such rows named
   * a parent with no version here, and kept "runs another version". */
  const check = async (history) => {
    const world = batchWorld();
    world.xml[1].update_guid_history = history;
    world.versions.forEach((version, index) => { version.sys_recorded_at = REC([20, 10, 30][index]); });
    const session = lens.createSession({ kind: "set", set: lens.normalizeSet(world.sets[0]) }, ctxFor(fakeInstance(world)), {});
    await session.prepare();
    await session.start();
    const rows = session.view().rows;
    const newest = rows.find((row) => row.guid === guid(2));
    assert.strictEqual(newest.verdict, "current");
    assert.strictEqual(rows.find((row) => row.guid === guid(1)).verdict, "batch");
    const request = session.remoteRequest();
    const reply = batchReply(request, { [guid(2)]: ["other", guid(1) + ":1", false] });
    const placed = await session.placeRemote(reply, request);
    return { placed, newest, shown: lens.remoteView(reply, request, rows, "exampletest", ORIGIN, placed) };
  };
  const placedIt = await check(historyText(2, 1, 8));
  assert.deepStrictEqual(plain(placedIt.placed.get(placedIt.newest.key)), { kind: "earlier", byContent: false, batch: true });
  assert.deepStrictEqual(plain(placedIt.shown.perRow[placedIt.newest.key]),
    { kind: "earlier", text: "On exampletest: runs an earlier save of this batch" });
  assert.deepStrictEqual(plain(placedIt.shown.lines.slice(1)), [
    { kind: "ok", text: "Promoting this set replaces nothing changed on exampletest: every record there runs this set's version or one it was built on." },
    { kind: "content", text: "exampletest runs this set's version for 2 of 3 records; 1 runs an earlier save of this batch." },
  ]);
  /* A save from outside the batch between the two: promoting would also
   * bring that save, so the row is not placed. */
  const between = await check(historyText(2, 8, 1));
  assert.strictEqual(between.placed.size, 0);
  assert.strictEqual(between.shown.perRow[between.newest.key].kind, "other");
});

/* ------------------------------------------------------------------ *
 * 9. Sets checked together: one story's separate sets
 *
 * A story's work often sits in separate sets named for it ("… V1", "V2",
 * "V3"), not a batch. Checked one at a time, a newer version in a sibling
 * reads Stale; checked together it is "in these sets", and the sets must be
 * committed in an order that leaves each record's newest version last.
 * ------------------------------------------------------------------ */

const V1 = id(11);
const V2 = id(12);
const V3 = id(13);

function storyWorld() {
  return {
    sets: [
      setRow(11, { name: "Team_STRY0000101_AB_V1", sys_created_on: "2026-10-01 09:00:00" }),
      setRow(12, { name: "Team_STRY0000101_AB_V2", sys_created_on: "2026-10-03 09:00:00" }),
      setRow(13, { name: "Team_STRY0000101_CD_V3", state: "in progress", sys_created_on: "2026-10-05 09:00:00" }),
      setRow(14, { name: "Team_STRY0000101_old", state: "ignore", sys_created_on: "2026-09-01 09:00:00" }),
      /* A longer number that merely contains the story's: never one of its sets. */
      setRow(15, { name: "Team_STRY00001012_other", sys_created_on: "2026-10-02 09:00:00" }),
      setRow(16, { name: "Team_STRY0000202_V1", sys_created_on: "2026-10-07 09:00:00" }),
    ],
    xml: [
      xmlRow(V1, NAME(1), guid(1), "1"),
      xmlRow(V3, NAME(1), guid(3), "3"),
      xmlRow(V2, NAME(2), guid(4), "4"),
      xmlRow(V1, NAME(2), guid(5), "5"),
      xmlRow(V2, NAME(3), guid(6), "7"),
      xmlRow(V3, NAME(3), guid(7), "7"),
      xmlRow(V2, NAME(4), guid(8), "8"),
      xmlRow(id(16), NAME(4), guid(9), "9"),
      xmlRow(V3, NAME(5), guid(10), "10"),
    ],
    versions: [
      /* NAME(1): V3 holds the newest; V1 the older. Creation order works. */
      versionRow(NAME(1), V3, "current", guid(3), "3", "2026-10-05 10:00:00"),
      versionRow(NAME(1), V1, "previous", guid(1), "1", "2026-10-01 10:00:00"),
      /* NAME(2): V1 was saved again after V2, so V1 must go after V2. */
      versionRow(NAME(2), V1, "current", guid(5), "5", "2026-10-06 10:00:00"),
      versionRow(NAME(2), V2, "previous", guid(4), "4", "2026-10-03 10:00:00"),
      /* NAME(3): the same content in V2 and V3: no order asked. */
      versionRow(NAME(3), V3, "current", guid(7), "7", "2026-10-05 11:00:00"),
      versionRow(NAME(3), V2, "previous", guid(6), "7", "2026-10-03 11:00:00"),
      /* NAME(4): another story changed it since: Stale stays Stale. */
      versionRow(NAME(4), id(16), "current", guid(9), "9", "2026-10-08 10:00:00"),
      versionRow(NAME(4), V2, "previous", guid(8), "8", "2026-10-03 12:00:00"),
      versionRow(NAME(5), V3, "current", guid(10), "10", "2026-10-05 12:00:00"),
    ],
  };
}

const storySet = (world, n) => lens.normalizeSet(world.sets.find((row) => row.sys_id === id(n)));
const storyReads = (instance) => instance.requests.filter((request) => /^nameLIKE/.test(request.query));

test("a story number is one whole token, uppercased; a longer number or a letter run-in is not it", () => {
  assert.strictEqual(lens.storyToken("Team.App_STRY0000101_New form_AB_V1"), "STRY0000101");
  assert.strictEqual(lens.storyToken("stry0000101 fix"), "STRY0000101");
  assert.strictEqual(lens.storyToken("Release20261101"), "", "seven letters is a word, not a prefix");
  assert.strictEqual(lens.storyToken("Set 1"), "");
  assert.strictEqual(lens.namesStory("Fix STRY0000101-V2", "STRY0000101"), true);
  assert.strictEqual(lens.namesStory("Team_STRY00001012_other", "STRY0000101"), false);
  assert.strictEqual(lens.namesStory("XSTRY0000101", "STRY0000101"), false);
});

test("typing a story number lists its sets oldest first, live ones ticked, in one read", async () => {
  const world = storyWorld();
  const instance = fakeInstance(world);
  const result = await lens.resolveUpdateSetInput("stry0000101", ctxFor(instance));
  assert.strictEqual(result.kind, "story");
  assert.strictEqual(result.story, "STRY0000101");
  assert.deepStrictEqual(plain(result.sets.map((set) => set.sysId)), [id(14), V1, V2, V3], "the longer number is left out");
  assert.deepStrictEqual(plain(result.preselected), [V1, V2, V3], "an Ignore set is listed, not ticked");
  assert.strictEqual(result.more, false);
  assert.strictEqual(instance.requests.length, 1);
  assert.strictEqual(instance.requests[0].query, "nameLIKESTRY0000101^ORDERBYsys_created_on");

  const one = await lens.resolveUpdateSetInput("STRY0000202", ctxFor(fakeInstance(world)));
  assert.deepStrictEqual([one.kind, one.set.sysId], ["set", id(16)], "one set opens as itself");
  const none = await lens.resolveUpdateSetInput("STRY0000999", ctxFor(fakeInstance(world)));
  assert.strictEqual(none.kind, "none", "no set for it falls back to the name search");
});

test("more than 50 sets for one story says so", async () => {
  const sets = Array.from({ length: 52 }, (_, index) => setRow(100 + index, {
    name: "STRY0000404 part " + index, sys_created_on: "2026-10-01 10:" + String(index).padStart(2, "0") + ":00",
  }));
  const result = await lens.resolveUpdateSetInput("STRY0000404", ctxFor(fakeInstance({ sets })));
  assert.strictEqual(result.kind, "story");
  assert.strictEqual(result.sets.length, 50);
  assert.strictEqual(result.more, true);
});

test("sets checked together: a sibling's newer version is in these sets, another story's is still Stale", async () => {
  const world = storyWorld();
  const instance = fakeInstance(world);
  const session = lens.createSession(
    { kind: "group", sets: [storySet(world, 13), storySet(world, 11), storySet(world, 12)], story: "STRY0000101" },
    ctxFor(instance), {}
  );
  await session.prepare();
  let view = session.view();
  assert.strictEqual(view.subject, null);
  assert.strictEqual(view.group.included, true);
  assert.strictEqual(view.group.fixed, true);
  assert.deepStrictEqual(plain(view.group.sets.map((set) => set.sysId)), [V1, V2, V3], "oldest first");
  await session.start();
  view = session.view();
  assert.strictEqual(view.unit, "group");
  const at = (setId, n) => view.rows.find((row) => row.setId === setId && row.name === NAME(n));
  assert.strictEqual(view.rows.length, 9 - 1, "the other story's own row is not among these sets");
  assert.strictEqual(at(V1, 1).verdict, "batch");
  assert.strictEqual(at(V1, 1).text, "Newer version is in “Team_STRY0000101_CD_V3”", "the badge already says In these sets");
  assert.strictEqual(at(V1, 1).ownSavedRaw, "2026-10-01 10:00:00", "rule 6 placed V1's own version here");
  assert.strictEqual(at(V1, 1).orderReason, "");
  assert.strictEqual(at(V1, 1).childSet, "Team_STRY0000101_AB_V1", "every row names its set");
  assert.strictEqual(at(V3, 1).childSet, "Team_STRY0000101_CD_V3");
  assert.strictEqual(at(V2, 2).verdict, "batch");
  assert.strictEqual(at(V1, 2).verdict, "current");
  assert.strictEqual(at(V2, 3).verdict, "batch");
  assert.strictEqual(at(V2, 3).newerSameContent, true);
  assert.strictEqual(at(V2, 4).verdict, "stale");
  assert.strictEqual(at(V2, 4).text, "Newer version in “Team_STRY0000202_V1”");
  assert.ok(!view.banners.some((banner) => banner.kind === "warn"));

  /* V1 holds NAME(2)'s newest, saved after V2's: V2 goes first. */
  const order = plain(view.group.order);
  assert.deepStrictEqual(order.sets.map((set) => set.name),
    ["Team_STRY0000101_AB_V2", "Team_STRY0000101_AB_V1", "Team_STRY0000101_CD_V3"]);
  assert.deepStrictEqual(order.sets.map((set) => set.after), [
    [],
    [{ sysId: V2, name: "Team_STRY0000101_AB_V2", records: 1 }],
    [{ sysId: V1, name: "Team_STRY0000101_AB_V1", records: 1 }],
  ]);
  assert.deepStrictEqual(order.sets.map((set) => set.held), [0, 1, 1]);
  assert.strictEqual(order.rules, 2);
  assert.strictEqual(order.records, 2, "the same content in two sets asks for no order");
  assert.strictEqual(order.unplaced, 0);
  assert.strictEqual(order.matchesCreation, false);
  assert.deepStrictEqual(order.against, [
    { firstId: V2, first: "Team_STRY0000101_AB_V2", thenId: V1, then: "Team_STRY0000101_AB_V1", records: 1 },
  ]);
  assert.strictEqual(order.cycle, null);
  assert.strictEqual(order.soFar, false);
  /* Which of the sets were backed out here is read once, one read a set. */
  const backedOutReads = instance.requests.filter((request) => /state=backedout/.test(request.query));
  assert.strictEqual(backedOutReads.length, 3);
});

test("a set named for a story offers its story's other live sets behind a tick box", async () => {
  const world = storyWorld();
  const instance = fakeInstance(world);
  const session = lens.createSession({ kind: "set", set: storySet(world, 11) }, ctxFor(instance), {});
  await session.prepare();
  let view = session.view();
  assert.strictEqual(storyReads(instance).length, 1, "one read, beside the others");
  assert.deepStrictEqual(
    { story: view.group.story, included: view.group.included, fixed: view.group.fixed, others: view.group.others, order: view.group.order },
    { story: "STRY0000101", included: false, fixed: false, others: 2, order: null },
    "the Ignore set and the longer number are not offered"
  );
  await session.start();
  view = session.view();
  assert.strictEqual(view.unit, "set");
  assert.deepStrictEqual(plain(view.rows.map((row) => [row.name, row.verdict])), [[NAME(1), "stale"], [NAME(2), "current"]],
    "alone, V3's newer version reads Stale");
  assert.strictEqual(view.rows[0].childSet, "");

  await session.setIncludeStory(true);
  view = session.view();
  assert.strictEqual(view.unit, "group");
  assert.strictEqual(view.rows.length, 8);
  assert.strictEqual(view.rows.find((row) => row.setId === V1 && row.name === NAME(1)).verdict, "batch");
  assert.ok(view.group.order);
  assert.strictEqual(storyReads(instance).length, 1, "ticking reads no story again");

  await session.setIncludeStory(false);
  assert.strictEqual(session.view().rows.length, 2);
});

test("a batch parent's line is the batch's, never its story's", async () => {
  const sets = [
    setRow(30, { name: "Release STRY0000303" }),
    setRow(31, { name: "STRY0000303 part A", parent: id(30) }),
  ];
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(sets[0]) }, ctxFor(fakeInstance({ sets })), {});
  await session.prepare();
  const view = session.view();
  assert.ok(view.batch);
  assert.strictEqual(view.group, null);
});

test("a set with no story number, or whose story has no other live set, reads nothing for it", async () => {
  const plainSet = setRow(40, { name: "Approval fix" });
  const instance = fakeInstance({ sets: [plainSet] });
  const session = lens.createSession({ kind: "set", set: lens.normalizeSet(plainSet) }, ctxFor(instance), {});
  await session.prepare();
  assert.strictEqual(session.view().group, null);
  assert.strictEqual(storyReads(instance).length, 0);

  const alone = setRow(41, { name: "STRY0000505 only" });
  const lonely = lens.createSession({ kind: "set", set: lens.normalizeSet(alone) }, ctxFor(fakeInstance({ sets: [alone] })), {});
  await lonely.prepare();
  assert.strictEqual(lonely.view().group, null);
});

test("commit order: creation order when it works, a cycle named, same content and outside sets ignored", () => {
  const S = (n, created) => ({ sysId: id(n), name: "Set " + n, createdOnRaw: created, stateLabel: "Complete", createdOn: created });
  const sets = [S(3, "2026-10-03 00:00:00"), S(1, "2026-10-01 00:00:00"), S(2, "2026-10-02 00:00:00")];
  const rule = (from, to, name, extra) => Object.assign({ verdict: "batch", setId: id(from), newerSetId: id(to), name }, extra);

  const forward = lens.commitOrder(sets, [rule(1, 3, "a"), rule(2, 3, "b")], false);
  assert.deepStrictEqual(plain(forward.sets.map((set) => set.name)), ["Set 1", "Set 2", "Set 3"]);
  assert.strictEqual(forward.matchesCreation, true);
  assert.deepStrictEqual(plain(forward.against), []);

  const none = lens.commitOrder(sets, [
    rule(1, 3, "a", { newerSameContent: true }),
    Object.assign(rule(2, 1, "c"), { verdict: "stale" }),
    Object.assign(rule(9, 1, "d"), { verdict: "batch" }),
  ], true);
  assert.strictEqual(none.rules, 0, "same content, a lone Stale row, and a row from a set outside ask for no order");
  assert.strictEqual(none.unplaced, 0);
  assert.strictEqual(none.matchesCreation, true);
  assert.strictEqual(none.soFar, true);

  /* A sibling whose own version rule 6 couldn't place makes no rule, and
   * its record is unplaced rather than "the order doesn't matter". */
  const guarded = lens.commitOrder(sets, [rule(3, 1, "e", { orderReason: "backed-out-here" })], false);
  assert.deepStrictEqual([guarded.rules, guarded.unplaced], [0, 1]);

  const cycle = lens.commitOrder(sets, [rule(1, 2, "a"), rule(2, 1, "b"), rule(2, 3, "c")], false);
  assert.deepStrictEqual(plain(cycle.cycle), ["Set 1", "Set 2"], "a set only after the cycle is not on it");
  assert.deepStrictEqual(plain(cycle.cycleIds), [id(1), id(2)]);
  assert.strictEqual(cycle.matchesCreation, false);
  assert.deepStrictEqual(plain(cycle.sets.map((set) => set.name)), ["Set 1", "Set 2", "Set 3"], "every set still listed");
});

test("commit order when the running version is elsewhere: two sets go in the order their own versions were recorded", () => {
  const S = (n, created) => ({ sysId: id(n), name: "Set " + n, createdOnRaw: created });
  const sets = [S(1, "2026-10-01 00:00:00"), S(2, "2026-10-02 00:00:00")];
  const stale = (n, hash, saved, extra) => Object.assign({ verdict: "stale", setId: id(n), name: "a", hash, ownSavedRaw: saved }, extra);

  /* Set 1 was saved again after set 2: set 2 goes first, against creation. */
  const later = lens.commitOrder(sets, [stale(1, "1", "2026-10-06 10:00:00"), stale(2, "2", "2026-10-03 10:00:00")], false);
  assert.deepStrictEqual(plain(later.sets.map((set) => set.name)), ["Set 2", "Set 1"]);
  assert.deepStrictEqual([later.rules, later.unplaced, later.matchesCreation], [1, 0, false]);

  assert.strictEqual(lens.commitOrder(sets, [stale(1, "7", "2026-10-06 10:00:00"), stale(2, "7", "2026-10-03 10:00:00")], false).rules, 0,
    "the same content in both asks for no order");

  /* Set 1 holds the content that runs here (Same content) and saved it
   * last: it goes last, so the target ends on what runs here. */
  const holdsRunning = lens.commitOrder(sets, [
    stale(1, "9", "2026-10-05 10:00:00", { verdict: "same" }),
    stale(2, "2", "2026-10-03 10:00:00"),
  ], false);
  assert.deepStrictEqual(plain(holdsRunning.sets.map((set) => set.name)), ["Set 2", "Set 1"]);
  assert.deepStrictEqual([holdsRunning.rules, holdsRunning.unplaced, holdsRunning.matchesCreation], [1, 0, false]);

  /* Saved BEFORE the Stale one, it holds old content another set put back:
   * a revert. It is not the newer version, and the record is unplaced. */
  const revert = lens.commitOrder(sets, [
    stale(1, "9", "2026-10-01 10:00:00", { verdict: "same" }),
    stale(2, "2", "2026-10-03 10:00:00"),
  ], false);
  assert.deepStrictEqual([revert.rules, revert.unplaced], [0, 1]);
  assert.deepStrictEqual(plain(revert.unplacedRecords), [{ name: "a", reason: "revert", setId: "" }], "about the record, no set");
  const unguarded = lens.commitOrder(sets, [
    stale(1, "9", "", { verdict: "same", orderReason: "not-applied" }),
    stale(2, "2", "2026-10-03 10:00:00"),
  ], false);
  assert.deepStrictEqual(plain(unguarded.unplacedRecords), [{ name: "a", reason: "not-applied", setId: id(1) }],
    "its own rule-6 reason, kept with the set it is about");

  /* Two such records asking for opposite orders (measured once in 200
   * stories): both go, whichever row is read first, and there is no "no
   * order works": a batch would not fix a version neither set holds. */
  const recordA = [stale(1, "1", "2026-10-02 10:00:00"), stale(2, "2", "2026-10-03 10:00:00")];
  const recordB = [stale(1, "9", "2026-10-05 10:00:00", { verdict: "same", name: "b" }), stale(2, "3", "2026-10-03 10:00:00", { name: "b" })];
  const shape = (order) => ({
    sets: order.sets.map((set) => set.name), rules: order.rules, records: order.records, cycle: order.cycle,
    unplaced: order.unplacedRecords.map((entry) => entry.name + ":" + entry.reason).sort(),
  });
  const aFirst = plain(shape(lens.commitOrder(sets, recordA.concat(recordB), false)));
  const bFirst = plain(shape(lens.commitOrder(sets, recordB.concat(recordA), false)));
  assert.deepStrictEqual(aFirst, bFirst, "the same evidence gives the same answer in either row order");
  assert.deepStrictEqual(aFirst, {
    sets: ["Set 1", "Set 2"], rules: 0, records: 0, cycle: null, unplaced: ["a:soft-conflict", "b:soft-conflict"],
  });

  /* A record the sets do run (a hard rule) always wins over a soft one. */
  const hardFirst = lens.commitOrder(sets, [
    { verdict: "batch", setId: id(1), newerSetId: id(2), name: "h", hash: "1" },
    stale(1, "9", "2026-10-05 10:00:00", { verdict: "same", name: "b" }), stale(2, "3", "2026-10-03 10:00:00", { name: "b" }),
  ], false);
  assert.deepStrictEqual(plain(hardFirst.sets.map((set) => set.name)), ["Set 1", "Set 2"]);
  assert.deepStrictEqual([hardFirst.rules, hardFirst.unplaced], [1, 1]);
  assert.deepStrictEqual(plain(hardFirst.unplacedRecords), [{ name: "b", reason: "soft-conflict", setId: "" }]);
  for (const [label, rows] of [
    ["a Can't tell holder", [stale(1, "1", "2026-10-06 10:00:00"), stale(2, "2", "", { verdict: "cant" })]],
    ["no recorded time", [stale(1, "1", ""), stale(2, "2", "2026-10-03 10:00:00")]],
    ["the same second", [stale(1, "1", "2026-10-03 10:00:00"), stale(2, "2", "2026-10-03 10:00:00")]],
  ]) {
    const order = lens.commitOrder(sets, rows, false);
    assert.deepStrictEqual([order.rules, order.unplaced], [0, 1], label);
  }
});

/* Found by review: three records the order once got wrong. */
function reviewWorld(versions, extraXml) {
  return {
    sets: [
      setRow(11, { name: "Team_STRY0000101_AB_V1", sys_created_on: "2026-10-01 09:00:00" }),
      setRow(12, { name: "Team_STRY0000101_AB_V2", sys_created_on: "2026-10-03 09:00:00" }),
      setRow(16, { name: "Team_STRY0000202_V1", sys_created_on: "2026-10-07 09:00:00" }),
    ],
    xml: [xmlRow(V1, NAME(1), guid(1), "1"), xmlRow(V2, NAME(1), guid(2), "2")].concat(extraXml || []),
    versions,
  };
}

async function reviewGroup(world) {
  const session = lens.createSession(
    { kind: "group", sets: [storySet(world, 11), storySet(world, 12)], story: "STRY0000101" }, ctxFor(fakeInstance(world)), {}
  );
  await session.prepare();
  await session.start();
  return session.view();
}

test("checked together, a record another story changed since is ordered by its own saves, never 'doesn't matter'", async () => {
  const view = await reviewGroup(reviewWorld([
    versionRow(NAME(1), id(16), "current", guid(3), "3", "2026-10-08 10:00:00"),
    versionRow(NAME(1), V1, "previous", guid(1), "1", "2026-10-06 10:00:00"),
    versionRow(NAME(1), V2, "previous", guid(2), "2", "2026-10-03 10:00:00"),
  ], [xmlRow(id(16), NAME(1), guid(3), "3")]));
  assert.deepStrictEqual(plain(view.rows.map((row) => row.verdict)), ["stale", "stale"], "both still Stale");
  const order = plain(view.group.order);
  assert.deepStrictEqual(order.sets.map((set) => set.name), ["Team_STRY0000101_AB_V2", "Team_STRY0000101_AB_V1"],
    "V1 was saved last, so it goes last");
  assert.deepStrictEqual([order.rules, order.unplaced, order.matchesCreation], [1, 0, false]);
});

test("checked together, a sibling backed out here or never loaded here makes no order and says why", async () => {
  const backedOut = await reviewGroup(reviewWorld([
    versionRow(NAME(1), V1, "current", guid(1), "1", "2026-10-01 10:00:00"),
    versionRow(NAME(1), V2, "backedout", guid(2), "2", "2026-10-03 10:00:00"),
  ]));
  const neverLoaded = await reviewGroup(reviewWorld([
    versionRow(NAME(1), V1, "current", guid(1), "1", "2026-10-01 10:00:00"),
  ]));
  for (const [view, reason, words] of [
    [backedOut, "backed-out-here", "this set's version was backed out here"],
    [neverLoaded, "not-applied", "no version from this set is recorded here"],
  ]) {
    const row = view.rows.find((candidate) => candidate.setId === V2);
    assert.strictEqual(row.verdict, "batch");
    assert.strictEqual(row.orderReason, reason);
    assert.ok(row.text.startsWith("The version in “Team_STRY0000101_AB_V1” runs here, and " + words), row.text);
    assert.ok(!/Newer/.test(row.text), "it is not the older one");
    const order = plain(view.group.order);
    assert.deepStrictEqual([order.rules, order.unplaced, order.against.length], [0, 1, 0], reason);
    /* Both rows of the record carry the flag the panel filters on. The
     * reason speaks of "this set", so only V2's row says it; V1's row, whose
     * version runs here, points to V2's row instead (Fable, round 3). */
    view.rows.forEach((candidate) => assert.strictEqual(candidate.orderUnknown, true));
    const lead = "which of these sets should go last for it can't be told: ";
    assert.ok(row.notes.includes(lead + words + (reason === "backed-out-here" ? "" : ": skipped at commit, or added to the set without a save")),
      JSON.stringify(row.notes));
    const runs = view.rows.find((candidate) => candidate.setId === V1);
    assert.ok(runs.notes.includes(lead + "see its row from “Team_STRY0000101_AB_V2”"), JSON.stringify(runs.notes));
    assert.ok(!runs.notes.some((note) => /this set/.test(note)), "never a claim about V1's own set");
  }
  assert.ok(backedOut.banners.some((banner) => /backed out on this instance/.test(banner.text)));
});

test("checked together, a set holding content another story put back is not the newer one: a revert is unplaced", async () => {
  /* V1 saved content 1, V2 saved content 2 later, another story put content
   * 1 back. V1's row is Same content, but V1 does not hold the newer version. */
  const view = await reviewGroup(reviewWorld([
    versionRow(NAME(1), id(16), "current", guid(3), "1", "2026-10-08 10:00:00"),
    versionRow(NAME(1), V1, "previous", guid(1), "1", "2026-10-01 10:00:00"),
    versionRow(NAME(1), V2, "previous", guid(2), "2", "2026-10-03 10:00:00"),
  ], [xmlRow(id(16), NAME(1), guid(3), "1")]));
  const at = (setId) => view.rows.find((row) => row.setId === setId);
  assert.strictEqual(at(V1).verdict, "same");
  assert.strictEqual(at(V1).ownSavedRaw, "2026-10-01 10:00:00", "a Same content row is guarded too");
  assert.strictEqual(at(V2).verdict, "stale");
  const order = plain(view.group.order);
  assert.deepStrictEqual([order.rules, order.unplaced, order.matchesCreation], [0, 1, true]);
  assert.deepStrictEqual(order.unplacedRecords, [{ name: NAME(1), reason: "revert", setId: "" }]);
  for (const setId of [V1, V2]) {
    assert.ok(at(setId).notes.includes("which of these sets should go last for it can't be told: " +
      "the content that runs here was saved in one of these sets before the other's change, and put back since"),
    "a reason about the record is on every row of it");
  }

  /* A Same content capture with no version of its own (an identical
   * re-save, or a record added to the set) is timed by when it was
   * captured: after the Stale save it goes last, before it is a revert. */
  const versionless = (captured) => reviewGroup({
    sets: reviewWorld([]).sets,
    xml: [
      xmlRow(V1, NAME(1), guid(1), "1", { sys_updated_on: captured }),
      xmlRow(V2, NAME(1), guid(2), "2"),
      xmlRow(id(16), NAME(1), guid(3), "1"),
    ],
    versions: [
      versionRow(NAME(1), id(16), "current", guid(3), "1", "2026-10-08 10:00:00"),
      versionRow(NAME(1), V2, "previous", guid(2), "2", "2026-10-03 10:00:00"),
    ],
  });
  const later = await versionless("2026-10-09 10:00:00");
  const laterRow = later.rows.find((row) => row.setId === V1);
  assert.deepStrictEqual([laterRow.verdict, laterRow.ownSavedRaw, laterRow.orderReason], ["same", "2026-10-09 10:00:00", ""]);
  assert.deepStrictEqual(plain(later.group.order.sets.map((set) => set.name)), ["Team_STRY0000101_AB_V2", "Team_STRY0000101_AB_V1"]);
  assert.strictEqual(later.group.order.unplaced, 0);
  const earlier = await versionless("2026-10-02 10:00:00");
  assert.deepStrictEqual(plain(earlier.group.order.unplacedRecords), [{ name: NAME(1), reason: "revert", setId: "" }]);

  /* Saved after the Stale one, the same-content set does go last. */
  const forward = await reviewGroup(reviewWorld([
    versionRow(NAME(1), id(16), "current", guid(3), "2", "2026-10-08 10:00:00"),
    versionRow(NAME(1), V1, "previous", guid(1), "1", "2026-10-01 10:00:00"),
    versionRow(NAME(1), V2, "previous", guid(2), "2", "2026-10-03 10:00:00"),
  ], [xmlRow(id(16), NAME(1), guid(3), "2")]));
  const ahead = plain(forward.group.order);
  assert.deepStrictEqual([ahead.rules, ahead.unplaced, ahead.matchesCreation], [1, 0, true]);
  assert.ok(!forward.rows.some((row) => row.orderUnknown));
});

test("checked together, every set's banner names it: Default, backed out here, merged", async () => {
  const world = {
    sets: [
      setRow(11, { name: "Team_STRY0000101_AB_V1", sys_created_on: "2026-10-01 09:00:00", merged_to: id(16) }),
      setRow(12, { name: "Team_STRY0000101_AB_V2", sys_created_on: "2026-10-03 09:00:00", is_default: "true" }),
      setRow(16, { name: "Release target", sys_created_on: "2026-10-07 09:00:00" }),
    ],
    xml: [xmlRow(V1, NAME(1), guid(1), "1")],
    versions: [
      versionRow(NAME(1), V1, "current", guid(1), "1", "2026-10-01 10:00:00"),
      versionRow(NAME(2), V2, "backedout", guid(2), "2", "2026-10-03 10:00:00"),
    ],
  };
  const view = await reviewGroup(world);
  const texts = view.banners.map((banner) => banner.text);
  assert.ok(texts.includes("“Team_STRY0000101_AB_V2” is a Default set. Default sets aren't meant to be moved; this is a snapshot."));
  assert.ok(texts.includes("“Team_STRY0000101_AB_V2” was backed out on this instance; its versions here are marked backed out."));
  /* The sets here are normalised from raw rows, so the merged-into name is
   * its id; a real read brings the display name. */
  const merged = view.banners.find((banner) => /^“Team_STRY0000101_AB_V1” was merged into “/.test(banner.text));
  assert.ok(merged);
  assert.deepStrictEqual(plain(merged.links), [{ label: "Open that set", url: ORIGIN + "/sys_update_set.do?sys_id=" + id(16) }]);
});

test("checked together, a set's rows found only under its retrieved copy still count, and say so", async () => {
  const world = {
    sets: [
      setRow(11, { name: "Team_STRY0000101_AB_V1", sys_created_on: "2026-10-01 09:00:00", remote_sys_id: id(51) }),
      setRow(12, { name: "Team_STRY0000101_AB_V2", sys_created_on: "2026-10-03 09:00:00" }),
    ],
    xml: [
      xmlRow("", NAME(1), guid(1), "1", { remote_update_set: id(51) }),
      xmlRow(V2, NAME(1), guid(2), "2"),
    ],
    versions: [
      versionRow(NAME(1), V2, "current", guid(2), "2", "2026-10-05 10:00:00"),
      versionRow(NAME(1), V1, "previous", guid(1), "1", "2026-10-02 10:00:00"),
    ],
  };
  const view = await reviewGroup(world);
  const retrieved = view.rows.find((row) => row.asRetrieved);
  assert.ok(retrieved, "the retrieved-only row is listed");
  assert.strictEqual(retrieved.setId, V1, "under its local set");
  assert.strictEqual(retrieved.verdict, "batch");
  assert.ok(view.banners.some((banner) => /listed only under the retrieved set/.test(banner.text)));
  const order = plain(view.group.order);
  assert.deepStrictEqual(order.sets.map((set) => [set.name, set.arrived]),
    [["Team_STRY0000101_AB_V1", true], ["Team_STRY0000101_AB_V2", false]], "an arrived set is marked");
});

test("checked together on another instance, past ten sets the rest are tallied without dates", () => {
  const setIds = Array.from({ length: 12 }, (_, index) => id(200 + index));
  const request = {
    unit: "group", setIds, setNames: setIds.map((_, index) => "Story set " + (index + 1)),
    records: [], keys: [], filtered: [], unsent: 0,
  };
  const reply = { copies: [copy("committed", { set: 11, committedOn: "12 Oct 2026", localStateLabel: "Complete", linked: true })], clones: [] };
  const lines = lens.remoteView(reply, request, [], "exampletest", ORIGIN, null).lines.map((line) => line.text);
  assert.strictEqual(lines.length, 11);
  assert.strictEqual(lines[0], "“Story set 1” on exampletest: not found, or not visible to your account.");
  assert.strictEqual(lines[10], "2 more sets on exampletest: not found, or not visible to your account 1, committed 1.");
});

test("a name with two numbers takes the first as its story", () => {
  assert.strictEqual(lens.storyToken("CHG0099887 STRY0000101 fix"), "CHG0099887");
  assert.strictEqual(lens.namesStory("CHG0099887 STRY0000101 fix", "STRY0000101"), true, "either number finds it from the palette");
});

test("checked together on another instance: each set's presence by name, and these sets' words", async () => {
  const world = storyWorld();
  const session = lens.createSession(
    { kind: "group", sets: [storySet(world, 11), storySet(world, 12), storySet(world, 13)], story: "STRY0000101" },
    ctxFor(fakeInstance(world)), {}
  );
  await session.prepare();
  await session.start();
  const request = session.remoteRequest();
  assert.strictEqual(request.unit, "group");
  assert.deepStrictEqual(plain(request.setIds), [V1, V2, V3]);
  assert.deepStrictEqual(plain(request.setNames), ["Team_STRY0000101_AB_V1", "Team_STRY0000101_AB_V2", "Team_STRY0000101_CD_V3"]);
  const rows = session.view().rows;
  const replaced = rows.find((row) => row.setId === V1 && row.name === NAME(1));
  const reply = Object.assign(batchReply(request, { [guid(1)]: ["other", guid(3) + ":3", true] }), {
    copies: [copy("committed", { set: 0, committedOn: "12 Oct 2026", localStateLabel: "Complete", linked: true })],
  });
  const shown = lens.remoteView(reply, request, rows, "exampletest", ORIGIN, null);
  assert.deepStrictEqual(plain(shown.lines.slice(0, 3).map((line) => line.text)), [
    "“Team_STRY0000101_AB_V1” on exampletest: committed on 12 Oct 2026 (its local set is complete).",
    "“Team_STRY0000101_AB_V2” on exampletest: not found, or not visible to your account.",
    "“Team_STRY0000101_CD_V3” on exampletest: not found, or not visible to your account.",
  ], "a line each: every committed set carries its own date");
  assert.deepStrictEqual(plain(shown.perRow[replaced.key]),
    { kind: "inbatch", text: "On exampletest: runs the newest update of it in these sets" });
  assert.deepStrictEqual(plain(shown.lines[shown.lines.length - 1]),
    { kind: "ok", text: "exampletest matches: every record runs the newest update of it in these sets." });
});

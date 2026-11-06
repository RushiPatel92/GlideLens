/*
 * Version Lens engine.
 *
 *   node --test tests/version_lens.test.js
 *
 * DEV-ONLY, like its siblings. The real engine runs under node:vm on top of
 * the real Update Set Lens engine, as it is injected, against the simulated
 * instance in tests/update_set_sim.js. Every request every test makes is
 * kept, so the last tests can check what was never read as well as what was
 * concluded.
 *
 * Synthetic data only: no set, user, record or instance here is real.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { plain, id, guid, fakeInstance, setRow, versionRow } = require("./update_set_sim.js");

const root = path.join(__dirname, "..");
const USL_SOURCE = fs.readFileSync(path.join(root, "update_set_lens.js"), "utf8");
const ENGINE_SOURCE = fs.readFileSync(path.join(root, "version_lens.js"), "utf8");
const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8").replace(/\r\n/g, "\n");
const ORIGIN = "https://example.service-now.com";

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, "source block not found: " + startText);
  return source.slice(start, end);
}

/* The page helpers content.js passes in, lifted from it. */
const pageHelpers = new Function(
  between(contentSource, "function decodedVariants(", "\n/*\n * A record opened as a SUB-TAB") +
    between(contentSource, "function sysIdFromText(", "async function getCurrentRecordSysId(") +
    "\nreturn { recordContextFromText, sysIdFromText };"
)();

function loadEngines() {
  const sandbox = { URL, URLSearchParams, Promise, console, encodeURIComponent, decodeURIComponent };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(USL_SOURCE, sandbox, { filename: "update_set_lens.js" });
  vm.runInContext(ENGINE_SOURCE, sandbox, { filename: "version_lens.js" });
  return { usl: sandbox.SNUpdateSetLens, lens: sandbox.SNVersionLens };
}

const { usl, lens } = loadEngines();

/* Every simulated instance, so the static tests can read every request. */
const instances = [];
function sim(data, options) {
  const instance = fakeInstance(data, options);
  instances.push(instance);
  return instance;
}

function ctxFor(instance, extra) {
  return Object.assign({
    origin: ORIGIN,
    transport: instance.transport,
    sysIdFromText: pageHelpers.sysIdFromText,
    recordContextFromText: pageHelpers.recordContextFromText,
  }, extra || {});
}

function pageCtx(instance, href) {
  return ctxFor(instance, {
    pageTable: pageHelpers.recordContextFromText(href).table,
    currentSysId: async () => pageHelpers.sysIdFromText(href),
  });
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const REC = id(77);
const NAME = "sys_script_include_" + REC;
const META = { sys_id: REC, sys_class_name: "sys_script_include", sys_update_name: NAME, sys_name: "Approval utils", sys_scope: "global" };

let captureCounter = 9000;
function cap(setId, g, hash, extra) {
  captureCounter += 1;
  return Object.assign({
    sys_id: id(captureCounter),
    name: NAME,
    update_set: setId,
    remote_update_set: "",
    action: "INSERT_OR_UPDATE",
    type: "Script Include",
    target_name: "Approval utils",
    update_guid: g,
    payload_hash: hash,
    application: "global",
    category: "customer",
    sys_created_by: "dev.one",
    sys_created_on: "2026-10-01 09:00:00",
    sys_updated_by: "dev.one",
    sys_updated_on: "2026-10-01 09:00:00",
  }, extra);
}

const openSet = (n, extra) => setRow(n, Object.assign({ state: "in progress", name: "Open " + n }, extra));
const doneSet = (n, extra) => setRow(n, Object.assign({ state: "complete", name: "Done " + n }, extra));
const defaultSet = (n, extra) => setRow(n, Object.assign({ state: "in progress", is_default: "true", name: "Default" }, extra));
const ignoreSet = (n, extra) => setRow(n, Object.assign({ state: "ignore", name: "Ignored " + n }, extra));
const current = (setId, g, hash, extra) => versionRow(NAME, setId, "current", g, hash, "2026-10-05 10:00:00", extra);
const previous = (setId, g, hash, created) => versionRow(NAME, setId, "previous", g, hash, created || "2026-10-04 10:00:00");

/* Two open sets with different content, the second replaced by the first,
 * and a complete set whose version was replaced too. */
function collisionWorld() {
  return {
    metadata: [META],
    sets: [openSet(1), openSet(2), doneSet(3, { completed_on: "2026-09-20 10:00:00" })],
    xml: [
      cap(id(1), guid(1), "11", { sys_updated_on: "2026-10-05 10:00:00", sys_updated_by: "dev.two" }),
      cap(id(2), guid(2), "22", { sys_updated_on: "2026-10-04 10:00:00" }),
      cap(id(3), guid(3), "33", { sys_updated_on: "2026-09-01 10:00:00" }),
    ],
    versions: [
      current(id(1), guid(1), "11", { sys_created_by: "dev.two" }),
      previous(id(2), guid(2), "22"),
      previous(id(3), guid(3), "33", "2026-09-01 10:00:00"),
    ],
  };
}

async function resolve(data, options) {
  const instance = sim(Object.assign({ metadata: [META] }, data), options);
  const ctx = ctxFor(instance);
  const live = await lens.resolveRecord(REC, "", ctx);
  return { resolution: plain(live), live, instance, ctx };
}

async function runOn(data, options) {
  const { live: resolution, instance, ctx } = await resolve(data, options);
  const session = lens.createSession(resolution, ctx);
  await session.run();
  return { view: plain(session.view()), instance, session, resolution: plain(resolution) };
}

const headline = (view) => view.headline.lead + (view.headline.rest ? " " + view.headline.rest : "");
const tables = (instance) => instance.requests.map((request) => request.table);
const attention = (view, kind) => view.attention.filter((line) => line.id === kind);

/* ------------------------------------------------------------------ *
 * Identity (§3.1)
 * ------------------------------------------------------------------ */

test("1: a form's sys_id resolves through sys_metadata to its own name; another sys_id in the answer is ignored", async () => {
  const { resolution, instance } = await resolve({});
  assert.strictEqual(resolution.kind, "target");
  assert.strictEqual(resolution.target.name, NAME);
  assert.strictEqual(resolution.target.cls, "sys_script_include");
  assert.strictEqual(resolution.target.display, "Approval utils");
  assert.strictEqual(resolution.target.scope, "Global");
  assert.deepStrictEqual(plain(instance.requests[0]), {
    table: "sys_metadata", query: "sys_id=" + REC, fields: "sys_id,sys_class_name,sys_update_name,sys_name,sys_scope",
    limit: 2, options: { displayAll: true, suppressPagination: true },
  });
  assert.ok(!tables(instance).includes("sys_script_include"), "the concrete table is never queried");

  /* An answer whose only row is some other record names nothing. */
  const decoy = Object.assign({}, META, { sys_id: id(78), sys_update_name: "sys_script_include_" + id(78) });
  const instance2 = sim({ metadata: [] }, {
    answer: async (request) => (request.table === "sys_metadata"
      ? { ok: true, result: [{ sys_id: decoy.sys_id, sys_class_name: decoy.sys_class_name, sys_update_name: decoy.sys_update_name }] }
      : undefined),
  });
  const other = plain(await lens.resolveRecord(REC, "", ctxFor(instance2)));
  assert.strictEqual(other.kind, "identity");
  assert.strictEqual(other.headline, "H1");
});

test("2: a form layout and a dictionary entry resolve to their stored composite names, with no parsing", async () => {
  for (const [cls, name] of [["sys_ui_form", "sys_ui_form_sections_" + REC], ["sys_dictionary", "sys_dictionary_incident_u_notes"]]) {
    const { resolution, instance } = await resolve({ metadata: [Object.assign({}, META, { sys_class_name: cls, sys_update_name: name })] });
    assert.strictEqual(resolution.target.name, name);
    assert.deepStrictEqual(tables(instance), ["sys_metadata"], cls + ": one read, nothing composed or checked");
  }
});

test("3: a translation with a blank name opens on sys_translated_<sys_id> only when a capture of it exists", async () => {
  const blank = Object.assign({}, META, { sys_class_name: "sys_translated", sys_update_name: "" });
  const composed = "sys_translated_" + REC;
  const found = await resolve({ metadata: [blank], xml: [cap(id(1), guid(1), "1", { name: composed })], sets: [openSet(1)] });
  assert.strictEqual(found.resolution.target.name, composed);
  assert.strictEqual(found.resolution.target.blankName, true);
  assert.strictEqual(found.resolution.target.how, "class-sysid");

  const none = await runOn({ metadata: [blank] });
  assert.strictEqual(none.resolution.headline, "H4");
  assert.strictEqual(none.view.headline.id, "H4");
  assert.strictEqual(headline(none.view), "No update on this instance captured this record.");
  assert.deepStrictEqual(none.view.sublines, [
    "It has no update name here, which usually means it hasn't been changed since it was installed.",
  ]);
  assert.strictEqual(none.view.check.shown, false, "no name, nothing to check elsewhere");
});

test("4: a dictionary entry with a blank name tries its composed name, then <class>_<sys_id>, each only once read back", async () => {
  const blank = Object.assign({}, META, { sys_class_name: "sys_dictionary", sys_update_name: "" });
  const dictionary = [{ sys_id: REC, name: "incident", element: "u_notes" }];
  const composed = await resolve({
    metadata: [blank], tables: { sys_dictionary: dictionary },
    versions: [versionRow("sys_dictionary_incident_u_notes", id(1), "current", guid(1), "1", "2026-10-01 10:00:00")],
  });
  assert.strictEqual(composed.resolution.target.name, "sys_dictionary_incident_u_notes");
  assert.strictEqual(composed.resolution.target.how, "composed-dictionary");
  const asked = composed.instance.requests.filter((r) => r.table === "sys_update_xml" || r.table === "sys_update_version");
  assert.deepStrictEqual(asked.map((r) => [r.table, r.query]), [
    ["sys_update_xml", "name=sys_dictionary_incident_u_notes^category=customer"],
    ["sys_update_version", "name=sys_dictionary_incident_u_notes"],
  ]);

  /* A collection's entry has no element: _null. */
  const collection = await resolve({
    metadata: [blank], tables: { sys_dictionary: [{ sys_id: REC, name: "incident", element: "" }] },
    xml: [cap(id(1), guid(1), "1", { name: "sys_dictionary_incident_null" })],
  });
  assert.strictEqual(collection.resolution.target.name, "sys_dictionary_incident_null");

  /* The composed name is not there; <class>_<sys_id> is. */
  const fallback = await resolve({
    metadata: [blank], tables: { sys_dictionary: dictionary },
    xml: [cap(id(1), guid(1), "1", { name: "sys_dictionary_" + REC })],
  });
  assert.strictEqual(fallback.resolution.target.name, "sys_dictionary_" + REC);
  assert.strictEqual(fallback.resolution.target.how, "class-sysid");

  const neither = await resolve({ metadata: [blank], tables: { sys_dictionary: dictionary } });
  assert.strictEqual(neither.resolution.headline, "H4");
});

test("5: a sys_metadata_delete row is a deleted record, worded so", async () => {
  const { resolution } = await resolve({ metadata: [Object.assign({}, META, { sys_class_name: "sys_metadata_delete" })] });
  assert.strictEqual(resolution.target.how, "deleted");
  assert.deepStrictEqual(resolution.target.howWords, ["deleted record"]);
});

test("6: a list layout whose name another record shares says so, from its own read", async () => {
  const name = "sys_ui_list_incident_null";
  const list = Object.assign({}, META, { sys_class_name: "sys_ui_list", sys_update_name: name });
  const sharing = { sys_id: id(79), sys_class_name: "sys_ui_list", sys_update_name: name };
  const { resolution, instance } = await resolve({ metadata: [list, sharing] });
  assert.strictEqual(resolution.target.sharedWith, 1);
  assert.deepStrictEqual(resolution.target.howWords, ["shared with 1 other record"]);
  assert.strictEqual(instance.requests[1].query, "sys_update_name=" + name);
  assert.strictEqual(instance.requests[1].limit, 4);
  /* Any other class costs no such read. */
  const plainRecord = await resolve({});
  assert.strictEqual(plainRecord.instance.requests.length, 1);
});

test("7: the page's table differing from sys_class_name: the class wins", async () => {
  const instance = sim({ metadata: [META] });
  const resolution = plain(await lens.resolveRecord(REC, "sys_script", ctxFor(instance)));
  assert.strictEqual(resolution.target.cls, "sys_script_include");
  assert.strictEqual(resolution.target.name, NAME);
  assert.ok(!tables(instance).includes("sys_script"));
});

test("8: a record outside sys_metadata is <table>_<sys_id> only once read back; its class wins over a parent-table URL", async () => {
  const group = id(60);
  const groups = { sys_user_group: [{ sys_id: group, sys_class_name: "" }] };
  const found = sim({ tables: groups, xml: [cap(id(1), guid(1), "1", { name: "sys_user_group_" + group })] });
  const target = plain(await lens.resolveRecord(group, "sys_user_group", ctxFor(found)));
  assert.strictEqual(target.target.name, "sys_user_group_" + group);
  assert.strictEqual(target.target.how, "data");
  assert.deepStrictEqual(target.target.howWords, ["captured as data"]);

  const missing = sim({ tables: groups });
  const notTracked = plain(await lens.resolveRecord(group, "sys_user_group", ctxFor(missing)));
  assert.strictEqual(notTracked.headline, "H2");
  const session = lens.createSession(notTracked, ctxFor(missing));
  await session.run();
  const view = plain(session.view());
  assert.strictEqual(headline(view), "Not tracked in update sets: no update on this instance names this record.");
  assert.deepStrictEqual(view.sublines, ["sys_user_group records are captured only when someone adds them to a set."]);

  /* An incident through task.do: its own class, never task_<sys_id>. */
  const incident = id(61);
  const tasks = sim({ tables: { task: [{ sys_id: incident, sys_class_name: "incident" }] } });
  const viaTask = plain(await lens.resolveRecord(incident, "task", ctxFor(tasks)));
  assert.strictEqual(viaTask.headline, "H2");
  assert.strictEqual(viaTask.table, "incident");
  const looked = tasks.requests.filter((r) => r.table === "sys_update_xml").map((r) => r.query);
  assert.deepStrictEqual(looked, ["name=incident_" + incident + "^category=customer"]);

  /* A blank sys_class_name (an ACL blank) is Can't identify without a hint. */
  const hidden = Object.assign({}, META, { sys_class_name: "" });
  const blank = sim({ metadata: [hidden] });
  const refused = plain(await lens.resolveRecord(REC, "", ctxFor(blank)));
  assert.strictEqual(refused.headline, "H1");
  assert.match(refused.reason, /can't read which table/);
  assert.ok(!tables(blank).includes("sys_update_xml"), "no capture read on a guess");
  /* With the page's table it takes step 2's road instead. */
  const hinted = sim({ metadata: [hidden], tables: { sys_script_include: [{ sys_id: REC, sys_class_name: "sys_script_include" }] },
    xml: [cap(id(1), guid(1), "1")] });
  assert.strictEqual(plain(await lens.resolveRecord(REC, "sys_script_include", ctxFor(hinted))).target.name, NAME);
});

test("8b: sys_metadata refused (the non-admin road): the page's table, then a denial, never \"data\" or \"not tracked\"", async () => {
  const refuse = { answer: async (request) => (request.table === "sys_metadata" ? { ok: false, status: 403, error: "HTTP 403" } : undefined) };
  const own = { sys_script_include: [{ sys_id: REC, sys_class_name: "sys_script_include" }] };
  const found = sim({ tables: own, xml: [cap(id(1), guid(1), "1")] }, refuse);
  const target = plain(await lens.resolveRecord(REC, "sys_script_include", ctxFor(found)));
  assert.strictEqual(target.target.name, NAME);
  assert.strictEqual(target.target.how, "class-sysid");
  assert.deepStrictEqual(target.target.howWords, [], "not \"captured as data\": it may well be metadata");
  assert.deepStrictEqual(found.requests.map((r) => r.table).slice(0, 3), ["sys_metadata", "sys_script_include", "sys_update_xml"]);

  const missing = sim({ tables: own }, refuse);
  const denied = plain(await lens.resolveRecord(REC, "sys_script_include", ctxFor(missing)));
  assert.strictEqual(denied.headline, "H1", "a stored composite name may exist: never \"not tracked\"");
  assert.strictEqual(denied.reason, "this account can't read this record in sys_metadata here, and no update is named " + NAME +
    ". Paste the record's update name.");

  const noHint = sim({}, refuse);
  assert.match(plain(await lens.resolveRecord(REC, "", ctxFor(noHint))).reason, /^this account can't read sys_metadata here/);
});

test("9: a choice composes sys_choice_<table>_<element>, accepted only on an exact read-back", async () => {
  const choice = id(62);
  const choices = { sys_choice: [{ sys_id: choice, name: "incident", element: "category" }] };
  const composed = "sys_choice_incident_category";
  const found = sim({ tables: choices, xml: [cap(id(1), guid(1), "1", { name: composed })] });
  const target = plain(await lens.resolveRecord(choice, "sys_choice", ctxFor(found)));
  assert.strictEqual(target.target.name, composed);
  assert.deepStrictEqual(target.target.howWords, ["choices are captured per field: this is the list for incident.category"]);

  const missing = sim({ tables: choices });
  const miss = plain(await lens.resolveRecord(choice, "sys_choice", ctxFor(missing)));
  const session = lens.createSession(miss, ctxFor(missing));
  await session.run();
  assert.deepStrictEqual(plain(session.view()).sublines, [
    "No update on this instance is named sys_choice_incident_category, the name a field's choice list is captured under.",
  ]);
});

test("10: each layout child is not tracked on its own, names its parent, and reads no capture", async () => {
  for (const [child, entry] of Object.entries(plain(lens.LAYOUT_CHILDREN))) {
    const instance = sim({});
    const outcome = plain(await lens.resolveRecord(id(63), child, ctxFor(instance)));
    assert.strictEqual(outcome.headline, "H2", child);
    const session = lens.createSession(outcome, ctxFor(instance));
    await session.run();
    const line = plain(session.view()).sublines[0];
    assert.ok(line.startsWith(child + " rows are captured with their " + entry.words + " (" + entry.parent + ")."), line);
    assert.ok(line.endsWith("run Version Lens there."));
    assert.deepStrictEqual(tables(instance), ["sys_metadata"], child + ": no capture read");
  }
});

test("11: update and version forms open on that row's name; set forms ask, with the Update Set Lens hint", async () => {
  const xml = cap(id(1), guid(1), "1");
  const version = Object.assign(current(id(1), guid(1), "1"), { sys_id: id(64) });
  const instance = sim({ xml: [xml], versions: [version] });
  const fromUpdate = plain(await lens.pageTarget(ORIGIN + "/sys_update_xml.do?sys_id=" + xml.sys_id,
    pageCtx(instance, ORIGIN + "/sys_update_xml.do?sys_id=" + xml.sys_id)));
  assert.strictEqual(fromUpdate.target.name, NAME);
  assert.strictEqual(fromUpdate.target.how, "update");
  assert.deepStrictEqual(fromUpdate.target.howWords, ["from this update"]);
  assert.strictEqual(fromUpdate.target.display, "Approval utils");
  const fromVersion = plain(await lens.pageTarget(ORIGIN + "/sys_update_version.do?sys_id=" + id(64),
    pageCtx(instance, ORIGIN + "/sys_update_version.do?sys_id=" + id(64))));
  assert.strictEqual(fromVersion.target.name, NAME);
  assert.strictEqual(fromVersion.target.how, "version");
  for (const table of ["sys_update_set", "sys_remote_update_set"]) {
    const before = instance.requests.length;
    const href = ORIGIN + "/" + table + ".do?sys_id=" + id(65);
    const asked = plain(await lens.pageTarget(href, pageCtx(instance, href)));
    assert.deepStrictEqual(asked, { kind: "none", hint: "This is an update set. Update Set Lens checks a whole set." });
    assert.strictEqual(instance.requests.length, before, table + ": no read");
  }
});

test("12: a list, a nav_to.do list and a new record open the input row with no read", async () => {
  const instance = sim({ metadata: [META] });
  const pages = [
    [ORIGIN + "/sys_script_include_list.do?sysparm_query=sys_id%3D" + REC, ""],
    [ORIGIN + "/nav_to.do?uri=%2Fsys_script_include_list.do%3Fsysparm_query%3Dremote_sys_id%3D" + REC, ""],
    [ORIGIN + "/sys_script_include.do?sys_id=-1", "Save the record first. An unsaved record has no update history."],
    [ORIGIN + "/nav_to.do?uri=%2Fincident.do%3Fsys_id%3D-1", "Save the record first. An unsaved record has no update history."],
    [ORIGIN + "/now/sow/record/incident/-1", "Save the record first. An unsaved record has no update history."],
  ];
  for (const [href, hint] of pages) {
    assert.deepStrictEqual(plain(await lens.pageTarget(href, pageCtx(instance, href))), { kind: "none", hint }, href);
  }
  assert.strictEqual(instance.requests.length, 0);
});

test("13: nav_to.do names the inner table; Workspace and sub-record routes give table and id; a bare sysId= reads sys_metadata", async () => {
  assert.strictEqual(lens.navToTarget(ORIGIN + "/nav_to.do?uri=%2Fincident.do%3Fsys_id%3D" + REC), "incident");
  assert.strictEqual(lens.navToTarget(ORIGIN + "/nav_to.do?uri=incident.do?sys_id=" + REC), "incident");
  const group = id(66);
  const instance = sim({ metadata: [META], tables: { sys_user_group: [{ sys_id: group }] },
    xml: [cap(id(1), guid(1), "1", { name: "sys_user_group_" + group })] });
  const navTo = ORIGIN + "/nav_to.do?uri=%2Fsys_user_group.do%3Fsys_id%3D" + group;
  assert.strictEqual(plain(await lens.pageTarget(navTo, pageCtx(instance, navTo))).target.name, "sys_user_group_" + group);
  const workspace = ORIGIN + "/now/sow/record/sys_user_group/" + group;
  assert.strictEqual(plain(await lens.pageTarget(workspace, pageCtx(instance, workspace))).target.name, "sys_user_group_" + group);
  const sub = ORIGIN + "/now/sow/record/incident/" + id(67) + "/params/selected-tab-index/1/sub/record/sys_script_include/" + REC;
  assert.strictEqual(plain(await lens.pageTarget(sub, pageCtx(instance, sub))).target.name, NAME);
  const studio = ORIGIN + "/now/workflow-studio/builder?table=x&sysId=" + REC;
  assert.strictEqual(plain(await lens.pageTarget(studio, pageCtx(instance, studio))).target.name, NAME);
});

test("14: an unsafe stored name is Can't identify with no capture read; a comma name is read alone through name=", async () => {
  const unsafe = await runOn({ metadata: [Object.assign({}, META, { sys_update_name: "sys_x_a^b" })] });
  assert.strictEqual(unsafe.view.headline.id, "H1");
  assert.strictEqual(headline(unsafe.view), "Can't identify this record safely: its update name can't be looked up safely.");
  assert.ok(!tables(unsafe.instance).includes("sys_update_xml"));

  const comma = "sys_choice_incident_a,b";
  const listed = await runOn({ metadata: [Object.assign({}, META, { sys_update_name: comma })], sets: [openSet(1)],
    xml: [cap(id(1), guid(1), "1", { name: comma })] });
  const read = listed.instance.requests.find((r) => r.table === "sys_update_xml");
  assert.strictEqual(read.query, "name=" + comma + "^category=customer^ORDERBYDESCsys_updated_on");
  const versions = listed.instance.requests.filter((r) => r.table === "sys_update_version");
  assert.ok(versions.every((r) => !r.query.includes("nameIN")), "a comma never enters an IN list");
});

/* ------------------------------------------------------------------ *
 * Typed input (§2.3)
 * ------------------------------------------------------------------ */

test("15: another instance's link is refused with its host, and a list link is refused, before any read", async () => {
  const instance = sim({ metadata: [META] });
  const there = plain(await lens.resolveInput("https://other.service-now.com/sys_script_include.do?sys_id=" + REC, ctxFor(instance)));
  assert.deepStrictEqual(there, {
    kind: "refused",
    message: "This link is to other.service-now.com. Update history belongs to each instance; run Version Lens there.",
  });
  const list = plain(await lens.resolveInput(ORIGIN + "/sys_script_include_list.do?sysparm_query=sys_id%3D" + REC, ctxFor(instance)));
  assert.strictEqual(list.message, "That link opens a list. Open the record and paste its own link, or its sys_id.");
  /* This instance over http is not another instance (review S9). */
  const insecure = plain(await lens.resolveInput(ORIGIN.replace("https:", "http:") + "/sys_script_include.do?sys_id=" + REC, ctxFor(instance)));
  assert.strictEqual(insecure.message, "That link isn't this instance's https address. Paste the record's own link, its sys_id or its update name.");
  assert.strictEqual(instance.requests.length, 0);
  /* A link here takes the page's road. */
  const here = plain(await lens.resolveInput(ORIGIN + "/sys_script_include.do?sys_id=" + REC, ctxFor(instance)));
  assert.strictEqual(here.target.name, NAME);
});

test("16: a caret, a line break and javascript: in any case are refused before any read", async () => {
  const instance = sim({ metadata: [META] });
  for (const text of ["name=x^ORnameLIKEy", "sys_script_include\n" + REC, "javascript:gs.log(1)", "JavaScript:x", "  javascript:x"]) {
    const answer = plain(await lens.resolveInput(text, ctxFor(instance)));
    assert.deepStrictEqual(answer, { kind: "refused", message: "Use the record's link, sys_id or update name." }, text);
  }
  assert.strictEqual(plain(await lens.resolveInput("   ", ctxFor(instance))).message, "Type a record's sys_id, link or update name.");
  assert.strictEqual(instance.requests.length, 0);
});

test("17: a bare sys_id is tried as a record, an update, a version, then a deleted record, each checked in code", async () => {
  const typed = id(68);
  const deleted = { sys_id: id(69), sys_metadata: typed, sys_update_name: "sys_script_" + typed };
  const instance = sim({ deleted: [deleted] });
  const answer = plain(await lens.resolveInput(typed.toUpperCase(), ctxFor(instance)));
  assert.strictEqual(answer.target.name, "sys_script_" + typed);
  assert.strictEqual(answer.target.how, "deleted");
  assert.deepStrictEqual(instance.requests.map((r) => [r.table, r.query]), [
    ["sys_metadata", "sys_id=" + typed],
    ["sys_update_xml", "sys_id=" + typed],
    ["sys_update_version", "sys_id=" + typed],
    ["sys_metadata_delete", "sys_metadata=" + typed],
  ]);

  const update = cap(id(1), guid(1), "1");
  const byUpdate = sim({ xml: [update] });
  assert.strictEqual(plain(await lens.resolveInput(update.sys_id, ctxFor(byUpdate))).target.how, "update");

  /* A row for some other id, as an ignored condition would return, names nothing. */
  const ignored = sim({}, { answer: async (request) => (request.table === "sys_update_xml"
    ? { ok: true, result: [{ sys_id: { value: id(70) }, name: { value: NAME } }] } : undefined) });
  assert.deepStrictEqual(plain(await lens.resolveInput(typed, ctxFor(ignored))), {
    kind: "refused",
    message: "No record, update or deleted record with that sys_id here, or you can't read it. For a data record, paste its link: its table is in the link.",
  });
  assert.ok(!ignored.requests.some((r) => /nameLIKE|ENDSWITH/.test(r.query)), "never the 5-second scan");
});

test("18: a typed name is accepted only when it exists, folds like the server, and takes the server's spelling", async () => {
  const data = collisionWorld();
  const typed = NAME.toUpperCase().replace("SYS_SCRIPT_INCLUDE", "Sys_Script_Include") + "  ";
  const instance = sim(data);
  const answer = plain(await lens.resolveInput(typed, ctxFor(instance)));
  assert.strictEqual(answer.target.name, NAME, "the name exactly as the server returned it");
  const session = lens.createSession(answer, ctxFor(instance));
  await session.run();
  assert.match(plain(session.view()).runsHere, /^Runs here: the version from “Open 1”/,
    "the version read compares names exactly, so it finds the current version only with the server's spelling");

  const none = sim({});
  assert.deepStrictEqual(plain(await lens.resolveInput("sys_script_include_" + id(71), ctxFor(none))), {
    kind: "refused", message: "No update on this instance has that name, or you can't read it.",
  });
  assert.strictEqual(plain(await lens.resolveInput("approval utils", ctxFor(none))).message,
    "Type a sys_id, a link, or an update name such as sys_script_include_<sys_id>.");
});

/* ------------------------------------------------------------------ *
 * Captures and sets (§4.2, §6.6, §6.7)
 * ------------------------------------------------------------------ */

test("20: the capture read is exact: name, customer, newest first, 201 rows, a total, no pagination header; other rows dropped", async () => {
  const { instance, view } = await runOn(collisionWorld());
  const read = instance.requests.find((r) => r.table === "sys_update_xml");
  assert.deepStrictEqual(plain(read), {
    table: "sys_update_xml",
    query: "name=" + NAME + "^category=customer^ORDERBYDESCsys_updated_on",
    fields: "sys_id,name,update_set,remote_update_set,action,type,target_name,update_guid,payload_hash,application,category," +
      "sys_created_by,sys_created_on,sys_updated_by,sys_updated_on",
    limit: 201,
    options: { displayAll: true, suppressPagination: true, withTotal: true },
  });
  assert.strictEqual(view.rows.length, 3);

  /* An ignored condition shows as rows of another record or category. */
  const data = collisionWorld();
  const ignored = await runOn(data, { answer: async (request) => {
    if (request.table !== "sys_update_xml" || !request.query.startsWith("name=")) return undefined;
    const rows = data.xml.concat([cap(id(1), guid(9), "9", { name: "sys_script_include_" + id(99) }), cap(id(1), guid(8), "8", { category: "retrieved" })]);
    return { ok: true, total: rows.length, result: rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, { value: v, display_value: v }]))) };
  } });
  assert.strictEqual(ignored.view.rows.length, 3, "the other record's and the retrieved row are dropped");
  assert.ok(ignored.view.banners.some((b) => /disagree/.test(b.text)), "and the list is not trusted as complete");
});

test("21: a row with no local set but a retrieved set is a loaded copy: counted in one line, never a capture", async () => {
  const data = collisionWorld();
  data.xml.push(cap("", guid(5), "55", { remote_update_set: id(40) }), cap("", guid(6), "66", { remote_update_set: id(41) }));
  const { view } = await runOn(data);
  assert.strictEqual(view.rows.length, 3);
  assert.strictEqual(view.loadedLine, "2 copies loaded here from other instances aren't listed.");
  assert.ok(!view.banners.length, "a genuine loaded copy is no reason for Partial");
});

test("21b: a returned row with its name, category or both sets blank is unplaced: Partial, no tick, never H4", async () => {
  /* One open set, otherwise clear: the tick would show. */
  const clean = () => ({ sets: [openSet(1)], xml: [cap(id(1), guid(1), "1")], versions: [current(id(1), guid(1), "1")] });
  const ticked = await runOn(clean());
  assert.strictEqual(ticked.view.headline.id, "H7");
  assert.strictEqual(ticked.view.clear, true);
  assert.strictEqual(headline(ticked.view), "No competing sets: only “Open 1” holds it open.");

  for (const blank of [{ masked: ["update_set", "remote_update_set"] }, { masked: ["name"] }, { masked: ["category"] }]) {
    const data = clean();
    data.xml.push(cap(id(2), guid(2), "2", blank));
    const { view } = await runOn(data);
    assert.strictEqual(view.clear, false, JSON.stringify(blank));
    assert.strictEqual(view.headline.id, "H7");
    assert.strictEqual(headline(view), "No competing sets found so far: only “Open 1” holds it open.");
    assert.ok(view.banners.some((b) => b.text === "Partial: 1 of this record's captures can't be placed in a set here " +
      "(a field this account can't read); any of them may be in an open set."), JSON.stringify(view.banners));
  }

  /* The only row returned is unplaced: a capture exists, so never H4. */
  const only = await runOn({ xml: [cap(id(1), guid(1), "1", { masked: ["update_set", "remote_update_set"] })], versions: [current(id(1), guid(1), "1")] });
  assert.notStrictEqual(only.view.headline.id, "H4");
  assert.strictEqual(headline(only.view), "No open update set found so far: 1 capture can't be placed in a set here.");
  assert.strictEqual(only.view.clear, false);
});

test("22: more than 200 captures is Partial and \"so far\"; a total with no rows read disagrees", async () => {
  const many = Array.from({ length: 205 }, (_, index) => cap(id(1), guid(1), "1", {
    sys_updated_on: "2026-10-01 " + String(Math.floor(index / 60)).padStart(2, "0") + ":" + String(index % 60).padStart(2, "0") + ":00",
  }));
  const capped = await runOn({ sets: [openSet(1)], xml: many, versions: [current(id(1), guid(1), "1")] });
  assert.strictEqual(capped.view.rows.length, 200);
  assert.ok(capped.view.banners.some((b) => b.text === "Partial: showing the newest 200 of 205 captures; older ones aren't checked."));
  assert.strictEqual(capped.view.headline.lead, "No competing sets found so far:");
  assert.strictEqual(capped.view.clear, false);

  const empty = await runOn({}, { answer: async (request) => (request.table === "sys_update_xml" && request.options.withTotal
    ? { ok: true, result: [], total: 3 } : undefined) });
  assert.ok(empty.view.banners.some((b) => b.text === "Partial: the capture count and the captures read disagree; the list may be incomplete."));
  assert.notStrictEqual(empty.view.headline.id, "H4", "a count of three is no proof of none");

  /* A count above the rows read under the cap: rows were hidden (a row-level
   * ACL), so a clear-looking single open set is no tick (review B1). */
  const shown = cap(id(1), guid(1), "1");
  const visible = fakeInstance({ xml: [shown] });
  const hidden = await runOn({ sets: [openSet(1)], xml: [shown], versions: [current(id(1), guid(1), "1")] }, {
    answer: async (request) => (request.table === "sys_update_xml" && request.options.withTotal
      ? Object.assign(await visible.transport(request), { total: 3 }) : undefined),
  });
  assert.strictEqual(hidden.view.rows.length, 1);
  assert.strictEqual(headline(hidden.view), "No competing sets found so far: only “Open 1” holds it open.");
  assert.ok(hidden.view.banners.some((b) => /disagree/.test(b.text)));
  assert.strictEqual(hidden.view.clear, false);
});

test("22b: a capture read that fails or is refused is Couldn't read, with no Check on and no captures link", async () => {
  const refusedRead = await runOn(collisionWorld(), {
    answer: async (request) => (request.table === "sys_update_xml" && request.options.withTotal
      ? { ok: false, status: 403, error: "HTTP 403" } : undefined),
  });
  assert.strictEqual(headline(refusedRead.view), "Couldn't read this record's updates: this account can't read customer updates here (HTTP 403).");
  assert.strictEqual(refusedRead.view.headline.mark, "warn");
  assert.strictEqual(refusedRead.view.check.shown, false);
  assert.deepStrictEqual(refusedRead.view.links, []);
  assert.deepStrictEqual(refusedRead.view.rows, []);
  assert.strictEqual(refusedRead.view.clear, false);
  const failed = await runOn(collisionWorld(), {
    answer: async (request) => (request.table === "sys_update_xml" && request.options.withTotal
      ? { ok: false, status: 500, error: "HTTP 500" } : undefined),
  });
  assert.strictEqual(headline(failed.view), "Couldn't read this record's updates: HTTP 500");
});

test("23: two captures in one set are both listed, the set counted once, each keyed and classified on its own", async () => {
  const { view } = await runOn({
    sets: [openSet(1)],
    xml: [cap(id(1), guid(1), "1", { sys_updated_on: "2026-10-05 10:00:00" }), cap(id(1), guid(2), "2", { sys_updated_on: "2026-10-01 10:00:00" })],
    versions: [current(id(1), guid(1), "1")],
  });
  assert.strictEqual(view.rows.length, 2);
  assert.strictEqual(view.counts.open, 1);
  assert.notStrictEqual(view.rows[0].key, view.rows[1].key);
  assert.ok(view.rows.every((row) => row.key.includes(String.fromCharCode(0))));
  assert.deepStrictEqual(view.rows.map((row) => row.verdict), ["current", "cant"], "neither takes the other's verdict");
  assert.ok(view.rows.every((row) => row.notes.includes("captured 2 times in this set")));
  assert.strictEqual(view.headline.id, "H7");
});

test("24: sets are read 80 at a time with completed_on; the running set is read only when no capture holds it", async () => {
  const sets = Array.from({ length: 81 }, (_, index) => doneSet(index + 1));
  const xml = sets.map((set, index) => cap(set.sys_id, guid(index + 1), String(index + 1)));
  const many = await runOn({ sets, xml, versions: [current(id(1), guid(1), "1")] });
  const setReads = many.instance.requests.filter((r) => r.table === "sys_update_set");
  assert.deepStrictEqual(setReads.map((r) => r.query.split(",").length), [80, 1]);
  assert.strictEqual(lens.LIMITS.setsPerRead, usl.LIMITS.setsPerRead, "the chunk size is Update Set Lens's own");
  assert.ok(setReads.every((r) => r.fields.split(",").includes("completed_on")));

  /* The running version is in a set committed here that holds no customer
   * capture of it: one more read, and Runs here names it. */
  const arrived = doneSet(9, { name: "Release 9", remote_sys_id: id(90), completed_on: "2026-09-30 10:00:00" });
  const committed = await runOn({
    sets: [openSet(1), arrived],
    xml: [cap(id(1), guid(1), "1")],
    versions: [current(id(9), guid(9), "9"), previous(id(1), guid(1), "1", "2026-10-01 10:00:00")],
  });
  const reads = committed.instance.requests.filter((r) => r.table === "sys_update_set").map((r) => r.query);
  assert.deepStrictEqual(reads, ["sys_id=" + id(1), "sys_id=" + id(9)]);
  assert.strictEqual(committed.view.runsHere,
    "Runs here: the version from “Release 9” (Complete, completed D(2026-09-30 10:00:00), committed here from another instance), " +
    "version by dev.one at D(2026-10-05 10:00:00).");

  /* No capture at all: read 7, then the one set read. */
  const none = await runOn({ sets: [arrived], versions: [current(id(9), guid(9), "9")] });
  assert.deepStrictEqual(none.instance.requests.map((r) => r.table), ["sys_metadata", "sys_update_xml", "sys_update_version", "sys_update_set"]);
  assert.strictEqual(none.instance.requests[2].query, "state=current^name=" + NAME);
  assert.strictEqual(none.instance.requests[2].limit, 4);
  assert.strictEqual(none.view.headline.id, "H4");
  assert.match(none.view.runsHere, /“Release 9”/);
});

/* ------------------------------------------------------------------ *
 * Verdicts (§5, §6)
 * ------------------------------------------------------------------ */

test("25: open is in progress and not Default; a merged set counts only while in progress; a batch child's own state decides", async () => {
  const merged = await runOn({
    sets: [openSet(1, { merged_to: id(5) }), doneSet(2, { merged_to: id(5) }), openSet(5, { name: "Destination" })],
    xml: [cap(id(1), guid(1), "1"), cap(id(2), guid(2), "2")],
    versions: [current(id(1), guid(1), "1")],
  });
  assert.strictEqual(merged.view.headline.id, "H7");
  assert.deepStrictEqual(merged.view.rows.map((row) => [row.setName, row.stateBadge]), [["Open 1", "OPEN"], ["Done 2", "MERGED"]]);
  assert.ok(merged.view.rows[0].notes.includes("merged into “Destination”"));
  assert.strictEqual(merged.view.counts.merged, 1);

  const child = await runOn({
    sets: [ignoreSet(6, { name: "Parked batch" }), openSet(7, { parent: id(6) })],
    xml: [cap(id(7), guid(7), "7")],
    versions: [current(id(7), guid(7), "7")],
  });
  assert.strictEqual(headline(child.view), "No competing sets: only “Open 7” holds it open.");
  assert.ok(child.view.rows[0].notes.includes("in batch “Parked batch”"));

  const notOpen = await runOn({
    sets: [defaultSet(1), ignoreSet(2), doneSet(3)],
    xml: [cap(id(1), guid(1), "1"), cap(id(2), guid(1), "1"), cap(id(3), guid(1), "1")],
    versions: [current(id(1), guid(1), "1")],
  });
  assert.strictEqual(notOpen.view.counts.open, 0);
  assert.strictEqual(notOpen.view.headline.id, "H8");
});

test("26: two open sets with different content, or one blank fingerprint, are a Potential collision", async () => {
  const { view } = await runOn(collisionWorld());
  assert.strictEqual(headline(view), "Potential collision: 2 open sets hold different versions of this record.");
  assert.strictEqual(view.headline.mark, "differs");
  assert.strictEqual(view.clear, false);

  const blank = await runOn({
    sets: [openSet(1), openSet(2)],
    xml: [cap(id(1), guid(1), "1"), cap(id(2), guid(2), "")],
    versions: [current(id(1), guid(1), "1")],
  });
  assert.strictEqual(blank.view.headline.id, "H5", "a blank fingerprint is never the same content");
});

test("27: two open sets with the same content are No competing versions, ticked when clear (Q1)", async () => {
  const { view } = await runOn({
    sets: [openSet(1), openSet(2)],
    xml: [cap(id(1), guid(1), "7"), cap(id(2), guid(2), "7")],
    versions: [current(id(1), guid(1), "7")],
  });
  assert.strictEqual(headline(view), "No competing versions: 2 open sets hold it, all with the same content.");
  assert.strictEqual(view.clear, true);
  assert.strictEqual(view.headline.mark, "ok");

  /* Only open sets are compared: different content in a complete or a
   * Default set beside them changes nothing (review S4). */
  const closed = await runOn({
    sets: [openSet(1), openSet(2), doneSet(3), defaultSet(4)],
    xml: [cap(id(1), guid(1), "7"), cap(id(2), guid(2), "7"), cap(id(3), guid(3), "8"), cap(id(4), guid(4), "9")],
    versions: [current(id(1), guid(1), "7")],
  });
  assert.strictEqual(closed.view.headline.id, "H6");

  /* Each open set is compared by its newest capture: an older duplicate in
   * one set is not a second version (review S1). */
  const duplicate = await runOn({
    sets: [openSet(1), openSet(2)],
    xml: [
      cap(id(1), guid(1), "7", { sys_updated_on: "2026-10-05 10:00:00" }),
      cap(id(1), guid(9), "6", { sys_updated_on: "2026-10-01 10:00:00" }),
      cap(id(2), guid(2), "7", { sys_updated_on: "2026-10-04 10:00:00" }),
    ],
    versions: [current(id(1), guid(1), "7")],
  });
  assert.strictEqual(duplicate.view.headline.id, "H6");
  assert.strictEqual(duplicate.view.rows.length, 3, "both captures in the set are still listed");
  const differ = await runOn({
    sets: [openSet(1), openSet(2)],
    xml: [
      cap(id(1), guid(1), "6", { sys_updated_on: "2026-10-05 10:00:00" }),
      cap(id(1), guid(9), "7", { sys_updated_on: "2026-10-01 10:00:00" }),
      cap(id(2), guid(2), "7", { sys_updated_on: "2026-10-04 10:00:00" }),
    ],
    versions: [current(id(1), guid(1), "6")],
  });
  assert.strictEqual(differ.view.headline.id, "H5", "the newest decides, not any capture");
});

test("28: one open set is ticked; history only is not; Default only is its own amber headline", async () => {
  const history = await runOn({
    sets: [doneSet(3), ignoreSet(4)],
    xml: [cap(id(3), guid(3), "3"), cap(id(4), guid(4), "4")],
    versions: [current(id(3), guid(3), "3")],
  });
  assert.strictEqual(headline(history.view), "History only: no open update set holds it. 2 sets captured it.");
  assert.strictEqual(history.view.clear, false);
  assert.strictEqual(history.view.headline.mark, "");

  const outside = await runOn({
    sets: [defaultSet(1)],
    xml: [cap(id(1), guid(1), "1", { sys_updated_on: "2026-10-03 08:00:00", sys_updated_by: "dev.three" })],
    versions: [current(id(1), guid(1), "1")],
  });
  assert.strictEqual(headline(outside.view),
    "Captured only outside a named set: “Default” holds it, saved D(2026-10-03 08:00:00) by dev.three. That change won't be promoted.");
  assert.strictEqual(outside.view.headline.mark, "warn");
  assert.strictEqual(outside.view.clear, false);
});

test("29: a collision's sub-lines: how many versions, who saved them, a delete, and a shared batch", async () => {
  const three = await runOn({
    sets: [openSet(1, { parent: id(9) }), openSet(2, { parent: id(9) }), openSet(3), doneSet(9, { name: "Release train" })],
    xml: [
      cap(id(1), guid(1), "1"),
      cap(id(2), guid(2), "2", { action: "DELETE" }),
      cap(id(3), guid(3), "3"),
    ],
    versions: [current(id(1), guid(1), "1")],
  });
  assert.deepStrictEqual(three.view.sublines, [
    "They hold 3 different versions.",
    "All saved by dev.one.",
    "“Open 2” captured a delete of this record.",
    "“Open 1” and “Open 2” are in the same batch (“Release train”); a batch commit applies the newest.",
  ]);
  const two = await runOn(collisionWorld());
  assert.deepStrictEqual(two.view.sublines, ["Saved by 2 people."]);
});

test("30: an open set holding a replaced version is an amber line naming the newer set; never for a complete or Default set", async () => {
  const { view } = await runOn(collisionWorld());
  assert.deepStrictEqual(attention(view, "A1").map((line) => line.text), [
    "“Open 2” holds a version that no longer runs here. Newer version in “Open 1” (in progress, version by dev.two at D(2026-10-05 10:00:00)).",
  ]);
  assert.deepStrictEqual(attention(view, "A1")[0].links, [{ label: "Open newer set", url: ORIGIN + "/sys_update_set.do?sys_id=" + id(1) }]);
  assert.strictEqual(view.rows.find((row) => row.setName === "Done 3").verdict, "stale", "the complete set is stale too");
  assert.strictEqual(attention(view, "A1").length, 1, "but only the open set raises the line");

  const single = await runOn({
    sets: [openSet(2), doneSet(1)],
    xml: [cap(id(2), guid(2), "2")],
    versions: [current(id(1), guid(1), "1"), previous(id(2), guid(2), "2", "2026-10-01 10:00:00")],
  });
  assert.strictEqual(single.view.headline.id, "H7");
  assert.strictEqual(attention(single.view, "A1").length, 1);
  assert.strictEqual(single.view.clear, false, "an A line removes the tick");
  assert.strictEqual(single.view.headline.mark, "");
});

test("31: the version that runs here saved in a Default set is A2, with no tick", async () => {
  const { view } = await runOn({
    sets: [openSet(1), defaultSet(2)],
    xml: [cap(id(1), guid(1), "1"), cap(id(2), guid(2), "1")],
    versions: [current(id(2), guid(2), "1")],
  });
  assert.strictEqual(view.headline.id, "H7");
  assert.deepStrictEqual(attention(view, "A2").map((line) => line.text), [
    "The version that runs here was saved in “Default”, outside a named set, so no named set would promote it.",
  ]);
  assert.strictEqual(view.clear, false);
});

test("32: an open set's capture that rule 6 can't place is Can't tell (A3), never A1", async () => {
  const { view } = await runOn({
    sets: [openSet(2), doneSet(1)],
    xml: [cap(id(2), guid(2), "2")],
    /* No version from set 2 at all: skipped at commit, or added without a save. */
    versions: [current(id(1), guid(1), "1")],
  });
  assert.strictEqual(attention(view, "A1").length, 0);
  assert.deepStrictEqual(attention(view, "A3").map((line) => line.text), [
    "Can't tell whether “Open 2” holds what runs here: no version from this set is recorded here: skipped at commit, or added to the set without a save.",
  ]);
  assert.strictEqual(view.clear, false);
});

test("33: the version that runs here in an ignored set is A4; the ignored set never counts as open", async () => {
  const { view } = await runOn({
    sets: [openSet(1), ignoreSet(2)],
    xml: [cap(id(1), guid(1), "1"), cap(id(2), guid(2), "1")],
    versions: [current(id(2), guid(2), "1")],
  });
  assert.strictEqual(view.counts.open, 1);
  assert.deepStrictEqual(attention(view, "A4").map((line) => line.text), [
    "The version that runs here is in “Ignored 2”, an ignored set: it runs here but won't be promoted.",
  ]);
  assert.strictEqual(view.clear, false);
});

test("34: a set that can't be read is Partial, never ticked, and the headline says so far", async () => {
  const { view } = await runOn({
    sets: [openSet(1)],
    xml: [cap(id(1), guid(1), "1"), cap(id(2), guid(2), "1")],
    versions: [current(id(1), guid(1), "1")],
  });
  assert.strictEqual(headline(view), "No competing sets found so far: only “Open 1” holds it open.");
  assert.ok(view.banners.some((b) => b.text === "Partial: 1 of the sets that captured it can't be read here; any of them may be open."));
  assert.strictEqual(view.counts.unreadable, 1);
  assert.deepStrictEqual(view.rows.map((row) => row.stateBadge), ["OPEN", "CAN'T READ"]);
  assert.strictEqual(view.clear, false);
});

test("35: refused version reads are Partial, no row is Current, and the headline still comes from the open sets", async () => {
  const { view } = await runOn({
    sets: [openSet(1), openSet(2)],
    xml: [cap(id(1), guid(1), "1"), cap(id(2), guid(2), "1")],
    versions: [current(id(1), guid(1), "1")],
  }, { answer: async (request) => (request.table === "sys_update_version" ? { ok: false, status: 403, error: "HTTP 403" } : undefined) });
  assert.strictEqual(view.headline.id, "H6");
  assert.ok(view.banners.some((b) => b.text ===
    "Partial: this account can't read version history here, so which version runs isn't known. No row is shown as Current."));
  assert.ok(view.rows.every((row) => row.verdict !== "current"));
  assert.strictEqual(view.runsHere, "");
  assert.strictEqual(attention(view, "A3").length, 0, "the banner says it once, not once per set");
  assert.strictEqual(view.clear, false);
});

test("36: Runs here for every source", () => {
  /* Sets as normalizeSet makes them from a display-value read. */
  const displayed = (row) => Object.fromEntries(Object.entries(row).map(([field, value]) => [field, {
    value, display_value: field === "state" ? "Complete" : /_on$/.test(field) && value ? "D(" + value + ")" : value,
  }]));
  const sets = new Map();
  const set = (n, extra) => plain(usl.normalizeSet(displayed(doneSet(n, extra))));
  sets.set(id(1), set(1, { name: "Release 1", completed_on: "2026-09-01 10:00:00" }));
  sets.set(id(2), set(2, { name: "Arrived", remote_sys_id: id(20) }));
  const version = (extra) => Object.assign({
    name: NAME, state: "current", source: id(1), sourceTable: "sys_update_set", guid: guid(1), hash: "1",
    createdBy: "dev.one", createdOn: "21 Oct 2026 10:00", createdOnRaw: "2026-10-21 10:00:00",
  }, extra);
  const runs = (current) => lens.verdict([], sets, new Map(), current, { target: { name: NAME }, origin: ORIGIN }).runsHere;
  const one = (extra) => ({ list: [version(extra)], failed: false, refused: false, saturated: false });
  assert.strictEqual(runs(one()), "Runs here: the version from “Release 1” (Complete, completed D(2026-09-01 10:00:00)), version by dev.one at 21 Oct 2026 10:00.");
  assert.strictEqual(runs(one({ source: id(2) })), "Runs here: the version from “Arrived” (Complete, committed here from another instance), version by dev.one at 21 Oct 2026 10:00.");
  assert.strictEqual(runs(one({ source: id(3) })), "Runs here: a version from an update set you can't read.");
  assert.strictEqual(runs(one({ sourceTable: "sys_upgrade_history" })), "Runs here: the version from an upgrade (21 Oct 2026 10:00).");
  assert.strictEqual(runs(one({ sourceTable: "sys_store_app" })), "Runs here: the version from an application install (21 Oct 2026 10:00).");
  assert.strictEqual(runs(one({ sourceTable: "sys_app" })), "Runs here: the version from sys_app (21 Oct 2026 10:00).");
  assert.strictEqual(runs({ list: [], failed: false, refused: false, saturated: false }), "No current version of this record is recorded here.");
  assert.strictEqual(runs({ list: [version(), version()], failed: false, refused: false, saturated: false }), "More than one current version is recorded here.");
  assert.strictEqual(runs({ list: [], failed: true, refused: false, saturated: false }), "Couldn't read which version runs here.");
});

test("37: the tick needs H6 or H7, no attention line, no Partial banner, an exact read and versions read", async () => {
  const clean = { sets: [openSet(1)], xml: [cap(id(1), guid(1), "1")], versions: [current(id(1), guid(1), "1")] };
  assert.strictEqual((await runOn(clean)).view.clear, true);
  const failed = await runOn(clean, { answer: async (request) => (request.table === "sys_update_version" ? { ok: false, status: 500, error: "boom" } : undefined) });
  assert.strictEqual(failed.view.clear, false, "versions not read");
  const noTotal = await runOn(clean, { noTotals: true });
  assert.strictEqual(noTotal.view.clear, true, "a read under its limit is exact without a total");

  /* "Versions were read" on its own. In a run a failed read also raises an
   * A3 line or the refused banner; the rule must hold without either. */
  const set = { sysId: id(1), name: "Open 1", state: "in progress", stateLabel: "In progress", isDefault: false,
    mergedTo: "", parent: "", base: "", remoteSysId: "", completedOn: "" };
  const capture = { key: "k1", sysId: id(9), name: NAME, setId: id(1), hash: "1", guid: guid(1), action: "INSERT_OR_UPDATE",
    actionLabel: "Update", updatedBy: "dev.one", updatedOn: "D", updatedOnRaw: "2026-10-01 10:00:00", createdBy: "dev.one",
    createdOnRaw: "2026-10-01 10:00:00", scope: "" };
  const outcomes = new Map([["k1", { verdict: "current", reason: "", text: "This set's version is the one that runs here.", notes: [] }]]);
  const decide = (current) => lens.verdict([capture], new Map([[id(1), set]]), outcomes, current, { target: { name: NAME }, origin: ORIGIN });
  const read = decide({ list: [{ name: NAME, source: id(1), sourceTable: "sys_update_set", guid: guid(1), hash: "1" }], failed: false, refused: false, saturated: false });
  assert.strictEqual(read.clear, true);
  const unread = decide({ list: [], failed: true, refused: false, saturated: false });
  assert.strictEqual(unread.headline.id, "H7");
  assert.deepStrictEqual([unread.attention.length, unread.banners.length], [0, 0]);
  assert.strictEqual(unread.clear, false, "no tick when versions weren't read");
  assert.strictEqual(lens.verdict([capture], new Map([[id(1), set]]), outcomes, null, { target: { name: NAME }, origin: ORIGIN }).clear, false);
});

test("38: rows run open (newest save first), Default, complete, Ignore, merged, unreadable; scope only when it differs", async () => {
  const { view } = await runOn({
    sets: [openSet(1), openSet(2), defaultSet(3), doneSet(4), ignoreSet(5), doneSet(6, { merged_to: id(1) })],
    xml: [
      cap(id(6), guid(6), "6"),
      cap(id(5), guid(5), "5"),
      cap(id(1), guid(1), "1", { sys_updated_on: "2026-10-01 09:00:00" }),
      cap(id(7), guid(7), "7"),
      cap(id(4), guid(4), "4", { application: "x_app" }),
      cap(id(2), guid(2), "1", { sys_updated_on: "2026-10-02 09:00:00", sys_created_by: "dev.two" }),
      cap(id(3), guid(3), "3"),
    ],
    versions: [current(id(1), guid(1), "1")],
  });
  assert.deepStrictEqual(view.rows.map((row) => row.setName), ["Open 2", "Open 1", "Default", "Done 4", "Ignored 5", "Done 6", "an update set you can't read"]);
  assert.deepStrictEqual(view.rows.map((row) => row.pinned), [true, true, false, false, false, false, false]);
  assert.strictEqual(view.rows[3].line2, "scope x_app");
  assert.strictEqual(view.rows[1].line2, "", "same scope, same person, same day");
  assert.strictEqual(view.rows[0].line2, "First captured by dev.two on D(2026-10-01 09:00:00)");
  assert.strictEqual(view.rows[0].line1, "Last saved by dev.one on D(2026-10-02 09:00:00)");
  assert.deepStrictEqual([view.rows[0].savedOn, view.rows[0].savedBy], ["D(2026-10-02 09:00:00)", "dev.one"],
    "the Last saved column is the same display value and person");
  assert.deepStrictEqual(view.rows[0].links.map((link) => link.label), ["Open update", "Open set", "Check this set"]);
  assert.strictEqual(view.rows[0].links[2].set.sysId, id(2), "Check this set hands the set already read");
  assert.deepStrictEqual(view.rows[6].links.map((link) => link.label), ["Open update", "Open set"]);
});

test("39: a record held identically by seven open sets is one quiet line", async () => {
  const sets = Array.from({ length: 7 }, (_, index) => openSet(index + 1));
  const { view } = await runOn({
    sets,
    xml: sets.map((set, index) => cap(set.sys_id, guid(index + 1), "42")),
    versions: [current(id(1), guid(1), "42")],
  });
  assert.strictEqual(headline(view), "No competing versions: 7 open sets hold it, all with the same content.");
  assert.deepStrictEqual(view.sublines, []);
  assert.strictEqual(view.clear, true);
});

test("40: per-capture verdicts are what the Update Set Lens engine gives for the same rows", async () => {
  const data = collisionWorld();
  const { view } = await runOn(data);
  const instance = sim(data);
  const captures = lens.normalizeCaptures(data.xml.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, { value, display_value: value }]))));
  const direct = await usl.classifyRows(captures, { origin: ORIGIN, transport: instance.transport }, { sets: new Map() });
  const byKey = new Map(plain(direct.rows).map((row) => [row.sysId, [row.verdict, row.reason, row.text]]));
  view.rows.forEach((row) => assert.deepStrictEqual([row.verdict, row.reason, row.text], byKey.get(row.sysId), row.setName));
});

/* ------------------------------------------------------------------ *
 * Check on another instance (§7)
 * ------------------------------------------------------------------ */

const OTHER_HASH = "-2147483648";

test("45: the request: non-Default set ids, the running version first, then each capture; filters, fallbacks and the empty case", async () => {
  const { view, session } = await runOn(collisionWorld());
  const request = plain(lens.collisionRemoteRequest(view));
  assert.deepStrictEqual(request.setIds, [id(1), id(2), id(3)]);
  assert.strictEqual(request.zero, "current");
  assert.deepStrictEqual(request.records[0], { name: NAME, guid: guid(1), hash: "11" });
  assert.strictEqual(request.records.length, 4);
  assert.deepStrictEqual(request.keys, view.rows.map((row) => row.key));
  assert.strictEqual(request.blocked, "");
  assert.deepStrictEqual(plain(session.remoteRequest()), request);

  /* A signed decimal hash is kept exact; a row that fails its pattern stays here. */
  const odd = await runOn({
    sets: [openSet(1), openSet(2), defaultSet(3)],
    xml: [cap(id(1), guid(1), OTHER_HASH), cap(id(2), guid(2), "not-a-hash"), cap(id(3), guid(3), "3")],
    versions: [current(id(1), guid(1), OTHER_HASH)],
  });
  const oddRequest = plain(lens.collisionRemoteRequest(odd.view));
  assert.deepStrictEqual(oddRequest.setIds, [id(1), id(2)], "Default sets are left out while any other is there");
  assert.strictEqual(oddRequest.records[0].hash, OTHER_HASH);
  assert.strictEqual(oddRequest.filtered.length, 1);
  assert.ok(oddRequest.records.every((record) => /^-?[0-9]{1,10}$/.test(record.hash)));

  /* Default only: its id is sent, because the route needs one. */
  const onlyDefault = await runOn({ sets: [defaultSet(3)], xml: [cap(id(3), guid(3), "3")], versions: [current(id(3), guid(3), "3")] });
  assert.deepStrictEqual(plain(lens.collisionRemoteRequest(onlyDefault.view)).setIds, [id(3)]);

  /* No capture: the running version's set. */
  const none = await runOn({ sets: [doneSet(9)], versions: [current(id(9), guid(9), "9")] });
  assert.deepStrictEqual(plain(lens.collisionRemoteRequest(none.view)).setIds, [id(9)]);

  /* No current version here: the newest capture stands in, and is named. */
  const noCurrent = await runOn({ sets: [openSet(1)], xml: [cap(id(1), guid(1), "1")] });
  const fallback = plain(lens.collisionRemoteRequest(noCurrent.view));
  assert.strictEqual(fallback.zero, "newest");
  const shown = plain(lens.collisionRemoteView({ copies: [], clones: [], content: ["runs", "runs"] }, fallback, noCurrent.view, "TEST", "https://test.service-now.com"));
  assert.strictEqual(shown.lines[0].text, "TEST runs the same version as the newest capture here.");

  /* Nothing passes: Check is disabled, with its sentence. */
  const nothing = await runOn({ sets: [openSet(1)], xml: [cap(id(1), "bad", "x")] });
  assert.strictEqual(plain(lens.collisionRemoteRequest(nothing.view)).blocked, "Nothing here to look for there.");
  assert.deepStrictEqual(nothing.view.check, { shown: true, ready: false, blocked: "Nothing here to look for there." });
});

test("46: the content line for every status there; none never says \"not there\"", async () => {
  const { view } = await runOn(collisionWorld());
  const request = plain(lens.collisionRemoteRequest(view));
  const line = (content, extra) => plain(lens.collisionRemoteView(Object.assign({ copies: [], clones: [], content }, extra || {}),
    request, view, "TEST", "https://test.service-now.com")).lines[0];
  assert.deepStrictEqual(line(["runs", "runs", "other", "other"]), { kind: "ok", text: "TEST runs the same version as this instance." });
  assert.deepStrictEqual(line(["other", "other", "other", "runs"], { saved: [{ on: "30 Oct", set: "Hotfix" }] }), {
    kind: "differs", text: "TEST runs another version: the one in “Done 3” here (Complete), saved there 30 Oct in Hotfix.",
  });
  assert.strictEqual(line(["other", "other", "same", "other"]).text, "TEST runs another version, with the same content as “Open 2” here.");
  assert.strictEqual(line(["other", "other", "other", "other"]).text, "TEST runs another version.");
  assert.deepStrictEqual(line(["same", "other", "other", "other"]), { kind: "content", text: "TEST runs the same content as this instance, under another update." });
  assert.deepStrictEqual(line(["conflict"]), { kind: "warn", text: "Can't tell on TEST: its version shares this one's id but not its content." });
  assert.deepStrictEqual(line(["none"]), { kind: "warn", text: "TEST has no readable current version of this record." });
  assert.deepStrictEqual(line(["unknown"]), { kind: "warn", text: "Can't tell on TEST." });

  /* The matching set can't be read here: its name says so, with no empty
   * state in brackets (review S5). */
  const unreadable = await runOn({
    sets: [openSet(1)],
    xml: [cap(id(1), guid(1), "1"), cap(id(5), guid(5), "5")],
    versions: [current(id(1), guid(1), "1")],
  });
  const unreadableRequest = plain(lens.collisionRemoteRequest(unreadable.view));
  const runsThere = unreadableRequest.keys.map((key) => (unreadable.view.rows.find((row) => row.key === key).setName ===
    "an update set you can't read" ? "runs" : "other"));
  const unreadableLine = plain(lens.collisionRemoteView({ copies: [], clones: [], content: ["other"].concat(runsThere) },
    unreadableRequest, unreadable.view, "TEST", "")).lines[0];
  assert.strictEqual(unreadableLine.text, "TEST runs another version: the one in “an update set you can't read” here.");
  for (const status of ["none", "unknown", "conflict", "other"]) {
    assert.doesNotMatch(JSON.stringify(plain(lens.collisionRemoteView({ copies: [], clones: [], content: [status] }, request, view, "TEST", ""))), /not there/);
  }
  const failed = plain(lens.collisionRemoteView({ copies: [], clones: [], content: null, contentFailure: { code: "refused" } }, request, view, "TEST", ""));
  assert.match(failed.lines[0].text, /can't read version history/);
});

test("47: presence per row by set index, a summary that counts, and Default sets left out", async () => {
  const data = collisionWorld();
  data.sets.push(defaultSet(4));
  data.xml.push(cap(id(4), guid(4), "11"));
  const { view } = await runOn(data);
  const request = plain(lens.collisionRemoteRequest(view));
  assert.ok(!request.setIds.includes(id(4)));
  const reply = {
    copies: [
      { set: 0, match: "remote", state: "committed", stateLabel: "Committed", committedOn: "30 Oct", retrievedOn: "", collisions: "", localState: "", localStateLabel: "" },
      { set: 1, match: "remote", state: "previewed", stateLabel: "Previewed", committedOn: "", retrievedOn: "29 Oct", collisions: "", localState: "", localStateLabel: "" },
    ],
    clones: [],
    content: ["other", "runs", "same", "other", "other"],
  };
  const shown = plain(lens.collisionRemoteView(reply, request, view, "TEST", "https://test.service-now.com"));
  assert.ok(!shown.lines.some((line) => /^Sets on/.test(line.text)), "the sets' states are count badges, not a line");
  assert.deepStrictEqual(shown.tally, [
    { there: "committed", word: "Committed", count: 1 },
    { there: "previewed", word: "Previewed", count: 1 },
    { there: "missing", word: "Not found", count: 1 },
  ]);
  const byName = (name) => shown.perRow[view.rows.find((row) => row.setName === name).key];
  assert.deepStrictEqual(byName("Open 1"), {
    content: "runs", presence: "On TEST: committed on 30 Oct", there: "committed", thereWord: "Committed",
  });
  assert.deepStrictEqual(byName("Open 2"), {
    content: "same", presence: "On TEST: previewed, not committed (retrieved 29 Oct)", there: "previewed", thereWord: "Previewed",
  });
  assert.deepStrictEqual(byName("Done 3"), { presence: "On TEST: not found or not visible", there: "missing", thereWord: "Not found" });
  assert.strictEqual(byName("Default"), undefined, "a Default row carries nothing from there");
  assert.strictEqual(shown.copyLine, "On the other instance: runs another version; sets there: committed 1, previewed 1, not found 1.");
});

test("47b: the count badges keep one order; another state keeps its label; a failed read can't tell each set", async () => {
  const { view } = await runOn(collisionWorld());
  const request = plain(lens.collisionRemoteRequest(view));
  const copy = (set, match, state, stateLabel) => ({
    set, match, state, stateLabel, committedOn: "", retrievedOn: "", collisions: "", localState: "", localStateLabel: "",
  });
  /* Listed in reverse of the order the badges keep. */
  const shown = plain(lens.collisionRemoteView({
    copies: [copy(1, "name", "committed", "Committed"), copy(2, "remote", "partial", "Partly Done")],
    clones: [0],
    content: ["other", "other", "other", "other"],
  }, request, view, "TEST", ""));
  assert.deepStrictEqual(shown.tally, [
    { there: "other", word: "Partly done", count: 1 },
    { there: "elsewhere", word: "Via another instance", count: 1 },
    { there: "cloned", word: "Clone copy", count: 1 },
  ]);
  const byName = (name) => shown.perRow[view.rows.find((row) => row.setName === name).key];
  assert.deepStrictEqual([byName("Open 1").there, byName("Open 2").there, byName("Done 3").there], ["cloned", "elsewhere", "other"]);

  const failed = plain(lens.collisionRemoteView({ presenceFailure: { code: "refused" }, content: ["other", "other", "other", "other"] },
    request, view, "TEST", ""));
  assert.deepStrictEqual(failed.tally, []);
  for (const name of ["Open 1", "Open 2", "Done 3"]) {
    assert.deepStrictEqual(failed.perRow[view.rows.find((row) => row.setName === name).key], { there: "failed", thereWord: "Can't tell" }, name);
  }
});

test("48: why a check could not run reaches the panel's words", () => {
  assert.strictEqual(lens.remoteProblem({ code: "not-open" }, "TEST", "test.service-now.com"),
    "test.service-now.com isn't open in this browser. Open it in a tab, sign in, then try again.");
  assert.strictEqual(lens.remoteProblem({ code: "signed-out" }, "TEST"), "You're not signed in to TEST. Sign in there, then try again.");
  assert.strictEqual(lens.remoteProblem({ code: "invalid" }, "TEST"), "GlideLens couldn't send that check. Reopen Version Lens, then try again.");
  assert.strictEqual(lens.remoteProblem({ code: "busy" }, "TEST"), "A check is already running from this tab. Wait for it to finish.");
});

test("49: the copy summary holds counts and the state word only", async () => {
  const { view } = await runOn(collisionWorld());
  const request = plain(lens.collisionRemoteRequest(view));
  const remote = plain(lens.collisionRemoteView({ copies: [], clones: [], content: ["other", "runs", "other", "other"] },
    request, view, "TEST", "https://test.service-now.com"));
  const text = lens.copySummary(view, remote);
  assert.strictEqual(text, [
    "Version Lens: one record.",
    "Captured in 3 sets on this instance: open 2, Default 0, complete 1, Ignore 0, merged 0.",
    "Potential collision. Needs attention: 1 open set holds a version that no longer runs here.",
    "On the other instance: runs another version; sets there: not found 3.",
  ].join("\n"));
  for (const secret of [NAME, REC, "Open 1", "Done 3", "dev.one", "dev.two", ORIGIN, "TEST", guid(1)]) {
    assert.ok(!text.includes(secret), "the summary names nothing: " + secret);
  }
  const identityOnly = await runOn({ metadata: [Object.assign({}, META, { sys_update_name: "a^b" })] });
  assert.strictEqual(lens.copySummary(identityOnly.view, null), "Version Lens: one record.\nCan't identify this record.");
});

/* ------------------------------------------------------------------ *
 * Static rules, and every request this suite made
 * ------------------------------------------------------------------ */

const stripComments = (source) => String(source).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
const CODE = stripComments(ENGINE_SOURCE);

test("41: no field list holds payload or update_guid_history, and the capture read never asks for table", () => {
  assert.doesNotMatch(CODE, /["',]\s*payload\s*["',]/);
  assert.ok(!CODE.includes("update_guid_history"));
  assert.ok(!lens.CAPTURE_FIELDS.split(",").includes("table"));
  assert.ok(!lens.CAPTURE_FIELDS.split(",").includes("payload"));
});

test("42: no query is keyed by update_guid or payload_hash", () => {
  for (const forbidden of ["update_guid=", "update_guidIN", "payload_hash=", "payload_hashIN"]) {
    assert.ok(!CODE.includes(forbidden), forbidden);
  }
});

test("43: no write, no fetch, no message of its own: every read is Update Set Lens's readTable", () => {
  assert.ok(!/\bfetch\(/.test(CODE));
  assert.ok(!/\bmethod\s*:/.test(CODE));
  assert.ok(!/chrome\.|sendMessage/.test(CODE), "the engine reaches the extension only through readTable");
  assert.ok(!/function readTable\b/.test(CODE));
});

test("19 and 44: no read ever used nameLIKE, nameENDSWITH or nameSTARTSWITH, or dot-walked a condition", () => {
  assert.ok(!/nameLIKE|nameENDSWITH|nameSTARTSWITH/.test(CODE));
  assert.doesNotMatch(CODE, /"[a-z_]+\.[a-z_]+(?:=|IN|!=|LIKE)/);
  const requests = instances.flatMap((instance) => instance.requests);
  assert.ok(requests.length > 200, "the suite's requests were collected: " + requests.length);
  requests.forEach((request) => {
    assert.doesNotMatch(request.query, /(?:^|\^)name(?:LIKE|ENDSWITH|STARTSWITH)/, request.query);
    String(request.query).split("^").filter((part) => !part.startsWith("ORDERBY")).forEach((part) => {
      const field = (part.match(/^([a-z_.]+?)(?:IN|LIKE|>|=)/) || [])[1] || "";
      assert.ok(!field.includes("."), "no dot-walk: " + part);
    });
    assert.ok(!/(?:^|,)payload(?:,|$)/.test(request.fields), request.fields);
  });
});

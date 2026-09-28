/*
 * Tests for the Impersonate engine: the query boundary, the three search
 * orders, eligibility, the role intersection, and the discovered attribute
 * filter. The real engine runs under node:vm; nothing here is a restatement of
 * the implementation.
 *
 * Every fixture is synthetic. No instance name, hostname, user, role or
 * sys_id from a real instance belongs in this repository.
 *
 *   node --test tests/impersonate.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadEngine(globals) {
  const context = Object.assign({ globalThis: null, setTimeout, clearTimeout }, globals || {});
  context.globalThis = context;
  vm.createContext(context);
  /* record_search.js first, as background.js injects it: the engine reuses its
   * anchor extraction and ranking, so a sandbox without it would exercise
   * fallbacks the real panel never takes. */
  ["record_search.js", "impersonate.js"].forEach((name) => {
    const file = path.join(__dirname, "..", name);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  });
  return context.SNImpersonate;
}

const IMP = loadEngine();

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/*
 * Distinct 32-hex ids. A named seed gets a stable one, so a test can refer to
 * the same record twice -- but the mapping is a counter rather than a
 * transformation of the seed text, because folding non-hex characters made
 * "ak" and "al" the same id and quietly turned a real assertion into a
 * tautology.
 */
let idCounter = 0;
const seededIds = new Map();
function sysId(seed) {
  if (!seed) {
    idCounter += 1;
    return String(idCounter).padStart(32, "c");
  }
  if (!seededIds.has(seed)) {
    seededIds.set(seed, String(seededIds.size + 1).padStart(32, "e"));
  }
  return seededIds.get(seed);
}

/*
 * The engine runs in its own vm realm, so the arrays it returns do not share
 * this realm's Array.prototype and deepStrictEqual rejects them on identity
 * alone. Record Lens's suite solves it the same way.
 */
const own = (value) => Array.from(value || []);

function dictField(element, options) {
  const opts = options || {};
  return {
    name: opts.table || "sys_user",
    element,
    column_label: opts.label || element,
    internal_type: opts.type || "string",
    choice: opts.choice || "",
    "reference.name": opts.reference || "",
  };
}

/* Stock-shaped: the four identity fields, the three eligibility booleans, and
 * a choice-backed string plus two references so both attribute shapes exist. */
const DEFAULT_DICTIONARY = [
  dictField("user_name", { label: "User ID" }),
  dictField("name", { label: "Name" }),
  dictField("email", { label: "Email", type: "email" }),
  dictField("title", { label: "Title" }),
  dictField("active", { label: "Active", type: "boolean" }),
  dictField("locked_out", { label: "Locked out", type: "boolean" }),
  dictField("web_service_access_only", { label: "Web service access only", type: "boolean" }),
  dictField("country", { label: "Country code", choice: "3" }),
  dictField("department", { label: "Department", type: "reference", reference: "cmn_department" }),
  dictField("company", { label: "Company", type: "reference", reference: "core_company" }),
];

function userRow(options) {
  const opts = options || {};
  return Object.assign({
    sys_id: opts.sysId || sysId(),
    user_name: opts.userName === undefined ? "sample.user" : opts.userName,
    name: opts.name === undefined ? "Sample User" : opts.name,
    email: opts.email || "",
    title: opts.title || "",
    active: opts.active === undefined ? "true" : opts.active,
    locked_out: opts.lockedOut === undefined ? "false" : opts.lockedOut,
    web_service_access_only: opts.apiOnly === undefined ? "false" : opts.apiOnly,
    country: opts.country || "",
    department: opts.department || "",
    company: opts.company || "",
  }, opts.extra || {});
}

function membershipRow(userSysId, roleSysId, inherited) {
  return {
    user: userSysId,
    role: roleSysId,
    inherited: inherited ? "true" : "false",
    state: "active",
  };
}

/* sys_user_grmember is verified to carry `user` and `group` and nothing else. */
function groupMemberRow(userSysId, groupSysId) {
  return { user: userSysId, group: groupSysId };
}

/*
 * A transport that records every request and answers from a table map. Any
 * table the test did not provide answers empty, so a query going somewhere
 * unexpected shows up as a missing result rather than as a silent pass.
 */
function makeGet(tables) {
  const calls = [];
  const get = async (request) => {
    calls.push(request);
    const handler = tables[request.table];
    if (typeof handler === "function") return handler(request);
    return handler || [];
  };
  get.calls = calls;
  get.forTable = (table) => calls.filter((call) => call.table === table);
  return get;
}

const HIERARCHY = [{ name: "sys_user", label: "User", "super_class.name": "" }];

function baseTables(overrides) {
  return Object.assign({
    sys_db_object: HIERARCHY,
    sys_dictionary: DEFAULT_DICTIONARY,
    sys_properties: [{ name: "glide.sys.language", value: "en" }],
  }, overrides || {});
}

async function schemaFrom(dictionary) {
  const get = makeGet(baseTables({ sys_dictionary: dictionary || DEFAULT_DICTIONARY }));
  return IMP.resolveUserSchema({ get, noCache: true });
}

/* ------------------------------------------------------------------ *
 * Parsing and the query boundary
 * ------------------------------------------------------------------ */

test("the module exposes the pure Impersonate API", () => {
  assert.ok(IMP);
  ["parseSearch", "runSearch", "resolveUserSchema", "validateUserName"].forEach((name) => {
    assert.strictEqual(typeof IMP[name], "function", name + " must be exported");
  });
});

test("a typed term needs three safe characters, and an exact sys_id does not", () => {
  assert.strictEqual(IMP.parseSearch({ term: "ab" }).ok, false);
  assert.strictEqual(IMP.parseSearch({ term: "abe" }).ok, true);
  assert.strictEqual(IMP.parseSearch({ term: "a^b" }).ok, false,
    "two-character runs either side of an operator are not an anchor");

  const id = sysId("beef");
  const parsed = IMP.parseSearch({ term: id });
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.isSysId, true);
  assert.strictEqual(parsed.anchor, id);
});

test("an email-shaped term anchors on its local part, not on the domain everyone shares", async () => {
  assert.strictEqual(IMP.parseSearch({ term: "t.okonkwo@example.com" }).anchor, "okonkwo");
  /* A local part too short to anchor falls back to the whole term, as does a
   * term that is only a domain. */
  assert.strictEqual(IMP.parseSearch({ term: "ab@example.com" }).anchor, "example");
  assert.strictEqual(IMP.parseSearch({ term: "@example.com" }).anchor, "example");

  /* Only the anchor moves: the complete term is still what a row must contain. */
  const schema = await schemaFrom();
  const target = userRow({ userName: "t.okonkwo@example.com", name: "Tomi Okonkwo" });
  const namesake = userRow({ userName: "okonkwo.b", name: "Bola Okonkwo" });
  const get = makeGet(baseTables({ sys_user: [target, namesake] }));
  const result = await IMP.runSearch(
    IMP.parseSearch({ term: "t.okonkwo@example.com" }), { get, schema }
  );
  assert.ok(get.forTable("sys_user")[0].query.startsWith("user_nameLIKEokonkwo"),
    get.forTable("sys_user")[0].query);
  assert.deepStrictEqual(own(result.results.map((user) => user.userName)), ["t.okonkwo@example.com"]);
});

test("a role suggestion needs only two characters", () => {
  assert.strictEqual(IMP.extractRoleAnchor("i"), null);
  assert.strictEqual(IMP.extractRoleAnchor("itil"), "itil");
  assert.strictEqual(IMP.extractRoleAnchor("^^ca^catalog"), "catalog");
});

test("no operator, separator or newline from user input reaches a query", async () => {
  const schema = await schemaFrom();
  const hostile = ["a^b=c", "x,y", "line\nbreak", "p^ORq", "s^ORDERBYname"];
  hostile.forEach((term) => {
    const parsed = IMP.parseSearch({ term });
    if (!parsed.ok) return;
    const query = IMP.buildUserTextQuery(schema.searchFields, parsed.anchor, schema, null);
    /* The eligibility clauses are the engine's own carets; nothing the user
     * typed may add one. */
    const fromInput = query.split("^").filter((clause) => clause.includes("LIKE"));
    fromInput.forEach((clause) => {
      /* A clause is a field, the operator, and one [A-Za-z0-9_] run. Whatever
       * the user typed becomes at most that run -- which is why a term like
       * "s^ORDERBYname" yields the harmless literal value "ORDERBYname" and
       * never the ^ORDERBY operator itself. */
      assert.ok(/^(OR)?[A-Za-z_]+LIKE[A-Za-z0-9_]+$/.test(clause),
        "unsafe clause built from " + JSON.stringify(term) + ": " + clause);
    });
    assert.ok(!query.includes("\n"));
    assert.ok(!query.includes(","));
    /* One caret per engine-owned clause and not one more. The eligibility
     * clauses are counted by their own carets, because the last of them is
     * deliberately an OR group and so carries one of its own. */
    const engineCarets = IMP.eligibilityClauses(schema)
      .reduce((total, clause) => total + clause.split("^").length, 0);
    assert.strictEqual(query.split("^").length, fromInput.length + engineCarets);
  });
});

test("an unsafe field name and an unsafe table are both refused", async () => {
  const schema = await schemaFrom();
  assert.throws(
    () => IMP.buildUserTextQuery(["user_name", "name^ORactive"], "abel", schema, null),
    (error) => error.code === "schema"
  );
  assert.throws(
    () => IMP.attributeCondition({ field: "country^ORactive", value: "GB" }, schema),
    (error) => error.code === "schema"
  );
});

test("an attribute condition is bound to the fields the filter offers, not every live column", async () => {
  const schema = await schemaFrom(DEFAULT_DICTIONARY.concat([
    dictField("user_password", { label: "Password", type: "password2" }),
  ]));
  assert.ok(schema.fieldNames.includes("user_password"), "the column exists");
  /* Exists but is never offered: credential-adjacent, and a plain email is
   * not a choice or a reference either. */
  ["user_password", "email"].forEach((field) => {
    assert.throws(
      () => IMP.attributeCondition({ field, value: "x" }, schema),
      (error) => error.code === "schema",
      field + " must be refused by the engine, not only by the picker"
    );
  });
  assert.strictEqual(IMP.attributeCondition({ field: "country", value: "GB" }, schema), "country=GB");
});

test("the table allowlist holds: no caller-supplied table reaches a query", async () => {
  const get = makeGet(baseTables());
  const schema = await IMP.resolveUserSchema({ get, noCache: true });
  await IMP.runSearch(IMP.parseSearch({ term: "sample" }), { get, schema });
  get.calls.forEach((call) => {
    assert.ok(IMP.TABLE_ALLOWLIST.includes(call.table), "unexpected table read: " + call.table);
  });
  /* And a table offered from outside is refused at the transport, before any
   * message is built -- there is no route by which one could be supplied. */
  for (const table of ["sys_update_xml", "sys_user_password", "incident", "sys user", ""]) {
    await assert.rejects(
      () => IMP.tableGet({ table, query: "", fields: "", limit: 1 }),
      (error) => error.code === "validation",
      "should have refused " + JSON.stringify(table)
    );
  }
  /* An allowlisted name in another case normalises rather than being refused,
   * so it gets past the table check and fails on the absent transport instead
   * -- which is how the two rejections are told apart. */
  await assert.rejects(
    () => IMP.tableGet({ table: " SYS_USER ", query: "", fields: "", limit: 1 }),
    (error) => error.code === "transient"
  );
});

test("a validated role sys_id is the only thing that identifies a role", () => {
  assert.strictEqual(IMP.parseSearch({ roleSysId: "itil" }).ok, false,
    "a role NAME round-tripped through the DOM must never reach a query");
  assert.strictEqual(IMP.parseSearch({ roleSysId: sysId("ab") }).ok, true);
  assert.throws(() => IMP.buildMembershipQuery("itil", null), (error) =>
    error.code === "validation");
});

test("a validated group sys_id is the only thing that identifies a group", () => {
  const typed = IMP.parseSearch({ groupSysId: "Service Desk" });
  assert.strictEqual(typed.ok, false,
    "a group NAME round-tripped through the DOM must never reach a query");
  assert.ok(/group/i.test(typed.error));
  assert.strictEqual(IMP.parseSearch({ groupSysId: sysId("gb") }).ok, true);
  assert.throws(() => IMP.buildGroupMemberQuery("Service Desk", null, null, null), (error) =>
    error.code === "validation");
});

test("the group tables join the allowlist, and a group search reads nothing outside it", async () => {
  ["sys_user_group", "sys_user_grmember"].forEach((table) => {
    assert.ok(IMP.TABLE_ALLOWLIST.includes(table), table + " must be allowlisted");
  });
  const schema = await schemaFrom();
  const group = sysId("gc");
  const member = userRow({ userName: "member.one", name: "Member One" });
  const get = makeGet(baseTables({
    sys_user: [member],
    sys_user_grmember: [groupMemberRow(member.sys_id, group)],
    sys_user_group: [{ sys_id: group, name: "Example Group", active: "true" }],
  }));
  await IMP.findGroups("Example", { get });
  await IMP.runSearch(IMP.parseSearch({ groupSysId: group }), { get, schema });
  await IMP.runSearch(IMP.parseSearch({ term: "member", groupSysId: group }), { get, schema });
  get.calls.forEach((call) => {
    assert.ok(IMP.TABLE_ALLOWLIST.includes(call.table), "unexpected table read: " + call.table);
  });
});

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

test("a missing required field is a schema error, and a missing optional one is omitted", async () => {
  await assert.rejects(
    () => schemaFrom(DEFAULT_DICTIONARY.filter((row) => row.element !== "locked_out")),
    (error) => error.code === "schema"
  );

  const lean = await schemaFrom(DEFAULT_DICTIONARY.filter((row) =>
    !["title", "country", "department", "company"].includes(row.element)));
  assert.deepStrictEqual(own(lean.searchFields), ["user_name", "name", "email"]);
  assert.deepStrictEqual(own(lean.displayFields), []);
  ["title", "country", "department", "company"].forEach((name) => {
    assert.ok(lean.omitted.includes(name), name + " should be reported as omitted");
  });
});

test("eligibility clauses cover every safety condition the instance actually has", async () => {
  const schema = await schemaFrom();
  assert.deepStrictEqual(own(IMP.eligibilityClauses(schema)), [
    "active=true",
    "locked_out=false",
    "user_nameISNOTEMPTY",
    /* Not `=false`. See the next test. */
    "web_service_access_only=false^ORweb_service_access_onlyISEMPTY",
  ]);
  /* user_nameISNOTEMPTY is doubly required: the endpoint is keyed by that
   * field, so a user without one cannot be impersonated at all. */
  const noApiOnly = await schemaFrom(
    DEFAULT_DICTIONARY.filter((row) => row.element !== "web_service_access_only")
  );
  assert.ok(!IMP.eligibilityClauses(noApiOnly).some((c) => c.includes("web_service_access_only")));
  assert.ok(IMP.eligibilityClauses(noApiOnly).includes("user_nameISNOTEMPTY"));
});

test("the API-only clause matches an EMPTY field, and stays last so its OR cannot spread", async () => {
  /*
   * Measured on the PDI, and it is the defect that made every search return
   * almost nothing: 642 active users, but `web_service_access_only=false`
   * matches only 83 — the field is EMPTY rather than false on more than 500 of
   * them, and neither `=false` nor `!=true` matches empty. `abel.tuter`, the
   * canonical demo user, came back as no result at all.
   *
   * A read cannot show this: display_value renders the empty field as the
   * string "false", so the row looks like one that would match.
   */
  const schema = await schemaFrom();
  const clauses = IMP.eligibilityClauses(schema);
  const apiOnly = clauses[clauses.length - 1];
  assert.match(apiOnly, /web_service_access_only=false\^ORweb_service_access_onlyISEMPTY/);

  /* `^OR` binds to the condition immediately before it, so the OR group has to
   * be the last thing in the query — anything after it would fall inside the
   * OR and stop being required. Every builder must therefore put eligibility
   * last, after the attribute condition. */
  const withAttribute = IMP.buildUserTextQuery(
    schema.searchFields, "abel", schema, { field: "country", value: "GB" }
  );
  assert.ok(withAttribute.endsWith(apiOnly),
    "eligibility must be last, or the attribute would land inside its OR: " + withAttribute);
  assert.ok(withAttribute.indexOf("country=GB") < withAttribute.indexOf(apiOnly));

  [
    IMP.buildUserSysIdQuery(sysId("ca"), schema, null),
    IMP.buildUserIdsQuery([sysId("cb")], schema, { field: "country", value: "GB" }),
    IMP.buildAttributeOnlyQuery(schema, { field: "country", value: "GB" }),
  ].forEach((query) => {
    assert.ok(query.endsWith(apiOnly), "OR group must be last in: " + query);
  });
});

test("a reordered eligibility list is refused rather than silently weakening the query", () => {
  /* The OR group is only safe at the end, so its position is asserted at
   * build time: a later edit that moved it would otherwise turn every
   * condition after it into an optional one, with no visible symptom. */
  const reordered = {
    fieldNames: ["web_service_access_only", "active"],
  };
  /* Both fields present, but the engine's own ordering puts the OR group
   * last, so this must succeed... */
  assert.ok(IMP.eligibilityClauses(reordered).length === 2);
  assert.ok(IMP.eligibilityClauses(reordered)[1].includes("ISEMPTY"));
});

test("fields are labelled from the live column_label, not from a name in our code", async () => {
  /* The shape that caught this: the stock field is relabelled and a CUSTOM
   * field carries the familiar label. A hardcoded "Country" would point at the
   * wrong one on the instance that matters most. */
  const relabelled = DEFAULT_DICTIONARY
    .map((row) => (row.element === "country"
      ? Object.assign({}, row, { column_label: "Language country code" })
      : row))
    .concat([dictField("u_country", {
      label: "Country", type: "reference", reference: "core_country",
    })]);
  const schema = await schemaFrom(relabelled);
  const byName = new Map(schema.attributeFields.map((field) => [field.name, field]));
  assert.strictEqual(byName.get("country").label, "Language country code");
  assert.strictEqual(byName.get("u_country").label, "Country");
  assert.strictEqual(byName.get("u_country").type, "reference");
  assert.strictEqual(byName.get("u_country").reference, "core_country");
});

test("the discovered attribute list is not truncated and excludes credential-adjacent fields", async () => {
  const many = DEFAULT_DICTIONARY.concat([
    dictField("u_region", { label: "Region", choice: "1" }),
    dictField("u_site", { label: "Site", choice: "3" }),
    dictField("u_cost_centre", { label: "Cost centre", type: "reference", reference: "cmn_cost_center" }),
    dictField("u_division", { label: "Division", choice: "3" }),
    dictField("u_country", { label: "Country", type: "reference", reference: "core_country" }),
    /* Must never be offered. */
    dictField("user_password", { label: "Password", type: "password2" }),
    dictField("security_question", { label: "Question", choice: "3" }),
    dictField("api_key", { label: "API key", choice: "3" }),
    dictField("photo", { label: "Photo", type: "reference", reference: "db_image" }),
  ]);
  const schema = await schemaFrom(many);
  const names = schema.attributeFields.map((field) => field.name);
  /* Capping discovery at Record Lens's six-field SELECTION limit would have
   * hidden exactly the custom field this mechanism exists for. */
  assert.ok(names.length > 6, "discovery must not be capped, got " + names.length);
  assert.ok(names.includes("u_country"));
  ["user_password", "security_question", "api_key", "photo"].forEach((name) => {
    assert.ok(!names.includes(name), name + " must never be offered as a filter");
  });
});

test("both the display-value and the scalar response shapes normalize", async () => {
  const schema = await schemaFrom();
  const objectShaped = userRow({
    userName: "sample.user", name: "Sample User", email: "sample@example.com",
  });
  Object.keys(objectShaped).forEach((key) => {
    objectShaped[key] = { value: objectShaped[key], display_value: objectShaped[key] };
  });
  assert.strictEqual(IMP.isEligibleRow(objectShaped, schema), true);
  const normalized = IMP.normalizeUser(objectShaped, schema);
  assert.strictEqual(normalized.userName, "sample.user");
  assert.strictEqual(normalized.email, "sample@example.com");

  const scalar = userRow({ userName: "sample.user", name: "Sample User" });
  assert.strictEqual(IMP.isEligibleRow(scalar, schema), true);
  assert.strictEqual(IMP.normalizeUser(scalar, schema).userName, "sample.user");
});

/* ------------------------------------------------------------------ *
 * Eligibility and verification
 * ------------------------------------------------------------------ */

test("ineligible accounts never reach a result, whatever the server returned", async () => {
  const schema = await schemaFrom();
  const rows = [
    userRow({ userName: "ok.user", name: "Ok User" }),
    /* The ordinary case on a real instance: the API-only flag is EMPTY rather
     * than false, on most users. This row must be eligible. */
    userRow({ userName: "empty.flag.user", name: "Empty Flag User", apiOnly: "" }),
    userRow({ userName: "gone.user", name: "Gone User", active: "false" }),
    userRow({ userName: "locked.user", name: "Locked User", lockedOut: "true" }),
    userRow({ userName: "robot.user", name: "Robot User", apiOnly: "true" }),
    /* No User ID at all: the endpoint is keyed by it, so this account cannot
     * be impersonated even in principle. */
    userRow({ userName: "", name: "Nameless User" }),
  ];
  const get = makeGet(baseTables({ sys_user: rows }));
  const result = await IMP.runSearch(IMP.parseSearch({ term: "User" }), { get, schema });
  assert.deepStrictEqual(
    own(result.results.map((user) => user.userName)).sort(),
    ["empty.flag.user", "ok.user"]
  );
  assert.strictEqual(result.eligibleTotal, 2);
});

test("a row that does not contain the complete term is dropped", async () => {
  const schema = await schemaFrom();
  /* The server was asked for "anglin" via the 6-character anchor, and answered
   * with a row that does not contain it. A condition the instance declined to
   * apply must not reach the panel as a verified result. */
  const get = makeGet(baseTables({
    sys_user: [
      userRow({ userName: "beth.anglin", name: "Beth Anglin" }),
      userRow({ userName: "unrelated.person", name: "Unrelated Person" }),
    ],
  }));
  const result = await IMP.runSearch(IMP.parseSearch({ term: "anglin" }), { get, schema });
  assert.deepStrictEqual(own(result.results.map((user) => user.userName)), ["beth.anglin"]);
});

test("an exact sys_id lookup is the one case that skips complete-term verification", async () => {
  const schema = await schemaFrom();
  const id = sysId("dd");
  const get = makeGet(baseTables({
    sys_user: [userRow({ sysId: id, userName: "some.user", name: "Some User" })],
  }));
  const result = await IMP.runSearch(IMP.parseSearch({ term: id }), { get, schema });
  assert.strictEqual(result.results.length, 1);
  assert.strictEqual(result.results[0].sysId, id);
  const call = get.forTable("sys_user")[0];
  assert.ok(call.query.startsWith("sys_id=" + id + "^"));
  assert.ok(call.query.includes("active=true"), "eligibility still applies to a sys_id lookup");
  assert.strictEqual(call.limit, 1);
});

test("ranking runs exact, then prefix, then substring, across all four text fields", async () => {
  const schema = await schemaFrom();
  /* One field each, so a row can only win on the field it is meant to test. */
  const get = makeGet(baseTables({
    sys_user: [
      /* Inside a word, so it is the weakest match of the four. */
      userRow({ userName: "d.inner", name: "Blacksmith Holdings" }),
      /* At a word boundary but not at the start of the value. */
      userRow({ userName: "c.boundary", name: "Q", title: "Lead smith engineer" }),
      /* Starts the value. */
      userRow({ userName: "b.prefix", name: "R", email: "smith.jones@example.com" }),
      /* Is the value. */
      userRow({ userName: "smith", name: "S" }),
    ],
  }));
  const result = await IMP.runSearch(IMP.parseSearch({ term: "smith" }), { get, schema });
  assert.deepStrictEqual(
    own(result.results.map((user) => user.userName)),
    ["smith", "b.prefix", "c.boundary", "d.inner"]
  );
});

/* ------------------------------------------------------------------ *
 * The three orders
 * ------------------------------------------------------------------ */

test("each input combination picks its documented order", () => {
  const role = sysId("aa");
  const group = sysId("ga");
  const attribute = { field: "country", value: "GB" };
  assert.strictEqual(IMP.searchOrder({ term: "abel" }), "user-first");
  /* Text rides the membership read rather than capping ahead of it: an
   * unordered text window can hold none of the members at all. */
  assert.strictEqual(IMP.searchOrder({ term: "abel", roleSysId: role }), "role-first");
  assert.strictEqual(IMP.searchOrder({ term: "abel", groupSysId: group }), "group-first");
  assert.strictEqual(IMP.searchOrder({ term: "abel", groupSysId: group, roleSysId: role }), "group-first");
  assert.strictEqual(IMP.searchOrder({ term: "abel", attribute }), "user-first");
  /* An exact sys_id is one row that nothing can crowd out. */
  assert.strictEqual(IMP.searchOrder({ term: sysId("exact"), groupSysId: group }), "user-first");
  assert.strictEqual(IMP.searchOrder({ term: sysId("exact"), roleSysId: role }), "user-first");
  assert.strictEqual(IMP.searchOrder({ groupSysId: group }), "group-first");
  /* The group is the narrower population and its read can carry eligibility,
   * so it drives whenever there is no text -- a role included. */
  assert.strictEqual(IMP.searchOrder({ groupSysId: group, roleSysId: role }), "group-first");
  assert.strictEqual(IMP.searchOrder({ groupSysId: group, attribute }), "group-first");
  assert.strictEqual(IMP.searchOrder({ roleSysId: role }), "role-first");
  assert.strictEqual(IMP.searchOrder({ roleSysId: role, attribute }), "role-first");
  assert.strictEqual(IMP.searchOrder({ attribute }), "attribute-first");
  assert.strictEqual(IMP.searchOrder({}), "none");
  assert.strictEqual(IMP.parseSearch({}).ok, false, "nothing to search reads nothing");
});

test("an attribute alone searches, with no text and no role and no anchor minimum", async () => {
  const schema = await schemaFrom();
  const get = makeGet(baseTables({
    sys_user: [userRow({ userName: "gb.user", name: "GB User", country: "GB" })],
  }));
  /* GB is two characters. The three-character minimum never applies, because
   * nothing was typed: it is an exact condition on a chosen option. */
  const parsed = IMP.parseSearch({ attribute: { field: "country", value: "GB" } });
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.order, "attribute-first");

  const result = await IMP.runSearch(parsed, { get, schema });
  assert.strictEqual(result.order, "attribute-first");
  assert.strictEqual(result.results.length, 1);
  const query = get.forTable("sys_user")[0].query;
  assert.ok(query.startsWith("country=GB^"), "exact condition first: " + query);
  assert.ok(!query.includes("LIKE"), "an attribute never becomes a LIKE");
});

test("the attribute joins the candidate read when text is present, never a post-filter", async () => {
  const schema = await schemaFrom();
  const get = makeGet(baseTables({
    sys_user: [userRow({ userName: "gb.user", name: "GB User", country: "GB" })],
  }));
  await IMP.runSearch(
    IMP.parseSearch({ term: "user", attribute: { field: "country", value: "GB" } }),
    { get, schema }
  );
  const call = get.forTable("sys_user")[0];
  assert.ok(call.query.includes("country=GB"),
    "the exact condition must narrow BEFORE the cap, or a capped page silently shrinks");
  assert.strictEqual(call.limit, IMP.USER_CANDIDATE_LIMIT);
});

test("a role reads its holders first, with the text and eligibility dot-walked", async () => {
  const schema = await schemaFrom();
  const role = sysId("ab");
  const user = userRow({ userName: "holder", name: "Holder One" });
  const tables = baseTables({
    sys_user: [user],
    sys_user_has_role: [membershipRow(user.sys_id, role, false)],
  });
  const eligibility = "^user.active=true^user.locked_out=false^user.user_nameISNOTEMPTY" +
    "^user.web_service_access_only=false^ORuser.web_service_access_onlyISEMPTY";

  const roleOnly = makeGet(tables);
  const first = await IMP.runSearch(IMP.parseSearch({ roleSysId: role }), {
    get: roleOnly, schema,
  });
  assert.strictEqual(first.order, "role-first");
  assert.strictEqual(roleOnly.calls[0].table, "sys_user_has_role");
  /* Verified on a customer instance: dot-walked eligibility kept exactly the
   * holders a direct sys_user read calls eligible -- 26 of 41 for one surname
   * -- so without it half the window went on accounts never listed. */
  assert.strictEqual(roleOnly.calls[0].query, "role=" + role + "^state=active" + eligibility);

  const withText = makeGet(tables);
  const second = await IMP.runSearch(
    IMP.parseSearch({ term: "Holder", roleSysId: role }), { get: withText, schema }
  );
  assert.strictEqual(second.order, "role-first");
  assert.strictEqual(withText.calls[0].table, "sys_user_has_role",
    "the text narrows the membership read itself, before its cap");
  assert.strictEqual(withText.calls[0].query,
    "role=" + role + "^state=active" +
    "^user.user_nameLIKEHolder^ORuser.nameLIKEHolder^ORuser.emailLIKEHolder^ORuser.titleLIKEHolder" +
    eligibility);
  assert.ok(!withText.forTable("sys_user").some((call) => call.query.includes("LIKE")),
    "no unordered text window is read at all");
  assert.deepStrictEqual(own(second.results.map((found) => found.userName)), ["holder"]);
});

test("role-only reads every collected id up to 100, not the 50-row text window", async () => {
  const schema = await schemaFrom();
  const role = sysId("ac");
  const users = [];
  const memberships = [];
  for (let index = 0; index < 80; index += 1) {
    const row = userRow({ userName: "holder" + index, name: "Holder " + index });
    users.push(row);
    memberships.push(membershipRow(row.sys_id, role, index % 2 === 0));
  }
  const get = makeGet(baseTables({ sys_user: users, sys_user_has_role: memberships }));
  const result = await IMP.runSearch(IMP.parseSearch({ roleSysId: role }), { get, schema });

  const userCall = get.forTable("sys_user")[0];
  assert.strictEqual(userCall.limit, IMP.ROLE_ONLY_USER_LIMIT);
  assert.notStrictEqual(userCall.limit, IMP.USER_CANDIDATE_LIMIT,
    "applying the text window here would silently halve the population before counting");
  assert.strictEqual(userCall.query.split("sys_idIN")[1].split("^")[0].split(",").length, 80);
  assert.strictEqual(result.eligibleTotal, 80);
  assert.strictEqual(result.results.length, IMP.RESULT_LIMIT);
});

/* ------------------------------------------------------------------ *
 * Membership: dedupe, the cap, and the two opposite rules
 * ------------------------------------------------------------------ */

test("duplicate membership rows collapse and a direct row wins over an inherited one", () => {
  const role = sysId("ad");
  const user = sysId("ae");
  const collapsed = IMP.dedupeMemberships([
    membershipRow(user, role, true),
    membershipRow(user, role, false),
  ], null);
  assert.strictEqual(collapsed.length, 1);
  assert.strictEqual(collapsed[0].inherited, false, "the direct grant is the truthful badge");

  /* And in the other arrival order. */
  const other = IMP.dedupeMemberships([
    membershipRow(user, role, false),
    membershipRow(user, role, true),
  ], null);
  assert.strictEqual(other[0].inherited, false);
});

test("the cap+1 probe answers completeness, and nothing else", async () => {
  const schema = await schemaFrom();
  const role = sysId("af");

  const complete = [];
  for (let index = 0; index < 30; index += 1) {
    complete.push(membershipRow(sysId(), role, false));
  }
  const completeGet = makeGet(baseTables({
    sys_user_has_role: complete,
    sys_user: complete.map((row, index) =>
      userRow({ sysId: row.user, userName: "holder" + index, name: "Holder " + index })),
  }));
  const whole = await IMP.runSearch(IMP.parseSearch({ roleSysId: role }), {
    get: completeGet, schema,
  });
  assert.strictEqual(completeGet.forTable("sys_user_has_role")[0].limit, IMP.MEMBERSHIP_LIMIT + 1,
    "cap + 1 rows are requested so the cap itself can be detected");
  assert.strictEqual(whole.membershipCapped, false);
  assert.strictEqual(whole.eligibleTotal, 30);
});

test("a capped membership read in the ROLE-ONLY order truncates the list honestly", async () => {
  const schema = await schemaFrom();
  const role = sysId("ag");
  const memberships = [];
  const users = [];
  for (let index = 0; index < IMP.MEMBERSHIP_LIMIT + 1; index += 1) {
    const row = userRow({ userName: "holder" + index, name: "Holder " + index });
    users.push(row);
    memberships.push(membershipRow(row.sys_id, role, false));
  }
  const get = makeGet(baseTables({ sys_user_has_role: memberships, sys_user: users }));
  const result = await IMP.runSearch(IMP.parseSearch({ roleSysId: role }), { get, schema });

  /* Every row returned is a genuine holder, so partial results are honest --
   * and no total is claimed, eligible or otherwise. */
  assert.strictEqual(result.membershipCapped, true);
  assert.strictEqual(result.eligibleTotal, null);
  assert.strictEqual(result.results.length, IMP.RESULT_LIMIT);
  assert.notStrictEqual(result.roleFilter.status, "unavailable");
});

test("a role intersection too large to read makes role filtering unavailable", async () => {
  const schema = await schemaFrom();
  const group = sysId("ah-group");
  const role = sysId("ah");
  const members = [];
  for (let index = 0; index < 40; index += 1) {
    members.push(userRow({ userName: "holder" + index, name: "Holder " + index }));
  }
  /* Forty members, each with far more role rows than one window can hold. */
  const roleRows = [];
  members.forEach((row) => {
    for (let copy = 0; copy < 5; copy += 1) roleRows.push(membershipRow(row.sys_id, role, copy > 0));
  });
  const get = makeGet(baseTables({
    sys_user_grmember: members.map((row) => groupMemberRow(row.sys_id, group)),
    sys_user: (request) => members.filter((row) => request.query.includes(row.sys_id)),
    sys_user_has_role: roleRows,
  }));
  const result = await IMP.runSearch(
    IMP.parseSearch({ groupSysId: group, roleSysId: role }), { get, schema }
  );

  /*
   * Here the cap corrupts the FILTER rather than the list: a candidate cut off
   * by it is indistinguishable from one that genuinely lacks the role. The two
   * rules look contradictory in isolation, which is why both are pinned.
   */
  assert.strictEqual(result.roleFilter.status, "unavailable");
  assert.deepStrictEqual(own(result.results), []);
  assert.strictEqual(result.eligibleTotal, null, "no total may be claimed either");
  assert.ok(result.roleFilter.reason);
});

test("the displayed total counts users after dedupe, eligibility and the attribute", async () => {
  const schema = await schemaFrom();
  const role = sysId("ai");
  const ok1 = userRow({ userName: "ok.one", name: "Ok One", country: "GB" });
  const ok2 = userRow({ userName: "ok.two", name: "Ok Two", country: "GB" });
  const inactive = userRow({ userName: "gone.one", name: "Gone One", country: "GB", active: "false" });
  const locked = userRow({ userName: "locked.one", name: "Locked One", country: "GB", lockedOut: "true" });
  const elsewhere = userRow({ userName: "other.one", name: "Other One", country: "US" });
  const users = [ok1, ok2, inactive, locked, elsewhere];

  /* Seven membership rows, five distinct users -- so a membership row count
   * would say 7, a deduplicated one 5, and only the eligibility- and
   * attribute-filtered user count says 2. */
  const memberships = users
    .map((row) => membershipRow(row.sys_id, role, false))
    .concat([membershipRow(ok1.sys_id, role, true), membershipRow(ok2.sys_id, role, true)]);

  const get = makeGet(baseTables({
    sys_user_has_role: memberships,
    sys_user: (request) => users.filter((row) =>
      request.query.includes(row.sys_id) &&
      (!request.query.includes("country=GB") || row.country === "GB")),
  }));
  const result = await IMP.runSearch(
    IMP.parseSearch({ roleSysId: role, attribute: { field: "country", value: "GB" } }),
    { get, schema }
  );
  assert.strictEqual(result.eligibleTotal, 2, "not 7, not 5, not 3");
  assert.deepStrictEqual(own(result.results.map((user) => user.userName)).sort(), ["ok.one", "ok.two"]);
  assert.ok(get.forTable("sys_user")[0].query.includes("country=GB"),
    "the attribute joins the user read, not a post-filter after the cap");
});

test("the role badge reports direct and inherited, and claims no provenance", async () => {
  const schema = await schemaFrom();
  const role = sysId("aj");
  const direct = userRow({ userName: "direct.holder", name: "Direct Holder" });
  const inherited = userRow({ userName: "inherited.holder", name: "Inherited Holder" });
  const get = makeGet(baseTables({
    sys_user: [direct, inherited],
    sys_user_has_role: [
      membershipRow(direct.sys_id, role, false),
      membershipRow(inherited.sys_id, role, true),
    ],
  }));
  const result = await IMP.runSearch(
    IMP.parseSearch({ term: "Holder", roleSysId: role }), { get, schema }
  );
  const byName = new Map(result.results.map((user) => [user.userName, user]));
  assert.strictEqual(byName.get("direct.holder").membership.inherited, false);
  assert.strictEqual(byName.get("inherited.holder").membership.inherited, true);
  /* granted_by and included_in_role are empty on every sampled row, so nothing
   * here may ever carry a group name. */
  result.results.forEach((user) => {
    assert.deepStrictEqual(own(Object.keys(user.membership)), ["inherited"]);
  });
});

test("a membership row naming another role or an unrequested user is discarded", () => {
  const role = sysId("ak");
  const other = sysId("al");
  const asked = sysId("am");
  const rows = [
    membershipRow(asked, role, false),
    membershipRow(asked, other, false),
    membershipRow(sysId(), role, false),
  ];
  const verified = IMP.verifyMembershipRows(rows, role, [asked]);
  assert.strictEqual(verified.length, 1);
  assert.strictEqual(verified[0].role, role);
});

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

/* Answers a sys_user read with every row whose sys_id the query names. */
const usersNamedIn = (users) => (request) =>
  users.filter((row) => request.query.includes(row.sys_id));

test("group-first spends its cap on eligible members: every eligibility term is dot-walked", async () => {
  const schema = await schemaFrom();
  const group = sysId("gd");
  const member = userRow({ userName: "member.one", name: "Member One" });
  const get = makeGet(baseTables({
    sys_user_grmember: [groupMemberRow(member.sys_id, group)],
    sys_user: usersNamedIn([member]),
  }));
  const result = await IMP.runSearch(IMP.parseSearch({ groupSysId: group }), { get, schema });

  assert.strictEqual(result.order, "group-first");
  assert.strictEqual(get.calls[0].table, "sys_user_grmember",
    "membership is read first when there is no text to narrow with");
  const memberCall = get.forTable("sys_user_grmember")[0];
  assert.strictEqual(memberCall.limit, IMP.MEMBERSHIP_LIMIT + 1);
  assert.ok(memberCall.query.startsWith("group=" + group + "^"), memberCall.query);
  /* Both halves of the OR group are walked, and it is still last: a prefix on
   * the first half alone would leave the second testing a field the
   * membership table does not have. */
  assert.ok(memberCall.query.endsWith(
    "^user.web_service_access_only=false^ORuser.web_service_access_onlyISEMPTY"), memberCall.query);
  memberCall.query.split("^").slice(1).forEach((term) => {
    assert.ok(/^(OR)?user\./.test(term), "an eligibility term was not dot-walked: " + term);
  });

  /* The user read applies eligibility again, undotted, over the whole window. */
  const userCall = get.forTable("sys_user")[0];
  assert.strictEqual(userCall.limit, IMP.ROLE_ONLY_USER_LIMIT);
  IMP.eligibilityClauses(schema).forEach((clause) => {
    assert.ok(userCall.query.includes(clause), "user read lost " + clause);
  });
  assert.strictEqual(result.eligibleTotal, 1);
  assert.strictEqual(result.groupFilter.status, "applied");
  assert.strictEqual(result.roleFilter, null);
  assert.ok(!result.results[0].membership, "group membership carries no badge");
});

test("an ignored dot-walk cannot put an ineligible member in the list, or inflate the count", async () => {
  /* Measured: a misspelt dot-walked field is silently IGNORED and the whole
   * group comes back. So this fixture answers the member read unfiltered --
   * with the messes a customer group really has -- and the user read without
   * applying eligibility either. Only the client-side check is left. */
  const schema = await schemaFrom();
  const group = sysId("ge");
  const otherGroup = sysId("gf");
  const ok = userRow({ userName: "ok.member", name: "Ok Member" });
  const gone = userRow({ userName: "gone.member", name: "Gone Member", active: "false" });
  const locked = userRow({ userName: "locked.member", name: "Locked Member", lockedOut: "true" });
  const apiOnly = userRow({ userName: "api.member", name: "Api Member", apiOnly: "true" });
  const stray = userRow({ userName: "stray.member", name: "Stray Member" });
  const get = makeGet(baseTables({
    sys_user_grmember: [
      groupMemberRow(ok.sys_id, group),
      groupMemberRow(ok.sys_id, group),
      groupMemberRow(gone.sys_id, group),
      groupMemberRow(locked.sys_id, group),
      groupMemberRow(apiOnly.sys_id, group),
      groupMemberRow("", group),
      groupMemberRow(stray.sys_id, otherGroup),
    ],
    sys_user: usersNamedIn([ok, gone, locked, apiOnly, stray]),
  }));
  const result = await IMP.runSearch(IMP.parseSearch({ groupSysId: group }), { get, schema });

  assert.deepStrictEqual(own(result.results.map((user) => user.userName)), ["ok.member"]);
  assert.strictEqual(result.eligibleTotal, 1, "not 7 rows, not 5 users -- one eligible member");
  const ids = get.forTable("sys_user")[0].query.split("sys_idIN")[1].split("^")[0].split(",");
  assert.strictEqual(ids.length, 4, "duplicates collapse and an empty user is not an id");
  assert.ok(!ids.includes(stray.sys_id), "a row naming another group is discarded");
});

test("an attribute rides the member read as a dot-walk, before eligibility, and the user read again", async () => {
  const schema = await schemaFrom();
  const group = sysId("gg");
  const member = userRow({ userName: "gb.member", name: "GB Member", country: "GB" });
  const get = makeGet(baseTables({
    sys_user_grmember: [groupMemberRow(member.sys_id, group)],
    sys_user: usersNamedIn([member]),
  }));
  await IMP.runSearch(
    IMP.parseSearch({ groupSysId: group, attribute: { field: "country", value: "GB" } }),
    { get, schema }
  );
  const memberQuery = get.forTable("sys_user_grmember")[0].query;
  assert.ok(memberQuery.includes("^user.country=GB^"), memberQuery);
  assert.ok(memberQuery.indexOf("user.country=GB") < memberQuery.indexOf("user.active=true"),
    "the attribute must precede the OR group, or it would fall inside it");
  assert.ok(get.forTable("sys_user")[0].query.includes("country=GB"),
    "the attribute is applied again where it cannot be silently ignored");
});

test("a capped member read truncates the list honestly and claims no total", async () => {
  const schema = await schemaFrom();
  const group = sysId("gh");
  const users = [];
  for (let index = 0; index < IMP.MEMBERSHIP_LIMIT + 1; index += 1) {
    users.push(userRow({ userName: "member" + index, name: "Member " + index }));
  }
  const get = makeGet(baseTables({
    sys_user_grmember: users.map((row) => groupMemberRow(row.sys_id, group)),
    sys_user: usersNamedIn(users),
  }));
  const result = await IMP.runSearch(IMP.parseSearch({ groupSysId: group }), { get, schema });

  /* Every member returned is a genuine member -- the largest group measured
   * had 41,580 -- so partial results are honest, with no claimed total. */
  assert.strictEqual(result.membershipCapped, true);
  assert.strictEqual(result.eligibleTotal, null);
  assert.strictEqual(result.results.length, IMP.RESULT_LIMIT);
  assert.strictEqual(result.groupFilter.status, "applied");
  const ids = get.forTable("sys_user")[0].query.split("sys_idIN")[1].split("^")[0].split(",");
  assert.strictEqual(ids.length, IMP.MEMBERSHIP_LIMIT, "cap + 1 detects the cap; cap are used");
});

test("text with a group finds the member an unordered text window would have missed", async () => {
  /*
   * The reported defect, measured on a customer instance: a surname matched
   * 237 eligible users, the one group member among them was not in the 50 the
   * text read returned, and a group that plainly listed him answered
   * "nobody". Sixty namesakes stand in for the 237 here.
   */
  const schema = await schemaFrom();
  const group = sysId("gi");
  const namesakes = [];
  for (let index = 0; index < 60; index += 1) {
    namesakes.push(userRow({ userName: "namesake" + index, name: "Namesake Surname " + index }));
  }
  const member = userRow({ userName: "the.member", name: "Member Surname" });
  const everyone = namesakes.concat([member]);
  const get = makeGet(baseTables({
    /* The member read honours its dot-walked text, as the live one did. */
    sys_user_grmember: (request) => (request.query.includes("^ORuser.nameLIKESurname")
      ? [groupMemberRow(member.sys_id, group)] : []),
    /* An unordered text read would have answered with namesakes first. */
    sys_user: (request) => (request.query.includes("sys_idIN")
      ? everyone.filter((row) => request.query.includes(row.sys_id))
      : everyone.slice(0, request.limit)),
  }));
  const result = await IMP.runSearch(
    IMP.parseSearch({ term: "Surname", groupSysId: group }), { get, schema }
  );
  assert.strictEqual(result.order, "group-first");
  assert.strictEqual(get.calls[0].table, "sys_user_grmember",
    "the group and the text narrow together, before any cap");
  const memberQuery = get.forTable("sys_user_grmember")[0].query;
  assert.ok(memberQuery.startsWith("group=" + group +
    "^user.user_nameLIKESurname^ORuser.nameLIKESurname^ORuser.emailLIKESurname^ORuser.titleLIKESurname" +
    "^user.active=true^"), memberQuery);
  assert.ok(!get.forTable("sys_user").some((call) => call.query.includes("LIKE")),
    "no unordered text window is read at all");
  assert.deepStrictEqual(own(result.results.map((user) => user.userName)), ["the.member"]);
  assert.strictEqual(result.eligibleTotal, 1);
  assert.strictEqual(result.groupFilter.status, "applied");
});

test("an ignored text dot-walk cannot put a non-matching member in the list", async () => {
  /* A misspelt dot-walked field is SILENTLY IGNORED and the whole group comes
   * back. So this fixture answers the member read unfiltered, and the complete
   * term is all that stands between the panel and a wrong row. */
  const schema = await schemaFrom();
  const group = sysId("gj");
  const match = userRow({ userName: "s.match", name: "Surname Match" });
  const other = userRow({ userName: "o.other", name: "Other Person" });
  const get = makeGet(baseTables({
    sys_user_grmember: [groupMemberRow(match.sys_id, group), groupMemberRow(other.sys_id, group)],
    sys_user: (request) => [match, other].filter((row) => request.query.includes(row.sys_id)),
  }));
  const result = await IMP.runSearch(
    IMP.parseSearch({ term: "Surname", groupSysId: group }), { get, schema }
  );
  assert.deepStrictEqual(own(result.results.map((user) => user.userName)), ["s.match"]);
  assert.strictEqual(result.eligibleTotal, 1, "and the count is of verified rows");
});

test("an exact sys_id with a group stays user-first and asks about that one user", async () => {
  const schema = await schemaFrom();
  const group = sysId("gz");
  const target = userRow({ name: "Exact Person" });
  const get = makeGet(baseTables({
    sys_user: [target],
    sys_user_grmember: (request) => (request.query.includes(target.sys_id)
      ? [groupMemberRow(target.sys_id, group)] : []),
  }));
  const result = await IMP.runSearch(
    IMP.parseSearch({ term: target.sys_id, groupSysId: group }), { get, schema }
  );
  assert.strictEqual(result.order, "user-first");
  assert.strictEqual(get.calls[0].table, "sys_user");
  assert.strictEqual(get.forTable("sys_user_grmember")[0].query,
    "userIN" + target.sys_id + "^group=" + group);
  assert.deepStrictEqual(own(result.results.map((user) => user.sysId)), [target.sys_id]);
});

test("a group and a role together: group drives, the role badge survives, non-holders drop", async () => {
  const schema = await schemaFrom();
  const group = sysId("gk");
  const role = sysId("gl");
  /* 60 members, each holding the role twice (direct and inherited): 120 role
   * rows, past the old fixed bound of 100. The intersection is bounded by its
   * candidates, so this must still filter rather than report unavailable. */
  const members = [];
  for (let index = 0; index < 60; index += 1) {
    members.push(userRow({ userName: "member" + index, name: "Member " + index }));
  }
  const nonHolder = userRow({ userName: "no.role", name: "No Role" });
  const everyone = members.concat([nonHolder]);
  const roleRows = [];
  members.forEach((row) => {
    roleRows.push(membershipRow(row.sys_id, role, false));
    roleRows.push(membershipRow(row.sys_id, role, true));
  });
  const get = makeGet(baseTables({
    sys_user_grmember: everyone.map((row) => groupMemberRow(row.sys_id, group)),
    sys_user: usersNamedIn(everyone),
    sys_user_has_role: roleRows,
  }));
  const result = await IMP.runSearch(
    IMP.parseSearch({ groupSysId: group, roleSysId: role }), { get, schema }
  );
  assert.strictEqual(result.order, "group-first");
  assert.strictEqual(result.roleFilter.status, "applied");
  assert.strictEqual(result.eligibleTotal, 60);
  assert.ok(result.results.every((user) => user.membership && user.membership.inherited === false),
    "a direct row wins, as it does everywhere else");
  assert.ok(!result.results.some((user) => user.userName === "no.role"));
  const roleQuery = get.forTable("sys_user_has_role")[0].query;
  assert.ok(roleQuery.startsWith("userIN"), "the role is asked about members, not read whole");
});

test("group suggestions AND every typed word and verify each one, not the complete term", async () => {
  const team = sysId("gm");
  const archive = sysId("gn");
  const retired = sysId("go");
  const get = makeGet({
    sys_user_group: [
      { sys_id: retired, name: "Acme-EU-Service Desk", active: "false", description: "Old desk" },
      { sys_id: team, name: "Acme-EU-Service Desk Team", active: "true", description: "" },
      /* display_value=all renders an EMPTY boolean as "false"; the raw value
       * decides. Two measured groups had it empty. */
      { sys_id: archive, name: "Acme-EU-Service Desk Archive",
        active: { value: "", display_value: "false" }, description: "" },
      /* Missing two of the words: a condition the server ignored. */
      { sys_id: sysId(), name: "Service Desk", active: "true", description: "" },
    ],
  });
  const found = await IMP.findGroups("Acme EU Service Desk", { get });

  const query = get.forTable("sys_user_group")[0].query;
  ["nameLIKEService", "nameLIKEDesk", "nameLIKEAcme", "nameLIKEEU"].forEach((clause) => {
    assert.ok(query.split("^").includes(clause), "missing " + clause + " in " + query);
  });
  assert.ok(!/description/.test(query), "name only: " + query);
  assert.ok(!/active/.test(query), "no active filter, which would hide an EMPTY flag: " + query);

  /* The punctuation differs from what was typed, and the rows still match. */
  assert.deepStrictEqual(own(found.groups.map((group) => group.name)), [
    "Acme-EU-Service Desk Archive",
    "Acme-EU-Service Desk Team",
    "Acme-EU-Service Desk",
  ], "active before inactive at equal match quality, and 'Service Desk' discarded");
  assert.strictEqual(found.groups.find((group) => group.sysId === archive).active, true);
  assert.strictEqual(found.groups.find((group) => group.sysId === retired).active, false);
});

test("no operator from a typed group name reaches a query", async () => {
  ["x^ORactive=true", "a^b", "p,q", "line\nbreak", "Acme - EU"].forEach((input) => {
    const anchors = IMP.groupAnchors(input);
    if (!anchors.length) return;
    IMP.buildGroupQuery(anchors).split("^").forEach((clause) => {
      assert.ok(/^nameLIKE[A-Za-z0-9_]+$/.test(clause),
        "unsafe clause from " + JSON.stringify(input) + ": " + clause);
    });
  });
  const get = makeGet({});
  const found = await IMP.findGroups("a^b", { get });
  assert.deepStrictEqual(own(found.groups), []);
  assert.strictEqual(get.calls.length, 0, "single characters are not an anchor, so nothing is read");
});

/* ------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------ */

test("role suggestions are complete-term verified and stay bound to their sys_id", async () => {
  const catalogId = sysId("an");
  const get = makeGet({
    sys_user_role: [
      { sys_id: catalogId, name: "catalog", description: "Catalog management" },
      { sys_id: sysId(), name: "unrelated", description: "Something else entirely" },
    ],
  });
  const found = await IMP.findRoles("catalog", { get });
  assert.deepStrictEqual(own(found.roles.map((role) => role.name)), ["catalog"]);
  assert.strictEqual(found.roles[0].sysId, catalogId);

  /* sys_user_role has no active field. Inventing one would hide every role on
   * an instance that does not have it. */
  const query = get.forTable("sys_user_role")[0].query;
  assert.ok(!/active/.test(query), "no invented active-role filter: " + query);
  assert.ok(query.includes("nameLIKEcatalog"));
  assert.ok(query.includes("ORdescriptionLIKEcatalog"));
});

/* ------------------------------------------------------------------ *
 * The attribute value list
 * ------------------------------------------------------------------ */

test("a choice list is scoped to one language, active only, and refuses the javascript: row", async () => {
  const schema = await schemaFrom();
  const field = schema.attributeFields.find((item) => item.name === "country");
  const get = makeGet(baseTables({
    sys_choice: (request) => {
      /* The read has to be scoped; an unscoped one returns the same country
       * repeatedly in mixed scripts. */
      assert.ok(request.query.includes("language=en"), "language scope missing");
      assert.ok(request.query.includes("inactive=false"), "active scope missing");
      assert.ok(request.query.includes("name=sys_user"));
      assert.ok(request.query.includes("element=country"));
      return [
        { label: "United Kingdom", value: "GB", inactive: "false" },
        { label: "United States", value: "US", inactive: "false" },
        /* All three defects the live table actually carries. */
        {
          label: "javascript:gs.getMessage('System ({0})', GlideLocale.get().getCurrent().getCountry())",
          value: "NULL_OVERRIDE",
          inactive: "false",
        },
        { label: "Retired Place", value: "XX", inactive: "true" },
        { label: "イギリス", value: "GB", inactive: "false" },
      ];
    },
  }));
  const loaded = await IMP.loadAttributeValues(field, { get, schema, noCache: true });
  assert.strictEqual(loaded.kind, "choice");
  assert.deepStrictEqual(own(loaded.values.map((item) => item.value)), ["GB", "US"]);
  loaded.values.forEach((item) => {
    assert.ok(!/javascript/i.test(item.label));
    assert.notStrictEqual(item.value, "NULL_OVERRIDE");
  });
});

test("a javascript: value is refused even when the label looks ordinary", () => {
  const values = IMP.choiceValuesFrom([
    { label: "Looks fine", value: "javascript:gs.getUser()", inactive: "false" },
    { label: "Also fine", value: "JavaScript : gs.getUser()", inactive: "false" },
    { label: "Real", value: "GB", inactive: "false" },
  ]);
  assert.deepStrictEqual(own(values.map((item) => item.value)), ["GB"]);
});

test("a reference field reads its referenced table, which a choice-only build would miss", async () => {
  const schema = await schemaFrom(DEFAULT_DICTIONARY.concat([
    dictField("u_country", { label: "Country", type: "reference", reference: "core_country" }),
  ]));
  const field = schema.attributeFields.find((item) => item.name === "u_country");
  assert.strictEqual(field.type, "reference");

  const gbId = sysId("ba");
  const get = makeGet(baseTables({
    sys_dictionary: (request) => {
      if (request.query.includes("name=core_country")) {
        return [{ name: "core_country", element: "name" }];
      }
      return DEFAULT_DICTIONARY;
    },
    core_country: [
      { sys_id: gbId, name: "United Kingdom" },
      { sys_id: sysId(), name: "Germany" },
    ],
  }));
  const loaded = await IMP.loadAttributeValues(field, { get, schema, noCache: true });
  assert.strictEqual(loaded.kind, "reference");
  assert.deepStrictEqual(own(loaded.values.map((item) => item.label)), ["Germany", "United Kingdom"]);
  /* A reference resolves to a sys_id, so the condition is an exact match on
   * the identifier, not on a display string. */
  assert.strictEqual(loaded.values.find((item) => item.label === "United Kingdom").value, gbId);
  assert.strictEqual(get.forTable("sys_choice").length, 0,
    "sys_choice must not be consulted for a reference field");
});

test("a reference field's values load through the real transport, not only an injected one", async () => {
  /* Every other test injects `get`, which skips the transport's own table
   * check. That check refused the admitted reference table, so the panel's
   * value list failed on every reference field while this suite stayed green. */
  const sent = [];
  const gbId = sysId("bc");
  const engine = loadEngine({
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          sent.push(message);
          if (message.table === "sys_dictionary") {
            return { ok: true, result: [{ name: "core_country", element: "name" }] };
          }
          if (message.table === "core_country") {
            return { ok: true, result: [{ sys_id: gbId, name: "United Kingdom" }] };
          }
          return { ok: true, result: [] };
        },
      },
    },
  });
  const schema = await engine.resolveUserSchema({
    get: makeGet(baseTables({ sys_dictionary: DEFAULT_DICTIONARY.concat([
      dictField("u_country", { label: "Country", type: "reference", reference: "core_country" }),
    ]) })),
    noCache: true,
  });
  const field = schema.attributeFields.find((item) => item.name === "u_country");

  const loaded = await engine.loadAttributeValues(field, { schema, noCache: true });
  assert.deepStrictEqual(own(loaded.values.map((item) => item.value)), [gbId]);
  assert.ok(sent.some((message) => message.table === "core_country"),
    "the referenced table never reached the transport");

  /* Admitting it for that one read does not admit it anywhere else -- and
   * the exported transport cannot be handed a table to admit. */
  await assert.rejects(
    () => engine.tableGet({ table: "core_country", query: "", fields: "", limit: 1 }),
    (error) => error.code === "validation"
  );
  await assert.rejects(
    () => engine.tableGet({ table: "core_country", query: "", fields: "", limit: 1 }, "core_country"),
    (error) => error.code === "validation"
  );
});

test("a referenced table larger than the cap degrades to a server-side type-ahead", async () => {
  const schema = await schemaFrom(DEFAULT_DICTIONARY.concat([
    dictField("u_country", { label: "Country", type: "reference", reference: "core_country" }),
  ]));
  const field = schema.attributeFields.find((item) => item.name === "u_country");
  const rows = [];
  for (let index = 0; index < IMP.ATTRIBUTE_VALUE_LIMIT + 1; index += 1) {
    rows.push({ sys_id: sysId(), name: "Place " + index });
  }
  const get = makeGet(baseTables({
    sys_dictionary: (request) => (request.query.includes("name=core_country")
      ? [{ name: "core_country", element: "name" }] : DEFAULT_DICTIONARY),
    core_country: (request) => (request.query.includes("LIKE")
      ? [{ sys_id: sysId("bb"), name: "Placeholder Republic" }]
      : rows),
  }));

  const first = await IMP.loadAttributeValues(field, { get, schema, noCache: true });
  assert.strictEqual(first.truncated, true, "the control must not present this as complete");

  const typed = await IMP.loadAttributeValues(field, {
    get, schema, noCache: true, term: "Placeholder",
  });
  assert.strictEqual(typed.searched, true);
  assert.deepStrictEqual(own(typed.values.map((item) => item.label)), ["Placeholder Republic"]);
  const query = get.forTable("core_country").pop().query;
  assert.ok(query.startsWith("nameLIKEPlaceholder"),
    "narrowing has to happen on the server: " + query);
});

test("an empty or unreadable value list yields nothing rather than a hardcoded fallback", async () => {
  const schema = await schemaFrom();
  const field = schema.attributeFields.find((item) => item.name === "country");
  const get = makeGet(baseTables({ sys_choice: [] }));
  const loaded = await IMP.loadAttributeValues(field, { get, schema, noCache: true });
  assert.deepStrictEqual(own(loaded.values), []);

  /* And nothing anywhere in the engine names a country. */
  const source = fs.readFileSync(path.join(__dirname, "..", "impersonate.js"), "utf8");
  ["United Kingdom", "Germany", '"GB"', "'GB'"].forEach((needle) => {
    assert.ok(!source.includes(needle), "the engine must not carry a country list: " + needle);
  });
});

test("a field no longer offered by the live dictionary is refused", async () => {
  const schema = await schemaFrom();
  await assert.rejects(
    () => IMP.loadAttributeValues({ name: "u_vanished", type: "choice" }, { schema }),
    (error) => error.code === "schema"
  );
});

test("a reference field with no schema to check it against is refused", async () => {
  /* The reference path is the one place a table outside the fixed allowlist is
   * read, and the schema is what admits it. Without one there is nothing to
   * check the named table against. */
  const get = makeGet(baseTables({ sys_update_xml: [{ sys_id: sysId(), name: "x" }] }));
  await assert.rejects(
    () => IMP.loadAttributeValues(
      { name: "u_smuggled", type: "reference", reference: "sys_update_xml" },
      { get }
    ),
    (error) => error.code === "schema"
  );
  assert.strictEqual(get.forTable("sys_update_xml").length, 0);
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

test("a restricted column is access, never empty", async () => {
  const schema = await schemaFrom();
  const get = async (request) => {
    if (request.table === "sys_user") {
      const error = new Error("You do not have read access to the user or role data this needs.");
      error.code = "access";
      error.status = 403;
      throw error;
    }
    return [];
  };
  await assert.rejects(
    () => IMP.runSearch(IMP.parseSearch({ term: "sample" }), { get, schema }),
    (error) => {
      /* §3.11 is this hazard in two forms: a blocked column 403s the whole
       * request, or is silently omitted. Neither may read as "no value set". */
      assert.strictEqual(error.code, "access");
      assert.notStrictEqual(error.code, "empty");
      return true;
    }
  );
});

test("no error string carries a query, an identity or a hostname", async () => {
  const messages = [];
  const collect = async (thunk) => {
    try { await thunk(); } catch (error) { messages.push(String(error.message)); }
  };
  const schema = await schemaFrom();
  await collect(() => IMP.runSearch(IMP.parseSearch({ term: "sample" }), {
    schema,
    get: async () => {
      const error = new Error("x");
      throw Object.assign(error, { code: "access", status: 403 });
    },
  }));
  [401, 403, 404, 429, 500, 0].forEach((status) => {
    messages.push(IMP.parseSearch({ term: "ab" }).error || "");
  });
  messages.push(IMP.parseSearch({ roleSysId: "itil" }).error);
  messages.push(IMP.parseSearch({}).error);
  messages.push(IMP.validateUserName("null").error);
  messages.filter(Boolean).forEach((message) => {
    assert.ok(!/service-now\.com|https?:\/\//.test(message), "hostname leaked: " + message);
    assert.ok(!/sysparm|\^OR|LIKE|ISNOTEMPTY/.test(message), "query leaked: " + message);
    assert.ok(!/@/.test(message), "an address-shaped value leaked: " + message);
    assert.ok(!/[0-9a-f]{32}/.test(message), "a sys_id leaked: " + message);
  });
});

/* ------------------------------------------------------------------ *
 * The recent-impersonations list
 * ------------------------------------------------------------------ */

test("a recent account is read through the eligibility gate, and a locked one is counted, not listed", async () => {
  const schema = await schemaFrom();
  const kept = sysId("recent-kept");
  const locked = sysId("recent-locked");
  const gone = sysId("recent-gone");
  /* The fake server ignores the query and answers with every row, so this
   * proves the client-side re-check rather than the server condition. */
  const get = makeGet(baseTables({
    sys_user: [
      userRow({ sysId: kept, userName: "kept.user", name: "Kept User" }),
      userRow({ sysId: locked, userName: "locked.user", name: "Locked User", lockedOut: "true" }),
    ],
  }));
  const found = await IMP.readRecentUsers([kept, locked, gone], { get, schema });
  assert.deepStrictEqual(own(found.users.map((user) => user.userName)), ["kept.user"]);
  /* Deleted and locked alike: a count, and nobody named. */
  assert.strictEqual(found.hidden, 2);

  const read = get.forTable("sys_user")[0];
  assert.ok(read.query.startsWith("sys_idIN" + [kept, locked, gone].join(",") + "^"), read.query);
  assert.ok(read.query.endsWith(
    "web_service_access_only=false^ORweb_service_access_onlyISEMPTY"), read.query);
  assert.ok(read.query.includes("active=true^locked_out=false"), read.query);
  assert.strictEqual(read.limit, 3);
});

test("the recent list keeps the platform's order, not the search's alphabetical one", async () => {
  const schema = await schemaFrom();
  const zed = sysId("recent-zed");
  const amy = sysId("recent-amy");
  const get = makeGet(baseTables({
    sys_user: [
      userRow({ sysId: amy, userName: "amy.user", name: "Amy User" }),
      userRow({ sysId: zed, userName: "zed.user", name: "Zed User" }),
    ],
  }));
  const found = await IMP.readRecentUsers([zed, amy], { get, schema });
  assert.deepStrictEqual(own(found.users.map((user) => user.userName)), ["zed.user", "amy.user"]);
});

test("recent ids are validated, deduplicated and bounded before any read", async () => {
  const schema = await schemaFrom();
  const get = makeGet(baseTables({ sys_user: [] }));
  const nothing = await IMP.readRecentUsers(["not-an-id", "", null, "x".repeat(32)], { get, schema });
  assert.strictEqual(nothing.users.length, 0);
  assert.strictEqual(nothing.hidden, 0);
  assert.strictEqual(get.forTable("sys_user").length, 0, "nothing valid, so nothing is read");

  const ids = [];
  for (let index = 0; index < IMP.RECENT_LIMIT + 5; index += 1) ids.push(sysId());
  const upper = ids[0].toUpperCase();
  await IMP.readRecentUsers([upper, ids[0]].concat(ids), { get, schema });
  const read = get.forTable("sys_user")[0];
  const listed = read.query.split("^")[0].replace("sys_idIN", "").split(",");
  assert.strictEqual(listed.length, IMP.RECENT_LIMIT);
  assert.strictEqual(new Set(listed).size, listed.length, "a repeated id is read once");
  assert.strictEqual(listed[0], ids[0], "and case-folded, since the table stores lower case");
});

test("a superseded recent read reports stale rather than an empty list", async () => {
  const schema = await schemaFrom();
  const get = makeGet(baseTables({ sys_user: [userRow({ sysId: sysId("recent-stale") })] }));
  const found = await IMP.readRecentUsers([sysId("recent-stale")], {
    get, schema, shouldStop: () => true,
  });
  assert.strictEqual(found.stale, true);
  assert.strictEqual(found.users.length, 0);
});

/* ------------------------------------------------------------------ *
 * The confirmation's roles
 * ------------------------------------------------------------------ */

function roleRow(userSysId, roleSysId, name, inherited) {
  return {
    user: { value: userSysId, display_value: "Sample User" },
    role: { value: roleSysId, display_value: name },
    inherited: { value: inherited ? "true" : "false", display_value: inherited ? "true" : "false" },
  };
}

test("one account's roles are read from the effective table, bounded, and verified", async () => {
  const person = sysId("roles-person");
  const get = makeGet({ sys_user_has_role: [] });
  await IMP.readUserRoles(person.toUpperCase(), { get });
  const read = get.forTable("sys_user_has_role")[0];
  assert.strictEqual(read.query, "user=" + person + "^state=active");
  assert.strictEqual(read.limit, IMP.USER_ROLE_LIMIT + 1, "cap + 1 answers whether it was complete");
  assert.ok(read.fields.split(",").includes("inherited"));
  assert.strictEqual(read.options.displayAll, true, "the role's display value is its name");

  await assert.rejects(IMP.readUserRoles("not-an-id", { get }), (error) => error.code === "validation");
  assert.strictEqual(get.forTable("sys_user_has_role").length, 1, "nothing is read for a bad id");
});

test("roles split into direct and inherited, a direct row wins, and duplicates collapse", async () => {
  const person = sysId("roles-split");
  const itil = sysId("role-itil");
  const approver = sysId("role-approver");
  const catalog = sysId("role-catalog");
  const get = makeGet({
    sys_user_has_role: [
      roleRow(person, itil, "itil", true),
      roleRow(person, itil, "itil", false),
      roleRow(person, approver, "approver_user", true),
      roleRow(person, approver, "approver_user", true),
      roleRow(person, catalog, "Catalog", false),
    ],
  });
  const found = await IMP.readUserRoles(person, { get });
  assert.deepStrictEqual(own(found.direct), ["Catalog", "itil"], "sorted, case-insensitively");
  assert.deepStrictEqual(own(found.inherited), ["approver_user"]);
  assert.strictEqual(found.capped, false);
  assert.strictEqual(found.unnamed, 0);
});

test("a row about someone else, a malformed role and a nameless role never become a name", async () => {
  const person = sysId("roles-verify");
  const get = makeGet({
    sys_user_has_role: [
      roleRow(person, sysId("role-kept"), "kept_role", false),
      /* The fake server ignores the query: a row for another account is a
       * condition that did not hold. */
      roleRow(sysId("roles-other"), sysId("role-other"), "someone_elses_role", false),
      roleRow(person, "not-a-sys-id", "malformed_role", false),
      /* A restricted name comes back blank, or as the bare sys_id. */
      roleRow(person, sysId("role-blank"), "", true),
      roleRow(person, sysId("role-bare"), sysId("role-bare"), true),
    ],
  });
  const found = await IMP.readUserRoles(person, { get });
  assert.deepStrictEqual(own(found.direct), ["kept_role"]);
  assert.deepStrictEqual(own(found.inherited), []);
  assert.strictEqual(found.unnamed, 2, "counted, not printed");
});

test("a read that reaches the cap says the lists are incomplete", async () => {
  const person = sysId("roles-capped");
  const rows = [];
  for (let index = 0; index <= IMP.USER_ROLE_LIMIT; index += 1) {
    rows.push(roleRow(person, String(index).padStart(32, "a"), "role_" + index, true));
  }
  const get = makeGet({ sys_user_has_role: rows });
  const found = await IMP.readUserRoles(person, { get });
  assert.strictEqual(found.capped, true);
  assert.strictEqual(found.inherited.length, IMP.USER_ROLE_LIMIT, "the probe row is not listed");
  /* The roles the read missed may be the ones that contain these, so nothing
   * is called assigned from it. */
  assert.strictEqual(get.forTable("sys_user_role_contains").length, 0);
  assert.strictEqual(found.containment, "unavailable");
  assert.strictEqual(found.assigned, null);
  assert.strictEqual(found.bundled, null);
});

test("a superseded roles read reports stale", async () => {
  const person = sysId("roles-stale");
  const get = makeGet({ sys_user_has_role: [roleRow(person, sysId("role-s"), "some_role", false)] });
  const found = await IMP.readUserRoles(person, { get, shouldStop: () => true });
  assert.strictEqual(found.stale, true);
  assert.strictEqual(found.direct.length, 0);
});

/* sys_user_role_contains is read with raw values, so its rows are plain ids:
 * `role` is the parent and `contains` the role it brings with it. */
function containsRow(parentSysId, childSysId) {
  return { role: parentSysId, contains: childSysId };
}

test("assigned roles are every direct grant plus each inherited role no held role contains", async () => {
  const person = sysId("assigned-person");
  const role = (name) => sysId("assigned-role-" + name);
  const get = makeGet({
    sys_user_has_role: [
      roleRow(person, role("catalog_admin"), "catalog_admin", false),
      /* Direct AND contained: a direct grant is always assigned. */
      roleRow(person, role("itil"), "itil", false),
      roleRow(person, role("approver_user"), "approver_user", true),
      roleRow(person, role("snc_internal"), "snc_internal", true),
      roleRow(person, role("catalog"), "catalog", true),
      roleRow(person, role("itil_part"), "itil_part", true),
      roleRow(person, role("deep_part"), "deep_part", true),
    ],
    sys_user_role_contains: [
      containsRow(role("catalog_admin"), role("itil")),
      containsRow(role("catalog_admin"), role("catalog")),
      containsRow(role("itil"), role("itil_part")),
      /* Two levels down is still bundled. */
      containsRow(role("itil_part"), role("deep_part")),
      /* A contained role the person does not hold bundles nothing. */
      containsRow(role("itil"), role("not_held")),
      /* A row about a role never asked for is a condition that did not hold:
       * it must not bundle a held role away. */
      containsRow(role("never_asked"), role("approver_user")),
    ],
  });
  const found = await IMP.readUserRoles(person, { get });
  assert.strictEqual(found.containment, "applied");
  assert.deepStrictEqual(own(found.assigned), ["approver_user", "catalog_admin", "itil", "snc_internal"]);
  assert.deepStrictEqual(own(found.bundled), ["catalog", "deep_part", "itil_part"]);
  assert.deepStrictEqual(own(found.direct), ["catalog_admin", "itil"]);
  /* The plain split is still there for the fallback. */
  assert.strictEqual(found.inherited.length, 5);

  const read = get.forTable("sys_user_role_contains")[0];
  assert.strictEqual(read.fields, "role,contains");
  assert.strictEqual(read.limit, IMP.CONTAINMENT_LIMIT + 1, "cap + 1 answers whether it was complete");
  assert.strictEqual(read.options.displayAll, false, "two ids a row and nothing to display");
  assert.ok(read.query.startsWith("roleIN"), read.query);
  assert.deepStrictEqual(read.query.slice("roleIN".length).split(",").sort(),
    ["approver_user", "catalog", "catalog_admin", "deep_part", "itil", "itil_part", "snc_internal"]
      .map(role).sort(), "every held role is asked about, and nothing else");
});

test("the containment table joins the allowlist, and a roles read goes 100 ids at a time", async () => {
  assert.ok(IMP.TABLE_ALLOWLIST.includes("sys_user_role_contains"));
  const person = sysId("chunk-person");
  const rows = [];
  for (let index = 0; index < 250; index += 1) {
    rows.push(roleRow(person, String(index).padStart(32, "b"), "chunk_role_" + index, true));
  }
  const get = makeGet({ sys_user_has_role: rows });
  const found = await IMP.readUserRoles(person, { get });
  get.calls.forEach((call) => {
    assert.ok(IMP.TABLE_ALLOWLIST.includes(call.table), "unexpected table read: " + call.table);
  });
  const reads = get.forTable("sys_user_role_contains");
  /* ~400 ids in one GET answered 414 on a customer instance; 100 was fine. */
  assert.deepStrictEqual(own(reads.map((read) => read.query.split(",").length)), [100, 100, 50]);
  const asked = reads.flatMap((read) => read.query.slice("roleIN".length).split(","));
  assert.strictEqual(new Set(asked).size, 250, "every held role asked about once");
  assert.strictEqual(found.containment, "applied");
  assert.strictEqual(found.assigned.length, 250, "nothing contains anything, so all are assigned");
  assert.strictEqual(found.bundled.length, 0);
  /* Allowlisted, so the transport check passes it and it fails on the absent
   * transport instead. */
  await assert.rejects(
    () => IMP.tableGet({ table: "sys_user_role_contains", query: "", fields: "", limit: 1 }),
    (error) => error.code === "transient"
  );
});

test("containment that cannot all be read falls back to direct and inherited, never to assigned", async () => {
  const person = sysId("fallback-person");
  const direct = sysId("fallback-direct");
  const parent = sysId("fallback-parent");
  const child = sysId("fallback-child");
  const roles = [
    roleRow(person, direct, "direct_role", false),
    roleRow(person, parent, "parent_role", true),
    roleRow(person, child, "child_role", true),
  ];
  const tooMany = [];
  for (let index = 0; index <= IMP.CONTAINMENT_LIMIT; index += 1) {
    tooMany.push(containsRow(parent, child));
  }
  const cases = {
    "a failed read": () => { throw Object.assign(new Error("denied"), { code: "access" }); },
    "a capped read": tooMany,
    /* A restricted column comes back blank: an ACL, not an absent edge. */
    "a blank column": [containsRow(parent, ""), containsRow(parent, child)],
    "a malformed id": [containsRow("not-an-id", child)],
  };
  for (const [label, answer] of Object.entries(cases)) {
    const get = makeGet({ sys_user_has_role: roles, sys_user_role_contains: answer });
    const found = await IMP.readUserRoles(person, { get });
    assert.strictEqual(found.stale, false, label);
    assert.strictEqual(found.containment, "unavailable", label);
    assert.strictEqual(found.assigned, null, label + ": nothing is called assigned");
    assert.strictEqual(found.bundled, null, label);
    assert.deepStrictEqual(own(found.direct), ["direct_role"], label);
    assert.deepStrictEqual(own(found.inherited), ["child_role", "parent_role"], label);
  }
});

test("an account with no inherited roles needs no containment read", async () => {
  const person = sysId("direct-only");
  const get = makeGet({
    sys_user_has_role: [
      roleRow(person, sysId("direct-only-a"), "role_a", false),
      roleRow(person, sysId("direct-only-b"), "role_b", false),
    ],
  });
  const found = await IMP.readUserRoles(person, { get });
  assert.strictEqual(get.forTable("sys_user_role_contains").length, 0);
  assert.strictEqual(found.containment, "applied");
  assert.deepStrictEqual(own(found.assigned), ["role_a", "role_b"]);
  assert.deepStrictEqual(own(found.bundled), []);
});

test("a containment cycle nothing assigned reaches is assigned, not hidden", async () => {
  const person = sysId("cycle-person");
  const a = sysId("cycle-a");
  const b = sysId("cycle-b");
  const c = sysId("cycle-c");
  const d = sysId("cycle-d");
  const get = makeGet({
    sys_user_has_role: [
      roleRow(person, a, "cycle_a", true),
      roleRow(person, b, "cycle_b", true),
      roleRow(person, c, "contained_c", true),
      roleRow(person, d, "direct_d", false),
    ],
    sys_user_role_contains: [containsRow(a, b), containsRow(b, a), containsRow(a, c)],
  });
  const found = await IMP.readUserRoles(person, { get });
  /* Without the reachability step all three inherited roles would be
   * "contained", and the panel would say they come with direct_d -- which
   * contains none of them. One member of the cycle is assigned instead, and
   * the rest genuinely come with it. */
  assert.deepStrictEqual(own(found.assigned), ["cycle_a", "direct_d"]);
  assert.deepStrictEqual(own(found.bundled), ["contained_c", "cycle_b"]);
});

test("unnamed roles still take part in containment, and are counted rather than listed", async () => {
  const person = sysId("unnamed-parent");
  const hidden = sysId("unnamed-hidden");
  const visible = sysId("unnamed-visible");
  const get = makeGet({
    sys_user_has_role: [
      roleRow(person, hidden, "", true),
      roleRow(person, visible, "visible_role", true),
    ],
    sys_user_role_contains: [containsRow(hidden, visible)],
  });
  const found = await IMP.readUserRoles(person, { get });
  assert.strictEqual(found.unnamed, 1);
  assert.deepStrictEqual(own(found.assigned), []);
  assert.deepStrictEqual(own(found.bundled), ["visible_role"],
    "it came inside a held role, even one whose name is restricted");
});

test("a containment read superseded mid-way reports stale", async () => {
  const person = sysId("contains-stale");
  const get = makeGet({
    sys_user_has_role: [roleRow(person, sysId("contains-stale-r"), "some_role", true)],
    sys_user_role_contains: [],
  });
  const found = await IMP.readUserRoles(person, {
    get,
    shouldStop: () => get.forTable("sys_user_role_contains").length > 0,
  });
  assert.strictEqual(found.stale, true);
  assert.strictEqual(found.assigned, null);
});

/* ------------------------------------------------------------------ *
 * The mutation's only input
 * ------------------------------------------------------------------ */

test("username validation catches bugs without rejecting identities the platform issues", () => {
  /* Email-shaped and non-Latin user IDs are ordinary. A character allowlist
   * would reject both, and the failure would surface first on a customer
   * instance with international users. */
  ["first.last@example.com", "Захар", "a b", " padded ", "x"]
    .forEach((value) => {
      assert.strictEqual(IMP.validateUserName(value).ok, true, "rejected: " + value);
      assert.strictEqual(IMP.validateUserName(value).userName, value,
        "the value is passed through byte for byte, never trimmed or case-folded");
    });

  assert.strictEqual(IMP.validateUserName("").ok, false);
  assert.strictEqual(IMP.validateUserName("   ").ok, false);
  assert.strictEqual(IMP.validateUserName("x".repeat(41)).ok, false);
  assert.strictEqual(IMP.validateUserName("x".repeat(40)).ok, true);
  assert.strictEqual(IMP.validateUserName("bad" + String.fromCharCode(10) + "value").ok, false);
  assert.strictEqual(IMP.validateUserName("bad" + String.fromCharCode(0) + "value").ok, false);
  /* The response's way home is the STRING "null" when there was no original. */
  assert.strictEqual(IMP.validateUserName("null").ok, false);
  assert.strictEqual(IMP.validateUserName(null).ok, false);
  assert.strictEqual(IMP.validateUserName(undefined).ok, false);
});

test("the record link is built from a validated sys_id and nothing else", () => {
  const id = sysId("bc");
  assert.strictEqual(
    IMP.buildUserUrl("https://example.service-now.com", { sysId: id }),
    "https://example.service-now.com/sys_user.do?sys_id=" + id
  );
  assert.throws(() => IMP.buildUserUrl("https://example.service-now.com", { sysId: "nope" }),
    (error) => error.code === "validation");
});

test("the impersonation dialog link is the stock UI page on the same instance", () => {
  assert.strictEqual(
    IMP.buildImpersonateDialogUrl("https://example.service-now.com"),
    "https://example.service-now.com/impersonate_dialog.do"
  );
});

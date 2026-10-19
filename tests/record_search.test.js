/*
 * Tests for Record Search's query boundary and metadata-driven field selection.
 * All fixtures are synthetic; no instance records belong in this repository.
 *
 *   node --test tests/record_search.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadScript(name) {
  const file = path.join(__dirname, "..", name);
  const context = { globalThis: null, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context;
}

const RS = loadScript("record_search.js").SNRecordSearch;
const own = (value) => Array.from(value);

test("module exposes the pure Record Search API", () => {
  assert.ok(RS);
  assert.strictEqual(typeof RS.parseSearch, "function");
  assert.strictEqual(typeof RS.runSearch, "function");
});

test("Record Search UI loads without a DOM until opened", () => {
  const context = loadScript("record_search_ui.js");
  assert.ok(context.SNRecordSearchUI);
  assert.strictEqual(typeof context.SNRecordSearchUI.open, "function");
});

test("Record Search UI retains table/result keyboard and copy/list actions", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "record_search_ui.js"), "utf8");
  ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"].forEach((key) => {
    assert.ok(source.includes('event.key === "' + key + '"'), "missing " + key);
  });
  ["Copy sys_id", "Copy URL", "Open results in list"].forEach((label) => {
    assert.ok(source.includes(label), "missing " + label);
  });
});

test("table names are normalized and restricted to technical identifiers", () => {
  assert.strictEqual(RS.parseSearch(" Incident ", "INC0012345").table, "incident");
  assert.strictEqual(RS.parseSearch("x_scope_custom_table", "Example").ok, true);
  assert.strictEqual(RS.parseSearch("incident^active=true", "Example").ok, false);
  assert.strictEqual(RS.parseSearch("incident.do", "Example").ok, false);
  assert.strictEqual(RS.parseSearch("", "Example").ok, false);
});

test("table lookup requires a safe bounded anchor", () => {
  assert.strictEqual(RS.extractTableLookupAnchor("i"), null);
  assert.strictEqual(RS.extractTableLookupAnchor("Incident tables"), "Incident");
  assert.strictEqual(RS.extractTableLookupAnchor("^^sys^db"), "sys");
});

/* The lookup's third read names the candidates that are import set staging
 * tables. Fakes that answer every read alike must answer this one apart. */
const isStagingRead = (request) =>
  request.table === "sys_db_object" && request.query.startsWith("super_class.name=");

test("table suggestions query a bounded match set and return label plus technical name", async () => {
  const requests = [];
  const results = await RS.findTables("incident^active=true", {
    get: async (request) => {
      requests.push(request);
      if (isStagingRead(request)) return [];
      return [
        { name: "incident", label: "Incident" },
        { name: "incident_task", label: "Incident Task" },
        { name: "x_example_incident_archive", label: "Archived records" },
        { name: "unrelated_table", label: "Unrelated" },
        { name: "bad^table", label: "Unsafe" },
      ];
    },
  });
  assert.strictEqual(requests.length, 3);
  requests.forEach((request) => {
    assert.strictEqual(request.limit, isStagingRead(request)
      ? RS.TABLE_LOOKUP_CANDIDATE_LIMIT * 2
      : RS.TABLE_LOOKUP_CANDIDATE_LIMIT);
    assert.ok(!request.query.includes("=true"));
  });
  assert.deepStrictEqual(requests.map((request) => [request.table, request.query]), [
    ["sys_documentation", "elementISEMPTY^labelLIKEincident^ORDERBYlabel^ORDERBYname"],
    ["sys_db_object", "nameLIKEincident^ORDERBYname^ORDERBYlabel"],
    ["sys_db_object", "super_class.name=sys_import_set_row^nameLIKEincident^ORlabelLIKEincident"],
  ]);
  assert.deepStrictEqual(own(results).map((item) => [item.label, item.name]), [
    ["Incident", "incident"],
    ["Incident Task", "incident_task"],
    ["Archived records", "x_example_incident_archive"],
  ]);
});

test("table suggestions show the label and technical name on separate full-width rows", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "record_search_ui.js"), "utf8");
  assert.ok(source.includes(".table-option{display:grid;grid-template-columns:minmax(0,1fr)"));
  assert.ok(source.includes("overflow-wrap:anywhere;white-space:normal}.table-name"));
  assert.match(source, /overflow-wrap:anywhere;\r?\n      white-space:normal}/);
});

test("the record results UI explains its ordering", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "record_search_ui.js"), "utf8");
  assert.ok(source.includes('" · sorted by " + result.sortLabel'));
});

test("verified record results sort by relevance then displayed title", () => {
  const make = (sysId, title, value) => ({
    sysId,
    title,
    values: [{ value }],
  });
  const results = RS.sortVerifiedResults([
    make("00000000000000000000000000000005", "Gamma", "Showcase item"),
    make("00000000000000000000000000000002", "Zeta", "case"),
    make("00000000000000000000000000000004", "Delta", "Supplier case review"),
    make("00000000000000000000000000000003", "Beta", "Case study"),
    make("00000000000000000000000000000001", "Alpha", "Case"),
  ], "case");
  assert.deepStrictEqual(own(results).map((item) => item.title), [
    "Alpha", "Zeta", "Beta", "Delta", "Gamma",
  ]);
});

test("multi-word table lookup searches the complete label phrase and technical name", async () => {
  const requests = [];
  const results = await RS.findTables("Supplier case", {
    get: async (request) => {
      requests.push(request);
      if (isStagingRead(request)) return [];
      return [
        { name: "sn_slm_case", label: "Supplier Case" },
        { name: "sn_supplier_item", label: "Unrelated supplier item" },
      ];
    },
  });
  assert.deepStrictEqual(requests.map((request) => [request.table, request.query]), [
    ["sys_documentation", "elementISEMPTY^labelLIKESupplier case^ORDERBYlabel^ORDERBYname"],
    ["sys_db_object", "nameLIKEsupplier_case^ORDERBYname^ORDERBYlabel"],
    ["sys_db_object", "super_class.name=sys_import_set_row^nameLIKEsupplier_case^ORlabelLIKESupplier case"],
  ]);
  assert.deepStrictEqual(own(results).map((item) => item.name), ["sn_slm_case"]);
});

test("separate candidate windows keep a label match ahead of crowded technical matches", async () => {
  const results = await RS.findTables("supplier", {
    get: async (request) => {
      if (request.table === "sys_documentation") {
        return [{ name: "sn_slm_case", label: "Supplier Case" }];
      }
      if (isStagingRead(request)) return [];
      return Array.from({ length: request.limit }, (_, index) => ({
        name: "sn_supplier_example_" + String(index).padStart(2, "0"),
        label: "Example table " + index,
      }));
    },
  });
  assert.strictEqual(results[0].name, "sn_slm_case");
  assert.strictEqual(results.truncated, true);
});

test("technical-name lookup recovers a documentation-backed table omitted by label search", async () => {
  const results = await RS.findTables("Case", {
    get: async (request) => {
      if (request.table === "sys_documentation" || isStagingRead(request)) return [];
      assert.strictEqual(request.query, "nameLIKEcase^ORDERBYname^ORDERBYlabel");
      return [{ name: "sn_slm_case", label: "Supplier Case" }];
    },
  });
  assert.deepStrictEqual(own(results).map((item) => item.name), ["sn_slm_case"]);
});

test("table suggestions show up to fifty verified matches", async () => {
  const results = await RS.findTables("match", {
    get: async (request) => isStagingRead(request) ? [] : Array.from(
      { length: request.limit },
      (_, index) => ({
        name: "x_example_" + String(index).padStart(2, "0") + "_match",
        label: "Example table " + index,
      })
    ),
  });
  assert.strictEqual(results.length, RS.TABLE_SUGGESTION_LIMIT);
  assert.ok(results.every((item) => item.name.includes("match")));
  assert.strictEqual(results.truncated, true);
});

test("an import set staging table is tagged and listed after the table people mean", async () => {
  /* Reported: a staging table carried its target's exact label, so it was
   * listed first, searched, and read as Record Lens not working. */
  const requests = [];
  const results = await RS.findTables("example payment", {
    get: async (request) => {
      requests.push(request);
      if (isStagingRead(request)) {
        return [{ name: "x_stage_example_payment" }, { name: "x_stage_not_a_candidate" }];
      }
      return [
        { name: "x_stage_example_payment", label: "Example Payment" },
        { name: "x_fin_example_payment", label: "Example Payment Information" },
      ];
    },
  });
  const staging = requests.find(isStagingRead);
  assert.strictEqual(staging.query,
    "super_class.name=sys_import_set_row^nameLIKEexample_payment^ORlabelLIKEexample payment");
  assert.strictEqual(staging.fields, "name");
  assert.deepStrictEqual(own(results).map((item) => [item.name, Boolean(item.staging)]), [
    ["x_fin_example_payment", false],
    ["x_stage_example_payment", true],
  ]);
});

test("typing a staging table's own technical name keeps it first, still tagged", async () => {
  const results = await RS.findTables("x_stage_example_payment", {
    get: async (request) => isStagingRead(request)
      ? [{ name: "x_stage_example_payment" }]
      : [
        { name: "x_stage_example_payment", label: "Example Payment" },
        { name: "x_stage_example_payment_info", label: "Example Payment Information" },
      ],
  });
  assert.deepStrictEqual(own(results).map((item) => [item.name, Boolean(item.staging)]), [
    ["x_stage_example_payment", true],
    ["x_stage_example_payment_info", false],
  ]);
});

test("a failed staging read loses only the tags", async () => {
  const results = await RS.findTables("example payment", {
    get: async (request) => {
      if (isStagingRead(request)) throw new Error("HTTP 403 reading sys_db_object");
      return [{ name: "x_stage_example_payment", label: "Example Payment" }];
    },
  });
  assert.deepStrictEqual(own(results).map((item) => [item.name, Boolean(item.staging)]), [
    ["x_stage_example_payment", false],
  ]);
});

test("a table under sys_import_set_row is staging, through to a sys_id search's result", async () => {
  const table = "x_stage_example_payment";
  const get = async (request) => {
    if (request.table === "sys_db_object") {
      const name = request.query.slice("name=".length);
      return [{
        name,
        label: name === table ? "Example Payment" : "Example parent",
        "super_class.name": name === table ? "sys_import_set_row" : "",
      }];
    }
    if (request.table === "sys_dictionary") {
      return [{ name: table, element: "u_code", column_label: "Code", internal_type: "string", display: "true" }];
    }
    return [];
  };
  const info = await RS.resolveTableInfo(table, { get, noCache: true });
  assert.deepStrictEqual(own(info.hierarchy), [table, "sys_import_set_row"]);
  assert.strictEqual(info.staging, true);
  const plain = await RS.resolveTableInfo("x_example_plain", { get, noCache: true });
  assert.strictEqual(plain.staging, false);

  const result = await RS.runSearch(RS.parseSearch(table, "0123456789abcdef0123456789abcdef"), {
    get, origin: "https://example.service-now.com/staging",
  });
  assert.strictEqual(result.results.length, 0);
  assert.strictEqual(result.bySysId, true);
  assert.strictEqual(result.staging, true);
  const byText = await RS.runSearch(RS.parseSearch(table, "example"), {
    get, origin: "https://example.service-now.com/staging",
  });
  assert.strictEqual(byText.bySysId, false);
});

test("exact sys_id input is recognized without a text anchor", () => {
  const parsed = RS.parseSearch("example_record", "0123456789abcdef0123456789abcdef");
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.isSysId, true);
  assert.strictEqual(parsed.anchor, "0123456789abcdef0123456789abcdef");
});

test("ordinary terms need a safe run of at least three characters", () => {
  assert.strictEqual(RS.parseSearch("example_record", "a^b").ok, false);
  assert.strictEqual(RS.parseSearch("example_record", "^^^").ok, false);
  assert.strictEqual(RS.parseSearch("example_record", "Example value").anchor, "Example");
});

test("encoded-query metacharacters never enter the server query", () => {
  const parsed = RS.parseSearch("example_record", "alpha^active=true");
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.anchor, "active");
  const query = RS.buildSearchQuery(["number", "short_description"], parsed.anchor);
  assert.strictEqual(query, "numberLIKEactive^ORshort_descriptionLIKEactive");
  assert.ok(!query.includes("=true"));
});

test("unsafe metadata fields are rejected before query construction", () => {
  assert.throws(
    () => RS.buildSearchQuery(["number^active=true"], "Example"),
    /Unsafe field/
  );
});

test("hierarchy discovery walks parents explicitly", async () => {
  const parentByTable = {
    example_child: "example_parent",
    example_parent: "",
  };
  const calls = [];
  const hierarchy = await RS.resolveHierarchy("example_child", async (request) => {
    calls.push(request.query);
    const name = request.query.slice("name=".length);
    return [{ name, label: name, "super_class.name": parentByTable[name] }];
  });
  assert.deepStrictEqual(own(hierarchy).map((item) => item.name), [
    "example_child",
    "example_parent",
  ]);
  assert.deepStrictEqual(calls, ["name=example_child", "name=example_parent"]);
});

test("field discovery keeps only confirmed text summaries and prefers display fields", async () => {
  const hierarchy = [
    { name: "example_child", label: "Example Child" },
    { name: "example_parent", label: "Example Parent" },
  ];
  const fields = await RS.discoverFields(hierarchy, async (request) => {
    if (request.query.includes("display=true")) {
      return [{
        name: "example_parent",
        element: "number",
        column_label: "Number",
        internal_type: "string",
        display: "true",
      }];
    }
    return [
      {
        name: "example_child",
        element: "short_description",
        column_label: "Short description",
        internal_type: "string",
        display: "false",
      },
      {
        name: "example_child",
        element: "assigned_to",
        column_label: "Assigned to",
        internal_type: "reference",
        display: "false",
      },
      {
        name: "example_child",
        element: "not^safe",
        column_label: "Unsafe",
        internal_type: "string",
        display: "false",
      },
    ];
  });
  assert.deepStrictEqual(own(fields).map((field) => field.name), [
    "number",
    "short_description",
  ]);
});

test("known-table presets are intersected with live fields", () => {
  const fields = [
    { name: "number", label: "Number", autoSelectable: true },
    { name: "short_description", label: "Short description", autoSelectable: true },
  ];
  const selected = RS.chooseDefaultFields(
    "incident",
    [{ name: "incident" }, { name: "task" }],
    fields
  );
  assert.deepStrictEqual(own(selected).map((field) => field.name), [
    "number",
    "short_description",
  ]);
  assert.ok(!own(selected).some((field) => field.name === "description"));
});

test("system property value and body-like fields are never selected automatically", () => {
  const fields = [
    { name: "name", label: "Name", autoSelectable: true, display: false },
    { name: "description", label: "Description", autoSelectable: true, display: false },
    { name: "value", label: "Value", autoSelectable: false, display: true },
    { name: "message_body", label: "Body", autoSelectable: false, display: false },
  ];
  const selected = RS.chooseDefaultFields(
    "sys_properties",
    [{ name: "sys_properties" }],
    fields
  );
  assert.deepStrictEqual(own(selected).map((field) => field.name), ["name", "description"]);
});

test("field discovery excludes HTML types and marks value fields manual-only", async () => {
  const hierarchy = [{ name: "example_record", label: "Example" }];
  const fields = await RS.discoverFields(hierarchy, async () => [
    {
      name: "example_record",
      element: "name",
      column_label: "Name",
      internal_type: "string",
      display: "true",
    },
    {
      name: "example_record",
      element: "value",
      column_label: "Value",
      internal_type: "string",
      display: "false",
    },
    {
      name: "example_record",
      element: "html_body",
      column_label: "HTML body",
      internal_type: "html",
      display: "false",
    },
  ]);
  assert.deepStrictEqual(own(fields).map((field) => field.name), ["name", "value"]);
  assert.strictEqual(fields.find((field) => field.name === "value").autoSelectable, false);
});

test("field selection rejects stale or excessive names", () => {
  const info = {
    fields: [
      { name: "name" },
      { name: "number" },
      { name: "title" },
      { name: "email" },
      { name: "user_name" },
      { name: "short_description" },
    ],
    defaultFields: [{ name: "name" }],
  };
  assert.deepStrictEqual(
    own(RS.selectVerifiedFields(info, ["number", "name"])).map((field) => field.name),
    ["number", "name"]
  );
  assert.throws(() => RS.selectVerifiedFields(info, ["not_live"]), /live dictionary/);
  assert.throws(
    () => RS.selectVerifiedFields(info, [
      "name", "number", "title", "email", "user_name", "short_description", "extra",
    ]),
    /no more than six/
  );
});

function metadataGet(table, resultRows, requests) {
  return async (request) => {
    requests.push(request);
    if (request.table === "sys_db_object") {
      const name = request.query.slice("name=".length);
      return [{ name, label: "Example records", "super_class.name": "" }];
    }
    if (request.table === "sys_dictionary") {
      if (request.query.includes("display=true")) {
        return [{
          name: table,
          element: "number",
          column_label: "Number",
          internal_type: "string",
          display: "true",
        }];
      }
      return [
        {
          name: table,
          element: "short_description",
          column_label: "Short description",
          internal_type: "string",
          display: "false",
        },
        {
          name: table,
          element: "email",
          column_label: "Email",
          internal_type: "email",
          display: "false",
        },
      ];
    }
    assert.strictEqual(request.table, table);
    return resultRows;
  };
}

test("full user text is verified against returned fields before rendering", async () => {
  const table = "example_verify_record";
  const requests = [];
  const rows = [
    {
      sys_id: "00000000000000000000000000000001",
      number: "EX0001",
      short_description: "Synthetic row",
      email: "alpha@example.com",
    },
    {
      sys_id: "00000000000000000000000000000002",
      number: "EX0002",
      short_description: "Example account with another address",
      email: "beta@example.net",
    },
  ];
  const parsed = RS.parseSearch(table, "alpha@example.com");
  const result = await RS.runSearch(parsed, {
    origin: "https://example.service-now.com/verify",
    get: metadataGet(table, rows, requests),
  });
  assert.strictEqual(result.results.length, 1);
  assert.strictEqual(result.results[0].sysId, rows[0].sys_id);
  const tableRequest = requests.find((request) => request.table === table);
  assert.ok(tableRequest.query.includes("LIKEexample"));
  assert.ok(!tableRequest.query.includes("@"));
  assert.strictEqual(tableRequest.limit, RS.SERVER_LIMIT);
});

test("only the user's verified field selection enters the query and result summary", async () => {
  const table = "example_selected_record";
  const requests = [];
  const parsed = RS.parseSearch(table, "example");
  const result = await RS.runSearch(parsed, {
    origin: "https://example.service-now.com/selected",
    fields: ["email"],
    get: metadataGet(table, [{
      sys_id: "00000000000000000000000000000009",
      number: "EXAMPLE009",
      short_description: "Not selected",
      email: "example@example.com",
    }], requests),
  });
  const tableRequest = requests.find((request) => request.table === table);
  assert.strictEqual(tableRequest.query, "emailLIKEexample");
  assert.strictEqual(tableRequest.fields, "sys_id,email");
  assert.deepStrictEqual(
    own(result.results[0].values).map((item) => item.field),
    ["email"]
  );
});

test("visible results are capped at twenty", async () => {
  const table = "example_capped_record";
  const rows = Array.from({ length: 25 }, (_, index) => ({
    sys_id: index.toString(16).padStart(32, "0"),
    number: "EXAMPLE" + index,
    short_description: "Synthetic example " + index,
    email: "",
  }));
  const parsed = RS.parseSearch(table, "example");
  const result = await RS.runSearch(parsed, {
    origin: "https://example.service-now.com/capped",
    get: metadataGet(table, rows, []),
  });
  assert.strictEqual(result.results.length, 20);
  assert.strictEqual(result.truncated, true);
});

test("exact sys_id lookup still works when metadata is not readable", async () => {
  const table = "example_locked_metadata";
  const sysId = "abcdefabcdefabcdefabcdefabcdefab";
  const parsed = RS.parseSearch(table, sysId);
  const requests = [];
  const result = await RS.runSearch(parsed, {
    origin: "https://example.service-now.com/locked",
    get: async (request) => {
      requests.push(request);
      if (request.table === "sys_db_object") throw new Error("HTTP 403 reading metadata");
      return [{ sys_id: sysId }];
    },
  });
  assert.strictEqual(result.results.length, 1);
  assert.strictEqual(result.results[0].title, sysId);
  assert.strictEqual(requests.at(-1).query, "sys_id=" + sysId);
  assert.strictEqual(requests.at(-1).fields, "sys_id");
});

test("a stale search stops before painting results", async () => {
  const table = "example_stale_record";
  const parsed = RS.parseSearch(table, "example");
  let stale = false;
  const result = await RS.runSearch(parsed, {
    origin: "https://example.service-now.com/stale",
    shouldStop: () => stale,
    get: async (request) => {
      stale = true;
      if (request.table === "sys_db_object") {
        return [{ name: table, label: "Example", "super_class.name": "" }];
      }
      return [];
    },
  });
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.results.length, 0);
});

test("record and verified-result list URLs contain only validated identifiers", () => {
  const one = {
    table: "example_record",
    sysId: "00000000000000000000000000000001",
  };
  assert.strictEqual(
    RS.buildRecordUrl("https://example.service-now.com", one),
    "https://example.service-now.com/example_record.do?sys_id=" + one.sysId
  );
  const listUrl = RS.buildResultListUrl("https://example.service-now.com", {
    table: "example_record",
    results: [
      one,
      { table: "example_record", sysId: "00000000000000000000000000000002" },
      { table: "example_record", sysId: "not-a-sys-id" },
    ],
  });
  assert.ok(listUrl.startsWith("https://example.service-now.com/example_record_list.do?"));
  assert.ok(decodeURIComponent(listUrl).includes(
    "sys_idIN00000000000000000000000000000001,00000000000000000000000000000002"
  ));
  assert.throws(
    () => RS.buildResultListUrl("https://example.service-now.com", {
      table: "example^record",
      results: [one],
    }),
    /table name is not safe/
  );
});

test("transport errors distinguish access, schema, and transient failures", async () => {
  const context = loadScript("record_search.js");
  context.chrome = {
    runtime: {
      sendMessage: async () => ({ ok: false, status: 403 }),
    },
  };
  await assert.rejects(
    () => context.SNRecordSearch.tableGet({ table: "sys_dictionary" }),
    (error) => error.code === "access" && /table metadata/.test(error.message)
  );
  context.chrome.runtime.sendMessage = async () => ({ ok: false, status: 404 });
  await assert.rejects(
    () => context.SNRecordSearch.tableGet({ table: "example_record" }),
    (error) => error.code === "schema" && /not found/.test(error.message)
  );
  context.chrome.runtime.sendMessage = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    () => context.SNRecordSearch.tableGet({ table: "example_record" }),
    (error) => error.code === "transient" && /Try again/.test(error.message)
  );
});

/* ------------------------------------------------------------------------ *
 * Starred tables: the engine side.
 *
 * Favourites arrive from the worker as candidates. These pin how they merge
 * into the table menu and how a favourite's remembered fields are verified.
 * ------------------------------------------------------------------------ */

const FAVORITES = [
  { name: "u_example_table", label: "Example table", fields: ["u_code"] },
  { name: "incident", label: "Incident", fields: [] },
  { name: "bad^name", label: "Unsafe", fields: [] },
];

test("an empty box lists every safe favourite in stored order", () => {
  assert.deepStrictEqual(
    own(RS.favoriteMatches(FAVORITES, "")).map((item) => item.name),
    ["u_example_table", "incident"]
  );
  assert.deepStrictEqual(own(RS.favoriteMatches(null, "")), []);
});

test("typed text matches favourites through the lookup's own needles", () => {
  assert.deepStrictEqual(
    own(RS.favoriteMatches(FAVORITES, "inc")).map((item) => item.name),
    ["incident"]
  );
  /* A label phrase matches the label; its underscore form matches the name. */
  assert.deepStrictEqual(
    own(RS.favoriteMatches(FAVORITES, "Example table")).map((item) => item.name),
    ["u_example_table"]
  );
  assert.deepStrictEqual(
    own(RS.favoriteMatches(FAVORITES, "example_table")).map((item) => item.name),
    ["u_example_table"]
  );
  /* Below the lookup's minimum nothing matches, as nothing would be looked up. */
  assert.deepStrictEqual(own(RS.favoriteMatches(FAVORITES, "i")), []);
});

test("merged options put matching favourites first, once, marked as starred", () => {
  const live = [
    { name: "incident_task", label: "Incident Task" },
    { name: "incident", label: "Incident" },
  ];
  live.truncated = true;
  const merged = RS.mergeFavoritesIntoOptions(FAVORITES, live, "inc", "");
  assert.deepStrictEqual(
    own(merged.options).map((item) => [item.name, Boolean(item.starred)]),
    [["incident", true], ["incident_task", false]]
  );
  assert.strictEqual(merged.options.truncated, true, "the live list's truncation is carried");
  assert.strictEqual(merged.activeIndex, 0);
});

test("the active option survives the live results arriving, by name", () => {
  const favorites = [
    { name: "u_example_one", label: "Example one", fields: [] },
    { name: "u_example_two", label: "Example two", fields: [] },
  ];
  const pending = RS.mergeFavoritesIntoOptions(favorites, [], "example", "");
  assert.strictEqual(pending.options.length, 2);
  /* The user arrows to the second favourite while the lookup runs. */
  const arrived = RS.mergeFavoritesIntoOptions(
    favorites,
    [{ name: "u_example_archive", label: "Example archive" }],
    "example",
    "u_example_two"
  );
  assert.strictEqual(arrived.options[arrived.activeIndex].name, "u_example_two");
  assert.strictEqual(arrived.activeIndex, 1, "favourite positions do not move");
  assert.strictEqual(RS.mergeFavoritesIntoOptions([], [], "zz", "").activeIndex, -1);
});

/* A dictionary double that answers the three discoverFields reads by query
 * shape. The optional all-fields read is the one that may degrade to []. */
function dictionaryGet(options) {
  const opts = options || {};
  const requests = [];
  const get = async (request) => {
    requests.push(request);
    if (request.table === "sys_db_object") {
      const name = request.query.slice("name=".length);
      return [{ name, label: "Example records", "super_class.name": "" }];
    }
    if (request.table === "sys_dictionary") {
      const field = (element) => ({
        name: "u_example_record",
        element,
        column_label: element,
        internal_type: "string",
        display: "false",
      });
      if (request.query.includes("display=true")) {
        return [Object.assign(field("number"), { display: "true" })];
      }
      if (request.query.includes("elementIN")) {
        if (opts.fullWindow) {
          return Array.from({ length: 100 }, (_, index) => field("u_filler_" + index));
        }
        const asked = request.query.split("elementIN")[1].split("^")[0].split(",");
        return (opts.existing || []).filter((name) => asked.includes(name)).map(field);
      }
      if (opts.optionalFails) throw new Error("timed out");
      return [];
    }
    return opts.rows || [];
  };
  return { get, requests };
}

test("a remembered field joins the bounded candidate read and is confirmed by its own row", async () => {
  const dictionary = dictionaryGet({ existing: ["u_code"], optionalFails: true });
  const info = await RS.resolveTableInfo("u_example_record", {
    origin: "https://example.service-now.com/remembered-1",
    get: dictionary.get,
    rememberedFields: ["u_code"],
  });
  const candidate = dictionary.requests.find((request) =>
    request.table === "sys_dictionary" && request.query.includes("elementIN"));
  assert.ok(candidate.query.includes(",u_code"), "the remembered name is asked for by name");
  /* The optional read failed, and the field is still confirmed. */
  assert.deepStrictEqual(own(info.remembered.verified), ["u_code"]);
  assert.deepStrictEqual(own(info.remembered.absent), []);
  assert.ok(own(info.fields).some((field) => field.name === "u_code"));
});

test("a remembered field with no row is absent; one a full window could have cut is unverifiable", async () => {
  const gone = await RS.resolveTableInfo("u_example_record", {
    origin: "https://example.service-now.com/remembered-2",
    get: dictionaryGet({ existing: [] }).get,
    rememberedFields: ["u_code", "u_removed"],
  });
  assert.deepStrictEqual(own(gone.remembered.absent), ["u_code", "u_removed"]);
  assert.deepStrictEqual(own(gone.remembered.unverifiable), []);

  const full = await RS.resolveTableInfo("u_example_record", {
    origin: "https://example.service-now.com/remembered-3",
    get: dictionaryGet({ fullWindow: true }).get,
    rememberedFields: ["u_code"],
  });
  assert.deepStrictEqual(own(full.remembered.absent), []);
  assert.deepStrictEqual(own(full.remembered.unverifiable), ["u_code"]);
});

test("unsafe remembered names never reach the query", async () => {
  const dictionary = dictionaryGet({ existing: ["u_code"] });
  const info = await RS.resolveTableInfo("u_example_record", {
    origin: "https://example.service-now.com/remembered-4",
    get: dictionary.get,
    rememberedFields: ["u_code", "u_x^ORactive=true", 42, "u_code"],
  });
  dictionary.requests.forEach((request) => {
    assert.ok(!request.query.includes("active=true^OR") && !request.query.includes("u_x"));
  });
  assert.deepStrictEqual(own(info.remembered.requested), ["u_code"]);
});

test("remembered fields are part of the cache key, and a search reuses the same read", async () => {
  const origin = "https://example.service-now.com/remembered-5";
  const dictionary = dictionaryGet({
    existing: ["u_code"],
    optionalFails: true,
    rows: [{ sys_id: "00000000000000000000000000000005", number: "EX5", u_code: "example code" }],
  });
  await RS.resolveTableInfo("u_example_record", { origin, get: dictionary.get });
  const plain = dictionary.requests.length;
  await RS.resolveTableInfo("u_example_record", {
    origin, get: dictionary.get, rememberedFields: ["u_code"],
  });
  assert.ok(dictionary.requests.length > plain, "a different remembered list is a different read");
  const remembered = dictionary.requests.length;

  /* The panel passes the list it resolved with, so the search hits the same
   * cache entry and u_code -- outside every preset, and missing from the
   * failed optional read -- still verifies. */
  const result = await RS.runSearch(RS.parseSearch("u_example_record", "example"), {
    origin,
    get: dictionary.get,
    fields: ["u_code"],
    rememberedFields: ["u_code"],
  });
  const dictionaryReads = dictionary.requests.slice(remembered)
    .filter((request) => request.table !== "u_example_record");
  assert.strictEqual(dictionaryReads.length, 0, "the search reused the cached read");
  assert.strictEqual(result.results.length, 1);
});

/* ------------------------------------------------------------------------ *
 * Starred tables: the worker side.
 *
 * The policy runs in background.js, which every tab shares, so these load the
 * worker's own block rather than a copy. The storage double clones values and
 * yields between calls, so an unlocked read-modify-write would lose one.
 * ------------------------------------------------------------------------ */

function loadFavoriteWorker(chrome) {
  const source = fs
    .readFileSync(path.join(__dirname, "..", "background.js"), "utf8")
    .replace(/\r\n/g, "\n");
  const slice = (startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, "not found: " + startMarker);
    return source.slice(start, end);
  };
  const body =
    slice("const SN_TAB_HOST", "/* Returns a URL rebuilt") +
    slice("const RL_FAVORITES_PREFIX", "function openUrlTabOptions") +
    "\nreturn { handleRecordLensFavorites, planRecordLensFavoriteCeiling, " +
    "applyRecordLensFavoriteOp, RL_MAX_FAVORITES, RL_MAX_FAVORITE_INSTANCES, " +
    "RL_FAVORITES_PREFIX };";
  return new Function("chrome", body)(chrome);
}

function storageDouble(initial) {
  const store = JSON.parse(JSON.stringify(initial || {}));
  const writes = [];
  const yieldTurn = () => new Promise((resolve) => setTimeout(resolve, 0));
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const local = {
    async get(key) {
      await yieldTurn();
      if (key === null) return clone(store);
      return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: clone(store[key]) } : {};
    },
    async set(items) {
      await yieldTurn();
      writes.push(Object.keys(items));
      Object.assign(store, clone(items));
    },
    async remove(keys) {
      await yieldTurn();
      writes.push(["remove"].concat(keys));
      [].concat(keys).forEach((key) => { delete store[key]; });
    },
  };
  return { chrome: { storage: { local } }, store, writes };
}

const ORIGIN_A = "https://example.service-now.com";
const ORIGIN_B = "https://example-test.service-now.com";
const KEY_A = "snhRecordLensFavorites:" + ORIGIN_A;
const KEY_B = "snhRecordLensFavorites:" + ORIGIN_B;
const senderFor = (origin) => ({ origin, tab: { id: 1, url: origin + "/incident_list.do" } });
const star = (name, extra) => Object.assign({
  type: "RECORD_LENS_FAVORITES",
  op: "star",
  name,
  label: "Example " + name,
  fields: ["short_description"],
}, extra || {});

test("a favourite is stored under the sender's own instance", async () => {
  const storage = storageDouble();
  const worker = loadFavoriteWorker(storage.chrome);
  const answer = await worker.handleRecordLensFavorites(star("u_example_table"), senderFor(ORIGIN_A), 1000);
  assert.strictEqual(answer.ok, true);
  assert.deepStrictEqual(Object.keys(storage.store), [KEY_A]);
  assert.deepStrictEqual(storage.store[KEY_A], {
    version: 1,
    updatedAt: 1000,
    tables: [{
      name: "u_example_table",
      label: "Example u_example_table",
      fields: ["short_description"],
      filterFields: [],
      starredAt: 1000,
    }],
  });
  assert.deepStrictEqual(own(answer.tables).map((item) => item.name), ["u_example_table"]);
});

test("a message naming another instance is refused and changes nothing there", async () => {
  const storage = storageDouble();
  const worker = loadFavoriteWorker(storage.chrome);
  const answer = await worker.handleRecordLensFavorites(
    star("u_example_table", { origin: ORIGIN_B }),
    senderFor(ORIGIN_A),
    1000
  );
  assert.strictEqual(answer.ok, false);
  assert.strictEqual(answer.code, "invalid");
  assert.deepStrictEqual(storage.store, {});
});

test("a sender that is not a ServiceNow tab is refused", async () => {
  const storage = storageDouble();
  const worker = loadFavoriteWorker(storage.chrome);
  for (const sender of [
    {},
    { origin: ORIGIN_A },
    { origin: "https://example.com", tab: { url: "https://example.com/" } },
    { origin: "http://example.service-now.com", tab: { url: "http://example.service-now.com/" } },
  ]) {
    const answer = await worker.handleRecordLensFavorites(star("u_example_table"), sender, 1000);
    assert.strictEqual(answer.ok, false, JSON.stringify(sender));
  }
  assert.deepStrictEqual(storage.store, {});
});

test("every bad shape is refused, never coerced", async () => {
  const storage = storageDouble();
  const worker = loadFavoriteWorker(storage.chrome);
  const bad = [
    star("Incident"),
    star("incident.do"),
    star("u_" + "x".repeat(80)),
    star("u_example_table", { label: 42 }),
    star("u_example_table", { label: "x".repeat(121) }),
    star("u_example_table", { fields: "short_description" }),
    star("u_example_table", { fields: ["a", "b", "c", "d", "e", "f", "g"] }),
    star("u_example_table", { fields: ["number", "number"] }),
    star("u_example_table", { fields: [7] }),
    star("u_example_table", { fields: ["number^ORactive=true"] }),
    star("u_example_table", { filterValues: { state: "1" } }),
    { type: "RECORD_LENS_FAVORITES", op: "drop", name: "u_example_table" },
    { type: "RECORD_LENS_FAVORITES" },
  ];
  for (const message of bad) {
    const answer = await worker.handleRecordLensFavorites(message, senderFor(ORIGIN_A), 1000);
    assert.strictEqual(answer.ok, false, JSON.stringify(message));
    assert.strictEqual(answer.code, "invalid", JSON.stringify(message));
  }
  assert.deepStrictEqual(storage.store, {});
});

test("two tabs starring at once both keep their star", async () => {
  const storage = storageDouble();
  const worker = loadFavoriteWorker(storage.chrome);
  await Promise.all([
    worker.handleRecordLensFavorites(star("u_example_one"), senderFor(ORIGIN_A), 1000),
    worker.handleRecordLensFavorites(star("u_example_two"), senderFor(ORIGIN_A), 1001),
  ]);
  assert.deepStrictEqual(
    own(storage.store[KEY_A].tables).map((item) => item.name),
    ["u_example_one", "u_example_two"]
  );
});

test("the cap is checked against what is stored and evicts nothing", async () => {
  const tables = Array.from({ length: 20 }, (_, index) => ({
    name: "u_example_" + index, label: "Example " + index, fields: [], starredAt: index + 1,
  }));
  const storage = storageDouble({ [KEY_A]: { version: 1, updatedAt: 20, tables } });
  const worker = loadFavoriteWorker(storage.chrome);
  const answer = await worker.handleRecordLensFavorites(star("u_example_more"), senderFor(ORIGIN_A), 1000);
  assert.strictEqual(answer.ok, false);
  assert.strictEqual(answer.code, "cap");
  assert.strictEqual(answer.limit, worker.RL_MAX_FAVORITES);
  assert.strictEqual(storage.store[KEY_A].tables.length, 20);
  assert.deepStrictEqual(storage.writes, []);
});

test("starring again updates the label and fields but keeps its place and starredAt", async () => {
  const storage = storageDouble();
  const worker = loadFavoriteWorker(storage.chrome);
  await worker.handleRecordLensFavorites(star("u_example_one"), senderFor(ORIGIN_A), 1000);
  await worker.handleRecordLensFavorites(star("u_example_two"), senderFor(ORIGIN_A), 1001);
  await worker.handleRecordLensFavorites(
    star("u_example_one", { label: "Renamed", fields: ["number"] }),
    senderFor(ORIGIN_A),
    2000
  );
  const first = storage.store[KEY_A].tables[0];
  assert.deepStrictEqual(first, {
    name: "u_example_one", label: "Renamed", fields: ["number"], filterFields: [], starredAt: 1000,
  });
  assert.strictEqual(storage.store[KEY_A].updatedAt, 2000);
});

test("fields are saved only for a starred table", async () => {
  const storage = storageDouble();
  const worker = loadFavoriteWorker(storage.chrome);
  const notStarred = await worker.handleRecordLensFavorites(
    { type: "RECORD_LENS_FAVORITES", op: "fields", name: "u_example_one", fields: ["number"] },
    senderFor(ORIGIN_A),
    1000
  );
  assert.strictEqual(notStarred.code, "not-starred");
  assert.deepStrictEqual(storage.store, {});
  await worker.handleRecordLensFavorites(star("u_example_one"), senderFor(ORIGIN_A), 1000);
  const saved = await worker.handleRecordLensFavorites(
    { type: "RECORD_LENS_FAVORITES", op: "fields", name: "u_example_one", fields: ["number", "u_code"] },
    senderFor(ORIGIN_A),
    3000
  );
  assert.strictEqual(saved.ok, true);
  assert.deepStrictEqual(storage.store[KEY_A].tables[0].fields, ["number", "u_code"]);
  assert.strictEqual(storage.store[KEY_A].updatedAt, 3000);
});

test("listing writes nothing, and unstarring the last table removes the key", async () => {
  const storage = storageDouble();
  const worker = loadFavoriteWorker(storage.chrome);
  const empty = await worker.handleRecordLensFavorites(
    { type: "RECORD_LENS_FAVORITES", op: "list" }, senderFor(ORIGIN_A), 1000
  );
  assert.strictEqual(empty.ok, true);
  assert.deepStrictEqual(own(empty.tables), []);
  assert.deepStrictEqual(storage.writes, []);

  await worker.handleRecordLensFavorites(star("u_example_one"), senderFor(ORIGIN_A), 1000);
  const writesBefore = storage.writes.length;
  await worker.handleRecordLensFavorites(
    { type: "RECORD_LENS_FAVORITES", op: "list" }, senderFor(ORIGIN_A), 2000
  );
  assert.strictEqual(storage.writes.length, writesBefore, "a list is never a write");
  assert.strictEqual(storage.store[KEY_A].updatedAt, 1000);

  const removed = await worker.handleRecordLensFavorites(
    { type: "RECORD_LENS_FAVORITES", op: "unstar", name: "u_example_one" },
    senderFor(ORIGIN_A),
    3000
  );
  assert.strictEqual(removed.ok, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(storage.store, KEY_A));
});

test("a stored entry that fails validation is left out, not repaired", async () => {
  const storage = storageDouble({
    [KEY_A]: {
      version: 1,
      updatedAt: 5,
      tables: [
        { name: "u_example_one", label: "One", fields: [], starredAt: 1 },
        { name: "Bad^Name", label: "Bad", fields: [], starredAt: 2 },
        { name: "u_example_two", label: "Two", fields: [], starredAt: 3, filterValues: ["x"] },
        { name: "u_example_one", label: "Duplicate", fields: [], starredAt: 4 },
      ],
    },
  });
  const worker = loadFavoriteWorker(storage.chrome);
  const answer = await worker.handleRecordLensFavorites(
    { type: "RECORD_LENS_FAVORITES", op: "list" }, senderFor(ORIGIN_A), 1000
  );
  assert.deepStrictEqual(own(answer.tables).map((item) => item.label), ["One"]);
});

test("the instance ceiling drops the instance changed longest ago, and says so", async () => {
  const worker = loadFavoriteWorker(storageDouble().chrome);
  const stored = {
    [KEY_B]: { updatedAt: 50 },
    ["snhRecordLensFavorites:https://example-old.service-now.com"]: { updatedAt: 10 },
    snhPaletteFavourite: "kept",
  };
  assert.deepStrictEqual(
    own(worker.planRecordLensFavoriteCeiling(stored, KEY_A, 2)),
    ["snhRecordLensFavorites:https://example-old.service-now.com"]
  );
  assert.deepStrictEqual(own(worker.planRecordLensFavoriteCeiling(stored, KEY_A, 3)), []);
  /* An instance already stored never counts against itself. */
  assert.deepStrictEqual(own(worker.planRecordLensFavoriteCeiling(stored, KEY_B, 2)), []);

  const initial = {};
  for (let index = 0; index < worker.RL_MAX_FAVORITE_INSTANCES; index += 1) {
    initial["snhRecordLensFavorites:https://example-" + index + ".service-now.com"] = {
      version: 1,
      updatedAt: 100 + index,
      tables: [{ name: "u_example", label: "Example", fields: [], starredAt: 1 }],
    };
  }
  const storage = storageDouble(initial);
  const full = loadFavoriteWorker(storage.chrome);
  const answer = await full.handleRecordLensFavorites(star("u_example_table"), senderFor(ORIGIN_A), 9000);
  assert.strictEqual(answer.ok, true);
  assert.strictEqual(answer.evicted, 1);
  assert.ok(!storage.store["snhRecordLensFavorites:https://example-0.service-now.com"]);
  assert.ok(storage.store[KEY_A]);
});

test("a favourite remembers filter field names, and only names", async () => {
  const storage = storageDouble();
  const worker = loadFavoriteWorker(storage.chrome);
  await worker.handleRecordLensFavorites(
    star("u_example_table", { filterFields: ["assignment_group"] }), senderFor(ORIGIN_A), 1000
  );
  assert.deepStrictEqual(storage.store[KEY_A].tables[0].filterFields, ["assignment_group"]);
  const saved = await worker.handleRecordLensFavorites(
    { type: "RECORD_LENS_FAVORITES", op: "filterFields", name: "u_example_table", filterFields: ["state", "priority"] },
    senderFor(ORIGIN_A),
    2000
  );
  assert.strictEqual(saved.ok, true);
  assert.deepStrictEqual(storage.store[KEY_A].tables[0].filterFields, ["state", "priority"]);
  /* Starring again without filterFields keeps what was saved. */
  await worker.handleRecordLensFavorites(star("u_example_table"), senderFor(ORIGIN_A), 3000);
  assert.deepStrictEqual(storage.store[KEY_A].tables[0].filterFields, ["state", "priority"]);
});

test("bad filter field lists are refused, and a favourite stored before filters still reads", async () => {
  const storage = storageDouble({
    [KEY_A]: { version: 1, updatedAt: 5, tables: [
      { name: "u_example_old", label: "Old", fields: ["number"], starredAt: 1 },
    ] },
  });
  const worker = loadFavoriteWorker(storage.chrome);
  const listed = await worker.handleRecordLensFavorites(
    { type: "RECORD_LENS_FAVORITES", op: "list" }, senderFor(ORIGIN_A), 1000
  );
  assert.deepStrictEqual(own(listed.tables[0].filterFields), []);
  const filterMessage = (filterFields) => ({
    type: "RECORD_LENS_FAVORITES", op: "filterFields", name: "u_example_old", filterFields,
  });
  for (const bad of [
    ["a", "b", "c", "d"],
    ["state", "state"],
    [{ field: "state", value: "2" }],
    "state",
    ["state^ORactive=true"],
  ]) {
    const answer = await worker.handleRecordLensFavorites(filterMessage(bad), senderFor(ORIGIN_A), 2000);
    assert.strictEqual(answer.code, "invalid", JSON.stringify(bad));
  }
  const notStarred = await worker.handleRecordLensFavorites(
    { type: "RECORD_LENS_FAVORITES", op: "filterFields", name: "u_example_new", filterFields: [] },
    senderFor(ORIGIN_A),
    2000
  );
  assert.strictEqual(notStarred.code, "not-starred");
  assert.strictEqual(storage.store[KEY_A].updatedAt, 5, "nothing was written");
});

/* ------------------------------------------------------------------------ *
 * Value filters.
 *
 * A double of the instance, answering each read by table and query shape.
 * Every origin below is unique, because each resolver caches per origin.
 * ------------------------------------------------------------------------ */

const GROUP_ID = "0123456789abcdef0123456789abcdef";
const OTHER_GROUP_ID = "fedcba9876543210fedcba9876543210";

const FILTER_FIELD_ROWS = [
  { name: "task", element: "assignment_group", column_label: "Assignment group", internal_type: "reference", "reference.name": "sys_user_group", choice: "" },
  { name: "task", element: "state", column_label: "State", internal_type: "integer", choice: "3" },
  { name: "task", element: "priority", column_label: "Priority", internal_type: "integer", choice: "1" },
  { name: "incident", element: "category", column_label: "Category", internal_type: "string", choice: "1" },
  { name: "task", element: "short_description", column_label: "Short description", internal_type: "string", choice: "" },
  { name: "task", element: "approval", column_label: "Approval", internal_type: "string", choice: "none" },
  { name: "task", element: "u_secret_token", column_label: "Secret token", internal_type: "reference", "reference.name": "sys_user" },
  { name: "task", element: "u_broken_ref", column_label: "Broken", internal_type: "reference", "reference.name": "" },
  { name: "task", element: "description", column_label: "Description", internal_type: "html", choice: "1" },
  { name: "incident", element: "u_stage", column_label: "Stage", internal_type: "string", choice: "1", choice_table: "u_example_stage_source", choice_field: "stage" },
];

function filterInstance(options) {
  const opts = options || {};
  const requests = [];
  const parents = Object.assign({ incident: "task", task: "", sys_user_group: "", u_example_stage_source: "" },
    opts.parents || {});
  const part = (query, key) => {
    const match = String(query).match(new RegExp("(?:^|\\^)" + key + "(IN|=)([^^]*)"));
    return match ? match[2].split(",") : null;
  };
  const get = async (request) => {
    requests.push(request);
    const query = request.query || "";
    if (request.table === "sys_db_object") {
      const name = query.slice("name=".length);
      if (!Object.prototype.hasOwnProperty.call(parents, name)) return [];
      return [{ name, label: "Label " + name, "super_class.name": parents[name] }];
    }
    if (request.table === "sys_dictionary") {
      if (query.includes("^display=true^ORelement=name")) return opts.displayRows || [];
      if (query.includes("^elementISNOTEMPTY^ORDERBYelement")) {
        if (opts.filterFieldsFail) throw Object.assign(new Error("timed out"), { code: "transient" });
        return opts.filterFieldRows || FILTER_FIELD_ROWS;
      }
      if (query.includes("^display=true^active=true")) {
        return [{ name: "task", element: "number", column_label: "Number", internal_type: "string", display: "true" }];
      }
      if (query.includes("elementIN")) {
        return [
          { name: "task", element: "short_description", column_label: "Short description", internal_type: "string", display: "false" },
        ].concat(opts.unordered ? [] : [
          { name: "sys_metadata", element: "sys_updated_on", column_label: "Updated", internal_type: "glide_date_time", display: "false" },
        ]);
      }
      return [];
    }
    if (request.table === "sys_dictionary_override") {
      if (opts.overrideFails) throw new Error("403");
      return opts.overrideRows || [];
    }
    if (request.table === "sys_properties") {
      return opts.language ? [{ name: "glide.sys.language", value: opts.language }] : [];
    }
    if (request.table === "sys_choice") {
      const names = part(query, "name");
      const element = part(query, "element");
      const language = part(query, "language");
      return (opts.choiceRows || []).filter((row) =>
        (!names || names.includes(row.name)) &&
        (!element || element.includes(row.element)) &&
        (!language || language.includes(row.language || "en")));
    }
    return opts.records ? opts.records(request) : [];
  };
  return { get, requests };
}

test("filter fields: references with a table and choice-listed strings or integers, nothing else", () => {
  const fields = own(RS.filterFieldsFrom(FILTER_FIELD_ROWS, ["incident", "task"]));
  assert.deepStrictEqual(fields.map((field) => [field.name, field.kind]), [
    ["assignment_group", "reference"],
    ["category", "choice"],
    ["priority", "choice"],
    ["u_stage", "choice"],
    ["state", "choice"],
  ]);
  assert.strictEqual(fields[0].reference, "sys_user_group");
  assert.strictEqual(RS.choiceEnabled({ choice: "none" }), false, "\"none\" is no choice list");
  assert.strictEqual(RS.choiceEnabled({ choice: "0" }), false);
  assert.strictEqual(RS.choiceEnabled({ choice: "3" }), true);
});

test("the nearest definition of a field decides whether it is filterable", () => {
  const fields = own(RS.filterFieldsFrom([
    { name: "task", element: "u_kind", column_label: "Kind (task)", internal_type: "string", choice: "1" },
    { name: "incident", element: "u_kind", column_label: "Kind", internal_type: "string", choice: "0" },
  ], ["incident", "task"]));
  assert.deepStrictEqual(fields, [], "the concrete table's own row has no choice list");
});

test("the filter-field read is its own bounded read, and a full window says so", async () => {
  const many = Array.from({ length: RS.FILTER_FIELD_READ_LIMIT + 1 }, (_, index) => ({
    name: "task", element: "u_ref_" + index, column_label: "Ref " + index,
    internal_type: "reference", "reference.name": "sys_user_group",
  }));
  const instance = filterInstance({ filterFieldRows: many });
  const info = await RS.resolveFilterFields("incident", {
    origin: "https://example.service-now.com/ff-1", get: instance.get,
  });
  const read = instance.requests.find((request) => request.query.includes("ORDERBYelement"));
  assert.strictEqual(read.limit, RS.FILTER_FIELD_READ_LIMIT + 1);
  assert.ok(read.fields.includes("reference.name") && read.fields.includes("choice_table"));
  assert.strictEqual(info.truncated, true);
  assert.strictEqual(info.fields.length, RS.FILTER_FIELD_READ_LIMIT);
  await assert.rejects(
    () => RS.resolveFilterFields("incident", {
      origin: "https://example.service-now.com/ff-2", get: filterInstance({ filterFieldsFail: true }).get,
    }),
    (error) => error.code === "transient",
    "a timeout is an error, never an empty field list"
  );
});

test("display column: an override wins and the walk's column comes back as a hint", async () => {
  const info = await RS.resolveDisplayColumn("incident", {
    origin: "https://example.service-now.com/dc-1",
    get: filterInstance({
      overrideRows: [{ name: "incident", element: "short_description" }],
      displayRows: [{ name: "task", element: "number", display: "true" }],
    }).get,
  });
  assert.deepStrictEqual(
    [info.column, info.hint, info.source],
    ["short_description", "number", "override"]
  );
});

test("display column: an inherited display row, then name only when name exists, then none", async () => {
  const inherited = await RS.resolveDisplayColumn("incident", {
    origin: "https://example.service-now.com/dc-2",
    get: filterInstance({ displayRows: [{ name: "task", element: "number", display: "true" }] }).get,
  });
  assert.deepStrictEqual([inherited.column, inherited.source, inherited.hint], ["number", "display", ""]);

  const named = await RS.resolveDisplayColumn("sys_user_group", {
    origin: "https://example.service-now.com/dc-3",
    get: filterInstance({ displayRows: [{ name: "sys_user_group", element: "name", display: "false" }] }).get,
  });
  assert.deepStrictEqual([named.column, named.source], ["name", "name"]);

  const none = await RS.resolveDisplayColumn("sys_user_group", {
    origin: "https://example.service-now.com/dc-4",
    get: filterInstance({ displayRows: [] }).get,
  });
  assert.deepStrictEqual([none.column, none.source], ["", "none"], "never number or any other guess");
});

test("reference values: listed by display column, type-ahead past the cap, pasted sys_id, no guess", async () => {
  const groups = (count) => Array.from({ length: count }, (_, index) => ({
    sys_id: ("b" + index.toString(16)).padStart(32, "0"), name: "Example group " + index,
  }));
  const instance = filterInstance({
    displayRows: [{ name: "sys_user_group", element: "name", display: "false" }],
    records: (request) => (request.table === "sys_user_group" ? groups(RS.FILTER_VALUE_LIMIT + 1) : []),
  });
  const origin = "https://example.service-now.com/rv-1";
  const listed = await RS.loadFilterValues("incident", "assignment_group", { origin, get: instance.get });
  const listRead = instance.requests.filter((request) => request.table === "sys_user_group").at(-1);
  assert.strictEqual(listRead.query, "ORDERBYname");
  assert.strictEqual(listRead.limit, RS.FILTER_VALUE_LIMIT + 1);
  assert.strictEqual(listed.truncated, true, "a capped list is never presented as complete");
  assert.strictEqual(listed.values.length, RS.FILTER_VALUE_LIMIT);
  assert.match(listed.note, /All records in sys_user_group, not the form's filtered list/);

  await RS.loadFilterValues("incident", "assignment_group", { origin, get: instance.get, term: "group 7" });
  assert.strictEqual(
    instance.requests.filter((request) => request.table === "sys_user_group").at(-1).query,
    "nameLIKEgroup^ORDERBYname",
    "the server narrows on a safe anchor"
  );
  await RS.loadFilterValues("incident", "assignment_group", { origin, get: instance.get, term: GROUP_ID });
  assert.strictEqual(
    instance.requests.filter((request) => request.table === "sys_user_group").at(-1).query,
    "sys_id=" + GROUP_ID
  );

  const blind = filterInstance({ displayRows: [] });
  const pasted = await RS.loadFilterValues("incident", "assignment_group", {
    origin: "https://example.service-now.com/rv-2", get: blind.get, term: GROUP_ID.toUpperCase(),
  });
  assert.strictEqual(pasted.noDisplayColumn, true);
  assert.deepStrictEqual(own(pasted.values).map((item) => item.value), [GROUP_ID]);
  assert.ok(!blind.requests.some((request) => request.table === "sys_user_group"),
    "with no verified column the table is not read at all");
});

test("reference values whose display column reads back blank are an access answer", async () => {
  const instance = filterInstance({
    displayRows: [{ name: "sys_user_group", element: "name", display: "false" }],
    records: () => [{ sys_id: GROUP_ID, name: "" }, { sys_id: OTHER_GROUP_ID, name: "" }],
  });
  await assert.rejects(
    () => RS.loadFilterValues("incident", "assignment_group", {
      origin: "https://example.service-now.com/rv-3", get: instance.get,
    }),
    (error) => error.code === "access" && /display column/.test(error.message)
  );
});

test("choices come from the concrete table, not the defining one, read chain-wide", async () => {
  const instance = filterInstance({
    choiceRows: [
      { name: "task", element: "state", value: "1", label: "Open", language: "en", inactive: "false" },
      { name: "incident", element: "state", value: "1", label: "New", language: "en", inactive: "false" },
      { name: "incident", element: "state", value: "2", label: "In Progress", language: "en", inactive: "false" },
      { name: "incident", element: "state", value: "9", label: "Retired", language: "en", inactive: "true" },
    ],
  });
  const result = await RS.loadFilterValues("incident", "state", {
    origin: "https://example.service-now.com/cv-1", get: instance.get,
  });
  const reads = instance.requests.filter((request) => request.table === "sys_choice");
  assert.deepStrictEqual(reads.map((request) => [request.query, request.limit]), [
    ["name=incident^element=state", 1],
    ["name=task^element=state", 1],
    ["name=incident^element=state^language=en", 1001],
  ], "one-row existence reads in any language, then the source's own list");
  assert.deepStrictEqual(own(result.values).map((item) => [item.label, item.value, item.hint]), [
    ["In Progress", "2", "2"],
    ["New", "1", "1"],
  ]);
  assert.strictEqual(result.source.table, "incident");
});

test("a choice_table redirect lists the target's values", async () => {
  const instance = filterInstance({
    choiceRows: [
      { name: "u_example_stage_source", element: "stage", value: "ordered", label: "Ordered", language: "en", inactive: "false" },
    ],
  });
  const result = await RS.loadFilterValues("incident", "u_stage", {
    origin: "https://example.service-now.com/cv-2", get: instance.get,
  });
  assert.deepStrictEqual(own(result.values).map((item) => item.value), ["ordered"]);
  assert.strictEqual(result.source.redirected, true);
});

test("choice labels use the instance language, falling back to English when it has none", async () => {
  const instance = filterInstance({
    language: "fr",
    choiceRows: [{ name: "incident", element: "category", value: "network", label: "Network", language: "en", inactive: "false" }],
  });
  const result = await RS.loadFilterValues("incident", "category", {
    origin: "https://example.service-now.com/cv-3", get: instance.get,
  });
  const languages = instance.requests
    .filter((request) => request.table === "sys_choice" && request.query.includes("language="))
    .map((request) => request.query.split("language=")[1]);
  assert.deepStrictEqual(languages, ["fr", "en"]);
  assert.strictEqual(result.language, "en");
  assert.match(result.note, /instance language \(en\)/);
});

test("a child table's own list wins even when only its parent is translated", async () => {
  /* The case a language-first read gets wrong: the instance language has
   * rows on the parent only, so filtering by language before choosing the
   * source would offer the parent's states on the child. */
  const instance = filterInstance({
    language: "fr",
    parents: { u_example_task: "task" },
    choiceRows: [
      { name: "task", element: "state", value: "1", label: "Ouvert", language: "fr", inactive: "false" },
      { name: "u_example_task", element: "state", value: "10", label: "Draft", language: "en", inactive: "false" },
    ],
  });
  const result = await RS.loadFilterValues("u_example_task", "state", {
    origin: "https://example.service-now.com/cv-5", get: instance.get,
  });
  assert.strictEqual(result.source.table, "u_example_task");
  assert.deepStrictEqual(own(result.values).map((item) => item.label), ["Draft"]);
  assert.strictEqual(result.language, "en");
});

test("a reference filter's read-back is compared case-insensitively", () => {
  const field = { name: "assignment_group", kind: "reference" };
  const condition = { field, value: GROUP_ID };
  assert.strictEqual(RS.verifyFilters({ assignment_group: { value: GROUP_ID.toUpperCase() } }, [condition]), true);
  assert.strictEqual(RS.verifyFilters({ assignment_group: { value: OTHER_GROUP_ID } }, [condition]), false);
  const choice = { field: { name: "state", kind: "choice" }, value: "2" };
  assert.strictEqual(RS.verifyFilters({ state: { value: "2" } }, [choice]), true);
  assert.strictEqual(RS.verifyFilters({ state: { value: "2.0" } }, [choice]), false, "a choice is an exact string");
});

test("a pasted sys_id with no record says so", async () => {
  const instance = filterInstance({
    displayRows: [{ name: "sys_user_group", element: "name", display: "false" }],
    records: () => [],
  });
  const result = await RS.loadFilterValues("incident", "assignment_group", {
    origin: "https://example.service-now.com/rv-4", get: instance.get, term: GROUP_ID,
  });
  assert.deepStrictEqual(own(result.values), []);
  assert.match(result.note, /^No record with that sys_id in sys_user_group\./);
});

test("complete value lists are narrowed locally; capped ones and pasted sys_ids go back to the instance", async () => {
  const calls = [];
  const answers = {
    "incident|state": { kind: "choice", values: [
      { value: "1", label: "New" }, { value: "2", label: "In Progress" },
    ], truncated: false },
    "incident|caller_id": { kind: "reference", values: [{ value: GROUP_ID, label: "Abel Example" }], truncated: true },
  };
  const load = RS.createFilterValueLoader(async (table, field, term) => {
    calls.push([table, field, term]);
    return answers[table + "|" + field];
  });
  await load("incident", "state", "");
  const narrowed = await load("incident", "state", "prog");
  assert.deepStrictEqual(own(narrowed.values).map((item) => item.label), ["In Progress"]);
  const byValue = await load("incident", "state", "1");
  assert.deepStrictEqual(own(byValue.values).map((item) => item.label), ["New"], "a choice matches its raw value too");
  await load("incident", "caller_id", "");
  await load("incident", "caller_id", "abel");
  await load("incident", "state", GROUP_ID);
  assert.deepStrictEqual(calls, [
    ["incident", "state", ""],
    ["incident", "caller_id", ""],
    ["incident", "caller_id", "abel"],
    ["incident", "state", GROUP_ID],
  ]);
});

test("dependent choices are de-duplicated by value and say they are not narrowed", async () => {
  const instance = filterInstance({
    choiceRows: [
      { name: "incident", element: "category", value: "email", label: "Email", dependent_value: "inquiry", language: "en", inactive: "false" },
      { name: "incident", element: "category", value: "email", label: "Email", dependent_value: "software", language: "en", inactive: "false" },
    ],
  });
  const result = await RS.loadFilterValues("incident", "category", {
    origin: "https://example.service-now.com/cv-4", get: instance.get,
  });
  assert.strictEqual(result.values.length, 1);
  assert.match(result.note, /not narrowed by the field this one depends on/);
});

test("choice values the query language cannot filter correctly are never offered", () => {
  const offered = own(RS.choiceOptionsFrom([
    { value: "null", label: "Literal null" },
    { value: "NULL", label: "Upper null" },
    { value: " padded", label: "Leading space" },
    { value: "padded ", label: "Trailing space" },
    { value: "NULL_OVERRIDE", label: "Sentinel" },
    { value: "ok", label: "javascript:gs.getMessage('x')" },
    { value: "javascript:alert(1)", label: "Script" },
    { value: "a^b", label: "Caret" },
    { value: ">=", label: "Greater or equal" },
    { value: "A/B,256", label: "Comma" },
  ])).map((item) => item.value);
  assert.deepStrictEqual(offered.sort(), [">=", "A/B,256"].sort());
  ["null", "Null", " x", "x ", "NULL_OVERRIDE", "", "a\nb"].forEach((value) => {
    assert.ok(RS.choiceValueProblem(value), "should refuse " + JSON.stringify(value));
  });
  assert.strictEqual(RS.choiceValueProblem("<"), "");
});

test("filters are exact, AND-ed, one per field, at most three, and bound to the offered list", () => {
  const info = { fields: RS.filterFieldsFrom(FILTER_FIELD_ROWS, ["incident", "task"]) };
  const conditions = own(RS.filterConditions([
    { field: "assignment_group", value: GROUP_ID.toUpperCase() },
    { field: "state", value: "2" },
  ], info));
  assert.deepStrictEqual(conditions.map((item) => item.clause), [
    "assignment_group=" + GROUP_ID,
    "state=2",
  ]);
  assert.throws(() => RS.filterConditions([
    { field: "state", value: "1" }, { field: "priority", value: "1" },
    { field: "category", value: "x" }, { field: "u_stage", value: "y" },
  ], info), /no more than three/);
  assert.throws(() => RS.filterConditions([
    { field: "state", value: "1" }, { field: "state", value: "2" },
  ], info), /filtered once/);
  assert.throws(() => RS.filterConditions([{ field: "u_secret_token", value: GROUP_ID }], info),
    /not one the live dictionary offers/);
  assert.throws(() => RS.filterConditions([{ field: "assignment_group", value: "Example group" }], info),
    /sys_id/);
  assert.throws(() => RS.filterConditions([{ field: "state", value: "null" }], info), /cannot be used/);
});

test("filters always precede the text chain, and the builder refuses any other order", () => {
  const chain = RS.buildSearchQuery(
    ["number", "short_description", "description", "close_notes", "correlation_id", "correlation_display"],
    "example"
  );
  const query = RS.composeQuery([
    { kind: "filter", clause: "assignment_group=" + GROUP_ID },
    { kind: "filter", clause: "state=2" },
    { kind: "filter", clause: "priority=1" },
    { kind: "chain", clause: chain },
  ]);
  assert.strictEqual(query, "assignment_group=" + GROUP_ID + "^state=2^priority=1^" + chain);
  assert.throws(() => RS.composeQuery([
    { kind: "chain", clause: chain }, { kind: "filter", clause: "state=2" },
  ]), /precede/);
  assert.throws(() => RS.composeQuery([{ kind: "filter", clause: "state=2^ORstate=3" }]), /one condition/);
});

function filteredSearch(instanceOptions, searchOptions) {
  const instance = filterInstance(instanceOptions);
  const parsed = RS.parseSearch("incident", searchOptions.term || "", {
    allowEmptyTerm: Boolean(searchOptions.filters && searchOptions.filters.length),
  });
  return RS.runSearch(parsed, Object.assign({ get: instance.get }, searchOptions))
    .then((result) => ({ result, instance }));
}

const incidentRow = (index, group, state) => ({
  sys_id: index.toString(16).padStart(32, "0"),
  number: "INC" + String(index).padStart(7, "0"),
  short_description: "Example " + index,
  assignment_group: { value: group, display_value: "Example group" },
  state: { value: state, display_value: "State " + state },
});

test("a filter-only search keeps the server's newest-first order and names it", async () => {
  /* Zeta before Alpha: an alphabetical re-sort would swap them. */
  const rows = [
    Object.assign(incidentRow(1, GROUP_ID, "2"), { number: "Zeta" }),
    Object.assign(incidentRow(2, GROUP_ID, "2"), { number: "Alpha" }),
  ];
  const { result, instance } = await filteredSearch(
    { records: (request) => (request.table === "incident" ? rows : []) },
    {
      origin: "https://example.service-now.com/fs-1",
      fields: ["number"],
      filters: [{ field: "assignment_group", value: GROUP_ID }, { field: "state", value: "2" }],
    }
  );
  const read = instance.requests.find((request) => request.table === "incident");
  assert.strictEqual(read.query, "assignment_group=" + GROUP_ID + "^state=2^ORDERBYDESCsys_updated_on");
  assert.strictEqual(read.fields, "sys_id,number,assignment_group,state", "filter fields are read back");
  assert.deepStrictEqual(own(result.results).map((item) => item.title), ["Zeta", "Alpha"]);
  assert.strictEqual(result.sortLabel, "most recently updated");
  assert.strictEqual(result.filterOnly, true);
});

test("without a verified update column, a filter-only search orders by sys_id and says so", async () => {
  const { result, instance } = await filteredSearch(
    { unordered: true, records: () => [incidentRow(1, GROUP_ID, "2")] },
    {
      origin: "https://example.service-now.com/fs-2",
      fields: ["number"],
      filters: [{ field: "assignment_group", value: GROUP_ID }],
    }
  );
  assert.ok(instance.requests.find((request) => request.table === "incident").query.endsWith("^ORDERBYsys_id"));
  assert.strictEqual(result.sortLabel, "sys_id");
});

test("filter plus text: the filter comes first and every row is re-verified on both", async () => {
  const { result, instance } = await filteredSearch(
    {
      records: () => [
        incidentRow(1, GROUP_ID, "2"),
        incidentRow(2, OTHER_GROUP_ID, "2"),
        Object.assign(incidentRow(3, GROUP_ID, "2"), { short_description: "Unrelated" }),
      ],
    },
    {
      origin: "https://example.service-now.com/fs-3",
      term: "example",
      fields: ["short_description"],
      filters: [{ field: "assignment_group", value: GROUP_ID }],
    }
  );
  assert.strictEqual(
    instance.requests.find((request) => request.table === "incident").query,
    "assignment_group=" + GROUP_ID + "^short_descriptionLIKEexample"
  );
  assert.deepStrictEqual(own(result.results).map((item) => item.sysId),
    [incidentRow(1).sys_id], "the other group and the non-matching text are both dropped");
});

test("a row where any one filter differs is dropped", async () => {
  const { result } = await filteredSearch(
    { records: () => [incidentRow(1, GROUP_ID, "2"), incidentRow(2, GROUP_ID, "3")] },
    {
      origin: "https://example.service-now.com/fs-4",
      fields: ["number"],
      filters: [{ field: "assignment_group", value: GROUP_ID }, { field: "state", value: "2" }],
    }
  );
  assert.deepStrictEqual(own(result.results).map((item) => item.sysId), [incidentRow(1).sys_id]);
});

test("a filter field that reads back blank on every row is an access answer, not no matches", async () => {
  await assert.rejects(
    () => filteredSearch(
      { records: () => [Object.assign(incidentRow(1, GROUP_ID, "2"), { assignment_group: { value: "", display_value: "" } })] },
      {
        origin: "https://example.service-now.com/fs-5",
        fields: ["number"],
        filters: [{ field: "assignment_group", value: GROUP_ID }],
      }
    ),
    (error) => error.code === "access" && /could not be read back/.test(error.message)
  );
});

test("an exact sys_id combines with filters", async () => {
  const id = incidentRow(1).sys_id;
  const { instance } = await filteredSearch(
    { records: () => [incidentRow(1, GROUP_ID, "2")] },
    {
      origin: "https://example.service-now.com/fs-6",
      term: id,
      filters: [{ field: "assignment_group", value: GROUP_ID }],
    }
  );
  assert.strictEqual(
    instance.requests.find((request) => request.table === "incident").query,
    "assignment_group=" + GROUP_ID + "^sys_id=" + id
  );
});

test("a search with neither text nor a complete filter is still refused", async () => {
  assert.strictEqual(RS.parseSearch("incident", "").ok, false);
  assert.strictEqual(RS.parseSearch("incident", "", { allowEmptyTerm: true }).ok, true);
  await assert.rejects(
    () => RS.runSearch(RS.parseSearch("incident", "", { allowEmptyTerm: true }), {
      origin: "https://example.service-now.com/fs-7", get: filterInstance().get, filters: [],
    }),
    /complete a filter/
  );
});

test("an optional broad dictionary failure keeps verified preset fields usable", async () => {
  const hierarchy = [{ name: "task", label: "Task" }];
  const fields = await RS.discoverFields(hierarchy, async (request) => {
    if (request.query.includes("elementISNOTEMPTY")) {
      assert.strictEqual(request.timeoutMs, RS.OPTIONAL_DICTIONARY_TIMEOUT_MS);
      throw new Error("Synthetic broad dictionary timeout");
    }
    if (request.query.includes("display=true")) return [];
    return [{
      name: "task",
      element: "number",
      column_label: "Number",
      internal_type: "string",
      display: "false",
    }];
  });
  assert.deepStrictEqual(own(fields).map((field) => field.name), ["number"]);
});

test("a metadata request times out instead of leaving Record Search spinning", async () => {
  const context = loadScript("record_search.js");
  context.chrome = {
    runtime: {
      sendMessage: () => new Promise(() => {}),
    },
  };
  await assert.rejects(
    () => context.SNRecordSearch.tableGet({
      table: "sys_db_object",
      timeoutMs: 5,
    }),
    (error) => error.code === "transient" && /too long/.test(error.message)
  );
});

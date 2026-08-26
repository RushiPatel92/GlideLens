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
  const context = { globalThis: null };
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

test("table suggestions query a bounded match set and return label plus technical name", async () => {
  const requests = [];
  const results = await RS.findTables("incident^active=true", {
    get: async (request) => {
      requests.push(request);
      return [
        { name: "incident", label: "Incident" },
        { name: "incident_task", label: "Incident Task" },
        { name: "unrelated_table", label: "Unrelated" },
        { name: "bad^table", label: "Unsafe" },
      ];
    },
  });
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].table, "sys_db_object");
  assert.strictEqual(requests[0].limit, RS.TABLE_SUGGESTION_LIMIT);
  assert.strictEqual(requests[0].query, "nameLIKEincident^ORlabelLIKEincident^ORDERBYlabel^ORDERBYname");
  assert.ok(!requests[0].query.includes("=true"));
  assert.deepStrictEqual(own(results).map((item) => [item.label, item.name]), [
    ["Incident", "incident"],
    ["Incident Task", "incident_task"],
  ]);
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

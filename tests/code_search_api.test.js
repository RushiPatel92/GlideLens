/*
 * Tests for the Tier 1 half of code_search.js — the instance's own Code Search
 * endpoint, its coverage map, and the merge with the Table API adapters.
 *
 *   node --test tests/code_search_api.test.js
 *
 * DEV-ONLY, like its sibling: this directory ships in the Download-ZIP install
 * because every committed file does, and Chrome ignores it.
 *
 * The fixtures encode what a real instance was measured doing on 2026-07-29
 * (written up in plans/, which is gitignored). Three behaviours matter and each
 * has a test below:
 *
 *   - `&table=` is SILENTLY IGNORED for an unconfigured table, answering with a
 *     full unscoped search that looks scoped.
 *   - a GLOBAL 500-hit cap with no truncation flag, which one record type can
 *     consume entirely.
 *   - `lineMatches` carries ±1 lines of context, so a naive render over-reports
 *     roughly 3×.
 *
 * Every fixture is synthetic. Real instance source does not belong in a public
 * repo.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCodeSearch() {
  const file = path.join(__dirname, "..", "code_search.js");
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context.SNCodeSearch;
}

const CS = loadCodeSearch();

const parsed = (term) => CS.parseQuery(term);

/* One endpoint hit, shaped exactly like the real response. */
const apiHit = (name, className, sysId, field, lineMatches) => ({
  name,
  className,
  tableLabel: className,
  sysId,
  modified: "2026-07-29 10:00:00",
  matches: [{ field, fieldLabel: field, lineMatches }],
});

const line = (n, context) => ({ line: n, context, escaped: context });

/* ---------------------------------------------------------------------------
 * Coverage map — per table.field, never per table
 * ------------------------------------------------------------------------- */

test("coverage is the union of the same table across groups", () => {
  const coverage = CS.buildCoverage(
    [
      { table: "sys_script", search_fields: "name,script", search_group: "g1" },
      { table: "sys_script", search_fields: "name,condition", search_group: "g2" },
    ],
    []
  );
  const fields = CS.coveredFields(coverage, "sys_script");
  assert.ok(fields.includes("script"));
  assert.ok(fields.includes("condition"));
});

test("a covered table with an uncovered field is not covered for that field", () => {
  /* The real case: sys_ui_action is configured name,script in every group on
   * the instance checked, so its `condition` one-liners stay invisible. */
  const coverage = CS.buildCoverage(
    [{ table: "sys_ui_action", search_fields: "name,script", search_group: "g1" }],
    []
  );
  assert.strictEqual(CS.isCovered(coverage, "sys_ui_action", "script"), true);
  assert.strictEqual(CS.isCovered(coverage, "sys_ui_action", "condition"), false);
});

test("an additional_filter makes a table only partially searched", () => {
  const coverage = CS.buildCoverage(
    [
      {
        table: "sys_script",
        search_fields: "name,script",
        additional_filter: "active=true",
      },
    ],
    []
  );
  assert.deepStrictEqual(Array.from(CS.coveredFields(coverage, "sys_script")), []);
});

/* ---------------------------------------------------------------------------
 * Response parsing — verification, context lines, inheritance
 * ------------------------------------------------------------------------- */

test("context lines that do not contain the term are not reported as matches", () => {
  /* lineMatches arrives with ±1 lines around each match. Rendering all of them
   * would treat 3 lines as 3 hits. */
  const result = [
    {
      recordType: "sys_script_include",
      tableLabel: "Script Include",
      hits: [
        apiHit("MyUtils", "sys_script_include", "abc123", "script", [
          line(48, "  var thing = 1;"),
          line(49, "  var gr = new GlideRecord('incident');"),
          line(50, "  gr.query();"),
        ]),
      ],
    },
  ];
  const out = CS.hitsFromApiResult(result, parsed("GlideRecord"), {});
  const hits = out.byClass.sys_script_include.hits;
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].snippets.length, 1, "only the real match line");
  assert.strictEqual(hits[0].snippets[0].line, 49);
});

test("a hit whose contexts never contain the term is dropped entirely", () => {
  const result = [
    {
      recordType: "sys_script",
      hits: [
        apiHit("Rule", "sys_script", "def456", "script", [
          line(10, "  // nothing relevant here"),
        ]),
      ],
    },
  ];
  const out = CS.hitsFromApiResult(result, parsed("GlideRecord"), {});
  assert.deepStrictEqual(Object.keys(out.byClass), []);
});

test("empty contexts are skipped rather than rendered as blank snippets", () => {
  const result = [
    {
      recordType: "sys_script",
      hits: [
        apiHit("Rule", "sys_script", "def456", "script", [
          line(1, ""),
          line(2, "gs.info('found');"),
        ]),
      ],
    },
  ];
  const out = CS.hitsFromApiResult(result, parsed("gs.info"), {});
  const hits = out.byClass.sys_script.hits;
  assert.strictEqual(hits[0].snippets.length, 1);
  assert.strictEqual(hits[0].snippets[0].line, 2);
});

test("a hit is filed under its concrete class, not the record type asked for", () => {
  /* The endpoint follows inheritance: the sys_script_client record type returns
   * catalog_script_client rows. Filing by className is what lets the dedupe key
   * line up with the adapter that also returns that record. */
  const result = [
    {
      recordType: "sys_script_client",
      tableLabel: "Client Script",
      hits: [
        apiHit("Catalog thing", "catalog_script_client", "cat001", "script", [
          line(3, "g_form.setValue('x', 1);"),
        ]),
      ],
    },
  ];
  const out = CS.hitsFromApiResult(result, parsed("g_form"), {});
  assert.deepStrictEqual(Object.keys(out.byClass), ["catalog_script_client"]);
  const hit = out.byClass.catalog_script_client.hits[0];
  assert.strictEqual(hit.table, "catalog_script_client");
  assert.strictEqual(
    CS.dedupeKey(hit.table, hit.sysId, hit.field),
    CS.dedupeKey("catalog_script_client", "cat001", "script"),
    "must collide with the child adapter's key for the same record"
  );
});

test("a scoped request discards record types it did not ask for", () => {
  /* The dangerous one. An unconfigured or misspelled table is not rejected —
   * the endpoint ignores the parameter and returns everything. */
  const result = [
    { recordType: "sys_script_include", hits: [
      apiHit("A", "sys_script_include", "1", "script", [line(1, "GlideRecord")]),
    ] },
    { recordType: "sys_script", hits: [
      apiHit("B", "sys_script", "2", "script", [line(1, "GlideRecord")]),
    ] },
  ];
  const out = CS.hitsFromApiResult(result, parsed("GlideRecord"), {
    table: "sys_script_include",
  });
  assert.deepStrictEqual(Object.keys(out.byClass), ["sys_script_include"]);
  assert.strictEqual(out.ignoredScope, 1, "the unasked-for type is counted, not rendered");
});

test("saturation at the global cap is detected without a truncation flag", () => {
  const hits = [];
  for (let i = 0; i < CS.API_GLOBAL_CAP; i++) {
    hits.push(apiHit("S" + i, "sys_script", "id" + i, "script", [line(1, "GlideRecord")]));
  }
  const out = CS.hitsFromApiResult([{ recordType: "sys_script", hits }], parsed("GlideRecord"), {});
  assert.strictEqual(out.capped, true);
  assert.strictEqual(out.rawHits, CS.API_GLOBAL_CAP);
});

test("a normal-sized response is not reported as capped", () => {
  const out = CS.hitsFromApiResult(
    [{ recordType: "sys_script", hits: [
      apiHit("A", "sys_script", "1", "script", [line(1, "GlideRecord")]),
    ] }],
    parsed("GlideRecord"),
    {}
  );
  assert.strictEqual(out.capped, false);
});

test("a sensitive name is redacted on the Tier 1 path too", () => {
  const out = CS.hitsFromApiResult(
    [{ recordType: "sys_script_include", hits: [
      apiHit("api_key_helper", "sys_script_include", "s1", "script", [
        line(4, "var token = 'GlideRecord';"),
      ]),
    ] }],
    parsed("GlideRecord"),
    {}
  );
  const hit = out.byClass.sys_script_include.hits[0];
  assert.strictEqual(hit.redacted, true);
  assert.strictEqual(hit.snippets[0].text, "•••");
});

/* ---------------------------------------------------------------------------
 * The hybrid call model
 * ------------------------------------------------------------------------- */

const coverageFor = (spec) =>
  CS.buildCoverage(
    Object.keys(spec).map((table) => ({ table, search_fields: spec[table] })),
    []
  );

test("an uncapped unscoped call is the whole search — one request", async () => {
  const calls = [];
  const result = await CS.runApiSearch(parsed("GlideRecord"), {
    coverage: coverageFor({ sys_script_include: "name,script" }),
    apiTransport: (request) => {
      calls.push(request);
      return Promise.resolve({ ok: true, status: 200, result: [
        { recordType: "sys_script_include", hits: [
          apiHit("A", "sys_script_include", "1", "script", [line(1, "GlideRecord")]),
        ] },
      ] });
    },
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].table, undefined);
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.capped, false);
  assert.strictEqual(result.hits.length, 1);
});

test("a saturated unscoped call is retried per table so one source cannot starve the rest", async () => {
  /* Measured on a real instance: 499 of 500 slots went to a single record type,
   * leaving one for everything else. Per-table calls give each its own budget. */
  const calls = [];
  const saturated = [];
  for (let i = 0; i < CS.API_GLOBAL_CAP; i++) {
    saturated.push(apiHit("C" + i, "catalog_script_client", "c" + i, "script", [
      line(1, "GlideRecord"),
    ]));
  }
  const result = await CS.runApiSearch(parsed("GlideRecord"), {
    coverage: coverageFor({
      sys_script: "name,script",
      sys_script_include: "name,script",
    }),
    apiTransport: (request) => {
      calls.push(request.table || "(unscoped)");
      if (!request.table) {
        return Promise.resolve({ ok: true, status: 200, result: [
          { recordType: "sys_script_client", hits: saturated },
        ] });
      }
      return Promise.resolve({ ok: true, status: 200, result: [
        { recordType: request.table, hits: [
          apiHit("hit in " + request.table, request.table, request.table + "-1", "script", [
            line(2, "new GlideRecord()"),
          ]),
        ] },
      ] });
    },
  });
  assert.strictEqual(calls[0], "(unscoped)");
  assert.deepStrictEqual(calls.slice(1).sort(), ["sys_script", "sys_script_include"]);
  assert.strictEqual(result.hits.length, 2, "one hit per table, none starved");
});

test("a table: filter the instance does not index never reaches the endpoint", async () => {
  /* Sending it would return a full unscoped search dressed as a scoped one. */
  let called = false;
  const result = await CS.runApiSearch(CS.parseQuery("GlideRecord table:sys_dictionary"), {
    coverage: coverageFor({ sys_script: "name,script" }),
    apiTransport: () => {
      called = true;
      return Promise.resolve({ ok: true, status: 200, result: [] });
    },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(result.available, false);
  assert.match(result.reason, /does not index/i);
});

test("a table: filter the instance does index is sent scoped", async () => {
  const calls = [];
  await CS.runApiSearch(CS.parseQuery("GlideRecord table:sys_script"), {
    coverage: coverageFor({ sys_script: "name,script" }),
    apiTransport: (request) => {
      calls.push(request);
      return Promise.resolve({ ok: true, status: 200, result: [
        { recordType: "sys_script", hits: [
          apiHit("A", "sys_script", "1", "script", [line(1, "GlideRecord")]),
        ] },
      ] });
    },
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].table, "sys_script");
});

test("unreadable coverage means unavailable, and unavailable is not an error", async () => {
  const result = await CS.runApiSearch(parsed("GlideRecord"), {
    coverage: { available: false, tables: {} },
    apiTransport: () => Promise.reject(new Error("must not be called")),
  });
  assert.strictEqual(result.available, false);
  assert.deepStrictEqual(Array.from(result.hits), []);
  assert.ok(result.reason);
});

test("an endpoint failure degrades to unavailable rather than throwing", async () => {
  const result = await CS.runApiSearch(parsed("GlideRecord"), {
    coverage: coverageFor({ sys_script: "name,script" }),
    apiTransport: () => Promise.resolve({ ok: false, status: 404, error: "HTTP 404" }),
  });
  assert.strictEqual(result.available, false);
  assert.match(result.reason, /404/);
});

/* ---------------------------------------------------------------------------
 * The merge: which adapters Tier 1 actually makes redundant
 * ------------------------------------------------------------------------- */

test("a fully covered adapter is skipped", () => {
  const coverage = coverageFor({ sys_script_include: "name,script" });
  const skip = CS.adaptersCoveredBy(
    { available: true, capped: false, searchedTables: ["sys_script_include"] },
    coverage,
    CS.SEARCH_TARGETS
  );
  assert.strictEqual(skip["script-include"], true);
});

test("a partially covered adapter keeps running", () => {
  /* sys_ui_action is indexed name,script — never condition — so the adapter is
   * the only thing that will ever find a UI Action condition. */
  const coverage = coverageFor({ sys_ui_action: "name,script" });
  const skip = CS.adaptersCoveredBy(
    { available: true, capped: false, searchedTables: ["sys_ui_action"] },
    coverage,
    CS.SEARCH_TARGETS
  );
  assert.ok(!skip["ui-action"]);
});

test("nothing is skipped when Tier 1 saturated", () => {
  /* A capped Tier 1 may have dropped hits silently, so it cannot stand in for
   * a source that would have found them. */
  const coverage = coverageFor({ sys_script_include: "name,script" });
  const skip = CS.adaptersCoveredBy(
    { available: true, capped: true, searchedTables: ["sys_script_include"] },
    coverage,
    CS.SEARCH_TARGETS
  );
  assert.deepStrictEqual(Object.keys(skip), []);
});

test("nothing is skipped when Tier 1 is unavailable", () => {
  const coverage = coverageFor({ sys_script_include: "name,script" });
  const skip = CS.adaptersCoveredBy({ available: false }, coverage, CS.SEARCH_TARGETS);
  assert.deepStrictEqual(Object.keys(skip), []);
});

test("the gap pack is never skipped, because no group configures it", () => {
  const coverage = coverageFor({
    sys_script: "name,script,condition",
    sys_script_include: "name,script",
  });
  const skip = CS.adaptersCoveredBy(
    {
      available: true,
      capped: false,
      searchedTables: ["sys_script", "sys_script_include"],
    },
    coverage,
    CS.SEARCH_TARGETS
  );
  ["dictionary", "dictionary-override", "catalog-variable", "transform-entry",
   "record-producer", "catalog-client-script"].forEach((id) => {
    assert.ok(!skip[id], id + " must keep its adapter");
  });
});

/* ---------------------------------------------------------------------------
 * Display grouping — one table is one group, whichever tier found it
 * ------------------------------------------------------------------------- */

test("both tiers reporting one table agree on the group key and name", async () => {
  const tier1 = await CS.runApiSearch(parsed("GlideRecord"), {
    coverage: coverageFor({ sys_ui_action: "name,script" }),
    apiTransport: () =>
      Promise.resolve({ ok: true, status: 200, result: [
        { recordType: "sys_ui_action", tableLabel: "UI Action", hits: [
          apiHit("Resolve", "sys_ui_action", "ui1", "script", [line(1, "GlideRecord")]),
        ] },
      ] }),
  });

  const adapter = await CS.runSearch(parsed("GlideRecord"), {
    targets: [CS.targetById("ui-action")],
    transport: () =>
      Promise.resolve({ ok: true, result: [
        { sys_id: "ui2", name: "Close", condition: "new GlideRecord()", table: "incident" },
      ] }),
  });

  const fromInstance = tier1.sources[0];
  const fromAdapter = adapter.sources[0];
  assert.strictEqual(fromInstance.groupKey, fromAdapter.groupKey, "same group");
  assert.strictEqual(fromInstance.groupLabel, fromAdapter.groupLabel);
  assert.strictEqual(fromInstance.groupLabel, "UI action");
  /* The source label still names the tier, because the status drawer has to
   * keep answering "what actually ran". */
  assert.notStrictEqual(fromInstance.label, fromAdapter.label);
  assert.match(fromInstance.label, /instance search/i);
});

test("a Tier 1 record type with no adapter still gets a readable group name", () => {
  const out = CS.hitsFromApiResult(
    [{ recordType: "sp_widget", tableLabel: "Widget", hits: [
      apiHit("Catalog widget", "sp_widget", "w1", "script", [line(1, "GlideRecord")]),
    ] }],
    parsed("GlideRecord"),
    {}
  );
  assert.strictEqual(out.byClass.sp_widget.label, "Widget");
});

test("a skipped source is reported, not silently dropped", async () => {
  const seen = [];
  const result = await CS.runSearch(parsed("GlideRecord"), {
    targets: [
      {
        id: "script-include",
        kind: "script",
        label: "Script include",
        table: "sys_script_include",
        fields: ["script"],
        title: ["name"],
        tier: 1,
      },
    ],
    skipTargets: { "script-include": true },
    transport: () => Promise.reject(new Error("skipped sources must not be fetched")),
    onSource: (summary) => seen.push(summary),
  });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].status, CS.SOURCE_STATUS.SKIPPED);
  assert.strictEqual(result.sources[0].status, CS.SOURCE_STATUS.SKIPPED);
});

/*
 * Tests for code_search.js — Node's built-in runner, zero dependencies:
 *
 *   node --test tests/
 *
 * DEV-ONLY. This directory ships in the Download-ZIP install (every committed
 * file does) and Chrome ignores it; it is not part of the extension.
 *
 * code_search.js is a browser script that assigns to globalThis, so it is
 * loaded here through node:vm rather than require(). That keeps the shipped
 * file free of any module shim that exists only for tests.
 *
 * Every fixture below is synthetic. Real instance source — especially from a
 * work instance — does not belong in a public repo.
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

/* Arrays returned by code_search.js are built inside the vm realm, so their
 * prototype is not this realm's Array.prototype and deepStrictEqual rejects
 * them on identity alone. Copying across the boundary keeps the comparison
 * strict about contents. */
const own = (value) => Array.from(value);

test("module exposes itself once and is idempotent", () => {
  assert.ok(CS, "SNCodeSearch missing from globalThis");
  assert.strictEqual(typeof CS.parseQuery, "function");
});

/* ---------------------------------------------------------------------------
 * Anchor extraction — the safety boundary between us and sysparm_query
 * ------------------------------------------------------------------------- */

test("anchor is the longest query-safe run", () => {
  assert.strictEqual(CS.extractAnchor("new GlideRecord('incident')"), "GlideRecord");
  assert.strictEqual(CS.extractAnchor("u_my_field"), "u_my_field");
  assert.strictEqual(CS.extractAnchor("getTemplates(current)"), "getTemplates");
});

test("anchor refuses terms with no safe run of the minimum length", () => {
  assert.strictEqual(CS.extractAnchor("^^^"), null);
  assert.strictEqual(CS.extractAnchor("a^b"), null);
  assert.strictEqual(CS.extractAnchor("=="), null);
  assert.strictEqual(CS.extractAnchor(""), null);
  assert.strictEqual(CS.extractAnchor(null), null);
});

test("anchor never contains an encoded-query metacharacter", () => {
  const hostile = [
    "foo^active=true",
    "a=b,c",
    "x@y",
    "one\ntwo",
    "he said \"hello\"",
    "name!=value",
    "a<b>c",
    "50%off",
    "café_lookup",
    "変数_reference",
  ];
  hostile.forEach((term) => {
    const anchor = CS.extractAnchor(term);
    if (anchor === null) return;
    assert.match(anchor, /^[A-Za-z0-9_]+$/, "unsafe anchor from: " + term);
  });
});

test("a caret in the term cannot reach the encoded query", () => {
  const parsed = CS.parseQuery("current^active=true");
  assert.ok(parsed.ok);
  /* The literal the user typed is kept whole for verification... */
  assert.strictEqual(parsed.term, "current^active=true");
  /* ...but only the safe run is ever sent to the server. */
  assert.strictEqual(parsed.anchor, "current");
  const query = CS.buildFieldQuery(["condition"], parsed.anchor);
  assert.strictEqual(query, "conditionLIKEcurrent");
  assert.ok(query.indexOf("active") === -1, "term leaked into the query");
});

test("buildAnchorCondition throws rather than emit an unsafe query", () => {
  assert.throws(() => CS.buildAnchorCondition("field", "a^b"));
  assert.throws(() => CS.buildAnchorCondition("field^x", "safe"));
  assert.throws(() => CS.buildAnchorCondition("field", "ab"), /too-short/);
});

test("multi-field queries OR-join without corrupting separators", () => {
  assert.strictEqual(
    CS.buildFieldQuery(["reference_qual", "default_value"], "javascript"),
    "reference_qualLIKEjavascript^ORdefault_valueLIKEjavascript"
  );
});

/* ---------------------------------------------------------------------------
 * Query parsing
 * ------------------------------------------------------------------------- */

test("regex input is rejected with a reason, not silently downgraded", () => {
  const parsed = CS.parseQuery("/foo|bar/i");
  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.error, /Regular expressions/);
  assert.match(parsed.error, /silently/);
});

test("quoted phrase keeps spaces and is not parsed for filters", () => {
  const parsed = CS.parseQuery('"table:incident is a phrase"');
  assert.ok(parsed.ok);
  assert.strictEqual(parsed.term, "table:incident is a phrase");
  assert.strictEqual(parsed.isPhrase, true);
  assert.deepStrictEqual(own(parsed.filters.tables), []);
});

test("table: filters are extracted and lowercased", () => {
  const parsed = CS.parseQuery("GlideRecord table:SYS_SCRIPT_INCLUDE");
  assert.ok(parsed.ok);
  assert.strictEqual(parsed.term, "GlideRecord");
  assert.deepStrictEqual(own(parsed.filters.tables), ["sys_script_include"]);
});

test("kind: filters are refused rather than silently narrowing the search", () => {
  const parsed = CS.parseQuery("kind:catalog getpaymentterm");
  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.error, /every supported source/);
  assert.match(parsed.error, /table:<name>/);
});

test("filters with no term are refused rather than matching everything", () => {
  const parsed = CS.parseQuery("table:sys_script");
  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.error, /match everything/);
});

test("empty and too-short terms are refused", () => {
  assert.strictEqual(CS.parseQuery("").ok, false);
  assert.strictEqual(CS.parseQuery("   ").ok, false);
  const short = CS.parseQuery("ab");
  assert.strictEqual(short.ok, false);
  assert.match(short.error, /searchable run/);
});

/* ---------------------------------------------------------------------------
 * Verification — the defence against silently-dropped server filters
 * ------------------------------------------------------------------------- */

test("verifyMatch is case-insensitive substring", () => {
  assert.ok(CS.verifyMatch("var gr = new GlideRecord('x')", "gliderecord"));
  assert.ok(CS.verifyMatch("GLIDERECORD", "GlideRecord"));
  assert.strictEqual(CS.verifyMatch("nothing here", "GlideRecord"), false);
});

test("a row that only matched the anchor is rejected", () => {
  /* What the server returns for "current^active=true": the anchor "current"
   * matched, the full literal did not. Rendering this row would be the bug. */
  const serverRow = "current.state == 3";
  const parsed = CS.parseQuery("current^active=true");
  assert.ok(CS.verifyMatch(serverRow, parsed.anchor), "anchor should match");
  assert.strictEqual(
    CS.verifyMatch(serverRow, parsed.term),
    false,
    "full literal must not verify"
  );
});

test("verifyMatch handles empty and null defensively", () => {
  assert.strictEqual(CS.verifyMatch(null, "x"), false);
  assert.strictEqual(CS.verifyMatch("x", null), false);
  assert.strictEqual(CS.verifyMatch("x", ""), false);
});

/* ---------------------------------------------------------------------------
 * Snippets
 * ------------------------------------------------------------------------- */

test("snippet is the enclosing line with correct 1-based line number", () => {
  const body = "line one\nvar gr = new GlideRecord('incident');\nline three";
  const snippets = CS.buildSnippets(body, "GlideRecord");
  assert.strictEqual(snippets.length, 1);
  assert.strictEqual(snippets[0].line, 2);
  assert.strictEqual(snippets[0].text, "var gr = new GlideRecord('incident');");
});

test("snippet match offsets point at the term inside the snippet text", () => {
  const body = "    var gr = new GlideRecord('incident');";
  const [snippet] = CS.buildSnippets(body, "GlideRecord");
  assert.strictEqual(
    snippet.text.slice(snippet.matchStart, snippet.matchEnd),
    "GlideRecord"
  );
});

test("a very long line is windowed so the match stays visible", () => {
  const body = "x".repeat(500) + "NEEDLE" + "y".repeat(500);
  const [snippet] = CS.buildSnippets(body, "NEEDLE", { maxLength: 80 });
  assert.ok(snippet.text.length <= 82, "snippet not windowed: " + snippet.text.length);
  assert.strictEqual(
    snippet.text.slice(snippet.matchStart, snippet.matchEnd),
    "NEEDLE"
  );
});

test("multiple matches are capped per field", () => {
  const body = Array.from({ length: 10 }, (unused, i) => "hit " + i).join("\n");
  const snippets = CS.buildSnippets(body, "hit");
  assert.strictEqual(snippets.length, 3);
  assert.strictEqual(snippets[0].line, 1);
  assert.strictEqual(snippets[2].line, 3);
});

test("first and last line boundaries do not overrun", () => {
  const single = CS.buildSnippets("only GlideRecord here", "GlideRecord");
  assert.strictEqual(single[0].line, 1);
  assert.strictEqual(single[0].text, "only GlideRecord here");
  const last = CS.buildSnippets("a\nb\ntrailing GlideRecord", "GlideRecord");
  assert.strictEqual(last[0].line, 3);
  assert.strictEqual(last[0].text, "trailing GlideRecord");
});

test("no match yields no snippets", () => {
  assert.deepStrictEqual(own(CS.buildSnippets("nothing", "GlideRecord")), []);
});

/* ---------------------------------------------------------------------------
 * Identity and dedupe
 * ------------------------------------------------------------------------- */

test("dedupe key is table + sysId + field", () => {
  assert.strictEqual(CS.dedupeKey("sys_script", "abc", "script"), "sys_script|abc|script");
});

test("same record matching two fields stays two rows", () => {
  const hits = [
    { table: "sys_script", sysId: "abc", field: "script" },
    { table: "sys_script", sysId: "abc", field: "condition" },
  ];
  assert.strictEqual(CS.dedupeHits(hits).length, 2);
});

test("the same hit from overlapping sources collapses to one", () => {
  const hits = [
    { table: "sys_script", sysId: "abc", field: "script", from: "adapter" },
    { table: "sys_script", sysId: "abc", field: "script", from: "code-search-api" },
  ];
  const deduped = CS.dedupeHits(hits);
  assert.strictEqual(deduped.length, 1);
  assert.strictEqual(deduped[0].from, "adapter", "first source should win");
});

/* ---------------------------------------------------------------------------
 * Redaction
 * ------------------------------------------------------------------------- */

test("sensitive names are detected on name or label", () => {
  assert.ok(CS.isSensitiveName("api_key"));
  assert.ok(CS.isSensitiveName("u_password_reset"));
  assert.ok(CS.isSensitiveName("harmless", "OAuth Token"));
  assert.strictEqual(CS.isSensitiveName("assignment_rule"), false);
});

test("a sensitive hit renders as bullets with no body text", () => {
  const hit = {
    table: "sys_script",
    sysId: "abc",
    field: "script",
    name: "set_api_key",
    snippets: [{ line: 4, text: "var k = 'sk-real-secret';", matchStart: 8, matchEnd: 11 }],
  };
  const redacted = CS.redactHit(hit);
  assert.strictEqual(redacted.redacted, true);
  assert.strictEqual(redacted.snippets[0].text, "•••");
  assert.strictEqual(redacted.snippets[0].line, 4, "line number is still useful");
  assert.ok(
    JSON.stringify(redacted).indexOf("sk-real-secret") === -1,
    "secret survived redaction"
  );
});

test("redaction is default-deny for an unnamed hit", () => {
  const hit = {
    table: "sys_variable_value",
    sysId: "abc",
    field: "value",
    name: "",
    snippets: [{ line: 1, text: "unknown", matchStart: 0, matchEnd: 1 }],
  };
  assert.strictEqual(CS.redactHit(hit).redacted, true);
});

test("an ordinary named hit is untouched", () => {
  const hit = { table: "sys_script", sysId: "abc", field: "script", name: "Set priority", snippets: [] };
  assert.strictEqual(CS.redactHit(hit).redacted, undefined);
});

/* ---------------------------------------------------------------------------
 * Stale sessions
 * ------------------------------------------------------------------------- */

test("a slower earlier search cannot paint over a newer one", () => {
  const tracker = CS.createSessionTracker();
  const first = tracker.next();
  const second = tracker.next();
  assert.strictEqual(tracker.isCurrent(second), true);
  assert.strictEqual(tracker.isCurrent(first), false);
});

test("cancel invalidates the in-flight search", () => {
  const tracker = CS.createSessionTracker();
  const id = tracker.next();
  assert.strictEqual(tracker.isCurrent(id), true);
  tracker.cancel();
  assert.strictEqual(tracker.isCurrent(id), false);
});

/* ---------------------------------------------------------------------------
 * Registry
 * ------------------------------------------------------------------------- */

test("every registry target is well formed and uniquely identified", () => {
  const seen = new Set();
  own(CS.SEARCH_TARGETS).forEach((target) => {
    assert.ok(target.id, "target without an id");
    assert.strictEqual(seen.has(target.id), false, "duplicate id: " + target.id);
    seen.add(target.id);
    assert.match(target.table, /^[a-z0-9_]+$/, "unsafe table: " + target.table);
    assert.ok(own(target.fields).length > 0, "no fields: " + target.id);
    own(target.fields).forEach((field) =>
      assert.match(field, /^[a-z0-9_]+$/, "unsafe field: " + target.id + "." + field)
    );
  });
});

test("every registry field survives encoded-query construction", () => {
  own(CS.SEARCH_TARGETS).forEach((target) => {
    const query = CS.buildFieldQuery(own(target.fields), "anchor");
    assert.ok(query.indexOf("^OR") !== -1 || own(target.fields).length === 1);
  });
});

test("item_option_new.macro is absent — it is a reference, not searchable text", () => {
  const target = CS.targetById("catalog-variable");
  assert.ok(target);
  assert.strictEqual(own(target.fields).indexOf("macro"), -1);
  assert.ok(own(target.fields).indexOf("reference_qual") !== -1);
});

/* ---------------------------------------------------------------------------
 * Fetch pool
 * ------------------------------------------------------------------------- */

test("pool respects the concurrency ceiling", async () => {
  let inFlight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 12 }, () => async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { ok: true };
  });
  await CS.runPool(tasks, { concurrency: 4 });
  assert.ok(peak <= 4, "peak concurrency was " + peak);
});

test("pool returns one result per task", async () => {
  const tasks = Array.from({ length: 6 }, (unused, i) => async () => ({ ok: true, i }));
  const results = await CS.runPool(tasks, { concurrency: 3 });
  assert.strictEqual(results.length, 6);
});

test("a throwing task fails only itself", async () => {
  const tasks = [
    async () => ({ ok: true, id: "a" }),
    async () => {
      throw new Error("source exploded");
    },
    async () => ({ ok: true, id: "c" }),
  ];
  const results = own(await CS.runPool(tasks, { concurrency: 3 }));
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results.filter((r) => r.ok).length, 2);
  assert.match(results.filter((r) => !r.ok)[0].error, /source exploded/);
});

test("cancel drains the queue instead of running every task", async () => {
  let started = 0;
  let stop = false;
  const tasks = Array.from({ length: 20 }, () => async () => {
    started++;
    await new Promise((r) => setTimeout(r, 1));
    return { ok: true };
  });
  const pending = CS.runPool(tasks, { concurrency: 2, shouldStop: () => stop });
  setTimeout(() => {
    stop = true;
  }, 5);
  await pending;
  assert.ok(started < 20, "pool ran all " + started + " tasks despite cancel");
});

/* ---------------------------------------------------------------------------
 * Probe — the super_class walk that keeps catalog variables searchable
 * ------------------------------------------------------------------------- */

/* Mirrors the real hierarchy verified on the instance: item_option_new extends
 * question, catalog_script_client extends sys_script_client, and the fields we
 * search are defined on those PARENTS. */
function fakeInstance() {
  const tables = {
    item_option_new: { sys_id: "t_ion", super_class: "t_question" },
    question: { sys_id: "t_question", super_class: "t_meta" },
    catalog_script_client: { sys_id: "t_csc", super_class: "t_ssc" },
    sys_script_client: { sys_id: "t_ssc", super_class: "t_meta" },
    sys_metadata: { sys_id: "t_meta", super_class: "" },
  };
  const dictionary = [
    { name: "question", element: "reference_qual" },
    { name: "question", element: "default_value" },
    { name: "item_option_new", element: "read_script" },
    { name: "sys_script_client", element: "script" },
  ];
  return async (request) => {
    if (request.table === "sys_db_object") {
      const rows = Object.keys(tables).map((name) =>
        Object.assign({ name }, tables[name])
      );
      if (request.query.indexOf("nameIN") === 0) {
        const wanted = request.query.slice("nameIN".length).split(",");
        return { ok: true, result: rows.filter((r) => wanted.indexOf(r.name) !== -1) };
      }
      const wantedIds = request.query.slice("sys_idIN".length).split(",");
      return { ok: true, result: rows.filter((r) => wantedIds.indexOf(r.sys_id) !== -1) };
    }
    if (request.table === "sys_dictionary") {
      return { ok: true, result: dictionary };
    }
    return { ok: false, status: 404, error: "unexpected table " + request.table };
  };
}

test("ancestry walk resolves the full super_class chain", async () => {
  const chains = await CS.resolveAncestry(["item_option_new"], fakeInstance());
  assert.deepStrictEqual(own(chains.item_option_new), [
    "item_option_new",
    "question",
    "sys_metadata",
  ]);
});

test("probe finds a field defined on a parent table", async () => {
  const result = await CS.probe({
    transport: fakeInstance(),
    targets: [
      {
        id: "catalog-variable",
        table: "item_option_new",
        fields: ["reference_qual", "default_value", "read_script"],
      },
    ],
  });
  assert.strictEqual(result.ok, true);
  const fields = own(result.targets["catalog-variable"].fields);
  /* Defined on `question`, queryable on item_option_new. A probe without the
   * super_class walk reports these missing and disables the source. */
  assert.ok(fields.indexOf("reference_qual") !== -1, "inherited field dropped");
  assert.ok(fields.indexOf("default_value") !== -1, "inherited field dropped");
  assert.ok(fields.indexOf("read_script") !== -1, "own field dropped");
  assert.strictEqual(own(result.targets["catalog-variable"].missing).length, 0);
});

test("probe reports a genuinely absent field as missing", async () => {
  const result = await CS.probe({
    transport: fakeInstance(),
    targets: [
      { id: "x", table: "item_option_new", fields: ["reference_qual", "not_a_column"] },
    ],
  });
  assert.deepStrictEqual(own(result.targets.x.fields), ["reference_qual"]);
  assert.deepStrictEqual(own(result.targets.x.missing), ["not_a_column"]);
});

test("a failed probe means unknown, not absent", async () => {
  const failing = async () => ({ ok: false, status: 500, error: "boom" });
  const result = await CS.probe({
    transport: failing,
    targets: [{ id: "x", table: "sys_script", fields: ["script", "condition"] }],
  });
  assert.strictEqual(result.ok, false);
  /* Fields stay searchable: refusing a source because one request failed would
   * be the silent hole the whole design exists to avoid. */
  assert.deepStrictEqual(own(result.targets.x.fields), ["script", "condition"]);
  assert.strictEqual(result.targets.x.unverified, true);
});

/* ---------------------------------------------------------------------------
 * Search orchestration
 * ------------------------------------------------------------------------- */

const DICT_TARGET = {
  id: "dictionary",
  kind: "dictionary",
  label: "Dictionary",
  table: "sys_dictionary",
  fields: ["reference_qual"],
  title: ["name", "element"],
  tier: 1,
};

function transportReturning(rows, overrides) {
  return async () => Object.assign({ ok: true, result: rows }, overrides || {});
}

test("only rows containing the real term become hits", async () => {
  /* The server matched the anchor "current" and, per rule 1, may also have
   * dropped the filter entirely and returned unrelated rows. Neither may
   * reach the panel. */
  const parsed = CS.parseQuery("current^active=true");
  const rows = [
    { sys_id: "1", name: "incident", element: "x", reference_qual: "current^active=true" },
    { sys_id: "2", name: "incident", element: "y", reference_qual: "current.state == 3" },
    { sys_id: "3", name: "incident", element: "z", reference_qual: "nothing relevant" },
  ];
  const result = await CS.runSearch(parsed, {
    targets: [DICT_TARGET],
    transport: transportReturning(rows),
  });
  assert.strictEqual(own(result.hits).length, 1);
  assert.strictEqual(own(result.hits)[0].sysId, "1");
});

test("a hit carries the sys_id and a readable name", async () => {
  const parsed = CS.parseQuery("javascript");
  const result = await CS.runSearch(parsed, {
    targets: [DICT_TARGET],
    transport: transportReturning([
      { sys_id: "abc", name: "incident", element: "caller_id", reference_qual: "javascript:x()" },
    ]),
  });
  const hit = own(result.hits)[0];
  assert.strictEqual(hit.sysId, "abc");
  assert.strictEqual(hit.name, "incident · caller_id");
  assert.strictEqual(hit.table, "sys_dictionary");
  assert.strictEqual(hit.field, "reference_qual");
  assert.ok(own(hit.snippets).length > 0);
});

test("a denied source is reported as denied, never as no matches", async () => {
  const parsed = CS.parseQuery("javascript");
  const result = await CS.runSearch(parsed, {
    targets: [DICT_TARGET],
    transport: async () => ({ ok: false, status: 403, error: "HTTP 403" }),
  });
  assert.strictEqual(own(result.sources)[0].status, "denied");
  assert.strictEqual(own(result.sources)[0].count, 0);
});

test("status distinguishes absent, timed out and empty", async () => {
  const parsed = CS.parseQuery("javascript");
  const status = async (response) => {
    const result = await CS.runSearch(parsed, {
      targets: [DICT_TARGET],
      transport: async () => response,
    });
    return own(result.sources)[0].status;
  };
  assert.strictEqual(await status({ ok: false, status: 404, error: "gone" }), "absent");
  assert.strictEqual(await status({ ok: false, status: 0, timedOut: true }), "timed-out");
  assert.strictEqual(await status({ ok: true, result: [] }), "no-matches");
});

test("one failing source does not discard the others", async () => {
  const parsed = CS.parseQuery("javascript");
  const good = Object.assign({}, DICT_TARGET, { id: "good", table: "sys_script" });
  const result = await CS.runSearch(parsed, {
    targets: [DICT_TARGET, good],
    transport: async (request) =>
      request.table === "sys_dictionary"
        ? { ok: false, status: 403, error: "denied" }
        : {
            ok: true,
            result: [{ sys_id: "9", name: "n", element: "e", reference_qual: "javascript:y()" }],
          },
  });
  assert.strictEqual(own(result.hits).length, 1);
  assert.strictEqual(own(result.sources).length, 2);
  assert.strictEqual(
    own(result.sources).filter((s) => s.status === "denied").length,
    1
  );
});

test("a source hitting the row limit is reported as capped", async () => {
  const parsed = CS.parseQuery("javascript");
  const rows = Array.from({ length: 5 }, (unused, i) => ({
    sys_id: String(i),
    name: "t",
    element: "e",
    reference_qual: "javascript:x()",
  }));
  const result = await CS.runSearch(parsed, {
    targets: [DICT_TARGET],
    transport: transportReturning(rows),
    limit: 5,
  });
  assert.strictEqual(own(result.sources)[0].status, "capped");
});

test("table: filters narrow which sources run", () => {
  const scoped = CS.selectTargets(
    { filters: { tables: ["sys_dictionary"] } },
    null
  );
  assert.strictEqual(own(scoped).length, 1);
  assert.strictEqual(own(scoped)[0].table, "sys_dictionary");
});

test("an unscoped search selects every tier-1 source", () => {
  const unscoped = CS.selectTargets({ filters: { tables: [] } }, null);
  const tierOne = own(CS.SEARCH_TARGETS).filter((target) => (target.tier || 1) === 1);
  assert.strictEqual(own(unscoped).length, tierOne.length);
});

test("the probe removes missing fields but keeps the source searchable", () => {
  const probeResult = {
    targets: { dictionary: { fields: ["reference_qual"], missing: ["calculation"] } },
  };
  const selected = CS.selectTargets({ filters: { tables: [] } }, probeResult);
  const dictionary = own(selected).filter((t) => t.id === "dictionary")[0];
  assert.deepStrictEqual(own(dictionary.fields), ["reference_qual"]);
  assert.deepStrictEqual(own(dictionary.missingFields), ["calculation"]);
});

test("a source whose every field is missing is not searched at all", () => {
  const probeResult = { targets: { dictionary: { fields: [], missing: ["reference_qual"] } } };
  const selected = CS.selectTargets({ filters: { tables: ["sys_dictionary"] } }, probeResult);
  assert.strictEqual(own(selected).length, 0);
});

test("a sensitive hit is redacted on the way out of the search", async () => {
  const target = Object.assign({}, DICT_TARGET, { title: ["name"] });
  const parsed = CS.parseQuery("javascript");
  const result = await CS.runSearch(parsed, {
    targets: [target],
    transport: transportReturning([
      { sys_id: "1", name: "u_api_key_lookup", reference_qual: "javascript: 'sk-live-xyz'" },
    ]),
  });
  const hit = own(result.hits)[0];
  assert.strictEqual(hit.redacted, true);
  assert.ok(JSON.stringify(hit).indexOf("sk-live-xyz") === -1);
});

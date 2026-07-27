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

test("table: and kind: filters are extracted and lowercased", () => {
  const parsed = CS.parseQuery("GlideRecord table:sys_script_include kind:Dictionary");
  assert.ok(parsed.ok);
  assert.strictEqual(parsed.term, "GlideRecord");
  assert.deepStrictEqual(own(parsed.filters.tables), ["sys_script_include"]);
  assert.deepStrictEqual(own(parsed.filters.kinds), ["dictionary"]);
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

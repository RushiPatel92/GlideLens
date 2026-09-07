/* Translation Lens runtime-boundary tests. No browser or live instance needed. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const packageSource = fs.readFileSync(path.join(__dirname, "..", "package.mjs"), "utf8");
const translationLensSource = fs.readFileSync(path.join(__dirname, "..", "translation_lens.js"), "utf8");
const manifestSource = fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8");

/* Line endings are normalised before the search. `core.autocrlf=true` gives a
 * Windows working copy CRLF files while the repository stores LF, so a
 * sentinel spanning a newline -- the section banners below do -- matches or
 * fails depending on how the tree was checked out rather than on the code
 * under test. Slicing the normalised text keeps the indices consistent. */
function between(source, startText, endText) {
  const text = String(source).replace(/\r\n/g, "\n");
  const start = text.indexOf(startText);
  const end = text.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, "source block not found: " + startText);
  return text.slice(start, end);
}

test("a table-sourced catalog choice is not applicable, not unverified", () => {
  /* List Collector and the lookup types draw options from a table, so there is
   * no choice list to translate. Reporting that as "unverified" claimed a read
   * had failed when it was never applicable, and put a row nobody can act on
   * in front of the reader. analyzeCatalogChoice is not exported -- the engine
   * surface is a deliberate contract -- so this is pinned at the source. */
  const branch = between(
    translationLensSource,
    "if (DYNAMIC_CATALOG_TYPES.has(String(variable.type",
    "const activeChoices"
  );
  assert.ok(branch.includes('"not_applicable"'), "the state must be not applicable");
  assert.ok(branch.includes("minor: true"), "and flagged so the panel can fold it away");
  assert.ok(!branch.includes('"unverified"'), "and must no longer claim a failed read");
  assert.ok(
    /notApplicableReason/.test(branch),
    "a not-applicable row must name its reason rather than leaving it blank"
  );
});

test("Reference variables are left out of the table-sourced set on purpose", () => {
  /* Type 8 produces no choice row at all today. Adding it to the set would
   * invent rows only to hide them, which is the opposite of the intent. */
  const set = between(translationLensSource, "const DYNAMIC_CATALOG_TYPES", ");");
  assert.ok(set.includes('"21"'), "List Collector is in the set");
  assert.ok(!/"8"/.test(set), "Reference must not be added to it");
  assert.ok(!/"reference"/.test(set),
    "and the string alias must be absent too, or the exclusion holds only for the numeric form");
});

test("content script pins the complete six-method Opus UI contract", () => {
  const contract = between(
    contentSource,
    "const TRANSLATION_LENS_UI_METHODS",
    "let translationLensRunSequence"
  );
  [
    "open", "setProgress", "showResults", "showError", "close",
    "formatResultsAsText",
  ].forEach((method) => assert.ok(contract.includes('"' + method + '"'), method));
  assert.match(contentSource, /Translation Lens panel is awaiting its visual module/);
  assert.ok(!contentSource.includes("globalThis.SNTranslationLensUI ="));
});

test("Workspace is refused before loading or probing Translation Lens", () => {
  const block = between(contentSource, "async function showTranslationLens", "/* =====================================================================\n * RECORD SEARCH");
  /* The refusal uses the any-id route detector, not the saved-record parser:
   * a new Workspace record has no sys_id in its route and must still refuse. */
  const workspace = block.indexOf("isWorkspaceRecordRoute(location.href)");
  const load = block.indexOf("ensureTranslationLensLoaded()");
  const resolve = block.indexOf("resolveTranslationLensContext(engine)");
  assert.ok(workspace >= 0 && workspace < load && load < resolve);
  assert.ok(!block.includes("if (workspaceRecordContextFromText(location.href))"));

  const resolver = between(contentSource, "async function resolveTranslationLensContext", "function translationFormEngineContext");
  assert.ok(
    resolver.indexOf("isWorkspaceRecordRoute(location.href)") <
      resolver.indexOf("getFormTranslationContext([], null)")
  );
  assert.ok(!resolver.includes("workspaceRecordContextFromText"));
  const stillCurrent = between(contentSource, "async function translationContextStillCurrent", "function openTranslationUrl");
  assert.ok(stillCurrent.includes("isWorkspaceRecordRoute(location.href)"));
});

test("the Workspace fallback builds only a same-origin classic form URL for a saved record", () => {
  const factory = new Function(
    between(contentSource, "function classicFormUrlForWorkspaceRoute", "function showTranslationLensWorkspaceNotice") +
      "\nreturn classicFormUrlForWorkspaceRoute;"
  );
  const build = factory();
  const origin = "https://example.service-now.com";
  const sysId = "00000000000000000000000000000001";
  assert.strictEqual(
    build({ experiencePath: ["sow"], table: "incident", sysId }, origin),
    origin + "/incident.do?sys_id=" + sysId
  );
  assert.strictEqual(
    build({ experiencePath: ["psm", "workspace"], table: "SN_PSM_Supplier_Case", sysId: sysId.toUpperCase() }, origin),
    origin + "/sn_psm_supplier_case.do?sys_id=" + sysId
  );
  /* No route, no record, or an identifier that is not a table name: nothing
   * is opened, rather than a guessed URL. */
  assert.strictEqual(build(null, origin), "");
  assert.strictEqual(build({ table: "incident", sysId: "-1" }, origin), "");
  assert.strictEqual(build({ table: "incident", sysId: "" }, origin), "");
  assert.strictEqual(build({ table: "incident.do?x=1&y", sysId }, origin), "");
  assert.strictEqual(build({ table: "../sys_user", sysId }, origin), "");
});

test("the Workspace notice links to the classic form and navigates only on a click", () => {
  const block = between(contentSource, "function showTranslationLensWorkspaceNotice", "async function showTranslationLens");
  assert.ok(block.includes("workspaceRecordContextFromText(location.href)"));
  assert.ok(block.includes("classicFormUrlForWorkspaceRoute(route, location.origin)"));
  assert.ok(block.includes('document.createElement("a")'));
  assert.ok(block.includes("link.href = url"));
  /* The only navigation is inside the click handler, after preventDefault,
   * and it goes through the same-origin translation URL route. */
  const click = block.indexOf('addEventListener("click"');
  const prevent = block.indexOf("preventDefault()");
  const open = block.indexOf("openTranslationUrl(url)");
  assert.ok(click >= 0 && click < prevent && prevent < open);
  assert.strictEqual(block.indexOf("openTranslationUrl("), open, "no navigation outside the click handler");
  assert.ok(!block.includes("chrome.runtime.sendMessage"), "must not bypass the same-origin check");
  assert.ok(!block.includes("ensureTranslationLensLoaded"), "the notice must not load the engine");
  assert.ok(block.includes("run Translation Lens there"));
});

test("panel opens and receives progress before engine data reads", () => {
  const block = between(contentSource, "async function showTranslationLens", "/* =====================================================================\n * RECORD SEARCH");
  const open = block.indexOf("ui.open({");
  const progress = block.indexOf("ui.setProgress({");
  const run = block.indexOf("engine.run(engineContext, engine.tableGet)");
  assert.ok(open >= 0 && open < progress && progress < run);
  assert.ok(block.includes("engineContext.onProgress"));
  assert.ok(block.includes("engineContext.onSection"));
  assert.ok(block.includes("partial: true"));
});

test("a partial section is drawn only after the record is confirmed unchanged", () => {
  /* Review finding: sections used to be drawn on the run id alone, with the
   * record checked only once at the end, so a record change mid-read left
   * stale sections on screen under the error. */
  const block = between(contentSource, "async function readTranslationLens", "/* =====================================================================\n * RECORD SEARCH");
  const gate = block.indexOf("sectionGate = sectionGate.then(");
  const check = block.indexOf("translationContextStillCurrent(resolved)", gate);
  const draw = block.indexOf("partial: true", gate);
  assert.ok(gate >= 0 && check > gate && draw > check, "check before draw, inside the serialised gate");
  assert.ok(block.includes("discard: true"), "a context change discards what was drawn");
  assert.ok(block.includes("translationLensRunSequence++"), "and cancels the rest of the run");
  assert.ok(block.indexOf("await sectionGate") < block.lastIndexOf("partial: false"), "the final result waits for pending section checks");
});

test("late results are checked against run id and context fingerprint", () => {
  const block = between(contentSource, "async function showTranslationLens", "/* =====================================================================\n * RECORD SEARCH");
  assert.ok(block.includes("translationLensRunSequence"));
  assert.ok(block.includes("if (!isCurrent()) return"));
  assert.ok(block.includes("translationContextStillCurrent(resolved)"));
  /* The final result is committed only when the run is still current AND the
   * page is still the same record; a changed page goes through contextChanged,
   * which discards and cancels. */
  const finalCheck = block.lastIndexOf("translationContextStillCurrent(resolved)");
  const commit = block.lastIndexOf("partial: false");
  assert.ok(finalCheck >= 0 && finalCheck < commit);
  const tail = block.slice(finalCheck, commit);
  assert.ok(tail.includes("if (!isCurrent()) return"));
  assert.ok(tail.includes("if (!stillCurrent) {") && tail.includes("contextChanged()"));
});

test("classic label ids are marker-table matched and non-field ids are rejected", () => {
  const parse = between(contentSource, "function parseClassicLabel", "function walkRoots");
  const fields = between(contentSource, "function translationFormFields", "function translationExpectedFormIdentity");
  const factory = new Function(
    parse + fields + "\nreturn translationFormFields;"
  );
  const readFields = factory();
  const result = readFields({
    table: "example_record",
    labelIds: [
      "label.example_record.title",
      "label.example_record.bad.field",
      "label.other_record.title",
      "label.ni.example_record.related",
      "label.IO:00000000000000000000000000000001",
    ],
  });
  assert.deepStrictEqual(result.map((item) => item.field), ["title"]);
});

test("variable editor question ids are lifted from the probe's label ids and handed to the engine", () => {
  const factory = new Function(
    between(contentSource, "function translationVariableQuestionIds", "function translationExpectedFormIdentity") +
      "\nreturn translationVariableQuestionIds;"
  );
  const lift = factory();
  const a = "00000000000000000000000000000031";
  const b = "00000000000000000000000000000032";
  assert.deepStrictEqual(lift({ labelIds: [
    "label.example_record.title",
    "label.IO:" + a,
    "label.ni.IO:" + b.toUpperCase(),
    "label.IO:" + a,
    "label.IO:not-a-sys-id",
    "label.IO:",
  ] }), [a, b]);
  assert.deepStrictEqual(lift({ labelIds: [] }), []);
  assert.deepStrictEqual(lift(null), []);

  const context = between(contentSource, "function translationFormEngineContext", "function translationEngineContext");
  assert.ok(context.includes("variableQuestionIds: translationVariableQuestionIds(form)"));
  const block = between(contentSource, "async function readTranslationLens", "/* =====================================================================\n * RECORD SEARCH");
  const notice = block.indexOf("engineContext.onNotice");
  assert.ok(notice >= 0 && block.indexOf("deliver(", notice) > notice, "a notice goes through the same context gate as a section");
});

test("form value reread is constrained to expected table, identity, and frame", () => {
  const block = between(contentSource, "function translationFormEngineContext", "function translationEngineContext");
  assert.ok(block.includes("translationExpectedFormIdentity(form)"));
  assert.ok(block.includes("getFormTranslationContext(fields, expected)"));
  assert.match(block, /The form changed while Translation Lens was reading it/);
});

test("catalog candidates are corroborated through sc_cat_item and inheritance", () => {
  const block = between(contentSource, "async function corroborateCatalogTranslationContext", "async function resolveTranslationLensContext");
  assert.ok(block.includes('table: "sc_cat_item"'));
  assert.ok(block.includes('query: "sys_id="'));
  assert.ok(block.includes("engine.resolveHierarchy(itemClass, engine.tableGet)"));
  assert.ok(block.includes('hierarchy.tables.includes("sc_cat_item")'));
  assert.ok(block.includes("Accepted R1 residual limitation"));
  assert.ok(block.includes("page-owned Angular model"));
});

test("translation reads and form probes have dedicated worker routes", () => {
  assert.ok(backgroundSource.includes('msg.type === "SN_TRANSLATION_GET"'));
  assert.ok(backgroundSource.includes('msg.type === "GET_FORM_TRANSLATION_CONTEXT"'));
  assert.ok(backgroundSource.includes("translationTableGet(sender.tab.id"));
  assert.ok(backgroundSource.includes("readTranslationFormContext(sender.tab.id"));
  const transport = between(backgroundSource, "function translationTableGet", "function codeSearchApiGet");
  assert.ok(transport.includes("codeSearchFrameGet"));
  assert.ok(transport.includes("PAGE_READ_TIMEOUT_MS"));
  assert.ok(transport.includes("withTimeout"));
  assert.ok(!transport.includes("readFromPageFrames"));
});

test("panel runs have a 60-second deadline and suppress late callbacks", () => {
  const helper = between(
    contentSource,
    "const TRANSLATION_LENS_PANEL_TIMEOUT_MS",
    "function translationLensUi"
  );
  assert.ok(helper.includes("60000"));
  assert.ok(helper.includes('error.code = "translation-timeout"'));
  const block = between(contentSource, "async function showTranslationLens", "/* =====================================================================\n * RECORD SEARCH");
  assert.ok(block.includes("translationLensWithTimeout("));
  assert.ok(block.includes('error.code === "translation-timeout"'));
  assert.ok(block.includes("translationLensRunSequence++"));
});

/* This test previously pinned the opposite: that the panel was absent and had
 * not been fabricated to make the feature look finished. The panel now exists,
 * so the assertion inverts -- both files must ship and both must be injected,
 * or the palette command loads an engine with nothing to render into. */
test("engine and panel are packaged lazily and injected together", () => {
  assert.ok(packageSource.includes('"translation_lens.js"'));
  assert.ok(packageSource.includes('"translation_lens_ui.js"'));
  const injection = between(
    backgroundSource,
    'if (msg && msg.type === "INJECT_TRANSLATION_LENS"',
    'if (msg && msg.type === "INJECT_CODE_SEARCH"'
  );
  assert.ok(injection.includes('files: ["translation_lens.js", "translation_lens_ui.js"]'));
  /* Neither belongs in manifest.json: the pair is lazily injected on first use
   * of the palette command, like Code Search. */
  assert.ok(!manifestSource.includes("translation_lens"));
});

test("same-origin opening is enforced before OPEN_URL", () => {
  const block = between(contentSource, "function openTranslationUrl", "async function showTranslationLens");
  assert.ok(block.includes("target.origin !== location.origin"));
  assert.ok(block.includes('type: "OPEN_URL"'));
});

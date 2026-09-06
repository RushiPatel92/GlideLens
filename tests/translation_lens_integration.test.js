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
  const workspace = block.indexOf("workspaceRecordContextFromText(location.href)");
  const load = block.indexOf("ensureTranslationLensLoaded()");
  const resolve = block.indexOf("resolveTranslationLensContext(engine)");
  assert.ok(workspace >= 0 && workspace < load && load < resolve);

  const resolver = between(contentSource, "async function resolveTranslationLensContext", "function translationFormEngineContext");
  assert.ok(
    resolver.indexOf("workspaceRecordContextFromText(location.href)") <
      resolver.indexOf("getFormTranslationContext([], null)")
  );
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

test("late results are checked against run id and context fingerprint", () => {
  const block = between(contentSource, "async function showTranslationLens", "/* =====================================================================\n * RECORD SEARCH");
  assert.ok(block.includes("translationLensRunSequence"));
  assert.ok(block.includes("if (!isCurrent()) return"));
  assert.ok(block.includes("translationContextStillCurrent(resolved)"));
  assert.ok(block.includes("if (!isCurrent() || !stillCurrent)"));
  assert.ok(block.indexOf("translationContextStillCurrent(resolved)") < block.lastIndexOf("partial: false"));
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

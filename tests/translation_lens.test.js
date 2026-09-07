/*
 * Translation Lens engine tests. All fixtures are synthetic; no instance
 * names, record identifiers, source strings, or translations from a real
 * environment belong in this repository.
 *
 *   node --test tests/translation_lens.test.js
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadEngine(extra) {
  const file = path.join(__dirname, "..", "translation_lens.js");
  const context = Object.assign({ globalThis: null, URL, URLSearchParams }, extra || {});
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context;
}

const context = loadEngine();
const TL = context.SNTranslationLens;
const own = (value) => Array.from(value || []);
const json = (value) => JSON.parse(JSON.stringify(value));

function languages(options) {
  const opts = options || {};
  const rows = opts.rows || [
    { sys_id: "00000000000000000000000000000001", id: "en", name: "English", active: "true", fallback: "" },
    { sys_id: "00000000000000000000000000000002", id: "fr", name: "French", active: "true", fallback: "" },
    { sys_id: "00000000000000000000000000000003", id: "fr-CA", name: "French (Canada)", active: "true", fallback: "00000000000000000000000000000002" },
    { sys_id: "00000000000000000000000000000004", id: "de", name: "German", active: "true", fallback: "" },
  ];
  return TL.buildLanguageContext(
    rows,
    opts.noProperty ? [] : [{ name: "glide.sys.language", value: opts.base || "en" }],
    opts.picker
  );
}

test("engine is DOM-free, exported once, and exposes run(context, transport)", () => {
  assert.ok(TL);
  assert.strictEqual(typeof TL.run, "function");
  assert.strictEqual(typeof TL.buildNewRecordUrl, "function");
  const first = context.SNTranslationLens;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "translation_lens.js"), "utf8"), context);
  assert.strictEqual(context.SNTranslationLens, first);
});

test("engine source never requests translated-text or message content columns", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "translation_lens.js"), "utf8");
  const translatedTextBlocks = source.split('table: "sys_translated_text"').slice(1);
  translatedTextBlocks.forEach((block) => {
    const fields = block.match(/fields:\s*"([^"]+)"/);
    assert.ok(fields, "sys_translated_text request must declare bounded fields");
    assert.ok(!fields[1].split(",").includes("value"), "sys_translated_text.value must not be requested");
  });
  const messageBlocks = source.split('table: "sys_ui_message"').slice(1);
  messageBlocks.forEach((block) => {
    const fields = block.match(/fields:\s*"([^"]+)"/);
    assert.ok(fields, "sys_ui_message request must declare bounded fields");
    assert.ok(!fields[1].split(",").includes("message"), "sys_ui_message.message must not be requested");
  });
});

test("dictionary types route to their verified stores", () => {
  assert.deepStrictEqual(json(TL.routeInternalType("translated_text")), {
    applicable: true, primary: "sys_translated_text", mirror: null,
  });
  assert.deepStrictEqual(json(TL.routeInternalType("translated_html")), {
    applicable: true, primary: "sys_translated_text", mirror: null,
  });
  assert.deepStrictEqual(json(TL.routeInternalType("translated_field")), {
    applicable: true, primary: "sys_translated", mirror: "sys_translated_text",
  });
  const unknown = TL.routeInternalType("translated");
  assert.strictEqual(unknown.unverified, true);
  assert.deepStrictEqual(own(unknown.candidateStores), ["sys_translated", "sys_translated_text"]);
  assert.strictEqual(TL.routeInternalType("html").applicable, false);
  assert.strictEqual(TL.routeInternalType("string").applicable, false);
});

test("value query chunks preserve commas and equals while refusing unsafe values", () => {
  const values = Array.from({ length: 41 }, (_, index) => "value," + index + "=ok");
  values.push("value,0=ok", "bad^query", "bad\nquery", "x".repeat(256));
  const result = TL.buildValueQueryChunks("name=example^element=label", "value", values);
  assert.strictEqual(result.chunks.length, 2);
  assert.strictEqual(result.chunks[0].values.length, 40);
  assert.strictEqual(result.chunks[1].values.length, 1);
  assert.ok(result.chunks[0].query.includes("value=value,0=ok"));
  assert.ok(result.chunks.every((chunk) => chunk.query.length <= TL.MAX_QUERY_LENGTH));
  assert.deepStrictEqual(own(result.rejected).map((item) => item.reason), [
    "encoded-query-separator", "encoded-query-separator", "over-255",
  ]);
  assert.throws(() => TL.buildValueQueryChunks("", "bad^field", ["safe"]), /Unsafe field/);
});

test("a single overlong query value is refused instead of emitted", () => {
  const result = TL.buildValueQueryChunks("x=" + "a".repeat(5990), "value", ["short"]);
  assert.strictEqual(result.chunks.length, 0);
  assert.strictEqual(result.rejected[0].reason, "over-6000-query");
});

test("field chunk width derives from language count, hierarchy depth, and cap", () => {
  assert.strictEqual(TL.derivedFieldChunkSize(23, 2, 2000), 40);
  assert.strictEqual(TL.derivedFieldChunkSize(99, 5, 2000), 4);
  assert.strictEqual(TL.derivedFieldChunkSize(500, 20, 2000), 1);
});

test("hierarchy resolution queries every hop and terminates a cycle", async () => {
  const requests = [];
  const parent = { example_child: "example_parent", example_parent: "example_base", example_base: "" };
  const result = await TL.resolveHierarchy("example_child", async (request) => {
    requests.push(request.query);
    const name = request.query.slice("name=".length);
    return [{ name, "super_class.name": parent[name] }];
  });
  assert.deepStrictEqual(own(result.tables), ["example_child", "example_parent", "example_base"]);
  assert.deepStrictEqual(requests, ["name=example_child", "name=example_parent", "name=example_base"]);
  const cyclic = await TL.resolveHierarchy("example_child", async (request) => {
    const name = request.query.slice("name=".length);
    return [{ name, "super_class.name": name === "example_child" ? "example_parent" : "example_child" }];
  });
  assert.strictEqual(cyclic.cycle, true);
  assert.deepStrictEqual(own(cyclic.tables), ["example_child", "example_parent"]);
});

test("a failed hierarchy walk refuses dependent reads", async () => {
  await assert.rejects(
    () => TL.resolveHierarchy("example_child", async () => ({ ok: false, status: 403, error: "Denied" })),
    (error) => error.code === "access" && error.status === 403
  );
});

test("active languages, base, picker, extras, and English preset stay distinct", () => {
  const languageContext = languages({
    picker: ["fr"],
    rows: [
      { sys_id: "00000000000000000000000000000001", id: "en", active: "true" },
      { sys_id: "00000000000000000000000000000002", id: "en-GB", active: "true" },
      { sys_id: "00000000000000000000000000000003", id: "fr", active: "true" },
      { sys_id: "00000000000000000000000000000004", id: "xl", active: "true" },
      { sys_id: "00000000000000000000000000000005", id: "de", active: "false" },
    ],
  });
  assert.deepStrictEqual(own(languageContext.countedLanguageIds), ["en-GB", "fr", "xl"]);
  assert.deepStrictEqual(own(languageContext.visibleLanguageIds), ["fr"]);
  assert.strictEqual(languageContext.countedLanguageIds.length, 3, "picker must not narrow L");
  assert.deepStrictEqual(own(TL.englishVariantPreset(languageContext)), ["fr"]);
  const assumed = languages({ noProperty: true });
  assert.strictEqual(assumed.baseLanguage, "en");
  assert.strictEqual(assumed.assumedBase, true);
  assert.ok(TL.buildNewRecordUrl("https://example.service-now.com", "sys_ui_message", {
    key: "Example key", language: "es-MX",
  }).includes("language%3Des-MX"), "language id case must survive URL construction");
});

test("fallback resolution follows references and stops at cycles or dangling rows", () => {
  const languageContext = languages();
  const states = {
    fr: { state: "direct" },
    "fr-CA": { state: "missing" },
    de: { state: "missing" },
  };
  const resolved = TL.applyFallbacks(states, languageContext);
  assert.strictEqual(resolved["fr-CA"].state, "fallback");
  assert.strictEqual(resolved["fr-CA"].fallbackLanguage, "fr");
  assert.strictEqual(resolved.de.state, "missing");
  const cycle = Object.assign({}, languageContext, { fallbackById: { fr: "fr-CA", "fr-CA": "fr", de: "missing" } });
  const cycled = TL.applyFallbacks({ fr: { state: "missing" }, "fr-CA": { state: "missing" }, de: { state: "missing" } }, cycle);
  assert.strictEqual(cycled.fr.state, "missing");
  assert.strictEqual(cycled["fr-CA"].state, "missing");
  assert.strictEqual(cycled.de.state, "missing");
});

test("empty language denominator does not divide by zero", () => {
  const onlyBase = TL.buildLanguageContext(
    [{ sys_id: "00000000000000000000000000000001", id: "en", active: "true" }],
    [{ name: "glide.sys.language", value: "en" }]
  );
  const coverage = TL.coverageFromStates({}, onlyBase.countedLanguageIds);
  assert.deepStrictEqual(json(coverage), {
    covered: 0, counted: 0, percent: null, missing: [], unavailable: [],
  });
});

test("atom states distinguish direct, same-source, blank, conflict, and duplicate presence", () => {
  assert.strictEqual(TL.atomState([{ label: "Bonjour" }], { source: "Hello" }).state, "direct");
  assert.strictEqual(TL.atomState([{ label: "Hello" }], { source: "Hello" }).state, "same_as_source");
  const blank = TL.atomState([{ label: "" }], { source: "Hello" });
  assert.strictEqual(blank.state, "missing");
  assert.strictEqual(blank.blank, true);
  assert.strictEqual(TL.atomState([{ label: "A" }, { label: "B" }], { source: "Hello" }).state, "conflict");
  const presence = TL.atomState([{}, {}], { presenceOnly: true });
  assert.strictEqual(presence.state, "direct");
  assert.strictEqual(presence.duplicateRows, true);
});

test("a sys_translated key differing only in capitalisation covers the language", () => {
  const row = TL.analyzeStringRows({
    element: "title",
    aspect: "value",
    store: "sys_translated",
    effectiveTable: "example_record",
    source: "Base Source",
    languages: languages(),
    rows: [
      { name: "example_record", value: "Base Source", language: "fr", label: "Source FR" },
      { name: "example_record", value: "base source", language: "de", label: "Source DE" },
      { name: "example_child", value: "Base Source", language: "de", label: "Child DE" },
      { name: "example_record", value: "Base Source", language: "it", label: "Source IT" },
    ],
  });
  assert.strictEqual(row.states.fr.state, "direct");
  assert.strictEqual(row.states.fr.capitalisationVariantKey, undefined);
  /* The platform resolves the key regardless of capitalisation, so "base
   * source" covers a form spelling it "Base Source" -- marked, not a gap. */
  assert.strictEqual(row.states.de.state, "direct");
  assert.strictEqual(row.states.de.capitalisationVariantKey, true);
  assert.strictEqual(row.evidence.capitalisationVariants.rowCount, 1);
  assert.strictEqual(row.evidence.nearDuplicates.rowCount, 0);
  assert.strictEqual(row.evidence.alternateRegistrations.rowCount, 1);
  assert.deepStrictEqual(own(row.evidence.extras.languages), ["it"]);
});

test("a capitalisation-only key never covers a store whose lookup is unverified", () => {
  const row = TL.analyzeStringRows({
    element: "state",
    aspect: "value",
    store: "sys_choice",
    effectiveTable: "example_record",
    source: "Base Source",
    languages: languages(),
    rows: [
      { name: "example_record", value: "base source", language: "de", label: "Source DE" },
    ],
  });
  assert.strictEqual(row.states.de.state, "missing");
  assert.strictEqual(row.evidence.nearDuplicates.rowCount, 1);
  assert.strictEqual(row.evidence.capitalisationVariants.rowCount, 0);
});

test("a message key scanned in another capitalisation is covered by its rows", () => {
  /* A getMessage key scanned as "Supplier" against rows keyed "supplier".
   * gs.getMessage answers that key in any capitalisation -- probed on the PDI
   * -- and the read already returns the rows, so they count. */
  const row = TL.analyzeStringRows({
    element: "Supplier",
    aspect: "value",
    store: "sys_ui_message",
    keyField: "key",
    presenceOnly: true,
    source: "Supplier",
    languages: languages(),
    rows: [
      { key: "supplier", language: "fr", message: "Fournisseur" },
      { key: "supplier", language: "de", message: "Lieferant" },
    ],
  });
  assert.strictEqual(row.states.fr.state, "direct");
  assert.strictEqual(row.states.fr.capitalisationVariantKey, true);
  assert.strictEqual(row.coverage.covered, 2);
  assert.strictEqual(row.evidence.capitalisationVariants.rowCount, 2);
  assert.strictEqual(row.evidence.nearDuplicates.rowCount, 0);
});

test("a presence-only store that was never probed still reports what it refused", () => {
  /* The capitalisation check used to be skipped whenever the text column is
   * never read, which left a bare Missing beside a list button that opens the
   * rows. Reported, but not counted: this store's lookup is untested. */
  const row = TL.analyzeStringRows({
    element: "short_description",
    aspect: "value",
    store: "sys_translated_text",
    tableField: "tablename",
    keyField: "fieldname",
    effectiveTable: "example_record",
    presenceOnly: true,
    source: "short_description",
    languages: languages(),
    rows: [
      { tablename: "example_record", fieldname: "Short_Description", language: "fr", value: "x" },
    ],
  });
  assert.strictEqual(row.states.fr.state, "missing");
  assert.strictEqual(row.evidence.nearDuplicates.rowCount, 1);
  assert.strictEqual(row.evidence.capitalisationVariants.rowCount, 0);
});

test("a language covered by both spellings is not reported as a capitalisation variant", () => {
  const row = TL.analyzeStringRows({
    element: "title",
    aspect: "value",
    store: "sys_translated",
    effectiveTable: "example_record",
    source: "Base Source",
    languages: languages(),
    rows: [
      { name: "example_record", value: "Base Source", language: "de", label: "Source DE" },
      { name: "example_record", value: "base source", language: "de", label: "Source DE" },
    ],
  });
  assert.strictEqual(row.states.de.state, "direct");
  assert.strictEqual(row.states.de.capitalisationVariantKey, undefined);
  assert.strictEqual(row.states.de.duplicateCount, 1);
});

test("unavailable languages never lower a percentage", () => {
  const row = TL.analyzeStringRows({
    element: "title",
    source: "Base Source",
    languages: languages(),
    unavailable: true,
    unavailableReason: "Synthetic timeout",
  });
  assert.strictEqual(row.coverage.counted, 0);
  assert.strictEqual(row.coverage.percent, null);
  assert.deepStrictEqual(own(row.coverage.unavailable), ["fr", "fr-CA", "de"]);
});

test("an empty translated-field source is Not applicable, not Unverified", () => {
  const row = TL.analyzeStringRows({
    element: "title", source: "", effectiveTable: "example_record",
    rows: [], languages: languages(),
  });
  assert.strictEqual(row.states.fr.state, "not_applicable");
  assert.strictEqual(row.evidence.notApplicable, true);
});

test("labels use the nearest available table per language and partial includes plural and hint", () => {
  const row = TL.analyzeLabel({
    element: "summary",
    definingTable: "example_parent",
    concreteTable: "example_child",
    chain: ["example_child", "example_parent"],
    languages: languages(),
    rows: [
      { name: "example_child", element: "summary", language: "en", label: "Child summary", plural: "Child summaries", hint: "Child hint" },
      { name: "example_parent", element: "summary", language: "en", label: "Parent summary", plural: "Parent summaries", hint: "Parent hint" },
      { name: "example_parent", element: "summary", language: "fr", label: "Résumé", plural: "Résumés", hint: "Indice" },
      { name: "example_parent", element: "summary", language: "fr-CA", label: "Résumé CA", plural: "Résumés CA", hint: "" },
    ],
  });
  assert.strictEqual(row.states.fr.state, "direct");
  assert.strictEqual(row.states["fr-CA"].state, "partial");
  assert.deepStrictEqual(own(row.states["fr-CA"].missingAtoms), ["hint"]);
  assert.strictEqual(row.states.de.state, "missing");
  assert.strictEqual(row.evidence.registrationByLanguage.fr, "example_parent");
  assert.ok(row.evidence.overrides.rowCount > 0);
});

test("choice source order is redirect, concrete table, then nearest ancestor", () => {
  const chain = ["example_child", "example_parent", "example_base"];
  const rows = [
    { name: "example_parent", element: "status" },
    { name: "example_base", element: "status" },
  ];
  const inherited = TL.resolveChoiceSource({ element: "status", choice: "1" }, chain, rows);
  assert.deepStrictEqual(json(inherited), { table: "example_parent", field: "status", redirected: false });
  const concrete = TL.resolveChoiceSource({ element: "status", choice: "1" }, chain, rows.concat([{ name: "example_child", element: "status" }]));
  assert.strictEqual(concrete.table, "example_child");
  const redirected = TL.resolveChoiceSource({
    element: "status", choice: "1", choice_table: "example_shared", choice_field: "shared_status",
  }, chain, rows);
  assert.deepStrictEqual(json(redirected), { table: "example_shared", field: "shared_status", redirected: true });
  const fallbackField = TL.resolveChoiceSource({
    element: "status", choice: "1", choice_table: "example_shared", choice_field: "",
  }, chain, rows);
  assert.strictEqual(fallbackField.field, "status");
  const plainReference = TL.resolveChoiceSource({
    element: "status", choice: "", choice_table: "example_shared", choice_field: "shared_status",
  }, chain, rows);
  assert.strictEqual(plainReference.redirected, false);
  assert.strictEqual(plainReference.table, "example_parent");
});

test("native choice identity includes dependent_value, including empty", () => {
  const languageContext = languages();
  const rows = [
    { name: "example_record", element: "subcategory", value: "email", dependent_value: "inquiry", language: "en", label: "Email inquiry", inactive: "false" },
    { name: "example_record", element: "subcategory", value: "email", dependent_value: "software", language: "en", label: "Email software", inactive: "false" },
    { name: "example_record", element: "subcategory", value: "email", dependent_value: "", language: "en", label: "Email general", inactive: "false" },
    { name: "example_record", element: "subcategory", value: "email", dependent_value: "inquiry", language: "fr", label: "Courriel demande", inactive: "false" },
    { name: "example_record", element: "subcategory", value: "email", dependent_value: "", language: "fr", label: "Courriel général", inactive: "false" },
    { name: "example_record", element: "subcategory", value: "chat", dependent_value: "software", language: "fr", label: "Clavardage", inactive: "false" },
  ];
  const row = TL.analyzeChoices({
    element: "subcategory",
    source: { table: "example_record", field: "subcategory" },
    rows,
    languages: languageContext,
  });
  assert.strictEqual(row.evidence.choices.length, 3);
  const inquiry = row.evidence.choices.find((choice) => choice.dependentValue === "inquiry");
  const software = row.evidence.choices.find((choice) => choice.dependentValue === "software");
  const empty = row.evidence.choices.find((choice) => choice.dependentValue === "");
  assert.strictEqual(inquiry.states.fr.state, "direct");
  assert.strictEqual(software.states.fr.state, "missing");
  assert.strictEqual(empty.states.fr.state, "direct");
  assert.strictEqual(row.states.fr.state, "partial");
  assert.strictEqual(row.evidence.extras.rowCount, 1);
  assert.notStrictEqual(
    TL.choiceIdentity("email", "inquiry"),
    TL.choiceIdentity("email", "software")
  );
});

test("choice conflicts, inactive rows, and empty base sets retain truthful states", () => {
  const languageContext = languages();
  const conflict = TL.analyzeChoices({
    element: "state",
    source: { table: "example_record", field: "state" },
    languages: languageContext,
    rows: [
      { name: "example_record", element: "state", value: "1", dependent_value: "", language: "en", label: "Open" },
      { name: "example_record", element: "state", value: "1", dependent_value: "", language: "fr", label: "Ouvert" },
      { name: "example_record", element: "state", value: "1", dependent_value: "", language: "fr", label: "Ouverte" },
      { name: "example_record", element: "state", value: "2", dependent_value: "", language: "fr", label: "Extra", inactive: "true" },
    ],
  });
  assert.strictEqual(conflict.states.fr.state, "conflict");
  assert.strictEqual(conflict.evidence.extras.rowCount, 0);
  const none = TL.analyzeChoices({
    element: "state", source: { table: "example_record", field: "state" }, rows: [], languages: languageContext,
  });
  assert.strictEqual(none.states.fr.state, "not_applicable");
});

test("new-record and list links contain the exact store keys", () => {
  const origin = "https://example.service-now.com";
  const choiceUrl = TL.buildNewRecordUrl(origin, "sys_choice", {
    name: "example_record", element: "subcategory", value: "email",
    dependentValue: "", language: "pl",
  });
  const choiceQuery = decodeURIComponent(choiceUrl.split("sysparm_query=")[1]);
  assert.strictEqual(
    choiceQuery,
    "name=example_record^element=subcategory^value=email^dependent_value=^language=pl"
  );
  assert.ok(choiceUrl.includes("sys_id=-1"));
  assert.throws(() => TL.buildNewRecordUrl(origin, "sys_choice", {
    name: "example_record", element: "subcategory", value: "email", language: "pl",
  }), /dependent_value/);
  const stringQuery = decodeURIComponent(TL.buildNewRecordUrl(origin, "sys_translated", {
    name: "question", element: "question_text", value: "Base source", language: "pl",
  }).split("sysparm_query=")[1]);
  assert.ok(stringQuery.startsWith("name=question^"), "verified defining table must be used");
  const textQuery = decodeURIComponent(TL.buildNewRecordUrl(origin, "sys_translated_text", {
    tableName: "example_record", documentKey: "00000000000000000000000000000001",
    fieldName: "description", language: "pl",
  }).split("sysparm_query=")[1]);
  assert.ok(textQuery.includes("documentkey=00000000000000000000000000000001"));
  assert.ok(TL.buildListUrl(origin, "sys_documentation", {
    name: "example_record", element: "summary", language: "pl",
  }).includes("sys_documentation_list.do"));
  assert.throws(() => TL.buildNewRecordUrl(origin, "sys_translated", {
    name: "question", element: "question_text", value: "bad^value", language: "pl",
  }), /Unsafe encoded-query value/);
  assert.throws(() => TL.buildNewRecordUrl("https://example.invalid", "sys_ui_message", {
    key: "Example key", language: "pl",
  }), /Invalid ServiceNow origin/);
});

test("getMessage extraction handles quotes, escapes, gs prefix, dedupe, invalid, dynamic, and cap", () => {
  const extracted = TL.extractMessageKeys([
    "getMessage('Simple key'); gs.getMessage(\"Double key\");",
    "getMessage('It\\'s ready'); getMessage('Simple key');",
    "getMessage(dynamicKey); getMessage(`template`); getMessage('joined' + suffix);",
    "object.getMessage('ignore me'); getMessage('bad^key');",
  ], 2);
  assert.deepStrictEqual(own(extracted.keys), ["Simple key", "Double key"]);
  assert.strictEqual(extracted.dynamicCount, 3);
  assert.strictEqual(extracted.invalid.length, 1);
  assert.strictEqual(extracted.capped, true);
  assert.strictEqual(extracted.omittedCount, 1);
});

test("scanned messages have a separate denominator from the form headline", () => {
  const languageContext = languages();
  const messageRows = TL.analyzeMessages(["Example key"], [
    { key: "Example key", language: "fr", application: "" },
    { key: "Example key", language: "fr", application: "" },
  ], languageContext);
  const fieldRow = TL.analyzeStringRows({
    element: "title", source: "Base", effectiveTable: "example_record",
    rows: [{ name: "example_record", value: "Base", language: "fr", label: "Titre" }],
    languages: languageContext,
  });
  const result = TL.summarizeResult({
    sections: [
      { id: "values", rows: [fieldRow] },
      { id: "messages", rows: messageRows, separateHeadline: true },
    ],
  });
  assert.strictEqual(result.summary.covered, 1);
  assert.strictEqual(result.messageSummary.covered, 1);
  assert.strictEqual(messageRows[0].states.fr.duplicateRows, true);
});

test("analyzeMessages keeps the rows the read returned for another capitalisation", () => {
  /* Regression: this grouping filter compared the key exactly, so the rows a
   * capitalisation-insensitive read had just returned were thrown away one
   * step before anything could count them. The store-level rule was correct
   * and unreachable, and the panel reported 0/2 beside a list button that
   * opened every one of the discarded rows. */
  const rows = [
    { key: "supplier", language: "fr", application: "" },
    { key: "supplier", language: "de", application: "" },
    { key: "unrelated", language: "fr", application: "" },
  ];
  const analysed = TL.analyzeMessages(["Supplier"], rows, languages(), null, "");
  assert.strictEqual(analysed.length, 1);
  assert.strictEqual(analysed[0].coverage.covered, 2);
  assert.strictEqual(analysed[0].states.fr.state, "direct");
  assert.strictEqual(analysed[0].states.fr.capitalisationVariantKey, true);
  assert.strictEqual(analysed[0].evidence.capitalisationVariants.rowCount, 2,
    "the unrelated key is still not this row's");
});

test("manual message lookup uses the same safe, presence-only pipeline", async () => {
  const languageContext = languages();
  const requests = [];
  const found = await TL.lookupMessage("Example Key", languageContext, async (request) => {
    requests.push(request);
    return [
      { key: "example key", language: "fr", application: "" },
      { key: "Example Key", language: "fr", application: "" },
    ];
  });
  assert.strictEqual(found.ok, true);
  assert.strictEqual(found.row.states.fr.state, "direct");
  /* Both rows answer getMessage for this key, so French really is served by
   * two rows and the platform picks between them. That is a duplicate worth
   * reporting, not a row to discard for spelling the key differently. */
  assert.strictEqual(found.row.states.fr.duplicateRows, true);
  assert.strictEqual(found.row.evidence.capitalisationVariants.rowCount, 1);
  assert.strictEqual(requests[0].query, "messageISNOTEMPTY^key=Example Key");
  assert.ok(!requests[0].fields.split(",").includes("message"));
  let called = false;
  const invalid = await TL.lookupMessage("bad^key", languageContext, async () => {
    called = true;
    return [];
  });
  assert.strictEqual(called, false);
  assert.strictEqual(invalid.row.states.fr.state, "unverified");
});

test("plain-text report includes keys and states but excludes sources, translations, host, URL, and sys_id", () => {
  const languageContext = languages();
  const fieldRow = TL.analyzeStringRows({
    element: "summary", aspect: "value", source: "DO_NOT_COPY_SOURCE",
    effectiveTable: "example_record",
    rows: [{ name: "example_record", value: "DO_NOT_COPY_SOURCE", language: "fr", label: "DO_NOT_COPY_TRANSLATION" }],
    languages: languageContext,
  });
  /* A technical key survives verbatim; anything that is not a bare
   * identifier does not -- see the test below. */
  const message = TL.analyzeMessages(["example_message_key"], [], languageContext)[0];
  const result = TL.summarizeResult({
    context: { mode: "form", table: "example_record", sysId: "00000000000000000000000000000001", origin: "https://secret.service-now.com" },
    languages: languageContext,
    sections: [
      { id: "values", label: "Values", rows: [fieldRow] },
      { id: "messages", label: "Messages", rows: [message] },
    ],
    failures: [],
  });
  const report = TL.formatResultsAsText(result);
  assert.ok(report.includes("summary [value]"));
  assert.ok(report.includes("example_message_key"));
  assert.ok(report.includes("missing="));
  assert.ok(!report.includes("DO_NOT_COPY_SOURCE"));
  assert.ok(!report.includes("DO_NOT_COPY_TRANSLATION"));
  assert.ok(!report.includes("secret.service-now.com"));
  assert.ok(!report.includes("00000000000000000000000000000001"));
  assert.ok(!report.includes("https://"));
});

test("a report replaces any element that is not a bare technical name", () => {
  const languageContext = languages();
  /* Both vectors are real. A getMessage key is whatever the calling script
   * passed -- a URL, or a whole sentence of instance text. And an unnamed
   * catalog variable's element is its own sys_id, because runCatalog falls
   * back to the id when name is empty. Neither may reach a report that is
   * meant to be handed to someone who was never on the instance. */
  const urlKey = TL.analyzeMessages(
    ["https://secret.service-now.com/nav_to.do"], [], languageContext)[0];
  const sentenceKey = TL.analyzeMessages(
    ["Please contact the service desk"], [], languageContext)[0];
  /* Two more vectors from review: a key that is a bare hostname satisfies a
   * dots-and-hyphens allowlist, and a key with a sys_id embedded in it is
   * not "entirely a sys_id". Neither may pass. A plain key still does. */
  const hostKey = TL.analyzeMessages(
    ["example.service-now.com"], [], languageContext)[0];
  const embeddedKey = TL.analyzeMessages(
    ["key.00000000000000000000000000000009"], [], languageContext)[0];
  const plainKey = TL.analyzeMessages(
    ["invalid_email"], [], languageContext)[0];
  const unnamedVariable = TL.analyzeStringRows({
    element: "0123456789abcdef0123456789abcdef",
    aspect: "source",
    source: "Example question text",
    effectiveTable: "question",
    rows: [],
    languages: languageContext,
  });
  const result = TL.summarizeResult({
    context: { mode: "catalog", table: "sc_cat_item" },
    languages: languageContext,
    sections: [
      { id: "values", label: "Catalog Text", rows: [unnamedVariable] },
      { id: "messages", label: "Messages", rows: [urlKey, sentenceKey, hostKey, embeddedKey, plainKey] },
    ],
    failures: [],
  });
  const report = TL.formatResultsAsText(result);

  assert.ok(!report.includes("https://"), "a URL-shaped key must not reach the report");
  assert.ok(!report.includes("secret.service-now.com"), "nor the host inside it");
  assert.ok(!report.includes("Please contact"), "nor a sentence-shaped key");
  assert.ok(!report.includes("0123456789abcdef0123456789abcdef"),
    "nor an unnamed variable's sys_id");
  assert.ok(!report.includes("service-now.com"), "nor a key that is a bare hostname");
  assert.ok(!report.includes("00000000000000000000000000000009"), "nor a sys_id embedded in a key");

  /* Replaced by position, so a reader can still line each line up against the
   * panel on screen rather than losing the row entirely. */
  assert.ok(report.includes("message #1"), "the first message is positional: " + report);
  assert.ok(report.includes("message #2"), "and so is the second");
  assert.ok(report.includes("message #3"), "and the hostname-shaped one");
  assert.ok(report.includes("message #4"), "and the one with an embedded id");
  assert.ok(report.includes("invalid_email"), "a plain key is the payload and survives");
  assert.ok(report.includes("source #1"), "and so is the unnamed variable");
});

test("a failed choice translation read is unavailable, never a missing translation", async () => {
  /* The choice DEFINITIONS read cleanly here; only the sys_translated chunk
   * carrying their text is denied. Before this was propagated, the row scored
   * the choice as an untranslated gap -- a failed read counted as coverage,
   * which is the one thing this panel must never do. */
  const itemId = "00000000000000000000000000000010";
  const variableId = "00000000000000000000000000000011";
  const choiceId = "00000000000000000000000000000012";
  const transport = async (request) => {
    if (request.table === "sys_language") return [
      { sys_id: "00000000000000000000000000000001", id: "en", active: "true" },
      { sys_id: "00000000000000000000000000000002", id: "fr", active: "true" },
    ];
    if (request.table === "sys_properties") return [{ name: "glide.sys.language", value: "en" }];
    if (request.table === "sc_cat_item") return [{
      sys_id: itemId, sys_class_name: "sc_cat_item", name: "Example item",
      short_description: "", description: "",
    }];
    if (request.table === "sys_db_object") return [{ name: "sc_cat_item", "super_class.name": "" }];
    if (request.table === "io_set_item") return [];
    if (request.table === "item_option_new_set") return [];
    if (request.table === "item_option_new") return [{
      sys_id: variableId, name: "example_topic", question_text: "Example topic",
      type: "5", active: "true", variable_set: "",
    }];
    if (request.table === "question_choice") return [{
      sys_id: choiceId, question: variableId, text: "Choice A", value: "a", inactive: "false",
    }];
    if (request.table === "sys_translated") {
      if (request.query.includes("element=text")) {
        return { ok: false, status: 403, error: "Denied" };
      }
      return [];
    }
    if (request.table === "sys_translated_text") return [];
    if (request.table === "sys_ui_message") return [];
    return [];
  };

  const result = await TL.run({
    mode: "catalog", table: "sc_cat_item", catalogItemSysId: itemId, sysId: itemId,
  }, transport);

  const choices = result.sections.find((section) => section.id === "choices");
  assert.ok(choices && choices.rows.length, "the choices section still has its row");
  const row = choices.rows[0];
  assert.strictEqual(row.states.fr.state, "unavailable",
    "an unread translation is unknown, not missing");
  assert.strictEqual(row.coverage.counted, 0, "and it is kept out of the denominator");
  assert.ok(row.evidence.unavailable, "the row says the read did not complete");

  /* The question_text chunk read fine, so it must not be dragged down with it. */
  const values = result.sections.find((section) => section.id === "values");
  const question = (values.rows || []).find((entry) => entry.aspect === "source");
  assert.ok(question, "the question text row still exists");
  assert.notStrictEqual(question.states.fr.state, "unavailable",
    "a healthy chunk is unaffected by a failure in another");
});

function formTransport(options) {
  const opts = options || {};
  const requests = [];
  const transport = async (request) => {
    requests.push(request);
    if (request.table === "sys_language") return [
      { sys_id: "00000000000000000000000000000001", id: "en", name: "English", active: "true", fallback: "" },
      { sys_id: "00000000000000000000000000000002", id: "fr", name: "French", active: "true", fallback: "" },
    ];
    if (request.table === "sys_properties") return [{ name: "glide.sys.language", value: "en" }];
    if (request.table === "sys_db_object") {
      const name = request.query.slice("name=".length);
      return [{ name, "super_class.name": name === "example_child" ? "example_parent" : "" }];
    }
    if (request.table === "sys_dictionary") return [
      { name: "example_parent", element: "title", internal_type: "translated_field", choice: "" },
      { name: "example_parent", element: "description", internal_type: "translated_text", choice: "" },
      { name: "example_parent", element: "state", internal_type: "string", choice: "1" },
      { name: "example_parent", element: "plain", internal_type: "string", choice: "" },
    ];
    if (request.table === "sys_documentation") return [
      { name: "example_parent", element: "title", language: "en", label: "Title" },
      { name: "example_parent", element: "title", language: "fr", label: "Titre" },
      { name: "example_parent", element: "description", language: "en", label: "Description" },
      { name: "example_parent", element: "state", language: "en", label: "State" },
      { name: "example_parent", element: "plain", language: "en", label: "Plain" },
    ];
    if (request.table === "sys_choice") return [
      { name: "example_parent", element: "state", value: "1", dependent_value: "", language: "en", label: "Open", inactive: "false" },
      { name: "example_parent", element: "state", value: "1", dependent_value: "", language: "fr", label: "Ouvert", inactive: "false" },
    ];
    if (request.table === "sys_translated") return [
      { name: "example_parent", element: "title", value: "Base title", language: "fr", label: "Titre de base" },
      { name: "example_child", element: "title", value: "Base title", language: "de", label: "Alternative" },
    ];
    if (request.table === "sys_translated_text") return [
      { tablename: "example_child", documentkey: "00000000000000000000000000000009", fieldname: "title", language: "de" },
      { tablename: "example_child", documentkey: "00000000000000000000000000000009", fieldname: "description", language: "fr" },
    ];
    if (request.table === "sys_script_client") return [{ script: "getMessage('Example key')" }];
    if (request.table === "sys_ui_policy") return [];
    if (request.table === "sys_ui_message") return [{ key: "Example key", language: "fr", application: "" }];
    throw new Error("Unexpected table " + request.table);
  };
  return { transport, requests };
}

test("form run uses verified defining registration and keeps translated-field mirrors stranded", async () => {
  const fixture = formTransport();
  let requestedValueFields = null;
  const result = await TL.run({
    mode: "form",
    surface: "classic",
    table: "example_child",
    sysId: "00000000000000000000000000000009",
    fields: ["title", "description", "state", "plain"],
    loadValues: async (fields) => {
      requestedValueFields = fields;
      return { values: { title: "Base title" } };
    },
  }, fixture.transport);
  const values = result.sections.find((section) => section.id === "values").rows;
  const title = values.find((row) => row.element === "title");
  const description = values.find((row) => row.element === "description");
  const plain = values.find((row) => row.element === "plain");
  assert.strictEqual(title.registrationTable, "example_parent");
  assert.strictEqual(title.states.fr.state, "direct");
  assert.strictEqual(title.evidence.alternateRegistrations.rowCount, 1);
  assert.strictEqual(title.evidence.stranded.rowCount, 1);
  assert.strictEqual(description.states.fr.state, "direct");
  /* A field whose type cannot hold a translation gets no value row at all;
   * a section of Not applicable rows said nothing a reader could act on. */
  assert.strictEqual(plain, undefined, "a plain string field has no value row");
  assert.ok(!values.some((row) => row.element === "state"), "nor does a choice-typed string");
  assert.strictEqual(result.sections.find((section) => section.id === "values").note, "",
    "a populated section carries no explanatory note");
  const choices = result.sections.find((section) => section.id === "choices").rows;
  assert.strictEqual(choices[0].registrationTable, "example_parent");
  assert.strictEqual(choices[0].states.fr.state, "direct");
  const messages = result.sections.find((section) => section.id === "messages");
  assert.strictEqual(messages.separateHeadline, true);
  assert.strictEqual(messages.rows[0].states.fr.state, "direct");
  assert.deepStrictEqual(own(requestedValueFields), ["title"]);
  const textRequest = fixture.requests.find((request) => request.table === "sys_translated_text");
  assert.ok(textRequest.query.includes("fieldnameINtitle,description"), "translated_field mirror must be queried in Form mode");
  assert.ok(textRequest.query.startsWith("valueISNOTEMPTY^"));
  const messageRequest = fixture.requests.find((request) => request.table === "sys_ui_message");
  assert.ok(messageRequest.query.startsWith("messageISNOTEMPTY^"));
  assert.ok(!messageRequest.fields.split(",").includes("message"));
});

test("a form with no translatable value type gets an empty, explained Field Values section", async () => {
  /* Owner finding on a customer case form: every field showed as Not
   * applicable under a section nobody could name. The section is now empty
   * and says why, rather than listing what is not there. */
  const fixture = formTransport();
  const result = await TL.run({
    mode: "form",
    table: "example_child",
    sysId: "00000000000000000000000000000009",
    fields: ["state", "plain"],
    loadValues: async () => ({ values: {} }),
  }, fixture.transport);
  const values = result.sections.find((section) => section.id === "values");
  assert.strictEqual(values.label, "Field Values");
  assert.deepStrictEqual(Array.from(values.rows), []);
  assert.match(values.note, /No field on this form has a value type that can hold a translation/);
  assert.match(values.note, /translated_field, translated_text or translated_html/);
  assert.ok(!fixture.requests.some((request) => request.table === "sys_translated"),
    "nothing string-keyed was read for a form with nothing to read");
});

test("a catalog choices row links to the list of its choice translations", async () => {
  /* Owner finding on a customer record producer: the choices row had no
   * "open the matching rows" link, although each chip did. The row now links
   * to every sys_translated row for its choice texts, in the same ORed shape
   * the read used, so the list opened is the list that was counted. */
  const fixture = catalogTransport({ choiceText: "Choice A" });
  const result = await TL.run({
    mode: "catalog", table: "sc_cat_item", catalogItemSysId: fixture.itemId, sysId: fixture.itemId,
    origin: "https://example.service-now.com",
  }, fixture.transport);
  const row = result.sections.find((section) => section.id === "choices").rows[0];
  assert.ok(row.links && row.links.list, "the row has a list link");
  assert.ok(row.links.list.startsWith("https://example.service-now.com/sys_translated_list.do?sysparm_query="));
  const query = decodeURIComponent(row.links.list.split("sysparm_query=")[1]);
  assert.strictEqual(query, "name=question_choice^element=text^value=Choice A");
  assert.deepStrictEqual(Object.keys(row.links.newRecord), [], "the row itself offers no prefill; the chips do");

  /* A text the query language cannot express is out of the link as it is out
   * of the count; with no expressible text there is no link at all. */
  const unsafe = catalogTransport({ choiceText: "Choice^A" });
  const unsafeResult = await TL.run({
    mode: "catalog", table: "sc_cat_item", catalogItemSysId: unsafe.itemId, sysId: unsafe.itemId,
    origin: "https://example.service-now.com",
  }, unsafe.transport);
  assert.strictEqual(unsafeResult.sections.find((section) => section.id === "choices").rows[0].links, null);
});

test("a form with a variable editor gets a notice naming what was not checked, linked to the definition", async () => {
  /* Owner finding on a customer case raised through a record producer: the
   * classic form carries a variable editor whose variables a form run never
   * checks, and nothing said so. The editor's label ids carry the question
   * ids; one bounded read resolves the owning item for the link. */
  const producerId = "00000000000000000000000000000030";
  const questionA = "00000000000000000000000000000031";
  const questionB = "00000000000000000000000000000032";
  const fixture = formTransport();
  const events = [];
  const transport = async (request) => {
    if (request.table === "item_option_new") {
      assert.ok(request.query.startsWith("sys_idIN"), "questions are read by id");
      return [
        { sys_id: questionA, cat_item: producerId, variable_set: "" },
        { sys_id: questionB, cat_item: "", variable_set: "00000000000000000000000000000033" },
      ];
    }
    if (request.table === "sc_cat_item") {
      assert.ok(request.query.includes(producerId));
      return [{ sys_id: producerId, sys_class_name: "sc_cat_item_producer" }];
    }
    return fixture.transport(request);
  };
  const result = await TL.run({
    mode: "form",
    table: "example_child",
    sysId: "00000000000000000000000000000009",
    fields: ["title", "state"],
    variableQuestionIds: [questionA, questionB.toUpperCase(), questionA, "not-a-sys-id"],
    loadValues: async () => ({ values: { title: "Base title" } }),
    origin: "https://example.service-now.com",
    onNotice: (notice) => events.push("notice:" + notice.id),
    onSection: (section) => events.push("section:" + section.id),
  }, transport);
  assert.strictEqual(result.notices.length, 1);
  const notice = result.notices[0];
  assert.strictEqual(notice.id, "variable-editor");
  assert.strictEqual(notice.count, 2, "deduplicated, case-folded, invalid ids dropped");
  assert.match(notice.text, /variable editor with 2 catalog variables that this run does not check/);
  assert.match(notice.text, /open its definition form and run Translation Lens there, or run it on the item in the Service Portal/);
  assert.deepStrictEqual(Array.from(notice.links, (link) => link.label), ["Open the record producer definition"]);
  assert.strictEqual(notice.links[0].url, "https://example.service-now.com/sc_cat_item_producer.do?sys_id=" + producerId);
  assert.strictEqual(events[0], "notice:variable-editor", "the notice is handed over before any section");
  assert.ok(TL.formatResultsAsText(result).includes("Note: This form has a variable editor with 2 catalog variables"));
  assert.ok(!TL.formatResultsAsText(result).includes(producerId), "the report carries the note, never the link");
});

test("a form without a variable editor gets no notice and makes no extra read", async () => {
  const fixture = formTransport();
  const result = await TL.run({
    mode: "form",
    table: "example_child",
    sysId: "00000000000000000000000000000009",
    fields: ["title"],
    loadValues: async () => ({ values: { title: "Base title" } }),
  }, fixture.transport);
  assert.deepStrictEqual(Array.from(result.notices), []);
  assert.ok(!fixture.requests.some((request) => request.table === "item_option_new" || request.table === "sc_cat_item"));
  assert.ok(!TL.formatResultsAsText(result).includes("Note:"));
});

test("a variable editor whose item cannot be resolved still gets the notice, without a link", async () => {
  const fixture = formTransport();
  const transport = async (request) => {
    if (request.table === "item_option_new") return [{ sys_id: "00000000000000000000000000000031", cat_item: "", variable_set: "00000000000000000000000000000033" }];
    if (request.table === "sc_cat_item") throw new Error("must not be read with no item id");
    return fixture.transport(request);
  };
  const result = await TL.run({
    mode: "form",
    table: "example_child",
    sysId: "00000000000000000000000000000009",
    fields: ["title"],
    variableQuestionIds: ["00000000000000000000000000000031"],
    loadValues: async () => ({ values: { title: "Base title" } }),
    origin: "https://example.service-now.com",
  }, transport);
  const notice = result.notices[0];
  assert.ok(notice);
  assert.deepStrictEqual(Array.from(notice.links), []);
  assert.match(notice.text, /could not be resolved from the variables on this form/);
});

test("new form skips all per-record translation reads even with a preallocated identity", async () => {
  const fixture = formTransport();
  const result = await TL.run({
    mode: "form",
    table: "example_child",
    sysId: "00000000000000000000000000000009",
    isNewRecord: true,
    fields: ["title", "description"],
    values: { title: "Unsaved source" },
  }, fixture.transport);
  assert.ok(!fixture.requests.some((request) =>
    request.table === "sys_translated" || request.table === "sys_translated_text"
  ));
  const rows = result.sections.find((section) => section.id === "values").rows;
  assert.ok(rows.every((row) => row.evidence.skippedForNewRecord));
  assert.ok(rows.every((row) => row.states.fr.state === "not_applicable"));
});

test("a failed store leaves independent sections rendered", async () => {
  const fixture = formTransport();
  const wrapped = async (request) => {
    if (request.table === "sys_translated") return { ok: false, status: 403, error: "Denied" };
    return fixture.transport(request);
  };
  const result = await TL.run({
    mode: "form",
    table: "example_child",
    sysId: "00000000000000000000000000000009",
    fields: ["title", "description"],
    values: { title: "Base title" },
  }, wrapped);
  const rows = result.sections.find((section) => section.id === "values").rows;
  assert.strictEqual(rows.find((row) => row.element === "title").states.fr.state, "unavailable");
  assert.strictEqual(rows.find((row) => row.element === "description").states.fr.state, "direct");
  assert.ok(result.failures.some((failure) => failure.table === "sys_translated" && failure.status === 403));
});

test("a truncated chunk marks only its targets unavailable", async () => {
  const failures = [];
  const requests = [
    { table: "sys_documentation", limit: 10, targets: ["first"] },
    { table: "sys_documentation", limit: 10, targets: ["second"] },
  ];
  let call = 0;
  const result = await TL.readChunked(async () => {
    call++;
    return call === 1
      ? { ok: true, result: [{ id: "one" }], truncated: true }
      : { ok: true, result: [{ id: "two" }] };
  }, requests, "sys_documentation", failures, 10);
  assert.strictEqual(result.unavailableTargets.has("first"), true);
  assert.strictEqual(result.unavailableTargets.has("second"), false);
  assert.strictEqual(result.rows.length, 2);
  assert.strictEqual(failures.length, 1);
  assert.strictEqual(failures[0].truncated, true);
});

test("catalog run counts defining-table strings, record-keyed text, choices, and item text", async () => {
  const itemId = "00000000000000000000000000000010";
  const variableId = "00000000000000000000000000000011";
  const choiceId = "00000000000000000000000000000012";
  const setId = "00000000000000000000000000000013";
  const requests = [];
  const transport = async (request) => {
    requests.push(request);
    if (request.table === "sys_language") return [
      { sys_id: "00000000000000000000000000000001", id: "en", active: "true" },
      { sys_id: "00000000000000000000000000000002", id: "fr", active: "true" },
    ];
    if (request.table === "sys_properties") return [{ name: "glide.sys.language", value: "en" }];
    if (request.table === "sc_cat_item") return [{
      sys_id: itemId, sys_class_name: "sc_cat_item", name: "Example item",
      short_description: "Example short description", description: "Example description",
    }];
    if (request.table === "sys_db_object") return [{ name: "sc_cat_item", "super_class.name": "" }];
    if (request.table === "io_set_item") return [{ variable_set: setId, order: "100" }];
    if (request.table === "item_option_new_set") return [{
      sys_id: setId, title: "Example set", type: "one_to_one", active: "true", order: "100",
    }];
    if (request.table === "item_option_new") return [{
      sys_id: variableId, name: "example_topic", question_text: "Example topic",
      help_text: "Example help", type: "5", active: "true", variable_set: "",
    }];
    if (request.table === "question_choice") return [{
      sys_id: choiceId, question: variableId, text: "Choice A", value: "a", inactive: "false",
    }];
    if (request.table === "sys_translated") {
      if (request.query.includes("element=question_text")) return [
        { name: "question", element: "question_text", value: "Example topic", language: "fr", label: "Sujet exemple" },
        { name: "item_option_new", element: "question_text", value: "Example topic", language: "de", label: "Alternative" },
      ];
      if (request.query.includes("element=text")) return [
        { name: "question_choice", element: "text", value: "Choice A", language: "fr", label: "Choix A" },
      ];
      if (request.query.includes("element=title")) return [
        { name: "item_option_new_set", element: "title", value: "Example set", language: "fr", label: "Ensemble exemple" },
      ];
      return [];
    }
    if (request.table === "sys_translated_text") {
      assert.ok(!request.fields.split(",").includes("value"), "translation content must not be requested");
      if (request.query.includes("tablenameINquestion,item_option_new")) return [
        { tablename: "item_option_new", documentkey: variableId, fieldname: "question_text", language: "de" },
        { tablename: "item_option_new", documentkey: variableId, fieldname: "help_text", language: "fr" },
      ];
      if (request.query.includes("tablename=question_choice")) return [
        { tablename: "question_choice", documentkey: choiceId, fieldname: "text", language: "de" },
      ];
      if (request.query.includes("documentkey=" + itemId)) return [
        { tablename: "sc_cat_item", documentkey: itemId, fieldname: "name", language: "fr" },
      ];
      return [];
    }
    if (request.table === "catalog_script_client" || request.table === "catalog_ui_policy") return [];
    throw new Error("Unexpected table " + request.table);
  };
  const result = await TL.run({
    mode: "catalog", table: "sc_cat_item", catalogItemSysId: itemId,
  }, transport);
  const values = result.sections.find((section) => section.id === "values").rows;
  const source = values.find((row) => row.element === "example_topic" && row.aspect === "source");
  const help = values.find((row) => row.element === "example_topic" && row.aspect === "help_text");
  const itemName = values.find((row) => row.element === "catalog_item" && row.aspect === "name");
  assert.strictEqual(source.registrationTable, "question");
  assert.strictEqual(source.states.fr.state, "direct");
  assert.strictEqual(source.evidence.alternateRegistrations.rowCount, 1);
  assert.strictEqual(source.evidence.stranded.rowCount, 1);
  assert.strictEqual(help.states.fr.state, "direct");
  assert.strictEqual(itemName.states.fr.state, "direct");
  const setTitle = values.find((row) => row.element === "variable_set_1" && row.aspect === "set title");
  assert.strictEqual(setTitle.states.fr.state, "direct");
  const choice = result.sections.find((section) => section.id === "choices").rows[0];
  assert.strictEqual(choice.states.fr.state, "direct");
  assert.ok(requests.some((request) => request.table === "question_choice" && request.query === "questionIN" + variableId));
});

test("default browser transport propagates HTTP status and error category", async () => {
  const engineContext = loadEngine({
    chrome: { runtime: { sendMessage: async () => ({ ok: false, status: 403, error: "Denied" }) } },
  });
  await assert.rejects(
    () => engineContext.SNTranslationLens.resolveHierarchy("example_record"),
    (error) => error.code === "access" && error.status === 403
  );
});

test("row links name the key across languages and prefill only the missing ones", () => {
  const origin = "https://example.service-now.com";
  const languageContext = languages();
  const label = TL.analyzeLabel({
    element: "summary",
    chain: ["example_record"],
    definingTable: "example_record",
    languages: languageContext,
    origin,
    linkKey: { name: "example_record", element: "summary" },
    rows: [
      { name: "example_record", element: "summary", language: "en", label: "Summary" },
      { name: "example_record", element: "summary", language: "fr", label: "Résumé" },
    ],
  });
  const listQuery = decodeURIComponent(label.links.list.split("sysparm_query=")[1]);
  assert.strictEqual(
    listQuery, "name=example_record^element=summary",
    "a row lists every language for its key, so it carries no language clause"
  );
  assert.ok(label.links.list.includes("sys_documentation_list.do"));
  assert.ok(!label.links.newRecord.fr, "a covered language is offered no prefill");
  const missingQuery = decodeURIComponent(label.links.newRecord.de.split("sysparm_query=")[1]);
  assert.strictEqual(missingQuery, "name=example_record^element=summary^language=de");
  assert.ok(label.links.newRecord.de.includes("sys_id=-1"));
  /* fr-CA falls back to fr, and a fallback is not a gap to create a row for. */
  assert.ok(!label.links.newRecord["fr-CA"]);
});

test("a blank language is linked to its existing rows, never to a new record", () => {
  /* Review finding: a blank row already exists for that key and language, so
   * a prefilled new record would sit beside it as a duplicate and never repair
   * it. The link for a Blank chip is the list of the rows that are there. */
  const origin = "https://example.service-now.com";
  const row = TL.analyzeStringRows({
    element: "cost_centre",
    aspect: "source",
    store: "sys_translated",
    effectiveTable: "question",
    source: "Cost centre",
    languages: languages(),
    origin,
    linkKey: { name: "question", element: "question_text", value: "Cost centre" },
    rows: [
      { name: "question", element: "question_text", value: "Cost centre", label: "", language: "de" },
    ],
  });
  assert.strictEqual(row.states.de.state, "missing");
  assert.strictEqual(row.states.de.blank, true);
  assert.ok(!row.links.newRecord.de, "no prefilled new record for a blank language");
  const existingQuery = decodeURIComponent(row.links.existing.de.split("sysparm_query=")[1]);
  assert.strictEqual(existingQuery, "name=question^element=question_text^value=Cost centre^language=de");
  assert.ok(row.links.existing.de.includes("sys_translated_list.do"), "it is a list, not a form");
  /* A genuinely missing language keeps its prefill and gets no existing link. */
  assert.ok(row.links.newRecord.fr && row.links.newRecord.fr.includes("sys_id=-1"));
  assert.ok(!row.links.existing.fr);
});

test("a native choice whose key cannot be queried is unverified and excluded, not a missing gap", () => {
  /* Review finding: an unsafe value scored as Missing, counted 0/1, with no
   * usable link. It cannot be listed, prefilled, or matched with confidence,
   * so it is Unverified and stays out of the denominator. */
  const languageContext = languages();
  const row = TL.analyzeChoices({
    element: "state",
    source: { table: "example_record", field: "state" },
    languages: languageContext,
    origin: "https://example.service-now.com",
    rows: [
      { name: "example_record", element: "state", value: "unsafe^value", dependent_value: "", language: "en", label: "Unsafe", inactive: "false" },
      { name: "example_record", element: "state", value: "safe", dependent_value: "", language: "en", label: "Safe", inactive: "false" },
      { name: "example_record", element: "state", value: "safe", dependent_value: "", language: "fr", label: "Sûr", inactive: "false" },
    ],
  });
  const unsafe = row.evidence.choices.find((choice) => choice.value === "unsafe^value");
  const safe = row.evidence.choices.find((choice) => choice.value === "safe");
  assert.strictEqual(unsafe.states.fr.state, "unverified");
  assert.strictEqual(unsafe.coverage.counted, 0, "excluded from its own denominator");
  assert.strictEqual(unsafe.links, null, "no half-built link");
  assert.strictEqual(safe.states.fr.state, "direct", "the expressible choice is unaffected");
  assert.strictEqual(row.states.fr.state, "unverified", "one unknown choice makes the row's verdict unknown");
  assert.strictEqual(row.coverage.counted, 0);

  /* A dependent_value the query language cannot express is the same case. */
  const dependent = TL.analyzeChoices({
    element: "state",
    source: { table: "example_record", field: "state" },
    languages: languageContext,
    rows: [
      { name: "example_record", element: "state", value: "a", dependent_value: "x\ny", language: "en", label: "A", inactive: "false" },
    ],
  });
  assert.strictEqual(dependent.evidence.choices[0].states.fr.state, "unverified");
});

function catalogTransport(options) {
  /* A catalog item with an optional list of attached variable sets and one
   * static-choice variable. `answer` lets a test override any table. */
  const opts = options || {};
  const itemId = "00000000000000000000000000000010";
  const variableId = "00000000000000000000000000000011";
  const choiceId = "00000000000000000000000000000012";
  const setIds = opts.setIds || [];
  const requests = [];
  const transport = async (request) => {
    requests.push(request);
    if (opts.answer) {
      const answered = opts.answer(request);
      if (answered !== undefined) return answered;
    }
    if (request.table === "sys_language") return [
      { sys_id: "00000000000000000000000000000001", id: "en", active: "true" },
      { sys_id: "00000000000000000000000000000002", id: "fr", active: "true" },
    ];
    if (request.table === "sys_properties") return [{ name: "glide.sys.language", value: "en" }];
    if (request.table === "sc_cat_item") return [{
      sys_id: itemId, sys_class_name: "sc_cat_item", name: "Example item",
      short_description: "", description: "",
    }];
    if (request.table === "sys_db_object") return [{ name: "sc_cat_item", "super_class.name": "" }];
    if (request.table === "io_set_item") return setIds.map((id, index) => ({ variable_set: id, order: String(index) }));
    if (request.table === "item_option_new_set") {
      return setIds.filter((id) => request.query.includes(id)).map((id, index) => ({
        sys_id: id, title: "Set " + (index + 1), type: "one_to_one", active: "true", order: "100",
      }));
    }
    if (request.table === "item_option_new") {
      return request.query.startsWith("cat_item=") ? [{
        sys_id: variableId, name: "example_topic", question_text: "Example topic",
        type: "5", active: "true", variable_set: "",
      }] : [];
    }
    if (request.table === "question_choice") return [{
      sys_id: choiceId, question: variableId, text: opts.choiceText || "Choice A", value: "a", inactive: "false",
    }];
    if (request.table === "sys_translated") return [];
    if (request.table === "sys_translated_text") return [];
    if (request.table === "catalog_script_client") return [];
    if (request.table === "catalog_ui_policy") return [];
    if (request.table === "sys_ui_message") return [];
    return [];
  };
  return { transport, requests, itemId, variableId, choiceId };
}

test("a catalog choice whose text cannot be queried is unverified, not unavailable", async () => {
  /* Review finding: a rejected string went into the unavailable set, so it
   * read as a failed read. It is a key the query language cannot express,
   * which is Unverified; Unavailable is reserved for reads that failed. */
  const fixture = catalogTransport({ choiceText: "Choice^A" });
  const result = await TL.run({
    mode: "catalog", table: "sc_cat_item", catalogItemSysId: fixture.itemId, sysId: fixture.itemId,
  }, fixture.transport);
  const row = result.sections.find((section) => section.id === "choices").rows[0];
  assert.strictEqual(row.states.fr.state, "unverified");
  assert.ok(!row.evidence.unavailable, "not presented as a failed read");
  assert.strictEqual(row.evidence.choices[0].states.fr.state, "unverified");
  assert.strictEqual(row.coverage.counted, 0);
  assert.ok(
    !fixture.requests.some((request) => request.table === "sys_translated" && request.query.includes("Choice^A")),
    "the unexpressible text is never put into a query"
  );
});

test("a record-keyed row for a variable set title is reported as stranded", async () => {
  /* Review finding: set titles were built without stranded evidence because
   * the mirror read never asked for item_option_new_set document keys. */
  const setId = "00000000000000000000000000000020";
  const fixture = catalogTransport({
    setIds: [setId],
    answer: (request) => {
      if (request.table === "sys_translated_text" && request.query.includes("tablename=item_option_new_set")) {
        return [{ tablename: "item_option_new_set", documentkey: setId, fieldname: "title", language: "fr" }];
      }
      return undefined;
    },
  });
  const result = await TL.run({
    mode: "catalog", table: "sc_cat_item", catalogItemSysId: fixture.itemId, sysId: fixture.itemId,
  }, fixture.transport);
  const mirror = fixture.requests.find((request) =>
    request.table === "sys_translated_text" && request.query.includes("tablename=item_option_new_set"));
  assert.ok(mirror && mirror.query.includes("documentkeyIN" + setId), "the mirror read names the set");
  const values = result.sections.find((section) => section.id === "values");
  const title = values.rows.find((row) => row.aspect === "set title");
  assert.ok(title, "the set title row exists");
  assert.strictEqual(title.evidence.stranded.rowCount, 1, "the wrong-store row is reported");
  assert.strictEqual(title.states.fr.state, "missing", "and it never counts as coverage");
});

test("catalog reads over many variable sets stay under the query bound", async () => {
  /* Review finding: sys_idIN and variable_setIN were joined over every set
   * id in one query, so an item with 182 sets produced requests over 6000
   * characters. Every id list is now chunked, item rows read once. */
  const setIds = [];
  for (let index = 0; index < 182; index++) {
    setIds.push("0000000000000000000000000000" + index.toString(16).padStart(4, "0"));
  }
  const fixture = catalogTransport({ setIds });
  await TL.run({
    mode: "catalog", table: "sc_cat_item", catalogItemSysId: fixture.itemId, sysId: fixture.itemId,
  }, fixture.transport);
  const longest = Math.max.apply(null, fixture.requests.map((request) => String(request.query || "").length));
  assert.ok(longest <= 6000, "longest query was " + longest);
  const count = (table, predicate) => fixture.requests.filter((request) =>
    request.table === table && (!predicate || predicate(request))).length;
  assert.strictEqual(count("item_option_new_set"), 4, "182 sets in chunks of 50");
  assert.strictEqual(count("item_option_new", (r) => r.query.startsWith("cat_item=")), 1, "the item's own variables once");
  assert.strictEqual(count("item_option_new", (r) => r.query.startsWith("variable_setIN")), 4);
  assert.strictEqual(count("catalog_script_client"), 5, "item plus four set chunks");
  assert.strictEqual(count("catalog_ui_policy"), 5);
  assert.strictEqual(count("sys_translated_text", (r) => r.query.includes("tablename=item_option_new_set")), 4, "set-title mirrors are chunked too");
  assert.ok(fixture.requests.every((request) => !/,,|IN,|IN\^/.test(request.query || "")), "no empty id list is ever sent");
});

test("form sections are handed over as their rows exist, before the message scan", async () => {
  /* Review finding: every section was emitted together at the end, so a
   * timeout during the client-script scan discarded labels, values and
   * choices that had already been read. */
  const fixture = formTransport();
  const events = [];
  let seenAtScan = null;
  const transport = async (request) => {
    if (request.table === "sys_script_client" && seenAtScan === null) seenAtScan = events.slice();
    return fixture.transport(request);
  };
  const result = await TL.run({
    mode: "form",
    surface: "classic",
    table: "example_child",
    sysId: "00000000000000000000000000000009",
    fields: ["title", "description", "state", "plain"],
    loadValues: async () => ({ values: { title: "Base title" } }),
    onSection: (section) => events.push(section.id),
  }, transport);
  assert.deepStrictEqual(seenAtScan, ["labels", "values", "choices"], "three sections were on their way before the scan started");
  assert.deepStrictEqual(events, ["labels", "values", "choices", "messages"]);
  /* Array.from: the engine's arrays come from its VM realm, whose Array
   * prototype is not this one's, and deepStrictEqual compares prototypes. */
  assert.deepStrictEqual(Array.from(result.sections, (section) => section.id), events, "the final result is the same sections in the same order");
});

test("catalog sections are handed over before the client-script scan", async () => {
  const fixture = catalogTransport();
  const events = [];
  let seenAtScan = null;
  const transport = async (request) => {
    if (request.table === "catalog_script_client" && seenAtScan === null) seenAtScan = events.slice();
    return fixture.transport(request);
  };
  const result = await TL.run({
    mode: "catalog", table: "sc_cat_item", catalogItemSysId: fixture.itemId, sysId: fixture.itemId,
    onSection: (section) => events.push(section.id),
  }, transport);
  assert.deepStrictEqual(seenAtScan, ["values", "choices"]);
  assert.deepStrictEqual(events, ["values", "choices", "messages"]);
  assert.deepStrictEqual(Array.from(result.sections, (section) => section.id), events);
});

test("a choices row links to the whole list while each value prefills its own row", () => {
  const origin = "https://example.service-now.com";
  const languageContext = languages();
  const row = TL.analyzeChoices({
    element: "subcategory",
    source: { table: "example_record", field: "subcategory" },
    languages: languageContext,
    origin,
    rows: [
      { name: "example_record", element: "subcategory", value: "email", dependent_value: "inquiry", language: "en", label: "Email inquiry" },
      { name: "example_record", element: "subcategory", value: "email", dependent_value: "inquiry", language: "fr", label: "Courriel" },
    ],
  });
  const rowQuery = decodeURIComponent(row.links.list.split("sysparm_query=")[1]);
  assert.strictEqual(
    rowQuery, "name=example_record^element=subcategory",
    "the row is the whole choice list, not one base value"
  );
  assert.deepStrictEqual(
    Object.keys(row.links.newRecord), [],
    "an aggregate state names no single row to create"
  );
  const choice = row.evidence.choices[0];
  const choiceQuery = decodeURIComponent(choice.links.newRecord.de.split("sysparm_query=")[1]);
  assert.strictEqual(
    choiceQuery,
    "name=example_record^element=subcategory^value=email^dependent_value=inquiry^language=de",
    "dependent_value is part of a choice's identity, so a prefill must carry it"
  );
  const choiceList = decodeURIComponent(choice.links.list.split("sysparm_query=")[1]);
  assert.strictEqual(
    choiceList, "name=example_record^element=subcategory^value=email^dependent_value=inquiry"
  );
});

test("footer links filter each store to the surface, or offer nothing", () => {
  const origin = "https://example.service-now.com";
  const targets = {
    tables: ["example_record", "example_parent"],
    documentKey: "00000000000000000000000000000009",
    messageKeys: ["example.key.one", "example.key.two"],
  };
  const doc = decodeURIComponent(
    TL.buildContextListUrl(origin, "sys_documentation", targets).split("sysparm_query=")[1]
  );
  assert.strictEqual(doc, "nameINexample_record,example_parent");
  const text = decodeURIComponent(
    TL.buildContextListUrl(origin, "sys_translated_text", targets).split("sysparm_query=")[1]
  );
  assert.strictEqual(
    text,
    "tablenameINexample_record,example_parent^documentkey=00000000000000000000000000000009"
  );
  const messages = decodeURIComponent(
    TL.buildContextListUrl(origin, "sys_ui_message", targets).split("sysparm_query=")[1]
  );
  assert.strictEqual(messages, "key=example.key.one^ORkey=example.key.two");

  assert.strictEqual(
    TL.buildContextListUrl(origin, "sys_documentation", { tables: [] }), "",
    "no target means no button rather than an unfiltered list"
  );
  assert.strictEqual(TL.buildContextListUrl(origin, "sys_ui_message", { messageKeys: [] }), "");
  /* A key list that cannot be expressed in one chunk would open a list
   * answering a narrower question than the panel asked. */
  const many = [];
  for (let index = 0; index < TL.MAX_VALUE_CHUNK + 5; index++) many.push("example.key." + index);
  assert.strictEqual(
    TL.buildContextListUrl(origin, "sys_ui_message", { messageKeys: many }), ""
  );
});

test("without a usable origin nothing offers a link at all", () => {
  const languageContext = languages();
  const row = TL.analyzeLabel({
    element: "summary",
    chain: ["example_record"],
    definingTable: "example_record",
    languages: languageContext,
    linkKey: { name: "example_record", element: "summary" },
    rows: [{ name: "example_record", element: "summary", language: "en", label: "Summary" }],
  });
  assert.strictEqual(row.links, null, "no origin, no link -- never a half-built one");
  const unsafe = TL.analyzeLabel({
    element: "summary",
    chain: ["example_record"],
    definingTable: "example_record",
    languages: languageContext,
    origin: "https://example.invalid",
    linkKey: { name: "example_record", element: "summary" },
    rows: [{ name: "example_record", element: "summary", language: "en", label: "Summary" }],
  });
  assert.strictEqual(unsafe.links, null, "a non-ServiceNow origin is refused");
});


/* ------------------------------------------------------------------ *
 * Language-scoped summaries
 *
 * The unscoped summary is the number nobody can move by hiding a column.
 * The scoped one answers the question a reader on a twenty-language
 * instance actually has: is this done for the languages we ship? Both are
 * derived from the same states through the same coverage rule, and the
 * panel shows them together.
 * ------------------------------------------------------------------ */

function summaryRow(states, countedIds) {
  return { states, coverage: TL.coverageFromStates(states, countedIds) };
}

test("an unscoped section summary counts every language the run counted", () => {
  const counted = ["fr", "de"];
  const rows = [
    summaryRow({ fr: { state: "direct" }, de: { state: "missing" } }, counted),
    summaryRow({ fr: { state: "direct" }, de: { state: "direct" } }, counted),
  ];
  const summary = TL.sectionSummary(rows);
  assert.strictEqual(summary.covered, 3);
  assert.strictEqual(summary.counted, 4);
  assert.strictEqual(summary.percent, 75);
  assert.strictEqual(summary.complete, 1);
  assert.strictEqual(summary.partial, 1);
  assert.strictEqual(summary.none, 0);
  assert.strictEqual(summary.scoped, false, "an unscoped summary must declare itself unscoped");
  assert.strictEqual(summary.scopeCount, null);
});

test("a scoped summary re-counts the same rows over only the languages asked for", () => {
  const counted = ["fr", "de"];
  const rows = [
    summaryRow({ fr: { state: "direct" }, de: { state: "missing" } }, counted),
    summaryRow({ fr: { state: "direct" }, de: { state: "missing" } }, counted),
  ];
  const all = TL.sectionSummary(rows);
  assert.strictEqual(all.percent, 50);
  assert.strictEqual(all.complete, 0, "neither row is complete in both languages");

  const scoped = TL.sectionSummary(rows, ["fr"]);
  assert.strictEqual(scoped.percent, 100);
  assert.strictEqual(scoped.complete, 2, "both rows are finished in the language asked for");
  assert.strictEqual(scoped.partial, 0);
  assert.strictEqual(scoped.none, 0);
  assert.strictEqual(scoped.scoped, true);
  assert.strictEqual(scoped.scopeCount, 1);

  assert.strictEqual(rows[0].coverage.counted, 2, "scoping must not rewrite the row it counted");
  assert.strictEqual(TL.sectionSummary(rows).percent, 50, "and the unscoped answer is unchanged");
});

test("a scoped summary applies the same excluded-state rule as the unscoped one", () => {
  const counted = ["fr", "de"];
  const rows = [summaryRow({ fr: { state: "unavailable" }, de: { state: "direct" } }, counted)];
  const scoped = TL.sectionSummary(rows, ["fr"]);
  assert.strictEqual(scoped.counted, 0, "an unavailable language is unknown, never missing");
  assert.strictEqual(scoped.percent, null);
  assert.strictEqual(scoped.none, 0, "and an uncounted row is not a row with no coverage");
  assert.strictEqual(scoped.rowCount, 1, "the row still exists, it is simply uncounted");
});

test("scoping to a language the row never carried counts it missing, not covered", () => {
  const rows = [summaryRow({ fr: { state: "direct" } }, ["fr"])];
  const scoped = TL.sectionSummary(rows, ["fr", "de"]);
  assert.strictEqual(scoped.counted, 2);
  assert.strictEqual(scoped.covered, 1);
  assert.strictEqual(scoped.partial, 1, "absence of a state is a gap, never a pass");
});

test("an empty scope counts nothing rather than silently meaning every language", () => {
  const rows = [summaryRow({ fr: { state: "direct" }, de: { state: "missing" } }, ["fr", "de"])];
  const scoped = TL.sectionSummary(rows, []);
  assert.strictEqual(scoped.counted, 0);
  assert.strictEqual(scoped.percent, null);
  assert.strictEqual(scoped.scoped, true, "deselecting everything is still a selection");
  assert.strictEqual(scoped.scopeCount, 0);
});

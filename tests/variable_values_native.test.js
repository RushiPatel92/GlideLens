/* Tests for native-UI Variable Values: identity, safe stored reads, comparison,
 * portal regression behavior, rendering/copy safety, and source invariants. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const uiSource = fs.readFileSync(path.join(__dirname, "..", "hidden_variables_ui.js"), "utf8");
const manifestSource = fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8");

const id = (number) => Number(number).toString(16).padStart(32, "0");
const RITM_ID = id(1);
const ITEM_ID = id(2);
const SOW = "sow:sc_req_item";
const SUPPLIER_CASE = "psm/workspace:sn_slm_case";
const SUPPLIER_TASK = "psm/workspace:sn_slm_task";

function nativeHelperSource() {
  const fieldStart = contentSource.indexOf("function snFieldValue");
  const fieldEnd = contentSource.indexOf("function normalizeSourceInput", fieldStart);
  const typeStart = contentSource.indexOf("const UNSUPPORTED_VARIABLE_TYPES");
  const typeEnd = contentSource.indexOf("function parseVariableOrder", typeStart);
  const policyStart = contentSource.indexOf("const SENSITIVE_VARIABLE_NAME_PATTERN");
  const policyEnd = contentSource.indexOf("const VARIABLE_DEFINITION_FIELDS", policyStart);
  const nativeStart = contentSource.indexOf("function nativeDefinitionFromRow");
  const nativeEnd = contentSource.indexOf("// Build one row per variable", nativeStart);
  for (const [name, start, end] of [
    ["field", fieldStart, fieldEnd],
    ["type", typeStart, typeEnd],
    ["policy", policyStart, policyEnd],
    ["native", nativeStart, nativeEnd],
  ]) {
    assert.ok(start >= 0 && end > start, name + " helper block not found");
  }
  return [
    contentSource.slice(fieldStart, fieldEnd),
    contentSource.slice(typeStart, typeEnd),
    contentSource.slice(policyStart, policyEnd),
    contentSource.slice(nativeStart, nativeEnd),
  ].join("\n");
}

function loadNativeHelpers(snGetMany) {
  const factory = new Function(
    "snGetMany",
    nativeHelperSource() +
      "\nreturn { NATIVE_VARIABLE_TYPE_POLICIES, NATIVE_PROTOTYPE_COLLISION_NAMES, " +
      "NATIVE_STORED_METADATA_FIELDS, classifyNativeVariable, nativeValuesEqual, " +
      "nativeRecordIdentityMatches, nativeStoredDateTimeInZone, " +
      "WORKSPACE_SOW_RITM_TYPE_POLICIES, WORKSPACE_SUPPLIER_TYPE_POLICIES, " +
      "WORKSPACE_TYPE_POLICIES_BY_SURFACE, classifyWorkspaceVariable, " +
      "workspaceLiveReadAllowed, nativeMrvsNotReadReason, " +
      "nativeDuplicateNameSet, nativeLiveReadRequested, workspaceLiveReadRequested, " +
      "workspaceLiveValueForComparison, fetchNativeRitmStoredValues, " +
      "fetchNativeMrvsStoredValues, nativeMrvsValuesEqual, parseNativeMrvsRows, " +
      "nativeMrvsColumnsSafe, nativeMrvsColumnTypes, applyNativeMrvsLiveReadPolicy, " +
      "reconcileProducerDefinitionsWithAnswers, " +
      "fetchNativeRitmRecordData, fetchNativeProducerRecordData, buildNativeVariableRows };"
  );
  return factory(snGetMany || (async () => []));
}

function liveRequestApi() {
  return new Function(
    nativeHelperSource() +
      contentSource.slice(
        contentSource.indexOf("// True when any definition sharing this name"),
        contentSource.indexOf("async function finishNativeVariableValues")
      ) +
      "\nreturn { nativeLiveValueRequests, workspaceLiveValueRequests };"
  )();
}

function workspaceSnapshotProbe(document, location, globals) {
  const start = backgroundSource.indexOf("function inspectWorkspaceVariableSnapshot");
  const end = backgroundSource.indexOf("// Self-contained MAIN-world inspector for hidden", start);
  assert.ok(start >= 0 && end > start, "Workspace snapshot probe not found");
  const values = globals || {};
  const probe = new Function(
    "document",
    "location",
    "g_tz",
    "g_user_date_format",
    "g_user_date_time_format",
    "getDateFromFormat",
    backgroundSource.slice(start, end) + "\nreturn inspectWorkspaceVariableSnapshot;"
  )(
    document,
    location,
    values.timeZone || "Europe/London",
    values.dateFormat || "yyyy-MM-dd",
    values.dateTimeFormat || "yyyy-MM-dd HH:mm:ss",
    values.getDateFromFormat || (() => 0)
  );
  return probe;
}

function workspaceElement(tagName, properties, parent, visible = true) {
  return Object.assign({
    tagName: tagName.toUpperCase(),
    parentElement: parent || null,
    shadowRoot: null,
    getRootNode() { return { host: null }; },
    getBoundingClientRect() {
      return visible ? { width: 300, height: 200 } : { width: 0, height: 0 };
    },
  }, properties || {});
}

function workspaceDocument(elements) {
  return {
    querySelectorAll(selector) {
      assert.strictEqual(selector, "*");
      return elements;
    },
  };
}

function definition(overrides) {
  return Object.assign({
    name: "example",
    label: "Example",
    type: "6",
    typeDisplay: "Single Line Text",
    questionId: id(100),
    setName: "",
    hiddenType: false,
    isMrvs: false,
  }, overrides || {});
}

function storedRow(def, value, overrides) {
  return Object.assign({
    optionSysId: id(200),
    questionId: def.questionId,
    name: def.name,
    type: def.type,
    typeDisplay: def.typeDisplay,
    secret: false,
    policy: { disposition: "comparable", comparisonMode: def.type === "21" ? "set" : "scalar" },
    fetchAllowed: true,
    valueAvailable: true,
    storedValue: value,
  }, overrides || {});
}

function liveRow(def, value, overrides) {
  return Object.assign({
    name: def.name,
    questionId: def.questionId,
    foundEl: true,
    visible: true,
    gFormReportedVisible: true,
    liveValueAvailable: true,
    liveValue: value,
    valueReadFailed: false,
  }, overrides || {});
}

function rowsFor(definitions, metadataRows, liveResults, status = "success", extra) {
  return loadNativeHelpers().buildNativeVariableRows(
    definitions,
    Object.assign({ storedReadStatus: status, metadataRows }, extra || {}),
    liveResults
  );
}

const MRVS_SET_ID = id(700);

function mrvsDefinition(overrides) {
  return definition(Object.assign({
    name: "example_rows",
    label: "Example Rows",
    type: "34",
    typeDisplay: "Multi-Row Variable Set",
    variableSet: MRVS_SET_ID,
    questionId: MRVS_SET_ID,
    isMrvs: true,
    // applyNativeMrvsLiveReadPolicy sets both on every multi-row definition
    // before the rows are built, so a fixture without them models a state the
    // reader cannot produce.
    mrvsColumnsSafe: true,
    liveReadAllowed: true,
    liveReadBlockedReason: "",
  }, overrides || {}));
}

// Shape returned by assembleNativeMrvsSets for one set.
function mrvsStored(rows, overrides) {
  return Object.assign({
    rows,
    withheldColumns: [],
    comparisonModes: {},
  }, overrides || {});
}

function mrvsResult(setId, set, status = "success") {
  return {
    mrvsReadStatus: status,
    mrvsReadError: "",
    mrvsValuesBySetId: set ? new Map([[setId, set]]) : new Map(),
  };
}

function mrvsAnswerRow(answerSysId, columnName, rowIndex, overrides) {
  return Object.assign({
    sys_id: answerSysId,
    parent_id: RITM_ID,
    row_index: String(rowIndex),
    variable_set: MRVS_SET_ID,
    item_option_new: id(800),
    "item_option_new.name": columnName,
    "item_option_new.question_text": columnName,
    "item_option_new.type": { value: "6", display_value: "Single Line Text" },
  }, overrides || {});
}

function metadataRow(def, optionSysId, overrides) {
  return Object.assign({
    "sc_item_option.sys_id": optionSysId,
    "sc_item_option.item_option_new": def.questionId,
    "sc_item_option.item_option_new.name": def.name,
    "sc_item_option.item_option_new.question_text": def.label,
    "sc_item_option.item_option_new.type": {
      value: def.type,
      display_value: def.typeDisplay,
    },
  }, overrides || {});
}

function producerMetadataRow(def, answerSysId, overrides) {
  return Object.assign({
    sys_id: answerSysId,
    table_name: "sn_example_case",
    table_sys_id: RITM_ID,
    document: id(990),
    question: def.questionId,
    "question.name": def.name,
    "question.question_text": def.label,
    "question.type": { value: def.type, display_value: def.typeDisplay },
    "question.order": "100",
    "question.variable_set": "",
    "question.reference": "",
    "question.lookup_table": "",
    "question.list_table": "",
    "question.cat_item": "",
  }, overrides || {});
}

function nativeDefinitionRow(def, overrides) {
  return Object.assign({
    sys_id: def.questionId,
    name: def.name,
    question_text: def.label,
    type: { value: def.type, display_value: def.typeDisplay },
    order: "100",
    variable_set: def.variableSet || "",
    reference: "",
    lookup_table: "",
    list_table: "",
  }, overrides || {});
}

test("the policy enumerates every documented numeric type and defaults unknown types closed", () => {
  const helpers = loadNativeHelpers();
  const documented = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "14",
    "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26",
    "27", "28", "29", "31", "32", "33", "34", "40",
  ];
  documented.forEach((type) => assert.ok(helpers.NATIVE_VARIABLE_TYPE_POLICIES.has(type), type));
  assert.deepStrictEqual(helpers.classifyNativeVariable(definition({ type: "999" })), {
    disposition: "denied",
  });
});

test("each Workspace surface has its own layer-one allowlist", () => {
  const helpers = loadNativeHelpers();
  assert.deepStrictEqual(
    Array.from(helpers.WORKSPACE_SOW_RITM_TYPE_POLICIES.keys()),
    ["1", "2", "5", "6", "7", "8", "9", "10", "18", "21", "26", "31", "33", "34"]
  );
  assert.deepStrictEqual(
    Array.from(helpers.WORKSPACE_SUPPLIER_TYPE_POLICIES.keys()),
    ["1", "2", "5", "6", "7", "8", "10", "18", "21", "26", "33", "34"]
  );
  // The column allowlist a surface proves for the inside of a multi-row set is
  // separate from its variable allowlist, and separate per surface.
  assert.deepStrictEqual(
    Array.from(helpers.WORKSPACE_SOW_RITM_TYPE_POLICIES.get("34").columnTypes),
    ["5", "6", "8"]
  );
  assert.deepStrictEqual(
    Array.from(helpers.WORKSPACE_SUPPLIER_TYPE_POLICIES.get("34").columnTypes),
    ["1", "2", "5", "6", "7", "8", "33"]
  );
  // No surface may compare a date column inside a set: the container renders
  // one in the user's date format and the session timezone, not raw.
  Object.values(Object.fromEntries(helpers.WORKSPACE_TYPE_POLICIES_BY_SURFACE))
    .forEach((policies) => {
      const columnTypes = policies.get("34").columnTypes;
      assert.ok(!columnTypes.has("9"), "a Date column must never be compared inside a set");
      assert.ok(!columnTypes.has("10"), "a Date/Time column must never be compared inside a set");
    });
  assert.deepStrictEqual(
    Array.from(helpers.WORKSPACE_TYPE_POLICIES_BY_SURFACE.keys()),
    ["sow:sc_req_item", "psm/workspace:sn_slm_case", "psm/workspace:sn_slm_task"]
  );
  assert.deepStrictEqual(
    helpers.classifyWorkspaceVariable(definition({ type: "5" }), SOW),
    {
      disposition: "comparable",
      comparisonMode: "scalar",
      validator: "choice-pair",
      layer: 1,
    }
  );
  assert.strictEqual(
    helpers.classifyWorkspaceVariable(
      definition({ type: "25", typeDisplay: "Masked" }),
      SOW
    ).disposition,
    "secret"
  );
});

test("per-type evidence never transfers between Workspace surfaces", () => {
  const helpers = loadNativeHelpers();
  const api = liveRequestApi();
  // Date is proven on SOW and deliberately unproven on the supplier surfaces:
  // no probed supplier record stores one, so there is no evidence to
  // allowlist from.
  const date = definition({ type: "9", name: "needed_by", questionId: id(991) });
  assert.strictEqual(
    helpers.classifyWorkspaceVariable(date, SOW).disposition,
    "comparable"
  );
  assert.strictEqual(
    helpers.classifyWorkspaceVariable(date, SUPPLIER_CASE).disposition,
    "denied"
  );
  assert.deepStrictEqual(api.workspaceLiveValueRequests([date], SUPPLIER_CASE), []);
  // Supplier case and supplier task share one verified policy map, so a type
  // proven on one is proven on the other and neither can drift alone.
  assert.strictEqual(
    helpers.classifyWorkspaceVariable(date, SUPPLIER_TASK).disposition,
    "denied"
  );
  ["1", "2", "5", "6", "7", "8", "10", "18", "21", "26", "33", "34"].forEach((type) => {
    assert.deepStrictEqual(
      helpers.classifyWorkspaceVariable(definition({ type }), SUPPLIER_CASE),
      helpers.classifyWorkspaceVariable(definition({ type }), SUPPLIER_TASK),
      "type " + type + " must classify identically on both supplier surfaces"
    );
  });
  // A surface with no policy map of its own compares nothing at all rather
  // than falling back to another surface's proven types.
  const text = definition({ type: "6", name: "note", questionId: id(992) });
  assert.strictEqual(
    helpers.classifyWorkspaceVariable(text, "psm/workspace:sc_req_item").disposition,
    "denied"
  );
  assert.strictEqual(helpers.classifyWorkspaceVariable(text, "").disposition, "denied");
  assert.deepStrictEqual(api.workspaceLiveValueRequests([text], "sow:sn_slm_case"), []);
});

test("a secret stays secret on a surface that has no policy map", () => {
  const helpers = loadNativeHelpers();
  assert.strictEqual(
    helpers.classifyWorkspaceVariable(
      definition({ type: "25", typeDisplay: "Masked" }),
      "psm/workspace:sc_req_item"
    ).disposition,
    "secret"
  );
});

test("Workspace keeps the single-instance type-16 observation denied", () => {
  const helpers = loadNativeHelpers();
  const api = liveRequestApi();
  const wideText = definition({
    name: "request_description",
    type: "16",
    questionId: id(985),
  });
  assert.deepStrictEqual(helpers.classifyNativeVariable(wideText), {
    disposition: "comparable",
    comparisonMode: "scalar",
  });
  assert.deepStrictEqual(helpers.classifyWorkspaceVariable(wideText, SOW), {
    disposition: "denied",
  });
  assert.deepStrictEqual(api.workspaceLiveValueRequests([wideText], SOW), []);
});

test("Workspace compares Checkbox as a boolean now both approved instances proved its shape", () => {
  const helpers = loadNativeHelpers();
  const api = liveRequestApi();
  const checkbox = definition({
    name: "accept_policy",
    type: "7",
    typeDisplay: "Checkbox",
    questionId: id(986),
  });
  assert.deepStrictEqual(helpers.classifyNativeVariable(checkbox), {
    disposition: "comparable",
    comparisonMode: "boolean",
  });
  // Stock and configured instances both exposed layer 1 `value` and
  // `displayValue` as equal strings matching storage, so the observed pair is
  // verified with text-pair while the comparison itself stays boolean.
  assert.deepStrictEqual(helpers.classifyWorkspaceVariable(checkbox, SOW), {
    disposition: "comparable",
    comparisonMode: "boolean",
    validator: "boolean-pair",
    layer: 1,
  });
  assert.deepStrictEqual(api.workspaceLiveValueRequests([checkbox], SOW), [
    {
      name: "accept_policy",
      fieldName: "variables.accept_policy",
      questionId: id(986),
      type: "7",
      dateKind: "",
      liveLayer: 1,
    },
  ]);
});

test("a Workspace Checkbox row compares end to end through the panel builder", () => {
  const helpers = loadNativeHelpers();
  const checkboxDef = definition({
    name: "gl_checkbox",
    type: "7",
    typeDisplay: "Checkbox",
    questionId: id(987),
  });
  const nativePolicy = { disposition: "comparable", comparisonMode: "boolean" };
  const live = (value, displayValue) => ({
    name: checkboxDef.name,
    questionId: checkboxDef.questionId,
    foundEntry: true,
    visible: true,
    canRead: true,
    liveValueAvailable: true,
    liveValue: value,
    liveDisplayValueAvailable: true,
    liveDisplayValue: displayValue,
    liveLayer: 1,
  });
  const build = (stored, liveEntry) => helpers.buildNativeVariableRows(
    [checkboxDef],
    {
      storedReadStatus: "success",
      metadataRows: [storedRow(checkboxDef, stored, { policy: nativePolicy })],
    },
    [liveEntry],
    { workspace: true, workspaceSurfaceKey: SOW, timeZone: "Europe/London", zoneSource: "page" }
  )[0];

  const checked = build("true", live("true", "true"));
  assert.strictEqual(checked.workspaceCandidate, true);
  assert.strictEqual(checked.comparison, "match");
  assert.strictEqual(build("false", live("false", "false")).comparison, "match");
  // Boolean meaning bridges the platform's interchangeable spellings.
  assert.strictEqual(build("true", live("1", "1")).comparison, "match");
  assert.strictEqual(build("true", live("false", "false")).comparison, "differs");

  // An unrecognised representation refuses instead of claiming a difference.
  const unrecognised = build("true", live("checked", "checked"));
  assert.strictEqual(unrecognised.comparison, "not-comparable");
  assert.match(unrecognised.reason, /representation could not be verified/);
});

test("a Workspace Checkbox whose live pair disagrees is not comparable", () => {
  const helpers = loadNativeHelpers();
  const policy = helpers.classifyWorkspaceVariable(
    definition({ type: "7", typeDisplay: "Checkbox" }),
    SOW
  );
  // A rendered label such as "Yes" would make displayValue disagree with the
  // raw value. That is an unverified shape, never a substituted comparison.
  const mismatched = helpers.workspaceLiveValueForComparison(policy, {
    foundEntry: true,
    canRead: true,
    liveValueAvailable: true,
    liveValue: "true",
    liveDisplayValueAvailable: true,
    liveDisplayValue: "Yes",
  });
  assert.strictEqual(mismatched.ok, false);
  const agreed = helpers.workspaceLiveValueForComparison(policy, {
    foundEntry: true,
    canRead: true,
    liveValueAvailable: true,
    liveValue: "false",
    liveDisplayValueAvailable: true,
    liveDisplayValue: "false",
  });
  assert.deepStrictEqual(agreed, { ok: true, value: "false" });
  // An agreeing pair is still refused when the representation is not a
  // recognised boolean: reporting "differs" there could describe two states
  // that are actually identical.
  const unrecognised = helpers.workspaceLiveValueForComparison(policy, {
    foundEntry: true,
    canRead: true,
    liveValueAvailable: true,
    liveValue: "checked",
    liveDisplayValueAvailable: true,
    liveDisplayValue: "checked",
  });
  assert.strictEqual(unrecognised.ok, false);
  // Empty stays comparable so a stored empty against a live false is surfaced.
  assert.deepStrictEqual(
    helpers.workspaceLiveValueForComparison(policy, {
      foundEntry: true,
      canRead: true,
      liveValueAvailable: true,
      liveValue: "",
      liveDisplayValueAvailable: true,
      liveDisplayValue: "",
    }),
    { ok: true, value: "" }
  );
  // Boolean meaning still bridges the platform's interchangeable spellings.
  assert.strictEqual(helpers.nativeValuesEqual("true", "1", "boolean"), true);
  assert.strictEqual(helpers.nativeValuesEqual("false", "0", "boolean"), true);
  assert.strictEqual(helpers.nativeValuesEqual("", "false", "boolean"), false);
});

test("Break is structural, and Lookup Multiple Choice and URL compare as plain strings", () => {
  const helpers = loadNativeHelpers();
  // Verified live: type 22 stores one raw value, never a comma-separated list,
  // so it is a scalar rather than a set like List Collector.
  assert.deepStrictEqual(helpers.classifyNativeVariable(definition({ type: "12" })), {
    disposition: "structural",
  });
  ["22", "27"].forEach((type) => {
    assert.deepStrictEqual(helpers.classifyNativeVariable(definition({ type })), {
      disposition: "comparable",
      comparisonMode: "scalar",
    });
  });
  const def = definition({ type: "22" });
  assert.strictEqual(helpers.nativeValuesEqual("a,b", "b,a", "scalar"), false);
  assert.strictEqual(helpers.nativeValuesEqual("one value", "one value", "scalar"), true);
  // A secret name still wins over a comparable type.
  assert.deepStrictEqual(
    helpers.classifyNativeVariable(Object.assign({}, def, { name: "password" })),
    { disposition: "secret" }
  );
});

test("Lookup Select Box and Attachment compare as single raw values", () => {
  const helpers = loadNativeHelpers();
  // Verified live: type 18 stores one raw choice value (a sys_id or a label,
  // depending on lookup_value) and type 33 stores one attachment sys_id.
  // Neither is ever comma-separated, so both are scalars.
  ["18", "33"].forEach((type) => {
    assert.deepStrictEqual(helpers.classifyNativeVariable(definition({ type })), {
      disposition: "comparable",
      comparisonMode: "scalar",
    });
  });
  const attachment = id(801);
  assert.strictEqual(helpers.nativeValuesEqual(attachment, attachment, "scalar"), true);
  assert.strictEqual(helpers.nativeValuesEqual(attachment, id(802), "scalar"), false);
  // A replaced attachment reads as a difference, and a cleared one is not
  // mistaken for a match.
  assert.strictEqual(helpers.nativeValuesEqual(attachment, "", "scalar"), false);
});

test("plain single-value types compare as scalars, and format-risky types stay denied", () => {
  const helpers = loadNativeHelpers();
  // Verified live: each stores one raw value with no separator — choice values,
  // free text, an address, and a user sys_id.
  ["3", "16", "28", "31"].forEach((type) => {
    assert.deepStrictEqual(helpers.classifyNativeVariable(definition({ type })), {
      disposition: "comparable",
      comparisonMode: "scalar",
    }, type);
  });
  // Duration stores an internal format g_form does not echo back, and HTML can
  // be re-encoded between the two sides. Comparing either raw would turn a
  // correct "not compared" into a false "differs", so both stay denied. Date (9)
  // and Date/Time (10) are handled by the normalisation tests below.
  ["23", "29"].forEach((type) => {
    assert.deepStrictEqual(helpers.classifyNativeVariable(definition({ type })), {
      disposition: "denied",
    }, type);
  });
});

test("a Date compares on the page-normalised value, never the raw display string", () => {
  const helpers = loadNativeHelpers();
  assert.deepStrictEqual(helpers.classifyNativeVariable(definition({ type: "9" })), {
    disposition: "comparable",
    comparisonMode: "date",
  });
  const def = definition({ name: "start_date", type: "9", typeDisplay: "Date" });
  // The live value arrives in the user's format; the probe supplies the
  // yyyy-MM-dd normalisation alongside it.
  const matching = rowsFor(
    [def],
    [storedRow(def, "2026-09-24", { policy: { disposition: "comparable", comparisonMode: "date" } })],
    [liveRow(def, "24-09-2026", { liveDateValue: "2026-09-24", liveDateNormalised: true })]
  )[0];
  assert.strictEqual(matching.comparison, "match");
  assert.strictEqual(matching.liveValue, "24-09-2026", "the panel still shows what the form shows");
  assert.match(matching.reason, /internal date format; the form shows the same day/);
  // That wording asserts the days agree, so it must not appear on a differing row.

  const differing = rowsFor(
    [def],
    [storedRow(def, "2026-09-24", { policy: { disposition: "comparable", comparisonMode: "date" } })],
    [liveRow(def, "25-09-2026", { liveDateValue: "2026-09-25", liveDateNormalised: true })]
  )[0];
  assert.strictEqual(differing.comparison, "differs");
  assert.doesNotMatch(differing.reason, /the same day/);

  // An unparsed date is never compared raw: that would report a difference
  // between "24-09-2026" and "2026-09-24" that does not exist.
  const unparsed = rowsFor(
    [def],
    [storedRow(def, "2026-09-24", { policy: { disposition: "comparable", comparisonMode: "date" } })],
    [liveRow(def, "24-09-2026", { liveDateValue: "", liveDateNormalised: false })]
  )[0];
  assert.strictEqual(unparsed.comparison, "not-comparable");
  assert.match(unparsed.reason, /user date format/);

  // The probe is only asked to normalise for date variables.
  const requestSource = contentSource.slice(
    contentSource.indexOf("function nativeLiveValueRequests"),
    contentSource.indexOf("async function finishNativeVariableValues")
  );
  assert.match(requestSource, /dateKind:/);
  const probe = backgroundSource.slice(
    backgroundSource.indexOf("function inspectNativeRecordVariables"),
    backgroundSource.indexOf("// Self-contained MAIN-world inspector")
  );
  assert.match(probe, /variable\.dateKind/);
  assert.match(probe, /typeof getDateFromFormat === "function"/);
  assert.match(probe, /typeof g_user_date_format !== "undefined"/);
  assert.match(probe, /transitionWindow[\s\S]*getTimezoneOffset/);
});

test("a Date/Time is compared in the signed-in user's timezone, not the browser's", () => {
  const helpers = loadNativeHelpers();
  assert.deepStrictEqual(helpers.classifyNativeVariable(definition({ type: "10" })), {
    disposition: "comparable",
    comparisonMode: "datetime",
  });

  // Verified live: a value stored as 17:51:39 UTC renders as 23:21:39 for a
  // user on +5:30, and as 18:51:39 for a user on +1 in August.
  const stored = "2026-08-23 17:51:39";
  assert.strictEqual(
    helpers.nativeStoredDateTimeInZone(stored, "Asia/Kolkata"),
    "2026-08-23 23:21:39"
  );
  assert.strictEqual(
    helpers.nativeStoredDateTimeInZone(stored, "Europe/London"),
    "2026-08-23 18:51:39"
  );
  // The offset is resolved for that instant, so DST is handled: the same clock
  // time in January is +0 in London, not +1.
  assert.strictEqual(
    helpers.nativeStoredDateTimeInZone("2026-01-23 17:51:39", "Europe/London"),
    "2026-01-23 17:51:39"
  );
  // Anything unresolvable yields "", which leaves the row uncompared.
  assert.strictEqual(helpers.nativeStoredDateTimeInZone(stored, ""), "");
  assert.strictEqual(helpers.nativeStoredDateTimeInZone(stored, "Not/AZone"), "");
  assert.strictEqual(helpers.nativeStoredDateTimeInZone("not a date", "Asia/Kolkata"), "");
  assert.strictEqual(
    helpers.nativeStoredDateTimeInZone("2026-02-30 17:51:39", "Asia/Kolkata"),
    "",
    "an invalid calendar date must not normalise into a different valid instant"
  );

  const def = definition({ name: "call_back", type: "10", typeDisplay: "Date/Time" });
  const policy = { disposition: "comparable", comparisonMode: "datetime" };
  const rows = (live, zone, zoneSource) => helpers.buildNativeVariableRows(
    [def],
    { storedReadStatus: "success", metadataRows: [storedRow(def, stored, { policy })] },
    [liveRow(def, "23-08-2026 23:21:39", { liveDateValue: live, liveDateNormalised: true })],
    { timeZone: zone, zoneSource: zoneSource || "user" }
  )[0];

  const matched = rows("2026-08-23 23:21:39", "Asia/Kolkata");
  assert.strictEqual(matched.comparison, "match");
  // The two columns show 17:51:39 next to 23:21:39, so a bare "Match" reads as
  // a bug. The row has to say why they agree.
  assert.match(matched.reason, /is UTC, which is 2026-08-23 23:21:39/);
  assert.match(matched.reason, /Asia\/Kolkata/);
  assert.match(
    rows("2026-08-23 23:22:39", "Asia/Kolkata").reason,
    /differ\. Stored .* is UTC/,
    "a differing row explains the conversion too, without claiming the form shows it"
  );
  // The same wall clock read by a user on a different offset is a real
  // difference, not a match.
  assert.strictEqual(rows("2026-08-23 23:21:39", "Europe/London").comparison, "differs");
  assert.strictEqual(rows("2026-08-23 23:22:39", "Asia/Kolkata").comparison, "differs");

  // With no timezone the row is left uncompared rather than compared raw,
  // which would report every date/time on the record as differing.
  const noZone = rows("2026-08-23 23:21:39", "");
  assert.strictEqual(noZone.comparison, "not-comparable");
  assert.match(noZone.reason, /timezone could not be resolved/);
  assert.match(rows("2026-08-23 23:21:39", "", "no-page-zone").reason, /active timezone/);

  // The active page zone is captured in the same MAIN-world probe that reads
  // values. No sys_user/sys_properties lookup or browser-zone fallback remains.
  const nativeProbe = backgroundSource.slice(
    backgroundSource.indexOf("function inspectNativeRecordVariables"),
    backgroundSource.indexOf("function inspectWorkspaceVariableSnapshot")
  );
  const nativeFlow = contentSource.slice(
    contentSource.indexOf("async function finishNativeVariableValues"),
    contentSource.indexOf("async function showNativeRitmVariableValues")
  );
  assert.match(nativeProbe, /typeof g_tz[\s\S]*result\.timeZone/);
  assert.match(nativeFlow, /liveProbe\.timeZone/);
  assert.doesNotMatch(nativeFlow, /sys_user|sys_properties|fetchNativeUserZone/);
});

test("no duplicate name is read, so a secret twin cannot leak through its sibling", () => {
  // Two definitions can share a name, and g_form resolves the name to whichever
  // one it likes. When one of the pair is masked, reading "the ordinary one"
  // could hand back the masked one's value -- into a row that is not marked
  // secret, and from there into copy output. Duplicates are uncomparable
  // anyway, so none of them is ever read.
  const api = liveRequestApi();
  const ordinary = definition({ name: "api_key", questionId: id(940) });
  const masked = definition({
    name: "api_key",
    type: "25",
    typeDisplay: "Masked",
    questionId: id(941),
  });
  const unique = definition({ name: "comments", questionId: id(942) });

  const requests = api.nativeLiveValueRequests([ordinary, masked, unique]);
  const byQuestion = new Map(requests.map((request) => [request.questionId, request]));

  assert.strictEqual(byQuestion.get(id(940)).readValue, false);
  assert.strictEqual(byQuestion.get(id(941)).readValue, false);
  // The ordinary twin is marked secret too: the probe must not touch the name
  // at all, not even to ask g_form whether it is visible.
  assert.strictEqual(byQuestion.get(id(940)).secret, true);
  assert.strictEqual(byQuestion.get(id(940)).duplicateName, true);
  // A name that is merely duplicated, with no secret in the pair, is still not
  // read -- but it is not misreported as a secret either.
  const plainPair = api.nativeLiveValueRequests([
    definition({ name: "dupe", questionId: id(943) }),
    definition({ name: "dupe", questionId: id(944) }),
  ]);
  assert.deepStrictEqual(plainPair.map((request) => request.readValue), [false, false]);
  assert.deepStrictEqual(plainPair.map((request) => request.secret), [false, false]);
  // An unambiguous variable is unaffected.
  assert.strictEqual(byQuestion.get(id(942)).readValue, true);
  assert.strictEqual(byQuestion.get(id(942)).secret, false);
  assert.strictEqual(byQuestion.get(id(942)).fieldName, "variables.comments");
});

test("a live MRVS is read only after every child column is proven safe", () => {
  const helpers = loadNativeHelpers();
  const api = liveRequestApi();
  const safeColumn = definition({ name: "plain", questionId: id(960), variableSet: MRVS_SET_ID });
  const secondColumn = definition({ name: "count", questionId: id(961), variableSet: MRVS_SET_ID });
  const maskedColumn = definition({
    name: "password",
    type: "25",
    typeDisplay: "Masked",
    questionId: id(962),
    variableSet: MRVS_SET_ID,
  });

  assert.strictEqual(
    helpers.nativeMrvsColumnsSafe(
      [nativeDefinitionRow(safeColumn), nativeDefinitionRow(secondColumn)],
      true
    ),
    true
  );
  assert.strictEqual(
    helpers.nativeMrvsColumnsSafe(
      [nativeDefinitionRow(safeColumn), nativeDefinitionRow(maskedColumn)],
      true
    ),
    false,
    "one masked child must block the whole live JSON read"
  );
  assert.strictEqual(
    helpers.nativeMrvsColumnsSafe([nativeDefinitionRow(safeColumn)], false),
    false,
    "a capped column-definition read cannot prove the set safe"
  );

  const approved = mrvsDefinition({ mrvsColumnsSafe: true });
  helpers.applyNativeMrvsLiveReadPolicy([approved], mrvsResult(null, null, "empty"));
  assert.strictEqual(approved.liveReadAllowed, true);
  assert.strictEqual(api.nativeLiveValueRequests([approved])[0].readValue, true);

  const withheld = mrvsDefinition({ mrvsColumnsSafe: true });
  helpers.applyNativeMrvsLiveReadPolicy(
    [withheld],
    mrvsResult(MRVS_SET_ID, mrvsStored([], { withheldColumns: ["password"] }))
  );
  assert.strictEqual(withheld.liveReadAllowed, false);
  assert.strictEqual(api.nativeLiveValueRequests([withheld])[0].readValue, false);
  const [row] = rowsFor(
    [withheld],
    [],
    [],
    "success",
    mrvsResult(MRVS_SET_ID, mrvsStored([], { withheldColumns: ["password"] }))
  );
  assert.match(row.reason, /Columns were not read/);
});

test("Workspace requests contain only positively allowlisted unique safe definitions", () => {
  const api = liveRequestApi();
  const safe = definition({ name: "plain_note", type: "6", questionId: id(945) });
  const choice = definition({ name: "choice_box", type: "5", questionId: id(946) });
  const secret = definition({ name: "password_value", type: "25", questionId: id(947) });
  const duplicateA = definition({ name: "dupe", type: "6", questionId: id(948) });
  const duplicateB = definition({ name: "dupe", type: "6", questionId: id(949) });
  const collision = definition({ name: "toString", type: "6", questionId: id(950) });
  const malformed = definition({ name: "bad_id", type: "6", questionId: "not-an-id" });

  const requests = api.workspaceLiveValueRequests([
    safe,
    choice,
    secret,
    duplicateA,
    duplicateB,
    collision,
    malformed,
  ], SOW);
  assert.deepStrictEqual(requests, [
    {
      name: "plain_note",
      fieldName: "variables.plain_note",
      questionId: id(945),
      type: "6",
      dateKind: "",
      liveLayer: 1,
    },
    {
      name: "choice_box",
      fieldName: "variables.choice_box",
      questionId: id(946),
      type: "5",
      dateKind: "",
      liveLayer: 1,
    },
  ]);
});

test("Workspace snapshot binds identity before geometry and pulls only requested keys", () => {
  const currentId = id(960);
  const otherId = id(961);
  const currentMacro = workspaceElement("macroponent-current", {
    table: "sc_req_item",
    sysId: currentId,
  });
  const otherMacro = workspaceElement("macroponent-other", {
    table: "sc_req_item",
    sysId: otherId,
  });
  let unrequestedTouched = false;
  const fields = {
    "variables.plain_note": {
      id: id(962),
      name: "variables.plain_note",
      referringTable: "sc_req_item",
      referringRecordId: currentId,
      visible: true,
      canRead: true,
      value: "live",
      displayValue: "live",
    },
  };
  Object.defineProperty(fields, "variables.secret", {
    configurable: true,
    get() {
      unrequestedTouched = true;
      throw new Error("must not read");
    },
  });
  const currentForm = workspaceElement("sn-catalog-form", {
    sourceTable: "sc_req_item",
    sourceId: currentId,
    fields,
  }, currentMacro, false);
  const unrelatedVisibleForm = workspaceElement("sn-catalog-form", {
    sourceTable: "sc_req_item",
    sourceId: otherId,
    fields: {},
  }, otherMacro, true);
  const document = workspaceDocument([
    currentMacro,
    otherMacro,
    currentForm,
    unrelatedVisibleForm,
  ]);
  const probe = workspaceSnapshotProbe(document, {
    href: "https://example.service-now.com/now/sow/record/sc_req_item/" + currentId,
  });
  const snapshot = probe([{
    name: "plain_note",
    fieldName: "variables.plain_note",
    questionId: id(962),
    type: "6",
    dateKind: "",
  }]);
  assert.strictEqual(snapshot.identityStatus, "verified");
  assert.strictEqual(snapshot.formStatus, "available");
  assert.strictEqual(snapshot.selectedFormCollapsed, true);
  assert.strictEqual(snapshot.perVariable[0].liveValue, "live");
  assert.strictEqual(unrequestedTouched, false);
});

test("Workspace snapshot uses rect only to break same-record duplicates", () => {
  const currentId = id(963);
  const macro = workspaceElement("macroponent-current", {
    table: "sc_req_item",
    sysId: currentId,
  });
  const entry = {
    id: id(964),
    name: "variables.plain_note",
    referringTable: "sc_req_item",
    referringRecordId: currentId,
    visible: true,
    canRead: true,
    value: "current",
    displayValue: "current",
  };
  const stale = workspaceElement("sn-catalog-form", {
    sourceTable: "sc_req_item",
    sourceId: currentId,
    fields: { "variables.plain_note": { ...entry, value: "stale", displayValue: "stale" } },
  }, macro, false);
  const current = workspaceElement("sn-catalog-form", {
    sourceTable: "sc_req_item",
    sourceId: currentId,
    fields: { "variables.plain_note": entry },
  }, macro, true);
  const route = { href: "https://example.service-now.com/now/sow/record/sc_req_item/" + currentId };
  const request = [{
    name: "plain_note",
    fieldName: "variables.plain_note",
    questionId: id(964),
    type: "6",
    dateKind: "",
  }];
  const selected = workspaceSnapshotProbe(
    workspaceDocument([macro, stale, current]),
    route
  )(request);
  assert.strictEqual(selected.identityStatus, "verified");
  assert.strictEqual(selected.perVariable[0].liveValue, "current");

  const duplicateVisible = workspaceElement("sn-catalog-form", {
    sourceTable: "sc_req_item",
    sourceId: currentId,
    fields: {},
  }, macro, true);
  const refused = workspaceSnapshotProbe(
    workspaceDocument([macro, current, duplicateVisible]),
    route
  )([]);
  assert.strictEqual(refused.identityStatus, "refused");
  assert.match(refused.identityReason, /More than one Workspace catalog form/);
});

test("Workspace entry referring identity is optional as a complete pair", () => {
  const currentId = id(971);
  const questionId = id(972);
  const macro = workspaceElement("macroponent-current", {
    table: "sc_req_item",
    sysId: currentId,
  });
  const entry = {
    id: questionId,
    name: "variables.plain_note",
    visible: true,
    canRead: true,
    value: "live",
    displayValue: "live",
  };
  const form = workspaceElement("sn-catalog-form", {
    sourceTable: "sc_req_item",
    sourceId: currentId,
    fields: { "variables.plain_note": entry },
  }, macro, true);
  const snapshot = workspaceSnapshotProbe(
    workspaceDocument([macro, form]),
    { href: "https://example.service-now.com/now/sow/record/sc_req_item/" + currentId }
  )([{
    name: "plain_note",
    fieldName: "variables.plain_note",
    questionId,
    type: "6",
    dateKind: "",
  }]);
  assert.strictEqual(snapshot.identityStatus, "verified");
  assert.strictEqual(snapshot.perVariable[0].liveValue, "live");
});

test("Workspace entry referring identity half-pairs and mismatches refuse atomically", () => {
  const currentId = id(973);
  const otherId = id(974);
  const questionId = id(975);
  const request = [{
    name: "plain_note",
    fieldName: "variables.plain_note",
    questionId,
    type: "6",
    dateKind: "",
  }];
  const probeFor = (extra) => {
    const macro = workspaceElement("macroponent-current", {
      table: "sc_req_item",
      sysId: currentId,
    });
    const form = workspaceElement("sn-catalog-form", {
      sourceTable: "sc_req_item",
      sourceId: currentId,
      fields: {
        "variables.plain_note": {
          id: questionId,
          name: "variables.plain_note",
          visible: true,
          canRead: true,
          value: "live",
          displayValue: "live",
          ...extra,
        },
      },
    }, macro, true);
    return workspaceSnapshotProbe(
      workspaceDocument([macro, form]),
      { href: "https://example.service-now.com/now/sow/record/sc_req_item/" + currentId }
    )(request);
  };
  for (const snapshot of [
    probeFor({ referringTable: "sc_req_item" }),
    probeFor({ referringRecordId: currentId }),
    probeFor({ referringTable: "sc_req_item", referringRecordId: otherId }),
  ]) {
    assert.strictEqual(snapshot.identityStatus, "refused");
    assert.strictEqual(snapshot.perVariable.length, 0);
  }
});

test("Workspace missing mandatory entry identity stays uncompared without poisoning siblings", () => {
  const currentId = id(976);
  const questionId = id(977);
  const macro = workspaceElement("macroponent-current", {
    table: "sc_req_item",
    sysId: currentId,
  });
  const form = workspaceElement("sn-catalog-form", {
    sourceTable: "sc_req_item",
    sourceId: currentId,
    fields: {
      "variables.plain_note": {
        name: "variables.plain_note",
        visible: true,
        canRead: true,
        value: "must-not-be-read",
      },
    },
  }, macro, true);
  const snapshot = workspaceSnapshotProbe(
    workspaceDocument([macro, form]),
    { href: "https://example.service-now.com/now/sow/record/sc_req_item/" + currentId }
  )([{
    name: "plain_note",
    fieldName: "variables.plain_note",
    questionId,
    type: "6",
    dateKind: "",
  }]);
  assert.strictEqual(snapshot.identityStatus, "verified");
  assert.strictEqual(snapshot.perVariable[0].identityUnavailable, true);
  assert.strictEqual(snapshot.perVariable[0].liveValueAvailable, false);
});

test("Workspace snapshot never touches value getters unless canRead is exactly true", () => {
  const currentId = id(965);
  const macro = workspaceElement("macroponent-current", {
    table: "sc_req_item",
    sysId: currentId,
  });
  let touched = false;
  const denied = {
    id: id(966),
    name: "variables.denied",
    referringTable: "sc_req_item",
    referringRecordId: currentId,
    visible: true,
    canRead: false,
  };
  Object.defineProperties(denied, {
    value: { get() { touched = true; throw new Error("denied value"); } },
    displayValue: { get() { touched = true; throw new Error("denied display"); } },
  });
  const form = workspaceElement("sn-catalog-form", {
    sourceTable: "sc_req_item",
    sourceId: currentId,
    fields: { "variables.denied": denied },
  }, macro, true);
  const snapshot = workspaceSnapshotProbe(
    workspaceDocument([macro, form]),
    { href: "https://example.service-now.com/now/sow/record/sc_req_item/" + currentId }
  )([{
    name: "denied",
    fieldName: "variables.denied",
    questionId: id(966),
    type: "6",
    dateKind: "",
  }]);
  assert.strictEqual(snapshot.identityStatus, "verified");
  assert.strictEqual(snapshot.perVariable[0].canRead, false);
  assert.strictEqual(snapshot.perVariable[0].liveValueAvailable, false);
  assert.strictEqual(touched, false);
});

test("Workspace snapshot does not forward non-string Select Box representations", () => {
  const currentId = id(983);
  const questionId = id(984);
  const macro = workspaceElement("macroponent-current", {
    table: "sc_req_item",
    sysId: currentId,
  });
  const form = workspaceElement("sn-catalog-form", {
    sourceTable: "sc_req_item",
    sourceId: currentId,
    fields: {
      "variables.choice_box": {
        id: questionId,
        name: "variables.choice_box",
        referringTable: "sc_req_item",
        referringRecordId: currentId,
        visible: true,
        canRead: true,
        value: 1,
        displayValue: { label: "One" },
      },
    },
  }, macro, true);
  const snapshot = workspaceSnapshotProbe(
    workspaceDocument([macro, form]),
    { href: "https://example.service-now.com/now/sow/record/sc_req_item/" + currentId }
  )([{
    name: "choice_box",
    fieldName: "variables.choice_box",
    questionId,
    type: "5",
    dateKind: "",
  }]);

  assert.strictEqual(snapshot.identityStatus, "verified");
  assert.strictEqual(snapshot.perVariable[0].canRead, true);
  assert.strictEqual(snapshot.perVariable[0].liveValueAvailable, false);
  assert.strictEqual(snapshot.perVariable[0].liveDisplayValueAvailable, false);

  const helpers = loadNativeHelpers();
  const choiceDef = definition({ name: "choice_box", type: "5", questionId });
  const [row] = helpers.buildNativeVariableRows(
    [choiceDef],
    { storedReadStatus: "success", metadataRows: [storedRow(choiceDef, "1")] },
    snapshot.perVariable,
    { workspace: true, workspaceSurfaceKey: SOW, timeZone: "Europe/London", zoneSource: "page" }
  );
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /value unavailable/i);
});

test("Workspace rows compare only after layer-specific representation validation", () => {
  const helpers = loadNativeHelpers();
  const textDef = definition({ name: "plain_note", type: "6", questionId: id(967) });
  const textStored = storedRow(textDef, "live");
  const live = {
    name: textDef.name,
    questionId: textDef.questionId,
    foundEntry: true,
    visible: true,
    canRead: true,
    liveValueAvailable: true,
    liveValue: "live",
    liveDisplayValueAvailable: true,
    liveDisplayValue: "live",
    liveLayer: 1,
  };
  const [matched] = helpers.buildNativeVariableRows(
    [textDef],
    { storedReadStatus: "success", metadataRows: [textStored] },
    [live],
    { workspace: true, workspaceSurfaceKey: SOW, timeZone: "Europe/London", zoneSource: "page" }
  );
  assert.strictEqual(matched.workspaceCandidate, true);
  assert.strictEqual(matched.comparison, "match");
  assert.strictEqual(matched.visibilityState, "visible");

  const [normalisedDisplay] = helpers.buildNativeVariableRows(
    [textDef],
    { storedReadStatus: "success", metadataRows: [textStored] },
    [{ ...live, liveDisplayValue: "live\r\n" }],
    { workspace: true, workspaceSurfaceKey: SOW, timeZone: "Europe/London", zoneSource: "page" }
  );
  assert.strictEqual(normalisedDisplay.comparison, "not-comparable");
  assert.match(normalisedDisplay.reason, /representation could not be verified/);
});

test("Workspace Select Box compares raw value while requiring the display pair shape", () => {
  const helpers = loadNativeHelpers();
  const choiceDef = definition({ name: "request_type", type: "5", questionId: id(982) });
  const stored = storedRow(choiceDef, "create_group");
  const live = {
    name: choiceDef.name,
    questionId: choiceDef.questionId,
    foundEntry: true,
    visible: true,
    canRead: true,
    liveValueAvailable: true,
    liveValue: "create_group",
    liveDisplayValueAvailable: true,
    liveDisplayValue: "Create Ownership Group",
    liveLayer: 1,
  };
  const build = (overrides) => helpers.buildNativeVariableRows(
    [choiceDef],
    { storedReadStatus: "success", metadataRows: [stored] },
    [{ ...live, ...overrides }],
    { workspace: true, workspaceSurfaceKey: SOW, timeZone: "Europe/London", zoneSource: "page" }
  )[0];

  assert.strictEqual(build({}).comparison, "match");
  assert.strictEqual(
    build({ liveDisplayValue: "create_group" }).comparison,
    "match",
    "a choice whose label equals its raw value remains comparable"
  );
  assert.strictEqual(
    build({ liveDisplayValue: "Create Ownership Group " }).comparison,
    "match",
    "display formatting is not substituted for the raw comparison value"
  );

  const rewritten = build({
    liveValue: "remove_group",
    liveDisplayValue: "Remove Ownership Group",
  });
  assert.strictEqual(rewritten.comparison, "differs");

  const emptyStored = storedRow(choiceDef, "");
  const [empty] = helpers.buildNativeVariableRows(
    [choiceDef],
    { storedReadStatus: "success", metadataRows: [emptyStored] },
    [{ ...live, liveValue: "", liveDisplayValue: "" }],
    { workspace: true, workspaceSurfaceKey: SOW, timeZone: "Europe/London", zoneSource: "page" }
  );
  assert.strictEqual(empty.comparison, "match");

  for (const malformed of [
    { liveDisplayValueAvailable: false },
    { liveValueAvailable: false },
  ]) {
    const row = build(malformed);
    assert.strictEqual(row.comparison, "not-comparable");
    assert.match(row.reason, /choice representation|value unavailable/i);
  }
});

test("Workspace visibility is tri-state and independent from canRead", () => {
  const helpers = loadNativeHelpers();
  const def = definition({ name: "plain_note", type: "6", questionId: id(968) });
  const stored = storedRow(def, "saved");
  const build = (live) => helpers.buildNativeVariableRows(
    [def],
    { storedReadStatus: "success", metadataRows: [stored] },
    live ? [{ name: def.name, questionId: def.questionId, foundEntry: true, ...live }] : [],
    { workspace: true, workspaceSurfaceKey: SOW, timeZone: "Europe/London", zoneSource: "page" }
  )[0];

  const deniedVisible = build({ visible: true, canRead: false });
  assert.strictEqual(deniedVisible.visibilityState, "visible");
  assert.strictEqual(deniedVisible.hidden, false);
  assert.strictEqual(deniedVisible.comparison, "not-comparable");
  assert.match(deniedVisible.reason, /not readable/);

  const hidden = build({ visible: false, canRead: false });
  assert.strictEqual(hidden.visibilityState, "hidden");
  assert.strictEqual(hidden.hidden, true);

  const unavailable = build(null);
  assert.strictEqual(unavailable.visibilityState, "unknown");
  assert.strictEqual(unavailable.hidden, null);
  assert.strictEqual(unavailable.bucket, "live-unavailable");
});

test("Workspace Date/Time proves raw UTC against the normalised display wall clock", () => {
  const helpers = loadNativeHelpers();
  const def = definition({ name: "when_needed", type: "10", questionId: id(969) });
  const stored = "2026-08-23 17:51:39";
  const live = {
    name: def.name,
    questionId: def.questionId,
    foundEntry: true,
    visible: true,
    canRead: true,
    liveValueAvailable: true,
    liveValue: stored,
    liveDisplayValueAvailable: true,
    liveDisplayValue: "23-08-2026 18:51:39",
    liveDateValue: "2026-08-23 18:51:39",
    liveDateNormalised: true,
    liveLayer: 1,
  };
  const row = (overrides, timeZone = "Europe/London") => helpers.buildNativeVariableRows(
    [def],
    { storedReadStatus: "success", metadataRows: [storedRow(def, stored)] },
    [{ ...live, ...(overrides || {}) }],
    { workspace: true, workspaceSurfaceKey: SOW, timeZone, zoneSource: timeZone ? "page" : "no-page-zone" }
  )[0];
  assert.strictEqual(row().comparison, "match");
  assert.strictEqual(row({ liveDateValue: stored }).comparison, "not-comparable");
  assert.strictEqual(row({}, "").comparison, "not-comparable");
});

test("a frame without the classic record marker is declined, not merely deprioritised", () => {
  const selectFrame = new Function(
    backgroundSource.slice(
      backgroundSource.indexOf("function selectClassicRecordFrame"),
      backgroundSource.indexOf("function inspectNativeRecordVariables")
    ) + "\nreturn selectClassicRecordFrame;"
  )();

  const marked = {
    foundGForm: true,
    recordMarkerMatched: true,
    identity: { table: "sc_req_item", sysId: RITM_ID },
    perVariable: [{ name: "a" }],
  };
  // A Workspace or embedded frame: a real g_form, no sys_target/sys_uniqueValue
  // agreement, and more variables than the classic frame -- so neither the
  // marker preference nor the variable-count tiebreak would exclude it.
  const workspace = {
    foundGForm: true,
    recordMarkerMatched: false,
    perVariable: [{ name: "a" }, { name: "b" }, { name: "c" }],
  };

  assert.strictEqual(selectFrame([workspace, marked]), marked);
  // The regression: with no marked frame at all, the answer is nothing, not
  // "the best of the markerless ones". The caller then reports no classic form
  // and the Service Portal path stays available.
  assert.strictEqual(selectFrame([workspace]), undefined);
  assert.strictEqual(selectFrame([]), undefined);
  assert.strictEqual(selectFrame(null), undefined);
  assert.strictEqual(selectFrame([{ foundGForm: false, recordMarkerMatched: true }]), undefined);

  const wrongRecord = {
    ...marked,
    identity: { table: "sc_req_item", sysId: id(999) },
    perVariable: [{ name: "wrong" }, { name: "larger" }],
  };
  assert.strictEqual(
    selectFrame([wrongRecord, marked], { table: "sc_req_item", sysId: RITM_ID }),
    marked,
    "a marker-qualified child for another Workspace record cannot win"
  );
  assert.strictEqual(
    selectFrame([wrongRecord], { table: "sc_req_item", sysId: RITM_ID }),
    undefined
  );
});

test("stored MRVS rows without a row index are withheld, not split into fabricated rows", async () => {
  // row_index is what groups cells into rows. Keying on read order instead
  // turns one real two-column row into two single-column rows, which the
  // comparison then reports as a confident row-count difference against the
  // live set.
  const helpers = loadNativeHelpers(async (table, query) => {
    if (table !== "sc_multi_row_question_answer") return [];
    if (query.startsWith("parent_id=")) {
      return [
        mrvsAnswerRow(id(950), "first", "", { row_index: "" }),
        mrvsAnswerRow(id(951), "second", "", { row_index: "not a number" }),
      ];
    }
    return [
      { sys_id: id(950), value: "one" },
      { sys_id: id(951), value: "two" },
    ];
  });
  const result = await helpers.fetchNativeMrvsStoredValues(RITM_ID, [MRVS_SET_ID]);
  const set = result.mrvsValuesBySetId.get(MRVS_SET_ID);
  assert.strictEqual(set.indexIncomplete, true, "both a missing and a malformed index count");

  const def = mrvsDefinition();
  const [row] = rowsFor(
    [def],
    [],
    [liveRow(def, '[{"first":"one","second":"two"}]')],
    "success",
    mrvsResult(MRVS_SET_ID, set)
  );
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /missing a row index/);
  // Specifically not the fabricated-difference report this replaces.
  assert.doesNotMatch(row.reason, /Stored has 2 rows/);
});

test("a well-indexed set is unaffected by the missing-index guard", async () => {
  const helpers = loadNativeHelpers(async (table, query) => {
    if (table !== "sc_multi_row_question_answer") return [];
    if (query.startsWith("parent_id=")) {
      return [mrvsAnswerRow(id(952), "first", 1), mrvsAnswerRow(id(953), "second", 1)];
    }
    return [
      { sys_id: id(952), value: "one" },
      { sys_id: id(953), value: "two" },
    ];
  });
  const result = await helpers.fetchNativeMrvsStoredValues(RITM_ID, [MRVS_SET_ID]);
  const set = result.mrvsValuesBySetId.get(MRVS_SET_ID);
  assert.strictEqual(set.indexIncomplete, false);
  assert.deepStrictEqual(set.rows, [{ first: "one", second: "two" }]);

  const def = mrvsDefinition();
  const [row] = rowsFor(
    [def],
    [],
    [liveRow(def, '[{"first":"one","second":"two"}]')],
    "success",
    mrvsResult(MRVS_SET_ID, set)
  );
  assert.strictEqual(row.comparison, "match");
});

test("a retired variable is listed only when it still holds stored data", async () => {
  // A deactivated variable never renders and never stores an answer, so
  // enumerating it produced a permanent "not stored" row for a field that is
  // not on the form at all.
  const live = definition({ name: "live_one", questionId: id(830) });
  const retired = definition({ name: "retired", questionId: id(831), inactive: true });
  const retiredWithData = definition({
    name: "retired_with_data",
    questionId: id(832),
    inactive: true,
  });
  const rows = rowsFor(
    [live, retired, retiredWithData],
    [storedRow(retiredWithData, "historical value")],
    []
  );
  assert.deepStrictEqual(rows.map((row) => row.name), ["live_one", "retired_with_data"]);
  // Data on an old record is never hidden, only labelled.
  const kept = rows.find((row) => row.name === "retired_with_data");
  assert.strictEqual(kept.inactive, true);
  assert.strictEqual(kept.storedValue, "historical value");
  assert.match(kept.reason, /^Inactive variable\./);

  // The flag comes from the definition read on both paths.
  const itemHelpers = loadNativeHelpers(async (table, query) => {
    if (table === "sc_req_item") return [{ cat_item: ITEM_ID }];
    if (table === "item_option_new" && query === "cat_item=" + ITEM_ID) {
      return [
        nativeDefinitionRow(live, { active: "true" }),
        nativeDefinitionRow(retired, { active: "false" }),
      ];
    }
    return [];
  });
  const ritm = await itemHelpers.fetchNativeRitmRecordData(RITM_ID);
  assert.deepStrictEqual(
    ritm.definitions.map((row) => [row.name, row.inactive]),
    [["live_one", false], ["retired", true]],
    "enumeration keeps the row so stored data can still attach to it"
  );
  assert.deepStrictEqual(
    itemHelpers.buildNativeVariableRows(ritm.definitions, ritm, []).map((row) => row.name),
    ["live_one"]
  );

  const producerHelpers = loadNativeHelpers(async (table, query) => {
    if (table === "question_answer" && query.startsWith("table_sys_id=")) {
      return [producerMetadataRow(retired, id(833), { "question.active": "false" })];
    }
    return [];
  });
  const producer = await producerHelpers.fetchNativeProducerRecordData("sn_example_case", RITM_ID);
  assert.strictEqual(producer.definitions[0].inactive, true);
});

test("layout-only variable types are dropped from the panel on every path", async () => {
  const helpers = loadNativeHelpers();
  // The policy entries survive the exclusion, so a row that somehow reaches the
  // comparison is still structural and still never fetched.
  ["11", "12", "14", "15", "17", "19", "20", "24", "32"].forEach((type) => {
    assert.deepStrictEqual(helpers.classifyNativeVariable(definition({ type })), {
      disposition: "structural",
    }, type);
  });

  const label = definition({
    name: "instructions",
    type: "32",
    typeDisplay: "Rich Text Label",
    questionId: id(810),
  });
  const kept = definition({ name: "kept", questionId: id(811) });
  const brk = definition({
    name: "page_break",
    type: "12",
    typeDisplay: "Break",
    questionId: id(814),
  });
  const caption = definition({
    name: "section_caption",
    type: "11",
    typeDisplay: "Label",
    questionId: id(815),
  });
  const containerStart = definition({
    name: "box_start",
    type: "19",
    typeDisplay: "Container Start",
    questionId: id(816),
  });
  const containerEnd = definition({
    name: "box_end",
    type: "20",
    typeDisplay: "Container End",
    questionId: id(817),
  });
  const customWidget = definition({
    name: "custom_widget",
    type: "14",
    typeDisplay: "Custom",
    questionId: id(818),
  });
  const uiPage = definition({
    name: "embedded_page",
    type: "15",
    typeDisplay: "UI Page",
    questionId: id(819),
  });
  const containerSplit = definition({
    name: "box_split",
    type: "24",
    typeDisplay: "Container Split",
    questionId: id(826),
  });
  const customWithLabel = definition({
    name: "captioned_widget",
    type: "17",
    typeDisplay: "Custom with Label",
    questionId: id(830),
  });
  const setId = id(812);
  const setLabel = definition({
    name: "set_instructions",
    type: "32",
    typeDisplay: "Rich Text Label",
    questionId: id(813),
    variableSet: setId,
  });

  const itemHelpers = loadNativeHelpers(async (table, query) => {
    if (table === "sc_req_item") return [{ cat_item: ITEM_ID }];
    if (table === "item_option_new" && query === "cat_item=" + ITEM_ID) {
      return [
        nativeDefinitionRow(label),
        nativeDefinitionRow(brk),
        nativeDefinitionRow(caption),
        nativeDefinitionRow(containerStart),
        nativeDefinitionRow(containerEnd),
        nativeDefinitionRow(customWidget),
        nativeDefinitionRow(uiPage),
        nativeDefinitionRow(containerSplit),
        nativeDefinitionRow(customWithLabel),
        nativeDefinitionRow(kept),
      ];
    }
    if (table === "io_set_item") return [{ variable_set: setId, order: "100" }];
    if (table === "item_option_new_set") {
      return [{ sys_id: setId, name: "set", internal_name: "set", title: "Set", type: { value: "", display_value: "" } }];
    }
    if (table === "item_option_new" && query === "variable_setIN" + setId) {
      return [nativeDefinitionRow(setLabel, { variable_set: setId })];
    }
    return [];
  });
  const ritm = await itemHelpers.fetchNativeRitmRecordData(RITM_ID);
  assert.deepStrictEqual(ritm.definitions.map((row) => row.name), ["kept"]);

  const producerHelpers = loadNativeHelpers(async (table, query) => {
    if (table === "question_answer" && query.startsWith("table_sys_id=")) {
      return [
        producerMetadataRow(label, id(820)),
        producerMetadataRow(brk, id(822)),
        producerMetadataRow(caption, id(823)),
        producerMetadataRow(containerStart, id(824)),
        producerMetadataRow(containerEnd, id(825)),
        producerMetadataRow(customWidget, id(827)),
        producerMetadataRow(uiPage, id(828)),
        producerMetadataRow(containerSplit, id(829)),
        producerMetadataRow(customWithLabel, id(831)),
        producerMetadataRow(kept, id(821)),
      ];
    }
    if (table === "question_answer" && query.startsWith("sys_idIN")) {
      assert.doesNotMatch(
        query,
        new RegExp([
          id(820), id(822), id(823), id(824), id(825), id(827), id(828), id(829),
          id(831),
        ].join("|")),
        "no value may be requested for an omitted layout variable"
      );
      return [{ sys_id: id(821), value: "stored" }];
    }
    return [];
  });
  const producer = await producerHelpers.fetchNativeProducerRecordData("sn_example_case", RITM_ID);
  assert.deepStrictEqual(producer.definitions.map((row) => row.name), ["kept"]);

  const portalStart = contentSource.indexOf("const VARIABLE_DEFINITION_FIELDS");
  const portalEnd = contentSource.indexOf("function nativeDefinitionFromRow", portalStart);
  const portal = await new Function(
    "snGetMany",
    nativeHelperSource() + contentSource.slice(portalStart, portalEnd) +
      "\nreturn { fetchCatalogItemVariableDefinitions };"
  )(async (table) => {
    if (table === "item_option_new") {
      return [
        nativeDefinitionRow(label),
        nativeDefinitionRow(brk),
        nativeDefinitionRow(caption),
        nativeDefinitionRow(containerStart),
        nativeDefinitionRow(containerEnd),
        nativeDefinitionRow(customWidget),
        nativeDefinitionRow(uiPage),
        nativeDefinitionRow(containerSplit),
        nativeDefinitionRow(customWithLabel),
        nativeDefinitionRow(kept),
      ];
    }
    return [];
  }).fetchCatalogItemVariableDefinitions(ITEM_ID);
  assert.deepStrictEqual(portal.variables.map((row) => row.name), ["kept"]);
});

test("scalar comparison flags an onLoad rewrite and preserves an empty stored value", () => {
  const def = definition();
  const [row] = rowsFor([def], [storedRow(def, "")], [liveRow(def, "populated")]);
  assert.strictEqual(row.storedPresent, true);
  assert.strictEqual(row.storedValue, "");
  assert.strictEqual(row.liveValue, "populated");
  assert.strictEqual(row.comparison, "differs");
  assert.match(row.reason, /Stored value is empty/);
});

test("reference and choice raw values compare equal without display-label false positives", () => {
  for (const type of ["5", "8"]) {
    const def = definition({ type, typeDisplay: type === "5" ? "Select Box" : "Reference" });
    const raw = type === "8" ? id(300) : "internal_value";
    const [row] = rowsFor([def], [storedRow(def, raw)], [liveRow(def, raw)]);
    assert.strictEqual(row.comparison, "match", type);
  }
});

test("Yes/No and Checkbox values use conservative boolean normalisation", () => {
  const helpers = loadNativeHelpers();
  for (const type of ["1", "7"]) {
    assert.deepStrictEqual(helpers.classifyNativeVariable(definition({ type })), {
      disposition: "comparable",
      comparisonMode: "boolean",
    });
  }
  assert.strictEqual(helpers.nativeValuesEqual("true", "1", "boolean"), true);
  assert.strictEqual(helpers.nativeValuesEqual("YES", "true", "boolean"), true);
  assert.strictEqual(helpers.nativeValuesEqual("false", "0", "boolean"), true);
  assert.strictEqual(helpers.nativeValuesEqual("No", "false", "boolean"), true);
  assert.strictEqual(helpers.nativeValuesEqual("true", "false", "boolean"), false);
  assert.strictEqual(
    helpers.nativeValuesEqual("", "false", "boolean"),
    false,
    "stored empty must stay distinct from a live false/default"
  );

  const checkbox = definition({ type: "7", typeDisplay: "Checkbox" });
  const [match] = rowsFor(
    [checkbox],
    [storedRow(checkbox, "true", { policy: { disposition: "comparable", comparisonMode: "boolean" } })],
    [liveRow(checkbox, "1")]
  );
  assert.strictEqual(match.comparison, "match");
});

test("List Collector comparison is a set: order, empty tokens, and duplicates are ignored", () => {
  const helpers = loadNativeHelpers();
  assert.strictEqual(helpers.nativeValuesEqual("a,b", "b,a", "set"), true);
  assert.strictEqual(helpers.nativeValuesEqual("a,,b,", "a,b", "set"), true);
  assert.strictEqual(helpers.nativeValuesEqual("a,b,b", "b,a", "set"), true);
  assert.strictEqual(helpers.nativeValuesEqual("a,b", "a,c", "set"), false);
  const def = definition({ type: "21", typeDisplay: "List Collector" });
  const [row] = rowsFor([def], [storedRow(def, "a,b")], [liveRow(def, "b,a")]);
  assert.strictEqual(row.comparison, "match");
});

test("the constructed prototype deny set covers every collision observed live", () => {
  const helpers = loadNativeHelpers();
  const observed = ["name", "constructor", "toString", "valueOf", "length", "hasOwnProperty", "__proto__"];
  observed.forEach((name) => assert.ok(helpers.NATIVE_PROTOTYPE_COLLISION_NAMES.has(name), name));
  const def = definition({ name: "name" });
  const [row] = rowsFor([def], [storedRow(def, "stored")], [liveRow(def, "")]);
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /prototype/);
});

test("duplicates are preserved and every duplicate is not comparable", () => {
  const first = definition({ name: "duplicate", questionId: id(401) });
  const second = definition({ name: "duplicate", questionId: id(402) });
  const rows = rowsFor(
    [first, second],
    [storedRow(first, "one"), storedRow(second, "two", { optionSysId: id(403) })],
    [liveRow(first, "one"), liveRow(second, "two")]
  );
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((row) => row.comparison === "not-comparable"));
  assert.ok(rows.every((row) => /Duplicate variable name/.test(row.reason)));
});

test("an empty stored read lists definitions, distinguishes absence, and reports no differences", () => {
  const def = definition();
  const [row] = rowsFor([def], [], [liveRow(def, "live")], "empty");
  assert.strictEqual(row.storedPresent, false);
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /no stored variable rows/i);
});

test("failed and truncated reads retain live values but run no comparison", () => {
  const def = definition();
  for (const status of ["failed", "truncated"]) {
    const [row] = rowsFor([def], [storedRow(def, "stored")], [liveRow(def, "live")], status);
    assert.strictEqual(row.liveValue, "live");
    assert.strictEqual(row.comparison, "not-comparable");
    assert.match(row.reason, /no comparison was run/);
  }
});

test("an unread MRVS reports that it was not read, never that it is not stored", () => {
  const def = mrvsDefinition();
  const [row] = rowsFor([def], [], [liveRow(def, '[{"a":"1"}]')], "empty");
  assert.strictEqual(row.bucket, "mrvs");
  assert.strictEqual(row.isMrvs, true);
  // The old behaviour rendered this as "(not stored)", which asserted a fact
  // about the record that no read had ever checked.
  assert.strictEqual(row.storedLookup, "not-read");
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /were not read/);
});

test("MRVS stored rows come from the multi-row read and compare structurally", () => {
  const def = mrvsDefinition();
  const stored = mrvsStored([{ a: "1", b: "x" }, { a: "2", b: "y" }]);
  const [row] = rowsFor(
    [def],
    [],
    [liveRow(def, '[{"b":"x","a":"1"},{"b":"y","a":"2"}]')],
    "success",
    mrvsResult(MRVS_SET_ID, stored)
  );
  assert.strictEqual(row.storedLookup, "found");
  assert.strictEqual(row.storedRowCount, 2);
  assert.strictEqual(row.liveRowCount, 2);
  // Key order differs on the two sides; that is not a difference.
  assert.strictEqual(row.comparison, "match");
  assert.match(row.reason, /rows match/);
});

test("MRVS row-count differences are reported with both counts", () => {
  const def = mrvsDefinition();
  const stored = mrvsStored([{ a: "1" }]);
  const [row] = rowsFor(
    [def],
    [],
    [liveRow(def, '[{"a":"1"},{"a":"2"}]')],
    "success",
    mrvsResult(MRVS_SET_ID, stored)
  );
  assert.strictEqual(row.comparison, "differs");
  assert.match(row.reason, /Stored has 1 row; the live form has 2\./);
});

test("MRVS cell differences are found inside an equal number of rows", () => {
  const def = mrvsDefinition();
  const stored = mrvsStored([{ a: "1", b: "old" }]);
  const [row] = rowsFor(
    [def],
    [],
    [liveRow(def, '[{"a":"1","b":"new"}]')],
    "success",
    mrvsResult(MRVS_SET_ID, stored)
  );
  assert.strictEqual(row.comparison, "differs");
  assert.match(row.reason, /rows differ/);
});

test("a checkbox column inside an MRVS compares by boolean meaning", () => {
  const def = mrvsDefinition();
  const stored = mrvsStored([{ flag: "0" }], { comparisonModes: { flag: "boolean" } });
  const [row] = rowsFor(
    [def],
    [],
    [liveRow(def, '[{"flag":"false"}]')],
    "success",
    mrvsResult(MRVS_SET_ID, stored)
  );
  assert.strictEqual(row.comparison, "match");
});

test("an absent MRVS key is compared as empty rather than as a difference", () => {
  const def = mrvsDefinition();
  const stored = mrvsStored([{ a: "1" }]);
  const [row] = rowsFor(
    [def],
    [],
    [liveRow(def, '[{"a":"1","b":""}]')],
    "success",
    mrvsResult(MRVS_SET_ID, stored)
  );
  assert.strictEqual(row.comparison, "match");
});

test("a withheld MRVS column blocks comparison and names the column", () => {
  const def = mrvsDefinition();
  const stored = mrvsStored([{ a: "1" }], { withheldColumns: ["secret_column"] });
  const [row] = rowsFor(
    [def],
    [],
    [liveRow(def, '[{"a":"1","secret_column":"shown"}]')],
    "success",
    mrvsResult(MRVS_SET_ID, stored)
  );
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /secret_column/);
});

test("an MRVS with no stored rows is reported as unstored, not as a difference", () => {
  const def = mrvsDefinition();
  const [row] = rowsFor(
    [def],
    [],
    [liveRow(def, '[{"a":"1"}]')],
    "success",
    mrvsResult(MRVS_SET_ID, null, "empty")
  );
  assert.strictEqual(row.storedLookup, "absent");
  assert.strictEqual(row.storedRowCount, 0);
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /No multi-row answers are stored/);
});

test("a set that read successfully but holds no rows still compares", () => {
  const def = mrvsDefinition();
  const [row] = rowsFor(
    [def],
    [],
    [liveRow(def, "[]")],
    "success",
    mrvsResult(MRVS_SET_ID, null, "success")
  );
  assert.strictEqual(row.storedLookup, "found");
  assert.strictEqual(row.storedValue, "[]");
  assert.strictEqual(row.comparison, "match");
});

test("an unreadable live MRVS value is not compared against stored rows", () => {
  const def = mrvsDefinition();
  const stored = mrvsStored([{ a: "1" }]);
  const [row] = rowsFor(
    [def],
    [],
    [liveRow(def, "not json")],
    "success",
    mrvsResult(MRVS_SET_ID, stored)
  );
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /readable JSON array/);
});

test("a failed ordinary stored read is reported as unread, not as an absent row", () => {
  const def = definition();
  const [row] = rowsFor([def], [], [liveRow(def, "live")], "failed");
  assert.strictEqual(row.storedLookup, "not-read");
  assert.strictEqual(row.comparison, "not-comparable");
});

test("an empty ordinary stored read is the one case that reports absence", () => {
  const def = definition();
  const [row] = rowsFor([def], [], [liveRow(def, "live")], "empty");
  assert.strictEqual(row.storedLookup, "absent");
});

test("MRVS values are read in two phases and only for allowlisted columns", async () => {
  const queries = [];
  const helpers = loadNativeHelpers(async (table, query, fields) => {
    queries.push({ table, query, fields });
    if (table !== "sc_multi_row_question_answer") return [];
    if (query.startsWith("parent_id=")) {
      return [
        mrvsAnswerRow(id(801), "plain", 1),
        mrvsAnswerRow(id(802), "password", 1, {
          "item_option_new.type": { value: "25", display_value: "Masked" },
        }),
      ];
    }
    return [{ sys_id: id(801), value: "kept" }];
  });

  const result = await helpers.fetchNativeMrvsStoredValues(RITM_ID, [MRVS_SET_ID]);
  assert.strictEqual(result.mrvsReadStatus, "success");

  const [metadataRead, valueRead] = queries;
  assert.doesNotMatch(metadataRead.fields, /(^|,)value(,|$)/);
  // The metadata read covers every set on the record, not only the enumerated
  // ones: a set the item no longer attaches has to be visible to be refused.
  assert.strictEqual(metadataRead.query, "parent_id=" + RITM_ID);
  assert.strictEqual(valueRead.fields, "sys_id,value");
  // The masked column's answer id must never enter the value request.
  assert.match(valueRead.query, new RegExp(id(801)));
  assert.doesNotMatch(valueRead.query, new RegExp(id(802)));

  const set = result.mrvsValuesBySetId.get(MRVS_SET_ID);
  assert.deepStrictEqual(set.rows, [{ plain: "kept" }]);
  assert.deepStrictEqual(set.withheldColumns, ["password"]);
});

test("MRVS rows are ordered by row_index, not by read order", async () => {
  const helpers = loadNativeHelpers(async (table, query) => {
    if (table !== "sc_multi_row_question_answer") return [];
    if (query.startsWith("parent_id=")) {
      return [
        mrvsAnswerRow(id(811), "a", 2),
        mrvsAnswerRow(id(812), "a", 1),
      ];
    }
    return [
      { sys_id: id(811), value: "second" },
      { sys_id: id(812), value: "first" },
    ];
  });

  const result = await helpers.fetchNativeMrvsStoredValues(RITM_ID, [MRVS_SET_ID]);
  assert.deepStrictEqual(
    result.mrvsValuesBySetId.get(MRVS_SET_ID).rows,
    [{ a: "first" }, { a: "second" }]
  );
});

test("no multi-row read is issued when the item has no multi-row set", async () => {
  let read = false;
  const helpers = loadNativeHelpers(async () => {
    read = true;
    return [];
  });
  const result = await helpers.fetchNativeMrvsStoredValues(RITM_ID, []);
  assert.strictEqual(result.mrvsReadStatus, "skipped");
  assert.strictEqual(read, false);
});

test("a capped multi-row read is truncated rather than treated as complete", async () => {
  const helpers = loadNativeHelpers(async (table, query) => {
    if (table !== "sc_multi_row_question_answer") return [];
    if (!query.startsWith("parent_id=")) return [];
    return Array.from({ length: 1000 }, (unused, index) =>
      mrvsAnswerRow(id(2000 + index), "a", index + 1)
    );
  });
  const result = await helpers.fetchNativeMrvsStoredValues(RITM_ID, [MRVS_SET_ID]);
  assert.strictEqual(result.mrvsReadStatus, "truncated");
  assert.strictEqual(result.mrvsValuesBySetId.size, 0);
});

test("record identity accepts only the same classic record before and after the reads", () => {
  const helpers = loadNativeHelpers();
  const initial = { table: "sc_req_item", sysId: RITM_ID };
  assert.strictEqual(helpers.nativeRecordIdentityMatches(initial, { ...initial }), true);
  assert.strictEqual(
    helpers.nativeRecordIdentityMatches(initial, { table: "sc_req_item", sysId: id(999) }),
    false,
    "record movement must be rejected"
  );
  assert.strictEqual(
    helpers.nativeRecordIdentityMatches(initial, { table: "sc_task", sysId: RITM_ID }),
    false,
    "a different table must be rejected"
  );
  assert.strictEqual(
    helpers.nativeRecordIdentityMatches(
      { table: "sn_example_case", sysId: RITM_ID },
      { table: "sn_example_case", sysId: RITM_ID }
    ),
    true,
    "a stable record producer target is valid"
  );
});

test("metadata-first reading never requests secret, unknown, or missing-definition values", async () => {
  const safe = definition({ name: "safe", questionId: id(501) });
  const secret = definition({ name: "ordinary_name", type: "25", typeDisplay: "Masked", questionId: id(502) });
  const unknown = definition({ name: "unknown", type: "999", typeDisplay: "Future Type", questionId: id(503) });
  const safeOption = id(511);
  const secretOption = id(512);
  const unknownOption = id(513);
  const inaccessibleOption = id(514);
  const requests = [];
  const helpers = loadNativeHelpers(async (table, query, fields, limit) => {
    requests.push({ table, query, fields, limit });
    if (table === "sc_item_option_mtom") {
      return [
        metadataRow(safe, safeOption),
        metadataRow(secret, secretOption),
        metadataRow(unknown, unknownOption),
        metadataRow(definition({ name: "orphan", questionId: id(599) }), inaccessibleOption),
      ];
    }
    if (table === "sc_item_option") {
      assert.match(query, new RegExp(safeOption));
      assert.doesNotMatch(query, new RegExp(secretOption + "|" + unknownOption + "|" + inaccessibleOption));
      return [{ sys_id: safeOption, value: "safe stored value" }];
    }
    return [];
  });

  const result = await helpers.fetchNativeRitmStoredValues(
    RITM_ID,
    [safe, secret, unknown],
    "success"
  );
  assert.strictEqual(result.storedReadStatus, "success");
  assert.strictEqual(requests[0].table, "sc_item_option_mtom");
  assert.doesNotMatch(requests[0].fields, /(^|,)value(,|$)|\.value/);
  assert.deepStrictEqual(requests.filter((request) => request.table === "sc_item_option").length, 1);
  const secretResult = result.metadataRows.find((row) => row.optionSysId === secretOption);
  assert.strictEqual(secretResult.secret, true);
  assert.strictEqual(secretResult.storedValue, null);
  assert.strictEqual(secretResult.valueAvailable, false);
});

test("record producer answers use the same metadata-first allowlist without fetching secrets", async () => {
  const safe = definition({ name: "safe_checkbox", type: "7", typeDisplay: "Checkbox", questionId: id(551) });
  const yesNo = definition({ name: "safe_yes_no", type: "1", typeDisplay: "Yes/No", questionId: id(554) });
  const secret = definition({ name: "ordinary_answer", type: "25", typeDisplay: "Masked", questionId: id(552) });
  const unknown = definition({ name: "future_answer", type: "999", typeDisplay: "Future Type", questionId: id(553) });
  const safeAnswer = id(561);
  const yesNoAnswer = id(564);
  const secretAnswer = id(562);
  const unknownAnswer = id(563);
  const requests = [];
  const helpers = loadNativeHelpers(async (table, query, fields, limit) => {
    requests.push({ table, query, fields, limit });
    assert.strictEqual(table, "question_answer");
    if (query.startsWith("table_sys_id=")) {
      assert.match(query, /\^table_name=sn_example_case$/);
      assert.doesNotMatch(fields, /(^|,)value(,|$)/);
      return [
        producerMetadataRow(safe, safeAnswer),
        producerMetadataRow(yesNo, yesNoAnswer),
        producerMetadataRow(secret, secretAnswer),
        producerMetadataRow(unknown, unknownAnswer),
      ];
    }
    assert.match(query, new RegExp(safeAnswer));
    assert.match(query, new RegExp(yesNoAnswer));
    assert.doesNotMatch(query, new RegExp(secretAnswer + "|" + unknownAnswer));
    return [
      { sys_id: safeAnswer, value: "true" },
      { sys_id: yesNoAnswer, value: "false" },
    ];
  });

  const result = await helpers.fetchNativeProducerRecordData("sn_example_case", RITM_ID);
  assert.strictEqual(result.recordProducerFound, true);
  assert.strictEqual(result.storedReadStatus, "success");
  assert.strictEqual(result.definitions.length, 4);
  assert.strictEqual(requests.filter((request) => request.fields === "sys_id,value").length, 1);
  const secretResult = result.metadataRows.find((row) => row.optionSysId === secretAnswer);
  assert.strictEqual(secretResult.secret, true);
  assert.strictEqual(secretResult.storedValue, null);
  assert.strictEqual(secretResult.valueAvailable, false);
});

test("record producer definitions include unanswered variables and consolidate MRVS children", async () => {
  const safe = definition({ name: "safe_answer", questionId: id(570) });
  const unanswered = definition({ name: "unanswered", questionId: id(571) });
  const mrvsSetId = id(572);
  const mrvsChild = definition({
    name: "mrvs_child",
    questionId: id(573),
    variableSet: mrvsSetId,
  });
  const safeAnswer = id(574);
  const mrvsAnswer = id(575);
  const valueQueries = [];
  const helpers = loadNativeHelpers(async (table, query, fields) => {
    if (table === "question_answer" && query.startsWith("table_sys_id=")) {
      assert.doesNotMatch(fields, /(^|,)value(,|$)/);
      return [
        producerMetadataRow(safe, safeAnswer, { "question.cat_item": ITEM_ID }),
        producerMetadataRow(mrvsChild, mrvsAnswer, {
          "question.variable_set": mrvsSetId,
          "question.cat_item": "",
        }),
      ];
    }
    if (table === "item_option_new_set") {
      return [{
        sys_id: mrvsSetId,
        name: "example_rows",
        internal_name: "example_rows",
        title: "Example rows",
        type: { value: "one_to_many", display_value: "Multiple Rows" },
      }];
    }
    if (table === "item_option_new" && query === "cat_item=" + ITEM_ID) {
      return [nativeDefinitionRow(safe), nativeDefinitionRow(unanswered)];
    }
    if (table === "io_set_item") {
      return [{ variable_set: mrvsSetId, order: "200" }];
    }
    if (table === "item_option_new" && query === "variable_setIN" + mrvsSetId) {
      return [nativeDefinitionRow(mrvsChild, { variable_set: mrvsSetId })];
    }
    if (table === "question_answer" && query.startsWith("sys_idIN")) {
      valueQueries.push(query);
      return [{ sys_id: safeAnswer, value: "stored" }];
    }
    return [];
  });

  const result = await helpers.fetchNativeProducerRecordData("sn_example_case", RITM_ID);
  assert.strictEqual(result.definitionEnumerationStatus, "success");
  assert.deepStrictEqual(result.definitions.map((row) => row.name), [
    "safe_answer", "unanswered", "example_rows",
  ]);
  assert.strictEqual(result.definitions.some((row) => row.name === "mrvs_child"), false);
  const parent = result.definitions.find((row) => row.name === "example_rows");
  assert.strictEqual(parent.isMrvs, true);
  const childMetadata = result.metadataRows.find((row) => row.optionSysId === mrvsAnswer);
  assert.strictEqual(childMetadata.fetchAllowed, false);
  assert.strictEqual(childMetadata.valueAvailable, false);
  assert.strictEqual(valueQueries.length, 1);
  assert.match(valueQueries[0], new RegExp(safeAnswer));
  assert.doesNotMatch(valueQueries[0], new RegExp(mrvsAnswer));

  const rows = helpers.buildNativeVariableRows(result.definitions, result, []);
  assert.strictEqual(rows.find((row) => row.name === "unanswered").storedPresent, false);
  assert.strictEqual(rows.find((row) => row.name === "example_rows").bucket, "mrvs");
});

test("an answers-only producer still consolidates MRVS without guessing a producer definition", async () => {
  const mrvsSetId = id(580);
  const child = definition({ name: "child", questionId: id(581), variableSet: mrvsSetId });
  const answerId = id(582);
  let unexpectedRead = false;
  const helpers = loadNativeHelpers(async (table, query) => {
    if (table === "question_answer" && query.startsWith("table_sys_id=")) {
      return [producerMetadataRow(child, answerId, {
        "question.variable_set": mrvsSetId,
        "question.cat_item": "",
      })];
    }
    if (table === "item_option_new_set") {
      return [{
        sys_id: mrvsSetId,
        name: "rows",
        internal_name: "rows",
        title: "Rows",
        type: { value: "one_to_many", display_value: "Multiple Rows" },
      }];
    }
    // The multi-row read is expected: it is how the set's stored side is
    // resolved. It is keyed by the record, so it guesses no producer.
    if (table === "sc_multi_row_question_answer") return [];
    unexpectedRead = true;
    return [];
  });

  const result = await helpers.fetchNativeProducerRecordData("sn_example_case", RITM_ID);
  assert.strictEqual(result.definitionEnumerationStatus, "answers-only");
  assert.deepStrictEqual(result.definitions.map((row) => row.name), ["rows"]);
  assert.strictEqual(result.definitions[0].isMrvs, true);
  assert.strictEqual(result.metadataRows[0].fetchAllowed, false);
  assert.strictEqual(unexpectedRead, false, "shared-set reverse lookup must not guess a producer");
});

test("producer definition-read failure fetches no answer values", async () => {
  const def = definition({ name: "safe_answer", questionId: id(590) });
  const answerId = id(591);
  let valueRead = false;
  const helpers = loadNativeHelpers(async (table, query) => {
    if (table === "question_answer" && query.startsWith("table_sys_id=")) {
      return [producerMetadataRow(def, answerId, { "question.cat_item": ITEM_ID })];
    }
    if (table === "item_option_new" && query === "cat_item=" + ITEM_ID) {
      throw new Error("definition ACL denied");
    }
    if (table === "question_answer" && query.startsWith("sys_idIN")) valueRead = true;
    return [];
  });

  const result = await helpers.fetchNativeProducerRecordData("sn_example_case", RITM_ID);
  assert.strictEqual(result.definitionEnumerationStatus, "failed");
  assert.strictEqual(result.storedReadStatus, "failed");
  assert.strictEqual(result.metadataRows[0].fetchAllowed, false);
  assert.strictEqual(valueRead, false);
});

test("a classic record without question_answer rows is not claimed as a producer target", async () => {
  const helpers = loadNativeHelpers(async () => []);
  const result = await helpers.fetchNativeProducerRecordData("sn_example_case", RITM_ID);
  assert.strictEqual(result.recordProducerFound, false);
  assert.strictEqual(result.storedReadStatus, "empty");
  assert.deepStrictEqual(result.definitions, []);
});

test("record producer table identity is query-safe and fail-closed", async () => {
  const helpers = loadNativeHelpers(async () => {
    throw new Error("unsafe input reached the API");
  });
  await assert.rejects(
    () => helpers.fetchNativeProducerRecordData("sn_example_case^ORsys_idISNOTEMPTY", RITM_ID),
    /identity was not safe/
  );
});

test("record producer value failure keeps definitions and disables comparison", async () => {
  const def = definition({ name: "safe_answer", questionId: id(571) });
  const answerId = id(572);
  const helpers = loadNativeHelpers(async (_table, query) => {
    if (query.startsWith("table_sys_id=")) return [producerMetadataRow(def, answerId)];
    throw new Error("value ACL denied");
  });
  const result = await helpers.fetchNativeProducerRecordData("sn_example_case", RITM_ID);
  assert.strictEqual(result.recordProducerFound, true);
  assert.strictEqual(result.storedReadStatus, "failed");
  assert.strictEqual(result.definitions.length, 1);
  assert.strictEqual(result.metadataRows[0].valueAvailable, false);
});

test("record producer row-cap truncation is explicit and requests no values", async () => {
  let valueRead = false;
  const helpers = loadNativeHelpers(async (_table, query) => {
    if (!query.startsWith("table_sys_id=")) {
      valueRead = true;
      return [];
    }
    return Array.from({ length: 300 }, (_, index) => {
      const def = definition({ name: "answer_" + index, questionId: id(2000 + index) });
      return producerMetadataRow(def, id(2400 + index));
    });
  });
  const result = await helpers.fetchNativeProducerRecordData("sn_example_case", RITM_ID);
  assert.strictEqual(result.storedReadStatus, "truncated");
  assert.strictEqual(valueRead, false);
});

test("record producer values are batched into 50-row requests", async () => {
  const metadata = Array.from({ length: 51 }, (_, index) => {
    const def = definition({ name: "answer_" + index, questionId: id(3000 + index) });
    return producerMetadataRow(def, id(3400 + index));
  });
  const batchSizes = [];
  const helpers = loadNativeHelpers(async (_table, query) => {
    if (query.startsWith("table_sys_id=")) return metadata;
    const ids = query.slice("sys_idIN".length).split(",");
    batchSizes.push(ids.length);
    return ids.map((answerId) => ({ sys_id: answerId, value: "" }));
  });
  const result = await helpers.fetchNativeProducerRecordData("sn_example_case", RITM_ID);
  assert.strictEqual(result.storedReadStatus, "success");
  assert.deepStrictEqual(batchSizes, [50, 1]);
});

test("stored value requests are chunked into the existing 50-row Table API window", async () => {
  const definitions = [];
  const metadata = [];
  for (let index = 0; index < 51; index++) {
    const def = definition({ name: "v" + index, questionId: id(600 + index) });
    definitions.push(def);
    metadata.push(metadataRow(def, id(700 + index)));
  }
  const valueBatchSizes = [];
  const helpers = loadNativeHelpers(async (table, query) => {
    if (table === "sc_item_option_mtom") return metadata;
    const ids = query.slice("sys_idIN".length).split(",");
    valueBatchSizes.push(ids.length);
    return ids.map((sysId) => ({ sys_id: sysId, value: "" }));
  });
  const result = await helpers.fetchNativeRitmStoredValues(RITM_ID, definitions, "success");
  assert.strictEqual(result.storedReadStatus, "success");
  assert.deepStrictEqual(valueBatchSizes, [50, 1]);
  assert.ok(result.metadataRows.every((row) => row.valueAvailable));
});

test("row-cap truncation is explicit and prevents every value request", async () => {
  const sample = definition();
  let valueRead = false;
  const helpers = loadNativeHelpers(async (table) => {
    if (table === "sc_item_option_mtom") {
      return Array.from({ length: 300 }, (_, index) => metadataRow(
        definition({ name: "v" + index, questionId: id(800 + index) }),
        id(1200 + index)
      ));
    }
    valueRead = true;
    return [];
  });
  const result = await helpers.fetchNativeRitmStoredValues(RITM_ID, [sample], "success");
  assert.strictEqual(result.storedReadStatus, "truncated");
  assert.strictEqual(valueRead, false);
});

test("zero rows and stored-read failure have distinct statuses", async () => {
  const empty = await loadNativeHelpers(async () => []).fetchNativeRitmStoredValues(
    RITM_ID,
    [definition()],
    "success"
  );
  assert.strictEqual(empty.storedReadStatus, "empty");

  const failed = await loadNativeHelpers(async () => { throw new Error("denied"); })
    .fetchNativeRitmStoredValues(RITM_ID, [definition()], "success");
  assert.strictEqual(failed.storedReadStatus, "failed");
});

test("definition access failure aborts before stored metadata or live comparison", async () => {
  const calls = [];
  const helpers = loadNativeHelpers(async (table) => {
    calls.push(table);
    if (table === "sc_req_item") return [{ cat_item: ITEM_ID }];
    if (table === "item_option_new") throw new Error("definition denied");
    return [];
  });
  await assert.rejects(() => helpers.fetchNativeRitmRecordData(RITM_ID), /definition denied/);
  assert.strictEqual(calls.includes("sc_item_option_mtom"), false);
});

test("an inaccessible variable-set definition fails closed instead of guessing MRVS children", async () => {
  const helpers = loadNativeHelpers(async (table) => {
    if (table === "sc_req_item") return [{ cat_item: ITEM_ID }];
    if (table === "item_option_new") return [];
    if (table === "io_set_item") return [{ variable_set: id(960), order: "100" }];
    if (table === "item_option_new_set") return [];
    return [];
  });
  await assert.rejects(
    () => helpers.fetchNativeRitmRecordData(RITM_ID),
    /variable-set definitions were inaccessible/
  );
});

test("the MAIN-world probe uses fresh identity accessors and guards every variable call", () => {
  const start = backgroundSource.indexOf("function inspectNativeRecordVariables");
  const end = backgroundSource.indexOf("// Self-contained MAIN-world inspector for hidden", start);
  assert.ok(start >= 0 && end > start);
  const factory = new Function(
    "g_form",
    "document",
    "getComputedStyle",
    backgroundSource.slice(start, end) + "\nreturn inspectNativeRecordVariables;"
  );
  const calls = [];
  const form = {
    getTableName: () => "sc_req_item",
    getUniqueValue: () => RITM_ID,
    isVisible(name) { calls.push("visible:" + name); return true; },
    getValue(name) {
      calls.push("value:" + name);
      if (name === "variables.throws") throw new Error("bad key");
      return "live:" + name;
    },
  };
  const document = { getElementById: () => null };
  const probe = factory(form, document, () => ({ display: "block", visibility: "visible", opacity: "1" }));
  const result = probe([
    { name: "secret", fieldName: "variables.secret", questionId: id(901), secret: true, readValue: true },
    { name: "name", fieldName: "variables.name", questionId: id(902), secret: false, readValue: true },
    { name: "throws", fieldName: "variables.throws", questionId: id(903), secret: false, readValue: true },
    { name: "works", fieldName: "variables.works", questionId: id(904), secret: false, readValue: true },
  ]);
  assert.deepStrictEqual(result.identity, { table: "sc_req_item", sysId: RITM_ID });
  assert.strictEqual(calls.includes("value:secret"), false);
  assert.strictEqual(calls.includes("value:name"), false);
  assert.strictEqual(calls.includes("value:variables.throws"), true);
  assert.strictEqual(calls.includes("value:variables.works"), true, "one throw must not abort later reads");
  assert.strictEqual(
    result.perVariable.find((row) => row.name === "works").liveValue,
    "live:variables.works"
  );
  assert.match(backgroundSource.slice(start, end), /getUniqueValue/);
  assert.doesNotMatch(backgroundSource.slice(start, end), /getSysId|hasField|setValue/);
});

test("classic variables use the exact namespace and fail the whole live source closed when unsupported", () => {
  const start = backgroundSource.indexOf("function inspectNativeRecordVariables");
  const end = backgroundSource.indexOf("function inspectWorkspaceVariableSnapshot", start);
  const probe = new Function(
    "g_form",
    "document",
    "getComputedStyle",
    backgroundSource.slice(start, end) + "\nreturn inspectNativeRecordVariables;"
  )({
    getTableName: () => "sc_req_item",
    getUniqueValue: () => RITM_ID,
    isVisible: () => true,
    getValue(name) {
      return name.startsWith("variables.") ? "" : "record-field-value";
    },
  }, { getElementById: () => null }, () => ({}));
  const result = probe([{
    name: "requested_for",
    fieldName: "variables.requested_for",
    questionId: id(970),
    secret: false,
    readValue: true,
  }]);
  assert.strictEqual(result.variableNamespaceAvailable, false);
  assert.strictEqual(result.perVariable[0].liveValueAvailable, false);
  assert.strictEqual(result.perVariable[0].namespaceUnavailable, true);
});

test("secret native rows contain no values and copy output cannot disclose supplied sentinels", () => {
  const secret = definition({ name: "innocent_name", type: "25", typeDisplay: "Masked" });
  const [row] = rowsFor(
    [secret],
    [storedRow(secret, "STORED_SECRET", { secret: true, fetchAllowed: false, valueAvailable: false })],
    [liveRow(secret, "LIVE_SECRET")]
  );
  assert.strictEqual(row.secret, true);
  assert.strictEqual(row.storedValue, null);
  assert.strictEqual(row.liveValue, null);
  assert.strictEqual(row.comparison, "not-comparable");

  const isolated = {};
  const ui = new Function(
    "globalThis",
    "window",
    uiSource + "\nreturn globalThis.SNHiddenVariablesUI;"
  )(isolated, { top: null });
  const text = ui.formatResultsAsText(
    { rows: [{ ...row, storedValue: "STORED_SECRET", liveValue: "LIVE_SECRET" }] },
    [{ ...row, storedValue: "STORED_SECRET", liveValue: "LIVE_SECRET" }]
  );
  assert.doesNotMatch(text, /STORED_SECRET|LIVE_SECRET/);
  assert.match(text, /Values not read \(secret\)/);
});

test("the portal path now lists masked variables as secret and no longer treats type 18 as hidden", async () => {
  const helper = nativeHelperSource();
  const portalStart = contentSource.indexOf("const VARIABLE_DEFINITION_FIELDS");
  const portalEnd = contentSource.indexOf("function nativeDefinitionFromRow", portalStart);
  const factory = new Function(
    "snGetMany",
    helper + contentSource.slice(portalStart, portalEnd) +
      "\nreturn { fetchCatalogItemVariableDefinitions };"
  );
  const definitions = await factory(async (table) => {
    if (table === "item_option_new") {
      return [
        { sys_id: id(951), name: "ordinary", question_text: "Ordinary", type: { value: "25", display_value: "Masked" }, default_value: "DO_NOT_SHOW" },
        { sys_id: id(952), name: "lookup", question_text: "Lookup", type: { value: "18", display_value: "Lookup Select Box" }, default_value: "" },
      ];
    }
    return [];
  }).fetchCatalogItemVariableDefinitions(ITEM_ID);
  const masked = definitions.variables.find((row) => row.name === "ordinary");
  const lookup = definitions.variables.find((row) => row.name === "lookup");
  assert.ok(masked, "masked variable should no longer be omitted");
  assert.strictEqual(masked.secret, true);
  assert.strictEqual(masked.defaultValue, "");
  assert.strictEqual(lookup.hiddenType, false);
  const portalProbe = backgroundSource.slice(
    backgroundSource.indexOf("function inspectHiddenPortalVariables"),
    backgroundSource.indexOf("function mapPortalVariableAnchors")
  );
  assert.match(portalProbe, /variable\.secret[\s\S]*result\.results\.push\(entry\)[\s\S]*return/);
});

test("native panel source exposes comparison state, differing filter, and modal keyboard access", () => {
  assert.match(uiSource, /width:min\(1180px,calc\(100vw - 32px\)\)/);
  assert.match(uiSource, /data-filter="differs"/);
  assert.match(uiSource, /data-count="differs"/);
  assert.match(uiSource, /role="dialog" aria-modal="true"/);
  assert.match(uiSource, /role="list" aria-label="Catalog variables"/);
  assert.match(uiSource, /event\.key !== "Tab"/);
  assert.match(uiSource, /previousFocus\.focus/);
  assert.match(uiSource, /aria-pressed/);
});

test("Workspace stored-only copy is structurally incapable of claiming a comparison", () => {
  const isolated = {};
  const ui = new Function(
    "globalThis",
    "window",
    uiSource + "\nreturn globalThis.SNHiddenVariablesUI;"
  )(isolated, { top: null });
  const row = {
    mode: "native",
    name: "plain_note",
    label: "Plain note",
    type: "Single Line Text",
    bucket: "live-unavailable",
    secret: false,
    storedLookup: "found",
    storedValue: "saved",
    liveValueAvailable: false,
    comparison: "not-comparable",
    reason: "Live value unavailable.",
  };
  const result = {
    mode: "native",
    recordKind: "workspace",
    panelState: "stored-only",
    capabilities: {
      comparison: false,
      liveValues: false,
      differing: false,
      liveVisibility: false,
    },
    rows: [row],
  };
  const text = ui.formatResultsAsText(result, [row]);
  assert.match(text, /Stored Variables/);
  assert.match(text, /not compared[\s\S]*stored values only/i);
  assert.match(text, /Stored: saved/);
  assert.doesNotMatch(text, /\bLive:|\bMatch\b|\bDiffers\b|0 differing/i);
});

test("Workspace refusal and unavailable copy never claim stored-only values", () => {
  const isolated = {};
  const ui = new Function(
    "globalThis",
    "window",
    uiSource + "\nreturn globalThis.SNHiddenVariablesUI;"
  )(isolated, { top: null });
  const text = ui.formatResultsAsText({
    mode: "native",
    recordKind: "workspace",
    panelState: "refused",
    capabilities: {
      comparison: false,
      liveValues: false,
      differing: false,
      liveVisibility: false,
    },
    rows: [],
  }, []);
  assert.match(text, /GlideLens — Variable Values/);
  assert.doesNotMatch(text, /Stored Variables|stored values only/i);

  const unavailable = ui.formatResultsAsText({
    mode: "native",
    recordKind: "workspace",
    panelState: "stored-unavailable",
    capabilities: {
      comparison: false,
      liveValues: false,
      differing: false,
      liveVisibility: false,
    },
    rows: [],
  }, []);
  assert.match(unavailable, /Stored values were unavailable/);
  assert.doesNotMatch(unavailable, /Stored Variables|stored values only/i);
});

test("Workspace panel completeness is derived from final row verdicts", () => {
  const start = contentSource.indexOf("function workspaceDefinitionsComplete");
  const end = contentSource.indexOf("async function showWorkspaceVariableValues", start);
  const panelState = new Function(
    contentSource.slice(start, end) + "\nreturn workspacePanelState;"
  )();
  const completeRead = { definitionReadStatus: "success", storedReadStatus: "success" };
  assert.strictEqual(
    panelState(completeRead, "available", [
      { workspaceCandidate: true, comparison: "match" },
      { workspaceCandidate: true, comparison: "differs" },
    ]).panelState,
    "complete"
  );
  const partial = panelState(completeRead, "available", [
    { workspaceCandidate: true, comparison: "match" },
    { workspaceCandidate: true, comparison: "not-comparable" },
  ]);
  assert.deepStrictEqual(partial, {
    panelState: "partial",
    candidateCount: 2,
    checkedCount: 1,
    uncheckedCount: 1,
  });
  assert.strictEqual(
    panelState({ definitionReadStatus: "success", storedReadStatus: "empty" }, "available", [
      { workspaceCandidate: true, comparison: "not-comparable" },
    ]).panelState,
    "partial"
  );
  assert.strictEqual(panelState(completeRead, "available", []).panelState, "no-candidate");
  assert.strictEqual(
    panelState({ definitionReadStatus: "success", storedReadStatus: "empty" }, "absent", []).panelState,
    "no-editor-empty"
  );
  assert.strictEqual(
    panelState({ definitionReadStatus: "success", storedReadStatus: "failed" }, "absent", []).panelState,
    "stored-unavailable"
  );
  assert.strictEqual(
    panelState({ definitionReadStatus: "truncated", storedReadStatus: "truncated" }, "unavailable", []).panelState,
    "stored-unavailable"
  );

  // The producer reader reports enumeration under its own field name. Reading
  // only definitionReadStatus pinned every producer-backed Workspace panel to
  // "partial" while claiming a complete check in its own row counts.
  const producerComplete = {
    definitionEnumerationStatus: "success",
    storedReadStatus: "success",
  };
  assert.strictEqual(
    panelState(producerComplete, "available", [
      { workspaceCandidate: true, comparison: "match" },
    ]).panelState,
    "complete"
  );
  assert.strictEqual(
    panelState(
      { definitionEnumerationStatus: "answers-only", storedReadStatus: "success" },
      "available",
      [{ workspaceCandidate: true, comparison: "match" }]
    ).panelState,
    "complete"
  );
  // A truncated or failed enumeration is not complete, and a producer record
  // must never inherit completeness from the RITM field being absent.
  ["truncated", "failed", "unavailable"].forEach((status) => {
    assert.strictEqual(
      panelState(
        { definitionEnumerationStatus: status, storedReadStatus: "success" },
        "available",
        [{ workspaceCandidate: true, comparison: "match" }]
      ).panelState,
      "partial",
      status + " enumeration must not read as complete"
    );
  });
});

/*
 * The MAIN-world snapshot re-derives the route itself and cannot close over
 * extension scope, so the surface allowlist exists twice on purpose. Nothing
 * but a test stops the two copies drifting, and a drift is silent: the router
 * would start a read the snapshot then refuses, or worse, the snapshot would
 * answer for a surface the router never verified.
 */
test("both worlds gate Workspace on the same surface allowlist", () => {
  const surfaces = new Function(
    contentSource.slice(
      contentSource.indexOf("const WORKSPACE_SUPPORTED_SURFACES"),
      contentSource.indexOf("function workspaceSurfaceKey")
    ) + "; return WORKSPACE_SUPPORTED_SURFACES;"
  )();
  const contentKeys = surfaces.map(
    (surface) => surface.experiencePath.join("/") + ":" + surface.table
  );

  const probeStart = backgroundSource.indexOf("const supportedSurfaces = [");
  assert.ok(probeStart >= 0, "the MAIN-world surface list was not found");
  const probeEnd = backgroundSource.indexOf("];", probeStart);
  const backgroundKeys = backgroundSource
    .slice(probeStart, probeEnd)
    .match(/"[^"]+"/g)
    .map((quoted) => quoted.slice(1, -1));

  assert.deepStrictEqual(backgroundKeys, contentKeys);

  // And the type policy map is keyed by the same strings, so no allowlisted
  // surface can reach a live read with no policy of its own.
  const helpers = loadNativeHelpers();
  assert.deepStrictEqual(
    Array.from(helpers.WORKSPACE_TYPE_POLICIES_BY_SURFACE.keys()),
    contentKeys
  );
});

test("the MAIN-world snapshot refuses an unlisted Workspace surface", () => {
  const probe = workspaceSnapshotProbe(
    { querySelectorAll: () => [] },
    {
      href:
        "https://example.service-now.com/now/psm/workspace/record/sc_req_item/" +
        id(1),
    }
  );
  const refused = probe([]);
  assert.strictEqual(refused.identityStatus, "refused");
  assert.strictEqual(refused.formStatus, "refused");
  assert.deepStrictEqual(refused.perVariable, []);
  assert.match(refused.identityReason, /not a supported Workspace record route/);
});

test("native orchestration constrains classic frames on Workspace and keeps portal fallback", () => {
  const start = contentSource.indexOf("async function probeNativeRecordVariables");
  const end = contentSource.indexOf("/* =====================================================================", start);
  const flow = contentSource.slice(start, end);
  const nativeStart = flow.indexOf("async function showNativeRitmVariableValues");
  const commandStart = flow.indexOf("async function showVariableValues");
  const nativeFlow = flow.slice(nativeStart, commandStart);
  const commandFlow = flow.slice(commandStart);
  assert.ok(
    commandFlow.indexOf("workspaceRecordContextFromText(location.href)") >= 0 &&
    commandFlow.indexOf("workspaceRecordContextFromText(location.href)") <
      commandFlow.indexOf("probeNativeRecordVariables([], {")
  );
  assert.match(commandFlow, /expectedIdentity:\s*workspaceRoute/);
  assert.match(commandFlow, /softNoMatchOnFailure:\s*Boolean\(workspaceRoute\)/);
  assert.match(commandFlow, /showNativeRitmVariableValues\(initialProbe, workspaceRoute\)/);
  assert.ok(
    nativeFlow.indexOf("fetchNativeRitmRecordData") >= 0 &&
    nativeFlow.indexOf("finishNativeVariableValues") >
      nativeFlow.indexOf("fetchNativeRitmRecordData")
  );
  assert.match(flow, /nativeRecordIdentityMatches\(initialIdentity, finalIdentity\)/);
  assert.match(flow, /workspaceRecordContextFromText\(location\.href\)/);
  assert.match(commandFlow, /showNativeProducerVariableValues\(initialProbe, workspaceRoute\)/);
  assert.match(flow, /fetchNativeProducerRecordData/);
  assert.match(commandFlow, /showWorkspaceVariableValues\(/);
  assert.match(flow, /await showHiddenPortalVariables\(\)/);
});

test("Workspace transport is pinned to frame zero and classic failures soften only with expected identity", () => {
  const workspaceHandler = backgroundSource.slice(
    backgroundSource.indexOf('msg.type === "GET_WORKSPACE_VARIABLE_SNAPSHOT"'),
    backgroundSource.indexOf('msg.type === "GET_NATIVE_RECORD_VARIABLES"')
  );
  assert.match(workspaceHandler, /sender\.frameId !== 0/);
  assert.match(workspaceHandler, /injectInFrame\([\s\S]*sender\.tab\.id,[\s\S]*0,[\s\S]*world: "MAIN"/);
  assert.doesNotMatch(workspaceHandler, /readFromPageFrames|discoverContentFrames/);

  const classicHandler = backgroundSource.slice(
    backgroundSource.indexOf('msg.type === "GET_NATIVE_RECORD_VARIABLES"'),
    backgroundSource.indexOf('msg.type === "GET_HIDDEN_PORTAL_VARIABLES"')
  );
  assert.match(classicHandler, /softNoMatchOnFailure && expectedIdentity/);
  assert.match(classicHandler, /probeInconclusive:\s*true/);
  assert.ok(
    classicHandler.indexOf("if (softNoMatchOnFailure)") <
      classicHandler.indexOf("inconclusiveError")
  );
});

test("the feature adds no permission, allFrames injection, writes, or native setValue calls", () => {
  const manifest = JSON.parse(manifestSource);
  assert.deepStrictEqual(manifest.permissions, ["scripting", "storage", "clipboardWrite"]);
  const nativeBackground = backgroundSource.slice(
    backgroundSource.indexOf("function inspectNativeRecordVariables"),
    backgroundSource.indexOf("// Self-contained MAIN-world inspector for hidden")
  );
  assert.doesNotMatch(nativeBackground, /allFrames|setValue|fetch\(|console\./);
  const nativeContent = contentSource.slice(
    contentSource.indexOf("const NATIVE_VARIABLE_TYPE_POLICIES"),
    contentSource.indexOf("/* =====================================================================", contentSource.indexOf("async function showVariableValues"))
  );
  assert.doesNotMatch(nativeContent, /setValue\s*\(|console\./);
});

/*
 * End-to-end reproduction of the reported symptom: a producer-backed classic
 * record whose multi-row variable sets rendered "(not stored)" while the live
 * form held rows. Drives the real producer reader, row builder, and copy
 * formatter over a stubbed Table API.
 */
test("a producer-backed record reads its multi-row sets instead of reporting them unstored", async () => {
  const RECORD_ID = id(1100);
  const direct = definition({ name: "requested_for", questionId: id(1101), type: "8", typeDisplay: "Reference" });
  const mrvsChild = definition({
    name: "bank_name",
    questionId: id(1102),
    variableSet: MRVS_SET_ID,
  });
  const setRow = {
    sys_id: MRVS_SET_ID,
    name: "bank_accounts",
    internal_name: "bank_accounts",
    title: "Bank Accounts",
    type: { value: "one_to_many", display_value: "Multiple Rows" },
  };

  const helpers = loadNativeHelpers(async (table, query, fields) => {
    if (table === "question_answer" && query.startsWith("table_sys_id=")) {
      return [producerMetadataRow(direct, id(1200), { "question.cat_item": ITEM_ID })];
    }
    if (table === "question_answer" && query.startsWith("sys_idIN")) {
      return [{ sys_id: id(1200), value: "abel.tuter" }];
    }
    if (table === "item_option_new_set") return [setRow];
    if (table === "item_option_new" && query === "cat_item=" + ITEM_ID) {
      return [nativeDefinitionRow(direct)];
    }
    if (table === "io_set_item") return [{ variable_set: MRVS_SET_ID, order: "100" }];
    if (table === "item_option_new" && query.startsWith("variable_setIN")) {
      return [nativeDefinitionRow(mrvsChild)];
    }
    if (table === "sc_multi_row_question_answer" && query.startsWith("parent_id=")) {
      // Every set on the record, so a detached one can be seen and refused.
      assert.strictEqual(query, "parent_id=" + RECORD_ID);
      assert.doesNotMatch(fields, /(^|,)value(,|$)/);
      return [
        mrvsAnswerRow(id(1301), "bank_name", 1, { parent_id: RECORD_ID }),
        mrvsAnswerRow(id(1302), "bank_country", 1, { parent_id: RECORD_ID }),
      ];
    }
    if (table === "sc_multi_row_question_answer") {
      return [
        { sys_id: id(1301), value: "HJ" },
        { sys_id: id(1302), value: "NL" },
      ];
    }
    return [];
  });

  const recordData = await helpers.fetchNativeProducerRecordData("sn_example_case", RECORD_ID);
  assert.strictEqual(recordData.mrvsReadStatus, "success");

  const parent = recordData.definitions.find((row) => row.isMrvs);
  assert.ok(parent, "the multi-row set should be listed as one parent row");
  const rows = helpers.buildNativeVariableRows(recordData.definitions, recordData, [
    liveRow(direct, "abel.tuter"),
    liveRow(parent, '[{"bank_country":"NL","bank_name":"HJ"}]'),
  ]);

  const mrvsRow = rows.find((row) => row.isMrvs);
  assert.strictEqual(mrvsRow.storedLookup, "found");
  assert.strictEqual(mrvsRow.storedRowCount, 1);
  assert.strictEqual(mrvsRow.comparison, "match");

  const ui = new Function(
    "globalThis",
    "window",
    uiSource + "\nreturn globalThis.SNHiddenVariablesUI;"
  )({}, { top: null });
  const text = ui.formatResultsAsText({ mode: "native", rows }, rows);
  assert.match(text, /1 row: \[\{"bank_name":"HJ","bank_country":"NL"\}\]/);
  assert.doesNotMatch(text, /\(not stored\)/);
});

/* ---------------------------------------------------------------------------
 * Multi-row variable sets on Workspace.
 *
 * The Workspace form exposes a set as one container entry: the raw value is a
 * JSON array of row objects and displayValue is the same array with display
 * labels substituted. That pair is what "mrvs-pair" verifies, and reading it
 * hands over every column of every row at once — which is why the read is
 * gated on the surface's proof, the classic column-safety rule, and a
 * per-surface allowlist of the column types the container renders raw.
 * ------------------------------------------------------------------------ */

function workspaceMrvsDefinition(overrides) {
  return mrvsDefinition(Object.assign({
    name: "bank_accounts",
    label: "Bank Accounts",
    liveReadAllowed: true,
    liveReadBlockedReason: "",
    mrvsColumnsSafe: true,
    mrvsColumnTypes: [
      { type: "6", label: "Single Line Text" },
      { type: "8", label: "Reference" },
    ],
  }, overrides || {}));
}

function workspaceMrvsLive(def, value, displayValue, overrides) {
  return Object.assign({
    name: def.name,
    questionId: def.questionId,
    foundEntry: true,
    visible: true,
    canRead: true,
    liveValueAvailable: true,
    liveValue: value,
    liveDisplayValueAvailable: displayValue != null,
    liveDisplayValue: displayValue == null ? "" : displayValue,
    liveLayer: 1,
  }, overrides || {});
}

function workspaceMrvsRow(def, stored, liveEntry, surfaceKey) {
  return loadNativeHelpers().buildNativeVariableRows(
    [def],
    Object.assign(
      { storedReadStatus: "success", metadataRows: [] },
      mrvsResult(def.variableSet, mrvsStored(stored, {
        comparisonModes: { bank_name: "scalar", bank_country: "scalar" },
      }))
    ),
    liveEntry ? [liveEntry] : [],
    {
      workspace: true,
      workspaceSurfaceKey: surfaceKey === undefined ? SUPPLIER_CASE : surfaceKey,
      timeZone: "Europe/London",
      zoneSource: "page",
    }
  )[0];
}

const MRVS_RAW = '[{"bank_name":"HJ","bank_country":"0d38b7111b121100763d91eebc0713e8"}]';
const MRVS_DISPLAY = '[{"bank_name":"HJ","bank_country":"Netherlands"}]';
const MRVS_STORED = [{ bank_name: "HJ", bank_country: "0d38b7111b121100763d91eebc0713e8" }];

test("a Workspace multi-row set is requested and compared where the surface proves it", () => {
  const api = liveRequestApi();
  const def = workspaceMrvsDefinition();
  const requests = api.workspaceLiveValueRequests([def], SUPPLIER_CASE);
  assert.deepStrictEqual(requests, [{
    name: "bank_accounts",
    fieldName: "variables.bank_accounts",
    // The container entry is keyed by the variable set, which is exactly the
    // question id the MRVS definition carries, so the MAIN-world identity gate
    // needs no special case.
    questionId: MRVS_SET_ID,
    type: "34",
    dateKind: "",
    liveLayer: 1,
  }]);

  const row = workspaceMrvsRow(def, MRVS_STORED, workspaceMrvsLive(def, MRVS_RAW, MRVS_DISPLAY));
  assert.strictEqual(row.isMrvs, true);
  assert.strictEqual(row.workspaceCandidate, true);
  assert.strictEqual(row.storedRowCount, 1);
  assert.strictEqual(row.liveRowCount, 1);
  assert.strictEqual(row.comparison, "match");
  assert.match(row.reason, /Stored and live Workspace rows match/);

  // Key order differs between the reassembled stored side and the form's own
  // emission order, and that is not a difference.
  const reordered = workspaceMrvsRow(
    def,
    MRVS_STORED,
    workspaceMrvsLive(
      def,
      '[{"bank_country":"0d38b7111b121100763d91eebc0713e8","bank_name":"HJ"}]',
      '[{"bank_country":"Netherlands","bank_name":"HJ"}]'
    )
  );
  assert.strictEqual(reordered.comparison, "match");

  const changed = workspaceMrvsRow(
    def,
    MRVS_STORED,
    workspaceMrvsLive(
      def,
      '[{"bank_name":"KL","bank_country":"0d38b7111b121100763d91eebc0713e8"}]',
      '[{"bank_name":"KL","bank_country":"Netherlands"}]'
    )
  );
  assert.strictEqual(changed.comparison, "differs");
});

test("an unproven Workspace surface lists a multi-row set and says so plainly", () => {
  const api = liveRequestApi();
  const def = workspaceMrvsDefinition();
  // A surface with no policy map at all, and an empty key, are both covered:
  // neither may read the set, and neither may imply the form was asked.
  ["psm/workspace:sc_req_item", ""].forEach((surfaceKey) => {
    assert.deepStrictEqual(api.workspaceLiveValueRequests([def], surfaceKey), []);
    const row = workspaceMrvsRow(def, MRVS_STORED, null, surfaceKey);
    assert.strictEqual(row.isMrvs, true);
    assert.strictEqual(row.workspaceCandidate, false);
    assert.strictEqual(row.comparison, "not-comparable");
    // The stored side is still real, so the row is not empty.
    assert.strictEqual(row.storedLookup, "found");
    assert.strictEqual(row.storedRowCount, 1);
    assert.match(row.reason, /listed but not compared on this Workspace surface/);
    // The failure mode this replaces: wording that reads as a fact about the
    // form, when the form was never asked at all.
    assert.doesNotMatch(row.reason, /No live multi-row value was available/);
    assert.doesNotMatch(row.reason, /match/);
  });
});

test("a Workspace multi-row set is never read when a column type is unproven there", () => {
  const api = liveRequestApi();
  // A Date/Time column inside the container is rendered in the user's date
  // format and the session timezone, not raw, so a set holding one would
  // report a difference in a record where none exists.
  const withDateTime = workspaceMrvsDefinition({
    mrvsColumnTypes: [
      { type: "6", label: "Single Line Text" },
      { type: "10", label: "Date/Time" },
    ],
  });
  assert.deepStrictEqual(api.workspaceLiveValueRequests([withDateTime], SUPPLIER_CASE), []);
  const row = workspaceMrvsRow(withDateTime, MRVS_STORED, null);
  assert.strictEqual(row.workspaceCandidate, false);
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /has not verified how Date\/Time is represented inside a multi-row set/);

  // Column evidence does not transfer between surfaces either: a Checkbox
  // column is proven inside a supplier set and not inside a SOW one.
  const withCheckbox = workspaceMrvsDefinition({
    mrvsColumnTypes: [
      { type: "6", label: "Single Line Text" },
      { type: "7", label: "Checkbox" },
    ],
  });
  assert.strictEqual(
    api.workspaceLiveValueRequests([withCheckbox], SUPPLIER_CASE).length,
    1
  );
  assert.deepStrictEqual(api.workspaceLiveValueRequests([withCheckbox], SOW), []);

  // A set whose columns were never enumerated is refused, not assumed empty.
  const unknownColumns = workspaceMrvsDefinition({ mrvsColumnTypes: null });
  assert.deepStrictEqual(api.workspaceLiveValueRequests([unknownColumns], SUPPLIER_CASE), []);
  assert.match(
    workspaceMrvsRow(unknownColumns, MRVS_STORED, null).reason,
    /column definitions were not read/
  );

  // The classic all-columns-safe rule still gates the Workspace read.
  const unsafe = workspaceMrvsDefinition({
    liveReadAllowed: false,
    liveReadBlockedReason:
      "Live multi-row value was not read because its columns could not all be verified as safe and comparable.",
  });
  assert.deepStrictEqual(api.workspaceLiveValueRequests([unsafe], SUPPLIER_CASE), []);
  assert.match(
    workspaceMrvsRow(unsafe, MRVS_STORED, null).reason,
    /could not all be verified as safe and comparable/
  );
});

test("the Workspace multi-row representation is verified before any comparison", () => {
  const helpers = loadNativeHelpers();
  const policy = { disposition: "mrvs", validator: "mrvs-pair", layer: 1 };
  const source = (value, displayValue) => ({
    foundEntry: true,
    canRead: true,
    liveValueAvailable: true,
    liveValue: value,
    liveDisplayValueAvailable: displayValue != null,
    liveDisplayValue: displayValue == null ? "" : displayValue,
  });
  const verify = (value, displayValue) =>
    helpers.workspaceLiveValueForComparison(policy, source(value, displayValue), "");

  assert.deepStrictEqual(verify(MRVS_RAW, MRVS_DISPLAY), { ok: true, value: MRVS_RAW });
  assert.deepStrictEqual(verify("[]", "[]"), { ok: true, value: "[]" });

  // Every way the pair can fail to be the observed shape refuses rather than
  // falling through to a raw string comparison.
  [
    [MRVS_RAW, null],
    [MRVS_RAW, ""],
    [MRVS_RAW, '[{"bank_name":"HJ"}]'],
    [MRVS_RAW, "[]"],
    [MRVS_RAW, '["HJ"]'],
    ['{"bank_name":"HJ"}', '{"bank_name":"HJ"}'],
    ["not json", "not json"],
    ["[null]", "[null]"],
  ].forEach(([value, displayValue]) => {
    const verdict = verify(value, displayValue);
    assert.strictEqual(verdict.ok, false, JSON.stringify([value, displayValue]));
    assert.match(verdict.reason, /multi-row representation could not be verified/);
  });

  // And the same refusal reaches the panel row rather than a comparison.
  const def = workspaceMrvsDefinition();
  const row = workspaceMrvsRow(
    def,
    MRVS_STORED,
    workspaceMrvsLive(def, MRVS_RAW, '[{"bank_name":"HJ"}]')
  );
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /multi-row representation could not be verified/);
});

test("Workspace candidates are exactly the rows a live read was requested for", () => {
  const api = liveRequestApi();
  const helpers = loadNativeHelpers();
  const definitions = [
    definition({ name: "short_text", type: "6", questionId: id(1401) }),
    definition({ name: "yes_no", type: "1", questionId: id(1402) }),
    definition({ name: "lookup", type: "18", questionId: id(1403) }),
    definition({ name: "attachment", type: "33", questionId: id(1404) }),
    definition({ name: "needed_by", type: "9", questionId: id(1405) }),
    workspaceMrvsDefinition(),
  ];
  const requested = api
    .workspaceLiveValueRequests(definitions, SUPPLIER_CASE)
    .map((request) => request.name)
    .sort();
  const candidates = helpers
    .buildNativeVariableRows(
      definitions,
      Object.assign(
        {
          storedReadStatus: "success",
          metadataRows: definitions
            .filter((def) => !def.isMrvs)
            .map((def) => storedRow(def, "")),
        },
        mrvsResult(MRVS_SET_ID, mrvsStored([]))
      ),
      [],
      { workspace: true, workspaceSurfaceKey: SUPPLIER_CASE, timeZone: "", zoneSource: "page" }
    )
    .filter((row) => row.workspaceCandidate)
    .map((row) => row.name)
    .sort();
  assert.deepStrictEqual(candidates, requested);
  // Types 1, 18 and 33 are now proven on this surface; type 9 is not.
  assert.deepStrictEqual(
    requested,
    ["attachment", "bank_accounts", "lookup", "short_text", "yes_no"]
  );
});

test("the column types a multi-row set is built from are read from its definitions", () => {
  const helpers = loadNativeHelpers();
  assert.deepStrictEqual(
    helpers.nativeMrvsColumnTypes([
      { name: "note", type: { value: "6", display_value: "Single Line Text" } },
      { name: "due", type: { value: "10", display_value: "Date/Time" } },
    ]),
    [
      // The name travels too: the live representation check binds the JSON's
      // keys to this set's own columns.
      { name: "note", type: "6", label: "Single Line Text" },
      { name: "due", type: "10", label: "Date/Time" },
    ]
  );
  assert.deepStrictEqual(helpers.nativeMrvsColumnTypes(null), []);
});

test("a date column inside a multi-row set stops the live read on every surface", () => {
  const helpers = loadNativeHelpers();
  const withDate = mrvsDefinition({ mrvsColumnsSafe: true });
  withDate.mrvsColumnTypes = [
    { type: "6", label: "Single Line Text" },
    { type: "10", label: "Date/Time" },
  ];
  const withoutDate = mrvsDefinition({ mrvsColumnsSafe: true });
  withoutDate.mrvsColumnTypes = [
    { type: "6", label: "Single Line Text" },
    { type: "8", label: "Reference" },
  ];
  const unsafe = mrvsDefinition({ mrvsColumnsSafe: false });
  unsafe.mrvsColumnTypes = [{ type: "10", label: "Date/Time" }];

  helpers.applyNativeMrvsLiveReadPolicy(
    [withDate, withoutDate, unsafe],
    mrvsResult(MRVS_SET_ID, mrvsStored([]))
  );

  assert.strictEqual(withoutDate.liveReadAllowed, true);
  assert.strictEqual(withoutDate.liveReadBlockedReason, "");

  // The form hands the whole set over with the date cell already formatted to
  // the user's date format and shifted into the session timezone, so comparing
  // it against stored UTC reports a difference that does not exist.
  assert.strictEqual(withDate.liveReadAllowed, false);
  assert.match(
    withDate.liveReadBlockedReason,
    /renders Date\/Time inside a set in the user's date format and timezone/
  );

  // A column that could not be verified at all may be a secret, and that is
  // the stronger reason to refuse.
  assert.strictEqual(unsafe.liveReadAllowed, false);
  assert.match(unsafe.liveReadBlockedReason, /could not all be verified as safe and comparable/);

  // The classic panel therefore lists the set rather than reporting a
  // difference it cannot stand behind.
  const rows = loadNativeHelpers().buildNativeVariableRows(
    [withDate],
    Object.assign(
      { storedReadStatus: "success", metadataRows: [] },
      mrvsResult(MRVS_SET_ID, mrvsStored([{ due: "2026-04-21 14:13:37" }]))
    ),
    []
  );
  assert.strictEqual(rows[0].comparison, "not-comparable");
  assert.strictEqual(rows[0].storedRowCount, 1);
  assert.match(rows[0].reason, /user's date format and timezone/);
});

/* ---------------------------------------------------------------------------
 * A catalog item whose attached variable set has been swapped since the record
 * was answered. The item defines `commodities` with one question id; the
 * record answered — and the form is bound to — a different question of the
 * same name in a newer set. Observed live on a supplier case, where it emptied
 * the whole Workspace panel.
 * ------------------------------------------------------------------------ */

const OLD_SET_ID = id(800);
const NEW_SET_ID = id(801);

function answerDefinition(overrides) {
  return Object.assign({
    name: "commodities",
    label: "Commodities",
    type: "6",
    typeDisplay: "Single Line Text",
    variableSet: NEW_SET_ID,
    setName: "",
    questionId: id(811),
    hiddenType: false,
    isMrvs: false,
    inactive: false,
    sourceIndex: 0,
  }, overrides || {});
}

function reconcileSetMeta() {
  return new Map([
    [OLD_SET_ID, { id: OLD_SET_ID, internalName: "old_set", name: "", title: "Old Set", isMrvs: false }],
    [NEW_SET_ID, { id: NEW_SET_ID, internalName: "new_set", name: "", title: "New Set", isMrvs: false }],
  ]);
}

test("a record's own answer outranks a catalog definition that shares its name", () => {
  const helpers = loadNativeHelpers();
  const catalogRow = definition({
    name: "commodities",
    questionId: id(810),
    variableSet: OLD_SET_ID,
    setName: "Old Set",
    sourceIndex: 0,
  });
  const unanswered = definition({
    name: "never_answered",
    questionId: id(812),
    sourceIndex: 1,
  });
  const reconciled = helpers.reconcileProducerDefinitionsWithAnswers(
    [catalogRow, unanswered],
    [answerDefinition()],
    reconcileSetMeta()
  );

  // The row keeps its place in the item's order but now names the question the
  // record actually answered, and the set that question really belongs to.
  assert.strictEqual(reconciled.length, 2);
  assert.strictEqual(reconciled[0].name, "commodities");
  assert.strictEqual(reconciled[0].questionId, id(811));
  assert.strictEqual(reconciled[0].variableSet, NEW_SET_ID);
  assert.strictEqual(reconciled[0].setName, "New Set");
  assert.strictEqual(reconciled[0].sourceIndex, 0);
  assert.strictEqual(reconciled[0].definitionFromAnswer, true);

  // A variable the item defines and this record never answered is untouched:
  // listing it is the reason the item is enumerated at all.
  assert.strictEqual(reconciled[1].questionId, id(812));
  assert.strictEqual(reconciled[1].definitionFromAnswer, undefined);

  // And the panel says which authority it used rather than quietly swapping.
  const rows = helpers.buildNativeVariableRows(
    reconciled,
    {
      storedReadStatus: "success",
      metadataRows: [storedRow(reconciled[0], "steel", { optionSysId: id(820) })],
    },
    [liveRow(reconciled[0], "steel")]
  );
  assert.strictEqual(rows[0].comparison, "match");
  assert.match(rows[0].reason, /Definition taken from this record's own answer/);
});

test("name reconciliation refuses every ambiguous case", () => {
  const helpers = loadNativeHelpers();
  const setMeta = reconcileSetMeta();
  const catalogRow = definition({
    name: "commodities",
    questionId: id(810),
    variableSet: OLD_SET_ID,
    sourceIndex: 0,
  });

  // The catalog definition's own id IS answered, so this is a genuine duplicate
  // name and belongs to the duplicate-name guard, not to a silent swap here.
  const bothAnswered = helpers.reconcileProducerDefinitionsWithAnswers(
    [catalogRow],
    [answerDefinition({ questionId: id(810), variableSet: OLD_SET_ID }), answerDefinition()],
    setMeta
  );
  assert.strictEqual(bothAnswered[0].questionId, id(810));
  assert.strictEqual(bothAnswered[0].definitionFromAnswer, undefined);

  // Two answers share the name: no single authority, so nothing is chosen.
  const twoAnswers = helpers.reconcileProducerDefinitionsWithAnswers(
    [catalogRow],
    [answerDefinition({ questionId: id(811) }), answerDefinition({ questionId: id(813) })],
    setMeta
  );
  assert.strictEqual(twoAnswers[0].questionId, id(810));

  // Two catalog definitions share the name: same reasoning from the other side.
  const twoDefinitions = helpers.reconcileProducerDefinitionsWithAnswers(
    [catalogRow, definition({ name: "commodities", questionId: id(814), sourceIndex: 1 })],
    [answerDefinition()],
    setMeta
  );
  assert.strictEqual(twoDefinitions[0].questionId, id(810));
  assert.strictEqual(twoDefinitions[1].questionId, id(814));

  // A multi-row parent is keyed by its variable set, not by an answer row, and
  // is never substituted.
  const mrvsParent = mrvsDefinition({ name: "commodities", sourceIndex: 0 });
  const mrvsKept = helpers.reconcileProducerDefinitionsWithAnswers(
    [mrvsParent],
    [answerDefinition()],
    setMeta
  );
  assert.strictEqual(mrvsKept[0].questionId, MRVS_SET_ID);
  assert.strictEqual(mrvsKept[0].isMrvs, true);

  // An answer whose set is a multi-row set is a cell, not a variable.
  const mrvsSetMeta = new Map([
    [NEW_SET_ID, { id: NEW_SET_ID, internalName: "new_set", name: "", title: "New Set", isMrvs: true }],
  ]);
  const cellIgnored = helpers.reconcileProducerDefinitionsWithAnswers(
    [catalogRow],
    [answerDefinition()],
    mrvsSetMeta
  );
  assert.strictEqual(cellIgnored[0].questionId, id(810));

  // A substituted definition of a structural type is dropped, exactly as the
  // enumeration would have dropped it in the first place.
  const structural = helpers.reconcileProducerDefinitionsWithAnswers(
    [catalogRow],
    [answerDefinition({ type: "11", typeDisplay: "Label" })],
    setMeta
  );
  assert.deepStrictEqual(structural, []);
});

test("a producer record reads the value of a swapped-set variable end to end", async () => {
  const RECORD_ID = id(1500);
  const ITEM = id(1501);
  const catalogRow = definition({
    name: "commodities",
    questionId: id(810),
    variableSet: OLD_SET_ID,
  });
  const answered = definition({
    name: "commodities",
    questionId: id(811),
    variableSet: NEW_SET_ID,
  });

  const helpers = loadNativeHelpers(async (table, query) => {
    if (table === "question_answer" && query.startsWith("table_sys_id=")) {
      return [producerMetadataRow(answered, id(1510), {
        "question.cat_item": ITEM,
        "question.variable_set": NEW_SET_ID,
      })];
    }
    if (table === "question_answer" && query.startsWith("sys_idIN")) {
      return [{ sys_id: id(1510), value: "steel" }];
    }
    if (table === "item_option_new_set") {
      const ids = query.replace("sys_idIN", "").split(",");
      return ids.map((setId) => ({
        sys_id: setId,
        name: "",
        internal_name: setId === OLD_SET_ID ? "old_set" : "new_set",
        title: setId === OLD_SET_ID ? "Old Set" : "New Set",
        type: { value: "one_to_one", display_value: "One to One" },
      }));
    }
    if (table === "item_option_new" && query === "cat_item=" + ITEM) return [];
    if (table === "io_set_item") return [{ variable_set: OLD_SET_ID, order: "100" }];
    if (table === "item_option_new" && query.startsWith("variable_setIN")) {
      return [nativeDefinitionRow(catalogRow)];
    }
    return [];
  });

  const recordData = await helpers.fetchNativeProducerRecordData("sn_example_case", RECORD_ID);
  const row = recordData.definitions.find((entry) => entry.name === "commodities");
  assert.strictEqual(row.questionId, id(811));
  assert.strictEqual(row.definitionFromAnswer, true);

  // Before reconciliation the stored read found nothing under the catalog id
  // and the row claimed the record had never answered it.
  const rows = helpers.buildNativeVariableRows(
    recordData.definitions,
    recordData,
    [],
    { workspace: true, workspaceSurfaceKey: SUPPLIER_CASE, timeZone: "", zoneSource: "page" }
  );
  const built = rows.find((entry) => entry.name === "commodities");
  assert.strictEqual(built.storedLookup, "found");
  assert.strictEqual(built.storedValue, "steel");

  // And the Workspace live read now asks the form for the id the form has.
  const api = liveRequestApi();
  const requests = api.workspaceLiveValueRequests(recordData.definitions, SUPPLIER_CASE);
  assert.deepStrictEqual(requests.map((request) => request.questionId), [id(811)]);
});

/* ---------------------------------------------------------------------------
 * Rendering a multi-row set as a table.
 *
 * The value is a JSON array of row objects, which no one can read as one line.
 * The panel shows a row count and builds the rows into a table on demand. The
 * part that needs pinning is not the markup but the honesty: merging the stored
 * and live sides into one grid, with a cell reading "stored -> live", asserts
 * that a comparison ran. A set that was listed rather than compared must keep
 * its sides apart, and the copy output must keep the raw JSON either way.
 * ------------------------------------------------------------------------ */

function fakeElement(tagName) {
  return {
    tagName: String(tagName).toUpperCase(),
    className: "",
    id: "",
    title: "",
    hidden: false,
    textContent: "",
    attributes: {},
    children: [],
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    appendChild(child) { this.children.push(child); return child; },
    append(...nodes) { nodes.forEach((node) => this.children.push(node)); },
    addEventListener() {},
    get childElementCount() { return this.children.length; },
  };
}

function mrvsViewSource() {
  const start = uiSource.indexOf("  const MRVS_EMPTY_CELL");
  const end = uiSource.indexOf("  // The detail sits on its own full-width line", start);
  assert.ok(start > 0 && end > start, "multi-row table helpers not found in the panel source");
  return uiSource.slice(start, end);
}

function mrvsViewApi() {
  const start = uiSource.indexOf("  const MRVS_EMPTY_CELL");
  const end = uiSource.indexOf("  // The detail sits on its own full-width line", start);
  assert.ok(start > 0 && end > start, "multi-row table helpers not found in the panel source");
  return new Function(
    "document",
    uiSource.slice(start, end) +
      "\nreturn { mrvsRowObjects, mrvsColumnNames, mrvsDetail, mrvsDiffKeys };"
  )({ createElement: fakeElement });
}

const descendants = (node) => (node.children || []).reduce(
  (all, child) => all.concat([child], descendants(child)),
  []
);
const byClass = (node, className) =>
  descendants(node).filter((child) => child.className === className);
const cellTexts = (table) =>
  descendants(table)
    .filter((child) => child.tagName === "TD" && child.className !== "mrvs-index")
    .map((child) => child.textContent);

test("a multi-row value is only read as rows when it really is an array of rows", () => {
  const view = mrvsViewApi();
  assert.deepStrictEqual(view.mrvsRowObjects('[{"a":"1"}]'), [{ a: "1" }]);
  assert.deepStrictEqual(view.mrvsRowObjects("[]"), []);
  assert.strictEqual(view.mrvsRowObjects(""), null);
  assert.strictEqual(view.mrvsRowObjects("not json"), null);
  // A bare object, an array of arrays and an array of strings are all shapes a
  // table cannot be built from, and each must fall back to the plain text.
  assert.strictEqual(view.mrvsRowObjects('{"a":"1"}'), null);
  assert.strictEqual(view.mrvsRowObjects('[["a","1"]]'), null);
  assert.strictEqual(view.mrvsRowObjects('["a"]'), null);
});

test("columns keep first-appearance order and a live-only column still shows", () => {
  const view = mrvsViewApi();
  assert.deepStrictEqual(
    view.mrvsColumnNames(
      [{ bank: "HJ", country: "NL" }],
      [{ country: "NL", bank: "HJ", added: "x" }]
    ),
    ["bank", "country", "added"]
  );
});

test("a compared multi-row set merges into one table and marks the changed cell", () => {
  const view = mrvsViewApi();
  // The changed cells come from the comparison, never from the panel reading
  // the two strings itself.
  const detail = view.mrvsDetail(
    [{ bank: "HJ", country: "NL" }, { bank: "KB", country: "PL" }],
    [{ bank: "HJ", country: "NL" }, { bank: "KB SA", country: "PL" }],
    true,
    true,
    view.mrvsDiffKeys({ mrvsCellDiffs: [{ row: 1, column: "bank" }] })
  );
  const captions = byClass(detail, "mrvs-caption").map((node) => node.textContent);
  assert.strictEqual(captions.length, 1);
  assert.match(captions[0], /stored → live/);

  const headers = descendants(detail)
    .filter((node) => node.tagName === "TH")
    .map((node) => node.textContent);
  assert.deepStrictEqual(headers, ["#", "bank", "country"]);

  const changed = byClass(detail, "mrvs-cell-differs");
  assert.strictEqual(changed.length, 1);
  assert.strictEqual(changed[0].textContent, "KB → KB SA");
  assert.match(changed[0].title, /Stored: KB\nLive: KB SA/);
  // An unchanged cell is written once, not as an arrow against itself.
  assert.ok(cellTexts(detail).includes("HJ"));
  assert.ok(!cellTexts(detail).some((text) => text === "HJ → HJ"));
});

test("a row present on one side only reads as an absent row rather than an empty one", () => {
  const view = mrvsViewApi();
  const detail = view.mrvsDetail(
    [{ bank: "HJ" }, { bank: "KB" }],
    [{ bank: "HJ" }],
    true,
    true,
    view.mrvsDiffKeys({ mrvsCellDiffs: [{ row: 1, column: "bank" }] })
  );
  const changed = byClass(detail, "mrvs-cell-differs");
  assert.strictEqual(changed.length, 1);
  assert.strictEqual(changed[0].textContent, "KB → (no row)");
});

test("an uncompared multi-row set keeps its sides in separate tables", () => {
  const view = mrvsViewApi();
  const detail = view.mrvsDetail(
    [{ bank: "HJ" }],
    [{ bank: "KB" }],
    false,
    false
  );
  assert.deepStrictEqual(
    byClass(detail, "mrvs-caption").map((node) => node.textContent),
    ["Stored rows", "Live rows"]
  );
  // No arrow anywhere: nothing here claims the two sides were compared.
  assert.strictEqual(byClass(detail, "mrvs-cell-differs").length, 0);
  assert.ok(!cellTexts(detail).some((text) => text.includes("→")));
});

test("a stored-only multi-row set renders one labelled table and an empty cell says so", () => {
  const view = mrvsViewApi();
  const detail = view.mrvsDetail([{ bank: "HJ", country: "" }], null, false, false);
  assert.deepStrictEqual(
    byClass(detail, "mrvs-caption").map((node) => node.textContent),
    ["Stored rows"]
  );
  assert.deepStrictEqual(cellTexts(detail), ["HJ", "(empty)"]);
  assert.strictEqual(view.mrvsDetail(null, null, false, false), null);
  // Rows with no columns at all cannot become a table, and must not become an
  // empty one that implies the set was read and found blank.
  assert.strictEqual(view.mrvsDetail([{}], null, false, false), null);
});

test("the panel shows a row count while the copy output keeps the whole array", () => {
  // The rendered side text and the copied side text are deliberately different
  // functions: the panel is for reading, the clipboard is for pasting.
  assert.match(uiSource, /sideValue\.textContent = nativeSideDisplayText\(row, side\)/);
  assert.match(uiSource, /lines\.push\("  Stored: " \+ nativeSideText\(row, "stored"\)\)/);
  assert.match(uiSource, /rows\.length === 1 \? "1 row" : String\(rows\.length\) \+ " rows"/);

  // Merging the two sides is gated on a verdict, not on both sides existing.
  assert.match(
    uiSource,
    /capabilities\.comparison &&\s*\(row\.comparison === "match" \|\| row\.comparison === "differs"\)/
  );

  // Every cell in the table is filled as text. The panel shell is the one
  // place allowed to write markup, and a set's own values must never reach it.
  assert.doesNotMatch(mrvsViewSource(), /innerHTML/);
  assert.match(mrvsViewSource(), /cell\.textContent = /);
  assert.match(uiSource, /detail\.hidden = true/);
  assert.match(uiSource, /toggle\.setAttribute\("aria-expanded", "false"\)/);
  assert.match(uiSource, /toggle\.setAttribute\("aria-controls", detail\.id\)/);
});

/* ---------------------------------------------------------------------------
 * A row may only be given a reason that describes what the read actually did.
 *
 * These are regressions for two defects found by executing the row builder
 * rather than reading it. Both were failures of the same invariant: the panel
 * described the form's state for a row the form was never asked about, and the
 * accounting counted a row differently from the way the request builder
 * treated it.
 * ------------------------------------------------------------------------ */

test("a multi-row set sharing a name is never asked for and never claims the form was empty", () => {
  // Two definitions, one name. Neither request builder emits for either, on
  // either world, so no reason may describe the form's state.
  const twin = definition({ name: "example_rows", label: "Twin", type: "6", questionId: id(701) });
  const set = mrvsDefinition();
  const stored = mrvsStored([{ a: "1" }]);

  const api = liveRequestApi();
  assert.deepStrictEqual(
    api.nativeLiveValueRequests([set, twin]).filter((request) => request.readValue),
    []
  );
  assert.deepStrictEqual(api.workspaceLiveValueRequests([set, twin], SOW), []);

  const classic = rowsFor([set, twin], [], [], "success", mrvsResult(MRVS_SET_ID, stored));
  const classicSet = classic.find((row) => row.isMrvs);
  assert.strictEqual(classicSet.comparison, "not-comparable");
  assert.match(classicSet.reason, /name is shared by another row/);
  assert.doesNotMatch(classicSet.reason, /no live multi-row value was available/i);

  const workspace = loadNativeHelpers().buildNativeVariableRows(
    [set, twin],
    Object.assign({ storedReadStatus: "success", metadataRows: [] }, mrvsResult(MRVS_SET_ID, stored)),
    [],
    { workspace: true, workspaceSurfaceKey: SOW, timeZone: "", zoneSource: "page" }
  );
  const workspaceSet = workspace.find((row) => row.isMrvs);
  assert.strictEqual(workspaceSet.comparison, "not-comparable");
  assert.match(workspaceSet.reason, /name is shared by another row/);
  assert.doesNotMatch(workspaceSet.reason, /no live multi-row value was available/i);
  // And it may not be counted as something the panel promised to check.
  assert.strictEqual(workspaceSet.workspaceCandidate, false);
});

test("a multi-row set whose name collides with the form prototype says so", () => {
  const set = mrvsDefinition({ name: "toString" });
  const [row] = rowsFor(
    [set],
    [],
    [],
    "success",
    mrvsResult(MRVS_SET_ID, mrvsStored([{ a: "1" }]))
  );
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /collides with the form API prototype/);
  assert.doesNotMatch(row.reason, /available/i);
});

test("the reason for an unread set never ends on a claim about the form", () => {
  const helpers = loadNativeHelpers();
  const policy = helpers.WORKSPACE_SOW_RITM_TYPE_POLICIES.get("34");
  // Every branch, including the fallback reached when nothing else explains it.
  const reasons = [
    helpers.nativeMrvsNotReadReason({ name: "a" }, policy, { duplicateName: true }),
    helpers.nativeMrvsNotReadReason({ name: "" }, policy, {}),
    helpers.nativeMrvsNotReadReason({ name: "toString" }, policy, {}),
    helpers.nativeMrvsNotReadReason({ name: "a" }, {}, { workspaceMode: true }),
    helpers.nativeMrvsNotReadReason({ name: "a", liveReadAllowed: false }, policy, {}),
    helpers.nativeMrvsNotReadReason(
      { name: "a", liveReadAllowed: true, mrvsColumnTypes: [] },
      policy,
      { workspaceMode: true }
    ),
    helpers.nativeMrvsNotReadReason(
      { name: "a", liveReadAllowed: true, mrvsColumnTypes: [{ type: "21", label: "List Collector" }] },
      policy,
      { workspaceMode: true }
    ),
    helpers.nativeMrvsNotReadReason(
      { name: "a", liveReadAllowed: true, mrvsColumnTypes: [{ type: "6", label: "Text" }] },
      policy,
      { workspaceMode: true }
    ),
  ];
  reasons.forEach((reason) => {
    assert.ok(reason && reason.length > 0);
    // "No live value was available" is a statement about a form that answered.
    // None of these rows reached a form at all.
    assert.doesNotMatch(reason, /value was available/i);
  });
  assert.match(reasons[0], /shared by another row/);
  assert.match(reasons[3], /not compared on this\s+Workspace surface/);
  assert.match(reasons[6], /List Collector/);
});

test("a name duplicated only in storage is neither requested nor counted", () => {
  // The definition list holds one `alpha`; the record holds two stored rows
  // called `alpha`. The request builders and the panel must agree that this is
  // a duplicate: reading the name could return either row's variable.
  const alpha = definition({ name: "alpha", label: "Alpha", type: "6", questionId: id(801) });
  const metadataRows = [
    storedRow(alpha, "one"),
    Object.assign({}, storedRow(alpha, "two"), { questionId: id(802) }),
  ];

  const helpers = loadNativeHelpers();
  const duplicates = helpers.nativeDuplicateNameSet([alpha], metadataRows);
  assert.strictEqual(duplicates.has("alpha"), true);

  const api = liveRequestApi();
  const classicRequest = api.nativeLiveValueRequests([alpha], duplicates)[0];
  assert.strictEqual(classicRequest.readValue, false);
  assert.deepStrictEqual(api.workspaceLiveValueRequests([alpha], SOW, duplicates), []);

  const rows = loadNativeHelpers().buildNativeVariableRows(
    [alpha],
    { storedReadStatus: "success", metadataRows },
    [],
    { workspace: true, workspaceSurfaceKey: SOW, timeZone: "", zoneSource: "page" }
  );
  // Requested and counted must move together: neither, here.
  assert.strictEqual(rows[0].workspaceCandidate, false);
  assert.strictEqual(rows[0].comparison, "not-comparable");
});

test("the request builders and the panel take duplicate names from one place", () => {
  // Source-level guard: the drift that caused the defect was two independent
  // name counts, and a future edit must not reintroduce one.
  const builderStart = contentSource.indexOf("function nativeLiveValueRequests");
  const builderEnd = contentSource.indexOf("async function finishNativeVariableValues", builderStart);
  const builders = contentSource.slice(builderStart, builderEnd);
  assert.doesNotMatch(builders, /nameCounts/);
  assert.match(builders, /nativeDuplicateNameSet/);

  // The old counts are gone from the file entirely, and the panel's candidate
  // flag is the request decision itself rather than a restatement of it.
  assert.doesNotMatch(contentSource, /definitionNameCounts|storedNameCounts/);
  assert.match(
    contentSource,
    /row\.workspaceCandidate = Boolean\(workspaceMode && liveReadRequested && !secret\)/
  );
});

test("a cell the comparison called equal is never marked changed, whatever the strings say", () => {
  // A Yes/No or Checkbox column inside a set folds Yes and true into one
  // bucket, so the row can be a Match while its two cells read differently.
  // Marking that cell would make the table contradict the badge above it.
  const view = mrvsViewApi();
  const detail = view.mrvsDetail(
    [{ approved: "Yes", note: "same" }],
    [{ approved: "true", note: "same" }],
    true,
    false,
    view.mrvsDiffKeys({ mrvsCellDiffs: [] })
  );
  assert.strictEqual(byClass(detail, "mrvs-cell-differs").length, 0);
  const cells = descendants(detail).filter(
    (node) => node.tagName === "TD" && node.className !== "mrvs-index"
  );
  assert.deepStrictEqual(cells.map((cell) => cell.textContent), ["Yes", "same"]);
  // The tooltip still tells the truth about both sides.
  assert.match(cells[0].title, /Stored: Yes/);
  assert.match(cells[0].title, /Live: true/);
  assert.match(cells[0].title, /compared equal/);
  assert.strictEqual(cells[1].title, "same");
});

test("the panel derives no cell verdict of its own", () => {
  // Source guard: the equality that decides a changed cell belongs to the
  // comparison, and the panel may only render what it was handed.
  const source = mrvsViewSource();
  assert.match(source, /diffKeys[.]has[(]/);
  assert.doesNotMatch(source, /if [(]stored === live[)]/);
});

test("rows stored under a set the item no longer attaches are seen but never read", async () => {
  const detachedSet = id(777);
  const queries = [];
  const helpers = loadNativeHelpers(async (table, query, fields) => {
    queries.push({ table, query, fields });
    if (table !== "sc_multi_row_question_answer") return [];
    if (query.startsWith("parent_id=")) {
      return [
        mrvsAnswerRow(id(801), "plain", 1),
        // Same record, a set the catalog item does not attach any more.
        Object.assign(mrvsAnswerRow(id(803), "orphan", 1), { variable_set: detachedSet }),
      ];
    }
    return [{ sys_id: id(801), value: "kept" }];
  });

  const result = await helpers.fetchNativeMrvsStoredValues(RITM_ID, [MRVS_SET_ID]);
  assert.deepStrictEqual(result.detachedMrvsSetIds, [detachedSet]);
  // Its value is never requested: nothing would show it.
  const valueRead = queries[1];
  assert.doesNotMatch(valueRead.query, new RegExp(id(803)));
  // And it does not contaminate the enumerated set's rows.
  assert.deepStrictEqual(result.mrvsValuesBySetId.get(MRVS_SET_ID).rows, [{ plain: "kept" }]);
  assert.strictEqual(result.mrvsValuesBySetId.has(detachedSet), false);
});

test("a set with no stored rows refuses while the record holds detached rows", () => {
  const def = mrvsDefinition();
  // The enumerated set has nothing; the record stores rows under another set.
  const [row] = rowsFor([def], [], [liveRow(def, '[{"a":"1"}]')], "success", {
    mrvsReadStatus: "success",
    mrvsValuesBySetId: new Map(),
    detachedMrvsSetIds: [id(778)],
  });
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /no longer attaches/);
  // Without the detached rows the same shape is an ordinary difference, so the
  // refusal is caused by the evidence and not by the empty set alone.
  const [plain] = rowsFor([def], [], [liveRow(def, '[{"a":"1"}]')], "success", {
    mrvsReadStatus: "success",
    mrvsValuesBySetId: new Map(),
    detachedMrvsSetIds: [],
  });
  assert.strictEqual(plain.comparison, "differs");
});

test("a request item reconciles a swapped variable set exactly as a producer record does", async () => {
  // The swap is a property of the catalog item, so a request item on the same
  // item is wrong in the same way: without this the row says the record never
  // answered a variable whose value is sitting in storage, and the Workspace
  // read asks the form for a question id it does not have.
  const REQUEST_ITEM = id(1600);
  const ITEM = id(1601);
  const catalogQuestion = id(1610);
  const answeredQuestion = id(1611);
  const catalogRow = definition({
    name: "commodities",
    questionId: catalogQuestion,
    variableSet: OLD_SET_ID,
  });

  const queries = [];
  const helpers = loadNativeHelpers(async (table, query) => {
    queries.push({ table, query });
    if (table === "sc_req_item") return [{ sys_id: REQUEST_ITEM, cat_item: ITEM }];
    if (table === "item_option_new" && query === "cat_item=" + ITEM) return [];
    if (table === "io_set_item") return [{ variable_set: OLD_SET_ID, order: "100" }];
    if (table === "item_option_new_set") {
      return [{
        sys_id: OLD_SET_ID,
        name: "",
        internal_name: "old_set",
        title: "Old Set",
        type: { value: "one_to_one", display_value: "One to One" },
      }];
    }
    if (table === "item_option_new" && query.startsWith("variable_setIN")) {
      return [nativeDefinitionRow(catalogRow)];
    }
    if (table === "sc_item_option_mtom") {
      // The record answered the NEW question, under the set the item dropped.
      return [{
        "sc_item_option.sys_id": id(1620),
        "sc_item_option.item_option_new": answeredQuestion,
        "sc_item_option.item_option_new.name": "commodities",
        "sc_item_option.item_option_new.question_text": "Commodities",
        "sc_item_option.item_option_new.type": { value: "6", display_value: "Single Line Text" },
        "sc_item_option.item_option_new.variable_set": NEW_SET_ID,
      }];
    }
    if (table === "sc_item_option") return [{ sys_id: id(1620), value: "steel" }];
    return [];
  });

  const recordData = await helpers.fetchNativeRitmRecordData(REQUEST_ITEM);
  const reconciled = recordData.definitions.find((entry) => entry.name === "commodities");
  assert.strictEqual(reconciled.questionId, answeredQuestion);
  assert.strictEqual(reconciled.definitionFromAnswer, true);

  // The stored rows are read once, not twice, now that the reader needs them
  // before the definitions are settled.
  const storedReads = queries.filter((entry) => entry.table === "sc_item_option_mtom");
  assert.strictEqual(storedReads.length, 1);

  // And the value is found, which is the whole point.
  const rows = helpers.buildNativeVariableRows(
    recordData.definitions,
    recordData,
    []
  );
  const row = rows.find((entry) => entry.name === "commodities");
  assert.strictEqual(row.storedLookup, "found");
  assert.strictEqual(row.storedValue, "steel");
  assert.match(row.reason, /taken from this record's own answer/);
});

test("a substituted definition is not compared when the classic form binds the other question", () => {
  // Workspace refuses this through the entry identity gate. The classic reader
  // resolves by name, so a form bound to the item's NEW question would hand
  // back that variable's value; comparing it against this record's older answer
  // compares two different variables.
  const def = definition({
    name: "commodities",
    questionId: id(1630),
    definitionFromAnswer: true,
  });
  const [row] = rowsFor(
    [def],
    [storedRow(def, "steel")],
    [Object.assign(liveRow(def, ""), { foundEl: false })]
  );
  assert.strictEqual(row.comparison, "not-comparable");
  assert.match(row.reason, /does not render that question/);

  // With the form rendering it, the same row compares normally.
  const [bound] = rowsFor(
    [def],
    [storedRow(def, "steel")],
    [Object.assign(liveRow(def, "steel"), { foundEl: true })]
  );
  assert.strictEqual(bound.comparison, "match");
});

/*
 * Translation Lens - DOM-free translation coverage engine.
 *
 * The engine owns query construction, storage routing, hierarchy and choice
 * resolution, coverage states, and report/link models. It knows nothing about
 * the page DOM or the panel. `run(context, transport)` accepts an injected
 * transport so the same code can run behind Chrome's single-token-frame route
 * and inside Node fixtures.
 */
(function () {
  if (globalThis.SNTranslationLens) return;

  const VERSION = 1;
  const MAX_QUERY_LENGTH = 6000;
  const MAX_VALUE_CHUNK = 40;
  const MAX_MESSAGE_KEYS = 200;
  const MAX_HIERARCHY_DEPTH = 20;
  const TABLE_PATTERN = /^[a-z][a-z0-9_]*$/;
  const FIELD_PATTERN = /^[a-z][a-z0-9_]*$/;
  const LANGUAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
  const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;
  const STORE_CAPS = Object.freeze({
    sys_choice: 5000,
    sys_translated: 5000,
    sys_translated_text: 5000,
    sys_documentation: 2000,
    sys_dictionary: 2000,
    sys_language: 2000,
    sys_properties: 2000,
    sys_script_client: 2000,
    sys_ui_policy: 2000,
    catalog_script_client: 2000,
    catalog_ui_policy: 2000,
    sys_ui_message: 2000,
    sys_db_object: 2000,
    io_set_item: 2000,
    item_option_new: 2000,
    item_option_new_set: 2000,
    question_choice: 2000,
    sc_cat_item: 2000,
  });
  const COVERED_STATES = new Set(["direct", "same_as_source"]);
  const EXCLUDED_STATES = new Set(["unavailable", "unverified", "not_applicable"]);
  const TRANSLATED_FIELD_TYPES = new Set(["translated_field"]);
  const TRANSLATED_TEXT_TYPES = new Set(["translated_text", "translated_html"]);
  const UNKNOWN_TRANSLATED_TYPES = new Set(["translated"]);
  /* Types arrive from the Table API as numbers; the names are defensive
   * aliases for a caller that builds its own variable objects. Reference
   * (8 / "reference") is deliberately absent from BOTH spellings: this set
   * also decides which variables get a Choices row at all, and a Reference
   * variable produces none today, so listing it would invent rows only to fold
   * them away again. */
  const DYNAMIC_CATALOG_TYPES = new Set([
    "lookup_select_box", "list_collector", "lookup_multiple_choice",
    "18", "21", "22",
  ]);

  function createError(code, message, status) {
    const error = new Error(message);
    error.code = code;
    error.status = Number(status) || 0;
    return error;
  }

  function rawValue(value) {
    if (value == null) return "";
    if (typeof value === "object" && !Array.isArray(value)) {
      if (value.value != null) return String(value.value);
      if (value.display_value != null) return String(value.display_value);
      return "";
    }
    return String(value);
  }

  function fieldValue(row, field) {
    return rawValue(row && row[field]);
  }

  function isTrue(value) {
    return /^(?:true|1|yes)$/i.test(rawValue(value));
  }

  function unique(values) {
    const seen = new Set();
    const out = [];
    (values || []).forEach((value) => {
      const text = String(value);
      if (seen.has(text)) return;
      seen.add(text);
      out.push(text);
    });
    return out;
  }

  function assertIdentifier(value, kind) {
    const raw = String(value == null ? "" : value).trim();
    const text = kind === "language" ? raw : raw.toLowerCase();
    const pattern = kind === "language" ? LANGUAGE_PATTERN :
      (kind === "field" ? FIELD_PATTERN : TABLE_PATTERN);
    if (!pattern.test(text)) {
      throw createError("validation", "Unsafe " + kind + " identifier.");
    }
    return text;
  }

  function queryValueStatus(value, options) {
    const opts = options || {};
    const text = String(value == null ? "" : value);
    if (!text && !opts.allowEmpty) return { ok: false, reason: "empty" };
    if (text.length > 255) return { ok: false, reason: "over-255" };
    if (text.includes("^") || /[\r\n]/.test(text)) {
      return { ok: false, reason: "encoded-query-separator" };
    }
    return { ok: true, value: text };
  }

  function assertQueryValue(value, options) {
    const status = queryValueStatus(value, options);
    if (!status.ok) {
      throw createError("validation", "Unsafe encoded-query value (" + status.reason + ").");
    }
    return status.value;
  }

  function assertQueryLength(query) {
    if (String(query || "").length > MAX_QUERY_LENGTH) {
      throw createError("validation", "Encoded query exceeds the 6000-character limit.");
    }
    return query;
  }

  function joinQuery(parts) {
    return assertQueryLength((parts || []).filter(Boolean).join("^"));
  }

  function identifierIn(field, values) {
    const safeField = assertIdentifier(field, "field");
    const safeValues = unique(values).map((value) => {
      const text = String(value || "").toLowerCase();
      if (!TABLE_PATTERN.test(text) && !FIELD_PATTERN.test(text) && !LANGUAGE_PATTERN.test(text)) {
        throw createError("validation", "Unsafe identifier in encoded query.");
      }
      return text;
    });
    if (!safeValues.length) throw createError("validation", "Encoded query has no identifiers.");
    return safeField + "IN" + safeValues.join(",");
  }

  /* Values use OR rather than IN because a source string may contain commas.
   * The query is split at both 40 distinct values and 6000 characters. */
  function buildValueQueryChunks(prefix, field, values, options) {
    const opts = options || {};
    const safeField = assertIdentifier(field, "field");
    const distinct = unique(values || []);
    const chunks = [];
    const rejected = [];
    let current = [];
    const queryFor = (items) => {
      const terms = items.map((value, index) =>
        (index ? "OR" : "") + safeField + "=" + value
      ).join("^");
      return prefix ? String(prefix) + "^" + terms : terms;
    };
    distinct.forEach((value) => {
      const status = queryValueStatus(value, { allowEmpty: Boolean(opts.allowEmpty) });
      if (!status.ok) {
        rejected.push({ value, reason: status.reason });
        return;
      }
      const candidate = current.concat([status.value]);
      if (
        current.length &&
        (candidate.length > (opts.maxItems || MAX_VALUE_CHUNK) ||
          queryFor(candidate).length > (opts.maxLength || MAX_QUERY_LENGTH))
      ) {
        chunks.push({ values: current.slice(), query: queryFor(current) });
        current = [status.value];
      } else {
        current = candidate;
      }
      if (queryFor(current).length > (opts.maxLength || MAX_QUERY_LENGTH)) {
        rejected.push({ value: current.pop(), reason: "over-6000-query" });
      }
    });
    if (current.length) chunks.push({ values: current.slice(), query: queryFor(current) });
    return { chunks, rejected };
  }

  function derivedFieldChunkSize(languageCount, chainLength, cap) {
    const languages = Math.max(1, Number(languageCount) + 1);
    const chain = Math.max(1, Number(chainLength));
    return Math.max(1, Math.min(MAX_VALUE_CHUNK, Math.floor(Number(cap) / (languages * chain))));
  }

  function chunkIdentifiers(values, size) {
    const clean = unique(values || []).map((value) => assertIdentifier(value, "field"));
    const out = [];
    const width = Math.max(1, Number(size) || 1);
    for (let index = 0; index < clean.length; index += width) {
      out.push(clean.slice(index, index + width));
    }
    return out;
  }

  function chunkSysIds(values, size) {
    const clean = unique(values || []).map((value) => {
      const text = String(value || "").toLowerCase();
      if (!SYS_ID_PATTERN.test(text)) throw createError("validation", "Invalid sys_id in query.");
      return text;
    });
    const out = [];
    const width = Math.max(1, Number(size) || 1);
    for (let index = 0; index < clean.length; index += width) {
      out.push(clean.slice(index, index + width));
    }
    return out;
  }

  function routeInternalType(internalType) {
    const type = String(internalType || "").trim().toLowerCase();
    if (TRANSLATED_FIELD_TYPES.has(type)) {
      return { applicable: true, primary: "sys_translated", mirror: "sys_translated_text" };
    }
    if (TRANSLATED_TEXT_TYPES.has(type)) {
      return { applicable: true, primary: "sys_translated_text", mirror: null };
    }
    if (UNKNOWN_TRANSLATED_TYPES.has(type)) {
      return {
        applicable: null,
        primary: null,
        mirror: null,
        unverified: true,
        reason: "storage unverified for type translated",
        candidateStores: ["sys_translated", "sys_translated_text"],
      };
    }
    return { applicable: false, primary: null, mirror: null };
  }

  async function defaultTransport(request) {
    if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      throw createError("transport", "Translation transport is unavailable.");
    }
    const response = await chrome.runtime.sendMessage(Object.assign(
      { type: "SN_TRANSLATION_GET" }, request
    ));
    return response;
  }

  function transportFunction(transport) {
    if (typeof transport === "function") return transport;
    if (transport && typeof transport.get === "function") {
      return transport.get.bind(transport);
    }
    return defaultTransport;
  }

  async function readRows(transport, request) {
    const get = transportFunction(transport);
    let response;
    try {
      response = await get(request);
    } catch (error) {
      if (error && error.code) throw error;
      throw createError("transport", String(error && error.message || error));
    }
    if (Array.isArray(response)) response = { ok: true, result: response };
    if (!response || response.ok === false) {
      const status = Number(response && response.status) || 0;
      const code = status === 401 || status === 403 ? "access" :
        (status === 404 ? "schema" : "transport");
      throw createError(
        code,
        (response && response.error) || "Translation read failed.",
        status
      );
    }
    const rows = Array.isArray(response.result) ? response.result :
      (Array.isArray(response.rows) ? response.rows : []);
    return {
      rows,
      status: Number(response.status) || 200,
      truncated: Boolean(response.truncated) ||
        (Number(request.limit) > 0 && rows.length >= Number(request.limit)),
    };
  }

  async function safeRead(transport, request) {
    try {
      return Object.assign({ ok: true }, await readRows(transport, request));
    } catch (error) {
      return {
        ok: false,
        rows: [],
        truncated: false,
        status: Number(error && error.status) || 0,
        error: String(error && error.message || error),
        code: (error && error.code) || "transport",
      };
    }
  }

  async function resolveHierarchy(startTable, transport) {
    let table = assertIdentifier(startTable, "table");
    const tables = [];
    let cycle = false;
    for (let hop = 0; hop < MAX_HIERARCHY_DEPTH && table; hop++) {
      if (tables.includes(table)) {
        cycle = true;
        break;
      }
      tables.push(table);
      const response = await readRows(transport, {
        table: "sys_db_object",
        query: "name=" + table,
        fields: "name,super_class.name,super_class",
        limit: 2,
        options: { displayAll: true, excludeRefLinks: true },
      });
      if (response.truncated) {
        throw createError("hierarchy", "Table hierarchy read was truncated.");
      }
      const exact = response.rows.find((row) => fieldValue(row, "name") === table);
      if (!exact) {
        throw createError("hierarchy", "Table hierarchy could not be verified.");
      }
      const parent = fieldValue(exact, "super_class.name") || fieldValue(exact, "super_class");
      if (!parent) {
        table = "";
        break;
      }
      table = assertIdentifier(parent, "table");
    }
    if (table && tables.length >= MAX_HIERARCHY_DEPTH) {
      throw createError("hierarchy", "Table hierarchy exceeded the safe depth.");
    }
    return { tables, cycle, complete: true };
  }

  function buildLanguageContext(languageRows, propertyRows, picker) {
    const active = [];
    const bySysId = new Map();
    (languageRows || []).forEach((row) => {
      if (fieldValue(row, "active") && !isTrue(row.active)) return;
      const id = fieldValue(row, "id");
      const sysId = fieldValue(row, "sys_id");
      if (!LANGUAGE_PATTERN.test(id) || active.some((item) => item.id === id)) return;
      const language = {
        id,
        sysId: SYS_ID_PATTERN.test(sysId) ? sysId.toLowerCase() : "",
        name: fieldValue(row, "name") || id,
        fallbackRef: fieldValue(row, "fallback"),
      };
      active.push(language);
      if (language.sysId) bySysId.set(language.sysId, id);
    });
    let baseLanguage = "";
    (propertyRows || []).some((row) => {
      if (fieldValue(row, "name") !== "glide.sys.language") return false;
      const value = fieldValue(row, "value");
      if (LANGUAGE_PATTERN.test(value)) baseLanguage = value;
      return Boolean(baseLanguage);
    });
    let assumedBase = false;
    if (!baseLanguage) {
      baseLanguage = "en";
      assumedBase = true;
    }
    const fallbackById = Object.create(null);
    active.forEach((language) => {
      const ref = String(language.fallbackRef || "").toLowerCase();
      fallbackById[language.id] = bySysId.get(ref) ||
        (LANGUAGE_PATTERN.test(language.fallbackRef) ? language.fallbackRef : "");
    });
    const countedLanguageIds = active
      .map((language) => language.id)
      .filter((id) => id !== baseLanguage);
    const selected = new Set(Array.isArray(picker) ? picker.map(String) : countedLanguageIds);
    const visibleLanguageIds = countedLanguageIds.filter((id) => selected.has(id));
    return {
      active,
      baseLanguage,
      assumedBase,
      fallbackById,
      countedLanguageIds,
      visibleLanguageIds,
      activeCount: active.length,
      shownCount: visibleLanguageIds.length,
    };
  }

  function englishVariantPreset(languageContext) {
    return (languageContext && languageContext.countedLanguageIds || []).filter((id) =>
      !/^en(?:-|$)/i.test(id) && !/^(?:xl|xx|qps[-_])/i.test(id)
    );
  }

  function atomState(rows, options) {
    const opts = options || {};
    const present = Array.isArray(rows) ? rows : [];
    if (!present.length) return { state: "missing", direct: false, duplicateCount: 0 };
    if (opts.presenceOnly) {
      return {
        state: "direct",
        direct: true,
        duplicateCount: Math.max(0, present.length - 1),
        duplicateRows: present.length > 1,
      };
    }
    const contents = present.map((row) => fieldValue(row, opts.contentField || "label"));
    const uniqueContents = unique(contents);
    if (uniqueContents.length > 1) {
      return {
        state: "conflict",
        direct: false,
        duplicateCount: present.length - 1,
        conflictCount: uniqueContents.length,
      };
    }
    const content = uniqueContents[0] || "";
    if (!content) {
      return {
        state: "missing",
        direct: false,
        blank: true,
        duplicateCount: Math.max(0, present.length - 1),
      };
    }
    const same = opts.source != null && content === String(opts.source);
    return {
      state: same ? "same_as_source" : "direct",
      direct: true,
      sameAsSource: same,
      duplicateCount: Math.max(0, present.length - 1),
    };
  }

  function applyFallbacks(states, languageContext) {
    const context = languageContext || { fallbackById: {} };
    const out = Object.create(null);
    Object.keys(states || {}).forEach((id) => { out[id] = Object.assign({}, states[id]); });
    Object.keys(out).forEach((id) => {
      if (!out[id] || out[id].state !== "missing") return;
      const seen = new Set([id]);
      let next = context.fallbackById && context.fallbackById[id];
      while (next && !seen.has(next)) {
        seen.add(next);
        const candidate = out[next];
        if (candidate && COVERED_STATES.has(candidate.state)) {
          out[id] = {
            state: "fallback",
            direct: false,
            fallbackLanguage: next,
          };
          return;
        }
        next = context.fallbackById && context.fallbackById[next];
      }
    });
    return out;
  }

  function coverageFromStates(states, languageIds) {
    let covered = 0;
    let counted = 0;
    const missing = [];
    const unavailable = [];
    (languageIds || []).forEach((id) => {
      const state = states && states[id] ? states[id].state : "missing";
      if (EXCLUDED_STATES.has(state)) {
        if (state === "unavailable") unavailable.push(id);
        return;
      }
      counted++;
      if (COVERED_STATES.has(state)) covered++;
      else missing.push(id);
    });
    return {
      covered,
      counted,
      percent: counted ? Math.round((covered / counted) * 100) : null,
      missing,
      unavailable,
    };
  }

  function unavailableStates(languageContext, reason) {
    const states = Object.create(null);
    (languageContext && languageContext.countedLanguageIds || []).forEach((id) => {
      states[id] = { state: "unavailable", reason: reason || "read unavailable" };
    });
    return states;
  }

  function fixedStates(languageContext, state, reason) {
    const states = Object.create(null);
    (languageContext && languageContext.countedLanguageIds || []).forEach((id) => {
      states[id] = { state, reason: reason || "" };
    });
    return states;
  }

  function summarizeEvidence(rows, languageContext) {
    const active = new Set(languageContext && languageContext.countedLanguageIds || []);
    const base = languageContext && languageContext.baseLanguage;
    const languages = unique((rows || []).map((row) => fieldValue(row, "language"))
      .filter((id) => id && id !== base));
    return {
      rowCount: (rows || []).length,
      languages,
      inactiveLanguages: languages.filter((id) => !active.has(id)),
    };
  }

  function analyzeStringRows(options) {
    const opts = options || {};
    const languages = opts.languages;
    const ids = languages.countedLanguageIds;
    if (opts.unavailable) {
      const states = unavailableStates(languages, opts.unavailableReason);
      return makeRow(opts, states, { unavailable: true });
    }
    const sourceStatus = queryValueStatus(opts.source, { allowEmpty: false });
    if (!sourceStatus.ok && !opts.presenceOnly) {
      const isEmpty = sourceStatus.reason === "empty";
      const state = isEmpty ? "not_applicable" : "unverified";
      const states = fixedStates(languages, state, sourceStatus.reason);
      return makeRow(opts, states, isEmpty
        ? { notApplicable: true, notApplicableReason: "base source is empty" }
        : { unverified: true, unverifiedReason: sourceStatus.reason });
    }
    const keyField = opts.keyField || "value";
    const tableField = opts.tableField || "name";
    const effectiveTable = opts.effectiveTable || "";
    const all = Array.isArray(opts.rows) ? opts.rows : [];
    const exact = all.filter((row) =>
      (!effectiveTable || fieldValue(row, tableField) === effectiveTable) &&
      fieldValue(row, keyField) === String(opts.source)
    );
    const near = opts.presenceOnly ? [] : all.filter((row) => {
      const value = fieldValue(row, keyField);
      return (!effectiveTable || fieldValue(row, tableField) === effectiveTable) &&
        value !== String(opts.source) &&
        value.toLocaleLowerCase() === String(opts.source).toLocaleLowerCase();
    });
    const states = Object.create(null);
    ids.forEach((id) => {
      states[id] = atomState(
        exact.filter((row) => fieldValue(row, "language") === id),
        {
          presenceOnly: Boolean(opts.presenceOnly),
          contentField: opts.contentField || "label",
          source: opts.source,
        }
      );
    });
    const withFallback = applyFallbacks(states, languages);
    const alternateRows = all.filter((row) =>
      effectiveTable && fieldValue(row, tableField) && fieldValue(row, tableField) !== effectiveTable &&
      fieldValue(row, keyField) === String(opts.source)
    );
    return makeRow(opts, withFallback, {
      nearDuplicates: summarizeEvidence(near, languages),
      alternateRegistrations: summarizeEvidence(alternateRows, languages),
      stranded: summarizeEvidence(opts.strandedRows || [], languages),
      extras: summarizeEvidence(exact.filter((row) => {
        const id = fieldValue(row, "language");
        return id && id !== languages.baseLanguage && !ids.includes(id);
      }), languages),
    });
  }

  function makeRow(options, states, evidence) {
    const opts = options || {};
    const coverage = coverageFromStates(states, opts.languages && opts.languages.countedLanguageIds);
    return {
      id: opts.id || [opts.aspect, opts.element].filter(Boolean).join(":"),
      element: opts.element || "",
      label: opts.label || opts.element || "",
      aspect: opts.aspect || "value",
      store: opts.store || "",
      internalType: opts.internalType || "",
      definingTable: opts.definingTable || "",
      concreteTable: opts.concreteTable || "",
      registrationTable: opts.effectiveTable || "",
      source: opts.source == null ? "" : String(opts.source),
      states,
      coverage,
      evidence: evidence || {},
      links: opts.links || buildRowLinks(opts, states),
    };
  }

  function effectiveRowsByLanguage(rows, chain, language, element) {
    const matching = (rows || []).filter((row) =>
      fieldValue(row, "element") === element && fieldValue(row, "language") === language
    );
    for (const table of chain || []) {
      const atTable = matching.filter((row) => fieldValue(row, "name") === table);
      if (atTable.length) return { table, rows: atTable };
    }
    return { table: "", rows: [] };
  }

  function analyzeLabel(options) {
    const opts = options || {};
    const languages = opts.languages;
    if (opts.unavailable) {
      return makeRow(Object.assign({}, opts, { aspect: "label", store: "sys_documentation" }),
        unavailableStates(languages, opts.unavailableReason), { unavailable: true });
    }
    const all = (opts.rows || []).filter((row) =>
      fieldValue(row, "element") === opts.element && (opts.chain || []).includes(fieldValue(row, "name"))
    );
    const baseEffective = effectiveRowsByLanguage(
      all, opts.chain, languages.baseLanguage, opts.element
    );
    const baseRow = baseEffective.rows[0] || null;
    const source = baseRow ? fieldValue(baseRow, "label") : (opts.source || "");
    if (!source) {
      return makeRow(Object.assign({}, opts, {
        aspect: "label", store: "sys_documentation", source: "",
      }), fixedStates(languages, "not_applicable", "base label is empty"), {
        notApplicable: true,
      });
    }
    const applicableAtoms = ["label"];
    ["plural", "hint"].forEach((field) => {
      if (fieldValue(baseRow, field)) applicableAtoms.push(field);
    });
    const states = Object.create(null);
    const registrationByLanguage = Object.create(null);
    languages.countedLanguageIds.forEach((id) => {
      const effective = effectiveRowsByLanguage(all, opts.chain, id, opts.element);
      registrationByLanguage[id] = effective.table;
      const atomStates = applicableAtoms.map((field) => atomState(effective.rows, {
        contentField: field,
        source: fieldValue(baseRow, field),
      }));
      if (atomStates.some((state) => state.state === "conflict")) {
        states[id] = { state: "conflict", direct: false };
      } else if (atomStates[0].direct && atomStates.slice(1).some((state) => !state.direct)) {
        states[id] = { state: "partial", direct: false, missingAtoms: applicableAtoms.filter((_, index) => !atomStates[index].direct) };
      } else {
        states[id] = atomStates[0];
      }
    });
    const withFallback = applyFallbacks(states, languages);
    const overrides = all.filter((row) => fieldValue(row, "name") !== opts.definingTable);
    const shadowed = all.filter((row) => {
      const language = fieldValue(row, "language");
      const selected = registrationByLanguage[language];
      return selected && fieldValue(row, "name") !== selected;
    });
    return makeRow(Object.assign({}, opts, {
      aspect: "label",
      store: "sys_documentation",
      source,
      effectiveTable: opts.definingTable,
    }), withFallback, {
      applicableAtoms,
      registrationByLanguage,
      overrides: summarizeEvidence(overrides, languages),
      shadowed: summarizeEvidence(shadowed, languages),
      extras: summarizeEvidence(all.filter((row) => {
        const id = fieldValue(row, "language");
        return id && id !== languages.baseLanguage && !languages.countedLanguageIds.includes(id);
      }), languages),
    });
  }

  function choiceEnabled(dictionaryRow) {
    const value = fieldValue(dictionaryRow, "choice").trim().toLowerCase();
    return Boolean(value && !["0", "false", "none"].includes(value));
  }

  function resolveChoiceSource(dictionaryRow, chain, rows) {
    const element = fieldValue(dictionaryRow, "element");
    const choiceTable = fieldValue(dictionaryRow, "choice_table");
    const choiceField = fieldValue(dictionaryRow, "choice_field") || element;
    if (choiceEnabled(dictionaryRow) && TABLE_PATTERN.test(choiceTable) && FIELD_PATTERN.test(choiceField)) {
      return { table: choiceTable, field: choiceField, redirected: true };
    }
    for (const table of chain || []) {
      if ((rows || []).some((row) =>
        fieldValue(row, "name") === table && fieldValue(row, "element") === element
      )) {
        return { table, field: element, redirected: false };
      }
    }
    return { table: "", field: element, redirected: false };
  }

  function choiceIdentity(value, dependentValue) {
    return String(value == null ? "" : value) + "\u0000" +
      String(dependentValue == null ? "" : dependentValue);
  }

  function analyzeChoices(options) {
    const opts = options || {};
    const languages = opts.languages;
    if (opts.unavailable) {
      return makeRow(Object.assign({}, opts, { aspect: "choices", store: "sys_choice" }),
        unavailableStates(languages, opts.unavailableReason), { unavailable: true });
    }
    if (opts.dynamic) {
      return makeRow(Object.assign({}, opts, { aspect: "choices", store: "sys_choice" }),
        fixedStates(languages, "unverified", "dynamic choice source"), {
          unverified: true,
          unverifiedReason: "dynamic choice source",
        });
    }
    const source = opts.source || { table: "", field: opts.element };
    if (!source.table) {
      return makeRow(Object.assign({}, opts, { aspect: "choices", store: "sys_choice" }),
        fixedStates(languages, "not_applicable", "no choice list"), { notApplicable: true });
    }
    const relevant = (opts.rows || []).filter((row) =>
      fieldValue(row, "name") === source.table && fieldValue(row, "element") === source.field
    );
    const included = relevant.filter((row) => opts.includeInactive || !isTrue(row.inactive));
    const baseRows = included.filter((row) => fieldValue(row, "language") === languages.baseLanguage);
    const baseByIdentity = new Map();
    baseRows.forEach((row) => {
      const key = choiceIdentity(fieldValue(row, "value"), fieldValue(row, "dependent_value"));
      if (!baseByIdentity.has(key)) baseByIdentity.set(key, row);
    });
    if (!baseByIdentity.size) {
      return makeRow(Object.assign({}, opts, { aspect: "choices", store: "sys_choice" }),
        fixedStates(languages, "not_applicable", "base choice set is empty"), { notApplicable: true });
    }
    const choices = [];
    baseByIdentity.forEach((baseRow, identity) => {
      const value = fieldValue(baseRow, "value");
      const dependentValue = fieldValue(baseRow, "dependent_value");
      const sourceLabel = fieldValue(baseRow, "label");
      let states = Object.create(null);
      languages.countedLanguageIds.forEach((id) => {
        states[id] = atomState(included.filter((row) =>
          fieldValue(row, "language") === id &&
          choiceIdentity(fieldValue(row, "value"), fieldValue(row, "dependent_value")) === identity
        ), { contentField: "label", source: sourceLabel });
      });
      states = applyFallbacks(states, languages);
      const near = included.filter((row) =>
        fieldValue(row, "dependent_value") === dependentValue &&
        fieldValue(row, "value") !== value &&
        fieldValue(row, "value").toLocaleLowerCase() === value.toLocaleLowerCase()
      );
      choices.push({
        identity,
        value,
        dependentValue,
        label: sourceLabel,
        store: "sys_choice",
        states,
        coverage: coverageFromStates(states, languages.countedLanguageIds),
        nearDuplicates: summarizeEvidence(near, languages),
        /* dependent_value is part of a choice's identity, so a prefill without
         * it would create a row under the wrong parent and never close the gap
         * it was opened from. It is prefilled empty, not omitted. */
        links: buildRowLinks({
          origin: opts.origin,
          store: "sys_choice",
          linkKey: {
            name: source.table, element: source.field, value, dependentValue,
          },
        }, states),
      });
    });
    const states = Object.create(null);
    languages.countedLanguageIds.forEach((id) => {
      const perChoice = choices.map((choice) => choice.states[id] || { state: "missing" });
      if (perChoice.some((state) => state.state === "conflict")) {
        states[id] = { state: "conflict" };
      } else if (perChoice.every((state) => COVERED_STATES.has(state.state))) {
        states[id] = { state: "direct", direct: true };
      } else if (perChoice.every((state) => state.state === "fallback")) {
        states[id] = { state: "fallback", direct: false };
      } else if (perChoice.every((state) => state.state === "missing")) {
        states[id] = { state: "missing", direct: false };
      } else {
        states[id] = { state: "partial", direct: false };
      }
    });
    const baseIds = new Set(baseByIdentity.keys());
    const extras = included.filter((row) => {
      const language = fieldValue(row, "language");
      if (language === languages.baseLanguage) return false;
      const identity = choiceIdentity(fieldValue(row, "value"), fieldValue(row, "dependent_value"));
      return !baseIds.has(identity) || !languages.countedLanguageIds.includes(language);
    });
    const alternate = (opts.rows || []).filter((row) =>
      fieldValue(row, "element") === opts.element && fieldValue(row, "name") !== source.table
    );
    return makeRow(Object.assign({}, opts, {
      aspect: "choices",
      store: "sys_choice",
      effectiveTable: source.table,
      /* The row is the whole choice list, so it links to that list and offers
       * no prefill: its per-language state is an aggregate over every base
       * value, and there is no single row a "de is missing" prefill would
       * create. Those live on the individual entries above. */
      linkKey: { name: source.table, element: source.field },
      linkListOptions: { omitLanguage: true, omitValue: true },
      linkListOnly: true,
    }), states, {
      choices,
      extras: summarizeEvidence(extras, languages),
      alternateSources: summarizeEvidence(alternate, languages),
    });
  }

  function unescapeMessageLiteral(text, quote) {
    let out = "";
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char !== "\\" || index + 1 >= text.length) {
        out += char;
        continue;
      }
      const next = text[++index];
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === quote || next === "\\") out += next;
      else out += next;
    }
    return out;
  }

  function extractMessageKeys(sources, cap) {
    const keys = [];
    const invalid = [];
    let dynamicCount = 0;
    const seen = new Set();
    (sources || []).forEach((source) => {
      const text = String(source || "");
      const call = /(^|[^\w.])((?:gs\.)?getMessage)\s*\(/g;
      let match;
      while ((match = call.exec(text)) !== null) {
        let index = call.lastIndex;
        while (/\s/.test(text[index] || "")) index++;
        const quote = text[index];
        if (quote !== "'" && quote !== '"') {
          dynamicCount++;
          continue;
        }
        index++;
        let escaped = false;
        let body = "";
        let closed = false;
        for (; index < text.length; index++) {
          const char = text[index];
          if (escaped) {
            body += "\\" + char;
            escaped = false;
          } else if (char === "\\") {
            escaped = true;
          } else if (char === quote) {
            closed = true;
            index++;
            break;
          } else {
            body += char;
          }
        }
        if (!closed) {
          dynamicCount++;
          continue;
        }
        while (/\s/.test(text[index] || "")) index++;
        if (text[index] !== ")" && text[index] !== ",") {
          dynamicCount++;
          continue;
        }
        const key = unescapeMessageLiteral(body, quote);
        const status = queryValueStatus(key);
        if (!status.ok) {
          invalid.push({ key, reason: status.reason });
        } else if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    });
    const limit = Math.max(0, Number(cap) || MAX_MESSAGE_KEYS);
    return {
      keys: keys.slice(0, limit),
      dynamicCount,
      invalid,
      capped: keys.length > limit,
      omittedCount: Math.max(0, keys.length - limit),
    };
  }

  function analyzeMessages(keys, rows, languageContext, unavailable, origin) {
    return (keys || []).map((key) => {
      const exact = (rows || []).filter((row) => fieldValue(row, "key") === key);
      return analyzeStringRows({
        id: "message:" + key,
        element: key,
        label: key,
        aspect: "message",
        store: "sys_ui_message",
        source: key,
        rows: exact,
        languages: languageContext,
        keyField: "key",
        origin: origin || "",
        linkKey: { key },
        presenceOnly: true,
        unavailable: Boolean(unavailable),
        unavailableReason: unavailable && unavailable.error,
      });
    });
  }

  async function lookupMessage(key, languageContext, transport, origin) {
    const status = queryValueStatus(key);
    if (!status.ok) {
      const states = fixedStates(languageContext, "unverified", status.reason);
      return {
        ok: false,
        code: "validation",
        error: "Message key cannot be expressed safely (" + status.reason + ").",
        row: makeRow({
          id: "message:" + String(key || ""),
          element: String(key || ""),
          label: String(key || ""),
          aspect: "message",
          store: "sys_ui_message",
          languages: languageContext,
        }, states, { unverified: true, unverifiedReason: status.reason }),
      };
    }
    const response = await safeRead(transport, {
      table: "sys_ui_message",
      query: "messageISNOTEMPTY^key=" + status.value,
      fields: "key,language,application",
      limit: STORE_CAPS.sys_ui_message,
      options: { displayAll: true, excludeRefLinks: true },
    });
    if (!response.ok || response.truncated) {
      return {
        ok: false,
        code: response.code || "transport",
        status: response.status || 0,
        error: response.error || "Message lookup unavailable.",
        row: analyzeMessages([status.value], [], languageContext, response, origin)[0],
      };
    }
    return {
      ok: true,
      row: analyzeMessages(
        status.value ? [status.value] : [], response.rows, languageContext, null, origin
      )[0],
    };
  }

  function safeOrigin(origin) {
    let url;
    try { url = new URL(String(origin || "")); } catch (error) {
      throw createError("validation", "Invalid ServiceNow origin.");
    }
    if (
      url.protocol !== "https:" || url.username || url.password ||
      !/^[a-z0-9-]+\.service-now\.com$/i.test(url.hostname)
    ) {
      throw createError("validation", "Invalid ServiceNow origin.");
    }
    return url.origin;
  }

  /* `omitLanguage` builds the same key without its language clause, which is
   * how a row offers "every language for this key" as one list. `omitValue`
   * drops a choice's value and dependent_value, which is how a choices row
   * lists the whole choice list rather than one base value. A prefilled new
   * record never passes either: it has to name the exact row it would create,
   * so `buildNewRecordUrl` takes no options at all. */
  function storeQuery(store, key, options) {
    const opts = options || {};
    const value = key || {};
    const language = opts.omitLanguage
      ? "" : "language=" + assertIdentifier(value.language, "language");
    let parts;
    if (store === "sys_documentation") {
      parts = [
        "name=" + assertIdentifier(value.name, "table"),
        "element=" + assertIdentifier(value.element, "field"),
        language,
      ];
    } else if (store === "sys_choice") {
      const identity = [];
      if (!opts.omitValue) {
        if (!Object.prototype.hasOwnProperty.call(value, "dependentValue")) {
          throw createError("validation", "Choice dependent_value is required.");
        }
        identity.push("value=" + assertQueryValue(value.value, { allowEmpty: true }));
        identity.push(
          "dependent_value=" + assertQueryValue(value.dependentValue, { allowEmpty: true })
        );
      }
      parts = [
        "name=" + assertIdentifier(value.name, "table"),
        "element=" + assertIdentifier(value.element, "field"),
      ].concat(identity, [language]);
    } else if (store === "sys_translated") {
      parts = [
        "name=" + assertIdentifier(value.name, "table"),
        "element=" + assertIdentifier(value.element, "field"),
        "value=" + assertQueryValue(value.value),
        language,
      ];
    } else if (store === "sys_translated_text") {
      const documentKey = String(value.documentKey || "").toLowerCase();
      if (!SYS_ID_PATTERN.test(documentKey)) {
        throw createError("validation", "Invalid translated-text document key.");
      }
      parts = [
        "tablename=" + assertIdentifier(value.tableName, "table"),
        "documentkey=" + documentKey,
        "fieldname=" + assertIdentifier(value.fieldName, "field"),
        language,
      ];
    } else if (store === "sys_ui_message") {
      parts = [
        "key=" + assertQueryValue(value.key),
        language,
      ];
    } else {
      throw createError("validation", "Unknown translation store.");
    }
    return joinQuery(parts);
  }

  function buildNewRecordUrl(origin, store, key) {
    const safeStore = assertIdentifier(store, "table");
    if (!["sys_documentation", "sys_choice", "sys_translated", "sys_translated_text", "sys_ui_message"].includes(safeStore)) {
      throw createError("validation", "Unknown translation store.");
    }
    return safeOrigin(origin) + "/" + safeStore + ".do?sys_id=-1&sysparm_query=" +
      encodeURIComponent(storeQuery(safeStore, key));
  }

  function buildListUrl(origin, store, key, options) {
    const safeStore = assertIdentifier(store, "table");
    return safeOrigin(origin) + "/" + safeStore + "_list.do?sysparm_query=" +
      encodeURIComponent(storeQuery(safeStore, key, options));
  }

  /* The footer's one-button-per-table links. These filter a store to the whole
   * surface rather than to one row, so they are built from the table chain the
   * reads themselves used -- never from a row that happens to exist. A store
   * with no target returns "", and the panel disables that button. */
  function buildContextListUrl(origin, store, context) {
    const safeStore = assertIdentifier(store, "table");
    const scope = context || {};
    const tables = unique(scope.tables || []).filter((table) => TABLE_PATTERN.test(String(table)));
    let query = "";
    if (safeStore === "sys_documentation" || safeStore === "sys_choice" ||
      safeStore === "sys_translated") {
      if (!tables.length) return "";
      query = identifierIn("name", tables);
    } else if (safeStore === "sys_translated_text") {
      if (!tables.length) return "";
      const documentKey = String(scope.documentKey || "").toLowerCase();
      query = joinQuery([
        identifierIn("tablename", tables),
        SYS_ID_PATTERN.test(documentKey) ? "documentkey=" + documentKey : "",
      ]);
    } else if (safeStore === "sys_ui_message") {
      /* Only when every scanned key fits one chunk. A truncated key list would
       * open a list that silently answers a narrower question than the panel
       * asked, which is worse than offering no button. */
      const keys = unique(scope.messageKeys || []);
      if (!keys.length) return "";
      const plan = buildValueQueryChunks("", "key", keys);
      if (plan.rejected.length || plan.chunks.length !== 1) return "";
      query = plan.chunks[0].query;
    } else {
      throw createError("validation", "Unknown translation store.");
    }
    if (!query) return "";
    return safeOrigin(origin) + "/" + safeStore + "_list.do?sysparm_query=" +
      encodeURIComponent(query);
  }

  /* Row-level links. The list link names the row's key across every language;
   * a prefilled new record is offered only for a language that is actually
   * Missing, because that is the only gap creating a row would close. A key
   * the query language cannot express simply yields no link -- never a
   * half-built one. */
  function buildRowLinks(options, states) {
    const opts = options || {};
    const origin = opts.origin;
    const store = opts.store;
    const key = opts.linkKey;
    if (!origin || !store || !key) return null;
    let list = "";
    try {
      list = buildListUrl(origin, store, key, opts.linkListOptions || { omitLanguage: true });
    } catch (error) { list = ""; }
    const newRecord = Object.create(null);
    let offered = 0;
    if (!opts.linkListOnly) {
      Object.keys(states || {}).forEach((language) => {
        const state = states[language];
        if (!state || state.state !== "missing") return;
        try {
          newRecord[language] = buildNewRecordUrl(
            origin, store, Object.assign({}, key, { language })
          );
          offered++;
        } catch (error) { /* an unexpressible key offers no prefill */ }
      });
    }
    if (!list && !offered) return null;
    return { list, newRecord };
  }

  function dictionaryByField(rows, chain, fields) {
    const byField = Object.create(null);
    (fields || []).forEach((field) => {
      const matches = (rows || []).filter((row) => fieldValue(row, "element") === field);
      const selected = (chain || []).map((table) =>
        matches.find((row) => fieldValue(row, "name") === table)
      ).find(Boolean);
      if (!selected) return;
      byField[field] = {
        row: selected,
        element: field,
        definingTable: fieldValue(selected, "name"),
        internalType: fieldValue(selected, "internal_type"),
        route: routeInternalType(fieldValue(selected, "internal_type")),
      };
    });
    return byField;
  }

  /*
   * Called with rows alone, this counts every language the run counted. That
   * is the number nobody can move by hiding a column, and it stays the
   * definition of the overall score.
   *
   * Called with an explicit language list, it re-counts the same rows over
   * just those languages. On an instance carrying twenty-odd languages almost
   * no row is complete in all of them, so the unscoped "complete" count reads
   * as zero for an item that is finished in every language the team actually
   * ships -- true, and useless as a headline. The scoped count answers the
   * question a reader has instead.
   *
   * Both paths derive coverage through coverageFromStates, so a scoped count
   * can never end up applying a different rule about what "covered" means.
   * The caller is expected to show both numbers: a selection that silently
   * replaced the denominator would be a selection that can hide a gap.
   */
  function sectionSummary(rows, languageIds) {
    const scope = Array.isArray(languageIds) ? languageIds : null;
    const list = rows || [];
    let covered = 0;
    let counted = 0;
    let complete = 0;
    let partial = 0;
    let none = 0;
    list.forEach((row) => {
      if (!row) return;
      const coverage = scope ? coverageFromStates(row.states, scope) : row.coverage;
      if (!coverage || !coverage.counted) return;
      covered += coverage.covered;
      counted += coverage.counted;
      if (coverage.covered === coverage.counted) complete++;
      else if (coverage.covered > 0) partial++;
      else none++;
    });
    return {
      covered,
      counted,
      percent: counted ? Math.round((covered / counted) * 100) : null,
      complete,
      partial,
      none,
      rowCount: list.length,
      /* Proof the scope argument was honoured, so a panel running against an
       * engine that predates it cannot label an all-language number as a
       * selected-language one. */
      scoped: !!scope,
      scopeCount: scope ? scope.length : null,
    };
  }

  function summarizeResult(result) {
    const mainRows = [];
    (result.sections || []).forEach((section) => {
      if (section.id !== "messages") mainRows.push.apply(mainRows, section.rows || []);
      section.summary = sectionSummary(section.rows || []);
    });
    result.summary = sectionSummary(mainRows);
    const messageSection = (result.sections || []).find((section) => section.id === "messages");
    result.messageSummary = messageSection ? messageSection.summary : sectionSummary([]);
    return result;
  }

  /* A report exists to be handed to someone who was never on the instance,
   * so it may carry technical keys and coverage states and nothing else.
   * row.element is NOT safe by construction: a getMessage key is whatever the
   * script passed -- a whole sentence, or a URL -- and an unnamed catalog
   * variable falls back to its own sys_id in runCatalog's variables map.
   * Anything that is not a bare technical identifier is replaced by its
   * position, which still lets a reader line the line up against the panel on
   * screen. Deliberately strict: no spaces, colons or slashes, so a URL or a
   * sentence can never satisfy it. */
  const SAFE_REPORT_ELEMENT = /^[A-Za-z0-9_.-]{1,120}$/;

  function reportIdentifier(row, index) {
    const element = String((row && row.element) || "");
    const aspect = String((row && row.aspect) || "row");
    const position = aspect + " #" + (Number(index) + 1);
    if (!element) return position;
    /* A sys_id would satisfy the pattern, so it is refused by name. */
    if (SYS_ID_PATTERN.test(element)) return position;
    return SAFE_REPORT_ELEMENT.test(element) ? element : position;
  }

  function reportWarnings(row) {
    const evidence = row.evidence || {};
    const warnings = [];
    if (evidence.nearDuplicates && evidence.nearDuplicates.rowCount) warnings.push("near-duplicate");
    if (evidence.stranded && evidence.stranded.rowCount) warnings.push("stranded");
    if (evidence.alternateRegistrations && evidence.alternateRegistrations.rowCount) warnings.push("alternate-registration");
    if (Object.values(row.states || {}).some((item) => item.state === "conflict")) warnings.push("conflict");
    if (Object.values(row.states || {}).some((item) => item.state === "unavailable")) warnings.push("unavailable");
    return warnings;
  }

  function formatResultsAsText(result) {
    const lines = ["Translation Lens"];
    const context = result && result.context || {};
    lines.push("Context: " + [context.mode || context.surface || "unknown", context.table || ""].filter(Boolean).join(" / "));
    const languages = result && result.languages;
    if (languages) {
      lines.push("Languages: " + languages.shownCount + " shown; " +
        languages.countedLanguageIds.length + " counted; base " + languages.baseLanguage);
    }
    (result && result.sections || []).forEach((section) => {
      lines.push("");
      lines.push(section.label || section.id);
      (section.rows || []).forEach((row, index) => {
        const missing = (row.coverage && row.coverage.missing || []).join(",") || "none";
        const warnings = reportWarnings(row);
        lines.push(
          "- " + reportIdentifier(row, index) + " [" + row.aspect + "]: " +
          row.coverage.covered + "/" + row.coverage.counted +
          "; missing=" + missing +
          (warnings.length ? "; warnings=" + warnings.join(",") : "")
        );
      });
    });
    (result && result.failures || []).forEach((failure) => {
      lines.push("Read failure: " + failure.table + " (" + (failure.status || "unavailable") + ")");
    });
    return lines.join("\n");
  }

  function notify(context, phase, detail) {
    if (context && typeof context.onProgress === "function") {
      try { context.onProgress({ phase, detail: detail || "" }); } catch (error) {}
    }
  }

  function failureFor(table, response) {
    return {
      table,
      status: response.status || 0,
      code: response.code || "transport",
      error: response.error || "read unavailable",
      truncated: Boolean(response.truncated),
    };
  }

  async function readLanguageContext(context, transport, failures) {
    notify(context, "languages", "Reading active languages");
    const languageRead = await safeRead(transport, {
      table: "sys_language",
      query: "active=true",
      fields: "sys_id,id,name,active,fallback",
      limit: STORE_CAPS.sys_language,
      options: { displayAll: true, excludeRefLinks: true },
    });
    if (!languageRead.ok || languageRead.truncated) {
      failures.push(failureFor("sys_language", languageRead));
      return null;
    }
    const propertyRead = await safeRead(transport, {
      table: "sys_properties",
      query: "name=glide.sys.language",
      fields: "name,value",
      limit: 2,
      options: { displayAll: true, excludeRefLinks: true },
    });
    if (!propertyRead.ok) failures.push(failureFor("sys_properties", propertyRead));
    return buildLanguageContext(languageRead.rows, propertyRead.ok ? propertyRead.rows : [], context.languagePicker);
  }

  async function readChunked(transport, requests, table, failures, cap) {
    const rows = [];
    const unavailableTargets = new Set();
    let remaining = Number(cap || STORE_CAPS[table] || 2000);
    for (const request of requests || []) {
      if (remaining <= 0) {
        (request.targets || []).forEach((target) => unavailableTargets.add(target));
        failures.push({
          table,
          status: 0,
          code: "cap",
          error: "Translation read reached its bounded row cap.",
          truncated: true,
        });
        continue;
      }
      const boundedRequest = Object.assign({}, request, {
        limit: Math.min(Number(request.limit) || remaining, remaining),
      });
      const response = await safeRead(transport, boundedRequest);
      if (!response.ok || response.truncated) {
        failures.push(failureFor(table, response));
        (request.targets || []).forEach((target) => unavailableTargets.add(target));
      }
      const accepted = (response.rows || []).slice(0, remaining);
      rows.push.apply(rows, accepted);
      remaining -= accepted.length;
    }
    return { rows, unavailableTargets };
  }

  function normalizedFormFields(context) {
    const seen = new Set();
    const out = [];
    (context.fields || []).forEach((entry) => {
      const field = typeof entry === "string" ? entry : (entry.field || entry.name);
      const text = String(field || "").toLowerCase();
      if (!FIELD_PATTERN.test(text) || seen.has(text)) return;
      seen.add(text);
      out.push({
        field: text,
        label: typeof entry === "object" && entry.label ? String(entry.label) : text,
      });
    });
    return out;
  }

  async function runForm(context, transport, shared) {
    const failures = shared.failures;
    const languages = shared.languages;
    const origin = shared.origin || "";
    const table = assertIdentifier(context.table, "table");
    const fieldEntries = normalizedFormFields(context);
    const fields = fieldEntries.map((entry) => entry.field);
    notify(context, "hierarchy", "Resolving table hierarchy");
    let hierarchy;
    try {
      hierarchy = await resolveHierarchy(table, transport);
    } catch (error) {
      failures.push({ table: "sys_db_object", status: error.status || 0, code: error.code || "hierarchy", error: error.message });
      const unavailable = fieldEntries.map((entry) => makeRow({
        element: entry.field,
        label: entry.label,
        aspect: "label",
        store: "sys_documentation",
        languages,
      }, unavailableStates(languages, "hierarchy unavailable"), { unavailable: true }));
      return [{ id: "labels", label: "Field Labels", rows: unavailable }];
    }
    const chain = hierarchy.tables;
    const fieldChunkSize = derivedFieldChunkSize(
      languages.countedLanguageIds.length, chain.length, STORE_CAPS.sys_dictionary
    );
    const fieldChunks = chunkIdentifiers(fields, fieldChunkSize);
    notify(context, "dictionary", "Reading field metadata");
    const dictionaryRequests = fieldChunks.map((chunk) => ({
      table: "sys_dictionary",
      query: joinQuery([identifierIn("name", chain), identifierIn("element", chunk)]),
      fields: "name,element,internal_type,choice,choice_table,choice_field,active",
      limit: STORE_CAPS.sys_dictionary,
      options: { displayAll: true, excludeRefLinks: true },
      targets: chunk,
    }));
    const dictionaryRead = await readChunked(transport, dictionaryRequests, "sys_dictionary", failures);
    const dictionary = dictionaryByField(dictionaryRead.rows, chain, fields);
    const stringValueFields = fields.filter((field) =>
      dictionary[field] && dictionary[field].route.primary === "sys_translated"
    );
    const loadedValues = Object.assign({}, context.values || {});
    const valueLoadUnavailable = new Set();
    if (!context.isNewRecord && stringValueFields.length && typeof context.loadValues === "function") {
      notify(context, "form-values", "Reading raw translated-field sources");
      try {
        const loaded = await context.loadValues(stringValueFields.slice());
        const values = loaded && loaded.values ? loaded.values : loaded;
        stringValueFields.forEach((field) => {
          if (values && Object.prototype.hasOwnProperty.call(values, field)) {
            loadedValues[field] = String(values[field] == null ? "" : values[field]);
          } else {
            valueLoadUnavailable.add(field);
          }
        });
      } catch (error) {
        stringValueFields.forEach((field) => valueLoadUnavailable.add(field));
        failures.push({
          table: "classic form",
          status: 0,
          code: (error && error.code) || "context",
          error: String(error && error.message || error),
          truncated: false,
        });
      }
    }

    notify(context, "labels", "Reading field labels");
    const documentationRequests = fieldChunks.map((chunk) => ({
      table: "sys_documentation",
      query: joinQuery([identifierIn("name", chain), identifierIn("element", chunk)]),
      fields: "name,element,language,label,plural,hint",
      limit: STORE_CAPS.sys_documentation,
      options: { displayAll: true, excludeRefLinks: true },
      targets: chunk,
    }));
    const documentationRead = await readChunked(transport, documentationRequests, "sys_documentation", failures);

    const choiceFields = fields.filter((field) => dictionary[field] && choiceEnabled(dictionary[field].row));
    let choiceRead = { rows: [], unavailableTargets: new Set() };
    if (choiceFields.length) {
      notify(context, "choices", "Reading native choices");
      const choiceChunkSize = derivedFieldChunkSize(
        languages.countedLanguageIds.length, chain.length, STORE_CAPS.sys_choice
      );
      const requests = chunkIdentifiers(choiceFields, choiceChunkSize).map((chunk) => ({
          table: "sys_choice",
          query: joinQuery([identifierIn("name", chain), identifierIn("element", chunk)]),
          fields: "name,element,value,label,language,inactive,dependent_value",
          limit: STORE_CAPS.sys_choice,
          options: { displayAll: true, excludeRefLinks: true },
          targets: chunk,
        }));
      choiceFields.forEach((field) => {
        const row = dictionary[field].row;
        const choiceTable = fieldValue(row, "choice_table");
        const choiceField = fieldValue(row, "choice_field") || field;
        if (choiceEnabled(row) && TABLE_PATTERN.test(choiceTable) && FIELD_PATTERN.test(choiceField)) {
          requests.push({
            table: "sys_choice",
            query: joinQuery(["name=" + choiceTable, "element=" + choiceField]),
            fields: "name,element,value,label,language,inactive,dependent_value",
            limit: STORE_CAPS.sys_choice,
            options: { displayAll: true, excludeRefLinks: true },
            targets: [field],
          });
        }
      });
      choiceRead = await readChunked(transport, requests, "sys_choice", failures);
    }

    const isNewRecord = Boolean(context.isNewRecord);
    const sysId = String(context.sysId || "").toLowerCase();
    const translatableFields = fields.filter((field) => {
      const route = dictionary[field] && dictionary[field].route;
      return route && route.applicable;
    });
    let textRead = { rows: [], unavailableTargets: new Set() };
    if (!isNewRecord && SYS_ID_PATTERN.test(sysId) && translatableFields.length) {
      notify(context, "record-values", "Reading record-keyed translations");
      const chunks = chunkIdentifiers(translatableFields, fieldChunkSize);
      const requests = chunks.map((chunk) => ({
        table: "sys_translated_text",
        query: joinQuery([
          "valueISNOTEMPTY",
          identifierIn("tablename", chain),
          "documentkey=" + sysId,
          identifierIn("fieldname", chunk),
        ]),
        fields: "tablename,fieldname,documentkey,language",
        limit: STORE_CAPS.sys_translated_text,
        options: { displayAll: true, excludeRefLinks: true },
        targets: chunk,
      }));
      textRead = await readChunked(transport, requests, "sys_translated_text", failures);
    }

    const stringRowsByField = Object.create(null);
    const stringUnavailable = new Set();
    if (!isNewRecord) {
      for (const field of fields) {
        const descriptor = dictionary[field];
        if (!descriptor || descriptor.route.primary !== "sys_translated") continue;
        if (valueLoadUnavailable.has(field)) {
          stringUnavailable.add(field);
          continue;
        }
        const source = loadedValues[field];
        const status = queryValueStatus(source);
        if (!status.ok) continue;
        notify(context, "string-values", "Reading string-keyed translations");
        const queryPlan = buildValueQueryChunks(
          joinQuery([identifierIn("name", chain), "element=" + field]),
          "value",
          [status.value]
        );
        const request = queryPlan.chunks[0] && {
          table: "sys_translated",
          query: queryPlan.chunks[0].query,
          fields: "name,element,value,label,language",
          limit: STORE_CAPS.sys_translated,
          options: { displayAll: true, excludeRefLinks: true },
          targets: [field],
        };
        if (!request) continue;
        const response = await safeRead(transport, request);
        stringRowsByField[field] = response.rows || [];
        if (!response.ok || response.truncated) {
          stringUnavailable.add(field);
          failures.push(failureFor("sys_translated", response));
        }
      }
    }

    const labelRows = fieldEntries.map((entry) => {
      const descriptor = dictionary[entry.field];
      const definingTable = (descriptor && descriptor.definingTable) || table;
      return analyzeLabel({
        element: entry.field,
        label: entry.label,
        concreteTable: table,
        definingTable,
        chain,
        rows: documentationRead.rows,
        languages,
        origin,
        linkKey: { name: definingTable, element: entry.field },
        unavailable: documentationRead.unavailableTargets.has(entry.field),
        unavailableReason: "label read unavailable",
      });
    });

    const valueRows = fieldEntries.map((entry) => {
      const descriptor = dictionary[entry.field];
      if (!descriptor || dictionaryRead.unavailableTargets.has(entry.field)) {
        return makeRow({ element: entry.field, label: entry.label, aspect: "value", languages },
          unavailableStates(languages, "dictionary unavailable"), { unavailable: true });
      }
      const route = descriptor.route;
      if (isNewRecord && route.applicable) {
        return makeRow({
          element: entry.field,
          label: entry.label,
          aspect: "value",
          internalType: descriptor.internalType,
          definingTable: descriptor.definingTable,
          concreteTable: table,
          store: route.primary || "",
          languages,
        }, fixedStates(languages, "not_applicable", "new record has no per-record value"), {
          skippedForNewRecord: true,
        });
      }
      if (route.unverified) {
        return makeRow({
          element: entry.field, label: entry.label, aspect: "value",
          internalType: descriptor.internalType, definingTable: descriptor.definingTable,
          concreteTable: table, languages,
        }, fixedStates(languages, "unverified", route.reason), {
          unverified: true,
          candidateStores: route.candidateStores,
        });
      }
      if (!route.applicable) {
        return makeRow({
          element: entry.field, label: entry.label, aspect: "value",
          internalType: descriptor.internalType, definingTable: descriptor.definingTable,
          concreteTable: table, languages,
        }, fixedStates(languages, "not_applicable", "field type is not translatable"), {
          notApplicable: true,
        });
      }
      if (route.primary === "sys_translated") {
        const source = loadedValues[entry.field];
        const mirror = textRead.rows.filter((row) =>
          fieldValue(row, "documentkey") === sysId && fieldValue(row, "fieldname") === entry.field &&
          chain.includes(fieldValue(row, "tablename"))
        );
        return analyzeStringRows({
          element: entry.field,
          label: entry.label,
          aspect: "value",
          store: "sys_translated",
          internalType: descriptor.internalType,
          definingTable: descriptor.definingTable,
          concreteTable: table,
          effectiveTable: descriptor.definingTable,
          rows: stringRowsByField[entry.field] || [],
          strandedRows: mirror,
          source,
          languages,
          origin,
          /* D7: the source string reaches the address bar here. It is the raw
           * base value of a translated_field, which is what this store is
           * keyed by -- never a translated value, and never another field. */
          linkKey: queryValueStatus(source).ok
            ? { name: descriptor.definingTable, element: entry.field, value: source }
            : null,
          unavailable: stringUnavailable.has(entry.field),
          unavailableReason: "string-keyed translation read unavailable",
        });
      }
      const primary = textRead.rows.filter((row) =>
        fieldValue(row, "documentkey") === sysId && fieldValue(row, "fieldname") === entry.field &&
        chain.includes(fieldValue(row, "tablename"))
      );
      return analyzeStringRows({
        element: entry.field,
        label: entry.label,
        aspect: "value",
        store: "sys_translated_text",
        internalType: descriptor.internalType,
        definingTable: descriptor.definingTable,
        concreteTable: table,
        effectiveTable: table,
        tableField: "tablename",
        keyField: "fieldname",
        source: entry.field,
        rows: primary,
        languages,
        origin,
        linkKey: SYS_ID_PATTERN.test(sysId)
          ? { tableName: table, documentKey: sysId, fieldName: entry.field }
          : null,
        presenceOnly: true,
        unavailable: textRead.unavailableTargets.has(entry.field),
        unavailableReason: "record-keyed translation read unavailable",
      });
    });

    const choiceRows = choiceFields.map((field) => {
      const descriptor = dictionary[field];
      const source = resolveChoiceSource(descriptor.row, chain, choiceRead.rows);
      return analyzeChoices({
        element: field,
        label: fieldEntries.find((entry) => entry.field === field).label,
        concreteTable: table,
        definingTable: descriptor.definingTable,
        source,
        rows: choiceRead.rows,
        languages,
        origin,
        includeInactive: Boolean(context.includeInactive),
        unavailable: choiceRead.unavailableTargets.has(field),
        unavailableReason: "choice read unavailable",
      });
    });

    const scriptSources = [];
    notify(context, "messages", "Scanning literal message keys");
    const scriptReads = await Promise.all([
      safeRead(transport, {
        table: "sys_script_client",
        query: joinQuery([identifierIn("table", chain), "active=true"]),
        fields: "sys_id,name,script",
        limit: STORE_CAPS.sys_script_client,
        options: { displayAll: true, excludeRefLinks: true },
      }),
      safeRead(transport, {
        table: "sys_ui_policy",
        query: joinQuery([identifierIn("table", chain), "active=true", "run_scripts=true"]),
        fields: "sys_id,short_description,script_true,script_false",
        limit: STORE_CAPS.sys_ui_policy,
        options: { displayAll: true, excludeRefLinks: true },
      }),
    ]);
    scriptReads.forEach((response, index) => {
      if (!response.ok || response.truncated) {
        failures.push(failureFor(index ? "sys_ui_policy" : "sys_script_client", response));
        return;
      }
      response.rows.forEach((row) => {
        ["script", "script_true", "script_false"].forEach((field) => {
          const source = fieldValue(row, field);
          if (source) scriptSources.push(source);
        });
      });
    });
    (context.messageSources || []).forEach((source) => scriptSources.push(String(source || "")));
    const extraction = extractMessageKeys(scriptSources);
    let messageRead = { ok: true, rows: [], truncated: false };
    if (extraction.keys.length) {
      const plan = buildValueQueryChunks("messageISNOTEMPTY", "key", extraction.keys);
      const messageRequests = plan.chunks.map((chunk) => ({
        table: "sys_ui_message",
        query: chunk.query,
        fields: "key,language,application",
        limit: STORE_CAPS.sys_ui_message,
        options: { displayAll: true, excludeRefLinks: true },
        targets: chunk.values,
      }));
      const collected = await readChunked(transport, messageRequests, "sys_ui_message", failures);
      messageRead = { ok: collected.unavailableTargets.size === 0, rows: collected.rows, unavailableTargets: collected.unavailableTargets };
    }
    const messageRows = analyzeMessages(
      extraction.keys, messageRead.rows, languages, null, origin
    ).map((row) => {
      if (messageRead.unavailableTargets && messageRead.unavailableTargets.has(row.element)) {
        row.states = unavailableStates(languages, "message read unavailable");
        row.coverage = coverageFromStates(row.states, languages.countedLanguageIds);
        row.links = null;
      }
      return row;
    });

    /* What the footer's per-table buttons filter to. Recorded from the reads
     * that actually ran, so a store with nothing to point at gets no button
     * rather than one that opens an unfiltered list. */
    shared.linkTargets = {
      tables: chain.slice(),
      documentKey: SYS_ID_PATTERN.test(sysId) ? sysId : "",
      messageKeys: extraction.keys.slice(),
    };

    const sections = [
      { id: "labels", label: "Field Labels", rows: labelRows },
      { id: "values", label: "Translated Names / Fields and Text", rows: valueRows },
      { id: "choices", label: "Choices", rows: choiceRows },
      {
        id: "messages",
        label: "Messages",
        rows: messageRows,
        scan: extraction,
        separateHeadline: true,
      },
    ];
    if (typeof context.onSection === "function") {
      sections.forEach((section) => context.onSection(section));
    }
    return sections;
  }

  const CATALOG_VARIABLE_FIELDS = [
    { field: "question_text", type: "translated_field", registration: "question" },
    { field: "tooltip", type: "translated_field", registration: "question" },
    { field: "help_tag", type: "translated_field", registration: "question" },
    { field: "example_text", type: "translated_field", registration: "question" },
    { field: "help_text", type: "translated_text" },
    { field: "instructions", type: "translated_html" },
    { field: "rich_text", type: "translated_html" },
    { field: "conversational_label", type: "translated_text" },
  ];
  const CATALOG_ITEM_FIELDS = [
    { field: "name", type: "translated_text" },
    { field: "short_description", type: "translated_text" },
    { field: "description", type: "translated_html" },
  ];
  /* §2.3: sys_translated.name holds both the defining and the concrete table,
   * so a catalog list has to name every level the reads used. */
  const CATALOG_REGISTRATION_TABLES = [
    "question", "item_option_new", "question_choice", "item_option_new_set",
  ];

  /* unavailableSources is the set of source strings whose sys_translated read
   * failed or was truncated. It is separate from `unavailable`, which reports
   * only on the question_choice DEFINITION read: the definitions can read
   * perfectly while the translation read behind them fails, and without this
   * the choice would be scored as a missing translation rather than excluded
   * as unknown. Absent data is never coverage. */
  function analyzeCatalogChoice(variable, choices, stringRows, mirrorRows, languages, includeInactive, unavailable, origin, unavailableSources) {
    if (unavailable) {
      return makeRow({
        element: variable.name,
        label: variable.questionText || variable.name,
        aspect: "choices",
        store: "sys_translated",
        languages,
      }, unavailableStates(languages, "catalog choice read unavailable"), { unavailable: true });
    }
    /* List Collector, Lookup Select Box and Lookup Multiple Choice draw their
     * options from a table: the options are records, not question_choice rows,
     * so there is nothing here for a translator to do. Calling that
     * "unverified" said the read had failed, when in truth the read was never
     * applicable. Reference (type 8) is deliberately absent from the set --
     * it produces no choice row at all today, and adding it would invent rows
     * rather than remove noise.
     *
     * Marked minor so the panel folds it away by default; still emitted, so
     * the copied report can show the variable was considered. */
    if (DYNAMIC_CATALOG_TYPES.has(String(variable.type || "").toLowerCase())) {
      return makeRow({
        element: variable.name,
        label: variable.questionText || variable.name,
        aspect: "choices",
        store: "sys_translated",
        languages,
      }, fixedStates(languages, "not_applicable", "options come from a table"), {
        notApplicable: true,
        notApplicableReason:
          "this variable's options are records in another table, so it has no choice list to translate",
        minor: true,
      });
    }
    const activeChoices = (choices || []).filter((choice) => includeInactive || !choice.inactive);
    if (!activeChoices.length) {
      return makeRow({
        element: variable.name,
        label: variable.questionText || variable.name,
        aspect: "choices",
        store: "sys_translated",
        languages,
      }, fixedStates(languages, "not_applicable", "no static choices"), { notApplicable: true });
    }
    const analyzed = activeChoices.map((choice) => analyzeStringRows({
      id: "catalog-choice:" + choice.id,
      element: variable.name,
      label: choice.text,
      aspect: "choice",
      store: "sys_translated",
      source: choice.text,
      effectiveTable: "question_choice",
      rows: stringRows,
      strandedRows: (mirrorRows || []).filter((row) => fieldValue(row, "documentkey") === choice.id),
      languages,
      origin,
      /* A catalog choice is string-keyed on its own text under
       * question_choice, not on the variable it belongs to. */
      linkKey: queryValueStatus(choice.text).ok
        ? { name: "question_choice", element: "text", value: choice.text }
        : null,
      unavailable: Boolean(unavailableSources && unavailableSources.has(choice.text)),
      unavailableReason: "catalog choice translation read unavailable",
    }));
    const states = Object.create(null);
    languages.countedLanguageIds.forEach((id) => {
      const items = analyzed.map((row) => row.states[id]);
      /* Checked first and deliberately: this one state stands for every choice
       * under the variable, so a single unknown makes the verdict unknown.
       * Claiming "missing" here would turn a failed read into a counted gap,
       * which is the one thing this panel must never do. */
      if (items.some((state) => state.state === "unavailable")) {
        states[id] = { state: "unavailable", reason: "choice translation read unavailable" };
      }
      else if (items.some((state) => state.state === "conflict")) states[id] = { state: "conflict" };
      else if (items.every((state) => COVERED_STATES.has(state.state))) states[id] = { state: "direct" };
      else if (items.every((state) => state.state === "missing")) states[id] = { state: "missing" };
      else states[id] = { state: "partial" };
    });
    return makeRow({
      element: variable.name,
      label: variable.questionText || variable.name,
      aspect: "choices",
      store: "sys_translated",
      effectiveTable: "question_choice",
      languages,
    }, states, {
      choices: analyzed,
      choiceCount: analyzed.length,
      unavailable: analyzed.some((row) => row.evidence && row.evidence.unavailable),
    });
  }

  async function runCatalog(context, transport, shared) {
    const failures = shared.failures;
    const languages = shared.languages;
    const origin = shared.origin || "";
    const itemId = String(context.catalogItemSysId || context.sysId || "").toLowerCase();
    if (!SYS_ID_PATTERN.test(itemId)) throw createError("validation", "Invalid catalog item identity.");
    notify(context, "catalog", "Reading catalog definition");
    const itemRead = await safeRead(transport, {
      table: "sc_cat_item",
      query: "sys_id=" + itemId,
      fields: "sys_id,sys_class_name,name,short_description,description",
      limit: 2,
      options: { displayAll: true, excludeRefLinks: true },
    });
    if (!itemRead.ok || itemRead.truncated) failures.push(failureFor("sc_cat_item", itemRead));
    const itemRow = itemRead.rows.find((row) => fieldValue(row, "sys_id") === itemId) || null;
    const itemClass = itemRow && TABLE_PATTERN.test(fieldValue(itemRow, "sys_class_name"))
      ? fieldValue(itemRow, "sys_class_name")
      : "sc_cat_item";
    let itemChain = [itemClass];
    try {
      itemChain = (await resolveHierarchy(itemClass, transport)).tables;
    } catch (error) {
      failures.push({
        table: "sys_db_object",
        status: error.status || 0,
        code: error.code || "hierarchy",
        error: error.message,
      });
    }
    const placementRead = await safeRead(transport, {
      table: "io_set_item",
      query: "sc_cat_item=" + itemId,
      fields: "variable_set,order",
      limit: STORE_CAPS.io_set_item,
      options: { displayAll: true, excludeRefLinks: true },
    });
    if (!placementRead.ok || placementRead.truncated) failures.push(failureFor("io_set_item", placementRead));
    const setIds = unique(placementRead.rows.map((row) => fieldValue(row, "variable_set")).filter((id) => SYS_ID_PATTERN.test(id)));
    let setRead = { ok: true, rows: [], truncated: false };
    if (setIds.length) {
      setRead = await safeRead(transport, {
        table: "item_option_new_set",
        query: "sys_idIN" + setIds.join(","),
        fields: "sys_id,title,type,active,order",
        limit: STORE_CAPS.item_option_new_set,
        options: { displayAll: true, excludeRefLinks: true },
      });
      if (!setRead.ok || setRead.truncated) failures.push(failureFor("item_option_new_set", setRead));
    }
    const variableQuery = setIds.length
      ? "cat_item=" + itemId + "^ORvariable_setIN" + setIds.join(",")
      : "cat_item=" + itemId;
    const variableRead = await safeRead(transport, {
      table: "item_option_new",
      query: variableQuery,
      fields: "sys_id,name,question_text,type,variable_set,active,order,tooltip,help_tag,example_text,help_text,instructions,rich_text,conversational_label",
      limit: STORE_CAPS.item_option_new,
      options: { displayAll: true, excludeRefLinks: true },
    });
    if (!variableRead.ok || variableRead.truncated) failures.push(failureFor("item_option_new", variableRead));
    const variables = variableRead.rows.map((row) => ({
      id: fieldValue(row, "sys_id"),
      name: fieldValue(row, "name") || fieldValue(row, "sys_id"),
      questionText: fieldValue(row, "question_text"),
      type: fieldValue(row, "type"),
      setId: fieldValue(row, "variable_set"),
      active: !fieldValue(row, "active") || isTrue(row.active),
      row,
    })).filter((item) => SYS_ID_PATTERN.test(item.id) && (context.includeInactive || item.active));
    const variableIds = variables.map((item) => item.id);
    let choiceRead = { ok: true, rows: [], truncated: false };
    if (variableIds.length) {
      const choiceRequests = chunkSysIds(variableIds, 50).map((ids) => ({
        table: "question_choice",
        query: "questionIN" + ids.join(","),
        fields: "sys_id,question,text,value,inactive",
        limit: 400,
        options: { displayAll: true, excludeRefLinks: true },
        targets: ids,
      }));
      const collected = await readChunked(
        transport, choiceRequests, "question_choice", failures, 400
      );
      choiceRead = {
        ok: collected.unavailableTargets.size === 0,
        rows: collected.rows,
        truncated: collected.unavailableTargets.size > 0,
      };
    }
    const choices = choiceRead.rows.map((row) => ({
      id: fieldValue(row, "sys_id"),
      questionId: fieldValue(row, "question"),
      text: fieldValue(row, "text"),
      value: fieldValue(row, "value"),
      inactive: isTrue(row.inactive),
    })).filter((item) => SYS_ID_PATTERN.test(item.id));

    const stringSpecs = [];
    variables.forEach((variable) => {
      CATALOG_VARIABLE_FIELDS.filter((spec) => spec.type === "translated_field").forEach((spec) => {
        const source = fieldValue(variable.row, spec.field);
        if (source) stringSpecs.push({ variable, spec, source });
      });
    });
    choices.forEach((choice) => {
      if (choice.text) stringSpecs.push({ choice, spec: { field: "text", registration: "question_choice" }, source: choice.text });
    });
    (setRead.rows || []).filter((row) =>
      context.includeInactive || !fieldValue(row, "active") || isTrue(row.active)
    ).forEach((row) => {
      const source = fieldValue(row, "title");
      if (source) stringSpecs.push({ set: row, spec: { field: "title", registration: "item_option_new_set" }, source });
    });
    const stringRows = [];
    const unavailableStringSources = new Set();
    const byRegistration = new Map();
    stringSpecs.forEach((item) => {
      const key = item.spec.registration + "\u0000" + item.spec.field;
      if (!byRegistration.has(key)) byRegistration.set(key, []);
      byRegistration.get(key).push(item.source);
    });
    for (const [key, sources] of byRegistration.entries()) {
      const parts = key.split("\u0000");
      const registration = parts[0];
      const element = parts[1];
      const names = registration === "question" ? ["question", "item_option_new"] : [registration];
      const plan = buildValueQueryChunks(
        joinQuery([identifierIn("name", names), "element=" + element]),
        "value",
        sources
      );
      plan.rejected.forEach((item) => unavailableStringSources.add(item.value));
      for (const chunk of plan.chunks) {
        const response = await safeRead(transport, {
          table: "sys_translated",
          query: chunk.query,
          fields: "name,element,value,label,language",
          limit: STORE_CAPS.sys_translated,
          options: { displayAll: true, excludeRefLinks: true },
        });
        stringRows.push.apply(stringRows, response.rows || []);
        if (!response.ok || response.truncated) {
          failures.push(failureFor("sys_translated", response));
          chunk.values.forEach((value) => unavailableStringSources.add(value));
        }
      }
    }

    const mirrorRequests = [];
    chunkSysIds(variableIds, 50).forEach((ids) => {
      mirrorRequests.push({
        table: "sys_translated_text",
        query: joinQuery([
          "valueISNOTEMPTY",
          "tablenameINquestion,item_option_new",
          "documentkeyIN" + ids.join(","),
        ]),
        fields: "tablename,documentkey,fieldname,language",
        limit: STORE_CAPS.sys_translated_text,
        options: { displayAll: true, excludeRefLinks: true },
        targets: ids,
      });
    });
    if (itemRow) {
      mirrorRequests.push({
        table: "sys_translated_text",
        query: joinQuery([
          "valueISNOTEMPTY",
          identifierIn("tablename", itemChain),
          "documentkey=" + itemId,
        ]),
        fields: "tablename,documentkey,fieldname,language",
        limit: STORE_CAPS.sys_translated_text,
        options: { displayAll: true, excludeRefLinks: true },
        targets: ["catalog-item"],
      });
    }
    const choiceIds = choices.map((choice) => choice.id);
    chunkSysIds(choiceIds, 50).forEach((ids) => {
      mirrorRequests.push({
        table: "sys_translated_text",
        query: joinQuery([
          "valueISNOTEMPTY", "tablename=question_choice",
          "documentkeyIN" + ids.join(","),
        ]),
        fields: "tablename,documentkey,fieldname,language",
        limit: STORE_CAPS.sys_translated_text,
        options: { displayAll: true, excludeRefLinks: true },
        targets: ids,
      });
    });
    const mirrorRead = await readChunked(
      transport, mirrorRequests, "sys_translated_text", failures,
      STORE_CAPS.sys_translated_text
    );
    const mirrorRows = mirrorRead.rows;
    const mirrorUnavailableTargets = mirrorRead.unavailableTargets;

    const valueRows = [];
    variables.forEach((variable) => {
      CATALOG_VARIABLE_FIELDS.forEach((spec) => {
        const source = fieldValue(variable.row, spec.field);
        if (!source) return;
        if (spec.type === "translated_field") {
          valueRows.push(analyzeStringRows({
            id: "catalog:" + variable.id + ":" + spec.field,
            element: variable.name,
            label: variable.questionText || variable.name,
            aspect: spec.field === "question_text" ? "source" : spec.field,
            store: "sys_translated",
            internalType: spec.type,
            effectiveTable: spec.registration,
            rows: stringRows.filter((row) => fieldValue(row, "element") === spec.field),
            strandedRows: mirrorRows.filter((row) =>
              fieldValue(row, "documentkey") === variable.id && fieldValue(row, "fieldname") === spec.field
            ),
            source,
            languages,
            origin,
            linkKey: queryValueStatus(source).ok
              ? { name: spec.registration, element: spec.field, value: source }
              : null,
            unavailable: unavailableStringSources.has(source),
            unavailableReason: "catalog string translation read unavailable",
          }));
        } else {
          valueRows.push(analyzeStringRows({
            id: "catalog:" + variable.id + ":" + spec.field,
            element: variable.name,
            label: variable.questionText || variable.name,
            aspect: spec.field,
            store: "sys_translated_text",
            effectiveTable: "item_option_new",
            tableField: "tablename",
            keyField: "fieldname",
            source: spec.field,
            rows: mirrorRows.filter((row) =>
              fieldValue(row, "documentkey") === variable.id && fieldValue(row, "fieldname") === spec.field
            ),
            languages,
            origin,
            linkKey: SYS_ID_PATTERN.test(variable.id)
              ? { tableName: "item_option_new", documentKey: variable.id, fieldName: spec.field }
              : null,
            presenceOnly: true,
            unavailable: mirrorUnavailableTargets.has(variable.id),
            unavailableReason: "catalog text translation read unavailable",
          }));
        }
      });
    });
    if (itemRow) {
      CATALOG_ITEM_FIELDS.forEach((spec) => {
        const source = fieldValue(itemRow, spec.field);
        if (!source) return;
        valueRows.push(analyzeStringRows({
          id: "catalog-item:" + spec.field,
          element: "catalog_item",
          label: "Catalog item",
          aspect: spec.field,
          store: "sys_translated_text",
          effectiveTable: itemClass,
          tableField: "tablename",
          keyField: "fieldname",
          source: spec.field,
          rows: mirrorRows.filter((row) =>
            fieldValue(row, "documentkey") === itemId &&
            fieldValue(row, "fieldname") === spec.field &&
            itemChain.includes(fieldValue(row, "tablename"))
          ),
          languages,
          origin,
          linkKey: { tableName: itemClass, documentKey: itemId, fieldName: spec.field },
          presenceOnly: true,
          unavailable: mirrorUnavailableTargets.has("catalog-item"),
          unavailableReason: "catalog item translation read unavailable",
        }));
      });
    }
    (setRead.rows || []).filter((row) =>
      context.includeInactive || !fieldValue(row, "active") || isTrue(row.active)
    ).forEach((row, setIndex) => {
      const id = fieldValue(row, "sys_id");
      const source = fieldValue(row, "title");
      if (!source) return;
      valueRows.push(analyzeStringRows({
        id: "set:" + id + ":title",
        element: "variable_set_" + (setIndex + 1),
        label: "Variable set",
        aspect: "set title",
        store: "sys_translated",
        effectiveTable: "item_option_new_set",
        rows: stringRows.filter((item) => fieldValue(item, "element") === "title"),
        source,
        languages,
        origin,
        linkKey: queryValueStatus(source).ok
          ? { name: "item_option_new_set", element: "title", value: source }
          : null,
        unavailable: unavailableStringSources.has(source),
      }));
    });
    const choiceRows = variables.filter((variable) =>
      DYNAMIC_CATALOG_TYPES.has(String(variable.type || "").toLowerCase()) ||
      choices.some((choice) => choice.questionId === variable.id)
    ).map((variable) => analyzeCatalogChoice(
        variable,
        choices.filter((choice) => choice.questionId === variable.id),
        stringRows.filter((row) => fieldValue(row, "name") === "question_choice" && fieldValue(row, "element") === "text"),
        mirrorRows.filter((row) => fieldValue(row, "tablename") === "question_choice" && fieldValue(row, "fieldname") === "text"),
        languages,
        Boolean(context.includeInactive),
        !choiceRead.ok || choiceRead.truncated,
        origin,
        unavailableStringSources
      ));

    const scripts = await Promise.all([
      safeRead(transport, {
        table: "catalog_script_client",
        query: setIds.length
          ? "active=true^cat_item=" + itemId + "^ORvariable_setIN" + setIds.join(",")
          : "cat_item=" + itemId + "^active=true",
        fields: "sys_id,name,script",
        limit: STORE_CAPS.catalog_script_client,
        options: { displayAll: true, excludeRefLinks: true },
      }),
      safeRead(transport, {
        table: "catalog_ui_policy",
        query: setIds.length
          ? "active=true^run_scripts=true^catalog_item=" + itemId + "^ORvariable_setIN" + setIds.join(",")
          : "catalog_item=" + itemId + "^active=true^run_scripts=true",
        fields: "sys_id,short_description,script_true,script_false",
        limit: STORE_CAPS.catalog_ui_policy,
        options: { displayAll: true, excludeRefLinks: true },
      }),
    ]);
    const messageSources = [];
    scripts.forEach((response, index) => {
      if (!response.ok || response.truncated) {
        failures.push(failureFor(index ? "catalog_ui_policy" : "catalog_script_client", response));
        return;
      }
      response.rows.forEach((row) => {
        ["script", "script_true", "script_false"].forEach((field) => {
          if (fieldValue(row, field)) messageSources.push(fieldValue(row, field));
        });
      });
    });
    const extraction = extractMessageKeys(messageSources.concat(context.messageSources || []));
    let messageRows = [];
    if (extraction.keys.length) {
      const plan = buildValueQueryChunks("messageISNOTEMPTY", "key", extraction.keys);
      const requests = plan.chunks.map((chunk) => ({
        table: "sys_ui_message",
        query: chunk.query,
        fields: "key,language,application",
        limit: STORE_CAPS.sys_ui_message,
        options: { displayAll: true, excludeRefLinks: true },
        targets: chunk.values,
      }));
      const read = await readChunked(transport, requests, "sys_ui_message", failures);
      messageRows = analyzeMessages(
        extraction.keys, read.rows, languages, null, origin
      ).map((row) => {
        if (read.unavailableTargets.has(row.element)) {
          row.states = unavailableStates(languages, "message read unavailable");
          row.coverage = coverageFromStates(row.states, languages.countedLanguageIds);
          row.links = null;
        }
        return row;
      });
    }
    /* The catalog registration tables plus the item's own class chain: the
     * two families the catalog reads actually touched. */
    shared.linkTargets = {
      tables: unique(CATALOG_REGISTRATION_TABLES.concat(itemChain)),
      documentKey: itemId,
      messageKeys: extraction.keys.slice(),
    };
    const sections = [
      { id: "values", label: "Catalog Text", rows: valueRows },
      { id: "choices", label: "Choices", rows: choiceRows },
      { id: "messages", label: "Messages", rows: messageRows, scan: extraction, separateHeadline: true },
    ];
    if (typeof context.onSection === "function") {
      sections.forEach((section) => context.onSection(section));
    }
    return sections;
  }

  function mergeLinkTargets(first, second) {
    const left = first || {};
    const right = second || {};
    return {
      tables: unique((left.tables || []).concat(right.tables || [])),
      documentKey: left.documentKey || right.documentKey || "",
      messageKeys: unique((left.messageKeys || []).concat(right.messageKeys || [])),
    };
  }

  const FOOTER_STORES = [
    "sys_documentation", "sys_choice", "sys_translated",
    "sys_translated_text", "sys_ui_message",
  ];

  function buildFooterLinks(origin, targets) {
    if (!origin || !targets) return null;
    const links = Object.create(null);
    let any = false;
    FOOTER_STORES.forEach((store) => {
      let url = "";
      try { url = buildContextListUrl(origin, store, targets); } catch (error) { url = ""; }
      if (!url) return;
      links[store] = url;
      any = true;
    });
    return any ? links : null;
  }

  async function run(context, transport) {
    const input = context || {};
    const mode = String(input.mode || "form").toLowerCase();
    if (!["form", "catalog"].includes(mode)) {
      throw createError("validation", "Unknown Translation Lens mode.");
    }
    const failures = [];
    /* One origin check for the whole run. An unusable origin is not fatal --
     * the reads do not need it -- it simply means no row and no footer button
     * offers a link, which the panel renders as disabled rather than broken. */
    let origin = "";
    try { origin = safeOrigin(input.origin); } catch (error) { origin = ""; }
    const languages = await readLanguageContext(input, transport, failures);
    if (!languages) {
      return summarizeResult({
        version: VERSION,
        context: { mode, table: input.table || "", isNewRecord: Boolean(input.isNewRecord) },
        languages: null,
        sections: [],
        failures,
        unavailable: true,
      });
    }
    const shared = { languages, failures, origin, linkTargets: null };
    let sections;
    if (mode === "catalog") {
      sections = await runCatalog(input, transport, shared);
      const catalogTargets = shared.linkTargets;
      if (input.formContext) {
        const formContext = Object.assign({}, input.formContext, {
          mode: "form",
          onProgress: input.onProgress,
          languagePicker: input.languagePicker,
          includeInactive: input.includeInactive,
        });
        const formSections = await runForm(formContext, transport, shared);
        /* The definition form contributes its own tables and scanned keys to
         * the footer; neither half's targets may swallow the other's. */
        shared.linkTargets = mergeLinkTargets(catalogTargets, shared.linkTargets);
        const formRows = [];
        formSections.filter((section) => section.id !== "messages").forEach((section) => {
          formRows.push.apply(formRows, section.rows || []);
        });
        const messageSection = sections.find((section) => section.id === "messages");
        const formMessages = formSections.find((section) => section.id === "messages");
        if (messageSection && formMessages) {
          const seen = new Set((messageSection.rows || []).map((row) => row.element));
          (formMessages.rows || []).forEach((row) => {
            if (!seen.has(row.element)) messageSection.rows.push(row);
          });
        }
        const messageIndex = sections.findIndex((section) => section.id === "messages");
        sections.splice(messageIndex < 0 ? sections.length : messageIndex, 0, {
          id: "form-fields",
          label: "Form fields",
          rows: formRows,
          subsections: formSections.filter((section) => section.id !== "messages"),
          collapsed: true,
        });
      }
    } else sections = await runForm(input, transport, shared);
    return summarizeResult({
      version: VERSION,
      context: {
        mode,
        surface: input.surface || mode,
        table: input.table || "",
        isNewRecord: Boolean(input.isNewRecord),
      },
      languages,
      sections,
      failures,
      links: buildFooterLinks(origin, shared.linkTargets),
      unavailable: false,
    });
  }

  globalThis.SNTranslationLens = {
    VERSION,
    MAX_QUERY_LENGTH,
    MAX_VALUE_CHUNK,
    MAX_MESSAGE_KEYS,
    STORE_CAPS,
    rawValue,
    fieldValue,
    queryValueStatus,
    assertQueryValue,
    buildValueQueryChunks,
    derivedFieldChunkSize,
    chunkIdentifiers,
    routeInternalType,
    resolveHierarchy,
    buildLanguageContext,
    englishVariantPreset,
    atomState,
    applyFallbacks,
    coverageFromStates,
    analyzeStringRows,
    analyzeLabel,
    choiceEnabled,
    resolveChoiceSource,
    choiceIdentity,
    analyzeChoices,
    extractMessageKeys,
    analyzeMessages,
    lookupMessage,
    storeQuery,
    buildNewRecordUrl,
    buildListUrl,
    buildContextListUrl,
    buildRowLinks,
    dictionaryByField,
    sectionSummary,
    summarizeResult,
    reportIdentifier,
    formatResultsAsText,
    readChunked,
    runForm,
    runCatalog,
    run,
    tableGet: defaultTransport,
  };
})();

/*
 * Record Search — bounded table lookup, live schema discovery, safe query
 * construction, and client-side result verification for read-only searches.
 * Lazily injected with record_search_ui.js; kept DOM-free for Node tests.
 */
(function () {
  if (globalThis.SNRecordSearch) return;

  const MIN_ANCHOR_LENGTH = 3;
  const TABLE_LOOKUP_MIN_LENGTH = 2;
  const RESULT_LIMIT = 20;
  const SERVER_LIMIT = 50;
  const TABLE_SUGGESTION_LIMIT = 50;
  const TABLE_LOOKUP_CANDIDATE_LIMIT = 50;
  const REQUEST_TIMEOUT_MS = 20000;
  const OPTIONAL_DICTIONARY_TIMEOUT_MS = 8000;
  const MAX_HIERARCHY_DEPTH = 20;
  const MAX_SEARCH_FIELDS = 6;
  const MAX_DICTIONARY_FIELDS = 250;
  const DICTIONARY_CANDIDATE_LIMIT = 100;
  const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
  const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
  const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;
  const ANCHOR_SAFE_RUN = /[A-Za-z0-9_]+/g;
  /* Import set staging tables extend this one. A staging table can carry the
   * exact label of the table its rows are loaded into, and is usually emptied
   * once they are, so it is named wherever it can be mistaken for that one. */
  const IMPORT_SET_ROW_TABLE = "sys_import_set_row";

  /* Presets are preferences only. A field is usable only after a live
   * sys_dictionary row confirms it on the selected table hierarchy. */
  const KNOWN_TABLE_PRESETS = Object.freeze({
    task: ["number", "short_description"],
    incident: ["number", "short_description"],
    change_request: ["number", "short_description"],
    problem: ["number", "short_description"],
    sc_request: ["number", "short_description"],
    sc_req_item: ["number", "short_description"],
    sc_task: ["number", "short_description"],
    sys_user: ["user_name", "name", "first_name", "last_name", "email"],
    sys_user_group: ["name", "email"],
    cmdb_ci: ["name", "asset_tag", "serial_number", "short_description"],
    sys_properties: ["name", "description"],
    sys_db_object: ["label", "name"],
    kb_knowledge: ["number", "short_description"],
  });
  const GENERIC_FIELD_PRIORITY = [
    "number", "name", "short_description", "title", "user_name", "email",
  ];
  const TEXT_TYPES = new Set([
    "string", "email", "url", "phone_number", "translated",
    "translated_field", "translated_text",
  ]);
  /* HTML/script types never enter TEXT_TYPES. Value/body/secret-like strings
   * remain available for explicit selection but are never defaults. */
  const SENSITIVE_AUTO_FIELD_PATTERN =
    /(^|_)(value|body|html|content|script|password|passwd|secret|token|credential|api_key)($|_)/i;
  const tableInfoCache = new Map();

  /* Value filters. A filter is always an exact `field=value` on a reference
   * or choice field the live dictionary offers, never a LIKE. */
  const MAX_FILTERS = 3;
  const FILTER_VALUE_LIMIT = 300;
  const FILTER_FIELD_READ_LIMIT = 1000;
  const CHOICE_READ_LIMIT = 1000;
  const ORDER_FIELD = "sys_updated_on";
  const LANGUAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
  const CHOICE_STRING_TYPES = new Set(["string", "translated_field", "translated_text"]);
  /* State, Priority, Impact and Urgency are integer choice fields, and they are
   * the filters people most want. Their values read back as the same string
   * sys_choice.value holds. */
  const CHOICE_INTEGER_TYPES = new Set(["integer"]);
  /* sys_choice ships an active row whose value is this sentinel and whose
   * label is a raw javascript: expression. */
  const CHOICE_SENTINEL_VALUES = new Set(["NULL_OVERRIDE"]);
  const filterFieldCache = new Map();
  const displayColumnCache = new Map();
  const languageCache = new Map();

  function createError(code, message, status) {
    const error = new Error(message);
    error.code = code;
    error.status = Number(status) || 0;
    return error;
  }

  function rawValue(value) {
    if (value == null) return "";
    if (typeof value === "object") {
      if (value.value != null) return String(value.value);
      if (value.display_value != null) return String(value.display_value);
    }
    return String(value);
  }

  function displayValue(value) {
    if (value == null) return "";
    if (typeof value === "object") {
      if (value.display_value != null && String(value.display_value)) {
        return String(value.display_value);
      }
      if (value.value != null) return String(value.value);
    }
    return String(value);
  }

  function longestSafeRun(value) {
    const text = String(value == null ? "" : value);
    let best = "";
    let match;
    ANCHOR_SAFE_RUN.lastIndex = 0;
    while ((match = ANCHOR_SAFE_RUN.exec(text)) !== null) {
      if (match[0].length > best.length) best = match[0];
    }
    return best;
  }

  function extractAnchor(term) {
    const best = longestSafeRun(term);
    return best.length >= MIN_ANCHOR_LENGTH ? best : null;
  }

  function extractTableLookupAnchor(input) {
    const best = longestSafeRun(input);
    return best.length >= TABLE_LOOKUP_MIN_LENGTH ? best : null;
  }

  function tableLookupNeedles(input) {
    const text = String(input == null ? "" : input).trim();
    const anchor = extractTableLookupAnchor(text);
    if (!anchor) return null;
    /* A clean multi-word label can be narrowed without allowing encoded-query
     * syntax through. Search its label phrase and technical-name equivalent;
     * inputs containing operators or punctuation keep the single safe anchor. */
    if (/^[A-Za-z0-9_]+(?:\s+[A-Za-z0-9_]+)+$/.test(text)) {
      const words = text.split(/\s+/);
      return { label: words.join(" "), name: words.join("_") };
    }
    return { label: anchor, name: anchor };
  }

  /* `allowEmptyTerm` is for a search carried by its filters alone. Text stays
   * optional only then; a search with neither is refused as before. */
  function parseSearch(tableInput, termInput, options) {
    const table = String(tableInput == null ? "" : tableInput).trim().toLowerCase();
    const term = String(termInput == null ? "" : termInput).trim();
    if (!table || !TABLE_NAME_PATTERN.test(table)) {
      return {
        ok: false,
        code: "validation",
        error: "Choose a verified table from the suggestions.",
      };
    }
    if (!term) {
      if (options && options.allowEmptyTerm) {
        return { ok: true, table, term: "", isSysId: false, anchor: "", filterOnly: true };
      }
      return { ok: false, code: "validation", error: "Enter text or a sys_id to find." };
    }
    const isSysId = SYS_ID_PATTERN.test(term);
    const anchor = isSysId ? term.toLowerCase() : extractAnchor(term);
    if (!anchor) {
      return {
        ok: false,
        code: "validation",
        error: "Enter at least " + MIN_ANCHOR_LENGTH +
          " consecutive letters, numbers, or underscores.",
      };
    }
    return { ok: true, table, term, isSysId, anchor };
  }

  function assertSafeTable(table) {
    const value = String(table == null ? "" : table).trim().toLowerCase();
    if (!TABLE_NAME_PATTERN.test(value)) {
      throw createError("validation", "The selected table name is not safe.");
    }
    return value;
  }

  function assertSafeField(field) {
    const value = String(field == null ? "" : field);
    if (!FIELD_NAME_PATTERN.test(value)) {
      throw createError("schema", "Unsafe field name returned by table metadata.");
    }
    return value;
  }

  function assertSafeAnchor(anchor) {
    const value = String(anchor == null ? "" : anchor);
    if (!/^[A-Za-z0-9_]+$/.test(value) || value.length < MIN_ANCHOR_LENGTH) {
      throw createError("validation", "Unsafe or too-short search anchor.");
    }
    return value;
  }

  function buildSearchQuery(fields, anchor) {
    const safeAnchor = assertSafeAnchor(anchor);
    const safeFields = Array.from(new Set((fields || []).map(assertSafeField)));
    if (!safeFields.length) {
      throw createError("validation", "Select at least one verified field to search.");
    }
    if (safeFields.length > MAX_SEARCH_FIELDS) {
      throw createError("validation", "Select no more than six fields to search.");
    }
    return safeFields
      .map((field, index) => (index ? "OR" : "") + field + "LIKE" + safeAnchor)
      .join("^");
  }

  function createSessionTracker() {
    let current = 0;
    return {
      next() { current += 1; return current; },
      cancel() { current += 1; },
      isCurrent(id) { return id === current; },
    };
  }

  function transportErrorMessage(status, table) {
    if (status === 401) {
      return "ServiceNow did not authorize this read. Refresh the page or sign in again.";
    }
    if (status === 403) {
      return table === "sys_db_object" || table === "sys_dictionary" ||
        table === "sys_documentation"
        ? "You do not have access to the table metadata needed for Record Search."
        : "You do not have read access to the selected table.";
    }
    if (status === 404) return "The selected table was not found or is not exposed to the Table API.";
    if (status === 429) return "ServiceNow is temporarily rate-limiting reads. Wait a moment and try again.";
    if (status >= 500) return "ServiceNow could not complete the read. Try again in a moment.";
    return "The read did not reach ServiceNow. Check the page connection and try again.";
  }

  function transportErrorCode(status) {
    if (status === 401 || status === 403) return "access";
    if (status === 404) return "schema";
    return "transient";
  }

  async function defaultTransport(request) {
    if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      throw createError("transient", "Record Search transport is unavailable.");
    }
    const response = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => finish(
        reject,
        createError(
          "transient",
          "ServiceNow took too long to complete the read. Try again.",
          0
        )
      ), request.timeoutMs || REQUEST_TIMEOUT_MS);
      chrome.runtime.sendMessage({
        type: "SN_RECORD_SEARCH_GET",
        table: request.table,
        query: request.query || "",
        fields: request.fields || "",
        limit: request.limit || SERVER_LIMIT,
        options: request.options || {},
      }).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    });
    if (!response || !response.ok) {
      const status = (response && response.status) || 0;
      throw createError(
        transportErrorCode(status),
        transportErrorMessage(status, request.table),
        status
      );
    }
    return response.result || [];
  }

  async function getRows(get, request) {
    const rows = await get(request);
    return Array.isArray(rows) ? rows : [];
  }

  function normalizeTableRow(row) {
    const name = rawValue(row && row.name).trim().toLowerCase();
    if (!TABLE_NAME_PATTERN.test(name)) return null;
    return { name, label: displayValue(row.label).trim() || name };
  }

  function tableSuggestionRank(item, needles) {
    const label = item.label.toLowerCase();
    const name = item.name.toLowerCase();
    const labelNeedle = needles.label.toLowerCase();
    const nameNeedle = needles.name.toLowerCase();
    if (label === labelNeedle) return 0;
    if (name === nameNeedle) return 1;
    if (label.startsWith(labelNeedle)) return 2;
    if (name.startsWith(nameNeedle)) return 3;
    if (label.includes(labelNeedle)) return 4;
    if (name.includes(nameNeedle)) return 5;
    return 6;
  }

  async function findTables(input, options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const needles = tableLookupNeedles(input);
    if (!needles) return [];
    const request = (table, query) => getRows(get, {
      table,
      query,
      fields: "name,label",
      limit: TABLE_LOOKUP_CANDIDATE_LIMIT,
      options: { displayAll: true, excludeRefLinks: true },
    });
    /* Keep label and technical-name candidate windows independent. A broad
     * technical-name match set must not crowd a useful label match out before
     * client-side verification and ranking. */
    const labelQuery =
      "elementISEMPTY^labelLIKE" + needles.label + "^ORDERBYlabel^ORDERBYname";
    /* Which candidates are staging tables, read alongside rather than after,
     * so the lookup is no slower. `^OR` binds to its neighbour only: staging
     * AND (name OR label). Optional: a failed read loses only the tags. */
    const stagingQuery = "super_class.name=" + IMPORT_SET_ROW_TABLE +
      "^nameLIKE" + needles.name.toLowerCase() + "^ORlabelLIKE" + needles.label;
    const stagingLimit = TABLE_LOOKUP_CANDIDATE_LIMIT * 2;
    const [labelRows, nameRows, stagingRows] = await Promise.all([
      /* ServiceNow stores user-facing table labels as documentation records.
       * Fall back to sys_db_object.label only when those rows are unreadable. */
      request("sys_documentation", labelQuery).catch(() =>
        request(
          "sys_db_object",
          "labelLIKE" + needles.label + "^ORDERBYlabel^ORDERBYname"
        )
      ),
      request(
        "sys_db_object",
        "nameLIKE" + needles.name.toLowerCase() + "^ORDERBYname^ORDERBYlabel"
      ),
      getRows(get, {
        table: "sys_db_object",
        query: stagingQuery,
        fields: "name",
        limit: stagingLimit,
        options: { excludeRefLinks: true },
      }).catch(() => []),
    ]);
    const staging = new Set(stagingRows.map((row) => rawValue(row && row.name).trim().toLowerCase()));
    /* A full staging window is an arbitrary slice, and could miss the very
     * candidates on screen. Those are then asked about by name, once. */
    if (stagingRows.length >= stagingLimit) {
      const unchecked = Array.from(new Set(labelRows.concat(nameRows)
        .map(normalizeTableRow)
        .filter((item) => item && !staging.has(item.name))
        .map((item) => item.name)));
      if (unchecked.length) {
        const more = await getRows(get, {
          table: "sys_db_object",
          query: "super_class.name=" + IMPORT_SET_ROW_TABLE + "^nameIN" + unchecked.join(","),
          fields: "name",
          limit: unchecked.length,
          options: { excludeRefLinks: true },
        }).catch(() => []);
        more.forEach((row) => staging.add(rawValue(row && row.name).trim().toLowerCase()));
      }
    }
    const seen = new Set();
    const nameNeedle = needles.name.toLowerCase();
    const labelNeedle = needles.label.toLowerCase();
    /* A staging table is listed after the tables people mean, unless its own
     * technical name was typed, which is asking for it. Compared directly: a
     * table labelled with its own name ranks as an exact label first. */
    const stagingRank = (item) => (item.staging && item.name !== nameNeedle ? 1 : 0);
    const matches = labelRows.concat(nameRows)
      .map(normalizeTableRow)
      .filter((item) => item && (
        item.name.toLowerCase().includes(nameNeedle) ||
        item.label.toLowerCase().includes(labelNeedle)
      ))
      .filter((item) => !seen.has(item.name) && seen.add(item.name))
      .map((item) => (staging.has(item.name) ? Object.assign(item, { staging: true }) : item))
      .sort((a, b) =>
        stagingRank(a) - stagingRank(b) ||
        tableSuggestionRank(a, needles) - tableSuggestionRank(b, needles) ||
        a.label.length - b.label.length ||
        a.label.localeCompare(b.label) ||
        a.name.localeCompare(b.name)
      );
    const suggestions = matches.slice(0, TABLE_SUGGESTION_LIMIT);
    suggestions.truncated =
      labelRows.length >= TABLE_LOOKUP_CANDIDATE_LIMIT ||
      nameRows.length >= TABLE_LOOKUP_CANDIDATE_LIMIT ||
      matches.length > TABLE_SUGGESTION_LIMIT;
    return suggestions;
  }

  /* Starred tables come from the worker, which validated them on write. They
   * are still only candidates: selecting one resolves it live like any other.
   * An empty box lists them all; typed text matches them exactly as a live
   * suggestion is matched, through the same needles. */
  function favoriteMatches(favorites, input) {
    const list = (Array.isArray(favorites) ? favorites : []).filter((item) =>
      item && typeof item.name === "string" && TABLE_NAME_PATTERN.test(item.name)
    );
    const text = String(input == null ? "" : input).trim();
    if (!text) return list.slice();
    const needles = tableLookupNeedles(text);
    if (!needles) return [];
    const nameNeedle = needles.name.toLowerCase();
    const labelNeedle = needles.label.toLowerCase();
    return list.filter((item) =>
      item.name.includes(nameNeedle) ||
      String(item.label || "").toLowerCase().includes(labelNeedle)
    );
  }

  /* Matching favourites first, in their stored order, then live results with
   * any favourite removed, so a table never appears twice and a favourite's
   * position does not move when the live results arrive. The active option is
   * kept by name rather than reset to the top. */
  function mergeFavoritesIntoOptions(favorites, lookupResults, input, activeName) {
    const starred = favoriteMatches(favorites, input).map((item) => ({
      name: item.name,
      label: String(item.label || "") || item.name,
      starred: true,
    }));
    const starredNames = new Set(starred.map((item) => item.name));
    const live = (Array.isArray(lookupResults) ? lookupResults : [])
      .filter((item) => item && !starredNames.has(item.name));
    const options = starred.concat(live);
    options.truncated = Boolean(lookupResults && lookupResults.truncated);
    const found = activeName ? options.findIndex((item) => item.name === activeName) : -1;
    return {
      options,
      activeIndex: found >= 0 ? found : (options.length ? 0 : -1),
    };
  }

  async function readTableRow(table, get) {
    const rows = await getRows(get, {
      table: "sys_db_object",
      query: "name=" + assertSafeTable(table),
      fields: "name,label,super_class.name",
      limit: 1,
      options: { excludeRefLinks: true },
    });
    return rows[0] || null;
  }

  async function resolveHierarchy(table, get, shouldStop) {
    const safeTable = assertSafeTable(table);
    const hierarchy = [];
    const seen = new Set();
    let current = safeTable;
    while (current && hierarchy.length < MAX_HIERARCHY_DEPTH && !seen.has(current)) {
      if (shouldStop && shouldStop()) return [];
      seen.add(current);
      const row = await readTableRow(current, get);
      if (!row) {
        if (!hierarchy.length) {
          throw createError(
            "schema",
            "That table was not found, is inactive, or its metadata is not readable."
          );
        }
        break;
      }
      const normalized = normalizeTableRow(row);
      if (!normalized) {
        throw createError("schema", "The table metadata returned an unsafe table name.");
      }
      hierarchy.push(normalized);
      current = rawValue(row["super_class.name"]).trim().toLowerCase();
      if (current && !TABLE_NAME_PATTERN.test(current)) {
        throw createError("schema", "The table metadata returned an unsafe parent table name.");
      }
    }
    return hierarchy;
  }

  function isSensitiveAutoField(name, type) {
    return SENSITIVE_AUTO_FIELD_PATTERN.test(String(name || "")) ||
      /html|script|journal|password|encrypted/i.test(String(type || ""));
  }

  function normalizeDictionaryField(row, hierarchyRank) {
    const name = rawValue(row.element);
    const type = rawValue(row.internal_type).toLowerCase();
    if (!FIELD_NAME_PATTERN.test(name) || !TEXT_TYPES.has(type)) return null;
    return {
      name,
      label: displayValue(row.column_label) || name,
      type,
      display: rawValue(row.display).toLowerCase() === "true",
      autoSelectable: !isSensitiveAutoField(name, type),
      rank: hierarchyRank.get(rawValue(row.name).toLowerCase()) ?? 999,
    };
  }

  function presetCandidatesForHierarchy(hierarchy) {
    const result = [];
    hierarchy.forEach((item) => {
      (KNOWN_TABLE_PRESETS[item.name] || []).forEach((name) => result.push(name));
    });
    GENERIC_FIELD_PRIORITY.forEach((name) => result.push(name));
    return Array.from(new Set(result));
  }

  function safeFieldNames(names) {
    if (!Array.isArray(names)) return [];
    return Array.from(new Set(names.filter((name) =>
      typeof name === "string" && FIELD_NAME_PATTERN.test(name)
    ))).slice(0, MAX_SEARCH_FIELDS);
  }

  function emptyRemembered() {
    return { requested: [], verified: [], absent: [], unverifiable: [] };
  }

  async function readDictionaryFields(hierarchy, get, rememberedFields) {
    const names = hierarchy.map((item) => item.name);
    const hierarchyRank = new Map(names.map((name, index) => [name, index]));
    const base = "nameIN" + names.join(",");
    const remembered = safeFieldNames(rememberedFields);
    /* The ordering column for filter-only results is verified here, in the
     * bounded read, so that order never depends on whether the capped
     * optional read happened to reach it. */
    const candidates = Array.from(new Set(
      presetCandidatesForHierarchy(hierarchy).concat(remembered, [ORDER_FIELD])
    ));
    const request = (query, limit, timeoutMs) => getRows(get, {
      table: "sys_dictionary",
      query,
      fields: "name,element,column_label,internal_type,display",
      limit,
      options: { displayAll: true, excludeRefLinks: true },
      timeoutMs,
    });
    const [displayRows, candidateRows, allRows] = await Promise.all([
      request(base + "^display=true^active=true", 100),
      request(
        base + "^elementIN" + candidates.join(",") + "^active=true",
        DICTIONARY_CANDIDATE_LIMIT
      ),
      request(
        base + "^active=true^elementISNOTEMPTY^ORDERBYcolumn_label",
        MAX_DICTIONARY_FIELDS,
        OPTIONAL_DICTIONARY_TIMEOUT_MS
      ).catch(() => []),
    ]);
    const normalized = displayRows.concat(candidateRows, allRows)
      .map((row) => normalizeDictionaryField(row, hierarchyRank))
      .filter(Boolean);
    const byName = new Map();
    normalized.forEach((field) => {
      const previous = byName.get(field.name);
      if (!previous || field.display || field.rank < previous.rank) byName.set(field.name, field);
    });
    const priority = new Map(GENERIC_FIELD_PRIORITY.map((name, index) => [name, index]));
    const fields = Array.from(byName.values()).sort((a, b) => {
      if (a.display !== b.display) return a.display ? -1 : 1;
      const priorityA = priority.get(a.name) ?? 999;
      const priorityB = priority.get(b.name) ?? 999;
      if (priorityA !== priorityB) return priorityA - priorityB;
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.label.localeCompare(b.label) || a.name.localeCompare(b.name);
    });
    /* A remembered field is confirmed only by its own row in the bounded
     * candidate read, never by the optional read that can degrade to []. A
     * full candidate window could have cut its row off, so a field missing
     * from one is unverifiable rather than gone. */
    const confirmed = new Set(candidateRows
      .map((row) => normalizeDictionaryField(row, hierarchyRank))
      .filter(Boolean)
      .map((field) => field.name));
    const windowFull = candidateRows.length >= DICTIONARY_CANDIDATE_LIMIT;
    const missing = remembered.filter((name) => !confirmed.has(name));
    const orderField = candidateRows.some((row) => rawValue(row && row.element) === ORDER_FIELD)
      ? ORDER_FIELD : "";
    return {
      fields,
      orderField,
      remembered: {
        requested: remembered,
        verified: remembered.filter((name) => confirmed.has(name)),
        absent: windowFull ? [] : missing,
        unverifiable: windowFull ? missing : [],
      },
    };
  }

  async function discoverFields(hierarchy, get) {
    return (await readDictionaryFields(hierarchy, get)).fields;
  }

  function chooseDefaultFields(table, hierarchy, fields) {
    const byName = new Map(fields.map((field) => [field.name, field]));
    const presetTable = [table].concat(hierarchy.map((item) => item.name))
      .find((name) => KNOWN_TABLE_PRESETS[name]);
    const preset = presetTable ? KNOWN_TABLE_PRESETS[presetTable] : null;
    let selected = (preset || [])
      .map((name) => byName.get(name))
      .filter((field) => field && field.autoSelectable);
    if (!selected.length) {
      const displayFields = fields.filter((field) => field.display && field.autoSelectable);
      const fallbackFields = GENERIC_FIELD_PRIORITY
        .map((name) => byName.get(name))
        .filter((field) => field && field.autoSelectable);
      selected = displayFields.concat(fallbackFields);
    }
    return Array.from(new Map(selected.map((field) => [field.name, field])).values())
      .slice(0, MAX_SEARCH_FIELDS);
  }

  async function resolveTableInfo(table, options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || null;
    const safeTable = assertSafeTable(table);
    /* A favourite's remembered fields join the candidate read, so they are
     * part of what was read and therefore part of the key. A search on that
     * table passes the same list and verifies against the same read. */
    const remembered = safeFieldNames(opts.rememberedFields);
    const cacheKey = String(opts.origin || "") + "|" + safeTable + "|" + remembered.join(",");
    if (!opts.noCache && tableInfoCache.has(cacheKey)) return tableInfoCache.get(cacheKey);
    const hierarchy = await resolveHierarchy(safeTable, get, shouldStop);
    if (!hierarchy.length) throw createError("cancelled", "Record Search was cancelled.");
    const staging = hierarchy.some((item) => item.name === IMPORT_SET_ROW_TABLE);
    if (shouldStop && shouldStop()) {
      return {
        table: safeTable,
        label: hierarchy[0].label,
        hierarchy: hierarchy.map((item) => item.name),
        staging,
        fields: [],
        defaultFields: [],
        remembered: emptyRemembered(),
        orderField: "",
      };
    }
    const read = await readDictionaryFields(hierarchy, get, remembered);
    const fields = read.fields;
    const info = {
      table: safeTable,
      label: hierarchy[0].label,
      hierarchy: hierarchy.map((item) => item.name),
      staging,
      fields,
      defaultFields: chooseDefaultFields(safeTable, hierarchy, fields),
      remembered: read.remembered,
      orderField: read.orderField,
    };
    if (!opts.noCache) tableInfoCache.set(cacheKey, info);
    return info;
  }

  function selectVerifiedFields(tableInfo, selectedNames) {
    const available = new Map((tableInfo.fields || []).map((field) => [field.name, field]));
    const requested = Array.isArray(selectedNames) && selectedNames.length
      ? selectedNames
      : (tableInfo.defaultFields || []).map((field) => field.name);
    const unique = Array.from(new Set(requested.map(assertSafeField)));
    if (unique.length > MAX_SEARCH_FIELDS) {
      throw createError("validation", "Select no more than six fields to search.");
    }
    const verified = unique.map((name) => available.get(name)).filter(Boolean);
    if (verified.length !== unique.length) {
      throw createError("schema", "The selected fields no longer match the live dictionary.");
    }
    return verified;
  }

  /* ------------------------------------------------------------------ *
   * Value filters
   * ------------------------------------------------------------------ */

  function isTrue(value) {
    const text = rawValue(value).trim().toLowerCase();
    return text === "true" || text === "1";
  }

  /* Translation Lens's rule, copied: "none" is no choice list, as are 0 and
   * false. Impersonate's looser test counts "none" as one. */
  function choiceEnabled(row) {
    const value = rawValue(row && row.choice).trim().toLowerCase();
    return Boolean(value && !["0", "false", "none"].includes(value));
  }

  /*
   * One field per element, the nearest definition winning, and only the two
   * shapes whose values can be offered as a verified list: a reference with
   * a named table, or a string or integer field with a choice list.
   * Sensitive names and types are never offered.
   */
  function filterFieldsFrom(rows, hierarchyNames) {
    const rank = new Map((hierarchyNames || []).map((name, index) => [name, index]));
    const nearest = new Map();
    (rows || []).forEach((row) => {
      const name = rawValue(row && row.element);
      if (!FIELD_NAME_PATTERN.test(name)) return;
      const position = rank.get(rawValue(row.name).toLowerCase()) ?? 999;
      const previous = nearest.get(name);
      if (!previous || position < previous.position) nearest.set(name, { row, position });
    });
    const fields = [];
    nearest.forEach(({ row, position }, name) => {
      const type = rawValue(row.internal_type).toLowerCase();
      if (isSensitiveAutoField(name, type)) return;
      const label = displayValue(row.column_label).trim() || name;
      const definingTable = rawValue(row.name).toLowerCase();
      if (type === "reference") {
        const reference = rawValue(row["reference.name"]).trim().toLowerCase();
        if (!TABLE_NAME_PATTERN.test(reference)) return;
        fields.push({ name, label, type, kind: "reference", reference, definingTable, rank: position });
        return;
      }
      if ((CHOICE_STRING_TYPES.has(type) || CHOICE_INTEGER_TYPES.has(type)) && choiceEnabled(row)) {
        fields.push({
          name,
          label,
          type,
          kind: "choice",
          choiceTable: rawValue(row.choice_table).trim().toLowerCase(),
          choiceField: rawValue(row.choice_field).trim(),
          definingTable,
          rank: position,
        });
      }
    });
    return fields.sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
  }

  /* A dedicated read, never the optional all-fields read that degrades to an
   * empty list: a timeout here is an error, not "no fields". */
  async function resolveFilterFields(table, options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || null;
    const safeTable = assertSafeTable(table);
    const cacheKey = String(opts.origin || "") + "|" + safeTable;
    if (!opts.noCache && filterFieldCache.has(cacheKey)) return filterFieldCache.get(cacheKey);
    const hierarchy = (await resolveHierarchy(safeTable, get, shouldStop)).map((item) => item.name);
    if (!hierarchy.length) throw createError("cancelled", "Record Search was cancelled.");
    const rows = await getRows(get, {
      table: "sys_dictionary",
      query: "nameIN" + hierarchy.join(",") + "^active=true^elementISNOTEMPTY^ORDERBYelement",
      fields: "name,element,column_label,internal_type,choice,choice_table,choice_field,reference.name",
      limit: FILTER_FIELD_READ_LIMIT + 1,
      options: { displayAll: true, excludeRefLinks: true },
    });
    const info = {
      table: safeTable,
      hierarchy,
      fields: filterFieldsFrom(rows.slice(0, FILTER_FIELD_READ_LIMIT), hierarchy),
      truncated: rows.length > FILTER_FIELD_READ_LIMIT,
    };
    if (!opts.noCache) filterFieldCache.set(cacheKey, info);
    return info;
  }

  function nearestElement(rows, rank, predicate) {
    let best = null;
    (rows || []).forEach((row) => {
      const element = rawValue(row && row.element);
      if (!FIELD_NAME_PATTERN.test(element) || (predicate && !predicate(row))) return;
      const position = rank.get(rawValue(row.name).toLowerCase()) ?? 999;
      if (!best || position < best.position) best = { element, position };
    });
    return best ? best.element : "";
  }

  /*
   * The referenced table's display column, in the order verified on the PDI:
   *   1. the nearest display_override row on its hierarchy;
   *   2. else the nearest display=true dictionary row;
   *   3. else `name`, but only when the hierarchy defines a `name` field --
   *      the platform's own fallback, which sys_user, sys_user_group and
   *      cmdb_ci all rely on;
   *   4. else none, and the picker takes a pasted sys_id.
   * Which column the platform renders when an override disagrees with the
   * walk was not observable, so the walk's column comes back as a hint. A
   * wrong column costs labels only: the condition is field=<sys_id>.
   */
  async function resolveDisplayColumn(table, options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || null;
    const safeTable = assertSafeTable(table);
    const cacheKey = String(opts.origin || "") + "|" + safeTable;
    if (!opts.noCache && displayColumnCache.has(cacheKey)) return displayColumnCache.get(cacheKey);
    const hierarchy = (await resolveHierarchy(safeTable, get, shouldStop)).map((item) => item.name);
    if (!hierarchy.length) throw createError("cancelled", "Record Search was cancelled.");
    const rank = new Map(hierarchy.map((name, index) => [name, index]));
    const chain = "nameIN" + hierarchy.join(",");
    let overrideUnread = false;
    const [overrideRows, dictionaryRows] = await Promise.all([
      getRows(get, {
        table: "sys_dictionary_override",
        query: chain + "^display_override=true",
        fields: "name,element",
        limit: 50,
        options: { displayAll: true, excludeRefLinks: true },
      }).catch(() => { overrideUnread = true; return []; }),
      /* `^OR` binds to its neighbour only: active AND (display OR name). */
      getRows(get, {
        table: "sys_dictionary",
        query: chain + "^active=true^display=true^ORelement=name",
        fields: "name,element,display",
        limit: 100,
        options: { displayAll: true, excludeRefLinks: true },
      }),
    ]);
    const override = nearestElement(overrideRows, rank);
    const displayRow = nearestElement(dictionaryRows, rank, (row) => isTrue(row.display));
    const hasName = dictionaryRows.some((row) => rawValue(row && row.element) === "name");
    const walk = displayRow || (hasName ? "name" : "");
    const info = {
      table: safeTable,
      column: override || walk,
      hint: override && walk && override !== walk ? walk : "",
      source: override ? "override" : displayRow ? "display" : walk ? "name" : "none",
      overrideUnread,
    };
    if (!opts.noCache) displayColumnCache.set(cacheKey, info);
    return info;
  }

  /*
   * A value that was chosen, never typed, still has to be checked. Beyond
   * Impersonate's rules: `null` in any case is the platform's keyword for
   * "is empty", so a literal null value can never be filtered correctly; and
   * whitespace at either end could not be observed to round-trip.
   */
  function queryValueProblem(value) {
    const raw = String(value == null ? "" : value);
    if (/javascript\s*:/i.test(raw)) return "the instance would run this value as a script";
    if (!raw || !raw.trim()) return "this value is empty";
    if (raw.length > 255) return "this value is too long for a filter";
    if (/[\^\r\n]/.test(raw)) return "a filter cannot express this value";
    return "";
  }

  function choiceValueProblem(value) {
    const raw = String(value == null ? "" : value);
    const problem = queryValueProblem(raw);
    if (problem) return problem;
    if (CHOICE_SENTINEL_VALUES.has(raw)) return "this is a platform placeholder, not a real value";
    if (/^null$/i.test(raw)) return "the instance reads this value as empty";
    if (raw !== raw.trim()) return "a value with spaces at either end cannot be matched exactly";
    return "";
  }

  /* Copied from Translation Lens's verified order, adapted to this file's
   * case-sensitive field pattern: an explicit choice_table redirect first,
   * else the concrete table, else ancestors nearest first. The rows must
   * already have been read chain-wide. */
  function resolveChoiceSource(field, chain, rows) {
    const choiceField = (field && field.choiceField) || (field && field.name) || "";
    if (field && field.choiceTable && TABLE_NAME_PATTERN.test(field.choiceTable) &&
      FIELD_NAME_PATTERN.test(choiceField)) {
      return { table: field.choiceTable, field: choiceField, redirected: true };
    }
    for (const table of chain || []) {
      if ((rows || []).some((row) =>
        rawValue(row && row.name).toLowerCase() === table && rawValue(row.element) === field.name
      )) {
        return { table, field: field.name, redirected: false };
      }
    }
    return { table: "", field: field ? field.name : "", redirected: false };
  }

  /* A dependent choice can repeat a label under another parent, so options
   * are de-duplicated by value and always show the raw value as a hint. */
  function choiceOptionsFrom(rows) {
    const seen = new Set();
    const values = [];
    (rows || []).forEach((row) => {
      const value = rawValue(row && row.value);
      const label = displayValue(row && row.label).trim();
      if (isTrue(row && row.inactive) || choiceValueProblem(value)) return;
      if (/javascript\s*:/i.test(label) || seen.has(value)) return;
      seen.add(value);
      values.push({ value, label: label || value, hint: value });
    });
    return values.sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  }

  function referenceOptionsFrom(rows, column, hintColumn) {
    const seen = new Set();
    const values = [];
    (rows || []).forEach((row) => {
      const sysId = rawValue(row && row.sys_id).toLowerCase();
      if (!SYS_ID_PATTERN.test(sysId) || seen.has(sysId)) return;
      const label = displayValue(row[column]).trim();
      if (!label) return;
      seen.add(sysId);
      const hint = hintColumn ? displayValue(row[hintColumn]).trim() : "";
      values.push({ value: sysId, label, hint: hint && hint !== label ? hintColumn + ": " + hint : "" });
    });
    return values;
  }

  async function resolveLanguage(options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const cacheKey = String(opts.origin || "");
    if (!opts.noCache && languageCache.has(cacheKey)) return languageCache.get(cacheKey);
    let language = "en";
    try {
      const rows = await getRows(get, {
        table: "sys_properties",
        query: "name=glide.sys.language",
        fields: "name,value",
        limit: 1,
        timeoutMs: OPTIONAL_DICTIONARY_TIMEOUT_MS,
      });
      const value = rawValue(rows[0] && rows[0].value).trim();
      if (LANGUAGE_PATTERN.test(value)) language = value;
    } catch (error) {
      /* Unreadable is not an error: English is the platform default, and the
       * list is still scoped to one language. */
    }
    if (!opts.noCache) languageCache.set(cacheKey, language);
    return language;
  }

  async function loadReferenceValues(field, opts) {
    const get = opts.get || defaultTransport;
    const display = await resolveDisplayColumn(field.reference, opts);
    const table = assertSafeTable(field.reference);
    const qualifierNote = "All records in " + table + ", not the form's filtered list.";
    const term = String(opts.term == null ? "" : opts.term).trim();
    const pastedId = SYS_ID_PATTERN.test(term) ? term.toLowerCase() : "";
    if (!display.column) {
      return {
        kind: "reference",
        table,
        values: pastedId ? [{ value: pastedId, label: pastedId, hint: "pasted sys_id" }] : [],
        truncated: false,
        noDisplayColumn: true,
        note: "No display column is verified for " + table + ", so paste a record's sys_id.",
      };
    }
    const column = assertSafeField(display.column);
    const hintColumn = display.hint ? assertSafeField(display.hint) : "";
    /* Past the cap the list becomes a type-ahead that narrows on the server;
     * filtering the first page locally would only search what happened to
     * fit. A pasted sys_id is looked up directly. */
    const anchor = pastedId ? "" : (term ? extractAnchor(term) : null);
    const query = pastedId
      ? "sys_id=" + pastedId
      : (anchor ? column + "LIKE" + assertSafeAnchor(anchor) + "^" : "") + "ORDERBY" + column;
    const rows = await getRows(get, {
      table,
      query,
      fields: ["sys_id", column].concat(hintColumn ? [hintColumn] : []).join(","),
      limit: FILTER_VALUE_LIMIT + 1,
      options: { displayAll: true, excludeRefLinks: true },
    });
    /* Rows came back and none has a label: an access answer, not an empty
     * table. */
    if (rows.length && rows.every((row) => !displayValue(row && row[column]).trim())) {
      throw createError(
        "access",
        "The display column of " + table + " could not be read, so its records cannot be listed."
      );
    }
    const values = narrowFilterValues({
      kind: "reference",
      values: referenceOptionsFrom(rows.slice(0, FILTER_VALUE_LIMIT), column, hintColumn),
    }, pastedId ? "" : term).values;
    return {
      kind: "reference",
      table,
      values,
      truncated: rows.length > FILTER_VALUE_LIMIT,
      searched: Boolean(anchor || pastedId),
      displayColumn: column,
      hintColumn,
      note: (pastedId && !values.length ? "No record with that sys_id in " + table + ". " : "") +
        qualifierNote + (display.overrideUnread
          ? " Display overrides could not be read, so labels use the dictionary's display column."
          : ""),
    };
  }

  /* The one narrowing rule for a loaded value list, used by both loaders and
   * by the panel's cache of complete lists: a reference matches on its
   * label, a choice on its label or raw value. */
  function narrowFilterValues(result, term) {
    const needle = String(term == null ? "" : term).trim().toLowerCase();
    if (!result || !needle) return result;
    return Object.assign({}, result, {
      values: (result.values || []).filter((item) =>
        item.label.toLowerCase().includes(needle) ||
        (result.kind === "choice" && item.value.toLowerCase().includes(needle))),
    });
  }

  /*
   * The source is decided as Translation Lens decides it -- a choice_table
   * redirect, else the nearest table on the chain with ANY row for the
   * element, in any language -- before a language is chosen. Choosing the
   * language first would let a parent's translation outrank the concrete
   * table's own list. One row per table is enough to know, so a large
   * multilingual list cannot crowd the answer out of a capped read.
   */
  async function loadChoiceValues(field, hierarchy, opts) {
    const get = opts.get || defaultTransport;
    const name = assertSafeField(field.name);
    const request = (query, limit) => getRows(get, {
      table: "sys_choice",
      query,
      fields: "name,element,value,label,language,inactive,dependent_value",
      limit,
      options: { displayAll: true, excludeRefLinks: true },
    });
    const redirect = field.choiceTable && TABLE_NAME_PATTERN.test(field.choiceTable) &&
      FIELD_NAME_PATTERN.test(field.choiceField || name);
    const probeRows = redirect ? [] : [].concat(...await Promise.all(hierarchy.map((table) =>
      request("name=" + assertSafeTable(table) + "^element=" + name, 1))));
    const source = resolveChoiceSource(field, hierarchy, probeRows);
    if (!source.table) {
      return { kind: "choice", values: [], truncated: false, language: "",
        note: "No choice values are defined for this field." };
    }
    const language = await resolveLanguage(opts);
    const read = (lang) => request(
      "name=" + assertSafeTable(source.table) + "^element=" + assertSafeField(source.field) +
        "^language=" + lang,
      CHOICE_READ_LIMIT + 1
    );
    let used = language;
    let rows = await read(language);
    if (!rows.length && language !== "en") {
      used = "en";
      rows = await read("en");
    }
    const values = narrowFilterValues({ kind: "choice", values: choiceOptionsFrom(rows) }, opts.term).values;
    const dependent = rows.some((row) => rawValue(row.dependent_value).trim());
    return {
      kind: "choice",
      values: values.slice(0, FILTER_VALUE_LIMIT),
      truncated: rows.length > CHOICE_READ_LIMIT || values.length > FILTER_VALUE_LIMIT,
      language: used,
      source,
      note: (rows.length ? "Labels in the instance language (" + used + ")"
        : "No choice labels in " + language + (language === "en" ? "" : " or en")) +
        (dependent ? " · not narrowed by the field this one depends on" : "") + ".",
    };
  }

  /* Complete lists are kept per table and field for one panel, so typing
   * narrows them here instead of re-reading the instance on every pause. A
   * capped list, a pasted sys_id and a table with no verified display
   * column always go back to the instance. */
  function createFilterValueLoader(load) {
    const complete = new Map();
    return async (table, field, term) => {
      const key = String(table) + "|" + String(field);
      const text = String(term == null ? "" : term).trim();
      if (complete.has(key) && !SYS_ID_PATTERN.test(text)) {
        return narrowFilterValues(complete.get(key), text);
      }
      const loaded = await load(table, field, text);
      if (!text && loaded && !loaded.truncated && !loaded.noDisplayColumn) complete.set(key, loaded);
      return loaded;
    };
  }

  /* The field must be one the live filter-field list offers: that binding is
   * what keeps a referenced table out of a query unless the dictionary named
   * it for a field the picker shows. */
  async function loadFilterValues(table, fieldName, options) {
    const opts = options || {};
    const filterInfo = await resolveFilterFields(table, opts);
    const field = filterInfo.fields.find((item) => item.name === fieldName);
    if (!field) throw createError("schema", "That field is not one the filter offers.");
    return field.kind === "reference"
      ? loadReferenceValues(field, opts)
      : loadChoiceValues(field, filterInfo.hierarchy, opts);
  }

  /* Exact conditions, AND-ed, one per field, bound to the discovered list in
   * the builder itself rather than only in the panel. */
  function filterConditions(filters, filterInfo) {
    const list = Array.isArray(filters) ? filters : [];
    if (list.length > MAX_FILTERS) {
      throw createError("validation", "Use no more than three filters.");
    }
    const offered = new Map(((filterInfo && filterInfo.fields) || []).map((item) => [item.name, item]));
    const seen = new Set();
    return list.map((filter) => {
      const name = assertSafeField(filter && filter.field);
      const field = offered.get(name);
      if (!field) {
        throw createError("schema", "That filter field is not one the live dictionary offers.");
      }
      if (seen.has(name)) throw createError("validation", "Each field can be filtered once.");
      seen.add(name);
      const value = String(filter.value == null ? "" : filter.value);
      if (field.kind === "reference") {
        if (!SYS_ID_PATTERN.test(value)) {
          throw createError("validation", "A reference filter needs a record's sys_id.");
        }
        return { field, value: value.toLowerCase(), clause: name + "=" + value.toLowerCase() };
      }
      const problem = choiceValueProblem(value);
      if (problem) throw createError("validation", "That value cannot be used as a filter: " + problem + ".");
      return { field, value, clause: name + "=" + value };
    });
  }

  /* Filters first, then at most one chain. `^OR` binds to what precedes it,
   * so the order is asserted rather than assumed: a later edit must not be
   * able to slip a filter in after the text chain. */
  function composeQuery(parts) {
    let chainSeen = false;
    (parts || []).forEach((part) => {
      if (part.kind === "chain") {
        if (chainSeen) throw createError("validation", "A search has one text condition.");
        chainSeen = true;
      } else if (part.kind === "filter") {
        if (chainSeen) throw createError("validation", "Filters must precede the text condition.");
        if (/[\^\r\n]/.test(part.clause)) throw createError("validation", "A filter is one condition.");
      } else {
        throw createError("validation", "Unknown query part.");
      }
    });
    return (parts || []).map((part) => part.clause).join("^");
  }

  function verifyFilters(row, conditions) {
    return (conditions || []).every((condition) => {
      const actual = rawValue(row && row[condition.field.name]);
      return condition.field.kind === "reference"
        ? actual.toLowerCase() === condition.value
        : actual === condition.value;
    });
  }

  function verifyRow(row, fields, term) {
    const needle = String(term).toLowerCase();
    return fields.some((field) =>
      displayValue(row[field.name]).toLowerCase().includes(needle)
    );
  }

  function normalizeResult(row, tableInfo, fields) {
    const sysId = rawValue(row.sys_id);
    if (!SYS_ID_PATTERN.test(sysId)) return null;
    const values = fields.map((field) => ({
      field: field.name,
      label: field.label,
      value: displayValue(row[field.name]),
    })).filter((item) => item.value);
    return {
      table: tableInfo.table,
      tableLabel: tableInfo.label,
      sysId,
      title: values.length ? values[0].value : sysId,
      values,
    };
  }

  function valueMatchRank(value, term) {
    const text = String(value == null ? "" : value).toLowerCase();
    const needle = String(term == null ? "" : term).toLowerCase();
    if (!needle || !text.includes(needle)) return 4;
    if (text === needle) return 0;
    const index = text.indexOf(needle);
    if (index === 0) return 1;
    return /[a-z0-9_]/i.test(text[index - 1]) ? 3 : 2;
  }

  function sortVerifiedResults(results, term) {
    return (results || []).slice().sort((a, b) => {
      const rank = (result) => Math.min.apply(null,
        (result.values || []).map((item) => valueMatchRank(item.value, term)).concat([4])
      );
      return rank(a) - rank(b) ||
        String(a.title || a.sysId).localeCompare(
          String(b.title || b.sysId),
          undefined,
          { numeric: true, sensitivity: "base" }
        ) ||
        String(a.sysId).localeCompare(String(b.sysId));
    });
  }

  async function runSearch(parsed, options) {
    if (!parsed || !parsed.ok) throw createError("validation", "Invalid record search.");
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || (() => false);
    const rememberedFields = opts.rememberedFields;
    let tableInfo;
    if (parsed.isSysId) {
      try {
        tableInfo = await resolveTableInfo(parsed.table, {
          get, origin: opts.origin, shouldStop, rememberedFields,
        });
      } catch (error) {
        if (shouldStop()) return { stale: true, results: [] };
        tableInfo = {
          table: parsed.table,
          label: parsed.table,
          hierarchy: [parsed.table],
          fields: [],
          defaultFields: [],
          remembered: emptyRemembered(),
        };
      }
    } else {
      tableInfo = await resolveTableInfo(parsed.table, {
        get, origin: opts.origin, shouldStop, rememberedFields,
      });
      if (shouldStop()) return { stale: true, results: [] };
    }
    if (shouldStop()) return { stale: true, results: [] };
    const filters = Array.isArray(opts.filters) ? opts.filters : [];
    const filterOnly = Boolean(parsed.filterOnly);
    if (filterOnly && !filters.length) {
      throw createError("validation", "Enter text or a sys_id, or complete a filter.");
    }
    let conditions = [];
    if (filters.length) {
      const filterInfo = await resolveFilterFields(parsed.table, {
        get, origin: opts.origin, shouldStop,
      });
      if (shouldStop()) return { stale: true, results: [] };
      conditions = filterConditions(filters, filterInfo);
    }
    const selectedFields = tableInfo.fields.length
      ? selectVerifiedFields(tableInfo, opts.fields)
      : [];
    if (!parsed.isSysId && !filterOnly && !selectedFields.length) {
      throw createError(
        "schema",
        "No verified text fields are selected. Choose at least one readable field."
      );
    }
    const fieldNames = selectedFields.map((field) => field.name);
    const parts = conditions.map((condition) => ({ kind: "filter", clause: condition.clause }));
    if (parsed.isSysId) parts.push({ kind: "chain", clause: "sys_id=" + parsed.anchor });
    else if (!filterOnly) parts.push({ kind: "chain", clause: buildSearchQuery(fieldNames, parsed.anchor) });
    let query = composeQuery(parts);
    /* With no term there is nothing to rank by, so the server's order is
     * kept and named, rather than re-sorted into alphabetical titles. */
    let orderLabel = "";
    if (filterOnly) {
      const byUpdated = tableInfo.orderField === ORDER_FIELD;
      query += byUpdated ? "^ORDERBYDESC" + ORDER_FIELD : "^ORDERBYsys_id";
      orderLabel = byUpdated ? "most recently updated" : "sys_id";
    }
    const readFields = Array.from(new Set(
      ["sys_id"].concat(fieldNames, conditions.map((condition) => condition.field.name))
    ));
    const rows = await getRows(get, {
      table: parsed.table,
      query,
      fields: readFields.join(","),
      limit: parsed.isSysId ? 1 : SERVER_LIMIT,
      options: { displayAll: true, excludeRefLinks: true },
    });
    if (shouldStop()) return { stale: true, results: [] };
    /* A field the session cannot read comes back blank, not missing. Rows
     * that all lack the filter's value were not verified as matches; they
     * are an access answer, and must not read as "no matches". */
    const unreadable = conditions.find((condition) => rows.length &&
      rows.every((row) => !rawValue(row && row[condition.field.name]).trim()));
    if (unreadable) {
      throw createError(
        "access",
        "The filter field " + unreadable.field.label +
          " could not be read back, so no row could be verified."
      );
    }
    const verified = rows
      .filter((row) => verifyFilters(row, conditions) &&
        (parsed.isSysId || filterOnly || verifyRow(row, selectedFields, parsed.term)))
      .map((row) => normalizeResult(row, tableInfo, selectedFields))
      .filter(Boolean);
    const ordered = parsed.isSysId || filterOnly
      ? verified
      : sortVerifiedResults(verified, parsed.term);
    const results = ordered.slice(0, RESULT_LIMIT);
    return {
      stale: false,
      table: tableInfo.table,
      tableLabel: tableInfo.label,
      term: parsed.term,
      bySysId: Boolean(parsed.isSysId),
      staging: Boolean(tableInfo.staging),
      fields: selectedFields,
      availableFields: tableInfo.fields,
      results,
      filterOnly,
      filters: conditions.map((condition) => ({
        field: condition.field.name,
        label: condition.field.label,
        value: condition.value,
      })),
      sortLabel: filterOnly
        ? orderLabel
        : parsed.isSysId || !selectedFields.length
          ? ""
          : "relevance, then " + selectedFields[0].label,
      truncated: rows.length >= SERVER_LIMIT || verified.length > RESULT_LIMIT,
      serverFull: rows.length >= SERVER_LIMIT,
      candidateCount: rows.length,
    };
  }

  function buildRecordUrl(origin, result) {
    const table = assertSafeTable(result && result.table);
    const sysId = rawValue(result && result.sysId);
    if (!SYS_ID_PATTERN.test(sysId)) throw createError("validation", "Invalid result sys_id.");
    return String(origin || "") + "/" + table + ".do?sys_id=" + encodeURIComponent(sysId);
  }

  function buildResultListUrl(origin, searchResult) {
    const table = assertSafeTable(searchResult && searchResult.table);
    const ids = Array.from(new Set(
      ((searchResult && searchResult.results) || [])
        .map((item) => rawValue(item && item.sysId))
        .filter((id) => SYS_ID_PATTERN.test(id))
    )).slice(0, RESULT_LIMIT);
    if (!ids.length) throw createError("validation", "There are no verified results to open.");
    return String(origin || "") + "/" + table + "_list.do?sysparm_query=" +
      encodeURIComponent("sys_idIN" + ids.join(","));
  }

  globalThis.SNRecordSearch = {
    MIN_ANCHOR_LENGTH,
    TABLE_LOOKUP_MIN_LENGTH,
    RESULT_LIMIT,
    SERVER_LIMIT,
    TABLE_SUGGESTION_LIMIT,
    TABLE_LOOKUP_CANDIDATE_LIMIT,
    REQUEST_TIMEOUT_MS,
    OPTIONAL_DICTIONARY_TIMEOUT_MS,
    MAX_SEARCH_FIELDS,
    MAX_FILTERS,
    FILTER_VALUE_LIMIT,
    FILTER_FIELD_READ_LIMIT,
    KNOWN_TABLE_PRESETS,
    GENERIC_FIELD_PRIORITY,
    SUMMARY_FIELD_PRIORITY: GENERIC_FIELD_PRIORITY,
    rawValue,
    displayValue,
    extractAnchor,
    extractTableLookupAnchor,
    tableLookupNeedles,
    tableSuggestionRank,
    parseSearch,
    buildSearchQuery,
    createSessionTracker,
    findTables,
    favoriteMatches,
    mergeFavoritesIntoOptions,
    resolveHierarchy,
    discoverFields,
    chooseDefaultFields,
    resolveTableInfo,
    selectVerifiedFields,
    choiceEnabled,
    filterFieldsFrom,
    resolveFilterFields,
    resolveDisplayColumn,
    queryValueProblem,
    choiceValueProblem,
    resolveChoiceSource,
    choiceOptionsFrom,
    narrowFilterValues,
    loadFilterValues,
    createFilterValueLoader,
    filterConditions,
    composeQuery,
    verifyFilters,
    verifyRow,
    normalizeResult,
    valueMatchRank,
    sortVerifiedResults,
    runSearch,
    buildRecordUrl,
    buildResultListUrl,
    tableGet: defaultTransport,
  };
})();

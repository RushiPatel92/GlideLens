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
  const TABLE_SUGGESTION_LIMIT = 12;
  const MAX_HIERARCHY_DEPTH = 20;
  const MAX_SEARCH_FIELDS = 6;
  const MAX_DICTIONARY_FIELDS = 250;
  const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
  const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
  const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;
  const ANCHOR_SAFE_RUN = /[A-Za-z0-9_]+/g;

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

  function parseSearch(tableInput, termInput) {
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
      return table === "sys_db_object" || table === "sys_dictionary"
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
    const response = await chrome.runtime.sendMessage({
      type: "SN_RECORD_SEARCH_GET",
      table: request.table,
      query: request.query || "",
      fields: request.fields || "",
      limit: request.limit || SERVER_LIMIT,
      options: request.options || {},
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

  async function findTables(input, options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const anchor = extractTableLookupAnchor(input);
    if (!anchor) return [];
    const rows = await getRows(get, {
      table: "sys_db_object",
      query: "nameLIKE" + anchor + "^ORlabelLIKE" + anchor + "^ORDERBYlabel^ORDERBYname",
      fields: "name,label",
      limit: TABLE_SUGGESTION_LIMIT,
      options: { displayAll: true, excludeRefLinks: true },
    });
    const seen = new Set();
    const needle = anchor.toLowerCase();
    return rows
      .map(normalizeTableRow)
      .filter((item) => item && (
        item.name.toLowerCase().includes(needle) ||
        item.label.toLowerCase().includes(needle)
      ))
      .filter((item) => !seen.has(item.name) && seen.add(item.name))
      .slice(0, TABLE_SUGGESTION_LIMIT);
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

  async function discoverFields(hierarchy, get) {
    const names = hierarchy.map((item) => item.name);
    const hierarchyRank = new Map(names.map((name, index) => [name, index]));
    const base = "nameIN" + names.join(",");
    const candidates = presetCandidatesForHierarchy(hierarchy);
    const request = (query, limit) => getRows(get, {
      table: "sys_dictionary",
      query,
      fields: "name,element,column_label,internal_type,display",
      limit,
      options: { displayAll: true, excludeRefLinks: true },
    });
    const [displayRows, candidateRows, allRows] = await Promise.all([
      request(base + "^display=true^active=true", 100),
      request(base + "^elementIN" + candidates.join(",") + "^active=true", 100),
      request(
        base + "^active=true^elementISNOTEMPTY^ORDERBYcolumn_label",
        MAX_DICTIONARY_FIELDS
      ),
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
    return Array.from(byName.values()).sort((a, b) => {
      if (a.display !== b.display) return a.display ? -1 : 1;
      const priorityA = priority.get(a.name) ?? 999;
      const priorityB = priority.get(b.name) ?? 999;
      if (priorityA !== priorityB) return priorityA - priorityB;
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.label.localeCompare(b.label) || a.name.localeCompare(b.name);
    });
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
    const cacheKey = String(opts.origin || "") + "|" + safeTable;
    if (!opts.noCache && tableInfoCache.has(cacheKey)) return tableInfoCache.get(cacheKey);
    const hierarchy = await resolveHierarchy(safeTable, get, shouldStop);
    if (!hierarchy.length) throw createError("cancelled", "Record Search was cancelled.");
    if (shouldStop && shouldStop()) {
      return {
        table: safeTable,
        label: hierarchy[0].label,
        hierarchy: hierarchy.map((item) => item.name),
        fields: [],
        defaultFields: [],
      };
    }
    const fields = await discoverFields(hierarchy, get);
    const info = {
      table: safeTable,
      label: hierarchy[0].label,
      hierarchy: hierarchy.map((item) => item.name),
      fields,
      defaultFields: chooseDefaultFields(safeTable, hierarchy, fields),
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

  async function runSearch(parsed, options) {
    if (!parsed || !parsed.ok) throw createError("validation", "Invalid record search.");
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || (() => false);
    let tableInfo;
    if (parsed.isSysId) {
      try {
        tableInfo = await resolveTableInfo(parsed.table, {
          get, origin: opts.origin, shouldStop,
        });
      } catch (error) {
        if (shouldStop()) return { stale: true, results: [] };
        tableInfo = {
          table: parsed.table,
          label: parsed.table,
          hierarchy: [parsed.table],
          fields: [],
          defaultFields: [],
        };
      }
    } else {
      tableInfo = await resolveTableInfo(parsed.table, {
        get, origin: opts.origin, shouldStop,
      });
      if (shouldStop()) return { stale: true, results: [] };
    }
    if (shouldStop()) return { stale: true, results: [] };
    const selectedFields = tableInfo.fields.length
      ? selectVerifiedFields(tableInfo, opts.fields)
      : [];
    if (!parsed.isSysId && !selectedFields.length) {
      throw createError(
        "schema",
        "No verified text fields are selected. Choose at least one readable field."
      );
    }
    const fieldNames = selectedFields.map((field) => field.name);
    const query = parsed.isSysId
      ? "sys_id=" + parsed.anchor
      : buildSearchQuery(fieldNames, parsed.anchor);
    const rows = await getRows(get, {
      table: parsed.table,
      query,
      fields: ["sys_id"].concat(fieldNames).join(","),
      limit: parsed.isSysId ? 1 : SERVER_LIMIT,
      options: { displayAll: true, excludeRefLinks: true },
    });
    if (shouldStop()) return { stale: true, results: [] };
    const verified = rows
      .filter((row) => parsed.isSysId || verifyRow(row, selectedFields, parsed.term))
      .map((row) => normalizeResult(row, tableInfo, selectedFields))
      .filter(Boolean);
    const results = verified.slice(0, RESULT_LIMIT);
    return {
      stale: false,
      table: tableInfo.table,
      tableLabel: tableInfo.label,
      term: parsed.term,
      fields: selectedFields,
      availableFields: tableInfo.fields,
      results,
      truncated: rows.length >= SERVER_LIMIT || verified.length > RESULT_LIMIT,
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
    MAX_SEARCH_FIELDS,
    KNOWN_TABLE_PRESETS,
    GENERIC_FIELD_PRIORITY,
    SUMMARY_FIELD_PRIORITY: GENERIC_FIELD_PRIORITY,
    rawValue,
    displayValue,
    extractAnchor,
    extractTableLookupAnchor,
    parseSearch,
    buildSearchQuery,
    createSessionTracker,
    findTables,
    resolveHierarchy,
    discoverFields,
    chooseDefaultFields,
    resolveTableInfo,
    selectVerifiedFields,
    verifyRow,
    normalizeResult,
    runSearch,
    buildRecordUrl,
    buildResultListUrl,
    tableGet: defaultTransport,
  };
})();

/*
 * Record Search — safe query construction, schema discovery, and result
 * normalization for read-only Table API searches.
 *
 * Lazily injected with record_search_ui.js when the palette command is used.
 * This file has no DOM dependency so its safety boundaries can be tested under
 * Node.
 *
 * ServiceNow can silently drop an invalid field from an encoded query. Record
 * Search therefore discovers fields from sys_dictionary, sends only a
 * query-safe anchor, and verifies the user's complete term against the returned
 * summary values before rendering a row.
 */
(function () {
  if (globalThis.SNRecordSearch) return;

  const MIN_ANCHOR_LENGTH = 3;
  const RESULT_LIMIT = 20;
  const SERVER_LIMIT = 50;
  const MAX_HIERARCHY_DEPTH = 20;
  const MAX_SEARCH_FIELDS = 6;
  const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
  const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
  const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;
  const ANCHOR_SAFE_RUN = /[A-Za-z0-9_]+/g;

  /* These are candidate roles, not assumed columns. A field enters a query only
   * after sys_dictionary confirms it exists on the table hierarchy. Explicit
   * display fields are preferred ahead of these conventional summaries. */
  const SUMMARY_FIELD_PRIORITY = [
    "number",
    "name",
    "short_description",
    "title",
    "user_name",
    "email",
  ];

  const TEXT_TYPES = new Set([
    "string",
    "email",
    "url",
    "phone_number",
    "translated",
    "translated_field",
    "translated_text",
  ]);

  const tableInfoCache = new Map();

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

  function extractAnchor(term) {
    const text = String(term == null ? "" : term);
    let best = "";
    let match;
    ANCHOR_SAFE_RUN.lastIndex = 0;
    while ((match = ANCHOR_SAFE_RUN.exec(text)) !== null) {
      if (match[0].length > best.length) best = match[0];
    }
    return best.length >= MIN_ANCHOR_LENGTH ? best : null;
  }

  function parseSearch(tableInput, termInput) {
    const table = String(tableInput == null ? "" : tableInput).trim().toLowerCase();
    const term = String(termInput == null ? "" : termInput).trim();

    if (!table) return { ok: false, error: "Enter a table name." };
    if (!TABLE_NAME_PATTERN.test(table)) {
      return {
        ok: false,
        error: "Use a technical table name containing only letters, numbers, and underscores.",
      };
    }
    if (!term) return { ok: false, error: "Enter text or a sys_id to find." };

    const isSysId = SYS_ID_PATTERN.test(term);
    const anchor = isSysId ? term.toLowerCase() : extractAnchor(term);
    if (!anchor) {
      return {
        ok: false,
        error:
          "Enter at least " + MIN_ANCHOR_LENGTH +
          " consecutive letters, numbers, or underscores.",
      };
    }

    return { ok: true, table, term, isSysId, anchor };
  }

  function assertSafeField(field) {
    const value = String(field == null ? "" : field);
    if (!FIELD_NAME_PATTERN.test(value)) {
      throw new Error("Unsafe field name returned by table metadata.");
    }
    return value;
  }

  function assertSafeAnchor(anchor) {
    const value = String(anchor == null ? "" : anchor);
    if (!/^[A-Za-z0-9_]+$/.test(value) || value.length < MIN_ANCHOR_LENGTH) {
      throw new Error("Unsafe or too-short search anchor.");
    }
    return value;
  }

  function buildSearchQuery(fields, anchor) {
    const safeAnchor = assertSafeAnchor(anchor);
    const safeFields = Array.from(new Set((fields || []).map(assertSafeField)));
    if (!safeFields.length) throw new Error("No safe fields are available to search.");
    return safeFields
      .map((field, index) => (index ? "OR" : "") + field + "LIKE" + safeAnchor)
      .join("^");
  }

  function createSessionTracker() {
    let current = 0;
    return {
      next() {
        current += 1;
        return current;
      },
      cancel() {
        current += 1;
      },
      isCurrent(id) {
        return id === current;
      },
    };
  }

  async function defaultTransport(request) {
    if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      throw new Error("Record Search transport is unavailable.");
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
      const error = new Error(
        (response && response.error) || "Couldn't read " + request.table + "."
      );
      error.status = (response && response.status) || 0;
      throw error;
    }
    return response.result || [];
  }

  async function getRows(get, request) {
    const rows = await get(request);
    return Array.isArray(rows) ? rows : [];
  }

  async function readTableRow(table, get) {
    const rows = await getRows(get, {
      table: "sys_db_object",
      query: "name=" + table,
      fields: "name,label,super_class.name",
      limit: 1,
      options: { excludeRefLinks: true },
    });
    return rows[0] || null;
  }

  async function resolveHierarchy(table, get, shouldStop) {
    const hierarchy = [];
    const seen = new Set();
    let current = table;

    while (current && hierarchy.length < MAX_HIERARCHY_DEPTH && !seen.has(current)) {
      if (shouldStop && shouldStop()) return [];
      seen.add(current);
      const row = await readTableRow(current, get);
      if (!row) {
        if (!hierarchy.length) {
          throw new Error("Table not found or its metadata is not readable: " + table);
        }
        break;
      }
      const name = rawValue(row.name).toLowerCase();
      if (!TABLE_NAME_PATTERN.test(name)) {
        throw new Error("The table metadata returned an unsafe table name.");
      }
      hierarchy.push({
        name,
        label: displayValue(row.label) || name,
      });
      current = rawValue(row["super_class.name"]).toLowerCase();
    }

    return hierarchy;
  }

  function normalizeDictionaryField(row, hierarchyRank) {
    const name = rawValue(row.element);
    const type = rawValue(row.internal_type).toLowerCase();
    if (!FIELD_NAME_PATTERN.test(name) || !TEXT_TYPES.has(type)) return null;
    return {
      name,
      label: displayValue(row.column_label) || name,
      display: rawValue(row.display).toLowerCase() === "true",
      rank: hierarchyRank.get(rawValue(row.name).toLowerCase()) ?? 999,
    };
  }

  async function discoverFields(hierarchy, get) {
    const names = hierarchy.map((item) => item.name);
    const hierarchyRank = new Map(names.map((name, index) => [name, index]));
    const base = "nameIN" + names.join(",");
    const candidates = SUMMARY_FIELD_PRIORITY.join(",");

    const [displayRows, candidateRows] = await Promise.all([
      getRows(get, {
        table: "sys_dictionary",
        query: base + "^display=true^active=true",
        fields: "name,element,column_label,internal_type,display",
        limit: 100,
        options: { displayAll: true, excludeRefLinks: true },
      }),
      getRows(get, {
        table: "sys_dictionary",
        query: base + "^elementIN" + candidates + "^active=true",
        fields: "name,element,column_label,internal_type,display",
        limit: 100,
        options: { displayAll: true, excludeRefLinks: true },
      }),
    ]);

    const normalized = displayRows
      .concat(candidateRows)
      .map((row) => normalizeDictionaryField(row, hierarchyRank))
      .filter(Boolean);
    const byName = new Map();
    normalized.forEach((field) => {
      const previous = byName.get(field.name);
      if (!previous || field.display || field.rank < previous.rank) byName.set(field.name, field);
    });

    const priority = new Map(SUMMARY_FIELD_PRIORITY.map((name, index) => [name, index]));
    return Array.from(byName.values())
      .sort((a, b) => {
        if (a.display !== b.display) return a.display ? -1 : 1;
        if (a.rank !== b.rank) return a.rank - b.rank;
        return (priority.get(a.name) ?? 999) - (priority.get(b.name) ?? 999);
      })
      .slice(0, MAX_SEARCH_FIELDS);
  }

  async function resolveTableInfo(table, options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || null;
    const cacheKey = String(opts.origin || "") + "|" + table;
    if (!opts.noCache && tableInfoCache.has(cacheKey)) return tableInfoCache.get(cacheKey);

    const hierarchy = await resolveHierarchy(table, get, shouldStop);
    if (!hierarchy.length) throw new Error("Record search was cancelled.");
    if (shouldStop && shouldStop()) {
      return {
        table,
        label: hierarchy[0].label,
        hierarchy: hierarchy.map((item) => item.name),
        fields: [],
      };
    }
    const fields = await discoverFields(hierarchy, get);
    const info = {
      table,
      label: hierarchy[0].label,
      hierarchy: hierarchy.map((item) => item.name),
      fields,
    };
    if (!opts.noCache) tableInfoCache.set(cacheKey, info);
    return info;
  }

  function verifyRow(row, fields, term) {
    const needle = String(term).toLowerCase();
    return fields.some((field) =>
      displayValue(row[field.name]).toLowerCase().includes(needle)
    );
  }

  function normalizeResult(row, tableInfo) {
    const sysId = rawValue(row.sys_id);
    if (!SYS_ID_PATTERN.test(sysId)) return null;
    const values = tableInfo.fields
      .map((field) => ({
        field: field.name,
        label: field.label,
        value: displayValue(row[field.name]),
      }))
      .filter((item) => item.value);
    return {
      table: tableInfo.table,
      tableLabel: tableInfo.label,
      sysId,
      title: values.length ? values[0].value : sysId,
      values,
    };
  }

  async function runSearch(parsed, options) {
    if (!parsed || !parsed.ok) throw new Error("Invalid record search.");
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || (() => false);
    let tableInfo;

    if (parsed.isSysId) {
      try {
        tableInfo = await resolveTableInfo(parsed.table, {
          get,
          origin: opts.origin,
          shouldStop,
        });
      } catch (error) {
        if (shouldStop()) return { stale: true, results: [] };
        tableInfo = {
          table: parsed.table,
          label: parsed.table,
          hierarchy: [parsed.table],
          fields: [],
        };
      }
    } else {
      tableInfo = await resolveTableInfo(parsed.table, {
        get,
        origin: opts.origin,
        shouldStop,
      });
      if (shouldStop()) return { stale: true, results: [] };
      if (!tableInfo.fields.length) {
        throw new Error(
          "No readable text summary fields were found for " + parsed.table + "."
        );
      }
    }
    if (shouldStop()) return { stale: true, results: [] };

    const fieldNames = tableInfo.fields.map((field) => field.name);
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
      .filter((row) => parsed.isSysId || verifyRow(row, tableInfo.fields, parsed.term))
      .map((row) => normalizeResult(row, tableInfo))
      .filter(Boolean);
    const results = verified.slice(0, RESULT_LIMIT);

    return {
      stale: false,
      table: tableInfo.table,
      tableLabel: tableInfo.label,
      term: parsed.term,
      fields: tableInfo.fields,
      results,
      truncated: rows.length >= SERVER_LIMIT || verified.length > RESULT_LIMIT,
      candidateCount: rows.length,
    };
  }

  globalThis.SNRecordSearch = {
    MIN_ANCHOR_LENGTH,
    RESULT_LIMIT,
    SERVER_LIMIT,
    SUMMARY_FIELD_PRIORITY,
    rawValue,
    displayValue,
    extractAnchor,
    parseSearch,
    buildSearchQuery,
    createSessionTracker,
    resolveHierarchy,
    discoverFields,
    resolveTableInfo,
    verifyRow,
    normalizeResult,
    runSearch,
    tableGet: defaultTransport,
  };
})();

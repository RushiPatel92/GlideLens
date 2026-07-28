/*
 * Code Search — query model, anchor building, match verification, snippets.
 *
 * Isolated-world script, lazily injected on first use of the palette command
 * (it is deliberately absent from manifest.json's content_scripts: this file
 * plus code_search_ui.js are the largest in the extension, for a feature used
 * occasionally).
 *
 * This file holds the pure functions only — no DOM, no network. The registry,
 * probe and fetch pool land alongside them; keeping the logic side-effect free
 * is what lets tests/code_search.test.js run it under Node with no browser and
 * no dependencies.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 * An invalid field name in sysparm_query is SILENTLY DROPPED by the Table API,
 * which turns a filter into "return every record in the table". Measured on a
 * live instance 2026-07-27: sys_ui_action?sysparm_query=bogus_fieldLIKEzzzzz
 * returned rows, while a valid-but-unmatchable control correctly returned none.
 *
 * So the server query is only ever a COARSE PREFILTER. Every row it returns is
 * re-checked here against the user's actual term before anything is rendered.
 * A caller that skips verifyMatch() will happily paint an entire table as
 * "matches".
 *
 * The second half of the same rule: '^' separates conditions in an encoded
 * query, so a raw term can never be interpolated into one. Only a run of
 * characters that carry no meaning to the query parser (extractAnchor) is sent
 * to the server; the full literal is verified here.
 * ---------------------------------------------------------------------------
 */
(function () {
  if (globalThis.SNCodeSearch) return;

  /* Minimum anchor length. Shorter than this and the server-side LIKE scans
   * most of the table for nothing — the client-side verify would do all the
   * real work anyway. */
  const MIN_ANCHOR_LENGTH = 3;

  /* Characters safe to place in an encoded query value. Deliberately narrow:
   * '^' separates conditions, '=' and ',' and '!' '<' '>' '@' all carry
   * meaning to the parser, and whitespace round-trips unpredictably. A term
   * made only of metacharacters yields no anchor, and we refuse to run rather
   * than search the whole table. */
  const ANCHOR_SAFE_RUN = /[A-Za-z0-9_]+/g;

  /* Reuses content.js's rule so a hit named "api_key" is redacted here exactly
   * as it is in the Debug Timeline. */
  const SENSITIVE_NAME_PATTERN =
    /(password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|authorization)/i;

  const SNIPPET_MAX_LENGTH = 160;
  const SNIPPET_MAX_PER_FIELD = 3;

  /* =====================================================================
   * QUERY PARSING
   *
   * R1 syntax, and no more: plain substring, "quoted phrase", table:.
   * AND / -exclude / scope: / since: are sound but deferred; the shape below
   * (a filters object beside a term) is what lets them slot in later without
   * rewriting callers.
   * ===================================================================== */

  /* Regex is rejected rather than deferred, and the reason is soundness, not
   * scope. The server only returns rows containing the literal anchor. A
   * pattern like /foo|bar/ has no mandatory literal — alternation and optional
   * groups mean no substring is guaranteed to appear in a matching record — so
   * anchor-prefilter plus client verify would produce SILENT MISSES, the exact
   * failure this file is built to prevent. Regex can only return as a
   * full-body client-side scan inside a mandatory table: scope. */
  const REGEX_LIKE = /^\/.*\/[gimsuy]*$/;

  function parseQuery(raw) {
    const input = String(raw == null ? "" : raw).trim();
    const filters = { tables: [] };

    if (!input) {
      return { ok: false, error: "Type something to search for.", filters };
    }
    if (REGEX_LIKE.test(input)) {
      return {
        ok: false,
        error:
          "Regular expressions aren't supported — they would miss matches " +
          "silently. Use plain text or a \"quoted phrase\".",
        filters,
      };
    }

    /* Quoted runs are pulled out first so a phrase containing table: or a
     * space is taken literally rather than parsed as a filter. */
    const phrases = [];
    let rest = input.replace(/"([^"]*)"/g, (whole, inner) => {
      const text = inner.trim();
      if (text) phrases.push(text);
      return " ";
    });

    /* kind: used to narrow the registry through an internal taxonomy. It was
     * removed because a search for usage should be exhaustive by default, and
     * silently omitting most sources creates false confidence. Refuse it
     * explicitly so an old query cannot degrade into a literal that finds
     * nothing. Quoted "kind:..." remains ordinary text. */
    if (/(?:^|\s)kind:[^\s]+/i.test(rest)) {
      return {
        ok: false,
        error:
          "kind: filters aren't supported. Code Search searches every supported " +
          "source by default; use table:<name> only for a targeted retry.",
        filters,
      };
    }

    rest = rest.replace(/(?:^|\s)table:([^\s]+)/gi, (whole, value) => {
      const cleaned = value.trim().toLowerCase();
      if (cleaned && filters.tables.indexOf(cleaned) === -1) {
        filters.tables.push(cleaned);
      }
      return " ";
    });

    const bare = rest.trim().replace(/\s+/g, " ");

    /* One search term in R1. A phrase wins over loose words: if the user
     * quoted something they meant that exact run of characters. */
    const term = phrases.length ? phrases[0] : bare;
    const isPhrase = phrases.length > 0;

    if (!term) {
      if (filters.tables.length) {
        return {
          ok: false,
          error: "Add something to search for — filters alone match everything.",
          filters,
        };
      }
      return { ok: false, error: "Type something to search for.", filters };
    }

    const anchor = extractAnchor(term);
    if (!anchor) {
      return {
        ok: false,
        error:
          'No searchable run of ' + MIN_ANCHOR_LENGTH + '+ letters, digits or ' +
          'underscores in "' + term + '". Add more of the text you are looking for.',
        filters,
        term,
      };
    }

    return { ok: true, term, isPhrase, anchor, filters };
  }

  /* =====================================================================
   * ANCHOR EXTRACTION
   * ===================================================================== */

  /*
   * The longest run of query-safe characters in the term. That run is
   * guaranteed to appear in any record containing the term, so a LIKE on it is
   * a valid superset of the true result set — never a subset, which is what
   * makes verify-then-render sound.
   *
   * "new GlideRecord('incident')" -> "GlideRecord"
   * "a^b=c"                       -> null below the minimum, refused upstream
   */
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

  /*
   * Builds one encoded-query condition. The anchor is asserted safe rather
   * than escaped, because there is no escape for '^' in an encoded query —
   * the only safe move is never to interpolate anything that could contain it.
   * A caller passing an unsafe anchor is a bug, so this throws rather than
   * quietly producing a query that matches the wrong thing.
   */
  function buildAnchorCondition(field, anchor) {
    const safeField = String(field == null ? "" : field);
    const safeAnchor = String(anchor == null ? "" : anchor);
    if (!/^[A-Za-z0-9_]+$/.test(safeField)) {
      throw new Error("Unsafe field name for an encoded query: " + safeField);
    }
    if (!/^[A-Za-z0-9_]+$/.test(safeAnchor) || safeAnchor.length < MIN_ANCHOR_LENGTH) {
      throw new Error("Unsafe or too-short anchor for an encoded query.");
    }
    return safeField + "LIKE" + safeAnchor;
  }

  /*
   * One record must match the anchor in ANY of the adapter's fields, so the
   * conditions are OR-joined ("^OR"). Field order is preserved for readability
   * when debugging a query in the network tab.
   */
  function buildFieldQuery(fields, anchor) {
    const list = (Array.isArray(fields) ? fields : []).filter(Boolean);
    if (!list.length) throw new Error("No fields to query.");
    return list
      .map((field, index) =>
        (index === 0 ? "" : "OR") + buildAnchorCondition(field, anchor)
      )
      .join("^");
  }

  /* =====================================================================
   * VERIFICATION
   * ===================================================================== */

  /*
   * The gate every row passes before it can be rendered. Case-insensitive
   * substring for both plain terms and phrases — quoting means "treat this
   * whole run of characters as one literal, including its spaces and colons",
   * not "match case".
   */
  function verifyMatch(text, term) {
    if (text == null || term == null) return false;
    const haystack = String(text);
    const needle = String(term);
    if (!needle) return false;
    return haystack.toLowerCase().indexOf(needle.toLowerCase()) !== -1;
  }

  function findMatchOffsets(text, term, limit) {
    const haystack = String(text == null ? "" : text).toLowerCase();
    const needle = String(term == null ? "" : term).toLowerCase();
    const offsets = [];
    if (!needle) return offsets;
    const max = limit || SNIPPET_MAX_PER_FIELD;
    let from = 0;
    while (offsets.length < max) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      offsets.push(at);
      from = at + needle.length;
    }
    return offsets;
  }

  /* =====================================================================
   * SNIPPETS
   *
   * Returns plain data — text plus match offsets within that text. The UI
   * renders it with textContent and positions a highlight from the offsets;
   * nothing here produces markup, because instance source code is the last
   * thing that should reach innerHTML.
   * ===================================================================== */

  function buildSnippets(text, term, options) {
    const body = String(text == null ? "" : text);
    const opts = options || {};
    const maxLength = opts.maxLength || SNIPPET_MAX_LENGTH;
    const limit = opts.limit || SNIPPET_MAX_PER_FIELD;
    const needleLength = String(term == null ? "" : term).length;

    return findMatchOffsets(body, term, limit).map((offset) => {
      /* Snippet boundaries are the enclosing line: a ref qual or condition is
       * usually one line anyway, and for a script the line is the unit a
       * developer recognises. */
      let start = body.lastIndexOf("\n", offset) + 1;
      let end = body.indexOf("\n", offset + needleLength);
      if (end === -1) end = body.length;

      const line = countLines(body, start);
      let snippet = body.slice(start, end);
      let matchStart = offset - start;

      /* A minified or very long line gets windowed around the match rather
       * than truncated from the left, so the match is always visible. */
      if (snippet.length > maxLength) {
        const before = Math.floor((maxLength - needleLength) / 2);
        let windowStart = Math.max(0, matchStart - Math.max(0, before));
        const windowEnd = Math.min(snippet.length, windowStart + maxLength);
        windowStart = Math.max(0, windowEnd - maxLength);
        const prefix = windowStart > 0 ? "…" : "";
        const suffix = windowEnd < snippet.length ? "…" : "";
        matchStart = matchStart - windowStart + prefix.length;
        snippet = prefix + snippet.slice(windowStart, windowEnd) + suffix;
      }

      const trimmed = snippet.replace(/^\s+/, "");
      matchStart -= snippet.length - trimmed.length;

      return {
        line,
        text: trimmed.replace(/\s+$/, ""),
        matchStart: Math.max(0, matchStart),
        matchEnd: Math.max(0, matchStart) + needleLength,
      };
    });
  }

  function countLines(body, upTo) {
    let count = 1;
    for (let i = 0; i < upTo; i++) {
      if (body.charCodeAt(i) === 10) count++;
    }
    return count;
  }

  /* =====================================================================
   * RESULTS: identity, redaction, staleness
   * ===================================================================== */

  /* The canonical identity of a hit. One record matching in two fields is two
   * rows; the same record arriving twice from overlapping sources is one. */
  function dedupeKey(table, sysId, field) {
    return String(table || "") + "|" + String(sysId || "") + "|" + String(field || "");
  }

  function dedupeHits(hits) {
    const seen = Object.create(null);
    const out = [];
    (Array.isArray(hits) ? hits : []).forEach((hit) => {
      if (!hit) return;
      const key = dedupeKey(hit.table, hit.sysId, hit.field);
      if (seen[key]) return;
      seen[key] = true;
      out.push(hit);
    });
    return out;
  }

  function isSensitiveName(name, label) {
    return (
      SENSITIVE_NAME_PATTERN.test(String(name || "")) ||
      SENSITIVE_NAME_PATTERN.test(String(label || ""))
    );
  }

  /*
   * Default-deny redaction. A hit whose name cannot be established is treated
   * as sensitive rather than assumed safe — the identity of a record we could
   * not name is exactly the case where we cannot know what it holds.
   */
  function redactHit(hit) {
    if (!hit) return hit;
    const named = hit.name != null && String(hit.name).trim() !== "";
    if (!named || isSensitiveName(hit.name, hit.label)) {
      return Object.assign({}, hit, {
        redacted: true,
        snippets: (hit.snippets || []).map((snippet) => ({
          line: snippet.line,
          text: "•••",
          matchStart: 0,
          matchEnd: 0,
        })),
      });
    }
    return hit;
  }

  /*
   * Two overlapping searches must never interleave: the user types, waits,
   * retypes, and the slower first search must not paint over the second.
   * Every result carries the id it was issued under and is dropped unless it
   * is still the current one.
   */
  function createSessionTracker() {
    let current = 0;
    return {
      next: function () {
        current += 1;
        return current;
      },
      isCurrent: function (id) {
        return id === current && id !== 0;
      },
      cancel: function () {
        current += 1;
      },
    };
  }

  /* =====================================================================
   * REGISTRY
   *
   * Every table.field below was verified against a live instance on
   * 2026-07-27 — a wrong column name does not error, it returns zero rows
   * forever, so nothing here is guessed.
   *
   * `kind` is internal classification metadata, not public query syntax.
   * Searches cover every tier-1 source unless the user explicitly names a
   * concrete ServiceNow table for a targeted retry. `tier` 1 is default-on;
   * tier 2 is opt-in (slow, noisy, or commonly restricted).
   * ===================================================================== */

  const SEARCH_TARGETS = [
    /* --- The gap pack: configuration source no code index reaches -------- */
    {
      id: "dictionary",
      kind: "dictionary",
      label: "Dictionary",
      table: "sys_dictionary",
      fields: ["reference_qual", "default_value", "calculation", "attributes"],
      title: ["name", "element"],
      tier: 1,
    },
    {
      id: "dictionary-override",
      kind: "dictionary",
      label: "Dictionary override",
      table: "sys_dictionary_override",
      fields: ["reference_qual", "default_value", "calculation", "attributes"],
      title: ["name", "element"],
      tier: 1,
    },
    {
      /* Catalog variable ref quals — the single best reason this feature
       * exists, and absent from every Code Search Group seen so far.
       *
       * reference_qual and default_value are defined on the PARENT table
       * `question`, not here. They are queryable on item_option_new all the
       * same (verified), but a probe that does not walk super_class will
       * report them missing and silently disable this source. `macro` is
       * deliberately absent: it is a reference to sys_ui_macro, so searching
       * it would match a sys_id rather than any code. */
      id: "catalog-variable",
      kind: "catalog",
      label: "Catalog variable",
      table: "item_option_new",
      fields: [
        "reference_qual",
        "default_value",
        "post_insert_script",
        "read_script",
        "save_script",
      ],
      title: ["name"],
      subtitle: ["question_text"],
      tier: 1,
    },
    {
      id: "transform-map",
      kind: "transform",
      label: "Transform map",
      table: "sys_transform_map",
      fields: ["script"],
      title: ["name"],
      tier: 1,
    },
    {
      id: "transform-entry",
      kind: "transform",
      label: "Field map script",
      table: "sys_transform_entry",
      fields: ["source_script"],
      title: ["target_field"],
      subtitle: ["map"],
      tier: 1,
    },
    {
      /* The stage column is `when` (onBefore/onAfter/onStart/onComplete), not
       * `type` — verified, because a wrong display column renders blank rather
       * than failing. */
      id: "transform-script",
      kind: "transform",
      label: "Transform script",
      table: "sys_transform_script",
      fields: ["script"],
      title: ["when"],
      subtitle: ["map"],
      tier: 1,
    },
    {
      id: "record-producer",
      kind: "catalog",
      label: "Record producer",
      table: "sc_cat_item_producer",
      fields: ["script"],
      title: ["name"],
      tier: 1,
    },
    {
      /* Groups configure sys_ui_action as name,script — never `condition`,
       * so the one-liner conditions stay invisible to instance code search
       * even on an instance whose group covers this table. */
      id: "ui-action",
      kind: "ui-action",
      label: "UI action",
      table: "sys_ui_action",
      fields: ["condition", "script"],
      title: ["name"],
      subtitle: ["table"],
      tier: 1,
    },

    /* --- Everyday scripts ------------------------------------------------
     * Reachable by instance code search where the plugin is present and the
     * session has the role. Kept as adapters because that is neither
     * guaranteed nor uniform, and because the coverage a group provides is
     * per-field: R2 derives a table.field coverage map and skips whatever is
     * already covered rather than dropping these outright. */
    {
      id: "script-include",
      kind: "script",
      label: "Script include",
      table: "sys_script_include",
      fields: ["script"],
      title: ["name"],
      subtitle: ["api_name"],
      tier: 1,
    },
    {
      id: "business-rule",
      kind: "script",
      label: "Business rule",
      table: "sys_script",
      fields: ["script", "condition"],
      title: ["name"],
      subtitle: ["collection"],
      tier: 1,
    },
    {
      id: "client-script",
      kind: "script",
      label: "Client script",
      table: "sys_script_client",
      fields: ["script", "condition"],
      title: ["name"],
      subtitle: ["table"],
      tier: 1,
    },
    {
      /* Extends sys_script_client, so `script` lives on the parent — the
       * same super_class walk the catalog variables need. */
      id: "catalog-client-script",
      kind: "catalog",
      label: "Catalog client script",
      table: "catalog_script_client",
      fields: ["script", "condition"],
      title: ["name"],
      subtitle: ["cat_item"],
      tier: 1,
    },
    {
      id: "script-action",
      kind: "script",
      label: "Script action",
      table: "sysevent_script_action",
      fields: ["script"],
      title: ["name"],
      subtitle: ["event_name"],
      tier: 1,
    },
    {
      id: "scripted-rest",
      kind: "script",
      label: "Scripted REST operation",
      table: "sys_ws_operation",
      fields: ["operation_script"],
      title: ["name"],
      subtitle: ["relative_path"],
      tier: 1,
    },
  ];

  function targetById(id) {
    return SEARCH_TARGETS.filter((target) => target.id === id)[0] || null;
  }

  /* =====================================================================
   * TRANSPORT
   *
   * Everything goes through the service worker, which runs the request in
   * the MAIN world where g_ck is readable. A direct fetch from this isolated
   * world carries the session cookie but NOT the CSRF token, and an instance
   * that enforces the token on REST GETs answers 401 to every call — silently,
   * because callers treat a throw as "no data". That bug shipped once already
   * in this extension (see snGet in content.js); it is not repeating here.
   * ===================================================================== */

  const REQUEST_TIMEOUT_MS = 20000;
  const MAX_CONCURRENCY = 4;
  const PER_SOURCE_LIMIT = 50;

  function defaultTransport(request) {
    /* The service worker cannot be aborted mid-flight, so the timeout races
     * the response rather than cancelling it. A late reply is discarded by the
     * session check upstream. */
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(
        () => finish({ ok: false, status: 0, timedOut: true, error: "Timed out" }),
        request.timeoutMs || REQUEST_TIMEOUT_MS
      );
      chrome.runtime
        .sendMessage({
          type: "SN_CODE_SEARCH_GET",
          table: request.table,
          query: request.query,
          fields: request.fields,
          limit: request.limit || PER_SOURCE_LIMIT,
        })
        .then((response) => {
          clearTimeout(timer);
          finish(response || { ok: false, status: 0, error: "No response" });
        })
        .catch((error) => {
          clearTimeout(timer);
          finish({ ok: false, status: 0, error: String(error) });
        });
    });
  }

  /*
   * Bounded worker pool. Sources resolve as they finish so the panel can paint
   * fast ones first, and `shouldStop` is checked between tasks so Cancel drains
   * the queue instead of waiting for every request to land.
   */
  async function runPool(tasks, options) {
    const opts = options || {};
    const limit = Math.max(1, opts.concurrency || MAX_CONCURRENCY);
    const queue = (Array.isArray(tasks) ? tasks : []).slice();
    const results = [];
    let index = 0;

    async function worker() {
      while (queue.length) {
        if (opts.shouldStop && opts.shouldStop()) return;
        const task = queue.shift();
        const position = index++;
        let outcome;
        try {
          outcome = await task();
        } catch (error) {
          outcome = { ok: false, status: 0, error: String(error) };
        }
        if (opts.shouldStop && opts.shouldStop()) return;
        results[position] = outcome;
        if (opts.onResult) opts.onResult(outcome);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(limit, queue.length); i++) workers.push(worker());
    await Promise.all(workers);
    return results.filter((item) => item !== undefined);
  }

  /* =====================================================================
   * PROBE
   *
   * Validates every table.field in the registry before the first search on an
   * origin, so a field this instance does not have is reported in the footer
   * rather than silently searched.
   *
   * It walks super_class, and that is not an optimisation. sys_dictionary
   * stores a field against the table that DEFINES it, so probing
   * item_option_new for reference_qual finds nothing — the column belongs to
   * `question` — while the Table API answers queries for it on the child
   * perfectly well. A probe without the walk would drop catalog variable
   * reference qualifiers, the single source this feature most exists to reach.
   * ===================================================================== */

  const PROBE_CACHE_VERSION = 1;
  const PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_ANCESTRY_HOPS = 10;

  function probeCacheKey(origin) {
    return "snhCodeSearchProbe:" + origin;
  }

  function uniqueStrings(values) {
    const seen = Object.create(null);
    const out = [];
    (values || []).forEach((value) => {
      const text = String(value || "");
      if (!text || seen[text]) return;
      seen[text] = true;
      out.push(text);
    });
    return out;
  }

  /*
   * table name -> [table, parent, grandparent, …]. Two reads per hop at most:
   * one to fetch the super_class references, one to turn those sys_ids into
   * names. Bounded by MAX_ANCESTRY_HOPS so a cyclic hierarchy cannot hang the
   * probe.
   */
  async function resolveAncestry(tables, transport) {
    const tableGet = transport || defaultTransport;
    const chains = Object.create(null);
    const parentOf = Object.create(null);
    const nameById = Object.create(null);

    let frontier = uniqueStrings(tables);
    const wanted = frontier.slice();

    for (let hop = 0; hop < MAX_ANCESTRY_HOPS && frontier.length; hop++) {
      const response = await tableGet({
        table: "sys_db_object",
        query: "nameIN" + frontier.join(","),
        fields: "name,super_class",
        limit: 200,
      });
      if (!response.ok) break;

      const parentIds = [];
      (response.result || []).forEach((row) => {
        const name = rowValue(row, "name");
        const parentId = rowValue(row, "super_class");
        nameById[rowValue(row, "sys_id")] = name;
        if (!name || !parentId) return;
        parentOf[name] = parentId;
        parentIds.push(parentId);
      });
      if (!parentIds.length) break;

      const parents = await tableGet({
        table: "sys_db_object",
        query: "sys_idIN" + uniqueStrings(parentIds).join(","),
        fields: "sys_id,name",
        limit: 200,
      });
      if (!parents.ok) break;

      const next = [];
      (parents.result || []).forEach((row) => {
        const id = rowValue(row, "sys_id");
        const name = rowValue(row, "name");
        if (!id || !name) return;
        if (!nameById[id]) next.push(name);
        nameById[id] = name;
      });
      frontier = uniqueStrings(next);
    }

    wanted.forEach((table) => {
      const chain = [table];
      let cursor = table;
      for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
        const parentId = parentOf[cursor];
        const parentName = parentId ? nameById[parentId] : null;
        if (!parentName || chain.indexOf(parentName) !== -1) break;
        chain.push(parentName);
        cursor = parentName;
      }
      chains[table] = chain;
    });

    return chains;
  }

  function rowValue(row, field) {
    const raw = row && row[field];
    if (raw == null) return "";
    if (typeof raw === "object" && !Array.isArray(raw)) {
      return raw.value != null ? String(raw.value) : "";
    }
    return String(raw);
  }

  async function probe(options) {
    const opts = options || {};
    const tableGet = opts.transport || defaultTransport;
    const targets = opts.targets || SEARCH_TARGETS;
    const tables = uniqueStrings(targets.map((target) => target.table));
    const fields = uniqueStrings(
      targets.reduce((all, target) => all.concat(target.fields), [])
    );

    const chains = await resolveAncestry(tables, tableGet);
    const searchNames = uniqueStrings(
      tables.reduce((all, table) => all.concat(chains[table] || [table]), [])
    );

    const response = await tableGet({
      table: "sys_dictionary",
      query:
        "nameIN" + searchNames.join(",") + "^elementIN" + fields.join(","),
      fields: "name,element",
      limit: 2000,
    });

    /* A probe that could not run is UNKNOWN, not absent: refusing to search a
     * source because one request failed would be the same silent-hole failure
     * the whole design is built to avoid. Assume present and let the search
     * report what actually happens. */
    if (!response.ok) {
      return {
        ok: false,
        error: response.error || "Probe failed",
        checkedAt: Date.now(),
        targets: targets.reduce((map, target) => {
          map[target.id] = { fields: target.fields.slice(), unverified: true };
          return map;
        }, Object.create(null)),
      };
    }

    const defined = Object.create(null);
    (response.result || []).forEach((row) => {
      defined[rowValue(row, "name") + "." + rowValue(row, "element")] = true;
    });

    const result = Object.create(null);
    targets.forEach((target) => {
      const chain = chains[target.table] || [target.table];
      const present = target.fields.filter((field) =>
        chain.some((table) => defined[table + "." + field])
      );
      result[target.id] = {
        fields: present,
        missing: target.fields.filter((field) => present.indexOf(field) === -1),
      };
    });

    return { ok: true, checkedAt: Date.now(), targets: result };
  }

  async function loadProbe(origin, options) {
    const opts = options || {};
    const key = probeCacheKey(origin);
    if (!opts.force) {
      try {
        const cached = await chrome.storage.local.get(key);
        const entry = cached && cached[key];
        if (
          entry &&
          entry.version === PROBE_CACHE_VERSION &&
          Date.now() - entry.checkedAt < PROBE_TTL_MS
        ) {
          return entry;
        }
      } catch (e) {}
    }
    const fresh = await probe(opts);
    /* An unverified probe is not cached — a transient failure should not
     * freeze "we do not know" in place for seven days. */
    if (fresh.ok) {
      try {
        await chrome.storage.local.set({
          [key]: Object.assign({ version: PROBE_CACHE_VERSION }, fresh),
        });
      } catch (e) {}
    }
    return fresh;
  }

  /* =====================================================================
   * SEARCH
   *
   * Per-source status is a first-class result, not an error path. One denied
   * or absent table must never discard the rest, and — the harder half — a
   * source that returned nothing must be distinguishable from a source that
   * was never allowed to look. "No matches" and "you cannot read this table"
   * look identical from the outside, and conflating them is how a search tool
   * teaches people to trust an answer that was never given.
   * ===================================================================== */

  const GLOBAL_HIT_CAP = 500;

  const SOURCE_STATUS = {
    COMPLETE: "complete",
    NO_MATCHES: "no-matches",
    DENIED: "denied",
    ABSENT: "absent",
    TIMED_OUT: "timed-out",
    CAPPED: "capped",
    SKIPPED: "skipped",
    ERROR: "error",
  };

  function selectTargets(parsed, probeResult, targets) {
    const all = targets || SEARCH_TARGETS;
    const wantTables = (parsed.filters && parsed.filters.tables) || [];
    const probed = (probeResult && probeResult.targets) || Object.create(null);

    return all
      .filter((target) => (target.tier || 1) === 1)
      .filter((target) => !wantTables.length || wantTables.indexOf(target.table) !== -1)
      .map((target) => {
        const entry = probed[target.id];
        /* No probe entry means the probe never ran — search everything the
         * registry declares rather than nothing. */
        const fields = entry ? entry.fields : target.fields;
        return Object.assign({}, target, {
          fields: fields || [],
          missingFields: (entry && entry.missing) || [],
          unverified: Boolean(entry && entry.unverified),
        });
      })
      .filter((target) => target.fields.length > 0);
  }

  /* The columns to ask for: what we search, plus what we display. sys_id is
   * always needed — without it a hit cannot be opened. */
  function requestFields(target) {
    return uniqueStrings(
      ["sys_id"]
        .concat(target.fields)
        .concat(target.title || [])
        .concat(target.subtitle || [])
    ).join(",");
  }

  function displayValue(row, fields) {
    return (fields || [])
      .map((field) => rowValue(row, field))
      .filter((value) => value !== "")
      .join(" · ");
  }

  /*
   * Turns one source's rows into verified hits. This is where rule 1 is
   * actually enforced: a row is only a hit if the field text really contains
   * the term the user typed, not merely the anchor sent to the server.
   */
  function hitsFromRows(rows, target, parsed) {
    const hits = [];
    (rows || []).forEach((row) => {
      target.fields.forEach((field) => {
        const text = rowValue(row, field);
        if (!text || !verifyMatch(text, parsed.term)) return;
        hits.push(
          redactHit({
            sourceId: target.id,
            kind: target.kind,
            sourceLabel: target.label,
            table: target.table,
            sysId: rowValue(row, "sys_id"),
            field,
            name: displayValue(row, target.title) || rowValue(row, "sys_id"),
            subtitle: displayValue(row, target.subtitle),
            snippets: buildSnippets(text, parsed.term),
          })
        );
      });
    });
    return hits;
  }

  function classify(response, verifiedCount, rowCount, limit) {
    if (response.timedOut) return SOURCE_STATUS.TIMED_OUT;
    if (!response.ok) {
      if (response.status === 403 || response.status === 401) return SOURCE_STATUS.DENIED;
      if (response.status === 404) return SOURCE_STATUS.ABSENT;
      return SOURCE_STATUS.ERROR;
    }
    if (rowCount >= limit) return SOURCE_STATUS.CAPPED;
    if (!verifiedCount) return SOURCE_STATUS.NO_MATCHES;
    return SOURCE_STATUS.COMPLETE;
  }

  async function runSearch(parsed, options) {
    const opts = options || {};
    const transport = opts.transport || defaultTransport;
    const limit = opts.limit || PER_SOURCE_LIMIT;
    const targets = selectTargets(parsed, opts.probe, opts.targets);
    const sources = [];
    let hits = [];
    let truncated = false;

    const tasks = targets.map((target) => async () => {
      const response = await transport({
        table: target.table,
        query: buildFieldQuery(target.fields, parsed.anchor),
        fields: requestFields(target),
        limit,
      });
      const rows = (response.ok && response.result) || [];
      const verified = hitsFromRows(rows, target, parsed);
      const summary = {
        id: target.id,
        label: target.label,
        table: target.table,
        kind: target.kind,
        status: classify(response, verified.length, rows.length, limit),
        count: verified.length,
        missingFields: target.missingFields,
        unverified: target.unverified,
        error: response.ok ? "" : response.error || "",
      };
      sources.push(summary);
      if (verified.length) {
        hits = hits.concat(verified);
        if (hits.length > GLOBAL_HIT_CAP) {
          hits = hits.slice(0, GLOBAL_HIT_CAP);
          truncated = true;
        }
      }
      /* Streamed so the panel can paint a fast source before a slow one
       * finishes; the caller drops anything from a stale session. */
      if (opts.onSource) opts.onSource(summary, verified);
      return summary;
    });

    await runPool(tasks, {
      concurrency: opts.concurrency,
      shouldStop: opts.shouldStop,
    });

    return { hits: dedupeHits(hits), sources, truncated, term: parsed.term };
  }

  globalThis.SNCodeSearch = {
    MIN_ANCHOR_LENGTH,
    SOURCE_STATUS,
    GLOBAL_HIT_CAP,
    PER_SOURCE_LIMIT,
    SEARCH_TARGETS,
    targetById,
    parseQuery,
    extractAnchor,
    buildAnchorCondition,
    buildFieldQuery,
    verifyMatch,
    findMatchOffsets,
    buildSnippets,
    dedupeKey,
    dedupeHits,
    isSensitiveName,
    redactHit,
    createSessionTracker,
    tableGet: defaultTransport,
    runPool,
    resolveAncestry,
    probe,
    loadProbe,
    selectTargets,
    hitsFromRows,
    runSearch,
  };
})();

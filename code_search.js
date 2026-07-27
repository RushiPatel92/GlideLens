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
   * R1 syntax, and no more: plain substring, "quoted phrase", table:, kind:.
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
    const filters = { tables: [], kinds: [] };

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

    rest = rest.replace(/(?:^|\s)(table|kind):([^\s]+)/gi, (whole, key, value) => {
      const bucket = key.toLowerCase() === "table" ? filters.tables : filters.kinds;
      const cleaned = value.trim().toLowerCase();
      if (cleaned && bucket.indexOf(cleaned) === -1) bucket.push(cleaned);
      return " ";
    });

    const bare = rest.trim().replace(/\s+/g, " ");

    /* One search term in R1. A phrase wins over loose words: if the user
     * quoted something they meant that exact run of characters. */
    const term = phrases.length ? phrases[0] : bare;
    const isPhrase = phrases.length > 0;

    if (!term) {
      if (filters.tables.length || filters.kinds.length) {
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

  globalThis.SNCodeSearch = {
    MIN_ANCHOR_LENGTH,
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
  };
})();

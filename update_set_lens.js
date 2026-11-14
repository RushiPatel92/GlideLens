/*
 * Update Set Lens engine. Isolated world and DOM-free, injected together with
 * its panel by INJECT_UPDATE_SET_LENS the first time the command runs.
 *
 * For one update set it answers whether each customer update in it is still
 * the version this instance runs, and if not, where the newer one is. It reads
 * sys_update_set, sys_update_xml, sys_update_version and sys_remote_update_set
 * through SN_UPDATE_SET_LENS_GET, and it writes nothing. Open record looks
 * one record up in sys_metadata when it is clicked, and no sooner.
 *
 * Rules that took measurement to find, with the reason each one exists:
 *
 *   - A version belongs to the set named in `source`, with
 *     source_table=sys_update_set. The version table has no update set column,
 *     and a misspelt condition is silently ignored, so every row that comes
 *     back is checked again in code.
 *   - A later save that changes nothing writes no new version. "The current
 *     version is in another set" is therefore Stale only when the content
 *     differs too, which is what payload_hash tells.
 *   - Versions are read by name (and set), never looked up by their id or
 *     their content fingerprint: one lookup by id took 11.8 s against 0.19 s
 *     by name.
 *   - A set committed from another instance can hold its updates in two
 *     places: attached to the local set, or still under the retrieved set. Its
 *     membership is the union of both.
 *   - Stale is claimed only when this set's own version was loaded here and
 *     later replaced (the applied-here guard, rule 6). An update skipped at
 *     commit never became a version here; calling an older version "newer"
 *     would reverse the order.
 *
 * Every verdict a blank, a refusal or a failed read touches is Can't tell. A
 * denial must never read as a clean result.
 */
(() => {
  if (globalThis.SNUpdateSetLens) return;

  const SYS_ID = /^[0-9a-f]{32}$/;
  /* The other instance's request patterns (§6.4). payload_hash is a SIGNED
   * DECIMAL (a 32-bit hash; about half are negative), never hex. */
  const REMOTE_NAME = /^[A-Za-z0-9_.-]{1,250}$/;
  const REMOTE_GUID = /^[0-9a-f]{32}$/;
  const REMOTE_HASH = /^-?[0-9]{1,10}$/;
  /* A table name that may become a form URL's path. */
  const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/;
  /* The usual update name: the record's table, then its sys_id. */
  const NAMED_RECORD = /^([a-z][a-z0-9_]*)_([0-9a-f]{32})$/;

  const LIMITS = Object.freeze({
    rowCap: 2000,
    memberPage: 200,
    namesPerRead: 40,
    urlCap: 6000,
    setsPerRead: 80,
    appliedLimit: 1000,
    chooser: 20,
    batchDepth: 6,
    batchSets: 1000,
    concurrency: 2,
    remoteRecords: 2000,
    remoteSets: 1000,
    /* Placing what runs there: update_guid_history reaches about 22 KB a
     * row, so few rows to a read, and every version of a name is read. */
    lineageRowsPerRead: 20,
    lineageNamesPerRead: 10,
    lineageVersionsPerName: 250,
  });
  /* An update's own history: "guid:hash", newest first, across sets. */
  const LINEAGE_ENTRY = /^([0-9a-f]{32}):(-?[0-9]{1,10})$/;
  const LINEAGE_XML_FIELDS = "sys_id,update_guid,update_guid_history";
  const LINEAGE_VERSION_FIELDS = "name,state,source,source_table,update_guid,payload_hash,sys_recorded_at";
  /* The states that mean a version ran here. */
  const LOADED_STATES = new Set(["previous", "current"]);

  /* completed_on is for Version Lens, which shows when a set was completed;
   * this panel ignores it. */
  const SET_FIELDS = [
    "sys_id", "name", "state", "is_default", "application", "parent", "base_update_set",
    "merged_to", "remote_sys_id", "origin_sys_id", "sys_created_by", "sys_created_on",
    "sys_updated_on", "completed_on",
  ].join(",");
  const MEMBER_FIELDS = [
    "sys_id", "name", "update_set", "remote_update_set", "action", "type", "target_name",
    "update_guid", "payload_hash",
  ].join(",");
  const VERSION_FIELDS = [
    "name", "state", "source", "source_table", "update_guid", "payload_hash", "action",
    "reverted_from", "sys_created_by", "sys_created_on",
  ].join(",");
  /* Rule 6's read. sys_created_on is here for rule 6b, which compares it with
   * the current version's, both raw UTC values from this instance. */
  const APPLIED_FIELDS = [
    "name", "source", "source_table", "state", "update_guid", "payload_hash", "sys_created_on",
  ].join(",");
  const RETRIEVED_FIELDS = [
    "sys_id", "name", "state", "remote_sys_id", "origin_sys_id", "update_set", "update_source",
    "commit_date", "collisions", "parent", "remote_base_update_set", "sys_created_on",
  ].join(",");

  const VERDICT_ORDER = { stale: 0, cant: 1, batch: 2, same: 3, current: 4 };

  const NOT_COMMITTED_STATES = new Set([
    "loaded", "in_hierarchy", "previewing", "previewed", "previewed_in_hierarchy",
  ]);
  const PREVIEWED_STATES = new Set(["previewed", "previewed_in_hierarchy"]);
  const BACKED_OUT_STATES = new Set(["backedout", "backedout_in_hierarchy"]);
  const NOT_APPLIED_NOTE = "Its updates aren't applied here, so there's nothing to call stale.";
  /* The tables whose page may be an update set's form. Any other concrete
   * table is some other record and costs no read. nav_to is here because
   * recordContextFromText returns it for a top-frame nav_to.do URL. */
  const PAGE_TABLES_TO_READ = new Set(["sys_update_set", "sys_remote_update_set", "nav_to"]);

  const CANT_TELL = {
    unqueryable: "Its name can't be looked up safely",
    "versions-failed": "Couldn't read versions",
    "versions-refused": "Couldn't read versions: this account can't read version history here",
    "no-version": "No readable version history",
    "several-current": "More than one current version",
    incomplete: "Incomplete version data",
    "same-id-different-content":
      "This update and its version record disagree (same id, different content). Use Compare to Current on the update.",
    "later-version-here": "This set holds a later version than its update row",
    "not-applied":
      "No version from this set is recorded here: skipped at commit, or added to the set without a save",
    "backed-out-here": "This set's version was backed out here",
    "never-loaded": "This set's version was never loaded here",
    "not-recorded-loaded": "This set's version here isn't recorded as loaded",
    "own-versions-differ": "This set's versions here don't match this update",
    "runs-older": "The version that runs here is older than this set's version",
    "too-many-versions": "Too many versions to check",
  };

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  const str = (value) => (value == null ? "" : String(value));

  function raw(row, field) {
    const value = row && row[field];
    if (value == null) return "";
    if (typeof value === "object") return value.value == null ? "" : String(value.value);
    return String(value);
  }

  function shown(row, field) {
    const value = row && row[field];
    if (value == null) return "";
    if (typeof value === "object") {
      if (value.display_value != null && value.display_value !== "") return String(value.display_value);
      return value.value == null ? "" : String(value.value);
    }
    return String(value);
  }

  function isSysId(value) {
    return SYS_ID.test(str(value));
  }

  /* ServiceNow's name match ignores case and trailing spaces (G3, on three
   * instances), so the code-side check folds both: otherwise it would drop a
   * match the server returned. */
  function foldName(value) {
    return str(value).trim().toLowerCase();
  }

  function decodedVariants(text) {
    const values = [];
    let value = str(text);
    for (let i = 0; i < 3 && value; i++) {
      values.push(value);
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch (error) {
        break;
      }
    }
    return values;
  }

  /* A list never opens on a set. `sysIdFromText` matches `sys_id=` inside
   * `remote_sys_id=` and `origin_sys_id=`, so a list filtered by either would
   * otherwise open silently on that set (G6). The raw route decides: the
   * shared URL parser strips `_list`, so its table cannot tell a list from a
   * form. A nav_to `uri=` names the route after `=`, with or without a slash. */
  function isListRoute(text) {
    return decodedVariants(text).some((value) =>
      /(?:^|[/=])[a-z][a-z0-9_]*_list\.do(?:[?#&]|$)/i.test(value));
  }

  function lensError(code, message, status) {
    const error = new Error(message);
    error.code = code;
    if (status) error.status = status;
    return error;
  }

  function errorMessage(error) {
    return str(error && error.message ? error.message : error);
  }

  /* Names that may enter a query: no caret (it splits an encoded query), no
   * line break, and never a `javascript:` value, which ServiceNow evaluates
   * even when it is encoded. A comma splits an IN list, so such a name is
   * read on its own. */
  function nameQueryKind(name) {
    const text = str(name);
    if (!text || /[\^\r\n]/.test(text) || /^\s*javascript:/i.test(text)) return "unsafe";
    if (text.includes(",")) return "alone";
    return "list";
  }

  /* ------------------------------------------------------------------ *
   * Transport
   * ------------------------------------------------------------------ */

  async function defaultTransport(request) {
    if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      throw lensError("transport", "Update Set Lens can't reach the extension.");
    }
    return chrome.runtime.sendMessage(Object.assign({ type: "SN_UPDATE_SET_LENS_GET" }, request));
  }

  /* The last line of defence for two rules that cost a live instance dearly:
   * no read by version id or content fingerprint (seconds per lookup), and
   * never the payload column (up to 4 MB a row). */
  function assertSafeRead(query, fields) {
    /* Per condition, by its field: a typed set name that merely contains the
     * words is a value, not a fingerprint read. */
    const fingerprint = str(query).split("^").some((part) =>
      /^(?:OR|NQ)?(?:update_guid|payload_hash)(?:=|!=|IN|NOT IN|LIKE|STARTSWITH)/.test(part.trim()));
    if (fingerprint) {
      throw lensError("internal", "Refused a read keyed by a version fingerprint.");
    }
    if (/(?:^|,)\s*payload\s*(?:,|$)/i.test(fields)) {
      throw lensError("internal", "Refused a read of update payloads.");
    }
  }

  /* One read: { rows, total }. total is X-Total-Count when asked for, else
   * null. A refusal (401, 403) is "access"; anything else is "transport".
   * Every read suppresses the pagination header: an 80-id chunk that matches
   * more rows than its limit is otherwise answered HTTP 400, so a batch with
   * enough child sets could never be counted. */
  async function readTable(ctx, table, query, fields, limit, options) {
    assertSafeRead(query, fields);
    if (ctx.shouldStop && ctx.shouldStop()) throw lensError("stale", "Superseded.");
    const request = {
      table,
      query,
      fields,
      limit,
      /* expectedOrigin: the tab's token frame can be a frame embedded from
       * another instance, whose rows would be taken for this one's; the page
       * reader refuses it and the read fails instead. */
      options: Object.assign({ displayAll: true, suppressPagination: true },
        ctx.origin ? { expectedOrigin: ctx.origin } : {}, options || {}),
    };
    let response;
    try {
      response = await (ctx.transport || defaultTransport)(request);
    } catch (error) {
      if (error && error.code) throw error;
      throw lensError("transport", errorMessage(error) || "Couldn't read " + table + ".");
    }
    if (!response || response.ok !== true) {
      const status = Number(response && response.status) || 0;
      throw lensError(
        status === 401 || status === 403 ? "access" : "transport",
        str(response && response.error) || "Couldn't read " + table + ".",
        status
      );
    }
    return {
      rows: Array.isArray(response.result) ? response.result : [],
      total: typeof response.total === "number" && Number.isFinite(response.total) ? response.total : null,
    };
  }

  /* Runs fn over a queue that may grow while it runs, `limit` at a time. */
  function drain(queue, limit, fn) {
    let active = 0;
    return new Promise((resolve) => {
      const pump = () => {
        if (!queue.length && !active) {
          resolve();
          return;
        }
        while (active < limit && queue.length) {
          const item = queue.shift();
          active += 1;
          Promise.resolve()
            .then(() => fn(item))
            .catch(() => {})
            .then(() => {
              active -= 1;
              pump();
            });
        }
      };
      pump();
    });
  }

  /* The URL tableApiGetInPage will build, measured the way it builds it. A
   * 40-name read of 250-character names reached 10,407 characters and got
   * HTTP 414 (G2); 22 of them, at 5,713, read fine. */
  function readUrlLength(origin, table, query, fields, limit) {
    const params = new URLSearchParams();
    params.set("sysparm_query", query);
    params.set("sysparm_fields", fields);
    params.set("sysparm_limit", String(limit));
    params.set("sysparm_display_value", "all");
    return str(origin).length + ("/api/now/table/" + encodeURIComponent(table) + "?").length +
      params.toString().length;
  }

  /* Greedy chunks of at most `per` items whose read stays under the URL cap.
   * An item too long to share a read gets one of its own. */
  function chunkForUrl(items, per, measure) {
    const chunks = [];
    let current = [];
    for (const item of items) {
      const next = current.concat([item]);
      if (current.length && (next.length > per || measure(next) > LIMITS.urlCap)) {
        chunks.push(current);
        current = [item];
      } else {
        current = next;
      }
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  function inClause(field, ids) {
    return ids.length === 1 ? field + "=" + ids[0] : field + "IN" + ids.join(",");
  }

  /* ------------------------------------------------------------------ *
   * Normalising rows
   * ------------------------------------------------------------------ */

  function normalizeSet(row) {
    const sysId = raw(row, "sys_id").toLowerCase();
    if (!isSysId(sysId)) return null;
    const ref = (field) => {
      const value = raw(row, field).toLowerCase();
      return isSysId(value) ? value : "";
    };
    return {
      sysId,
      name: raw(row, "name"),
      state: raw(row, "state").toLowerCase(),
      stateLabel: shown(row, "state"),
      isDefault: raw(row, "is_default") === "true",
      scope: shown(row, "application") || raw(row, "application"),
      parent: ref("parent"),
      parentName: shown(row, "parent"),
      base: ref("base_update_set"),
      mergedTo: ref("merged_to"),
      mergedToName: shown(row, "merged_to"),
      remoteSysId: ref("remote_sys_id"),
      originSysId: ref("origin_sys_id"),
      createdBy: raw(row, "sys_created_by"),
      createdOn: shown(row, "sys_created_on"),
      updatedOn: shown(row, "sys_updated_on"),
      updatedOnRaw: raw(row, "sys_updated_on"),
      completedOn: shown(row, "completed_on"),
    };
  }

  function normalizeRetrieved(row) {
    const sysId = raw(row, "sys_id").toLowerCase();
    if (!isSysId(sysId)) return null;
    const updateSet = raw(row, "update_set").toLowerCase();
    return {
      sysId,
      name: raw(row, "name"),
      state: raw(row, "state").toLowerCase(),
      stateLabel: shown(row, "state") || raw(row, "state"),
      remoteSysId: raw(row, "remote_sys_id").toLowerCase(),
      originSysId: raw(row, "origin_sys_id").toLowerCase(),
      /* Validated before it can reach a query: a missing link once built
       * `sys_id=undefined` (A-Q39). */
      updateSet: isSysId(updateSet) ? updateSet : "",
      updateSource: raw(row, "update_source") ? shown(row, "update_source") : "",
      commitDate: shown(row, "commit_date"),
      collisions: shown(row, "collisions"),
      createdOn: shown(row, "sys_created_on"),
    };
  }

  function normalizeVersion(row) {
    return {
      name: raw(row, "name"),
      state: raw(row, "state").toLowerCase(),
      source: raw(row, "source").toLowerCase(),
      sourceTable: raw(row, "source_table"),
      guid: raw(row, "update_guid"),
      hash: raw(row, "payload_hash"),
      action: raw(row, "action").toUpperCase(),
      revertedFrom: raw(row, "reverted_from"),
      createdBy: raw(row, "sys_created_by"),
      createdOn: shown(row, "sys_created_on"),
      createdOnRaw: raw(row, "sys_created_on"),
    };
  }

  function actionLabel(action, display) {
    if (action === "DELETE") return "Delete";
    if (action === "INSERT_OR_UPDATE") return "Update";
    return display || action || "";
  }

  /* ------------------------------------------------------------------ *
   * Reading one set
   * ------------------------------------------------------------------ */

  async function readSetById(id, ctx) {
    const answer = await readTable(ctx, "sys_update_set", "sys_id=" + id, SET_FIELDS, 1);
    const set = answer.rows.map(normalizeSet).find((row) => row && row.sysId === id);
    return set || null;
  }

  async function readRetrievedById(id, ctx) {
    const answer = await readTable(ctx, "sys_remote_update_set", "sys_id=" + id, RETRIEVED_FIELDS, 1);
    const remote = answer.rows.map(normalizeRetrieved).find((row) => row && row.sysId === id);
    return remote || null;
  }

  function readFailure(error) {
    if (error && error.code === "access") {
      return {
        kind: "error",
        message: "This account can't read update sets here (HTTP " + (error.status || 403) + ").",
      };
    }
    return { kind: "error", message: "Couldn't read update sets: " + errorMessage(error) };
  }

  /* §3.2 steps 2-4: a local set, else a retrieved one, else nothing. ACLs
   * hide rows rather than refuse them, so nothing is "you can't read it" too. */
  async function resolveById(id, ctx) {
    try {
      const set = await readSetById(id, ctx);
      if (set) return { kind: "set", set };
      const remote = await readRetrievedById(id, ctx);
      if (remote) return { kind: "retrieved", remote };
      return { kind: "none", message: "No update set with that sys_id here, or you can't read it." };
    } catch (error) {
      if (error && error.code === "stale") throw error;
      return readFailure(error);
    }
  }

  /* In progress, then complete by last update, then anything else, then
   * Ignore; Default sets last whatever their state. The tag comes from
   * is_default, never from the name: "Default" names ordinary sets too. */
  function orderChoices(sets) {
    const rank = (set) => {
      if (set.isDefault) return 4;
      if (set.state === "in progress") return 0;
      if (set.state === "complete") return 1;
      if (set.state === "ignore") return 3;
      return 2;
    };
    return sets
      .map((set, index) => ({ set, index }))
      .sort((left, right) =>
        rank(left.set) - rank(right.set) ||
        (left.set.updatedOnRaw < right.set.updatedOnRaw ? 1 : left.set.updatedOnRaw > right.set.updatedOnRaw ? -1 : 0) ||
        left.index - right.index)
      .map((entry) => entry.set);
  }

  async function resolveByName(text, ctx) {
    const limit = LIMITS.chooser + 1;
    try {
      const exact = await readTable(
        ctx, "sys_update_set", "name=" + text + "^ORDERBYDESCsys_updated_on", SET_FIELDS, limit
      );
      /* The server's answer is checked, so an ignored condition cannot pass. */
      const wanted = foldName(text);
      const matches = exact.rows.map(normalizeSet).filter((set) => set && foldName(set.name) === wanted);
      if (matches.length === 1) return { kind: "set", set: matches[0] };
      if (matches.length > 1) {
        return {
          kind: "choose",
          typed: text,
          sets: orderChoices(matches).slice(0, LIMITS.chooser),
          more: exact.rows.length >= limit || matches.length > LIMITS.chooser,
        };
      }
      const like = await readTable(
        ctx, "sys_update_set", "nameLIKE" + text + "^ORDERBYDESCsys_updated_on", SET_FIELDS, limit
      );
      const suggestions = like.rows.map(normalizeSet)
        .filter((set) => set && foldName(set.name).includes(wanted));
      if (suggestions.length) {
        return {
          kind: "suggest",
          typed: text,
          sets: orderChoices(suggestions).slice(0, LIMITS.chooser),
          more: like.rows.length >= limit || suggestions.length > LIMITS.chooser,
        };
      }
      return { kind: "none", message: "No update set named \"" + text + "\" here, or you can't read it." };
    } catch (error) {
      if (error && error.code === "stale") throw error;
      return readFailure(error);
    }
  }

  const UNSAFE_INPUT = "Use the sys_id or a link.";

  function linkIn(text) {
    const match = str(text).match(/https?:\/\/[^\s"'<>]+/i);
    if (!match) return null;
    try {
      return { url: new URL(match[0]), href: match[0] };
    } catch (error) {
      return { refused: true };
    }
  }

  /* §3.3. Typed input always wins over the page. Returns
   *   { kind: "set", set } | { kind: "retrieved", remote }
   *   { kind: "choose" | "suggest", typed, sets, more }
   *   { kind: "refused" | "none" | "error", message } */
  async function resolveUpdateSetInput(input, ctx) {
    const text = str(input).trim();
    if (!text) return { kind: "refused", message: "Type an update set's name, sys_id or link." };
    if (/[\r\n]/.test(text)) return { kind: "refused", message: UNSAFE_INPUT };
    const link = linkIn(text);
    if (link) {
      if (link.refused) return { kind: "refused", message: "That link can't be read. Paste the set's own link, or its sys_id." };
      const url = link.url;
      if (url.protocol !== "https:" || url.username || url.password || url.origin !== ctx.origin) {
        return {
          kind: "refused",
          message: "This link is to " + url.hostname + ". Update history belongs to each instance; " +
            "run Update Set Lens there.",
        };
      }
      if (isListRoute(link.href)) {
        return { kind: "refused", message: "That link opens a list. Open the update set and paste its own link, or its sys_id." };
      }
      const id = str(ctx.sysIdFromText ? ctx.sysIdFromText(link.href) : "").toLowerCase();
      if (!isSysId(id)) {
        return { kind: "refused", message: "That link doesn't name an update set. Paste the set's own link, or its sys_id." };
      }
      return resolveById(id, ctx);
    }
    if (text.includes("^") || /^javascript:/i.test(text)) return { kind: "refused", message: UNSAFE_INPUT };
    if (isSysId(text.toLowerCase())) return resolveById(text.toLowerCase(), ctx);
    return resolveByName(text, ctx);
  }

  /* §3.2: the set the page shows, or { kind: "none" } for the input row. A
   * list, and a page that is clearly some other table's record, cost no read.
   * The rest is decided by a read, because a nav_to.do URL names nav_to. */
  async function pageUpdateSet(href, ctx) {
    if (isListRoute(href)) return { kind: "none" };
    const table = str(ctx.pageTable).toLowerCase();
    if (table && !PAGE_TABLES_TO_READ.has(table)) return { kind: "none" };
    let id = "";
    try {
      id = str(ctx.currentSysId ? await ctx.currentSysId() : "").toLowerCase();
    } catch (error) {
      return { kind: "none" };
    }
    if (!isSysId(id)) return { kind: "none" };
    const found = await resolveById(id, ctx);
    if (found.kind === "set" || found.kind === "retrieved") return Object.assign({ pageSysId: id }, found);
    return { kind: "none" };
  }

  /* ------------------------------------------------------------------ *
   * The rule (§5.1)
   * ------------------------------------------------------------------ */

  /* Rules 1-5. `found` is what the version read gave for this row's name:
   * { versions, error, unsafe, saturated }. Returns a verdict, or
   * { candidate: c } for a row that needs rule 6. "This set" is the row's own
   * set: the local set for an arrival, the child set in batch mode. */
  function firstPass(row, found, batchIds) {
    if (found.unsafe) return { verdict: "cant", reason: "unqueryable" };
    if (found.error) {
      return { verdict: "cant", reason: found.error.code === "access" ? "versions-refused" : "versions-failed" };
    }
    if (found.saturated) return { verdict: "cant", reason: "several-current" };
    const versions = found.versions || [];
    if (!versions.length) return { verdict: "cant", reason: "no-version" };
    if (versions.length > 1) return { verdict: "cant", reason: "several-current" };
    const c = versions[0];
    /* Two blanks never compare equal, and a blank never yields a verdict:
     * a source with no source table names nothing (none on two instances,
     * but a field ACL could blank one). */
    if (!row.guid || !row.hash || !c.guid || !c.hash || !c.source || !c.sourceTable) {
      return { verdict: "cant", reason: "incomplete", c };
    }
    const inThisSet = c.sourceTable === "sys_update_set" && c.source === row.setId;
    if (c.guid === row.guid) {
      if (c.hash === row.hash) return { verdict: "current", c, elsewhere: !inThisSet };
      return { verdict: "cant", reason: "same-id-different-content", c };
    }
    if (inThisSet) {
      if (c.hash === row.hash) return { verdict: "current", c, laterSave: true };
      return { verdict: "cant", reason: "later-version-here", c };
    }
    if (batchIds && c.sourceTable === "sys_update_set" && batchIds.has(c.source)) {
      return { verdict: "batch", c };
    }
    if (c.hash === row.hash) return { verdict: "same", c };
    return { candidate: c };
  }

  function latestBy(rows) {
    return rows.reduce((best, row) => (!best || row.createdOnRaw > best.createdOnRaw ? row : best), null);
  }

  /* Rules 6 and 6b, then 7-8. `own` is every version of this row's name
   * credited to its own set (source_table=sys_update_set, source = that
   * set). The baseline must be this capture (same guid) or its exact content
   * from this same set (same hash), and `previous`: the one state that means
   * "loaded here, then replaced". */
  function appliedGuard(row, c, own) {
    if (!own.length) return { verdict: "cant", reason: "not-applied", c };
    const matching = own.filter((version) =>
      (version.guid && version.guid === row.guid) || (version.hash && version.hash === row.hash));
    const baselines = matching.filter((version) => version.state === "previous");
    if (!baselines.length) {
      if (matching.some((version) => version.state === "backedout")) {
        return { verdict: "cant", reason: "backed-out-here", c };
      }
      if (matching.some((version) => version.state === "history" || version.state === "history_collision")) {
        return { verdict: "cant", reason: "never-loaded", c };
      }
      if (matching.length) return { verdict: "cant", reason: "not-recorded-loaded", c };
      return { verdict: "cant", reason: "own-versions-differ", c };
    }
    const byGuid = baselines.filter((version) => version.guid === row.guid);
    const baseline = latestBy(byGuid.length ? byGuid : baselines);
    if (!baseline.createdOnRaw || !c.createdOnRaw) return { verdict: "cant", reason: "incomplete", c };
    /* 6b: a skip_collision update gets a `previous` version although it was
     * skipped, so the state alone does not prove the order. Raw values are
     * "YYYY-MM-DD HH:MM:SS" in UTC, so text order is time order. */
    if (c.createdOnRaw < baseline.createdOnRaw) return { verdict: "cant", reason: "runs-older", c };
    return { verdict: "stale", c, matchedByContent: !byGuid.length };
  }

  function staleText(row, c, setName) {
    if (c.sourceTable === "sys_upgrade_history") return "Replaced by an upgrade";
    if (c.sourceTable === "sys_store_app") return "Replaced by an application install";
    if (c.sourceTable !== "sys_update_set") {
      return "Replaced outside update sets (" + (c.sourceTable || "unknown source") + ")";
    }
    let text;
    if (c.action === "DELETE") text = "Deleted in “" + setName + "”";
    else if (row.action === "DELETE") text = "Re-created in “" + setName + "”";
    else text = "Newer version in “" + setName + "”";
    if (c.revertedFrom) text += " — a revert to that set's earlier content";
    return text;
  }

  function sourceWords(c, setName) {
    if (c.sourceTable === "sys_update_set") return "“" + setName + "”";
    if (c.sourceTable === "sys_upgrade_history") return "an upgrade";
    if (c.sourceTable === "sys_store_app") return "an application install";
    return c.sourceTable || "another source";
  }

  /* ------------------------------------------------------------------ *
   * Classifying one window of member rows
   * ------------------------------------------------------------------ */

  /* Reads by name in URL-capped chunks, splitting any chunk that fills its
   * limit, down to single names. A single name that still fills it is
   * `saturated`: its answer is incomplete, and never a verdict. */
  async function readByNames(ctx, table, entries, keyOf, buildQuery, fields, limitFor, per, options) {
    const out = { rows: [], failed: new Map(), saturated: new Set() };
    const measure = (group) => readUrlLength(ctx.origin, table, buildQuery(group), fields, limitFor(group.length));
    const queue = [];
    const listed = entries.filter((entry) => nameQueryKind(keyOf(entry)) === "list");
    chunkForUrl(listed, per || LIMITS.namesPerRead, measure).forEach((group) => queue.push(group));
    entries.filter((entry) => nameQueryKind(keyOf(entry)) === "alone").forEach((entry) => queue.push([entry]));
    await drain(queue, LIMITS.concurrency, async (group) => {
      const limit = limitFor(group.length);
      let answer;
      try {
        answer = await readTable(ctx, table, buildQuery(group), fields, limit, options);
      } catch (error) {
        if (error && error.code === "stale") return;
        group.forEach((entry) => out.failed.set(keyOf(entry), error));
        return;
      }
      if (answer.rows.length >= limit) {
        if (group.length === 1) {
          out.saturated.add(keyOf(group[0]));
          return;
        }
        const middle = Math.ceil(group.length / 2);
        queue.push(group.slice(0, middle), group.slice(middle));
        return;
      }
      answer.rows.forEach((row) => out.rows.push(row));
    });
    return out;
  }

  function nameCondition(names) {
    return names.length === 1 ? "name=" + names[0] : "nameIN" + names.join(",");
  }

  async function readCurrentVersions(names, ctx) {
    const result = await readByNames(
      ctx, "sys_update_version", names, (name) => name,
      (group) => "state=current^" + nameCondition(group),
      VERSION_FIELDS,
      (count) => count * 2 + 2
    );
    const byName = new Map();
    result.rows.map(normalizeVersion).forEach((version) => {
      /* Checked in code: the exact name, and the current state. */
      if (version.state !== "current" || !names.includes(version.name)) return;
      if (!byName.has(version.name)) byName.set(version.name, []);
      byName.get(version.name).push(version);
    });
    return { byName, failed: result.failed, saturated: result.saturated };
  }

  /* Rule 6's read, keyed by source and name, never by version id. */
  async function readOwnVersions(candidates, ctx) {
    const key = (entry) => entry.row.name;
    const build = (group) => {
      const sets = Array.from(new Set(group.map((entry) => entry.row.setId)));
      const names = Array.from(new Set(group.map((entry) => entry.row.name)));
      return "source_table=sys_update_set^" + inClause("source", sets) + "^" + nameCondition(names);
    };
    const result = await readByNames(
      ctx, "sys_update_version", candidates, key, build, APPLIED_FIELDS, () => LIMITS.appliedLimit
    );
    const own = new Map();
    result.rows.map(normalizeVersion).forEach((version) => {
      if (version.sourceTable !== "sys_update_set") return;
      const id = version.source + "\u0000" + version.name;
      if (!own.has(id)) own.set(id, []);
      own.get(id).push(version);
    });
    return { own, failed: result.failed, saturated: result.saturated };
  }

  async function readSetsById(ids, ctx) {
    const found = new Map();
    const failed = new Set();
    const queue = chunk(ids.filter(isSysId), LIMITS.setsPerRead);
    await drain(queue, LIMITS.concurrency, async (group) => {
      try {
        const answer = await readTable(ctx, "sys_update_set", inClause("sys_id", group), SET_FIELDS, group.length + 1);
        answer.rows.map(normalizeSet).forEach((set) => {
          if (set && group.includes(set.sysId)) found.set(set.sysId, set);
        });
      } catch (error) {
        group.forEach((id) => failed.add(id));
      }
    });
    return { found, failed };
  }

  /* ------------------------------------------------------------------ *
   * Presenting a verdict
   * ------------------------------------------------------------------ */

  function setLabel(set, id) {
    if (set) return set.name || "an unnamed update set";
    return id ? "an update set you can't read" : "another update set";
  }

  function newerFlags(set, c) {
    const flags = [];
    if (set) {
      if (set.isDefault) flags.push({ label: "Default set: changed outside a named set", kind: "default" });
      else if (set.state === "in progress") flags.push({ label: "In progress", kind: "progress" });
      else if (set.state === "ignore") flags.push({ label: "Ignore", kind: "ignore" });
      else if (set.stateLabel) flags.push({ label: set.stateLabel, kind: "" });
      if (set.remoteSysId) flags.push({ label: "Committed here from another instance", kind: "" });
    }
    if (c && c.revertedFrom) flags.push({ label: "Revert", kind: "" });
    return flags;
  }

  function linksFor(row, c, origin) {
    const links = [];
    if (isSysId(row.sysId)) {
      links.push({ label: "Open update", url: origin + "/sys_update_xml.do?sys_id=" + row.sysId });
    }
    /* Found on click, as ServiceNow's own Show Related Record finds it; a
     * deleted record has nothing to open. */
    if (row.action !== "DELETE" && nameQueryKind(row.name) !== "unsafe") {
      links.push({ label: "Open record", record: row.name });
    }
    if (c && c.sourceTable === "sys_update_set" && isSysId(c.source) && c.source !== row.setId) {
      links.push({ label: "Open newer set", url: origin + "/sys_update_set.do?sys_id=" + c.source });
    }
    if (nameQueryKind(row.name) !== "unsafe") {
      links.push({
        label: "Version history",
        url: origin + "/sys_update_version_list.do?sysparm_query=" +
          encodeURIComponent("name=" + row.name + "^ORDERBYDESCsys_recorded_at"),
      });
    }
    return links;
  }

  /* The row the panel draws: everything as text, links from allowlisted
   * fields only. */
  function presentRow(row, outcome, sets, origin) {
    const c = outcome.c || null;
    const newerSet = c && c.sourceTable === "sys_update_set" ? sets.get(c.source) || null : null;
    const name = c && c.sourceTable === "sys_update_set" ? setLabel(newerSet, c.source) : "";
    const notes = [];
    let text = "";
    let flags = [];
    let who = "";
    if (outcome.verdict === "stale") {
      text = staleText(row, c, name);
      flags = c.sourceTable === "sys_update_set" ? newerFlags(newerSet, c) : [];
      if (outcome.matchedByContent) flags.push({ label: "matched by content", kind: "" });
      if (c.createdBy || c.createdOn) {
        who = newerSet && newerSet.remoteSysId
          ? "Version by " + (c.createdBy || "unknown") + ", committed here " + (c.createdOn || "")
          : "Version by " + (c.createdBy || "unknown") + " at " + (c.createdOn || "");
      }
    } else if (outcome.verdict === "cant") {
      text = "Can't tell: " + (CANT_TELL[outcome.reason] || CANT_TELL["versions-failed"]) + ".";
    } else if (outcome.verdict === "same") {
      text = "Same content, versioned under " + sourceWords(c, name);
    } else if (outcome.verdict === "batch") {
      text = "Newer version is in " + sourceWords(c, name) + " of this batch";
    } else {
      text = "This set's version is the one that runs here.";
      if (outcome.laterSave) notes.push("later save in this set");
      if (outcome.elsewhere) notes.push("versioned under " + sourceWords(c, name));
    }
    return {
      key: row.key,
      sysId: row.sysId,
      name: row.name,
      type: row.type,
      target: row.target,
      action: row.actionLabel,
      setId: row.setId,
      verdict: outcome.verdict,
      reason: outcome.reason || "",
      text,
      flags,
      who,
      notes,
      links: linksFor(row, c, origin),
      asRetrieved: Boolean(row.asRetrieved),
      newerSetId: newerSet ? newerSet.sysId : (c && c.sourceTable === "sys_update_set" ? c.source : ""),
      newerSetName: c && c.sourceTable === "sys_update_set" && outcome.verdict === "stale" ? name : "",
      newerSetState: newerSet ? (newerSet.isDefault ? "default set" : newerSet.stateLabel || newerSet.state) : "",
      guid: row.guid,
      hash: row.hash,
      /* For the panel's card: the text without its verdict word, and the
       * newer version's save as facts (`who` says the same in a sentence). */
      explain: outcome.verdict === "cant" ? (CANT_TELL[outcome.reason] || CANT_TELL["versions-failed"]) + "." : text,
      newerSave: who ? {
        by: c.createdBy || "",
        on: c.createdOn || "",
        committedHere: Boolean(newerSet && newerSet.remoteSysId),
      } : null,
    };
  }

  /* The record an update saves, found the way ServiceNow's own Show Related
   * Record finds it: sys_metadata by sys_update_name, latest updated first.
   * Data added to a set is outside sys_metadata, so a name made of a table
   * and a sys_id is tried next, and opened only once a read finds it. */
  async function recordUrl(name, ctx) {
    if (nameQueryKind(name) === "unsafe") {
      return { ok: false, message: "This update's name can't be looked up safely." };
    }
    let found = null;
    try {
      const answer = await readTable(ctx, "sys_metadata", "sys_update_name=" + name + "^ORDERBYDESCsys_updated_on",
        "sys_id,sys_class_name,sys_update_name", 5, { displayAll: false });
      const row = answer.rows.find((candidate) => foldName(raw(candidate, "sys_update_name")) === foldName(name));
      const table = raw(row, "sys_class_name");
      const id = raw(row, "sys_id").toLowerCase();
      if (row && TABLE_NAME.test(table) && isSysId(id)) found = { table, id };
    } catch (error) {
      return {
        ok: false,
        message: error && error.code === "access" ? "This account can't look up records here." : "Couldn't look up this update's record.",
      };
    }
    const named = NAMED_RECORD.exec(str(name));
    if (!found && named && TABLE_NAME.test(named[1])) {
      try {
        const answer = await readTable(ctx, named[1], "sys_id=" + named[2], "sys_id", 1, { displayAll: false });
        if (answer.rows.some((row) => raw(row, "sys_id").toLowerCase() === named[2])) found = { table: named[1], id: named[2] };
      } catch (error) {
        /* Not a table, or not readable: there is nothing to open. */
      }
    }
    if (!found) return { ok: false, message: "No record found for this update." };
    return { ok: true, url: ctx.origin + "/" + found.table + ".do?sys_id=" + found.id };
  }

  /* §5.1 over one window of member rows: the version reads, rule 6's read for
   * the stale candidates, then one metadata read for sets not yet known. */
  async function classifyRows(rows, ctx, options) {
    const opts = options || {};
    const batchIds = opts.batchIds || null;
    const sets = opts.sets || new Map();
    const names = Array.from(new Set(rows.map((row) => row.name).filter((name) => nameQueryKind(name) !== "unsafe")));
    const current = await readCurrentVersions(names, ctx);
    const outcomes = new Map();
    const candidates = [];
    rows.forEach((row) => {
      const found = {
        unsafe: nameQueryKind(row.name) === "unsafe",
        error: current.failed.get(row.name) || null,
        saturated: current.saturated.has(row.name),
        versions: current.byName.get(row.name) || [],
      };
      const first = firstPass(row, found, batchIds);
      if (first.candidate) candidates.push({ row, c: first.candidate });
      else outcomes.set(row.key, first);
    });
    if (candidates.length) {
      const own = await readOwnVersions(candidates, ctx);
      candidates.forEach(({ row, c }) => {
        if (own.failed.has(row.name)) {
          const error = own.failed.get(row.name);
          outcomes.set(row.key, {
            verdict: "cant",
            reason: error && error.code === "access" ? "versions-refused" : "versions-failed",
            c,
          });
          return;
        }
        if (own.saturated.has(row.name)) {
          outcomes.set(row.key, { verdict: "cant", reason: "too-many-versions", c });
          return;
        }
        outcomes.set(row.key, appliedGuard(row, c, own.own.get(row.setId + "\u0000" + row.name) || []));
      });
    }
    const wanted = new Set();
    outcomes.forEach((outcome) => {
      const c = outcome.c;
      if (c && c.sourceTable === "sys_update_set" && isSysId(c.source) && !sets.has(c.source)) wanted.add(c.source);
    });
    if (wanted.size) {
      const read = await readSetsById(Array.from(wanted), ctx);
      read.found.forEach((set, id) => sets.set(id, set));
    }
    const versionsRefused = Array.from(current.failed.values()).some((error) => error && error.code === "access");
    /* `current` is the version read itself ({ byName, failed, saturated }),
     * for Version Lens's "Runs here" line. This panel ignores it. */
    return {
      rows: rows.map((row) => presentRow(row, outcomes.get(row.key), sets, ctx.origin)),
      versionsRefused,
      current,
    };
  }

  /* ------------------------------------------------------------------ *
   * Membership: the union of both shapes (§4.3), keyed paging, the cap
   * ------------------------------------------------------------------ */

  function normalizeMember(row, setId, asRetrieved) {
    const action = raw(row, "action").toUpperCase();
    return {
      sysId: raw(row, "sys_id").toLowerCase(),
      name: raw(row, "name"),
      setId,
      asRetrieved,
      action,
      actionLabel: actionLabel(action, shown(row, "action")),
      type: shown(row, "type"),
      target: raw(row, "target_name"),
      guid: raw(row, "update_guid"),
      hash: raw(row, "payload_hash"),
    };
  }

  /* A list of member rows over chunks of set ids, paged by sys_id. `field` is
   * update_set or remote_update_set; `owner(id)` maps a chunk id back to the
   * local set it stands for. */
  function memberList(kind, field, ids, owner) {
    return {
      kind,
      field,
      chunks: chunk(ids, LIMITS.setsPerRead),
      owner,
      totals: [],
      cursor: { index: 0, last: "" },
      done: ids.length === 0,
      yielded: 0,
    };
  }

  async function countList(list, ctx) {
    list.totals = await Promise.all(list.chunks.map(async (ids) => {
      const answer = await readTable(ctx, "sys_update_xml", inClause(list.field, ids), "sys_id", 1, { withTotal: true });
      if (answer.total != null) return answer.total;
      return answer.rows.length ? null : 0;
    }));
  }

  function listTotal(list) {
    /* Not counted yet is unknown, not zero. */
    if (list.chunks.length && list.totals.length !== list.chunks.length) return null;
    if (list.totals.some((total) => total == null)) return null;
    return list.totals.reduce((sum, total) => sum + total, 0);
  }

  async function nextPage(list, ctx, room) {
    const ids = list.chunks[list.cursor.index];
    const limit = Math.min(LIMITS.memberPage, room);
    let query = inClause(list.field, ids);
    if (list.cursor.last) query += "^sys_id>" + list.cursor.last;
    query += "^ORDERBYsys_id";
    const answer = await readTable(ctx, "sys_update_xml", query, MEMBER_FIELDS, limit);
    const rows = [];
    let last = list.cursor.last;
    answer.rows.forEach((row) => {
      const sysId = raw(row, "sys_id").toLowerCase();
      if (!isSysId(sysId) || (last && sysId <= last)) return;
      last = sysId;
      /* Checked in code: a row whose set is not in this chunk came from an
       * ignored condition. Never filtered by category: committed copies are
       * `retrieved` and `customer` alike. */
      const holder = raw(row, list.field).toLowerCase();
      if (!ids.includes(holder)) return;
      rows.push(normalizeMember(row, list.owner(holder), list.kind === "retrieved"));
    });
    /* A full page of rows that all belong elsewhere means the condition was
     * not applied. Paging on would walk the whole table, so the list stops
     * and says the read can't be trusted. */
    if (answer.rows.length >= limit && !rows.length) {
      list.done = true;
      list.suspect = true;
      return rows;
    }
    if (answer.rows.length < limit) {
      list.cursor = { index: list.cursor.index + 1, last: "" };
      if (list.cursor.index >= list.chunks.length) list.done = true;
    } else {
      list.cursor = { index: list.cursor.index, last };
    }
    list.yielded += rows.length;
    return rows;
  }

  /* ------------------------------------------------------------------ *
   * Batches (§3.4)
   * ------------------------------------------------------------------ */

  async function countChildren(set, ctx) {
    const answer = await readTable(ctx, "sys_update_set", "parent=" + set.sysId, "sys_id", 1, { withTotal: true });
    if (answer.total != null) return answer.total;
    return answer.rows.length;
  }

  /* Every set under `root`, breadth first on parent, at most 6 levels and
   * 1,000 sets, with every visited id kept so a cycle cannot loop. A root that
   * is its own base is read once by base_update_set instead (G5: the same
   * sets 5 of 5). */
  async function walkBatch(root, ctx) {
    const sets = [];
    if (root.base && root.base === root.sysId) {
      const answer = await readTable(
        ctx, "sys_update_set", "base_update_set=" + root.sysId + "^ORDERBYsys_created_on",
        SET_FIELDS, LIMITS.batchSets + 2
      );
      const seen = new Set([root.sysId]);
      answer.rows.map(normalizeSet).forEach((set) => {
        if (!set || seen.has(set.sysId) || set.base !== root.sysId) return;
        seen.add(set.sysId);
        sets.push(set);
      });
      const capped = sets.length > LIMITS.batchSets;
      return { sets: sets.slice(0, LIMITS.batchSets), capped, depthCapped: false };
    }
    const visited = new Set([root.sysId]);
    let frontier = [root.sysId];
    let depth = 0;
    let capped = false;
    while (frontier.length && depth < LIMITS.batchDepth && !capped) {
      const next = [];
      for (const group of chunk(frontier, LIMITS.setsPerRead)) {
        const room = LIMITS.batchSets - sets.length;
        if (room <= 0) {
          capped = true;
          break;
        }
        const answer = await readTable(
          ctx, "sys_update_set", inClause("parent", group) + "^ORDERBYsys_created_on", SET_FIELDS, room + 1
        );
        for (const set of answer.rows.map(normalizeSet)) {
          if (!set || visited.has(set.sysId) || !group.includes(set.parent)) continue;
          if (sets.length >= LIMITS.batchSets) {
            capped = true;
            break;
          }
          visited.add(set.sysId);
          sets.push(set);
          next.push(set.sysId);
        }
      }
      frontier = next;
      depth += 1;
    }
    return { sets, capped, depthCapped: frontier.length > 0 && depth >= LIMITS.batchDepth };
  }

  /* ------------------------------------------------------------------ *
   * The session: one panel's worth of state
   * ------------------------------------------------------------------ */

  function retrievedScreen(remote, pageSysId, origin) {
    const links = [];
    const openRetrieved = { label: "Open retrieved set", url: origin + "/sys_remote_update_set.do?sys_id=" + remote.sysId };
    const state = remote.state;
    let message;
    /* Said only where it is true. A committed set's updates are applied
     * here, and any other state is shown by its label with no claim. */
    let note = "";
    if (state === "committed") {
      message = remote.updateSet
        ? "Committed here, but its local set can't be read."
        : "Committed here; its local set isn't linked.";
    } else if (NOT_COMMITTED_STATES.has(state)) {
      message = "Not committed on this instance; ServiceNow's Preview checks it here.";
      note = NOT_APPLIED_NOTE;
    } else if (BACKED_OUT_STATES.has(state)) {
      message = "Backed out on this instance; its updates are no longer applied here.";
      note = NOT_APPLIED_NOTE;
    } else {
      message = (remote.stateLabel || state || "Unknown state") + ".";
    }
    if (pageSysId !== remote.sysId) links.push(openRetrieved);
    if (PREVIEWED_STATES.has(state)) {
      links.push({
        label: "Open preview problems",
        url: origin + "/sys_update_preview_problem_list.do?sysparm_query=" +
          encodeURIComponent("remote_update_set=" + remote.sysId),
      });
    }
    return {
      name: remote.name,
      stateLabel: remote.stateLabel || remote.state,
      loadedOn: remote.createdOn,
      source: remote.updateSource,
      message,
      note,
      links,
    };
  }

  /*
   * createSession(resolution, ctx, options) -> session
   *   resolution: { kind: "set", set } or { kind: "retrieved", remote }
   *   ctx: { origin, transport?, sysIdFromText?, shouldStop? }
   *   options: { pageSysId }
   *
   * session.prepare()      reads what the heading needs
   * session.start()        checks the first 2,000 rows
   * session.continue()     checks the next 2,000
   * session.setIncludeChildren(on)
   * session.view()         the panel's snapshot
   * session.onChange(fn)   called with a fresh snapshot after every step
   * session.cancel()
   * session.remoteRequest()            what Check on sends
   * session.placeRemote(reply, request, onRead)
   *                        places what runs there in each differing row's
   *                        own history, for remoteView
   */
  function createSession(resolution, ctx, options) {
    const opts = options || {};
    const listeners = [];
    let cancelled = false;
    let generation = 0;
    const sessionCtx = Object.assign({}, ctx, {
      shouldStop: () => cancelled || Boolean(ctx.shouldStop && ctx.shouldStop()),
    });
    const state = {
      phase: "preparing",
      subject: null,
      viaRetrieved: null,
      retrieved: null,
      provenance: null,
      banners: [],
      backedOut: false,
      ownTotal: null,
      batch: null,
      includeChildren: false,
      scope: [],
      sets: new Map(),
      lists: [],
      rows: [],
      keyCount: new Map(),
      attachedGuids: new Map(),
      attachedRows: new Map(),
      versionsRefused: false,
      membershipUnreadable: false,
      countsDisagree: false,
      message: "",
      error: "",
      progress: "",
      busy: true,
    };

    function emit() {
      if (cancelled) return;
      const snapshot = view();
      listeners.forEach((listener) => {
        try { listener(snapshot); } catch (error) { /* a listener must not stop the run */ }
      });
    }

    function stale(token) {
      return cancelled || token !== generation;
    }

    async function prepare() {
      const token = generation;
      try {
        if (resolution.kind === "retrieved") {
          const remote = resolution.remote;
          if (remote.state === "committed" && remote.updateSet) {
            const local = await readSetById(remote.updateSet, sessionCtx);
            if (stale(token)) return;
            if (local) {
              state.subject = local;
              state.viaRetrieved = remote;
            }
          }
          if (!state.subject) {
            state.retrieved = retrievedScreen(remote, opts.pageSysId, ctx.origin);
            state.phase = "retrieved";
            state.busy = false;
            emit();
            return;
          }
        } else {
          state.subject = resolution.set;
        }
        const set = state.subject;
        state.sets.set(set.sysId, set);
        const probes = await Promise.all([
          countChildren(set, sessionCtx).catch(() => null),
          ownCount(set).catch(() => null),
          set.remoteSysId ? readRetrievedById(set.remoteSysId, sessionCtx).catch(() => null) : null,
          backedOutHere(set).catch(() => false),
        ]);
        if (stale(token)) return;
        const [children, own, provenance] = probes;
        state.backedOut = probes[3];
        state.ownTotal = own;
        state.provenance = provenance;
        if (children) {
          state.batch = { children, walked: false, setCount: null, capped: false, depthCapped: false };
          /* Q3: on when the set holds no rows itself (95 of 102 parents). */
          state.includeChildren = own === 0;
        }
        state.phase = "ready";
        emit();
      } catch (error) {
        if (stale(token)) return;
        state.phase = "error";
        state.busy = false;
        state.error = errorMessage(error);
        emit();
      }
    }

    async function ownCount(set) {
      let total = 0;
      for (const [field, id] of [["update_set", set.sysId], ["remote_update_set", set.remoteSysId]]) {
        if (!id) continue;
        const answer = await readTable(sessionCtx, "sys_update_xml", field + "=" + id, "sys_id", 1, { withTotal: true });
        if (answer.total == null) return answer.rows.length ? null : total;
        total += answer.total;
      }
      return total;
    }

    async function backedOutHere(set) {
      const answer = await readTable(
        sessionCtx, "sys_update_version",
        "source=" + set.sysId + "^source_table=sys_update_set^state=backedout",
        "name,state,source,source_table", 1
      );
      return answer.rows.some((row) =>
        raw(row, "state") === "backedout" && raw(row, "source").toLowerCase() === set.sysId &&
        raw(row, "source_table") === "sys_update_set");
    }

    function resetRun() {
      state.rows = [];
      state.keyCount = new Map();
      state.attachedGuids = new Map();
      state.attachedRows = new Map();
      state.lists = [];
      state.versionsRefused = false;
      state.membershipUnreadable = false;
      state.countsDisagree = false;
      state.message = "";
    }

    async function buildScope(token) {
      const set = state.subject;
      let scope = [set];
      if (state.includeChildren && state.batch) {
        state.progress = "Finding the sets in this batch…";
        emit();
        const walked = await walkBatch(set, sessionCtx);
        if (stale(token)) return null;
        walked.sets.forEach((child) => state.sets.set(child.sysId, child));
        state.batch.walked = true;
        state.batch.setCount = walked.sets.length;
        state.batch.capped = walked.capped;
        state.batch.depthCapped = walked.depthCapped;
        scope = scope.concat(walked.sets);
      }
      return scope;
    }

    async function start() {
      generation += 1;
      const token = generation;
      resetRun();
      if (!state.subject) return;
      state.phase = "running";
      state.busy = true;
      state.error = "";
      try {
        const scope = await buildScope(token);
        if (!scope) return;
        state.scope = scope;
        const local = scope.map((set) => set.sysId);
        const byRetrieved = new Map();
        scope.forEach((set) => { if (set.remoteSysId) byRetrieved.set(set.remoteSysId, set.sysId); });
        const attached = memberList("attached", "update_set", local, (id) => id);
        const retrieved = memberList("retrieved", "remote_update_set", Array.from(byRetrieved.keys()),
          (id) => byRetrieved.get(id) || "");
        state.lists = [attached, retrieved];
        state.progress = "Counting updates…";
        emit();
        await Promise.all(state.lists.map((list) => countList(list, sessionCtx)));
        if (stale(token)) return;
        await checkNext(token);
      } catch (error) {
        if (stale(token)) return;
        state.phase = "error";
        state.busy = false;
        state.error = errorMessage(error);
        emit();
      }
    }

    async function continueRun() {
      if (!state.lists.length || state.busy) return;
      generation += 1;
      const token = generation;
      state.busy = true;
      try {
        await checkNext(token);
      } catch (error) {
        if (stale(token)) return;
        state.busy = false;
        state.error = errorMessage(error);
        emit();
      }
    }

    function addRows(fresh) {
      const kept = [];
      fresh.forEach((row) => {
        const key = row.setId + "\u0000" + row.name;
        if (row.asRetrieved) {
          /* Both shapes hold this name: the attached row is the one kept. */
          if (state.attachedGuids.has(key)) {
            if (!state.attachedGuids.get(key).has(row.guid)) {
              (state.attachedRows.get(key) || []).forEach((shownRow) => {
                if (!shownRow.notes.includes("the retrieved copy differs")) shownRow.notes.push("the retrieved copy differs");
              });
            }
            return;
          }
        } else {
          if (!state.attachedGuids.has(key)) state.attachedGuids.set(key, new Set());
          state.attachedGuids.get(key).add(row.guid);
        }
        const seen = state.keyCount.get(key) || 0;
        state.keyCount.set(key, seen + 1);
        row.key = key + "\u0000" + seen;
        row.duplicate = seen > 0;
        kept.push(row);
      });
      return kept;
    }

    async function checkNext(token) {
      let room = LIMITS.rowCap;
      const batchIds = state.includeChildren && state.scope.length > 1
        ? new Set(state.scope.map((set) => set.sysId)) : null;
      while (room > 0) {
        const list = state.lists.find((candidate) => !candidate.done);
        if (!list) break;
        state.progress = "Reading this set's updates…";
        const page = await nextPage(list, sessionCtx, room);
        if (stale(token)) return;
        const fresh = addRows(page);
        if (fresh.length) {
          state.progress = "Checking versions… " + (state.rows.length + fresh.length).toLocaleString() + " read";
          emit();
          const classified = await classifyRows(fresh, sessionCtx, { batchIds, sets: state.sets });
          if (stale(token)) return;
          if (classified.versionsRefused) state.versionsRefused = true;
          classified.rows.forEach((shownRow, index) => {
            const source = fresh[index];
            if (source.duplicate) shownRow.notes.push("captured twice in this set");
            if (!source.asRetrieved) {
              const key = source.setId + "\u0000" + source.name;
              if (!state.attachedRows.has(key)) state.attachedRows.set(key, []);
              state.attachedRows.get(key).push(shownRow);
            }
            state.rows.push(shownRow);
          });
          room -= fresh.length;
        }
        emit();
      }
      /* A count with no readable rows, or rows the count says are not there:
       * either way the membership read is not to be trusted as a clean list. */
      state.lists.forEach((list) => {
        if (!list.done) return;
        const total = listTotal(list);
        if (list.suspect) state.countsDisagree = true;
        else if (total != null && total > 0 && list.yielded === 0) state.membershipUnreadable = true;
        else if (total === 0 && list.yielded > 0) state.countsDisagree = true;
        /* Fewer rows than the count: a page that came back short (rows an
         * ACL removed, say) ended its chunk early, so some were never read. */
        else if (total != null && total > list.yielded) state.countsDisagree = true;
      });
      state.busy = false;
      state.phase = "done";
      state.progress = "";
      emit();
    }

    function setIncludeChildren(on) {
      if (!state.batch || Boolean(on) === state.includeChildren) return;
      state.includeChildren = Boolean(on);
      start();
    }

    function totals() {
      const lists = state.lists;
      if (!lists.length) return { checked: state.rows.length, total: null, exact: false };
      const done = lists.every((list) => list.done);
      if (done) return { checked: state.rows.length, total: state.rows.length, exact: true };
      const parts = lists.map(listTotal);
      const total = parts.some((part) => part == null) ? null : parts.reduce((sum, part) => sum + part, 0);
      return { checked: state.rows.length, total, exact: false };
    }

    function banners() {
      const out = [];
      const set = state.subject;
      if (!set) return out;
      const origin = ctx.origin;
      if (state.viaRetrieved) {
        const links = opts.pageSysId === state.viaRetrieved.sysId ? [] : [{
          label: "Open retrieved set",
          url: origin + "/sys_remote_update_set.do?sys_id=" + state.viaRetrieved.sysId,
        }];
        out.push({ kind: "info", text: "Retrieved set, showing its local copy.", links });
      }
      if (state.provenance) {
        const remote = state.provenance;
        const from = remote.updateSource ? "update source " + remote.updateSource : "a loaded XML file";
        const when = remote.commitDate ? " on " + remote.commitDate : "";
        const links = opts.pageSysId === remote.sysId || (state.viaRetrieved && state.viaRetrieved.sysId === remote.sysId)
          ? [] : [{ label: "Open retrieved set", url: origin + "/sys_remote_update_set.do?sys_id=" + remote.sysId }];
        out.push({ kind: "info", text: "Committed here from a retrieved set (" + from + ")" + when + ".", links });
      }
      const onlyRetrieved = state.rows.filter((row) => row.asRetrieved).length;
      if (onlyRetrieved) {
        out.push({
          kind: "info",
          text: onlyRetrieved + (onlyRetrieved === 1 ? " update is" : " updates are") +
            " listed only under the retrieved set.",
          links: [],
        });
      }
      if (set.isDefault) {
        out.push({ kind: "warn", text: "Default sets aren't meant to be moved; this is a snapshot.", links: [] });
      }
      if (state.backedOut) {
        out.push({
          kind: "warn",
          text: "This set was backed out on this instance; its versions here are marked backed out.",
          links: [],
        });
      }
      if (set.mergedTo) {
        out.push({
          kind: "info",
          text: "This set was merged into “" + (set.mergedToName || "another set") + "”.",
          links: [{ label: "Open that set", url: origin + "/sys_update_set.do?sys_id=" + set.mergedTo }],
        });
      }
      if (state.versionsRefused) {
        out.push({
          kind: "warn",
          text: "Partial: can't check staleness. This account can't read version history here, so no row is shown as Current.",
          links: [],
        });
      }
      if (state.membershipUnreadable) {
        out.push({ kind: "warn", text: "Can't read this set's updates. The count says there are some, but none could be read.", links: [] });
      }
      if (state.countsDisagree) {
        out.push({ kind: "warn", text: "The update count and the updates read disagree; the list may be incomplete.", links: [] });
      }
      if (state.batch && state.batch.capped) {
        out.push({ kind: "warn", text: "This batch has more than 1,000 sets; only the first 1,000 are checked.", links: [] });
      }
      if (state.batch && state.batch.depthCapped) {
        out.push({ kind: "warn", text: "This batch is nested more than 6 levels deep; deeper sets aren't checked.", links: [] });
      }
      return out;
    }

    function view() {
      const set = state.subject;
      const childNames = new Map();
      state.scope.forEach((scopeSet) => childNames.set(scopeSet.sysId, scopeSet.name));
      const inBatch = state.includeChildren && state.scope.length > 1;
      return {
        phase: state.phase,
        busy: state.busy,
        error: state.error,
        progress: state.progress,
        retrieved: state.retrieved,
        subject: set ? {
          sysId: set.sysId,
          name: set.name,
          stateLabel: set.stateLabel,
          scope: set.scope,
          createdBy: set.createdBy,
          createdOn: set.createdOn,
          isDefault: set.isDefault,
          parentName: set.parent ? set.parentName || "another set" : "",
          ownTotal: state.ownTotal,
        } : null,
        banners: banners(),
        batch: state.batch ? {
          children: state.batch.children,
          included: state.includeChildren,
          setCount: state.includeChildren && state.batch.walked ? state.batch.setCount : null,
        } : null,
        rows: state.rows.map((row) => Object.assign({}, row, {
          childSet: inBatch && row.setId !== (set && set.sysId) ? childNames.get(row.setId) || "" : "",
          notes: row.notes.slice(),
          flags: row.flags.slice(),
          links: row.links.slice(),
        })),
        totals: totals(),
        canContinue: state.phase === "done" && state.lists.some((list) => !list.done) && !state.membershipUnreadable,
      };
    }

    return {
      prepare,
      start,
      continue: continueRun,
      setIncludeChildren,
      view,
      onChange: (fn) => { if (typeof fn === "function") listeners.push(fn); },
      cancel: () => { cancelled = true; },
      remoteRequest: () => remoteRequest(state),
      placeRemote: (reply, request, onRead) => placeRemote(state, sessionCtx, reply, request, onRead),
      get state() { return state; },
    };
  }

  /* ------------------------------------------------------------------ *
   * Check on another instance (§6): the request, and reading its reply
   * ------------------------------------------------------------------ */

  /* The panel filters before it sends: a row whose name, guid or hash fails
   * its pattern stays here, and its remote answer is Can't tell. One odd row
   * never sinks the whole check. Guid and hash travel as the exact strings
   * read. */
  function remoteRequest(state) {
    const setIds = state.scope.length ? state.scope.map((set) => set.sysId) : (state.subject ? [state.subject.sysId] : []);
    const records = [];
    const keys = [];
    const filtered = [];
    state.rows.forEach((row) => {
      if (records.length >= LIMITS.remoteRecords) return;
      if (REMOTE_NAME.test(row.name) && REMOTE_GUID.test(row.guid) && REMOTE_HASH.test(row.hash)) {
        records.push({ name: row.name, guid: row.guid, hash: row.hash });
        keys.push(row.key);
      } else {
        filtered.push(row.key);
      }
    });
    return {
      setIds: setIds.slice(0, LIMITS.remoteSets),
      records,
      keys,
      filtered,
      unsent: Math.max(0, state.rows.length - records.length - filtered.length),
      /* Updates still to check here, or a membership read that may have
       * missed some (a batch past its set or depth limit, a list that
       * couldn't be trusted, counts that disagree): a match is then only a
       * match so far. */
      partial: state.lists.some((list) => !list.done) || state.countsDisagree || state.membershipUnreadable ||
        Boolean(state.includeChildren && state.batch && (state.batch.capped || state.batch.depthCapped)),
    };
  }

  /* ------------------------------------------------------------------ *
   * Placing what runs there in this update's own history
   * ------------------------------------------------------------------ */

  /* update_guid_history as entries, newest first; null when any entry is
   * malformed, so an odd history never yields a placing. */
  function parseLineage(text) {
    const out = [];
    for (const part of str(text).split(",")) {
      const value = part.trim();
      if (!value) continue;
      const match = LINEAGE_ENTRY.exec(value);
      if (!match) return null;
      out.push({ guid: match[1], hash: match[2] });
    }
    return out;
  }

  /* sys_recorded_at is hexadecimal and grows with time: a longer value is
   * later, and equal lengths compare as text. */
  function recordedBefore(left, right) {
    return left.length !== right.length ? left.length < right.length : left < right;
  }

  function normalizeLineageVersion(row) {
    return {
      name: raw(row, "name"),
      state: raw(row, "state").toLowerCase(),
      source: raw(row, "source").toLowerCase(),
      sourceTable: raw(row, "source_table"),
      guid: raw(row, "update_guid"),
      hash: raw(row, "payload_hash"),
      recordedAt: raw(row, "sys_recorded_at").toLowerCase(),
    };
  }

  /*
   * Where the version that runs on the other instance sits in this update's
   * own history: `history` is its update_guid_history, `versions` every
   * version of its name here, `ownSets` this set (or the whole batch).
   * Entry 0 is this capture; the entries after it that are saves in
   * `ownSets` are its own; the next one is the version it was built on.
   *
   *   built    there runs the version this set was built on, or its content
   *   earlier  there runs an earlier save of this set (or batch)
   *   behind   there runs an older version, further back in this history;
   *            `since` holds the versions here between the two
   *   diverged there runs a version this history doesn't hold
   *
   * null when the history can't be trusted. It is trusted only when the
   * version it names as the parent is also the newest version that ran here
   * before this set's first save, by sys_recorded_at (or when it names none
   * and no version ran here before). Measured on 419 updates in 25 sets, the
   * two agreed for 68 of the 73 with a parent; another set saving the record
   * between this set's saves, and a parent with no version here, made the
   * other five, and each is left unplaced rather than guessed.
   *
   * One placing needs no parent: what runs there is one of this set's own
   * saves, guid and hash, with only its own saves between. In a batch that
   * is the newest update of a record finding there an older update of the
   * batch; on a test instance's release batches, 12 of the 16 such rows
   * had a parent the check above refused.
   *
   * This capture's own entry must carry its hash (the same instance, so the
   * same writing). What runs there is matched by guid alone: the same
   * version is often written differently on another instance.
   * A version recorded here since this set began that the history doesn't
   * name is diverged, never matched by content to an older entry (Fable's
   * second review: a later revert to the parent's content read as built).
   *
   * A history is the order changes were committed on this instance, not the
   * order they were written: a set committed here after a newer one names
   * that newer version as its parent (seen on a test instance's release
   * batches, 6 of 9 placings there). So remoteView shows built and earlier,
   * the placings that read as safe, only when the other instance says this
   * update's own version was never there.
   */
  function placeThere(row, there, history, versions, ownSets) {
    if (!history || !history.length || history[0].guid !== row.guid || history[0].hash !== str(row.hash)) return null;
    if (!versions.length || versions.some((version) => !version.recordedAt || !version.guid)) return null;
    const ownGuids = new Set(versions
      .filter((version) => version.sourceTable === "sys_update_set" && ownSets.has(version.source))
      .map((version) => version.guid));
    ownGuids.add(row.guid);
    const mine = versions.filter((version) => ownGuids.has(version.guid));
    if (!mine.length) return null;
    const firstOwn = mine.reduce((first, version) =>
      (!first || recordedBefore(version.recordedAt, first) ? version.recordedAt : first), "");
    let at = 1;
    while (at < history.length && ownGuids.has(history[at].guid)) at += 1;
    /* What runs there is one of this set's own saves, exactly: only its own
     * saves lie between, so it is placed without the parent, whatever came
     * before them. */
    if (history.some((entry, index) => index > 0 && index < at && entry.guid === there.guid && entry.hash === there.hash)) {
      return { kind: "earlier", byContent: false };
    }
    const parent = at < history.length ? history[at] : null;
    const before = versions.filter((version) =>
      !ownGuids.has(version.guid) && LOADED_STATES.has(version.state) && recordedBefore(version.recordedAt, firstOwn));
    const newest = before.reduce((best, version) =>
      (!best || recordedBefore(best.recordedAt, version.recordedAt) ? version : best), null);
    /* Two versions recorded at the same moment can't be ordered. */
    if (newest && before.some((version) => version !== newest && version.recordedAt === newest.recordedAt)) return null;
    if (parent ? !newest || newest.guid !== parent.guid : newest) return null;

    /* By guid, whatever its hash: across instances a version's guid is its
     * identity and its hash is not. Measured from a development instance to
     * its sandbox, 28 rows ran a guid of this history with another hash; the
     * sandbox's own history agreed it ran that version, and the payloads
     * differed in how they were written (a currency attribute, the order of
     * related records), not in what they set. */
    let found = history.findIndex((entry, index) => index > 0 && entry.guid === there.guid);
    let byContent = false;
    if (found < 0) {
      /* A version saved here after this set began, that this history
       * doesn't name, is a later change (a revert to the parent's content,
       * say): matching its content to an older entry would call undoing it
       * safe. */
      const later = versions.some((version) => version.guid === there.guid && !recordedBefore(version.recordedAt, firstOwn));
      if (later) return { kind: "diverged" };
      found = history.findIndex((entry, index) => index > 0 && entry.hash === there.hash);
      byContent = found >= 0;
    }
    if (found < 0) return { kind: "diverged" };
    if (found < at) return { kind: "earlier", byContent };
    if (found === at || history[found].hash === parent.hash) return { kind: "built", byContent: byContent || found !== at };
    const since = history.slice(at, found)
      .map((entry) => versions.find((version) => version.guid === entry.guid))
      .filter(Boolean);
    return { kind: "behind", byContent, since };
  }

  /* Where a set or other source is named in a placing's note: a set by its
   * name in quotes, anything else in words. */
  function sinceSource(version, sets) {
    if (version.sourceTable === "sys_update_set") {
      const set = sets.get(version.source) || null;
      return set && set.name ? "“" + set.name + "”" : setLabel(set, version.source);
    }
    if (version.sourceTable === "sys_upgrade_history") return "an upgrade";
    if (version.sourceTable === "sys_store_app") return "an application install";
    return version.sourceTable || "another source";
  }

  /*
   * After a check on another instance: each row answered "other", with the
   * version that runs there, placed in that update's own history. Reads here
   * only: the rows' update_guid_history by sys_id, every version of their
   * names, and the names of the sets between. Never by guid or hash.
   * Returns a Map of row key to placing; a row left out keeps "runs another
   * version". `onRead` is called once, before the first read.
   */
  async function placeRemote(state, ctx, reply, request, onRead) {
    const placed = new Map();
    const content = Array.isArray(reply && reply.content) ? reply.content : [];
    const running = Array.isArray(reply && reply.running) ? reply.running : [];
    const moved = Array.isArray(reply && reply.moved) ? reply.moved : [];
    const rowsByKey = new Map(state.rows.map((row) => [row.key, row]));
    const targets = [];
    (request.keys || []).forEach((key, index) => {
      /* Nothing to place for a row whose own version was there and has
       * since been replaced (it is told so whatever its history says), or
       * for one a newer update of this batch replaces (that update is what
       * promoting leaves, and it is answered for itself). */
      const row = rowsByKey.get(key);
      const match = content[index] === "other" && moved[index] !== true && row && row.verdict !== "batch"
        ? LINEAGE_ENTRY.exec(str(running[index])) : null;
      if (!match || !row || !isSysId(row.sysId) || !REMOTE_GUID.test(row.guid)) return;
      if (nameQueryKind(row.name) === "unsafe") return;
      targets.push({ key, row, there: { guid: match[1], hash: match[2] } });
    });
    if (!targets.length) return placed;
    if (typeof onRead === "function") onRead();

    const histories = new Map();
    const ids = Array.from(new Set(targets.map((target) => target.row.sysId)));
    await drain(chunk(ids, LIMITS.lineageRowsPerRead), LIMITS.concurrency, async (group) => {
      let answer;
      try {
        answer = await readTable(ctx, "sys_update_xml", inClause("sys_id", group), LINEAGE_XML_FIELDS,
          group.length + 1, { displayAll: false });
      } catch (error) {
        return;
      }
      answer.rows.forEach((row) => {
        const sysId = raw(row, "sys_id").toLowerCase();
        if (!group.includes(sysId)) return;
        histories.set(sysId, { guid: raw(row, "update_guid"), history: parseLineage(raw(row, "update_guid_history")) });
      });
    });
    if (ctx.shouldStop && ctx.shouldStop()) return placed;

    const names = Array.from(new Set(targets.map((target) => target.row.name)));
    const read = await readByNames(
      ctx, "sys_update_version", names, (name) => name, nameCondition, LINEAGE_VERSION_FIELDS,
      (count) => count * LIMITS.lineageVersionsPerName, LIMITS.lineageNamesPerRead, { displayAll: false }
    );
    if (ctx.shouldStop && ctx.shouldStop()) return placed;
    const byName = new Map();
    read.rows.map(normalizeLineageVersion).forEach((version) => {
      /* Checked in code: the exact name. */
      if (!names.includes(version.name)) return;
      if (!byName.has(version.name)) byName.set(version.name, []);
      byName.get(version.name).push(version);
    });

    const batchIds = state.includeChildren && state.scope.length > 1
      ? new Set(state.scope.map((set) => set.sysId)) : null;
    const unknownSets = new Set();
    targets.forEach((target) => {
      const { row } = target;
      const xml = histories.get(row.sysId);
      if (!xml || xml.guid !== row.guid) return;
      if (read.failed.has(row.name) || read.saturated.has(row.name)) return;
      const place = placeThere(row, target.there, xml.history, byName.get(row.name) || [],
        batchIds || new Set([row.setId]));
      if (!place) return;
      if (batchIds) place.batch = true;
      if (place.since) {
        place.since.forEach((version) => {
          if (version.sourceTable === "sys_update_set" && isSysId(version.source) && !state.sets.has(version.source)) {
            unknownSets.add(version.source);
          }
        });
      }
      placed.set(target.key, place);
    });
    if (unknownSets.size) {
      const sets = await readSetsById(Array.from(unknownSets), ctx);
      sets.found.forEach((set, sysId) => state.sets.set(sysId, set));
    }
    placed.forEach((place) => {
      if (!place.since) return;
      const names = [];
      place.since.forEach((version) => {
        const label = sinceSource(version, state.sets);
        if (!names.includes(label)) names.push(label);
      });
      place.since = { count: place.since.length, sources: names };
    });
    return placed;
  }

  const PRESENCE_RANK = {
    committed: 7,
    committing: 6,
    partial: 6,
    previewed: 5,
    previewed_in_hierarchy: 5,
    previewing: 4,
    loaded: 3,
    in_hierarchy: 3,
    loading: 3,
    backedout: 2,
    backedout_in_hierarchy: 2,
  };

  function presenceWords(copy) {
    const state = copy.state;
    if (state === "committed") {
      return "Committed" + (copy.committedOn ? " on " + copy.committedOn : "") +
        (copy.localStateLabel ? " (its local set is " + copy.localStateLabel.toLowerCase() + ")" : "") +
        (copy.linked === false ? ", but its local set doesn't point back" : "");
    }
    if (PREVIEWED_STATES.has(state)) {
      const details = [];
      if (copy.retrievedOn) details.push("retrieved " + copy.retrievedOn);
      if (copy.collisions) details.push(copy.collisions + " collisions");
      return "Previewed, not committed" + (details.length ? " (" + details.join(", ") + ")" : "");
    }
    if (state === "loaded" || state === "in_hierarchy" || state === "loading") return "Retrieved, not previewed";
    if (BACKED_OUT_STATES.has(state)) return "Backed out";
    return copy.stateLabel || state || "Unknown state";
  }

  /* "Committed on…" as the second half of "<instance>: committed on…". A
   * choice label from the instance keeps its own capitals past the first. */
  function lowerFirst(text) {
    const value = str(text);
    return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
  }

  /* ", saved there <when> in <set>": why a row differs there. Empty when the
   * other instance sent no note for it. */
  function savedWords(note) {
    if (!note || typeof note !== "object") return "";
    const on = str(note.on);
    const set = str(note.set);
    const from = str(note.from);
    if (!on && !set && !from) return "";
    return ", saved there" + (on ? " " + on : "") + (set ? " in " + set : from ? " from " + from : "");
  }

  /* The most advanced copy, newest first among equals (the exporter lists
   * newest first). */
  function bestCopy(copies) {
    return copies.reduce((best, copy) =>
      (!best || (PRESENCE_RANK[copy.state] || 0) > (PRESENCE_RANK[best.state] || 0) ? copy : best), null);
  }

  /* A row's links on the other instance: its record and the version that runs
   * there, where that instance found them, and its version history unless no
   * current version is recorded there, which would open an empty list. Each
   * is an origin and ids, never a URL: the worker builds it. */
  function remoteLinks(found, record, origin, status) {
    const where = found && typeof found === "object" ? found : {};
    const out = [];
    if (TABLE_NAME.test(str(where.table)) && isSysId(where.record)) {
      out.push({ label: "Open record", remote: { origin, table: where.table, sysId: where.record } });
    }
    if (isSysId(where.version)) {
      out.push({ label: "Open version", remote: { origin, table: "sys_update_version", sysId: where.version } });
    }
    if (status !== "none" && record && REMOTE_NAME.test(str(record.name))) {
      out.push({ label: "Version history", remote: { origin, name: record.name } });
    }
    return out;
  }

  /* What an older version there is missing, for its row's note. */
  function sinceWords(since, instance) {
    const count = since && Number.isInteger(since.count) ? since.count : 0;
    const sources = since && Array.isArray(since.sources) ? since.sources.map(str).filter(Boolean) : [];
    let where = "";
    if (sources.length) {
      const named = sources.slice(0, 2);
      const more = sources.length - named.length;
      where = " in " + (more ? named.join(", ") + " and " + more + " more" : named.join(" and "));
    }
    const body = count <= 1
      ? "the change saved here" + where + "; promoting this set brings it too"
      : count + " changes saved here since," + where + "; promoting this set brings them too";
    return instance == null ? "Missing " + body : "Missing on " + instance + ": " + body;
  }

  /* ", saved there …" as a fact for the panel's card: when and in which set
   * (or from where), or null when the other instance sent no note. */
  function savedFact(note) {
    if (!note || typeof note !== "object") return null;
    const fact = { on: str(note.on), set: str(note.set), from: str(note.from) };
    return fact.on || fact.set || fact.from ? fact : null;
  }

  /*
   * The other instance's answer as text: presence lines and per-row notes.
   * `reply` is what the worker returned, already rebuilt from its allowlist;
   * `request` is what was sent; `rows` the rows on screen; `origin` the
   * instance checked, for the links on each row; `placed` what
   * session.placeRemote found, by row key, for rows that run another
   * version there.
   *
   * A row whose own version was there and has since been replaced (moved
   * true) says so, whatever its placing: promoting it again undoes a change
   * made there. Built and earlier, which read as safe, need moved false, the
   * other instance's word that this version was never there; without it the
   * row keeps "runs another version".
   *
   * A row a newer update of this batch replaces (verdict "batch") is never
   * placed: promoting leaves that newer update, not this one. When what runs
   * there is another update of this batch, exactly (guid and hash), the row
   * says so, in grey, and counts towards a match, whatever `moved` says;
   * otherwise moved true still says changed there since (that instance moved
   * off this version, or backed it out, to something outside the batch, and
   * promoting the batch undoes that too), and anything else keeps "runs
   * another version", the batch's newest update answering for the record. Measured on a test instance's release batches, 165 of
   * 273 rows the other instance had once run were such rows, running the
   * batch's own newer update there. The reverse, the newest update finding
   * an older update of the batch there, is placed as an earlier save when
   * its history names that update among the batch's own saves.
   */
  function remoteView(reply, request, rows, instance, origin, placed) {
    const lines = [];
    const perRow = {};
    const parts = {};
    const links = {};
    const counts = {
      runs: 0, same: 0, inBatch: 0, inBatchNewest: 0, built: 0, earlier: 0, behind: 0, diverged: 0, moved: 0, other: 0,
      otherStale: 0, none: 0, cant: 0,
    };
    const placing = placed && typeof placed.get === "function" ? placed : new Map();
    const verdictByKey = new Map(rows.map((row) => [row.key, row.verdict]));
    /* This view's updates by guid: across the whole batch when it is one. */
    const byGuid = new Map();
    rows.forEach((row) => {
      if (row && REMOTE_GUID.test(str(row.guid))) byGuid.set(row.guid, row);
    });
    const copies = Array.isArray(reply.copies) ? reply.copies : [];
    const clones = new Set(Array.isArray(reply.clones) ? reply.clones : []);
    const bySet = request.setIds.map(() => []);
    copies.forEach((copy) => { if (bySet[copy.set]) bySet[copy.set].push(copy); });

    if (reply.presenceFailure) {
      lines.push({ kind: "warn", text: presenceFailureText(reply.presenceFailure, instance, reply.sourceImpersonating) });
    } else if (request.setIds.length === 1) {
      const found = bySet[0];
      const remoteCopies = found.filter((copy) => copy.match === "remote");
      if (remoteCopies.length) {
        const best = bestCopy(remoteCopies);
        const others = remoteCopies.length - 1;
        lines.push({
          kind: "state",
          text: instance + ": " + lowerFirst(presenceWords(best)) + "." +
            (others ? " Also " + others + " other " + (others === 1 ? "copy" : "copies") + ": " +
              remoteCopies.filter((copy) => copy !== best).slice(0, 5).map((copy) => lowerFirst(presenceWords(copy))).join("; ") + "." : ""),
        });
      } else if (found.length) {
        const best = bestCopy(found);
        lines.push({
          kind: "state",
          text: "Arrived on " + instance + " through another instance; it names this set as its origin. " +
            presenceWords(best) + ".",
        });
      } else if (clones.has(0)) {
        lines.push({
          kind: "state",
          text: "This set's id exists on " + instance + " because the instance was copied, not because the set was moved.",
        });
      } else {
        lines.push({
          kind: "state",
          text: "Not found on " + instance + ", or not visible to your account there: no retrieved copy with this set's id.",
        });
      }
    } else {
      const tally = new Map();
      let notFound = 0;
      let viaOrigin = 0;
      let cloned = 0;
      bySet.forEach((found, index) => {
        const remoteCopies = found.filter((copy) => copy.match === "remote");
        if (remoteCopies.length) {
          const word = presenceWords(Object.assign({}, bestCopy(remoteCopies), {
            committedOn: "", retrievedOn: "", collisions: "", localStateLabel: "", linked: undefined,
          }));
          tally.set(word, (tally.get(word) || 0) + 1);
        } else if (found.length) viaOrigin += 1;
        else if (clones.has(index)) cloned += 1;
        else notFound += 1;
      });
      const parts = Array.from(tally.entries()).map(([word, count]) => word.toLowerCase() + " " + count);
      if (viaOrigin) parts.push("arrived through another instance " + viaOrigin);
      if (cloned) parts.push("same id only because the instance was copied " + cloned);
      if (notFound) parts.push("not found or not visible " + notFound);
      const base = bySet[0].filter((copy) => copy.match === "remote");
      lines.push({
        kind: "state",
        text: "Base and " + (request.setIds.length - 1) + " child sets on " + instance + ": " + parts.join(", ") + "." +
          (base.length ? " The base: " + presenceWords(bestCopy(base)).toLowerCase() + "." : ""),
      });
    }

    if (!Array.isArray(reply.content)) {
      /* Nothing was compared: one line says why, and no row is marked. */
      if (reply.contentFailure) {
        lines.push({ kind: "warn", text: contentFailureText(reply.contentFailure, instance, reply.sourceImpersonating) });
      }
      return { lines, perRow, parts, counts: null, links };
    }
    const content = reply.content;
    const saved = Array.isArray(reply.saved) ? reply.saved : [];
    const found = Array.isArray(reply.found) ? reply.found : [];
    const moved = Array.isArray(reply.moved) ? reply.moved : [];
    const running = Array.isArray(reply.running) ? reply.running : [];
    const sent = Array.isArray(request.records) ? request.records : [];
    /* What runs there is another update of this view, exactly: the same
     * record, guid and hash. */
    const siblingThere = (key, index) => {
      const there = LINEAGE_ENTRY.exec(str(running[index]));
      const sibling = there ? byGuid.get(there[1]) : null;
      return sibling && sibling.key !== key && str(sibling.hash) === there[2] &&
        sent[index] && sibling.name === sent[index].name ? sibling : null;
    };
    /* One answer, said twice from the same pieces: as the row's sentence
     * (perRow) and in parts for the panel's card, where the instance is the
     * card's heading. `then` is what promoting would do; `thenHere`, when
     * given, is how the sentence says it. */
    const answer = (key, kind, words, options) => {
      const o = options || {};
      perRow[key] = {
        kind,
        text: "On " + instance + ": " + lowerFirst(words) + (o.already ? " (already stale here)" : "") + savedWords(o.note) +
          (o.matched ? " (matched by content)" : "") + (o.then ? ". " + (o.thenHere || o.then) : ""),
      };
      parts[key] = {
        kind,
        say: words,
        notes: [o.already ? "already stale here" : "", o.matched ? "matched by content" : ""].filter(Boolean),
        saved: savedFact(o.note),
        then: o.then || "",
      };
    };
    request.keys.forEach((key, index) => {
      const status = content[index] || "unknown";
      if (origin) links[key] = remoteLinks(found[index], sent[index], origin, status);
      if (status === "runs") {
        counts.runs += 1;
        parts[key] = { kind: "runs", say: "Runs this set's version", notes: [], saved: null, then: "" };
        return;
      }
      const note = saved[index];
      if (status === "same") {
        counts.same += 1;
        answer(key, "same", "Same content under another update", { note });
      } else if (status === "other") {
        const already = verdictByKey.get(key) === "stale";
        const place = placing.get(key) || null;
        const matched = Boolean(place && place.byContent);
        const neverThere = moved[index] === false;
        const replacedInBatch = verdictByKey.get(key) === "batch";
        const sibling = replacedInBatch ? siblingThere(key, index) : null;
        if (sibling) {
          /* Its newest in this batch when nothing in the batch replaces it
           * and its own reading is sure. */
          const newest = sibling.verdict !== "batch" && sibling.verdict !== "cant";
          counts.inBatch += 1;
          if (newest) counts.inBatchNewest += 1;
          answer(key, "inbatch", "Runs " + (newest ? "this batch's newest update of it" : "another update of this batch"), { note });
        } else if (replacedInBatch && moved[index] !== true) {
          counts.other += 1;
          answer(key, "other", "Runs another version", { note });
        } else if (moved[index] === true) {
          /* Including a row its batch replaces, when what runs there now is
           * no update of this batch: that instance had this row's version and
           * moved off it (or backed it out), and promoting the batch undoes
           * that too. */
          counts.moved += 1;
          answer(key, "moved", "Had this set's version, and it has since been changed",
            { note, already, then: "Promoting this set again undoes that change" });
        } else if (place && place.kind === "built" && neverThere) {
          counts.built += 1;
          answer(key, "built", "Runs the version this set was built on", { note, already, matched });
        } else if (place && place.kind === "earlier" && neverThere) {
          counts.earlier += 1;
          answer(key, "earlier", "Runs an earlier save of this " + (place.batch ? "batch" : "set"), { note, already, matched });
        } else if (place && place.kind === "behind") {
          counts.behind += 1;
          answer(key, "behind", "Runs an older version of this update", {
            note, already, matched, then: sinceWords(place.since), thenHere: sinceWords(place.since, instance),
          });
        } else if (place && place.kind === "diverged") {
          counts.diverged += 1;
          answer(key, "diverged", "Runs a version that isn't in this update's history",
            { note, already, then: "Promoting this set replaces it" });
        } else {
          counts.other += 1;
          if (already) counts.otherStale += 1;
          answer(key, "other", "Runs another version", { note, already });
        }
      } else if (status === "none") {
        counts.none += 1;
        answer(key, "none", "No readable current version");
      } else {
        counts.cant += 1;
        answer(key, "cant", "Can't tell");
      }
    });
    request.filtered.forEach((key) => {
      counts.cant += 1;
      answer(key, "cant", "Can't tell");
    });
    /* Rows past what a check sends: in parts only, so the panel can mark
     * them, rather than leave them looking like rows that match there. */
    const asked = new Set(request.keys.concat(request.filtered));
    rows.forEach((row) => {
      if (!row || row.key == null || asked.has(row.key)) return;
      parts[row.key] = {
        kind: "unsent", say: "Not compared", notes: [], saved: null,
        then: "Check on compares the first " + LIMITS.remoteRecords.toLocaleString() + " updates checked here",
      };
    });
    const compared = request.keys.length + request.filtered.length;
    if (compared && counts.runs === compared) {
      /* Every record compared runs this set's version there: said as a
       * match, and as a match so far while some were not compared. */
      const all = compared === 1 ? "its one record" : "all " + compared.toLocaleString() + " records";
      lines.push({
        kind: "ok",
        text: request.unsent || request.partial
          ? instance + " matches so far: it runs this set's version for " + all + " compared."
          : instance + " matches: it runs this set's version for " + all + ".",
      });
    } else if (compared && counts.runs + counts.inBatchNewest === compared) {
      /* The rest run the newest update of their record in this batch, which
       * is what promoting it leaves. */
      lines.push({
        kind: "ok",
        text: request.unsent || request.partial
          ? instance + " matches so far: every record compared runs this batch's newest update of it."
          : instance + " matches: every record runs this batch's newest update of it.",
      });
    } else if (compared) {
      const one = (count, single, plural) => count + " " + (count === 1 ? single : plural);
      const bits = [
        instance + " runs this set's version for " + counts.runs + " of " + one(compared, "record", "records"),
      ];
      if (counts.same) bits.push(one(counts.same, "has", "have") + " the same content under another update");
      if (counts.inBatch) bits.push(one(counts.inBatch, "runs", "run") + " another update of this batch");
      if (counts.built) bits.push(one(counts.built, "runs", "run") + " the version this set was built on");
      if (counts.earlier) {
        bits.push(one(counts.earlier, "runs", "run") + " an earlier save of this " + (request.setIds.length > 1 ? "batch" : "set"));
      }
      if (counts.behind) bits.push(one(counts.behind, "runs", "run") + " an older version, missing changes saved here since");
      if (counts.diverged) bits.push(one(counts.diverged, "runs", "run") + " a version that isn't in its update's history");
      if (counts.moved) bits.push(counts.moved + " had this set's version and changed it since");
      if (counts.other) {
        const stale = !counts.otherStale ? ""
          : counts.other === 1 ? " (already stale here)"
            : " (" + (counts.otherStale === counts.other ? "all " : "") + counts.otherStale + " already stale here)";
        bits.push(one(counts.other, "runs", "run") + " another version" + stale);
      }
      if (counts.none) bits.push(one(counts.none, "has", "have") + " no readable current version there");
      if (counts.cant) bits.push(counts.cant + " can't tell");
      /* Every record there runs this set's version, its content, or a
       * version this set was built on: promoting it overwrites nothing made
       * there. Said only when the history placed at least one, and "so far"
       * while some updates weren't compared. */
      const built = counts.built + counts.earlier;
      if (built && counts.runs + counts.same + counts.inBatch + built === compared) {
        lines.push({
          kind: "ok",
          text: request.unsent || request.partial
            ? "So far, promoting this set replaces nothing changed on " + instance +
              ": every record compared runs this set's version or one it was built on."
            : "Promoting this set replaces nothing changed on " + instance +
              ": every record there runs this set's version or one it was built on.",
        });
      }
      /* Same content there is told, not flagged: the content matches. */
      const differs = counts.other || counts.behind || counts.diverged || counts.moved || counts.none || counts.cant;
      lines.push({ kind: differs ? "differs" : "content", text: bits.join("; ") + "." });
    }
    if (request.unsent) {
      lines.push({
        kind: "note",
        text: "Compared the first " + LIMITS.remoteRecords.toLocaleString() + " checked updates there.",
      });
    }
    return { lines, perRow, parts, counts, links };
  }

  function impersonatingNote(flag) {
    return flag ? " You're impersonating someone there: stop that in its tab, then try again." : "";
  }

  function presenceFailureText(failure, instance, impersonating) {
    if (failure.code === "refused") {
      return "That instance's session can't read update sets." + impersonatingNote(impersonating);
    }
    return "Couldn't read retrieved sets on " + instance + (failure.message ? ": " + failure.message : "") + ".";
  }

  function contentFailureText(failure, instance, impersonating) {
    if (failure.code === "refused") {
      return "That instance's session can't read version history, so what runs there wasn't compared." +
        impersonatingNote(impersonating);
    }
    return "Couldn't compare versions on " + instance + (failure.message ? ": " + failure.message : "") + ".";
  }

  /* Why a check could not run at all, by the worker's code. */
  function remoteProblem(reply, instance, host) {
    const code = reply && reply.code;
    if (code === "not-open") return (host || instance) + " isn't open in this browser. Open it in a tab, sign in, then try again.";
    if (code === "asleep") return "Your " + instance + " tab is asleep. Click it once, then try again.";
    if (code === "no-receiver") return "GlideLens isn't running in your " + instance + " tab yet. Reload that tab, then try again.";
    if (code === "signed-out") return "You're not signed in to " + instance + ". Sign in there, then try again.";
    if (code === "switching") return "Prefill is switching your session on " + instance + " in another tab. Wait for it to finish.";
    if (code === "busy") return "A check is already running from this tab. Wait for it to finish.";
    if (code === "timeout") return "Reading from " + instance + " timed out; the answer may be incomplete. Try again.";
    if (code === "source-changed") return "Your " + instance + " tab changed while GlideLens was reading it; the answer may be incomplete. Try again.";
    if (code === "refused") return "That instance's session can't read update sets." + impersonatingNote(reply.sourceImpersonating);
    if (code === "malformed") return "The answer from " + instance + " wasn't in the expected shape. Reload that tab, then try again.";
    if (code === "invalid") return "GlideLens couldn't send that check. Reopen Update Set Lens, then try again.";
    if (code === "read-error" && reply.message) return reply.message;
    return "Couldn't check " + instance + ". Try again.";
  }

  globalThis.SNUpdateSetLens = {
    LIMITS,
    REMOTE_NAME,
    REMOTE_GUID,
    REMOTE_HASH,
    VERDICT_ORDER,
    CANT_TELL,
    isListRoute,
    nameQueryKind,
    readUrlLength,
    chunkForUrl,
    normalizeSet,
    normalizeRetrieved,
    resolveUpdateSetInput,
    pageUpdateSet,
    firstPass,
    appliedGuard,
    classifyRows,
    recordUrl,
    walkBatch,
    createSession,
    remoteRequest,
    parseLineage,
    placeThere,
    remoteView,
    remoteProblem,
    retrievedScreen,
    /* Shared with Version Lens (version_lens.js), which reads through the
     * same route and words its verdicts the same way. Names unchanged. */
    TABLE_NAME,
    NAMED_RECORD,
    SET_FIELDS,
    MEMBER_FIELDS,
    VERSION_FIELDS,
    readTable,
    raw,
    shown,
    isSysId,
    foldName,
    decodedVariants,
    inClause,
    linkIn,
    normalizeVersion,
    normalizeMember,
    readCurrentVersions,
    readSetsById,
    staleText,
    lowerFirst,
    presenceWords,
    savedWords,
    bestCopy,
    remoteLinks,
    presenceFailureText,
    contentFailureText,
    /* Version Lens places the update that runs here with it, as a state of
     * one row: { rows, sets, includeChildren, scope }, where scope names the
     * set holding the update and, when it was moved, the set it was saved in. */
    placeRemote,
  };
})();

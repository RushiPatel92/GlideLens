/*
 * Version Lens engine. Isolated world and DOM-free, injected by
 * INJECT_VERSION_LENS after update_set_lens.js, whose reader, rule and
 * wording it reuses, and before its panel.
 *
 * For one configuration record it answers, on this instance: which update
 * sets captured it, who saved it there and when; whether two or more open
 * sets compete for it; and which version runs now. It reads sys_metadata,
 * sys_metadata_delete, sys_update_xml, sys_update_set and sys_update_version,
 * plus sys_dictionary or sys_choice to compose a name, all through Update Set
 * Lens's readTable and SN_UPDATE_SET_LENS_GET. It writes nothing.
 *
 * Rules that took measurement to find, with the reason each one exists:
 *
 *   - The record's identity is the name ServiceNow stored on it,
 *     sys_metadata.sys_update_name. Where that is blank (translations, some
 *     baseline rows) or the record is outside sys_metadata, a candidate name
 *     is used only once a capture or version with that exact name is read
 *     back. A name is never parsed to find a record: 47 of 320 parsed names
 *     named a table that does not exist.
 *   - Only open named sets compete: in progress and not Default. Counting
 *     Default sets would flag a quarter of all records; a complete set is
 *     history here, and only Check on can say whether it was promoted.
 *   - Two open sets holding the same content promote the same thing in
 *     either order, so they are not a collision. A blank fingerprint is never
 *     the same as anything.
 *   - The server already matched the name and category, so a returned capture
 *     whose name, category or both set references are blank is a field this
 *     account can't read. It is unplaced, never a loaded copy and never
 *     dropped: it may be in an open set.
 *   - Never `nameLIKE`, `nameENDSWITH` or `nameSTARTSWITH` on the update
 *     table: each is a table scan of about five seconds.
 *
 * Every verdict a blank, a refusal or a failed read touches is partial or
 * Can't tell. A denial must never read as a clean result.
 */
(() => {
  if (globalThis.SNVersionLens) return;
  const USL = globalThis.SNUpdateSetLens;
  /* Injected after update_set_lens.js. Without it there is nothing to read
   * with, and leaving the global unset lets the next injection try again. */
  if (!USL || typeof USL.readTable !== "function" || typeof USL.classifyRows !== "function") return;

  const {
    readTable, raw, shown, isSysId, foldName, decodedVariants, linkIn, isListRoute, nameQueryKind,
    normalizeSet, normalizeMember, readCurrentVersions, readSetsById, classifyRows, lowerFirst,
    presenceWords, savedWords, bestCopy, remoteLinks, presenceFailureText, contentFailureText,
    CANT_TELL, REMOTE_NAME, REMOTE_GUID, REMOTE_HASH, TABLE_NAME,
  } = USL;

  /* Keys join a sys_id and a counter with a character no sys_id holds. */
  const SEP = String.fromCharCode(0);

  /* setsPerRead is Update Set Lens's own: readSetsById chunks by it. */
  const LIMITS = Object.freeze({
    captures: 200,
    setsPerRead: USL.LIMITS.setsPerRead,
    remoteSets: 1000,
  });

  const METADATA_FIELDS = "sys_id,sys_class_name,sys_update_name,sys_name,sys_scope";
  /* Never payload (up to 4 MB a row), table (the configuration's target
   * table, not the record's) or update_guid_history (up to 22 KB a row). */
  const CAPTURE_FIELDS = [
    "sys_id", "name", "update_set", "remote_update_set", "action", "type", "target_name",
    "update_guid", "payload_hash", "application", "category", "sys_created_by", "sys_created_on",
    "sys_updated_by", "sys_updated_on",
  ].join(",");
  const COMPOSE_FIELDS = "sys_id,name,element";

  /* Rows captured with their parent, never on their own. The parent to open
   * is gate G2's to confirm; a wrong one only misdirects a sentence. */
  const LAYOUT_CHILDREN = {
    sys_ui_element: { parent: "sys_ui_section", words: "form section" },
    sys_ui_form_section: { parent: "sys_ui_form", words: "form" },
    sys_ui_list_element: { parent: "sys_ui_list", words: "list layout" },
    sys_ui_related_list_entry: { parent: "sys_ui_related_list", words: "related list layout" },
  };

  const SAVE_FIRST = "Save the record first. An unsaved record has no update history.";
  const SET_HINT = "This is an update set. Update Set Lens checks a whole set.";
  const UNSAFE_INPUT = "Use the record's link, sys_id or update name.";
  const NO_SUCH_ID = "No record, update or deleted record with that sys_id here, or you can't read it. " +
    "For a data record, paste its link: its table is in the link.";
  const BLANK_NAME = "It has no update name here, which usually means it hasn't been changed since it was installed.";
  const NOTHING_TO_CHECK = "Nothing here to look for there.";

  const GROUP_ORDER = ["open", "default", "complete", "ignore", "merged", "unreadable"];
  const STATE_BADGES = {
    open: "OPEN",
    default: "DEFAULT",
    complete: "COMPLETE",
    ignore: "IGNORE",
    merged: "MERGED",
    unreadable: "CAN'T READ",
  };
  const PREVIEWED = new Set(["previewed", "previewed_in_hierarchy"]);
  const RETRIEVED = new Set(["loaded", "in_hierarchy", "loading"]);
  const BACKED_OUT = new Set(["backedout", "backedout_in_hierarchy"]);

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  const str = (value) => (value == null ? "" : String(value));

  function errorMessage(error) {
    return str(error && error.message ? error.message : error);
  }

  function plural(count, one, many) {
    return Number(count).toLocaleString() + " " + (count === 1 ? one : many);
  }

  function unique(values) {
    return Array.from(new Set(values));
  }

  function rowById(answer, field, id) {
    return answer.rows.find((row) => raw(row, field).toLowerCase() === id) || null;
  }

  function refused(message) {
    return { kind: "refused", message };
  }

  function readFailure(error) {
    if (error && error.code === "access") {
      return {
        kind: "error",
        message: "This account can't read that record's update history here (HTTP " + (error.status || 403) + ").",
      };
    }
    return { kind: "error", message: "Couldn't read that record: " + errorMessage(error) };
  }

  /* An outcome decided while identifying the record: the panel opens on its
   * headline and reads nothing more. */
  function identity(headline, details) {
    return Object.assign({ kind: "identity", headline, record: null }, details || {});
  }

  function cantIdentify(reason, record) {
    return identity("H1", { reason, record: record || null });
  }

  function howWords(target) {
    const words = [];
    if (target.how === "deleted") words.push("deleted record");
    if (target.how === "choice" && target.choiceOf) {
      words.push("choices are captured per field: this is the list for " + target.choiceOf);
    }
    if (target.how === "data") words.push("captured as data");
    if (target.how === "update") words.push("from this update");
    if (target.how === "version") words.push("from this version");
    if (target.sharedWith) {
      words.push("shared with " + (target.sharedMore ? target.sharedWith + " or more other records" : plural(target.sharedWith, "other record", "other records")));
    }
    return words;
  }

  function makeTarget(fields) {
    const target = Object.assign({
      name: "",
      how: "record",
      cls: "",
      clsLabel: "",
      sysId: "",
      display: "",
      scope: "",
      blankName: false,
      sharedWith: 0,
      sharedMore: false,
      choiceOf: "",
    }, fields);
    target.howWords = howWords(target);
    return { kind: "target", target };
  }

  /* A name that came from the server: a row's own name, so it needs no
   * existence read, only the query-safety check every name gets. */
  function nameTarget(name, how, fields) {
    if (nameQueryKind(name) === "unsafe") {
      return cantIdentify("its update name can't be looked up safely.", fields || null);
    }
    return makeTarget(Object.assign({}, fields || {}, { name, how }));
  }

  /* ------------------------------------------------------------------ *
   * Pages and links
   * ------------------------------------------------------------------ */

  /* A top-frame nav_to.do URL names the table `nav_to`; the record's table
   * is in its decoded `uri=`. */
  function navToTarget(href) {
    for (const value of decodedVariants(href)) {
      const match = value.match(/[?&]uri=\/?([a-z][a-z0-9_]*)\.do(?:[?#&]|$)/i);
      if (match) return match[1].toLowerCase();
    }
    return "";
  }

  /* A new record, classic or Workspace, has no update history yet. */
  function isNewRecord(href) {
    return decodedVariants(href).some((value) =>
      /[?&]sys_id=-1(?:[&#]|$)/i.test(value) ||
      /\/now\/(?:[^/?#]+\/)*?record\/[^/?#]+\/-1(?:[/?#]|$)/i.test(value));
  }

  function tableHintFor(href, pageTable) {
    let table = str(pageTable).toLowerCase();
    if (!table || table === "nav_to") table = navToTarget(href) || "";
    return TABLE_NAME.test(table) && table !== "nav_to" ? table : "";
  }

  /* §2.2: what the page shows, or { kind: "none", hint } for the input row.
   * A list or a new record costs no read. */
  async function pageTarget(href, ctx) {
    if (isListRoute(href)) return { kind: "none", hint: "" };
    if (isNewRecord(href)) return { kind: "none", hint: SAVE_FIRST };
    let id = "";
    try {
      id = str(ctx.currentSysId ? await ctx.currentSysId() : "").toLowerCase();
    } catch (error) {
      return { kind: "none", hint: "" };
    }
    if (!isSysId(id)) return { kind: "none", hint: "" };
    const found = await targetFor(tableHintFor(href, ctx.pageTable), id, ctx);
    if (found.kind === "refused" || found.kind === "error") return { kind: "none", hint: found.message };
    return found;
  }

  /* The rows of §2.2 shared by a page and a pasted link. */
  async function targetFor(table, sysId, ctx) {
    if (table === "sys_update_set" || table === "sys_remote_update_set") return refused(SET_HINT);
    try {
      if (table === "sys_update_xml") return await fromUpdateRow(sysId, ctx);
      if (table === "sys_update_version") return await fromVersionRow(sysId, ctx);
      return await resolveRecord(sysId, table, ctx);
    } catch (error) {
      if (error && error.code === "stale") throw error;
      return readFailure(error);
    }
  }

  async function updateRow(sysId, ctx) {
    const answer = await readTable(ctx, "sys_update_xml", "sys_id=" + sysId, "sys_id,name,type,target_name", 1);
    const row = rowById(answer, "sys_id", sysId);
    return row && raw(row, "name") ? row : null;
  }

  async function versionRow(sysId, ctx) {
    const answer = await readTable(ctx, "sys_update_version", "sys_id=" + sysId, "sys_id,name", 1);
    const row = rowById(answer, "sys_id", sysId);
    return row && raw(row, "name") ? row : null;
  }

  function fromUpdate(row) {
    return nameTarget(raw(row, "name"), "update", { display: raw(row, "target_name"), clsLabel: shown(row, "type") });
  }

  async function fromUpdateRow(sysId, ctx) {
    const row = await updateRow(sysId, ctx);
    return row ? fromUpdate(row) : refused("No update with that sys_id here, or you can't read it.");
  }

  async function fromVersionRow(sysId, ctx) {
    const row = await versionRow(sysId, ctx);
    return row ? nameTarget(raw(row, "name"), "version", {}) : refused("No version with that sys_id here, or you can't read it.");
  }

  /* ------------------------------------------------------------------ *
   * Identity (§3.1)
   * ------------------------------------------------------------------ */

  /* §3.1 step 3: the name as the server stored it, or "" when neither a
   * capture nor a version has it. Names match ignoring case and trailing
   * spaces, as the server does, and the target then takes the server's
   * spelling: the version read compares names exactly. */
  async function existingName(candidate, ctx) {
    if (!candidate || nameQueryKind(candidate) === "unsafe") return "";
    const wanted = foldName(candidate);
    const pick = (answer) => answer.rows.map((row) => raw(row, "name")).find((name) => foldName(name) === wanted) || "";
    const captured = pick(await readTable(ctx, "sys_update_xml", "name=" + candidate + "^category=customer", "name", 1));
    if (captured) return captured;
    return pick(await readTable(ctx, "sys_update_version", "name=" + candidate, "name", 1));
  }

  /* A list layout's name can be shared by several rows (Fa-F9). A read by
   * sys_id returns one row, so this takes its own read, only for that class. */
  async function sharedCount(name, sysId, ctx) {
    try {
      const answer = await readTable(ctx, "sys_metadata", "sys_update_name=" + name, "sys_id,sys_update_name", 4);
      const same = answer.rows.filter((row) => foldName(raw(row, "sys_update_name")) === foldName(name));
      const others = same.filter((row) => raw(row, "sys_id").toLowerCase() !== sysId).length;
      return { others, more: answer.rows.length >= 4 };
    } catch (error) {
      if (error && error.code === "stale") throw error;
      return { others: 0, more: false };
    }
  }

  async function composedFrom(table, sysId, prefix, ctx) {
    const answer = await readTable(ctx, table, "sys_id=" + sysId, COMPOSE_FIELDS, 1);
    const row = rowById(answer, "sys_id", sysId);
    if (!row) return null;
    return { table: raw(row, "name"), element: raw(row, "element"), prefix };
  }

  async function fromMetadata(row, sysId, cls, ctx) {
    const name = raw(row, "sys_update_name");
    const record = {
      cls,
      sysId,
      display: shown(row, "sys_name"),
      scope: shown(row, "sys_scope"),
    };
    if (name) {
      if (nameQueryKind(name) === "unsafe") return cantIdentify("its update name can't be looked up safely.", record);
      const shared = cls === "sys_ui_list" ? await sharedCount(name, sysId, ctx) : { others: 0, more: false };
      return makeTarget(Object.assign({}, record, {
        name,
        how: cls === "sys_metadata_delete" ? "deleted" : "record",
        sharedWith: shared.others,
        sharedMore: shared.more,
      }));
    }
    /* A blank name (O-F10): a dictionary entry's composed name first, then
     * the class and sys_id. Each is used only once it is read back. */
    const candidates = [];
    if (cls === "sys_dictionary") {
      try {
        const parts = await composedFrom("sys_dictionary", sysId, "sys_dictionary", ctx);
        if (parts && TABLE_NAME.test(parts.table)) {
          candidates.push({ name: "sys_dictionary_" + parts.table + "_" + (parts.element || "null"), how: "composed-dictionary" });
        }
      } catch (error) {
        if (error && error.code === "stale") throw error;
      }
    }
    candidates.push({ name: cls + "_" + sysId, how: "class-sysid" });
    for (const candidate of candidates) {
      const found = await existingName(candidate.name, ctx);
      if (found) return makeTarget(Object.assign({}, record, { name: found, how: candidate.how, blankName: true }));
    }
    return identity("H4", { record, blankName: true });
  }

  /* §3.1 step 2: a record outside sys_metadata, or hidden from this account
   * (`metadataHidden`: the read was refused, or its class came back blank). */
  async function outsideMetadata(sysId, hint, ctx, metadataHidden) {
    if (!hint) {
      return cantIdentify(metadataHidden
        ? "this account can't read sys_metadata here, and the page doesn't say which table the record is in. " +
          "Paste the record's link, or its update name."
        : "GlideLens can't tell which table this record is in. Paste the record's link, or its update name.");
    }
    if (hint === "sys_choice") {
      const parts = await composedFrom("sys_choice", sysId, "sys_choice", ctx);
      const record = { cls: "sys_choice", sysId };
      if (!parts || !TABLE_NAME.test(parts.table) || !parts.element) {
        return cantIdentify("this choice can't be read here, so its list's update name can't be composed.", record);
      }
      const composed = "sys_choice_" + parts.table + "_" + parts.element;
      const found = await existingName(composed, ctx);
      if (found) {
        return makeTarget(Object.assign({}, record, { name: found, how: "choice", choiceOf: parts.table + "." + parts.element }));
      }
      return identity("H2", { reason: "choice", composed, record });
    }
    if (LAYOUT_CHILDREN[hint]) {
      return identity("H2", { reason: "layout", child: hint, parent: LAYOUT_CHILDREN[hint].parent, words: LAYOUT_CHILDREN[hint].words, record: { cls: hint, sysId } });
    }
    /* A URL can name a parent table (task.do for an incident); the update is
     * named after the concrete class. */
    let cls = hint;
    try {
      const answer = await readTable(ctx, hint, "sys_id=" + sysId, "sys_id,sys_class_name", 1, { displayAll: false });
      const row = rowById(answer, "sys_id", sysId);
      const own = raw(row, "sys_class_name");
      if (row && TABLE_NAME.test(own)) cls = own;
    } catch (error) {
      if (error && error.code === "stale") throw error;
    }
    const found = await existingName(cls + "_" + sysId, ctx);
    const record = { cls, sysId };
    /* With sys_metadata hidden this may well be a metadata record whose
     * stored name is something else, so neither "captured as data" nor
     * "not tracked" can be said: the refusal is worded as one (§16). */
    if (found) return makeTarget(Object.assign({}, record, { name: found, how: metadataHidden ? "class-sysid" : "data" }));
    if (metadataHidden) {
      return cantIdentify("this account can't read this record in sys_metadata here, and no update is named " +
        cls + "_" + sysId + ". Paste the record's update name.", record);
    }
    return identity("H2", { reason: "data", table: cls, record });
  }

  /* A bare sys_id that is no record here: an update's, a version's, or a
   * deleted record's, each a primary-key read checked in code (§2.3). */
  async function typedFallbacks(sysId, ctx) {
    const failures = [];
    const attempt = async (read) => {
      try {
        return await read();
      } catch (error) {
        if (error && error.code === "stale") throw error;
        failures.push(error);
        return null;
      }
    };
    const update = await attempt(() => updateRow(sysId, ctx));
    if (update) return fromUpdate(update);
    const version = await attempt(() => versionRow(sysId, ctx));
    if (version) return nameTarget(raw(version, "name"), "version", {});
    const deleted = await attempt(async () => {
      const answer = await readTable(ctx, "sys_metadata_delete", "sys_metadata=" + sysId, "sys_id,sys_metadata,sys_update_name", 2);
      return answer.rows.find((row) => raw(row, "sys_metadata").toLowerCase() === sysId && raw(row, "sys_update_name")) || null;
    });
    if (deleted) return nameTarget(raw(deleted, "sys_update_name"), "deleted", { sysId });
    if (failures.length) return readFailure(failures[0]);
    return null;
  }

  /*
   * resolveRecord(sysId, tableHint, ctx, { typed }) ->
   *   { kind: "target", target } | { kind: "identity", headline, … }
   *   | { kind: "refused" | "error", message }
   * The hint matters only for a record outside sys_metadata: a metadata
   * record's class comes from the read, and wins over a parent-table URL.
   */
  async function resolveRecord(sysId, tableHint, ctx, options) {
    const opts = options || {};
    const id = str(sysId).toLowerCase();
    const hint = TABLE_NAME.test(str(tableHint).toLowerCase()) ? str(tableHint).toLowerCase() : "";
    let row = null;
    let metadataRefused = false;
    try {
      const answer = await readTable(ctx, "sys_metadata", "sys_id=" + id, METADATA_FIELDS, 2);
      row = rowById(answer, "sys_id", id);
    } catch (error) {
      if (!error || error.code !== "access") throw error;
      metadataRefused = true;
    }
    if (row) {
      const cls = raw(row, "sys_class_name");
      if (TABLE_NAME.test(cls)) return fromMetadata(row, id, cls, ctx);
      /* A blank class is a field this account can't read: never a guess. */
      if (!hint) {
        return cantIdentify("this account can't read which table this record is in here. Paste the record's link, or its update name.",
          { sysId: id, display: shown(row, "sys_name") });
      }
    }
    if (opts.typed) {
      const other = await typedFallbacks(id, ctx);
      if (other) return other;
      if (!hint) return refused(NO_SUCH_ID);
    }
    /* A row here means its class came back blank: hidden, like a refusal. */
    return outsideMetadata(id, hint, ctx, metadataRefused || Boolean(row));
  }

  /* §2.3. Typed input always wins over the page. */
  async function resolveInput(input, ctx) {
    const text = str(input).trim();
    if (!text) return refused("Type a record's sys_id, link or update name.");
    if (/[\r\n]/.test(text)) return refused(UNSAFE_INPUT);
    /* A link is parsed before the caret check: a form link opened from a
     * list carries one in its record list, and only its table and sys_id
     * are ever taken from it. */
    const link = linkIn(text);
    if (link) return fromLink(link, ctx);
    if (text.includes("^") || /^javascript:/i.test(text)) return refused(UNSAFE_INPUT);
    try {
      if (isSysId(text.toLowerCase())) return await resolveRecord(text.toLowerCase(), "", ctx, { typed: true });
      if (REMOTE_NAME.test(text) && text.includes("_")) {
        const found = await existingName(text, ctx);
        if (!found) return refused("No update on this instance has that name, or you can't read it.");
        return nameTarget(found, "typed-name", {});
      }
    } catch (error) {
      if (error && error.code === "stale") throw error;
      return readFailure(error);
    }
    return refused("Type a sys_id, a link, or an update name such as sys_script_include_<sys_id>.");
  }

  async function fromLink(link, ctx) {
    if (link.refused) return refused("That link can't be read. Paste the record's own link, its sys_id or its update name.");
    const url = link.url;
    let here = "";
    try {
      here = new URL(ctx.origin).hostname;
    } catch (error) { /* no origin: every link is another instance's */ }
    if (url.hostname === here && (url.protocol !== "https:" || url.username || url.password)) {
      return refused("That link isn't this instance's https address. Paste the record's own link, its sys_id or its update name.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.origin !== ctx.origin) {
      return refused("This link is to " + url.hostname + ". Update history belongs to each instance; run Version Lens there.");
    }
    if (isListRoute(link.href)) return refused("That link opens a list. Open the record and paste its own link, or its sys_id.");
    if (isNewRecord(link.href)) return refused(SAVE_FIRST);
    const id = str(ctx.sysIdFromText ? ctx.sysIdFromText(link.href) : "").toLowerCase();
    if (!isSysId(id)) return refused("That link doesn't name a record. Paste the record's own link, its sys_id or its update name.");
    const context = (ctx.recordContextFromText && ctx.recordContextFromText(link.href)) || {};
    return targetFor(tableHintFor(link.href, context.table), id, ctx);
  }

  /* ------------------------------------------------------------------ *
   * Captures (§4.2 read 2, §6.7)
   * ------------------------------------------------------------------ */

  /* Each returned row is a capture in a local set, a copy loaded here from
   * another instance, or unplaced: a field this account can't read. A
   * genuine loaded copy always has remote_update_set (O-F8). A row naming
   * another record or category means a condition was ignored. */
  function placeRows(rows, name) {
    const wanted = foldName(name);
    const out = { captures: [], loaded: 0, unplaced: 0, dropped: 0 };
    rows.forEach((row) => {
      const rowName = raw(row, "name");
      const category = raw(row, "category");
      const local = raw(row, "update_set").toLowerCase();
      const remote = raw(row, "remote_update_set").toLowerCase();
      if (!rowName || !category || (!local && !remote)) {
        out.unplaced += 1;
        return;
      }
      if (foldName(rowName) !== wanted || category !== "customer") {
        out.dropped += 1;
        return;
      }
      if (isSysId(local)) out.captures.push(row);
      else if (!local && isSysId(remote)) out.loaded += 1;
      else out.unplaced += 1;
    });
    return out;
  }

  /* A capture as Update Set Lens's rule reads it, plus who saved it when.
   * `key` is its sys_id and a counter: classifyRows keys outcomes by it. */
  function normalizeCaptures(rows) {
    const seen = new Map();
    return rows.map((row) => {
      const setId = raw(row, "update_set").toLowerCase();
      const member = normalizeMember(row, setId, false);
      const count = seen.get(member.sysId) || 0;
      seen.set(member.sysId, count + 1);
      return Object.assign(member, {
        key: member.sysId + SEP + count,
        scope: shown(row, "application"),
        createdBy: raw(row, "sys_created_by"),
        createdOn: shown(row, "sys_created_on"),
        createdOnRaw: raw(row, "sys_created_on"),
        updatedBy: raw(row, "sys_updated_by"),
        updatedOn: shown(row, "sys_updated_on"),
        updatedOnRaw: raw(row, "sys_updated_on"),
      });
    });
  }

  /* The version read for this one name, folded as the server folds it. */
  function versionsFor(current, name) {
    const wanted = foldName(name);
    const list = [];
    let failure = null;
    let saturated = false;
    current.byName.forEach((versions, key) => { if (foldName(key) === wanted) versions.forEach((v) => list.push(v)); });
    current.failed.forEach((error, key) => { if (foldName(key) === wanted) failure = error; });
    current.saturated.forEach((key) => { if (foldName(key) === wanted) saturated = true; });
    return {
      list,
      failed: Boolean(failure),
      refused: Boolean(failure && failure.code === "access"),
      saturated,
    };
  }

  /* ------------------------------------------------------------------ *
   * The verdict (§5, §6), pure
   * ------------------------------------------------------------------ */

  function setGroup(set) {
    if (!set) return "unreadable";
    if (set.isDefault) return "default";
    /* A merged set still in progress can take captures the destination never
     * got, so it competes like any open set (S10). */
    if (set.state === "in progress") return "open";
    if (set.mergedTo) return "merged";
    if (set.state === "ignore") return "ignore";
    return "complete";
  }

  function setName(set) {
    return set ? set.name || "an unnamed update set" : "an update set you can't read";
  }

  function quoted(set) {
    return "“" + setName(set) + "”";
  }

  function dayOf(rawValue) {
    return str(rawValue).slice(0, 10);
  }

  function newestFirst(left, right) {
    return left.updatedOnRaw < right.updatedOnRaw ? 1 : left.updatedOnRaw > right.updatedOnRaw ? -1 : 0;
  }

  /* The current version, when exactly one is recorded and was read. */
  function oneCurrent(current) {
    if (!current || current.failed || current.saturated || current.list.length !== 1) return null;
    return current.list[0];
  }

  function runsHereLine(current, sets) {
    if (!current) return "";
    if (current.refused) return "";
    if (current.failed) return "Couldn't read which version runs here.";
    if (current.saturated || current.list.length > 1) return "More than one current version is recorded here.";
    if (!current.list.length) return "No current version of this record is recorded here.";
    const c = current.list[0];
    const by = ", version by " + (c.createdBy || "unknown") + " at " + (c.createdOn || "an unknown time") + ".";
    if (c.sourceTable === "sys_update_set") {
      const set = sets.get(c.source) || null;
      if (!set) return "Runs here: a version from an update set you can't read.";
      const about = [set.stateLabel || set.state];
      if (set.state === "complete" && set.completedOn) about.push("completed " + set.completedOn);
      if (set.remoteSysId) about.push("committed here from another instance");
      return "Runs here: the version from " + quoted(set) + " (" + about.filter(Boolean).join(", ") + ")" + by;
    }
    const when = c.createdOn ? " (" + c.createdOn + ")" : "";
    if (c.sourceTable === "sys_upgrade_history") return "Runs here: the version from an upgrade" + when + ".";
    if (c.sourceTable === "sys_store_app") return "Runs here: the version from an application install" + when + ".";
    return "Runs here: the version from " + (c.sourceTable || "another source") + when + ".";
  }

  function identityHeadline(outcome) {
    if (outcome.headline === "H1") {
      return { id: "H1", lead: "Can't identify this record safely:", rest: str(outcome.reason), mark: "warn", word: "Can't identify this record" };
    }
    if (outcome.headline === "H2") {
      return { id: "H2", lead: "Not tracked in update sets:", rest: "no update on this instance names this record.", mark: "", word: "Not tracked in update sets" };
    }
    return { id: "H4", lead: "No update on this instance captured this record.", rest: "", mark: "", word: "No update on this instance captured it" };
  }

  function identitySublines(outcome) {
    if (outcome.headline === "H4" && outcome.blankName) return [BLANK_NAME];
    if (outcome.headline !== "H2") return [];
    if (outcome.reason === "data") return [outcome.table + " records are captured only when someone adds them to a set."];
    if (outcome.reason === "layout") {
      return [outcome.child + " rows are captured with their " + outcome.words + " (" + outcome.parent + "). " +
        "Open the " + outcome.words + " and run Version Lens there."];
    }
    if (outcome.reason === "choice") {
      return ["No update on this instance is named " + outcome.composed + ", the name a field's choice list is captured under."];
    }
    return [];
  }

  function rowFor(capture, set, outcome, target, origin, duplicates) {
    const group = setGroup(set);
    const result = outcome || { verdict: "cant", reason: "versions-failed", text: "Can't tell: " + CANT_TELL["versions-failed"] + ".", notes: [] };
    const second = [];
    if (capture.createdBy && (capture.createdBy !== capture.updatedBy || dayOf(capture.createdOnRaw) !== dayOf(capture.updatedOnRaw))) {
      second.push("First captured by " + capture.createdBy + (capture.createdOn ? " on " + capture.createdOn : ""));
    }
    if (capture.scope && target.scope && capture.scope !== target.scope) second.push("scope " + capture.scope);
    if (set && set.state === "complete" && set.completedOn) second.push("completed " + set.completedOn);
    if (set && set.remoteSysId) second.push("committed here from another instance");
    const notes = [];
    if (set && set.parent) notes.push("in batch “" + (set.parentName || "another set") + "”");
    if (set && set.mergedTo) notes.push("merged into “" + (set.mergedToName || "another set") + "”");
    (result.notes || []).forEach((note) => notes.push(note));
    if (duplicates > 1) notes.push("captured " + duplicates + " times in this set");
    const links = [];
    if (isSysId(capture.sysId)) links.push({ label: "Open update", url: origin + "/sys_update_xml.do?sys_id=" + capture.sysId });
    if (isSysId(capture.setId)) links.push({ label: "Open set", url: origin + "/sys_update_set.do?sys_id=" + capture.setId });
    if (set) links.push({ label: "Check this set", set });
    const newer = result.verdict === "stale" && isSysId(result.newerSetId) && result.newerSetId !== capture.setId ? result.newerSetId : "";
    if (newer) links.push({ label: "Open newer set", url: origin + "/sys_update_set.do?sys_id=" + newer });
    return {
      key: capture.key,
      sysId: capture.sysId,
      name: capture.name,
      guid: capture.guid,
      hash: capture.hash,
      setId: capture.setId,
      setName: setName(set),
      stateLabel: set ? (set.isDefault ? "Default" : set.stateLabel || set.state) : "",
      group,
      stateBadge: STATE_BADGES[group],
      pinned: group === "open",
      verdict: result.verdict,
      reason: result.reason || "",
      text: result.text || "",
      action: capture.actionLabel,
      line1: "Last saved by " + (capture.updatedBy || "unknown") + (capture.updatedOn ? " on " + capture.updatedOn : ""),
      line2: second.join(" · "),
      /* The same two facts for the row's Last saved column. */
      savedOn: capture.updatedOn || "",
      savedBy: capture.updatedBy || "",
      notes,
      links,
      set: set || null,
      updatedOnRaw: capture.updatedOnRaw,
    };
  }

  function ordered(rows) {
    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) =>
        GROUP_ORDER.indexOf(left.row.group) - GROUP_ORDER.indexOf(right.row.group) ||
        newestFirst(left.row, right.row) ||
        left.index - right.index)
      .map((entry) => entry.row);
  }

  /* Open sets that share a batch, by base set or parent. */
  function batchLines(openSets, sets) {
    const groups = new Map();
    openSets.forEach((set) => {
      const root = set.base || set.parent;
      if (!root) return;
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(set);
    });
    const lines = [];
    groups.forEach((members, root) => {
      if (members.length < 2) return;
      const names = members.map(quoted);
      const listed = names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
      const rootSet = sets.get(root);
      const rootName = rootSet ? setName(rootSet) : (members.find((set) => set.parent === root) || {}).parentName || "their batch";
      lines.push(listed + " are in the same batch (“" + rootName + "”); a batch commit applies the newest.");
    });
    return lines;
  }

  /*
   * verdict(captures, sets, outcomes, current, flags) -> the panel's verdict
   *   captures  normalized captures (normalizeCaptures)
   *   sets      Map of readable sets by sys_id (normalizeSet)
   *   outcomes  Map of classifyRows rows by capture key
   *   current   { list, failed, refused, saturated }, or null when not read
   *   flags     { target, origin, identity, readError, capped, total,
   *               disagree, unplaced, loaded }
   */
  function verdict(captures, sets, outcomes, current, flags) {
    const f = flags || {};
    const target = f.target || { name: "", scope: "" };
    const out = {
      headline: null,
      sublines: [],
      attention: [],
      runsHere: "",
      loadedLine: "",
      banners: [],
      counts: { open: 0, default: 0, complete: 0, ignore: 0, merged: 0, unreadable: 0 },
      rows: [],
      clear: false,
      soFar: false,
      attentionCounts: { stale: 0, defaultRuns: false, cant: 0, ignoredRuns: false },
    };
    if (f.identity) {
      out.headline = identityHeadline(f.identity);
      out.sublines = identitySublines(f.identity);
      return out;
    }
    if (f.readError) {
      const error = f.readError;
      out.headline = {
        id: "H3",
        lead: "Couldn't read this record's updates:",
        rest: error.code === "access"
          ? "this account can't read customer updates here (HTTP " + (error.status || 403) + ")."
          : errorMessage(error) || "the read failed.",
        mark: "warn",
        word: "Couldn't read its updates",
      };
      return out;
    }

    const setIds = unique(captures.map((capture) => capture.setId));
    const unreadable = setIds.filter((id) => !sets.has(id));
    const groupOf = (id) => setGroup(sets.get(id) || null);
    setIds.forEach((id) => { out.counts[groupOf(id)] += 1; });
    const openIds = setIds.filter((id) => groupOf(id) === "open");
    const openCaptures = captures.filter((capture) => groupOf(capture.setId) === "open");
    const unplaced = Number(f.unplaced) || 0;
    const exact = !f.capped && !f.disagree && !unreadable.length && !unplaced;
    out.soFar = !exact;
    const so = out.soFar ? " found so far:" : ":";

    /* Headline (§6.2), the first that applies. */
    const n = openIds.length;
    if (!captures.length && !unplaced && !f.disagree) {
      out.headline = { id: "H4", lead: "No update on this instance captured this record.", rest: "", mark: "", word: "No update on this instance captured it" };
      if (target.blankName) out.sublines.push(BLANK_NAME);
    } else if (n >= 2) {
      /* What each open set would promote is its newest capture: a set
       * holding the record twice is still one version in the comparison. */
      const promoted = new Map();
      openCaptures.slice().sort(newestFirst).forEach((capture) => {
        if (!promoted.has(capture.setId)) promoted.set(capture.setId, capture);
      });
      const newest = Array.from(promoted.values());
      const hashes = newest.map((capture) => capture.hash);
      const differ = hashes.some((hash) => !hash) || new Set(hashes).size > 1;
      if (differ) {
        out.headline = {
          id: "H5", lead: "Potential collision:", rest: n + " open sets hold different versions of this record.",
          mark: "differs", word: "Potential collision",
        };
        if (n >= 3) {
          const versions = new Set(hashes.filter(Boolean)).size + hashes.filter((hash) => !hash).length;
          out.sublines.push("They hold " + versions + " different versions.");
        }
        const people = unique(openCaptures.map((capture) => capture.updatedBy).filter(Boolean));
        if (people.length === 1) out.sublines.push("All saved by " + people[0] + ".");
        else if (people.length > 1) out.sublines.push("Saved by " + people.length + " people.");
        newest.filter((capture) => capture.action === "DELETE")
          .forEach((capture) => out.sublines.push(quoted(sets.get(capture.setId)) + " captured a delete of this record."));
        batchLines(openIds.map((id) => sets.get(id)), sets).forEach((line) => out.sublines.push(line));
      } else {
        out.headline = {
          id: "H6", lead: "No competing versions" + so, rest: n + " open sets hold it, all with the same content.",
          mark: "ok", word: "No competing versions" + (out.soFar ? " found so far" : ""),
        };
      }
    } else if (n === 1) {
      out.headline = {
        id: "H7", lead: "No competing sets" + so, rest: "only " + quoted(sets.get(openIds[0])) + " holds it open.",
        mark: "ok", word: "No competing sets" + (out.soFar ? " found so far" : ""),
      };
    } else {
      const history = setIds.filter((id) => ["complete", "ignore", "merged"].includes(groupOf(id)));
      const defaults = captures.filter((capture) => groupOf(capture.setId) === "default").sort(newestFirst);
      if (!captures.length) {
        /* Rows came back but none could be placed: a capture exists, so this
         * is never "No update captured it" (B1). */
        out.headline = {
          id: "H8", lead: "No open update set found so far:",
          rest: unplaced
            ? plural(unplaced, "capture", "captures") + " can't be placed in a set here."
            : "the captures read don't match their count.",
          mark: "", word: "No open update set found so far",
        };
      } else if (history.length || unreadable.length) {
        out.headline = {
          id: "H8",
          lead: out.soFar ? "History only so far:" : "History only:",
          rest: (out.soFar ? "no open update set found. " : "no open update set holds it. ") +
            plural(setIds.length, "set captured it.", "sets captured it."),
          mark: "", word: "History only" + (out.soFar ? " so far" : ""),
        };
      } else if (defaults.length) {
        const newest = defaults[0];
        out.headline = {
          id: "H9", lead: "Captured only outside a named set" + (out.soFar ? " so far:" : ":"),
          rest: quoted(sets.get(newest.setId)) + " holds it, saved " + (newest.updatedOn || "at an unknown time") +
            " by " + (newest.updatedBy || "unknown") + ". That change won't be promoted.",
          mark: "warn", word: "Captured only outside a named set" + (out.soFar ? " so far" : ""),
        };
      }
    }

    /* Rows (§6.9) */
    const perSet = new Map();
    captures.forEach((capture) => perSet.set(capture.setId, (perSet.get(capture.setId) || 0) + 1));
    out.rows = ordered(captures.map((capture) =>
      rowFor(capture, sets.get(capture.setId) || null, outcomes.get(capture.key), target, f.origin || "", perSet.get(capture.setId))));

    /* Attention lines (§6.4): from the per-capture rule and the current
     * version, one per open set. */
    const versionsRefused = Boolean(current && current.refused);
    const seen = new Set();
    out.rows.filter((row) => row.group === "open" && row.verdict === "stale").forEach((row) => {
      if (seen.has("A1" + row.setId)) return;
      seen.add("A1" + row.setId);
      const outcome = outcomes.get(row.key) || {};
      const about = [lowerFirst(str(outcome.newerSetState).toLowerCase()), lowerFirst(str(outcome.who))].filter(Boolean);
      const links = row.links.filter((link) => link.label === "Open newer set");
      out.attention.push({
        id: "A1",
        text: "“" + row.setName + "” holds a version that no longer runs here. " + row.text +
          (about.length ? " (" + about.join(", ") + ")" : "") + ".",
        links,
      });
      out.attentionCounts.stale += 1;
    });
    const c = oneCurrent(current);
    const runningSet = c && c.sourceTable === "sys_update_set" ? sets.get(c.source) || null : null;
    if (runningSet && runningSet.isDefault) {
      out.attention.push({
        id: "A2",
        text: "The version that runs here was saved in " + quoted(runningSet) + ", outside a named set, so no named set would promote it.",
        links: [],
      });
      out.attentionCounts.defaultRuns = true;
    }
    if (!versionsRefused) {
      out.rows.filter((row) => row.group === "open" && row.verdict === "cant").forEach((row) => {
        if (seen.has("A3" + row.setId)) return;
        seen.add("A3" + row.setId);
        const reason = CANT_TELL[row.reason] || CANT_TELL["versions-failed"];
        out.attention.push({
          id: "A3",
          text: "Can't tell whether “" + row.setName + "” holds what runs here: " + lowerFirst(reason) + ".",
          links: [],
        });
        out.attentionCounts.cant += 1;
      });
    }
    if (runningSet && !runningSet.isDefault && runningSet.state === "ignore") {
      out.attention.push({
        id: "A4",
        text: "The version that runs here is in " + quoted(runningSet) + ", an ignored set: it runs here but won't be promoted.",
        links: [],
      });
      out.attentionCounts.ignoredRuns = true;
    }

    out.runsHere = runsHereLine(current, sets);
    const loaded = Number(f.loaded) || 0;
    if (loaded) {
      out.loadedLine = loaded === 1
        ? "1 copy loaded here from another instance isn't listed."
        : loaded.toLocaleString() + " copies loaded here from other instances aren't listed.";
    }

    /* Partial (§6.6): replaces the tick, never the headline. */
    if (unreadable.length) {
      out.banners.push({
        kind: "warn",
        text: "Partial: " + unreadable.length + " of the sets that captured it can't be read here; any of them may be open.",
      });
    }
    if (f.capped) {
      out.banners.push({
        kind: "warn",
        text: f.total != null
          ? "Partial: showing the newest " + LIMITS.captures + " of " + Number(f.total).toLocaleString() + " captures; older ones aren't checked."
          : "Partial: showing the newest " + LIMITS.captures + " captures; older ones aren't checked.",
      });
    }
    if (versionsRefused) {
      out.banners.push({
        kind: "warn",
        text: "Partial: this account can't read version history here, so which version runs isn't known. No row is shown as Current.",
      });
    }
    if (f.disagree) {
      out.banners.push({ kind: "warn", text: "Partial: the capture count and the captures read disagree; the list may be incomplete." });
    }
    if (unplaced) {
      out.banners.push({
        kind: "warn",
        text: "Partial: " + unplaced + " of this record's captures can't be placed in a set here (a field this account " +
          "can't read); any of them may be in an open set.",
      });
    }

    /* The tick (§6.8). */
    const versionsRead = Boolean(current) && !current.failed && !current.refused;
    out.clear = Boolean(out.headline) && (out.headline.id === "H6" || out.headline.id === "H7") &&
      !out.attention.length && !out.banners.length && exact && versionsRead;
    if (out.headline && out.headline.mark === "ok" && !out.clear) out.headline.mark = "";
    return out;
  }

  /* ------------------------------------------------------------------ *
   * The counts-only copy summary (§9.6): no name, id, user, origin or URL
   * ------------------------------------------------------------------ */

  function copyLines(result, read) {
    const lines = ["Version Lens: one record."];
    if (read) {
      const c = result.counts;
      const total = c.open + c.default + c.complete + c.ignore + c.merged + c.unreadable;
      lines.push("Captured in " + plural(total, "set", "sets") + " on this instance: open " + c.open + ", Default " + c.default +
        ", complete " + c.complete + ", Ignore " + c.ignore + ", merged " + c.merged +
        (c.unreadable ? ", can't read " + c.unreadable : "") + ".");
    }
    const a = result.attentionCounts;
    const needs = [];
    if (a.stale) needs.push(a.stale + (a.stale === 1 ? " open set holds" : " open sets hold") + " a version that no longer runs here");
    if (a.defaultRuns) needs.push("the version that runs here was saved in a Default set");
    if (a.cant) needs.push("can't tell for " + plural(a.cant, "open set", "open sets"));
    if (a.ignoredRuns) needs.push("the version that runs here is in an ignored set");
    let third = result.headline ? result.headline.word + "." : "";
    if (needs.length) third += " Needs attention: " + needs.join("; ") + ".";
    if (result.banners.length) third += " Partial.";
    if (third) lines.push(third.trim());
    return lines;
  }

  function copySummary(view, remote) {
    const lines = ((view && view.copyLines) || []).slice();
    if (remote && remote.copyLine) lines.push(remote.copyLine);
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ *
   * The session: one panel's worth of state
   * ------------------------------------------------------------------ */

  /*
   * createSession(resolution, ctx) -> session
   *   resolution: { kind: "target", target } or an identity outcome
   *   ctx: { origin, transport?, shouldStop? }
   *
   * session.run()        reads captures, sets and versions, once
   * session.view()       the panel's snapshot
   * session.onChange(fn) called with a fresh snapshot after every step
   * session.cancel()
   * session.remoteRequest()
   */
  function createSession(resolution, ctx) {
    const listeners = [];
    let cancelled = false;
    const sessionCtx = Object.assign({}, ctx, {
      shouldStop: () => cancelled || Boolean(ctx.shouldStop && ctx.shouldStop()),
    });
    const target = resolution && resolution.kind === "target" ? resolution.target : null;
    const identityOutcome = resolution && resolution.kind === "identity" ? resolution : null;
    const state = {
      phase: target ? "ready" : "done",
      busy: Boolean(target),
      progress: "",
      readError: null,
      read: false,
      captures: [],
      outcomes: new Map(),
      sets: new Map(),
      current: null,
      total: null,
      capped: false,
      disagree: false,
      unplaced: 0,
      loaded: 0,
    };

    function emit() {
      if (cancelled) return;
      const snapshot = view();
      listeners.forEach((listener) => {
        try { listener(snapshot); } catch (error) { /* a listener must not stop the run */ }
      });
    }

    function finish() {
      state.phase = "done";
      state.busy = false;
      state.progress = "";
      emit();
    }

    async function run() {
      if (!target || state.phase !== "ready") {
        emit();
        return;
      }
      state.phase = "running";
      state.progress = "Reading its updates…";
      emit();
      try {
        let answer;
        try {
          answer = await readTable(sessionCtx, "sys_update_xml",
            "name=" + target.name + "^category=customer^ORDERBYDESCsys_updated_on",
            CAPTURE_FIELDS, LIMITS.captures + 1, { withTotal: true });
        } catch (error) {
          if (error && error.code === "stale") return;
          state.readError = error;
          finish();
          return;
        }
        if (cancelled) return;
        state.read = true;
        state.total = answer.total;
        state.capped = answer.rows.length > LIMITS.captures || (answer.total != null && answer.total > LIMITS.captures);
        const placed = placeRows(answer.rows.slice(0, LIMITS.captures), target.name);
        state.unplaced = placed.unplaced;
        state.loaded = placed.loaded;
        /* Under the cap, a count above the rows read means rows were hidden
         * (a row-level ACL): the list is not whole, so it is never exact. */
        state.disagree = placed.dropped > 0 || (answer.total != null &&
          ((answer.total > 0 && !answer.rows.length) || (answer.total === 0 && answer.rows.length > 0) ||
            (!state.capped && answer.total > answer.rows.length)));
        state.captures = normalizeCaptures(placed.captures);
        const ids = unique(state.captures.map((capture) => capture.setId));
        if (ids.length) {
          const read = await readSetsById(ids, sessionCtx);
          if (cancelled) return;
          read.found.forEach((set, id) => state.sets.set(id, set));
        }
        state.progress = "Checking versions…";
        emit();
        if (state.captures.length) {
          const classified = await classifyRows(state.captures, sessionCtx, { sets: state.sets });
          if (cancelled) return;
          classified.rows.forEach((row) => state.outcomes.set(row.key, row));
          state.current = versionsFor(classified.current, target.name);
        } else {
          /* Read 7: no capture, but a version may still run here. */
          const current = await readCurrentVersions([target.name], sessionCtx);
          if (cancelled) return;
          state.current = versionsFor(current, target.name);
          const c = oneCurrent(state.current);
          if (c && c.sourceTable === "sys_update_set" && isSysId(c.source) && !state.sets.has(c.source)) {
            const read = await readSetsById([c.source], sessionCtx);
            if (cancelled) return;
            read.found.forEach((set, id) => state.sets.set(id, set));
          }
        }
        finish();
      } catch (error) {
        if (cancelled || (error && error.code === "stale")) return;
        state.readError = error;
        finish();
      }
    }

    function links() {
      const name = target ? target.name : "";
      if (!name || nameQueryKind(name) === "unsafe") return [];
      const out = [];
      const versions = state.current && state.current.list.length;
      if (versions || state.captures.length) {
        out.push({
          label: "Version history",
          url: ctx.origin + "/sys_update_version_list.do?sysparm_query=" +
            encodeURIComponent("name=" + name + "^ORDERBYDESCsys_recorded_at"),
        });
      }
      if (state.captures.length || state.unplaced || state.loaded) {
        out.push({
          label: "Captures list",
          url: ctx.origin + "/sys_update_xml_list.do?sysparm_query=" +
            encodeURIComponent("name=" + name + "^category=customer^ORDERBYDESCsys_updated_on"),
        });
      }
      return out;
    }

    function view() {
      const done = state.phase === "done";
      const result = done
        ? verdict(state.captures, state.sets, state.outcomes, state.current, {
          target: target || {},
          origin: ctx.origin,
          identity: identityOutcome,
          readError: state.readError,
          capped: state.capped,
          total: state.total,
          disagree: state.disagree,
          unplaced: state.unplaced,
          loaded: state.loaded,
        })
        : null;
      const c = oneCurrent(state.current);
      const snapshot = {
        phase: state.phase,
        busy: state.busy,
        progress: state.progress,
        target: target ? Object.assign({}, target, { howWords: target.howWords.slice() }) : null,
        record: identityOutcome ? identityOutcome.record : null,
        headline: result ? result.headline : null,
        sublines: result ? result.sublines : [],
        attention: result ? result.attention : [],
        runsHere: result ? result.runsHere : "",
        loadedLine: result ? result.loadedLine : "",
        banners: result ? result.banners : [],
        counts: result ? result.counts : null,
        rows: result ? result.rows : [],
        clear: result ? result.clear : false,
        links: done ? links() : [],
        current: c ? { name: c.name, guid: c.guid, hash: c.hash, source: c.source, sourceTable: c.sourceTable } : null,
        copyLines: result ? copyLines(result, state.read) : [],
      };
      const request = collisionRemoteRequest(snapshot);
      snapshot.check = {
        shown: Boolean(target) && !state.readError,
        ready: done && !request.blocked,
        blocked: done ? request.blocked : "",
      };
      return snapshot;
    }

    return {
      run,
      view,
      onChange: (fn) => { if (typeof fn === "function") listeners.push(fn); },
      cancel: () => { cancelled = true; },
      remoteRequest: () => collisionRemoteRequest(view()),
      get state() { return state; },
    };
  }

  /* ------------------------------------------------------------------ *
   * Check on another instance (§7), through the shipped route unchanged
   * ------------------------------------------------------------------ */

  function passes(record) {
    return Boolean(record) && REMOTE_NAME.test(str(record.name)) && REMOTE_GUID.test(str(record.guid)) &&
      REMOTE_HASH.test(str(record.hash));
  }

  /* Index 0 is the version that runs here, or the newest capture when that
   * is missing or fails its pattern; then one record per capture. A record
   * that fails its pattern is not sent, and its answer there is Can't tell. */
  function collisionRemoteRequest(view) {
    const rows = (view && view.rows) || [];
    const placed = rows.filter((row) => isSysId(row.setId));
    const named = unique(placed.filter((row) => row.group !== "default").map((row) => row.setId));
    let setIds = named.length ? named : unique(placed.map((row) => row.setId));
    const current = view && view.current;
    if (!setIds.length && current && current.sourceTable === "sys_update_set" && isSysId(current.source)) {
      setIds = [current.source];
    }
    const records = [];
    const keys = [];
    const filtered = [];
    let zero = null;
    if (passes(current)) {
      records.push({ name: current.name, guid: current.guid, hash: current.hash });
      zero = "current";
    } else {
      const newest = rows.filter(passes).slice().sort(newestFirst)[0];
      if (newest) {
        records.push({ name: newest.name, guid: newest.guid, hash: newest.hash });
        zero = "newest";
      }
    }
    const offset = records.length;
    rows.slice(0, LIMITS.captures).forEach((row) => {
      if (passes(row)) {
        records.push({ name: row.name, guid: row.guid, hash: row.hash });
        keys.push(row.key);
      } else {
        filtered.push(row.key);
      }
    });
    const defaults = new Set(placed.filter((row) => row.group === "default").map((row) => row.setId));
    return {
      setIds: setIds.slice(0, LIMITS.remoteSets),
      records,
      keys,
      filtered,
      zero,
      offset,
      defaults: Array.from(defaults),
      blocked: setIds.length && records.length ? "" : NOTHING_TO_CHECK,
    };
  }

  function presenceKind(found, cloned) {
    const remote = found.filter((copy) => copy.match === "remote");
    if (remote.length) {
      const state = bestCopy(remote).state;
      if (state === "committed") return "committed";
      if (PREVIEWED.has(state)) return "previewed";
      if (RETRIEVED.has(state)) return "retrieved";
      if (BACKED_OUT.has(state)) return "backed out";
      return lowerFirst(str(bestCopy(remote).stateLabel || state || "unknown state")).toLowerCase();
    }
    if (found.length) return "arrived through another instance";
    if (cloned) return "same id only because the instance was copied";
    return "not found or not visible";
  }

  function presenceText(found, cloned) {
    const remote = found.filter((copy) => copy.match === "remote");
    if (remote.length) return lowerFirst(presenceWords(bestCopy(remote)));
    if (found.length) return "arrived through another instance; " + lowerFirst(presenceWords(bestCopy(found)));
    if (cloned) return "same id only because the instance was copied";
    return "not found or not visible";
  }

  /* A set's state there as a row badge and a count badge: an id to style it
   * by and a word to show, in the order the counts are listed. Any other
   * state the instance reports keeps its own label. */
  const THERE_STATES = [
    ["committed", "committed", "Committed"],
    ["previewed", "previewed", "Previewed"],
    ["retrieved", "retrieved", "Retrieved"],
    ["backed out", "backed-out", "Backed out"],
    ["", "other", ""],
    ["arrived through another instance", "elsewhere", "Via another instance"],
    ["same id only because the instance was copied", "cloned", "Clone copy"],
    ["not found or not visible", "missing", "Not found"],
  ];

  function thereState(kind) {
    const index = THERE_STATES.findIndex(([word]) => word === kind);
    const at = index >= 0 ? index : THERE_STATES.findIndex(([word]) => word === "");
    const [, id, word] = THERE_STATES[at];
    const text = word || str(kind);
    return { rank: at, there: id, word: text.charAt(0).toUpperCase() + text.slice(1) };
  }

  const CONTENT_WORDS = {
    runs: "runs the same version",
    other: "runs another version",
    same: "runs the same content under another update",
    conflict: "can't tell",
    none: "no readable current version",
    unknown: "can't tell",
  };

  /*
   * The other instance's answer as text. `reply` is what the worker returned,
   * already rebuilt from its allowlist; `request` what was sent; `view` the
   * snapshot it was sent from; `origin` the instance checked, for its links.
   */
  function collisionRemoteView(reply, request, view, instance, origin) {
    const lines = [];
    const perRow = {};
    let links = [];
    const rows = (view && view.rows) || [];
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const content = Array.isArray(reply.content) ? reply.content : null;
    const status = (index) => (content ? content[index] || "unknown" : null);
    const newest = request.zero === "newest";
    const subject = newest ? "the newest capture here" : "this instance";
    let zeroStatus = null;

    if (!content) {
      if (reply.contentFailure) {
        lines.push({ kind: "warn", text: contentFailureText(reply.contentFailure, instance, reply.sourceImpersonating) });
      }
    } else if (!request.zero) {
      lines.push({ kind: "warn", text: "Can't tell on " + instance + "." });
    } else {
      zeroStatus = status(0);
      const saved = savedWords(Array.isArray(reply.saved) ? reply.saved[0] : null);
      const captureStatus = request.keys.map((key, index) => ({ key, status: status(index + request.offset) }));
      const than = newest ? " than the newest capture here" : "";
      if (zeroStatus === "runs") {
        lines.push({ kind: "ok", text: instance + " runs the same version as " + subject + "." });
      } else if (zeroStatus === "other") {
        const runs = captureStatus.find((entry) => entry.status === "runs");
        const same = captureStatus.find((entry) => entry.status === "same");
        let text;
        if (runs && byKey.get(runs.key)) {
          const row = byKey.get(runs.key);
          text = instance + " runs another version" + than + ": the one in “" + row.setName + "” here" +
            (row.stateLabel ? " (" + row.stateLabel + ")" : "") + saved + ".";
        } else if (same && byKey.get(same.key)) {
          text = instance + " runs another version" + than + ", with the same content as “" + byKey.get(same.key).setName + "” here" + saved + ".";
        } else {
          text = instance + " runs another version" + than + saved + ".";
        }
        lines.push({ kind: "differs", text });
      } else if (zeroStatus === "same") {
        lines.push({ kind: "content", text: instance + " runs the same content as " + subject + ", under another update" + saved + "." });
      } else if (zeroStatus === "conflict") {
        lines.push({
          kind: "warn",
          text: "Can't tell on " + instance + ": its version shares " + (newest ? "the newest capture's" : "this one's") + " id but not its content.",
        });
      } else if (zeroStatus === "none") {
        lines.push({ kind: "warn", text: instance + " has no readable current version of this record." });
      } else {
        lines.push({ kind: "warn", text: "Can't tell on " + instance + "." });
      }
      captureStatus.forEach((entry) => {
        const row = byKey.get(entry.key);
        if (row && row.group !== "default" && (entry.status === "runs" || entry.status === "same")) {
          perRow[entry.key] = { content: entry.status };
        }
      });
      if (origin) {
        links = remoteLinks(Array.isArray(reply.found) ? reply.found[0] : null, request.records[0], origin, zeroStatus);
      }
    }

    /* Presence of the sets, Default sets left out: they are never promoted. */
    const defaults = new Set(request.defaults || []);
    const tally = new Map();
    if (reply.presenceFailure) {
      lines.push({ kind: "warn", text: presenceFailureText(reply.presenceFailure, instance, reply.sourceImpersonating) });
      /* Every set asked about can't be told; the line above says why. */
      const asked = new Set(request.setIds.filter((setId) => !defaults.has(setId)));
      rows.forEach((row) => {
        if (!asked.has(row.setId)) return;
        perRow[row.key] = Object.assign({}, perRow[row.key] || {}, { there: "failed", thereWord: "Can't tell" });
      });
    } else {
      const copies = Array.isArray(reply.copies) ? reply.copies : [];
      const clones = new Set(Array.isArray(reply.clones) ? reply.clones : []);
      const bySet = request.setIds.map(() => []);
      copies.forEach((copy) => { if (bySet[copy.set]) bySet[copy.set].push(copy); });
      const presence = new Map();
      request.setIds.forEach((setId, index) => {
        if (defaults.has(setId)) return;
        const kind = presenceKind(bySet[index], clones.has(index));
        tally.set(kind, (tally.get(kind) || 0) + 1);
        presence.set(setId, { kind, text: presenceText(bySet[index], clones.has(index)) });
      });
      rows.forEach((row) => {
        const found = presence.get(row.setId);
        if (!found) return;
        const state = thereState(found.kind);
        perRow[row.key] = Object.assign({}, perRow[row.key] || {}, {
          presence: "On " + instance + ": " + found.text,
          there: state.there,
          thereWord: state.word,
        });
      });
    }
    /* The sets' states there as count badges; the panel labels them with the
     * instance it checked. */
    const counted = Array.from(tally.entries())
      .map(([kind, count]) => Object.assign(thereState(kind), { count }))
      .sort((left, right) => left.rank - right.rank)
      .map(({ there, word, count }) => ({ there, word, count }));

    const contentWord = !content ? "versions not compared"
      : !request.zero ? "can't tell"
        : (CONTENT_WORDS[zeroStatus] || "can't tell") + (zeroStatus === "runs" && newest ? " as the newest capture" : "");
    const short = (word) => (word === "not found or not visible" ? "not found" : word);
    const setsThere = Array.from(tally.entries()).map(([word, count]) => short(word) + " " + count).join(", ");
    return {
      lines,
      perRow,
      tally: counted,
      links,
      copyLine: "On the other instance: " + contentWord + (setsThere ? "; sets there: " + setsThere : "") + ".",
    };
  }

  /* Why a check could not run, by the worker's code: Update Set Lens's
   * words, except the one that names the command to reopen. */
  function remoteProblem(reply, instance, host) {
    if (reply && reply.code === "invalid") return "GlideLens couldn't send that check. Reopen Version Lens, then try again.";
    return USL.remoteProblem(reply, instance, host);
  }

  globalThis.SNVersionLens = {
    LIMITS,
    LAYOUT_CHILDREN,
    CAPTURE_FIELDS,
    METADATA_FIELDS,
    navToTarget,
    isNewRecord,
    pageTarget,
    resolveInput,
    resolveRecord,
    /* An update's own name, as Update Set Lens shows it: no read needed. */
    targetForName: (name, how) => nameTarget(str(name), how || "update", {}),
    existingName,
    placeRows,
    normalizeCaptures,
    verdict,
    createSession,
    collisionRemoteRequest,
    collisionRemoteView,
    copySummary,
    remoteProblem,
  };
})();

/*
 * Translation Assistant - DOM-free draft/apply engine.
 *
 * The engine owns the payload contract, the exclusion rules, the destination
 * grouping, reply parsing, the per-row verdicts and the merge construction. It
 * knows nothing about the page DOM, the panel, or chrome.* - the panel injects
 * it and hands it a flattened copy of the Localization Framework comparison
 * page's own content array, so the same code runs in Node fixtures.
 *
 * Two platform facts shape everything here and are recorded so a later reader
 * does not have to rediscover them:
 *
 * - A row's identity for matching is `additionalParameters` (type, table,
 *   sysId, name). The platform's own element id is `groupName + ": " + label`
 *   with an ordinal `_2` suffix on collision, so it moves when variables are
 *   added, removed or renamed. It is an address, never a key.
 * - A row's *destination* is not its identity. `translated_field` values are
 *   stored in sys_translated keyed by (table, column, source string), so two
 *   different records sharing one source string share one stored translation.
 *   Destination groups are therefore the unit of protection: all-or-nothing.
 *
 * The engine never writes a record and never publishes. It produces a merged
 * content array for the page's own `updateDocumentContent` channel, and the
 * user presses Publish.
 */
(function () {
  if (globalThis.SNTranslationAssistant) return;

  const SCHEMA_VERSION = 1;
  const EXPORT_ID_BYTES = 16;
  const DRAFT_LIMIT = 5;

  /* Refusal thresholds, not truncation thresholds. Everything past one of
   * these is refused whole, with the number shown. */
  const MAX_REPLY_CHARS = 5 * 1024 * 1024;
  const MAX_REPLY_ROWS = 2000;
  const MAX_TARGET_CHARS = 65000;

  /* R1 covers catalog items and record producers, which the framework registers
   * under one internal name (sc_cat_item_producer extends sc_cat_item). */
  const SUPPORTED_ARTIFACT_TYPES = new Set(["catalog_item"]);

  /* The hard limit is the *destination* column the translation is saved into,
   * derived from additionalParameters.type - never the source column, which is
   * advisory context and must not be enforced as a cap. The platform truncates
   * silently at these, so an over-limit row is blocked rather than warned.
   *
   * Only the three types observed on a catalog item are listed. sys_choice and
   * sys_documentation rows land in a column this engine has not verified
   * (sys_documentation splits across label/hint/plural), and a getMessage row
   * has no record anchor at all, so all three are excluded with a stated
   * reason rather than given a guessed limit. */
  const DESTINATION_LIMITS = Object.freeze({
    translated_field: 255,
    translated_text: 65000,
    translated_html: 65000,
  });

  /* Stored per record: (table, column, sysId). Safe to fill independently. */
  const RECORD_SCOPED_TYPES = new Set(["translated_text", "translated_html"]);
  /* Stored per source string: (table, column, value). Shared instance-wide. */
  const STRING_SCOPED_TYPES = new Set(["translated_field"]);

  /* Keys the platform's deserialiser handles by name. Anything else on a
   * fieldInfo object is moved into additionalParameters and posted to the
   * server on Publish, so the merge introduces none of its own. */
  const FIELD_KEYS = Object.freeze([
    "originalValue", "translatedValue", "primaryTranslatedValue", "textType",
    "isFieldLocked", "escapeDetails", "additionalParameters", "$$hashKey",
  ]);

  const PLACEHOLDER_PATTERN = /\$\{[^{}]*\}|\{\{[^{}]*\}\}|\{\d+\}/g;
  const UNIT = "\u0000";

  /* Exclusion reasons, in the order they are tested. A row carries exactly
   * one, and every excluded row is reported - a silent drop is a bug. */
  const REASON = Object.freeze({
    RICH_TEXT: "rich_text",
    SHARED_MESSAGE: "shared_message",
    UNSUPPORTED_TYPE: "unsupported_type",
    EMPTY_SOURCE: "empty_source",
    LOCKED: "locked",
    SHARED_WITH_INELIGIBLE: "shared_with_ineligible",
  });

  function createError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function text(value) {
    return typeof value === "string" ? value : "";
  }

  /* A field's translatedValue key is ABSENT on an untranslated row rather than
   * empty, so every read goes through here and the two cases stay identical. */
  function translatedText(field) {
    return text(field && field.translatedValue);
  }

  /*
   * FNV-1a, run twice with different offset bases to give 64 bits of hex. Used
   * only to detect that a source string moved between draft and apply, which is
   * a change check rather than a security boundary.
   */
  function hashText(value) {
    const input = text(value);
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < input.length; i += 1) {
      const code = input.charCodeAt(i);
      a ^= code;
      a = Math.imul(a, 0x01000193) >>> 0;
      b ^= code + i;
      b = Math.imul(b, 0x85ebca6b) >>> 0;
    }
    const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
    return hex(a) + hex(b) + ":" + input.length;
  }

  function randomExportId(source) {
    const rng = source || globalThis.crypto;
    if (!rng || typeof rng.getRandomValues !== "function") {
      throw createError("no_random_source", "A cryptographic random source is required for exportId.");
    }
    const bytes = new Uint8Array(EXPORT_ID_BYTES);
    rng.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }

  /*
   * sys_translated resolves a key regardless of capitalisation - verified on a
   * configured instance, where a variable whose only row was keyed with a
   * different capitalisation of its question text rendered that translation.
   * The read and the write use the same query, so two rows differing only in
   * case address one stored translation.
   *
   * Folding here therefore only ever *widens* a destination group, which is the
   * safe direction: a wider group blocks more and can never let a locked member
   * be rewritten through an unlocked one. If the write path later proves
   * case-sensitive, the cost is two case-variants sharing one translation,
   * which is what the page would show anyway. This is the one place to change
   * if that is ever measured.
   */
  function foldSourceKey(value) {
    return text(value).toLowerCase();
  }

  function placeholders(value) {
    const found = text(value).match(PLACEHOLDER_PATTERN) || [];
    return found.slice().sort();
  }

  function placeholdersDiffer(source, target) {
    const a = placeholders(source);
    const b = placeholders(target);
    if (a.length !== b.length) return true;
    return a.some((token, index) => token !== b[index]);
  }

  /* ---------------------------------------------------------------- reading */

  function contentArray(input) {
    if (Array.isArray(input)) return input;
    if (isObject(input) && Array.isArray(input.content)) return input.content;
    throw createError("no_content", "The comparison page returned no content array.");
  }

  function fieldType(params) {
    return text(params && params.type);
  }

  function identityKey(params) {
    const p = params || {};
    return [fieldType(p), text(p.table), text(p.name), text(p.sysId)].join(UNIT);
  }

  /*
   * Where the platform will store this translation. Two rows with the same
   * destination share one stored row, whatever their record identity says.
   */
  function destinationKey(field) {
    const p = field.params || {};
    const type = fieldType(p);
    if (STRING_SCOPED_TYPES.has(type)) {
      return ["string", type, text(p.table), text(p.name), foldSourceKey(field.source)].join(UNIT);
    }
    if (RECORD_SCOPED_TYPES.has(type)) {
      return ["record", type, text(p.table), text(p.name), text(p.sysId)].join(UNIT);
    }
    /* Unsupported and message rows never group: they are excluded anyway, and
     * an invented group would drag eligible rows down with them. */
    return ["row", String(field.elementIndex), String(field.fieldIndex)].join(UNIT);
  }

  function limitFor(params) {
    const limit = DESTINATION_LIMITS[fieldType(params)];
    return typeof limit === "number" ? limit : 0;
  }

  function exclusionFor(field) {
    const type = fieldType(field.params);
    if (field.textType === "html" || type === "translated_html") return REASON.RICH_TEXT;
    if (!text(field.params && field.params.sysId)) return REASON.SHARED_MESSAGE;
    if (!DESTINATION_LIMITS[type]) return REASON.UNSUPPORTED_TYPE;
    if (!field.source) return REASON.EMPTY_SOURCE;
    if (field.locked) return REASON.LOCKED;
    return null;
  }

  /*
   * Flatten the page's content array into addressable field records. Position
   * is kept for writing back; identity is what matching uses, because the
   * element id carries an ordinal suffix that moves when variables move.
   */
  function readFields(input) {
    const elements = contentArray(input);
    const fields = [];
    elements.forEach((element, elementIndex) => {
      const infos = (element && Array.isArray(element.fieldInfo)) ? element.fieldInfo : [];
      infos.forEach((info, fieldIndex) => {
        const params = isObject(info && info.additionalParameters) ? info.additionalParameters : {};
        const field = {
          elementIndex,
          fieldIndex,
          elementId: text(element && element.id),
          groupName: text(element && element.groupName),
          label: text(element && element.label),
          source: text(info && info.originalValue),
          target: translatedText(info),
          textType: text(info && info.textType) || "plain",
          locked: !!(info && info.isFieldLocked),
          params,
          type: fieldType(params),
        };
        field.identityKey = identityKey(params);
        field.destinationKey = destinationKey(field);
        field.limit = limitFor(params);
        field.exclusion = exclusionFor(field);
        fields.push(field);
      });
    });
    return { elements, fields, elementCount: elements.length, fieldCount: fields.length };
  }

  /*
   * Group by destination, preserving first-seen order. A group is exportable
   * only when EVERY member is eligible: filling one member of a group whose
   * other member is locked would rewrite the shared stored row and defeat that
   * lock without ever touching the locked row.
   */
  function groupByDestination(fields) {
    const order = [];
    const byKey = new Map();
    fields.forEach((field) => {
      let group = byKey.get(field.destinationKey);
      if (!group) {
        group = { destinationKey: field.destinationKey, members: [], blockedBy: null };
        byKey.set(field.destinationKey, group);
        order.push(group);
      }
      group.members.push(field);
    });
    order.forEach((group) => {
      const ineligible = group.members.filter((member) => member.exclusion);
      if (!ineligible.length) return;
      group.blockedBy = ineligible[0];
      group.members.forEach((member) => {
        if (!member.exclusion) member.exclusion = REASON.SHARED_WITH_INELIGIBLE;
      });
    });
    return { groups: order, byKey };
  }

  /* ------------------------------------------------------------------ draft */

  function requireContext(options) {
    const artifactType = text(options.artifactInternalName);
    const identity = {
      artifactInternalName: artifactType,
      artifactSysId: text(options.artifactSysId),
      sourceLanguage: text(options.sourceLanguage),
      targetLanguage: text(options.targetLanguage),
    };
    if (!identity.artifactInternalName || !identity.artifactSysId) {
      throw createError("no_artifact", "The comparison page did not identify its artifact.");
    }
    if (!identity.sourceLanguage || !identity.targetLanguage) {
      throw createError("no_languages", "The comparison page did not report a language pair.");
    }
    if (!SUPPORTED_ARTIFACT_TYPES.has(identity.artifactInternalName)) {
      throw createError("unsupported_artifact", "Translation Assistant covers catalog items and record producers.");
    }
    return identity;
  }

  /*
   * The instruction block. It is the first key of the envelope so a model
   * reading a truncated or partially quoted file meets it before the rows, it
   * is generated from this template and never edited by a user, and it is
   * ignored entirely on the way back in.
   */
  function buildPrompt(sourceName, targetName) {
    return "Translate each row's `source` from " + sourceName + " into " + targetName +
      ". Reply with this same JSON object, with a `target` added to every row." +
      " Preserve `exportId`, `schemaVersion` and every `k` exactly as given." +
      " Do not translate anything inside ${...}, {0} or {{...}}, and do not translate" +
      " the terms listed in `doNotTranslate`. Keep each `target` within its row's" +
      " `maxLength` and use wording appropriate for a short user-interface label." +
      " Reply with the JSON only.";
  }

  function serializePayload(payload) {
    return JSON.stringify(payload, null, 2);
  }

  function excludedEntry(field) {
    return {
      elementId: field.elementId,
      groupName: field.groupName,
      label: field.label,
      fieldIndex: field.fieldIndex,
      reason: field.exclusion,
      type: field.type,
    };
  }

  function buildDraft(options) {
    const opts = options || {};
    const identity = requireContext(opts);
    const read = readFields(opts.content);
    const grouped = groupByDestination(read.fields);
    const sourceName = text(opts.sourceLanguageName) || identity.sourceLanguage;
    const targetName = text(opts.targetLanguageName) || identity.targetLanguage;

    const map = {};
    const rows = [];
    const excluded = [];
    let k = 0;

    grouped.groups.forEach((group) => {
      const eligible = group.members.every((member) => !member.exclusion);
      if (!eligible) {
        group.members.forEach((member) => excluded.push(excludedEntry(member)));
        return;
      }
      k += 1;
      const lead = group.members[0];
      const maxLength = group.members.reduce(
        (limit, member) => Math.min(limit, member.limit), Number.MAX_SAFE_INTEGER
      );
      rows.push({
        k,
        kind: lead.label,
        context: lead.groupName,
        source: lead.source,
        maxLength,
      });
      map[String(k)] = {
        elementId: lead.elementId,
        fieldIndex: lead.fieldIndex,
        additionalParameters: lead.params,
        destinationKey: group.destinationKey,
        /* Carried so the preview can still describe a row that has since left
         * the model. Display only - matching never reads them. */
        kind: lead.label,
        context: lead.groupName,
        source: lead.source,
        sourceHash: hashText(lead.source),
        targetBaseline: lead.target,
        textType: lead.textType,
        maxLength,
        members: group.members.map((member) => ({
          identityKey: member.identityKey,
          elementId: member.elementId,
          fieldIndex: member.fieldIndex,
          sourceHash: hashText(member.source),
          targetBaseline: member.target,
        })),
      };
    });

    const counts = { fields: read.fieldCount, elements: read.elementCount, eligible: rows.length };
    Object.keys(REASON).forEach((name) => {
      counts[REASON[name]] = excluded.filter((entry) => entry.reason === REASON[name]).length;
    });

    const payload = {
      prompt: buildPrompt(sourceName, targetName),
      glidelens: "translation-assistant",
      schemaVersion: SCHEMA_VERSION,
      exportId: text(opts.exportId) || randomExportId(opts.random),
      artifactType: identity.artifactInternalName,
      sourceLanguage: identity.sourceLanguage,
      targetLanguage: identity.targetLanguage,
      doNotTranslate: [],
      rows,
    };

    return {
      exportId: payload.exportId,
      identity,
      elementCount: read.elementCount,
      fieldCount: read.fieldCount,
      createdAt: typeof opts.now === "number" ? opts.now : Date.now(),
      map,
      counts,
      excluded,
      payload,
      serialized: serializePayload(payload),
    };
  }

  /* What the worker persists in storage.session: the map, the identity half of
   * the fingerprint, and the element count the liveness check compares. No
   * frameId and no other browser handle - the frame is resolved fresh on every
   * route, and a reload changes its id while the artifact stays the same. */
  function storedDraft(draft) {
    return {
      exportId: draft.exportId,
      identity: draft.identity,
      elementCount: draft.elementCount,
      createdAt: draft.createdAt,
      map: draft.map,
    };
  }

  /* --------------------------------------------------------- the draft store */

  function createDraftStore() {
    return { version: SCHEMA_VERSION, drafts: [] };
  }

  function normalizeStore(store) {
    if (isObject(store) && Array.isArray(store.drafts)) return store;
    return createDraftStore();
  }

  /* Oldest first, capped. Clearing on browser close plus a bounded list
   * replaces a TTL sweep and the clock drift that comes with one. */
  function putDraft(store, draft) {
    const current = normalizeStore(store);
    const entry = draft && draft.map && draft.identity ? storedDraft(draft) : null;
    if (!entry || !entry.exportId) return current;
    const kept = current.drafts.filter((held) => held && held.exportId !== entry.exportId);
    kept.push(entry);
    return {
      version: SCHEMA_VERSION,
      drafts: kept.slice(Math.max(0, kept.length - DRAFT_LIMIT)),
    };
  }

  function getDraft(store, exportId) {
    const current = normalizeStore(store);
    const wanted = text(exportId);
    if (!wanted) return null;
    return current.drafts.find((held) => held && held.exportId === wanted) || null;
  }

  /* ----------------------------------------------------------------- parsing */

  function refusal(code, message, extra) {
    return Object.assign({ ok: false, code, message }, extra || {});
  }

  function excerptOf(value) {
    return text(value).slice(0, 200);
  }

  /*
   * Models wrap JSON in fences and explain themselves either side of it
   * regardless of instruction, so a reply is tried raw, then unfenced, then
   * sliced between the outermost braces.
   */
  function jsonCandidates(input) {
    const trimmed = input.trim();
    const candidates = [trimmed];
    const fence = trimmed.match(/```(?:[A-Za-z0-9_-]+)?\s*\n([\s\S]*?)```/);
    if (fence) candidates.push(fence[1].trim());
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
    return candidates;
  }

  function parseReply(input) {
    if (typeof input !== "string" || !input.trim()) {
      return refusal("empty_reply", "There is nothing to read - paste the model's reply, or upload its file.");
    }
    if (input.length > MAX_REPLY_CHARS) {
      return refusal("too_large",
        "That reply is " + input.length + " characters; the limit is " + MAX_REPLY_CHARS + ".");
    }
    let lastError = null;
    const candidates = jsonCandidates(input);
    for (let i = 0; i < candidates.length; i += 1) {
      try {
        const parsed = JSON.parse(candidates[i]);
        if (!isObject(parsed)) {
          lastError = new Error("The reply parsed as " + (Array.isArray(parsed) ? "an array" : typeof parsed) + " rather than an object.");
          continue;
        }
        return { ok: true, reply: parsed };
      } catch (error) {
        lastError = error;
      }
    }
    return refusal("unparseable",
      "That is not JSON: " + (lastError ? lastError.message : "unreadable"),
      { excerpt: excerptOf(input) });
  }

  /* -------------------------------------------------------------- evaluation */

  const VERDICT = Object.freeze({
    FILL: "fill",
    NOT_RETURNED: "not_returned",
    UNKNOWN_ROW: "unknown_row",
    BLANK: "blank",
    UNCHANGED: "unchanged",
    LOCKED: "locked",
    SOURCE_CHANGED: "source_changed",
    EDITED: "edited",
    NOT_EXPORTED: "not_exported",
    MISSING: "missing",
    TOO_LONG: "too_long",
  });

  const BLOCKED_VERDICTS = new Set([VERDICT.LOCKED, VERDICT.TOO_LONG]);

  function overrideFor(overrides, k) {
    if (!Array.isArray(overrides)) return null;
    return overrides.find((entry) => entry && Number(entry.k) === Number(k)) || null;
  }

  /* An override is bound to the exact values the user was shown. If any member
   * has moved since, the override is void for the whole group - a single tick
   * must never overwrite a value nobody reviewed. */
  function overrideHolds(override, members) {
    if (!override || !Array.isArray(override.reviewed)) return false;
    return members.every((member) => {
      const seen = override.reviewed.find((row) => row && row.identityKey === member.identityKey);
      return !!seen && text(seen.target) === member.liveTarget;
    });
  }

  function replyRows(reply) {
    return Array.isArray(reply && reply.rows) ? reply.rows : null;
  }

  const ENVELOPE_KEYS = new Set([
    "prompt", "glidelens", "schemaVersion", "exportId", "artifactType",
    "sourceLanguage", "targetLanguage", "doNotTranslate", "rows",
  ]);
  const ROW_KEYS = new Set(["k", "kind", "context", "source", "maxLength", "target"]);

  function countIgnoredKeys(reply) {
    let count = Object.keys(reply).filter((key) => !ENVELOPE_KEYS.has(key)).length;
    (replyRows(reply) || []).forEach((row) => {
      count += Object.keys(row).filter((key) => !ROW_KEYS.has(key)).length;
    });
    return count;
  }

  /*
   * The identity half of the fingerprint, compared against a fresh read of the
   * page being applied to. This is what stops a file drafted on one item from
   * being applied to another now that a draft outlives its page, so it is
   * required rather than optional: a caller that forgets it loses the guard.
   *
   * frameId is deliberately absent. It is a browser handle a reload
   * invalidates, both routes resolve their frame fresh, and caching it would
   * refuse every persisted draft after a reload.
   */
  function checkPage(draft, identity, elementCount) {
    if (!isObject(identity)) {
      throw createError("no_identity", "The live page identity is required to validate a reply.");
    }
    const fields = ["artifactInternalName", "artifactSysId", "sourceLanguage", "targetLanguage"];
    const moved = fields.find((field) => text(identity[field]) !== text(draft.identity[field]));
    if (moved) {
      return refusal("identity_moved",
        "This page is no longer the one this draft came from. Draft again from here.",
        { field: moved });
    }
    if (Number(elementCount) !== Number(draft.elementCount)) {
      return refusal("element_count",
        "This item had " + draft.elementCount + " sections when the draft was made and has " +
        elementCount + " now. Draft again.");
    }
    return null;
  }

  function checkEnvelope(draft, reply) {
    if (!draft || !draft.map || !draft.identity) {
      return refusal("unknown_draft",
        "This reply belongs to a draft this browser no longer has - draft again.");
    }
    if (text(reply.exportId) !== text(draft.exportId)) {
      return refusal("unknown_draft",
        "This reply belongs to a different draft. Draft this item again, or use the file that came from this one.");
    }
    if (Number(reply.schemaVersion) !== SCHEMA_VERSION) {
      return refusal("schema_version",
        "This reply uses format version " + reply.schemaVersion + "; this build understands " + SCHEMA_VERSION + ".");
    }
    if (text(reply.artifactType) !== draft.identity.artifactInternalName) {
      return refusal("artifact_mismatch", "This reply was drafted for a different kind of record.");
    }
    if (text(reply.sourceLanguage) !== draft.identity.sourceLanguage ||
        text(reply.targetLanguage) !== draft.identity.targetLanguage) {
      return refusal("language_mismatch",
        "This reply is " + text(reply.sourceLanguage) + " to " + text(reply.targetLanguage) +
        "; this page is " + draft.identity.sourceLanguage + " to " + draft.identity.targetLanguage + ".");
    }
    const rows = replyRows(reply);
    if (!rows) return refusal("rows_missing", "The reply has no `rows` array.");
    if (rows.length > MAX_REPLY_ROWS) {
      return refusal("too_many_rows",
        "That reply has " + rows.length + " rows; the limit is " + MAX_REPLY_ROWS + ".");
    }
    const seen = new Set();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!isObject(row)) return refusal("row_shape", "Row " + (i + 1) + " of the reply is not an object.");
      const key = String(row.k);
      if (seen.has(key)) {
        return refusal("duplicate_key", "Two rows in the reply both claim k " + key + ".");
      }
      seen.add(key);
      if (row.target !== undefined && typeof row.target !== "string") {
        return refusal("target_type", "Row k " + key + " returned a " +
          (row.target === null ? "null" : Array.isArray(row.target) ? "array" : typeof row.target) +
          " rather than text.");
      }
      if (typeof row.target === "string" && row.target.length > MAX_TARGET_CHARS) {
        return refusal("target_too_large",
          "Row k " + key + " returned " + row.target.length + " characters; the limit is " + MAX_TARGET_CHARS + ".");
      }
    }
    return null;
  }

  /*
   * Re-derive every group from the live model rather than trusting the draft's
   * membership: a variable renamed into a collision between draft and apply is
   * exactly the case a remembered list would miss.
   */
  function evaluateReply(options) {
    const opts = options || {};
    const draft = opts.draft;
    const reply = isObject(opts.reply) ? opts.reply : {};
    const envelopeRefusal = checkEnvelope(draft, reply);
    if (envelopeRefusal) return envelopeRefusal;

    const read = readFields(opts.content);
    const pageRefusal = checkPage(draft, opts.identity, read.elementCount);
    if (pageRefusal) return pageRefusal;

    const grouped = groupByDestination(read.fields);
    const byIdentity = new Map();
    read.fields.forEach((field) => {
      const list = byIdentity.get(field.identityKey) || [];
      list.push(field);
      byIdentity.set(field.identityKey, list);
    });

    const returned = new Map();
    replyRows(reply).forEach((row) => returned.set(String(row.k), row));

    const rows = [];
    const keys = Object.keys(draft.map).sort((a, b) => Number(a) - Number(b));

    keys.forEach((key) => {
      const entry = draft.map[key];
      const row = returned.get(key);
      const base = {
        k: Number(key),
        kind: text(entry.kind),
        context: text(entry.context),
        source: text(entry.source),
        elementId: entry.elementId,
        maxLength: entry.maxLength,
        shared: (entry.members || []).length > 1,
        members: [],
        target: "",
        warning: null,
        overridable: false,
        overrideApplied: false,
        overrideVoid: false,
      };
      if (!row) {
        rows.push(Object.assign(base, { verdict: VERDICT.NOT_RETURNED, status: "skip" }));
        return;
      }
      const target = text(row.target);
      base.target = target;

      /*
       * Resolve the drafted rows by record identity before anything else. A
       * translated_field's destination key contains its own source string, so
       * an edit to the English text moves the destination as well as the value
       * - looking the group up by the drafted key first would report that as a
       * vanished row rather than as the changed source it is.
       */
      const drafted = new Map((entry.members || []).map((member) => [member.identityKey, member]));
      const resolved = [];
      let missing = false;
      drafted.forEach((member, key) => {
        const live = byIdentity.get(key) || [];
        if (!live.length) missing = true;
        live.forEach((field) => resolved.push({ field, member }));
      });
      if (missing || !resolved.length) {
        rows.push(Object.assign(base, { verdict: VERDICT.MISSING, status: "skip" }));
        return;
      }

      const displayOf = (field) => ({
        identityKey: field.identityKey,
        elementId: field.elementId,
        fieldIndex: field.fieldIndex,
        liveTarget: field.target,
        liveSource: field.source,
        locked: field.locked,
      });
      base.members = resolved.map((entryPair) => displayOf(entryPair.field));

      const moved = resolved.find((pair) => hashText(pair.field.source) !== pair.member.sourceHash);
      if (moved) {
        rows.push(Object.assign(base, {
          verdict: VERDICT.SOURCE_CHANGED,
          status: "skip",
          detail: { member: moved.field.identityKey, elementId: moved.field.elementId },
        }));
        return;
      }

      /*
       * Only now is the destination stable, so membership can be re-derived
       * from the live model. A variable renamed into this collision after the
       * draft appears here as a member the user never reviewed.
       */
      const liveGroup = grouped.byKey.get(resolved[0].field.destinationKey);
      const liveMembers = liveGroup ? liveGroup.members : resolved.map((pair) => pair.field);
      base.members = liveMembers.map(displayOf);
      base.shared = liveMembers.length > 1;

      const stranger = liveMembers.find((member) => !drafted.has(member.identityKey));
      if (stranger) {
        rows.push(Object.assign(base, {
          verdict: VERDICT.NOT_EXPORTED,
          status: "skip",
          detail: { member: stranger.identityKey, elementId: stranger.elementId },
        }));
        return;
      }

      if (!target) {
        /* Never an instruction to erase: an empty translated value reaching the
         * platform's save deletes the stored row, and for a translated_field
         * that row is shared by every item using the same source string. */
        rows.push(Object.assign(base, { verdict: VERDICT.BLANK, status: "skip" }));
        return;
      }

      /* Blocks, evaluated against every current member of the group: filling
       * one member of a shared destination rewrites the stored row for all of
       * them, so a locked member is not something to fill around. */
      const locked = liveMembers.find((member) => member.locked);
      if (locked) {
        rows.push(Object.assign(base, {
          verdict: VERDICT.LOCKED,
          status: "block",
          detail: { member: locked.identityKey, elementId: locked.elementId },
        }));
        return;
      }

      const limit = liveMembers.reduce((low, member) => Math.min(low, member.limit), entry.maxLength);
      if (target.length > limit) {
        rows.push(Object.assign(base, {
          verdict: VERDICT.TOO_LONG,
          status: "block",
          detail: { length: target.length, maxLength: limit },
        }));
        return;
      }

      if (liveMembers.every((member) => member.target === target)) {
        rows.push(Object.assign(base, { verdict: VERDICT.UNCHANGED, status: "skip" }));
        return;
      }

      const edited = liveMembers.find(
        (member) => member.target !== drafted.get(member.identityKey).targetBaseline
      );
      if (edited) {
        const override = overrideFor(opts.overrides, base.k);
        const holds = overrideHolds(override, base.members);
        if (!holds) {
          rows.push(Object.assign(base, {
            verdict: VERDICT.EDITED,
            status: "skip",
            overridable: true,
            overrideVoid: !!override,
            detail: { member: edited.identityKey, elementId: edited.elementId },
          }));
          return;
        }
        base.overridable = true;
        base.overrideApplied = true;
      }

      const warning = placeholdersDiffer(liveMembers[0].source, target) ? "placeholder" : null;
      rows.push(Object.assign(base, {
        verdict: VERDICT.FILL,
        status: "fill",
        warning,
        detail: warning ? { source: placeholders(liveMembers[0].source), target: placeholders(target) } : undefined,
      }));
    });

    const unknown = [];
    returned.forEach((row, key) => {
      if (!Object.prototype.hasOwnProperty.call(draft.map, key)) {
        unknown.push({ k: row.k, verdict: VERDICT.UNKNOWN_ROW, status: "skip", target: text(row.target) });
      }
    });

    rows.forEach((row) => {
      /* A placeholder warning is advisory, so the row stays fillable but is not
       * ticked for the user; a block or a skip is never selected. */
      row.defaultSelected = row.status === "fill" && !row.warning;
      row.selectable = row.status === "fill";
    });

    const counts = {
      fill: rows.filter((row) => row.status === "fill").length,
      warned: rows.filter((row) => row.status === "fill" && row.warning).length,
      blocked: rows.filter((row) => row.status === "block").length,
      skipped: rows.filter((row) => row.status === "skip").length,
      notReturned: rows.filter((row) => row.verdict === VERDICT.NOT_RETURNED).length,
      unknown: unknown.length,
      ignoredKeys: countIgnoredKeys(reply),
    };

    return {
      ok: true,
      rows,
      unknown,
      counts,
      liveElementCount: read.elementCount,
      liveFieldCount: read.fieldCount,
    };
  }

  /* -------------------------------------------------------------- the apply */

  /*
   * The instruction set handed to the MAIN-world writer. Every member carries
   * the value it was reviewed against, so the writer verifies against the model
   * it is about to mutate rather than trusting this snapshot.
   */
  function buildApplyPlan(options) {
    const opts = options || {};
    const evaluation = opts.evaluation || {};
    const rows = Array.isArray(evaluation.rows) ? evaluation.rows : [];
    const chosen = Array.isArray(opts.selection)
      ? new Set(opts.selection.map(Number))
      : null;
    const fills = [];
    const refused = [];
    rows.forEach((row) => {
      const wanted = chosen ? chosen.has(row.k) : row.defaultSelected;
      if (!wanted) return;
      if (row.status !== "fill") {
        refused.push({ k: row.k, verdict: row.verdict });
        return;
      }
      fills.push({
        k: row.k,
        value: row.target,
        members: row.members.map((member) => ({
          identityKey: member.identityKey,
          elementId: member.elementId,
          fieldIndex: member.fieldIndex,
          expectedSourceHash: hashText(member.liveSource),
          expectedTarget: member.liveTarget,
        })),
      });
    });
    return { fills, refused, fieldCount: fills.reduce((n, fill) => n + fill.members.length, 0) };
  }

  function indexByIdentity(fields) {
    const index = new Map();
    fields.forEach((field) => {
      const list = index.get(field.identityKey) || [];
      list.push(field);
      index.set(field.identityKey, list);
    });
    return index;
  }

  /*
   * Build the array the page's own updateDocumentContent event will carry. The
   * merge writes translatedValue and nothing else: a key outside the platform's
   * named set would be promoted into additionalParameters and posted to the
   * server on Publish, so no correlation id, hash or marker is ever parked on
   * the model.
   */
  function buildMergedContent(options) {
    const opts = options || {};
    const elements = contentArray(opts.content);
    const clone = JSON.parse(JSON.stringify(elements));
    const read = readFields(elements);
    const index = indexByIdentity(read.fields);
    const applied = [];
    const stale = [];

    (opts.plan && opts.plan.fills ? opts.plan.fills : []).forEach((fill) => {
      const targets = [];
      let ok = true;
      fill.members.forEach((member) => {
        const matches = index.get(member.identityKey) || [];
        if (!matches.length) { ok = false; return; }
        matches.forEach((field) => {
          if (field.locked ||
              hashText(field.source) !== member.expectedSourceHash ||
              field.target !== text(member.expectedTarget)) {
            ok = false;
            return;
          }
          targets.push(field);
        });
      });
      if (!ok || !targets.length) {
        stale.push({ k: fill.k });
        return;
      }
      targets.forEach((field) => {
        clone[field.elementIndex].fieldInfo[field.fieldIndex].translatedValue = fill.value;
        applied.push({ k: fill.k, identityKey: field.identityKey, value: fill.value });
      });
    });

    return { content: clone, applied, stale };
  }

  /*
   * What the toast is allowed to report: fields read back out of the model that
   * actually hold the value that was intended for them, never the number that
   * was attempted.
   */
  function countApplied(content, plan) {
    const read = readFields(content);
    const index = indexByIdentity(read.fields);
    let count = 0;
    (plan && plan.fills ? plan.fills : []).forEach((fill) => {
      fill.members.forEach((member) => {
        (index.get(member.identityKey) || []).forEach((field) => {
          if (field.target === fill.value) count += 1;
        });
      });
    });
    return count;
  }

  globalThis.SNTranslationAssistant = {
    SCHEMA_VERSION,
    DRAFT_LIMIT,
    MAX_REPLY_CHARS,
    MAX_REPLY_ROWS,
    MAX_TARGET_CHARS,
    DESTINATION_LIMITS,
    SUPPORTED_ARTIFACT_TYPES,
    FIELD_KEYS,
    REASON,
    VERDICT,
    BLOCKED_VERDICTS,
    hashText,
    randomExportId,
    foldSourceKey,
    placeholders,
    placeholdersDiffer,
    identityKey,
    destinationKey,
    limitFor,
    exclusionFor,
    readFields,
    groupByDestination,
    buildPrompt,
    serializePayload,
    buildDraft,
    storedDraft,
    createDraftStore,
    putDraft,
    getDraft,
    parseReply,
    checkPage,
    evaluateReply,
    buildApplyPlan,
    buildMergedContent,
    countApplied,
  };
})();

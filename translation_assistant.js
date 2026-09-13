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
    UNCERTAIN_DESTINATION: "uncertain_destination",
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
   * Two 32-bit rolling hashes over the same string - one is FNV-1a, the second
   * mixes the index in with a different multiplier - concatenated with the
   * length. It is not standard 64-bit FNV-1a and it is not cryptographic: it
   * exists only to detect that a source string moved between draft and apply.
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
   * How the platform decides that two source strings are one stored
   * translation. `sys_translated.value` holds the source key lower-cased, and
   * the column's collation folds a good deal more than case on top of that, so
   * a fold that stops at toLowerCase() leaves rows the server unifies looking
   * like separate destinations - which is a lock bypass, since filling one
   * would rewrite the stored row a locked one shares.
   *
   * Measured 2026-09-09 on both the PDI and the configured customer
   * development instance, by querying real rows with variants of their own key
   * (`tooling/probe-sys-translated-fold-battery.*`). Identical on both: of 76
   * variants across 15 base letters, the server folds 68 - every precomposed
   * Latin accent tested, plus the Turkish dotless i, plus the eszett, which
   * folds to a single "s" and NOT to "ss" as Unicode case folding would have
   * it. It does not fold a decomposed accent, o/d/l/t with stroke, eng, eth,
   * ae or oe.
   *
   * This fold matches those 68 and is deliberately wider on six of the
   * remaining eight. Wider is the safe direction: it can only put more rows in
   * a group, and a group is all-or-nothing, so it blocks more and can never
   * let a locked member be rewritten through an unlocked one. Narrower is the
   * bypass. Anything added here must keep that direction.
   */
  const COMBINING_MARK = /\p{Mn}/u;
  /* Measured to fold, and not reachable by decomposing the character. */
  const FOLD_NON_DECOMPOSING = new Map([
    [0x0131, "i"],  // dotless i - the server folds it, NFD does not reach it
    [0x00df, "s"],  // eszett - to one s, measured, not the Unicode "ss"
  ]);
  /* Measured: a key stored with trailing spaces is returned by a query for the
   * trimmed form, on the same row. Leading spaces, doubled internal spaces,
   * newlines and a non-breaking space are all measured NOT to fold. */
  const TRAILING_SPACES = / +$/;

  function foldSourceKey(value) {
    const lowered = text(value).toLowerCase();
    let folded = "";
    for (const character of lowered) {
      const code = character.codePointAt(0);
      if (FOLD_NON_DECOMPOSING.has(code)) {
        folded += FOLD_NON_DECOMPOSING.get(code);
        continue;
      }
      /* Decompose one character at a time and keep its base letter. A
       * precomposed accent folds; a combining mark that was already standing on
       * its own in the source does not, because the server keeps those apart. */
      const decomposed = character.normalize("NFD");
      const base = decomposed[0];
      folded += (decomposed.length > 1 && COMBINING_MARK.test(decomposed[1])) ? base : character;
    }
    return folded.replace(TRAILING_SPACES, "");
  }

  /*
   * The other key, and the reason there are two.
   *
   * foldSourceKey answers "does the platform store one translation for these
   * two strings?", and it is used to DEDUPLICATE - to export two rows as one
   * and write one answer to both. A false equivalence there hides a source
   * string from the model and overwrites a different one, so it may only carry
   * equivalences that were measured.
   *
   * But the same question also decides what to BLOCK, and there the error runs
   * the other way: an equivalence the engine misses is a lock bypass, because
   * filling one row rewrites the stored row another one shares. Measurement
   * cannot cover every script and every whitespace form, so what is left over
   * needs a third answer besides "same" and "different": *unproven*.
   *
   * suspectSourceKey is that answer. Two rows whose folded keys differ but
   * whose suspect keys match might share a destination, so the engine refuses
   * to fill either of them and says why - rather than silently deduplicating
   * them, which would be the content error, or silently treating them as
   * independent, which would be the lock bypass.
   *
   * It carries only the whitespace forms no stored key on either instance was
   * available to test: a trailing tab, and an internal tab. Everything the
   * probe did settle stays out, so a measured-distinct pair is never blocked.
   */
  const TRAILING_WHITESPACE = /\s+$/;
  const INTERNAL_TABS = /\t+/g;

  function suspectSourceKey(value) {
    return foldSourceKey(text(value).replace(INTERNAL_TABS, " "))
      .replace(TRAILING_WHITESPACE, "");
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

  /* The same address under the looser key. Only string-scoped rows can collide
   * this way; a record-scoped destination is a sys_id and needs no guessing. */
  function suspectDestinationKey(field) {
    const p = field.params || {};
    const type = fieldType(p);
    if (!STRING_SCOPED_TYPES.has(type)) return null;
    return ["string", type, text(p.table), text(p.name), suspectSourceKey(field.source)].join(UNIT);
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
    /*
     * Destinations that are only PROBABLY distinct. Two groups whose folded
     * keys differ but whose suspect keys match may be one stored row, and the
     * engine cannot tell. Deduplicating them would write one answer over two
     * different source strings; treating them as independent would let filling
     * one rewrite the other's lock. Neither is acceptable on a guess, so both
     * groups are refused and the panel says which field it could not separate.
     */
    const bySuspect = new Map();
    order.forEach((group) => {
      const suspect = suspectDestinationKey(group.members[0]);
      if (!suspect) return;
      const seen = bySuspect.get(suspect) || [];
      seen.push(group);
      bySuspect.set(suspect, seen);
    });
    bySuspect.forEach((groups) => {
      if (groups.length < 2) return;
      groups.forEach((group) => {
        group.uncertainWith = groups
          .filter((other) => other !== group)
          .map((other) => other.members[0].elementId);
        group.members.forEach((member) => { member.exclusion = REASON.UNCERTAIN_DESTINATION; });
      });
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
   * The page reports its language pair as sys_language ids ("fr") and a person
   * reads names ("French"). sys_language holds both, in the id and name columns
   * Translation Lens already reads, so the runner asks it for the pair.
   *
   * An id goes into that query only when it is shaped like one - a letter, then
   * letters, digits, _ or -, as Translation Lens accepts it. The ids are page
   * text, and that shape admits no caret, comma or colon, so a filter cannot be
   * appended and a javascript: value, which the server would run rather than
   * match, cannot be sent.
   */
  const LANGUAGE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

  function languageNameQuery(identity) {
    const ids = [text(identity && identity.sourceLanguage), text(identity && identity.targetLanguage)]
      .filter((id) => LANGUAGE_ID_PATTERN.test(id));
    return ids.length ? "idIN" + Array.from(new Set(ids)).join(",") : "";
  }

  /* A name only when the rows give exactly one for the id. No row, a blank name,
   * or two rows that disagree leave it empty, and buildDraft then shows the
   * code - which is all the page gave, and what the draft showed before. */
  function languageNames(rows, identity) {
    const found = new Map();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const id = text(row && row.id).toLowerCase();
      const name = text(row && row.name).trim();
      if (!id || !name) return;
      if (!found.has(id)) found.set(id, new Set());
      found.get(id).add(name);
    });
    const nameFor = (value) => {
      const id = text(value);
      if (!LANGUAGE_ID_PATTERN.test(id)) return "";
      const names = found.get(id.toLowerCase());
      return names && names.size === 1 ? Array.from(names)[0] : "";
    };
    return {
      sourceLanguageName: nameFor(identity && identity.sourceLanguage),
      targetLanguageName: nameFor(identity && identity.targetLanguage),
    };
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
    const params = field.params || {};
    return {
      elementId: field.elementId,
      groupName: field.groupName,
      label: field.label,
      fieldIndex: field.fieldIndex,
      reason: field.exclusion,
      type: field.type,
      /* Enough for the panel to show an excluded field and link to where its
       * translation is kept, without the panel knowing which store a type
       * lives in: that mapping stays here, beside the type sets themselves. */
      source: field.source,
      target: field.target,
      table: text(params.table),
      column: text(params.name),
      sysId: text(params.sysId),
      store: STRING_SCOPED_TYPES.has(field.type) ? "sys_translated"
        : (RECORD_SCOPED_TYPES.has(field.type) ? "sys_translated_text" : ""),
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
    /* Fields covered by an exported row, which is not the number of rows: two
     * fields sharing one destination are one row and two fields. The panel
     * presents its tally as arithmetic against fieldCount, so it needs the
     * field number; the payload and the preview are addressed by row. */
    let eligibleFields = 0;
    /* Exported rows the platform stores by source string rather than by
     * record. Publishing one of these changes that translation for every
     * artifact on the instance whose field carries the same source string,
     * whether or not anything on THIS item shares it. */
    /* Listed rather than counted, so the panel can name each one and link to
     * every field that shares its text -- a claim the user can check. */
    const instanceWide = [];

    grouped.groups.forEach((group) => {
      const eligible = group.members.every((member) => !member.exclusion);
      if (!eligible) {
        group.members.forEach((member) => excluded.push(excludedEntry(member)));
        return;
      }
      k += 1;
      const lead = group.members[0];
      eligibleFields += group.members.length;
      if (STRING_SCOPED_TYPES.has(lead.type)) {
        instanceWide.push({
          k,
          kind: lead.label,
          context: lead.groupName,
          source: lead.source,
          /* The platform's own (table, column) for this field, straight from
           * additionalParameters and never inferred, so a list built from them
           * holds exactly the records the stored row is keyed against. */
          table: text(lead.params && lead.params.table),
          column: text(lead.params && lead.params.name),
        });
      }
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

    const counts = {
      fields: read.fieldCount,
      elements: read.elementCount,
      eligible: rows.length,
      eligibleFields,
    };
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
      /* Display names when the page supplied them, codes when it did not. Kept
       * beside identity rather than inside it: identity is compared against a
       * fresh read and a display name is not part of that comparison. */
      languages: {
        sourceLanguage: identity.sourceLanguage,
        targetLanguage: identity.targetLanguage,
        sourceLanguageName: sourceName,
        targetLanguageName: targetName,
      },
      /* How many exported rows fill more than one field OF THIS ITEM. This is
       * local multiplicity and nothing else: it explains why the tally's field
       * count and row count differ. It is NOT the shared-translation warning,
       * which is instanceWideRows -- a row with one local member is still
       * shared instance-wide when the platform keys it by source string. */
      sharedRows: Object.keys(map).filter((key) => (map[key].members || []).length > 1).length,
      instanceWideRows: instanceWide.length,
      instanceWide,
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
    INELIGIBLE: "ineligible",
  });

  const BLOCKED_VERDICTS = new Set([VERDICT.LOCKED, VERDICT.TOO_LONG]);

  /*
   * An exclusion that applies to this field as the model reads right now. A
   * draft can outlive a change in how the page represents a field - a plain
   * row that comes back as rich text is the case that matters, because that is
   * the one this feature must never fill - so eligibility is re-tested against
   * the live read rather than trusted from draft time.
   *
   * A member marked only because a group-mate is ineligible is not itself the
   * offender; the caller finds that one by scanning the rest of the group.
   */
  function ineligibilityOf(field) {
    if (field.locked) return VERDICT.LOCKED;
    if (field.exclusion &&
        field.exclusion !== REASON.SHARED_WITH_INELIGIBLE &&
        field.exclusion !== REASON.LOCKED) {
      return VERDICT.INELIGIBLE;
    }
    return null;
  }

  /* Why a live field can no longer take the value it was reviewed for, or null
   * when it still can. The order mirrors evaluateReply's deliberately: both
   * refuse either way, but the two must not name different reasons for the same
   * field or a report will contradict the preview the user just read. */
  function memberFailure(field, member) {
    const blocking = ineligibilityOf(field);
    if (blocking === VERDICT.INELIGIBLE) return blocking;
    if (hashText(field.source) !== member.expectedSourceHash) return VERDICT.SOURCE_CHANGED;
    if (blocking) return blocking;
    if (field.target !== text(member.expectedTarget)) return VERDICT.EDITED;
    return null;
  }

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

  /*
   * A reply is JSON from a language model, so every value in it is a shape
   * before it is a value. `{"toString": null}` is valid JSON and turns String()
   * and Number() into a TypeError, which would leave the panel with a thrown
   * exception instead of a refusal it can show. Nothing is coerced until it is
   * known to be a primitive, and nothing non-primitive is interpolated into a
   * message.
   */
  function isPrimitiveValue(value) {
    const type = typeof value;
    return type === "string" || type === "number" || type === "boolean";
  }

  function describeValue(value) {
    if (value === null) return "null";
    if (isPrimitiveValue(value)) return String(value);
    if (Array.isArray(value)) return "a list";
    return "an object";
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
    if (!isPrimitiveValue(reply.schemaVersion) || Number(reply.schemaVersion) !== SCHEMA_VERSION) {
      return refusal("schema_version",
        "This reply's format version is " + describeValue(reply.schemaVersion) +
        "; this build understands " + SCHEMA_VERSION + ".");
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
      if (!isPrimitiveValue(row.k)) {
        return refusal("key_shape", "Row " + (i + 1) + " of the reply has no usable k.");
      }
      const key = String(row.k);
      if (seen.has(key)) {
        return refusal("duplicate_key", "Two rows in the reply both claim k " + key + ".");
      }
      seen.add(key);
      if (row.target !== undefined && typeof row.target !== "string") {
        return refusal("target_type",
          "Row k " + key + " returned " + describeValue(row.target) + " rather than text.");
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

      /* Eligibility is re-tested against this read, not carried from the draft:
       * a row the page now represents as rich text is one R1 must not fill,
       * whatever it was when the draft was made. Locked has its own verdict
       * below, so it is not folded in here. */
      const ineligible = resolved.find((pair) => ineligibilityOf(pair.field) === VERDICT.INELIGIBLE);
      if (ineligible) {
        rows.push(Object.assign(base, {
          verdict: VERDICT.INELIGIBLE,
          status: "skip",
          detail: {
            reason: ineligible.field.exclusion,
            member: ineligible.field.identityKey,
            elementId: ineligible.field.elementId,
          },
        }));
        return;
      }

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

      /*
       * Against every member, not just the first. One translation covers the
       * whole destination group, and grouping folds capitalisation, so members
       * can carry placeholders this target matches and placeholders it does
       * not. Warning on the first member alone lets a real substitution loss
       * through as a clean fill.
       */
      const lost = liveMembers.find((member) => placeholdersDiffer(member.source, target));
      const warning = lost ? "placeholder" : null;
      rows.push(Object.assign(base, {
        verdict: VERDICT.FILL,
        status: "fill",
        warning,
        detail: warning
          ? {
            source: placeholders(lost.source),
            target: placeholders(target),
            member: lost.identityKey,
            elementId: lost.elementId,
          }
          : undefined,
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
    const grouped = groupByDestination(read.fields);
    const index = indexByIdentity(read.fields);
    const applied = [];
    const stale = [];

    (opts.plan && opts.plan.fills ? opts.plan.fills : []).forEach((fill) => {
      const planned = new Map((fill.members || []).map((member) => [member.identityKey, member]));
      const targets = [];
      let missing = false;
      planned.forEach((member, key) => {
        const matches = index.get(key) || [];
        if (!matches.length) missing = true;
        matches.forEach((field) => targets.push({ field, member }));
      });
      if (missing || !targets.length) {
        stale.push({ k: fill.k, reason: VERDICT.MISSING });
        return;
      }

      const failed = targets.find((pair) => memberFailure(pair.field, pair.member));
      if (failed) {
        stale.push({ k: fill.k, reason: memberFailure(failed.field, failed.member) });
        return;
      }

      /*
       * Rederive the destination group from the content about to be mutated,
       * exactly as the preview did. A row renamed into this collision between
       * preview and merge is a member the user never reviewed, and filling
       * around it would rewrite its shared row on Publish - which is the same
       * lock bypass the group rule exists to close, reached a step later.
       */
      const group = grouped.byKey.get(targets[0].field.destinationKey);
      const members = group ? group.members : targets.map((pair) => pair.field);
      if (members.some((field) => !planned.has(field.identityKey))) {
        stale.push({ k: fill.k, reason: VERDICT.NOT_EXPORTED });
        return;
      }

      targets.forEach((pair) => {
        const field = pair.field;
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
    suspectSourceKey,
    suspectDestinationKey,
    placeholders,
    placeholdersDiffer,
    identityKey,
    destinationKey,
    limitFor,
    exclusionFor,
    readFields,
    groupByDestination,
    languageNameQuery,
    languageNames,
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

/*
 * Impersonate — find a user by identity, attribute, role or group, and hand the
 * panel a verified row to impersonate. Bounded reads, live schema resolution,
 * safe query construction and client-side verification, exactly as Record Lens
 * does them; this file adds the role and group intersections and the
 * eligibility safety rule.
 *
 * DOM-free on purpose, so the suite runs the real engine under node:vm. The
 * mutation lives in background.js and never touches this file: nothing here
 * writes, and nothing here learns the original account.
 *
 * Lazily injected after record_search.js, whose anchor extraction, ranking and
 * Table API transport this reuses rather than restating.
 */
(function () {
  if (globalThis.SNImpersonate) return;

  /* Fixed in the engine. No caller anywhere supplies a table name. */
  const USER_TABLE = "sys_user";
  const ROLE_TABLE = "sys_user_role";
  const MEMBERSHIP_TABLE = "sys_user_has_role";
  /* Role containment, read for the confirmation alone. Verified on the PDI and
   * a customer instance: `role` is the parent and `contains` the role it
   * brings with it. */
  const CONTAINMENT_TABLE = "sys_user_role_contains";
  /* Verified live: sys_user_grmember is `user` + `group` and nothing else --
   * no state, no inherited flag. It is DIRECT membership, which is what the
   * platform's own Group Members list shows. */
  const GROUP_TABLE = "sys_user_group";
  const GROUP_MEMBER_TABLE = "sys_user_grmember";
  const DICTIONARY_TABLE = "sys_dictionary";
  const CHOICE_TABLE = "sys_choice";
  const PROPERTY_TABLE = "sys_properties";
  /* Record Lens's hierarchy walk reads this on our behalf, through our
   * transport -- so leaving it out did not merely make the allowlist an
   * incomplete description, it made the walk fail silently and pin sys_user's
   * hierarchy to sys_user on any instance that had extended it. */
  const TABLE_METADATA_TABLE = "sys_db_object";
  const TABLE_ALLOWLIST = Object.freeze([
    USER_TABLE, ROLE_TABLE, MEMBERSHIP_TABLE, CONTAINMENT_TABLE, GROUP_TABLE,
    GROUP_MEMBER_TABLE, DICTIONARY_TABLE, CHOICE_TABLE, PROPERTY_TABLE, TABLE_METADATA_TABLE,
  ]);

  /*
   * The candidate window for a TEXT search. Role-only reads a different,
   * larger window (below) because its population comes from the membership
   * cap, not from this one.
   */
  const USER_CANDIDATE_LIMIT = 50;
  /*
   * Role-only, group-first and attribute-only read every id they collected, up
   * to the membership cap. Applying the 50-row text window here would silently halve
   * the population and then report an "eligible holders" count from whatever
   * survived.
   */
  const ROLE_ONLY_USER_LIMIT = 100;
  const RESULT_LIMIT = 20;
  const ROLE_SUGGESTION_CANDIDATE_LIMIT = 50;
  const ROLE_SUGGESTION_LIMIT = 20;
  /*
   * Bound for one role's membership read. Not a number a probe returned: it is
   * candidates x duplicates with headroom. The measured duplicate factor is
   * ~1.1 (itil 70 rows / 66 users, catalog 33 / 30), so 50 candidates is
   * roughly 55 rows.
   */
  const MEMBERSHIP_LIMIT = 100;
  /*
   * Group suggestions share the role picker's window, but not its query. On a
   * customer instance with 14,549 groups, the single longest word matched
   * hundreds or thousands -- "Service" 713, "Approval" 4,279 -- against 96 and
   * 168 with every word of the phrase AND-ed. So every word the user typed
   * becomes its own condition, up to this many.
   */
  const GROUP_SUGGESTION_CANDIDATE_LIMIT = 50;
  const GROUP_SUGGESTION_LIMIT = 20;
  const MAX_GROUP_ANCHORS = 4;
  /*
   * Big enough that a stock reference table fits whole -- core_country is 232
   * rows -- so the ordinary case is a complete dropdown rather than a
   * truncated list pretending to be one.
   */
  const ATTRIBUTE_VALUE_LIMIT = 300;
  const MAX_DICTIONARY_FIELDS = 250;
  /*
   * ServiceNow's own recent-impersonations list. The platform's dialog showed
   * six on a customer instance; this bound only stops an unexpectedly long
   * list from becoming an unbounded sys_idIN.
   */
  const RECENT_LIMIT = 10;
  /*
   * One account's effective roles, for the confirmation. Measured on a
   * customer instance: ordinary accounts held 115-135 effective roles and
   * admin holders 270-490, but only 3-6 of them directly. The bound sits well
   * above the largest measured, and a read that reaches it says so.
   */
  const USER_ROLE_LIMIT = 1000;
  /*
   * The containment read names every role one account holds. A sys_idIN of
   * ~400 ids answered 414 on a customer instance and 100 was fine, so the ids
   * go 100 at a time. The same instance's accounts held roles with 109-554
   * containment rows between them in total, so a chunk's bound sits well above
   * the largest measured -- and a chunk that reaches it gives containment up
   * rather than guessing.
   */
  const CONTAINMENT_CHUNK = 100;
  const CONTAINMENT_LIMIT = 1000;

  const MIN_USER_ANCHOR = 3;
  const MIN_ROLE_ANCHOR = 2;
  /* The endpoint key is sys_user.user_name, String, max_length 40. */
  const MAX_USER_NAME_LENGTH = 40;

  const REQUEST_TIMEOUT_MS = 20000;
  const OPTIONAL_READ_TIMEOUT_MS = 8000;

  const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;
  const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
  const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
  const SAFE_ANCHOR_PATTERN = /^[A-Za-z0-9_]+$/;
  /* sys_language.id shape, as Translation Lens accepts it. */
  const LANGUAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

  /*
   * The four text fields a person uses to recognise a colleague, and nothing
   * else. Never a generic sys_user field picker: that would expose contact,
   * integration and credential-adjacent columns which choosing a test identity
   * does not need.
   */
  const SEARCH_FIELDS = Object.freeze(["user_name", "name", "email", "title"]);
  /*
   * Without these the panel cannot do its job at all: it could not label a
   * result, could not key the endpoint, and could not prove a row is safe to
   * impersonate. Their absence is a schema error, never a silent degradation.
   */
  const REQUIRED_USER_FIELDS = Object.freeze(["user_name", "name", "active", "locked_out"]);
  /* Present on stock; omitted from search and display when an instance lacks them. */
  const OPTIONAL_USER_FIELDS = Object.freeze([
    "email", "title", "country", "department", "company", "web_service_access_only",
  ]);
  const DISPLAY_FIELDS = Object.freeze(["country", "department", "company"]);

  /*
   * Eligibility is a safety rule, not a filter. ServiceNow documents that
   * impersonating an inactive or locked account can terminate the operator's
   * own session, so an ineligible account must never be selectable -- there is
   * no "include unavailable users" toggle. user_nameISNOTEMPTY is doubly
   * required: the endpoint is keyed by that field, so a user without one
   * cannot be impersonated at all.
   */
  const ELIGIBILITY_CONDITIONS = Object.freeze([
    { field: "active", clause: "active=true" },
    { field: "locked_out", clause: "locked_out=false" },
    { field: "user_name", clause: "user_nameISNOTEMPTY" },
    /*
     * `web_service_access_only=false` on its own is WRONG, and wrong in the
     * direction that hides almost everybody. Measured on the PDI: 642 active
     * users, but only 83 match `=false` — the field is **empty**, not false,
     * on more than 500 of them, and `=false` does not match empty. Nor does
     * `!=true`, which returns the same 83. So the naive clause silently
     * reduced every search to the handful of accounts where someone had
     * explicitly set the flag; `abel.tuter` returned nothing at all.
     *
     * A read cannot reveal this. `sysparm_display_value=all` renders the empty
     * field as the string "false", so the row looks exactly like a user who
     * would match — only a query tells the two apart. That is the
     * blank-versus-omitted trap in a third form.
     *
     * Hence the OR group, and hence it must stay **last** in the clause list:
     * `^OR` binds to the condition immediately before it, so anything appended
     * after this would fall inside the OR and stop being required. Every
     * builder therefore puts eligibility last, after the attribute condition.
     */
    {
      field: "web_service_access_only",
      clause: "web_service_access_only=false^ORweb_service_access_onlyISEMPTY",
      mustBeLast: true,
    },
  ]);

  /*
   * The attribute filter offers filterable fields, not every column. The
   * exclusions are Record Lens's credential-adjacent set, widened by the names
   * a people table carries that a test identity never needs.
   */
  const SENSITIVE_FIELD_PATTERN =
    /(^|_)(value|body|html|content|script|password|passwd|secret|token|credential|api_key|pin|question|answer|ssn|photo|avatar)($|_)/i;
  const SENSITIVE_TYPE_PATTERN = /html|script|journal|password|encrypted/i;
  /*
   * Choice-backed strings and references are the only two shapes whose values
   * can be offered as a verified list. Everything else would need typing, and
   * a typed attribute is what the dropdown exists to avoid.
   */
  const CHOICE_STRING_TYPES = new Set(["string", "translated_field", "translated_text"]);
  const REFERENCE_TYPES = new Set(["reference"]);
  /*
   * sys_choice.inactive=false leaves one active row on stock whose label is a
   * raw expression and whose value is a sentinel:
   *   javascript:gs.getMessage('System ({0})', ...) / NULL_OVERRIDE
   * The platform evaluates a list-filter value naming that scheme instead of
   * matching it as words, and encoding the URL does not stop it. So the rule
   * Translation Assistant already applies to a list link applies here to a
   * picker option: any label or value naming the scheme is refused, anywhere
   * in the text and in any case, and the sentinel is not a country code.
   */
  const CHOICE_SENTINEL_VALUES = new Set(["NULL_OVERRIDE"]);

  const schemaCache = new Map();
  const languageCache = new Map();

  function createError(code, message, status) {
    const error = new Error(message);
    error.code = code;
    error.status = Number(status) || 0;
    return error;
  }

  /*
   * sysparm_display_value=all returns { value, display_value } for every field
   * including booleans and strings. An instance answering with scalars is
   * equally valid, so both shapes normalize rather than one being assumed.
   */
  function rawValue(value) {
    if (value == null) return "";
    if (typeof value === "object") {
      if (value.value != null) return String(value.value);
      if (value.display_value != null) return String(value.display_value);
      return "";
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
      return "";
    }
    return String(value);
  }

  function isTrue(value) {
    const text = rawValue(value).trim().toLowerCase();
    return text === "true" || text === "1";
  }

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  /* ------------------------------------------------------------------ *
   * Query safety
   * ------------------------------------------------------------------ */

  /*
   * The fixed set, plus -- for the attribute value list alone -- the one table
   * the live dictionary named as a discovered field's reference. That table is
   * not caller-provided: it arrives on a sys_dictionary row and is admitted
   * only after the schema has been asked to confirm it.
   */
  function assertSafeTable(table, alsoAllowed) {
    const value = text(table).toLowerCase();
    const permitted = TABLE_ALLOWLIST.concat(alsoAllowed ? [String(alsoAllowed).toLowerCase()] : []);
    if (!TABLE_NAME_PATTERN.test(value) || !permitted.includes(value)) {
      throw createError("validation", "Impersonate reads only its own fixed tables.");
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

  function assertSafeAnchor(anchor, minimum) {
    const value = String(anchor == null ? "" : anchor);
    if (!SAFE_ANCHOR_PATTERN.test(value) || value.length < minimum) {
      throw createError("validation", "Unsafe or too-short search anchor.");
    }
    return value;
  }

  function assertSafeSysId(sysId) {
    const value = text(sysId).toLowerCase();
    if (!SYS_ID_PATTERN.test(value)) {
      throw createError("validation", "A record identifier must be 32 hexadecimal characters.");
    }
    return value;
  }

  /*
   * Applies to a value that was never typed -- a chosen option, not an anchor.
   * It still has to be checked, because sys_choice ships a row whose value is
   * a sentinel and whose label is an expression.
   */
  function queryValueProblem(value) {
    const raw = String(value == null ? "" : value);
    if (/javascript\s*:/i.test(raw)) return "the instance would run this value as a script";
    if (!raw || !raw.trim()) return "this value is empty";
    if (raw.length > 255) return "this value is too long for a filter";
    if (/[\^\r\n]/.test(raw)) return "a filter cannot express this value";
    return "";
  }

  function longestUserRun(term) {
    const engine = globalThis.SNRecordSearch;
    /* Record Lens's minimum is the same 3 characters, so its extractor is the
     * one used rather than a second copy that could drift from it. */
    if (engine && typeof engine.extractAnchor === "function") {
      return engine.extractAnchor(term);
    }
    const match = String(term == null ? "" : term).match(/[A-Za-z0-9_]+/g) || [];
    const best = match.reduce((a, b) => (b.length > a.length ? b : a), "");
    return best.length >= MIN_USER_ANCHOR ? best : null;
  }

  /*
   * An email-shaped term anchors on its LOCAL part. The longest run of
   * "t.okonkwo@example.com" is the domain, which every colleague shares, so
   * the unordered 50-row window would fill with other people and the
   * complete-term check would then find nobody. User IDs are routinely
   * email-shaped, so this is the ordinary case, not an edge. Verification
   * still uses the whole term; only the server-side anchor moves.
   */
  function extractUserAnchor(term) {
    const raw = String(term == null ? "" : term);
    const at = raw.indexOf("@");
    if (at > 0) {
      const local = longestUserRun(raw.slice(0, at));
      if (local) return local;
    }
    return longestUserRun(raw);
  }

  function extractRoleAnchor(input) {
    const engine = globalThis.SNRecordSearch;
    if (engine && typeof engine.extractTableLookupAnchor === "function") {
      return engine.extractTableLookupAnchor(input);
    }
    const match = String(input == null ? "" : input).match(/[A-Za-z0-9_]+/g) || [];
    const best = match.reduce((a, b) => (b.length > a.length ? b : a), "");
    return best.length >= MIN_ROLE_ANCHOR ? best : null;
  }

  /* ------------------------------------------------------------------ *
   * Input parsing and the three query orders
   * ------------------------------------------------------------------ */

  /*
   * Four inputs, each present or absent, and the order each combination has
   * to run in. The rule is that EVERY condition narrows before the one cap:
   * a membership read carries the text, the attribute and eligibility as
   * dot-walks through `user`, so the window is spent only on rows that can
   * appear.
   *
   * Text used to win whenever it was there, reading 50 unordered text matches
   * and then asking which of them held the role or sat in the group. That
   * lost people. Measured on a customer instance: one surname matched 237
   * eligible users, the one group member among them was not in the 50 read,
   * and a group that plainly listed him answered "nobody". Reading the
   * membership with the text dot-walked found exactly him, and for a role
   * found exactly the 26 holders a full intersection finds.
   *
   * Group outranks role. A group is the narrower population -- median 3
   * members across 12,359 groups on a customer instance, where one common
   * role has thousands of holders -- so the role becomes an intersection over
   * at most one window of members. An exact sys_id is one row that nothing
   * can crowd out, so it stays user-first and intersects.
   */
  function searchOrder(input) {
    const term = text(input && input.term);
    const hasRole = Boolean(input && text(input.roleSysId));
    const hasGroup = Boolean(input && text(input.groupSysId));
    const hasAttribute = Boolean(
      input && input.attribute && text(input.attribute.field) && text(input.attribute.value)
    );
    if (term && SYS_ID_PATTERN.test(term)) return "user-first";
    if (hasGroup) return "group-first";
    if (hasRole) return "role-first";
    if (term) return "user-first";
    if (hasAttribute) return "attribute-first";
    return "none";
  }

  function parseAttribute(attribute) {
    if (!attribute) return null;
    const field = text(attribute.field);
    const value = String(attribute.value == null ? "" : attribute.value);
    if (!field && !value) return null;
    if (!field || !FIELD_NAME_PATTERN.test(field)) {
      return { ok: false, error: "Choose a field from the discovered list." };
    }
    if (!value) {
      return { ok: false, error: "Choose a value for the selected field." };
    }
    const problem = queryValueProblem(value);
    if (problem) {
      return { ok: false, error: "That value cannot be used as a filter: " + problem + "." };
    }
    if (CHOICE_SENTINEL_VALUES.has(value)) {
      return { ok: false, error: "That option is a platform placeholder, not a real value." };
    }
    return { ok: true, field, value, type: text(attribute.type) };
  }

  function parseSearch(input) {
    const raw = input || {};
    const term = text(raw.term);
    const roleSysId = text(raw.roleSysId);
    const groupSysId = text(raw.groupSysId);
    const attribute = parseAttribute(raw.attribute);
    if (attribute && !attribute.ok) {
      return { ok: false, code: "validation", error: attribute.error };
    }
    if (roleSysId && !SYS_ID_PATTERN.test(roleSysId)) {
      return {
        ok: false,
        code: "validation",
        error: "Choose a role from the suggestions rather than typing one.",
      };
    }
    if (groupSysId && !SYS_ID_PATTERN.test(groupSysId)) {
      return {
        ok: false,
        code: "validation",
        error: "Choose a group from the suggestions rather than typing one.",
      };
    }
    const order = searchOrder({ term, roleSysId, groupSysId, attribute: attribute || null });
    if (order === "none") {
      return {
        ok: false,
        code: "validation",
        error: "Enter a name, user ID, email or title, or choose a role, a group or an attribute.",
      };
    }
    const isSysId = SYS_ID_PATTERN.test(term);
    const anchor = term ? (isSysId ? term.toLowerCase() : extractUserAnchor(term)) : "";
    if (term && !anchor) {
      return {
        ok: false,
        code: "validation",
        error: "Enter at least " + MIN_USER_ANCHOR +
          " consecutive letters, numbers or underscores, or an exact sys_id.",
      };
    }
    return {
      ok: true,
      order,
      term,
      isSysId,
      anchor: anchor || "",
      roleSysId: roleSysId ? roleSysId.toLowerCase() : "",
      groupSysId: groupSysId ? groupSysId.toLowerCase() : "",
      attribute: attribute ? { field: attribute.field, value: attribute.value, type: attribute.type } : null,
    };
  }

  /* ------------------------------------------------------------------ *
   * Query builders
   * ------------------------------------------------------------------ */

  /*
   * `via` names a reference field to sys_user, and turns every term into a
   * dot-walk through it -- both halves of the OR group included, since a
   * prefix on the first half alone would leave the second testing a field the
   * membership table does not have.
   */
  function eligibilityClauses(schema, via) {
    const available = new Set((schema && schema.fieldNames) || []);
    const kept = ELIGIBILITY_CONDITIONS
      .filter((condition) => !schema || available.has(condition.field));
    /* The OR-group clause is only safe at the end, so its position is asserted
     * rather than assumed: a later edit that reorders the list would otherwise
     * quietly turn the conditions after it into optional ones. */
    kept.forEach((condition, index) => {
      if (condition.mustBeLast && index !== kept.length - 1) {
        throw createError("schema", "The eligibility conditions are in an unsafe order.");
      }
    });
    if (!via) return kept.map((condition) => condition.clause);
    const prefix = assertSafeField(via) + ".";
    return kept.map((condition) => condition.clause
      .split("^")
      .map((term) => (term.startsWith("OR") ? "OR" + prefix + term.slice(2) : prefix + term))
      .join("^"));
  }

  function attributeCondition(attribute, schema) {
    if (!attribute) return "";
    const field = assertSafeField(attribute.field);
    if (schema && schema.fieldNames && !schema.fieldNames.includes(field)) {
      throw createError("schema", "That field is no longer in the live dictionary.");
    }
    /* Bound to what the picker OFFERS, not merely to what exists: fieldNames
     * holds every live column, credential-adjacent ones included, and the
     * sensitive-field exclusion must hold here too, not only in the UI. */
    if (schema && schema.attributeFields &&
      !schema.attributeFields.some((item) => item.name === field)) {
      throw createError("schema", "That field is not one the attribute filter offers.");
    }
    const problem = queryValueProblem(attribute.value);
    if (problem) throw createError("validation", "That value cannot be used as a filter.");
    if (CHOICE_SENTINEL_VALUES.has(String(attribute.value))) {
      throw createError("validation", "That option is a platform placeholder, not a real value.");
    }
    /* Always an exact condition. Never a LIKE, which is why the three-character
     * minimum has nothing to say about it. */
    return field + "=" + attribute.value;
  }

  /*
   * Every user query has the same shape, and the order is load-bearing:
   *
   *   <selector>  ^  <attribute>  ^  <eligibility, OR group last>
   *
   * The selector goes first because a text search is an OR chain and `^OR`
   * binds to what precedes it. Eligibility goes LAST because its final clause
   * is itself an OR group (see ELIGIBILITY_CONDITIONS): anything appended
   * after it would be swallowed by that OR and stop being required.
   */
  function buildUserQuery(selector, schema, attribute) {
    const condition = attributeCondition(attribute, schema);
    return [selector]
      .concat(condition ? [condition] : [], eligibilityClauses(schema))
      .join("^");
  }

  /*
   * The OR chain for a typed term. `via` dot-walks every link through a
   * reference to sys_user, as eligibilityClauses does. The chain is safe
   * after another condition, which the live check settled: after `group=`, every
   * row returned was in that group, because `^OR` joins only the links of
   * the chain it follows.
   */
  function textChain(fields, anchor, via) {
    const safeAnchor = assertSafeAnchor(anchor, MIN_USER_ANCHOR);
    const safeFields = Array.from(new Set((fields || []).map(assertSafeField)));
    if (!safeFields.length) {
      throw createError("schema", "No verified identity fields are readable on this instance.");
    }
    const prefix = via ? assertSafeField(via) + "." : "";
    return safeFields
      .map((field, index) => (index ? "OR" : "") + prefix + field + "LIKE" + safeAnchor)
      .join("^");
  }

  function buildUserTextQuery(fields, anchor, schema, attribute) {
    return buildUserQuery(textChain(fields, anchor), schema, attribute);
  }

  /*
   * A membership population read: <selector> ^ <text> ^ <attribute> ^
   * <eligibility>, every term after the selector dot-walked through `user` --
   * the same order and the same reason as buildUserQuery.
   */
  function membershipPopulationQuery(selector, schema, attribute, anchor) {
    const condition = attributeCondition(attribute, schema);
    const fields = (schema && schema.searchFields) || SEARCH_FIELDS;
    return [selector]
      .concat(anchor ? [textChain(fields, anchor, "user")] : [])
      .concat(condition ? ["user." + condition] : [], eligibilityClauses(schema, "user"))
      .join("^");
  }

  function buildUserSysIdQuery(sysId, schema, attribute) {
    return buildUserQuery("sys_id=" + assertSafeSysId(sysId), schema, attribute);
  }

  function buildUserIdsQuery(sysIds, schema, attribute) {
    const ids = Array.from(new Set((sysIds || []).map(assertSafeSysId)));
    if (!ids.length) throw createError("empty", "No user records to read.");
    return buildUserQuery("sys_idIN" + ids.join(","), schema, attribute);
  }

  function buildAttributeOnlyQuery(schema, attribute) {
    const condition = attributeCondition(attribute, schema);
    if (!condition) throw createError("validation", "Choose a field and a value to filter by.");
    return [condition].concat(eligibilityClauses(schema)).join("^");
  }

  /*
   * sys_user_has_role is the EFFECTIVE role table -- direct grants, role
   * containment and group-derived grants alike. sys_user.roles is direct-only,
   * incomplete even at that, and substring-prone, so it is never read.
   *
   * Given candidates, it asks which of THEM hold the role. Given none, it is
   * the role-first population read, carrying the text, the attribute and
   * eligibility as dot-walks, exactly as the group read does. Verified on a
   * customer instance for three surnames: the dot-walked eligibility selected
   * precisely the holders a direct sys_user read calls eligible (26 of 41,
   * 31 of 67, 5 of 7), so without it half the window went on accounts that
   * can never be listed.
   */
  function buildMembershipQuery(roleSysId, userSysIds, schema, attribute, anchor) {
    const role = assertSafeSysId(roleSysId);
    if (userSysIds) {
      const ids = Array.from(new Set(userSysIds.map(assertSafeSysId)));
      if (!ids.length) throw createError("empty", "No candidates to intersect.");
      return ["userIN" + ids.join(","), "role=" + role, "state=active"].join("^");
    }
    return membershipPopulationQuery("role=" + role + "^state=active", schema, attribute, anchor);
  }

  function buildRoleQuery(anchor) {
    const safeAnchor = assertSafeAnchor(anchor, MIN_ROLE_ANCHOR);
    /* sys_user_role has no active field; inventing one would silently hide
     * every role on instances that do not have it. Name and description only. */
    return "nameLIKE" + safeAnchor + "^ORdescriptionLIKE" + safeAnchor;
  }

  /*
   * Two shapes. Given candidates, it asks which of THEM are members, and needs
   * nothing else: they were read eligible. Given none, it is the group-first
   * population read, and the text, the attribute and eligibility ride along
   * as dot-walks through `user`, so the cap is spent on members who could
   * appear in the list at all. Measured on a customer instance, 40-60% of a
   * group's members were eligible; without the dot-walk half the window was
   * waste.
   *
   * The dot-walk is verified to select exactly the set a direct sys_user read
   * selects -- on the PDI and on four customer groups of ~380 members each,
   * and for the text on a customer group against every one of 237 matches.
   * It is still never trusted alone: a misspelt dot-walked field is silently
   * IGNORED, returning the whole group unfiltered, so the sys_user read that
   * follows applies eligibility and the attribute again and every row is
   * checked for the complete term.
   */
  function buildGroupMemberQuery(groupSysId, userSysIds, schema, attribute, anchor) {
    const group = assertSafeSysId(groupSysId);
    if (userSysIds) {
      const ids = Array.from(new Set(userSysIds.map(assertSafeSysId)));
      if (!ids.length) throw createError("empty", "No candidates to intersect.");
      return "userIN" + ids.join(",") + "^group=" + group;
    }
    return membershipPopulationQuery("group=" + group, schema, attribute, anchor);
  }

  /*
   * Every run the user typed, longest first, as AND-ed name conditions. One
   * anchor is enough for roles; it is not for groups (see
   * GROUP_SUGGESTION_CANDIDATE_LIMIT for the measured difference).
   */
  function groupAnchors(input) {
    const runs = String(input == null ? "" : input).match(/[A-Za-z0-9_]+/g) || [];
    const unique = Array.from(new Set(runs.filter((run) => run.length >= MIN_ROLE_ANCHOR)));
    return unique
      .sort((a, b) => b.length - a.length)
      .slice(0, MAX_GROUP_ANCHORS);
  }

  function buildGroupQuery(anchors) {
    const safe = (anchors || []).map((anchor) => assertSafeAnchor(anchor, MIN_ROLE_ANCHOR));
    if (!safe.length) throw createError("validation", "Unsafe or too-short search anchor.");
    /* Name only. A description match is a sentence about a team, and at this
     * scale it would crowd the named group out of the window. No active
     * filter either: 2 of the measured groups had `active` EMPTY, which
     * `active=true` would hide -- inactive groups rank last instead. */
    return safe.map((anchor) => "nameLIKE" + anchor).join("^");
  }

  /* ------------------------------------------------------------------ *
   * Transport
   * ------------------------------------------------------------------ */

  function transportErrorCode(status) {
    if (status === 401 || status === 403) return "access";
    if (status === 404) return "schema";
    return "transient";
  }

  /*
   * No hostname, URL, query, email, username or sys_id ever appears here. A
   * restricted column is access, never empty: a blocked field must not read as
   * "no country set".
   */
  function transportErrorMessage(status) {
    if (status === 401) {
      return "ServiceNow did not authorize this read. Refresh the page or sign in again.";
    }
    if (status === 403) {
      return "You do not have read access to the user or role data this needs.";
    }
    if (status === 404) {
      return "The user or role tables are not exposed to the Table API here.";
    }
    if (status === 429) {
      return "ServiceNow is temporarily rate-limiting reads. Wait a moment and try again.";
    }
    if (status >= 500) {
      return "ServiceNow could not complete the read. Try again in a moment.";
    }
    return "The read did not reach ServiceNow. Check the page connection and try again.";
  }

  /*
   * The transport re-checks the table rather than trusting getRows, so it has
   * to be told which reference table getRows admitted. Re-checking against the
   * fixed list alone refused EVERY reference field's value list with "reads
   * only its own fixed tables" -- the injected transports in the suite never
   * reach this function, which is how that shipped.
   */
  async function defaultTransport(request, alsoAllowedTable) {
    const table = assertSafeTable(request.table, alsoAllowedTable);
    if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      throw createError("transient", "The Impersonate transport is unavailable.");
    }
    const response = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(
        () => finish(reject, createError(
          "transient",
          "ServiceNow took too long to complete the read. Try again.",
          0
        )),
        request.timeoutMs || REQUEST_TIMEOUT_MS
      );
      chrome.runtime.sendMessage({
        type: "SN_RECORD_SEARCH_GET",
        table,
        query: request.query || "",
        fields: request.fields || "",
        limit: request.limit || USER_CANDIDATE_LIMIT,
        options: request.options || {},
      }).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    });
    if (!response || !response.ok) {
      const status = (response && response.status) || 0;
      throw createError(transportErrorCode(status), transportErrorMessage(status), status);
    }
    return response.result || [];
  }

  async function getRows(get, request, alsoAllowedTable) {
    const table = assertSafeTable(request.table, alsoAllowedTable);
    const rows = await get(Object.assign({}, request, {
      table,
      options: Object.assign({ displayAll: true, excludeRefLinks: true }, request.options || {}),
    }), alsoAllowedTable);
    return Array.isArray(rows) ? rows : [];
  }

  /* ------------------------------------------------------------------ *
   * Schema
   * ------------------------------------------------------------------ */

  function normalizeDictionaryRow(row) {
    const name = rawValue(row && row.element);
    if (!FIELD_NAME_PATTERN.test(name)) return null;
    const definingTable = rawValue(row && row.name).toLowerCase();
    if (!TABLE_NAME_PATTERN.test(definingTable)) return null;
    const type = rawValue(row && row.internal_type).toLowerCase();
    const choice = rawValue(row && row.choice).trim();
    const reference = rawValue(row && row["reference.name"]).trim().toLowerCase();
    return {
      name,
      definingTable,
      type,
      /* The LIVE column_label, never a hardcoded one. On stock, country reads
       * "Country code"; on an instance that relabelled it, the same field reads
       * something else and the custom field is the one called "Country". */
      label: displayValue(row && row.column_label) || name,
      choice,
      reference: TABLE_NAME_PATTERN.test(reference) ? reference : "",
    };
  }

  function isSensitiveField(name, type) {
    return SENSITIVE_FIELD_PATTERN.test(String(name || "")) ||
      SENSITIVE_TYPE_PATTERN.test(String(type || ""));
  }

  function hasChoiceList(row) {
    const choice = String(row && row.choice || "").trim();
    return Boolean(choice) && choice !== "0" && choice !== "false";
  }

  /*
   * Discovered, never named. The field list is whatever the live dictionary
   * offers that can produce a verified value list, and it is NOT truncated:
   * Record Lens's "no more than six" is a limit on how many fields you may
   * SELECT, and capping discovery here could hide the one custom field an
   * instance actually stores its country in.
   */
  function attributeFieldsFrom(fields) {
    return (fields || [])
      .filter((field) => {
        if (isSensitiveField(field.name, field.type)) return false;
        if (CHOICE_STRING_TYPES.has(field.type) && hasChoiceList(field)) return true;
        return REFERENCE_TYPES.has(field.type) && Boolean(field.reference);
      })
      .map((field) => ({
        name: field.name,
        label: field.label,
        type: REFERENCE_TYPES.has(field.type) ? "reference" : "choice",
        definingTable: field.definingTable,
        reference: field.reference,
      }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
  }

  async function resolveUserSchema(options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || (() => false);
    const cacheKey = String(opts.origin || "");
    if (!opts.noCache && schemaCache.has(cacheKey)) return schemaCache.get(cacheKey);

    const engine = globalThis.SNRecordSearch;
    let hierarchy = [USER_TABLE];
    if (engine && typeof engine.resolveHierarchy === "function") {
      /* sys_user is a base table on stock, but an instance is free to have
       * extended it. Resolving the hierarchy is what makes a field defined on
       * a parent visible here, and it is the same bounded walk Record Lens
       * already performs. */
      try {
        const resolved = await engine.resolveHierarchy(USER_TABLE, get, shouldStop);
        if (Array.isArray(resolved) && resolved.length) {
          hierarchy = resolved.map((item) => item.name);
        }
      } catch (error) {
        /* Metadata being unreadable is not fatal on its own -- the dictionary
         * read below decides that, and it names the real problem. */
      }
    }
    if (shouldStop()) throw createError("cancelled", "The search was superseded.");

    const rows = await getRows(get, {
      table: DICTIONARY_TABLE,
      query: "nameIN" + hierarchy.join(",") + "^active=true^elementISNOTEMPTY^ORDERBYcolumn_label",
      fields: "name,element,column_label,internal_type,choice,reference.name",
      limit: MAX_DICTIONARY_FIELDS,
    });
    if (shouldStop()) throw createError("cancelled", "The search was superseded.");

    const byName = new Map();
    rows.map(normalizeDictionaryRow).filter(Boolean).forEach((field) => {
      /* The nearest definition wins: a field redefined on the concrete table
       * carries that table's label and choice configuration. */
      const rank = hierarchy.indexOf(field.definingTable);
      const previous = byName.get(field.name);
      if (!previous || rank < previous.rank) {
        byName.set(field.name, Object.assign({ rank: rank < 0 ? 999 : rank }, field));
      }
    });

    const fields = Array.from(byName.values());
    const fieldNames = fields.map((field) => field.name);
    const missingRequired = REQUIRED_USER_FIELDS.filter((name) => !fieldNames.includes(name));
    if (missingRequired.length) {
      throw createError(
        "schema",
        "The user table on this instance is missing fields Impersonate needs to work safely."
      );
    }

    const schema = {
      table: USER_TABLE,
      hierarchy,
      fields,
      fieldNames,
      /* Search and display degrade field by field. Nothing that was not
       * live-verified reaches a query or a result. */
      searchFields: SEARCH_FIELDS.filter((name) => fieldNames.includes(name)),
      displayFields: DISPLAY_FIELDS.filter((name) => fieldNames.includes(name)),
      optionalFields: OPTIONAL_USER_FIELDS.filter((name) => fieldNames.includes(name)),
      attributeFields: attributeFieldsFrom(fields),
      omitted: OPTIONAL_USER_FIELDS.filter((name) => !fieldNames.includes(name)),
    };
    if (!schema.searchFields.length) {
      throw createError("schema", "No readable identity fields are available on this instance.");
    }
    if (!opts.noCache) schemaCache.set(cacheKey, schema);
    return schema;
  }

  function userReadFields(schema) {
    return ["sys_id"]
      .concat(SEARCH_FIELDS.filter((name) => schema.fieldNames.includes(name)))
      .concat(["active", "locked_out"])
      .concat(schema.fieldNames.includes("web_service_access_only")
        ? ["web_service_access_only"] : [])
      .concat(schema.displayFields)
      .filter((name, index, all) => all.indexOf(name) === index)
      .join(",");
  }

  /* ------------------------------------------------------------------ *
   * Verification and eligibility
   * ------------------------------------------------------------------ */

  /*
   * A server condition that was ignored must not reach the panel as a verified
   * result. The complete term -- not the anchor -- has to appear in at least
   * one allowlisted value; an exact sys_id lookup is the one exception, since
   * it matched on identity rather than on text.
   */
  function verifyUserRow(row, schema, term) {
    const needle = String(term == null ? "" : term).toLowerCase();
    if (!needle) return true;
    return (schema.searchFields || SEARCH_FIELDS).some((field) =>
      displayValue(row && row[field]).toLowerCase().includes(needle)
    );
  }

  /*
   * Re-checked on the way back even though the server was asked for it, for
   * the same reason the term is: a condition the instance declined to apply
   * would otherwise put an unsafe account in front of a click.
   */
  function isEligibleRow(row, schema) {
    if (!rawValue(row && row.user_name).trim()) return false;
    if (!isTrue(row && row.active)) return false;
    if (isTrue(row && row.locked_out)) return false;
    if (schema && schema.fieldNames && schema.fieldNames.includes("web_service_access_only") &&
      isTrue(row && row.web_service_access_only)) {
      return false;
    }
    return true;
  }

  function normalizeUser(row, schema) {
    const sysId = rawValue(row && row.sys_id).toLowerCase();
    if (!SYS_ID_PATTERN.test(sysId)) return null;
    const userName = rawValue(row && row.user_name);
    if (!userName) return null;
    const user = {
      sysId,
      userName,
      name: displayValue(row && row.name) || userName,
      email: schema.fieldNames.includes("email") ? displayValue(row && row.email) : "",
      title: schema.fieldNames.includes("title") ? displayValue(row && row.title) : "",
      details: [],
    };
    schema.displayFields.forEach((field) => {
      const value = displayValue(row && row[field]);
      if (!value) return;
      const definition = schema.fields.find((item) => item.name === field);
      user.details.push({ field, label: (definition && definition.label) || field, value });
    });
    return user;
  }

  function rankUser(user, term) {
    const engine = globalThis.SNRecordSearch;
    const rank = (value) => {
      if (engine && typeof engine.valueMatchRank === "function") {
        return engine.valueMatchRank(value, term);
      }
      const haystack = String(value || "").toLowerCase();
      const needle = String(term || "").toLowerCase();
      if (!needle || !haystack.includes(needle)) return 4;
      if (haystack === needle) return 0;
      return haystack.indexOf(needle) === 0 ? 1 : 3;
    };
    return Math.min.apply(null, [user.userName, user.name, user.email, user.title]
      .map(rank).concat([4]));
  }

  function sortUsers(users, term) {
    if (!term) {
      return (users || []).slice().sort((a, b) =>
        String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }) ||
        String(a.userName).localeCompare(String(b.userName)));
    }
    return (users || []).slice().sort((a, b) =>
      rankUser(a, term) - rankUser(b, term) ||
      String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }) ||
      String(a.userName).localeCompare(String(b.userName)));
  }

  /* ------------------------------------------------------------------ *
   * Membership
   * ------------------------------------------------------------------ */

  /*
   * Duplicate rows are normal -- itil returns 70 rows for 66 users -- so
   * membership is deduplicated by user and a DIRECT row wins when both appear.
   * granted_by is empty on the PDI and one unreadable value on every customer
   * row, and included_in_role is empty, so the panel may say direct or
   * inherited but must never claim "via group X".
   */
  function dedupeMemberships(rows, allowedUserIds) {
    const allowed = allowedUserIds ? new Set(allowedUserIds.map((id) => String(id).toLowerCase())) : null;
    const byUser = new Map();
    (rows || []).forEach((row) => {
      const userId = rawValue(row && row.user).toLowerCase();
      if (!SYS_ID_PATTERN.test(userId)) return;
      if (allowed && !allowed.has(userId)) return;
      const inherited = isTrue(row && row.inherited);
      const previous = byUser.get(userId);
      if (!previous || (previous.inherited && !inherited)) {
        byUser.set(userId, { userSysId: userId, inherited });
      }
    });
    return Array.from(byUser.values());
  }

  /* Every membership row must name the role we asked for and a user we asked
   * about; a row that does not is a server condition that did not hold. */
  function verifyMembershipRows(rows, roleSysId, requestedUserIds) {
    const role = String(roleSysId).toLowerCase();
    const requested = requestedUserIds
      ? new Set(requestedUserIds.map((id) => String(id).toLowerCase()))
      : null;
    return (rows || []).filter((row) => {
      const rowRole = rawValue(row && row.role).toLowerCase();
      const rowUser = rawValue(row && row.user).toLowerCase();
      if (rowRole && rowRole !== role) return false;
      if (!SYS_ID_PATTERN.test(rowUser)) return false;
      return !requested || requested.has(rowUser);
    });
  }

  /*
   * The same verification for group rows, deduplicated to user ids. Rows with
   * an EMPTY user are real -- 230 in one customer group -- and duplicate
   * (user, group) rows occur too, so rows are never a member count.
   */
  function groupMemberIds(rows, groupSysId, requestedUserIds) {
    const group = String(groupSysId).toLowerCase();
    const requested = requestedUserIds
      ? new Set(requestedUserIds.map((id) => String(id).toLowerCase()))
      : null;
    const seen = new Set();
    (rows || []).forEach((row) => {
      const rowGroup = rawValue(row && row.group).toLowerCase();
      const rowUser = rawValue(row && row.user).toLowerCase();
      if (rowGroup && rowGroup !== group) return;
      if (!SYS_ID_PATTERN.test(rowUser)) return;
      if (requested && !requested.has(rowUser)) return;
      seen.add(rowUser);
    });
    return Array.from(seen);
  }

  /* ------------------------------------------------------------------ *
   * Roles
   * ------------------------------------------------------------------ */

  function normalizeRole(row) {
    const sysId = rawValue(row && row.sys_id).toLowerCase();
    if (!SYS_ID_PATTERN.test(sysId)) return null;
    const name = displayValue(row && row.name).trim();
    if (!name) return null;
    return { sysId, name, description: displayValue(row && row.description).trim() };
  }

  async function findRoles(input, options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || (() => false);
    const term = text(input);
    const anchor = extractRoleAnchor(term);
    if (!anchor) return { roles: [], truncated: false };
    const rows = await getRows(get, {
      table: ROLE_TABLE,
      query: buildRoleQuery(anchor) + "^ORDERBYname",
      fields: "sys_id,name,description",
      limit: ROLE_SUGGESTION_CANDIDATE_LIMIT,
    });
    if (shouldStop()) return { roles: [], truncated: false, stale: true };
    const needle = term.toLowerCase();
    /* Complete-term verified, exactly like a user result. */
    const matches = rows
      .map(normalizeRole)
      .filter(Boolean)
      .filter((role) =>
        role.name.toLowerCase().includes(needle) ||
        role.description.toLowerCase().includes(needle))
      .sort((a, b) => {
        const rank = (role) => {
          const name = role.name.toLowerCase();
          if (name === needle) return 0;
          if (name.startsWith(needle)) return 1;
          if (name.includes(needle)) return 2;
          return 3;
        };
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      });
    const roles = matches.slice(0, ROLE_SUGGESTION_LIMIT);
    return {
      roles,
      truncated: rows.length >= ROLE_SUGGESTION_CANDIDATE_LIMIT ||
        matches.length > ROLE_SUGGESTION_LIMIT,
    };
  }

  /* ------------------------------------------------------------------ *
   * Groups
   * ------------------------------------------------------------------ */

  function normalizeGroup(row) {
    const sysId = rawValue(row && row.sys_id).toLowerCase();
    if (!SYS_ID_PATTERN.test(sysId)) return null;
    const name = displayValue(row && row.name).trim();
    if (!name) return null;
    /* Only an explicit false is inactive. An EMPTY flag is not -- and
     * display_value=all renders empty as "false", so the raw value decides. */
    const inactive = rawValue(row && row.active).trim().toLowerCase() === "false";
    return {
      sysId,
      name,
      description: displayValue(row && row.description).trim(),
      active: !inactive,
    };
  }

  async function findGroups(input, options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || (() => false);
    const term = text(input);
    const anchors = groupAnchors(term);
    if (!anchors.length) return { groups: [], truncated: false };
    const rows = await getRows(get, {
      table: GROUP_TABLE,
      query: buildGroupQuery(anchors) + "^ORDERBYname",
      fields: "sys_id,name,description,active",
      limit: GROUP_SUGGESTION_CANDIDATE_LIMIT,
    });
    if (shouldStop()) return { groups: [], truncated: false, stale: true };
    const needle = term.toLowerCase();
    const words = anchors.map((anchor) => anchor.toLowerCase());
    /*
     * Verified per anchor, not as the complete term: the conditions sent were
     * one per word, so each word is what a row has to prove it matched. A
     * complete-term check would hide "Acme-EU-Service Desk" from a user who
     * typed "Acme EU Service Desk" -- exactly what the AND-ed words are for.
     */
    const matches = rows
      .map(normalizeGroup)
      .filter(Boolean)
      .filter((group) => words.every((word) => group.name.toLowerCase().includes(word)))
      .sort((a, b) => {
        const rank = (group) => {
          const name = group.name.toLowerCase();
          if (name === needle) return 0;
          if (name.startsWith(needle)) return 1;
          if (name.includes(needle)) return 2;
          return 3;
        };
        /* An inactive group ranks after active ones of the same match
         * quality -- still offered, since its members are still members. */
        return rank(a) - rank(b) ||
          Number(!a.active) - Number(!b.active) ||
          a.name.localeCompare(b.name);
      });
    return {
      groups: matches.slice(0, GROUP_SUGGESTION_LIMIT),
      truncated: rows.length >= GROUP_SUGGESTION_CANDIDATE_LIMIT ||
        matches.length > GROUP_SUGGESTION_LIMIT,
    };
  }

  /* ------------------------------------------------------------------ *
   * Attribute values
   * ------------------------------------------------------------------ */

  async function resolveLanguage(options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const cacheKey = String(opts.origin || "");
    if (!opts.noCache && languageCache.has(cacheKey)) return languageCache.get(cacheKey);
    let language = "en";
    try {
      const rows = await getRows(get, {
        table: PROPERTY_TABLE,
        query: "name=glide.sys.language",
        fields: "name,value",
        limit: 1,
        timeoutMs: OPTIONAL_READ_TIMEOUT_MS,
      });
      const value = rawValue(rows[0] && rows[0].value).trim();
      if (LANGUAGE_PATTERN.test(value)) language = value;
    } catch (error) {
      /* An unreadable property is not an error: English is the platform
       * default and the picker still scopes to ONE language, which is the
       * point -- an unscoped read interleaves the same country in six scripts. */
    }
    if (!opts.noCache) languageCache.set(cacheKey, language);
    return language;
  }

  /*
   * Three defects live in this table and all three are filtered here: 1,387
   * rows across six languages, 222 of the 232 English rows inactive, and one
   * active row whose label is a raw javascript: expression carrying the
   * sentinel NULL_OVERRIDE as its value.
   */
  function choiceValuesFrom(rows) {
    const seen = new Set();
    const values = [];
    (rows || []).forEach((row) => {
      const value = rawValue(row && row.value);
      const label = displayValue(row && row.label).trim();
      if (!value || CHOICE_SENTINEL_VALUES.has(value)) return;
      if (queryValueProblem(value)) return;
      if (/javascript\s*:/i.test(label)) return;
      if (isTrue(row && row.inactive)) return;
      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      values.push({ value, label: label || value });
    });
    return values.sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  }

  function referenceValuesFrom(rows, displayField) {
    const seen = new Set();
    const values = [];
    (rows || []).forEach((row) => {
      const sysId = rawValue(row && row.sys_id).toLowerCase();
      if (!SYS_ID_PATTERN.test(sysId) || seen.has(sysId)) return;
      const label = displayValue(row && row[displayField]).trim();
      if (!label) return;
      seen.add(sysId);
      values.push({ value: sysId, label });
    });
    return values.sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  }

  /*
   * A reference field needs its REFERENCED table read, not sys_choice -- the
   * obvious generalisation of "string fields with a choice list" would find
   * nothing on an instance whose country field is a reference. Which column
   * holds the display value is read from that table's own dictionary, never
   * assumed to be `name`.
   */
  /* Which column carries the display value is read from the referenced
   * table's own dictionary, never assumed to be `name`. */
  async function resolveDisplayField(table, get, shouldStop) {
    const rows = await getRows(get, {
      table: DICTIONARY_TABLE,
      query: "name=" + table + "^display=true^active=true",
      fields: "name,element",
      limit: 5,
      timeoutMs: OPTIONAL_READ_TIMEOUT_MS,
    }).catch(() => []);
    if (shouldStop && shouldStop()) return "";
    const found = rows
      .map((row) => rawValue(row && row.element))
      .find((name) => FIELD_NAME_PATTERN.test(name));
    return found || "name";
  }

  /*
   * The field must still be one the live schema offers. Binding the read to
   * the discovered list is what keeps a reference table out of a query unless
   * sys_dictionary named it for a field the picker actually shows.
   */
  function verifyAttributeField(field, schema) {
    const name = text(field && field.name);
    if (!FIELD_NAME_PATTERN.test(name)) {
      throw createError("validation", "Choose a field from the discovered list.");
    }
    if (!schema) {
      /* The reference path is the one place a table outside the fixed
       * allowlist gets read, and the schema is what admits it. Without one
       * there is nothing to check the reference against, so it is refused
       * rather than trusted. */
      if (text(field && field.type) === "reference") {
        throw createError("schema", "The live dictionary is needed to read that field's values.");
      }
      return Object.assign({}, field, { name });
    }
    const found = (schema.attributeFields || []).find((item) => item.name === name);
    if (!found) {
      throw createError("schema", "That field is no longer offered by the live dictionary.");
    }
    return found;
  }

  async function loadAttributeValues(field, options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || (() => false);
    const verified = verifyAttributeField(field, opts.schema);

    if (verified.type === "reference") {
      const table = text(verified.reference).toLowerCase();
      if (!TABLE_NAME_PATTERN.test(table)) {
        throw createError("schema", "That field points at a table this cannot read.");
      }
      const displayField = await resolveDisplayField(table, get, shouldStop);
      if (shouldStop()) return { values: [], stale: true };
      const safeDisplay = assertSafeField(displayField);
      /*
       * Past the cap the control is a type-ahead rather than a truncated list
       * presented as complete -- and a type-ahead narrows on the SERVER, under
       * the ordinary anchor rules, since filtering the first page locally
       * would only ever search the part of the table that happened to fit.
       */
      const anchor = text(opts.term) ? extractUserAnchor(opts.term) : null;
      const query = anchor
        ? safeDisplay + "LIKE" + assertSafeAnchor(anchor, MIN_USER_ANCHOR) +
          "^ORDERBY" + safeDisplay
        : "ORDERBY" + safeDisplay;
      const rows = await getRows(get, {
        table,
        query,
        fields: ["sys_id", safeDisplay].join(","),
        limit: ATTRIBUTE_VALUE_LIMIT + 1,
      }, table);
      const found = referenceValuesFrom(rows, safeDisplay);
      /* Complete-term verified, exactly like a user result: a server condition
       * that was ignored must not come back looking like a match. */
      const needle = text(opts.term).toLowerCase();
      const values = needle
        ? found.filter((item) => item.label.toLowerCase().includes(needle))
        : found;
      return {
        values: values.slice(0, ATTRIBUTE_VALUE_LIMIT),
        truncated: rows.length > ATTRIBUTE_VALUE_LIMIT,
        kind: "reference",
        searched: Boolean(anchor),
      };
    }

    const language = await resolveLanguage(opts);
    if (shouldStop()) return { values: [], stale: true };
    const definingTable = text(verified.definingTable).toLowerCase() || USER_TABLE;
    if (!TABLE_NAME_PATTERN.test(definingTable)) {
      throw createError("schema", "That field's defining table name is not safe to query.");
    }
    const rows = await getRows(get, {
      table: CHOICE_TABLE,
      query: "name=" + definingTable + "^element=" + assertSafeField(verified.name) +
        "^language=" + language + "^inactive=false^ORDERBYlabel",
      fields: "name,element,label,value,language,inactive",
      limit: ATTRIBUTE_VALUE_LIMIT + 1,
    });
    const values = choiceValuesFrom(rows);
    return {
      values: values.slice(0, ATTRIBUTE_VALUE_LIMIT),
      truncated: rows.length > ATTRIBUTE_VALUE_LIMIT,
      kind: "choice",
      language,
    };
  }

  /* ------------------------------------------------------------------ *
   * The search itself
   * ------------------------------------------------------------------ */

  function presentation(users, term, total, capped) {
    const ordered = sortUsers(users, term);
    return {
      results: ordered.slice(0, RESULT_LIMIT),
      truncated: ordered.length > RESULT_LIMIT || Boolean(capped),
      /*
       * The number shown is the count of deduplicated, eligibility-filtered
       * and attribute-filtered USER rows -- never a membership row count. A
       * capped read claims no total at all, eligible or otherwise.
       */
      eligibleTotal: capped ? null : (typeof total === "number" ? total : ordered.length),
    };
  }

  async function readUsers(query, limit, schema, get) {
    return getRows(get, {
      table: USER_TABLE,
      query,
      fields: userReadFields(schema),
      limit,
    });
  }

  async function runUserFirst(parsed, schema, get, shouldStop) {
    const query = parsed.isSysId
      ? buildUserSysIdQuery(parsed.anchor, schema, parsed.attribute)
      : buildUserTextQuery(schema.searchFields, parsed.anchor, schema, parsed.attribute);
    const rows = await readUsers(
      query,
      parsed.isSysId ? 1 : USER_CANDIDATE_LIMIT,
      schema,
      get
    );
    if (shouldStop()) return { stale: true };
    const candidates = rows
      .filter((row) => isEligibleRow(row, schema))
      .filter((row) => parsed.isSysId || verifyUserRow(row, schema, parsed.term))
      .map((row) => normalizeUser(row, schema))
      .filter(Boolean);
    const candidatesCapped = !parsed.isSysId && rows.length >= USER_CANDIDATE_LIMIT;
    const filters = {
      roleFilter: parsed.roleSysId ? { status: "applied" } : null,
      groupFilter: parsed.groupSysId ? { status: "applied" } : null,
    };

    let users = candidates;
    /* Group before role: it narrows without adding anything to a row, so the
     * role read that follows asks about fewer candidates. */
    if (parsed.groupSysId && users.length) {
      const kept = await keepGroupMembers(users, parsed.groupSysId, get, shouldStop);
      if (kept.stale) return { stale: true };
      if (kept.unavailable) {
        return filterUnavailable("user-first", "group", filters, "Narrow the text term and try again.");
      }
      users = kept.users;
    }
    if (parsed.roleSysId && users.length) {
      const kept = await keepRoleHolders(users, parsed.roleSysId, get, shouldStop);
      if (kept.stale) return { stale: true };
      if (kept.unavailable) {
        return filterUnavailable("user-first", "role", filters, "Narrow the text term and try again.");
      }
      users = kept.users;
    }
    return Object.assign(
      { order: "user-first" },
      filters,
      presentation(users, parsed.term, users.length, candidatesCapped)
    );
  }

  /*
   * An intersection read asks about known candidates, so it can be complete:
   * each contributes about one row. Twice the candidates is the headroom --
   * which for the 50-row text window is exactly the old fixed bound of 100,
   * and for 100 group members leaves room for their role rows.
   */
  function intersectionLimit(count) {
    return Math.max(MEMBERSHIP_LIMIT, count * 2);
  }

  /*
   * A capped intersection corrupts the FILTER, not the list: a candidate cut
   * off by the cap is indistinguishable from one that genuinely lacks the
   * membership, so a filtered subset would misrepresent which users matched.
   * Unavailable, never no-match.
   */
  function filterUnavailable(order, kind, filters, narrowing) {
    const unavailable = {
      status: "unavailable",
      reason: "Too many " + kind + " memberships came back to filter these candidates reliably. " +
        narrowing,
    };
    return Object.assign(
      { order, results: [], truncated: false, eligibleTotal: null },
      filters,
      kind === "role" ? { roleFilter: unavailable } : { groupFilter: unavailable }
    );
  }

  async function keepRoleHolders(users, roleSysId, get, shouldStop) {
    const ids = users.map((user) => user.sysId);
    const limit = intersectionLimit(ids.length);
    const rows = await getRows(get, {
      table: MEMBERSHIP_TABLE,
      query: buildMembershipQuery(roleSysId, ids),
      fields: "user,role,inherited,state",
      limit: limit + 1,
    });
    if (shouldStop()) return { stale: true };
    if (rows.length > limit) return { unavailable: true };
    const memberships = new Map(
      dedupeMemberships(verifyMembershipRows(rows, roleSysId, ids), ids)
        .map((item) => [item.userSysId, item])
    );
    return {
      users: users
        .filter((user) => memberships.has(user.sysId))
        .map((user) => Object.assign({}, user, {
          membership: { inherited: memberships.get(user.sysId).inherited },
        })),
    };
  }

  async function keepGroupMembers(users, groupSysId, get, shouldStop) {
    const ids = users.map((user) => user.sysId);
    const limit = intersectionLimit(ids.length);
    const rows = await getRows(get, {
      table: GROUP_MEMBER_TABLE,
      query: buildGroupMemberQuery(groupSysId, ids),
      fields: "user,group",
      limit: limit + 1,
    });
    if (shouldStop()) return { stale: true };
    if (rows.length > limit) return { unavailable: true };
    const members = new Set(groupMemberIds(rows, groupSysId, ids));
    /* No badge: every row that survives is a member by construction, and
     * the table carries nothing further -- no direct/inherited distinction. */
    return { users: users.filter((user) => members.has(user.sysId)) };
  }

  /* The anchor a membership read dot-walks, or none. An exact sys_id never
   * reaches here: it is user-first. */
  function membershipAnchor(parsed) {
    return parsed.term && !parsed.isSysId ? parsed.anchor : "";
  }

  /*
   * A group, with any mix of text, a role and an attribute. The member read
   * carries the text, the attribute and eligibility as dot-walks, so its cap
   * is spent on members who can appear; the user read then applies the last
   * two again and every row is checked for the complete term (see
   * buildGroupMemberQuery for why the dot-walk is never trusted alone).
   *
   * Like role-first, the cap truncates the LIST here: every member returned
   * is a genuine member, so partial results are honest, with no claimed total.
   * The largest group measured on a customer instance had 41,580 members.
   */
  async function runGroupFirst(parsed, schema, get, shouldStop) {
    const filters = {
      roleFilter: parsed.roleSysId ? { status: "applied" } : null,
      groupFilter: { status: "applied" },
    };
    const memberRows = await getRows(get, {
      table: GROUP_MEMBER_TABLE,
      query: buildGroupMemberQuery(
        parsed.groupSysId, null, schema, parsed.attribute, membershipAnchor(parsed)
      ),
      fields: "user,group",
      limit: MEMBERSHIP_LIMIT + 1,
    });
    if (shouldStop()) return { stale: true };
    const membershipCapped = memberRows.length > MEMBERSHIP_LIMIT;
    const ids = groupMemberIds(memberRows.slice(0, MEMBERSHIP_LIMIT), parsed.groupSysId, null);
    if (!ids.length) {
      return Object.assign({
        order: "group-first",
        results: [],
        truncated: false,
        eligibleTotal: membershipCapped ? null : 0,
        membershipCapped,
      }, filters);
    }
    const rows = await readUsers(
      buildUserIdsQuery(ids, schema, parsed.attribute),
      ROLE_ONLY_USER_LIMIT,
      schema,
      get
    );
    if (shouldStop()) return { stale: true };
    const members = new Set(ids);
    let users = rows
      .filter((row) => isEligibleRow(row, schema))
      .filter((row) => verifyUserRow(row, schema, parsed.term))
      .map((row) => normalizeUser(row, schema))
      .filter(Boolean)
      .filter((user) => members.has(user.sysId));
    if (parsed.roleSysId && users.length) {
      const kept = await keepRoleHolders(users, parsed.roleSysId, get, shouldStop);
      if (kept.stale) return { stale: true };
      if (kept.unavailable) {
        return filterUnavailable("group-first", "role", filters,
          "Add a name, user ID, email or title to narrow and try again.");
      }
      users = kept.users;
    }
    return Object.assign(
      { order: "group-first", membershipCapped },
      filters,
      presentation(users, parsed.term, users.length, membershipCapped)
    );
  }

  async function runRoleFirst(parsed, schema, get, shouldStop) {
    /*
     * cap + 1 rows are requested and cap are used. It answers one question
     * only -- "did I see every membership row?" -- and it is NOT where the
     * displayed number comes from: dedupe and then eligibility both reduce the
     * set afterwards.
     */
    const membershipRows = await getRows(get, {
      table: MEMBERSHIP_TABLE,
      query: buildMembershipQuery(
        parsed.roleSysId, null, schema, parsed.attribute, membershipAnchor(parsed)
      ),
      fields: "user,role,inherited,state",
      limit: MEMBERSHIP_LIMIT + 1,
    });
    if (shouldStop()) return { stale: true };
    const membershipCapped = membershipRows.length > MEMBERSHIP_LIMIT;
    const usable = membershipRows.slice(0, MEMBERSHIP_LIMIT);
    const verified = verifyMembershipRows(usable, parsed.roleSysId, null);
    const memberships = dedupeMemberships(verified, null);
    if (!memberships.length) {
      return {
        order: "role-first",
        results: [],
        truncated: false,
        eligibleTotal: membershipCapped ? null : 0,
        membershipCapped,
        roleFilter: { status: "applied" },
      };
    }
    const byUser = new Map(memberships.map((item) => [item.userSysId, item]));
    const ids = memberships.map((item) => item.userSysId).slice(0, ROLE_ONLY_USER_LIMIT);
    const rows = await readUsers(
      buildUserIdsQuery(ids, schema, parsed.attribute),
      ROLE_ONLY_USER_LIMIT,
      schema,
      get
    );
    if (shouldStop()) return { stale: true };
    const users = rows
      .filter((row) => isEligibleRow(row, schema))
      .filter((row) => verifyUserRow(row, schema, parsed.term))
      .map((row) => normalizeUser(row, schema))
      .filter(Boolean)
      .filter((user) => byUser.has(user.sysId))
      .map((user) => Object.assign({}, user, {
        membership: { inherited: byUser.get(user.sysId).inherited },
      }));
    /*
     * Here the cap merely truncates the LIST. Every row that came back is a
     * genuine holder, so partial results are honest -- shown with a narrowing
     * message and no claimed total.
     */
    return Object.assign(
      { order: "role-first", membershipCapped, roleFilter: { status: "applied" } },
      presentation(users, parsed.term, users.length, membershipCapped)
    );
  }

  async function runAttributeFirst(parsed, schema, get, shouldStop) {
    const rows = await readUsers(
      buildAttributeOnlyQuery(schema, parsed.attribute),
      ROLE_ONLY_USER_LIMIT + 1,
      schema,
      get
    );
    if (shouldStop()) return { stale: true };
    const capped = rows.length > ROLE_ONLY_USER_LIMIT;
    const users = rows
      .slice(0, ROLE_ONLY_USER_LIMIT)
      .filter((row) => isEligibleRow(row, schema))
      .map((row) => normalizeUser(row, schema))
      .filter(Boolean);
    return Object.assign(
      { order: "attribute-first", roleFilter: null },
      presentation(users, "", users.length, capped)
    );
  }

  async function runSearch(parsed, options) {
    if (!parsed || !parsed.ok) throw createError("validation", "Invalid search.");
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || (() => false);
    const schema = opts.schema || await resolveUserSchema({
      get, origin: opts.origin, shouldStop,
    });
    if (shouldStop()) return { stale: true, results: [] };

    let outcome;
    if (parsed.order === "user-first") {
      outcome = await runUserFirst(parsed, schema, get, shouldStop);
    } else if (parsed.order === "group-first") {
      outcome = await runGroupFirst(parsed, schema, get, shouldStop);
    } else if (parsed.order === "role-first") {
      outcome = await runRoleFirst(parsed, schema, get, shouldStop);
    } else {
      outcome = await runAttributeFirst(parsed, schema, get, shouldStop);
    }
    if (outcome && outcome.stale) return { stale: true, results: [] };
    if (shouldStop()) return { stale: true, results: [] };
    return Object.assign({ stale: false, term: parsed.term, schema }, outcome);
  }

  /*
   * The platform's recent-impersonations list, read back through the same
   * eligibility gate as a search. ServiceNow lists whoever you impersonated,
   * not whoever is still safe to impersonate: an account deactivated or locked
   * since then stays on its list. So the list contributes ids only, and the
   * sys_user read decides who appears and what each row says.
   *
   * The endpoint's order is kept, so the list reads exactly as ServiceNow's
   * own Impersonate dialog does -- confirmed side by side on a customer
   * instance. It is NOT the preference's order: that value is newest-first,
   * and on the PDI the endpoint returned the same two accounts the other way
   * round.
   */
  async function readRecentUsers(sysIds, options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || (() => false);
    const ids = [];
    (Array.isArray(sysIds) ? sysIds : []).forEach((value) => {
      const id = text(value).toLowerCase();
      if (SYS_ID_PATTERN.test(id) && !ids.includes(id) && ids.length < RECENT_LIMIT) ids.push(id);
    });
    if (!ids.length) return { stale: false, users: [], hidden: 0 };
    const schema = opts.schema || await resolveUserSchema({
      get, origin: opts.origin, shouldStop,
    });
    if (shouldStop()) return { stale: true, users: [], hidden: 0 };
    const rows = await readUsers(buildUserIdsQuery(ids, schema, null), ids.length, schema, get);
    if (shouldStop()) return { stale: true, users: [], hidden: 0 };
    const byId = new Map();
    rows
      .filter((row) => isEligibleRow(row, schema))
      .map((row) => normalizeUser(row, schema))
      .filter(Boolean)
      .forEach((user) => { if (ids.includes(user.sysId)) byId.set(user.sysId, user); });
    const users = ids.map((id) => byId.get(id)).filter(Boolean);
    /* A count, never a list: the panel says that someone was left out and
     * why, but an account that cannot be impersonated is not named. */
    return { stale: false, users, hidden: ids.length - users.length };
  }

  /*
   * The containment rows between the roles one account holds, as parent ->
   * the held roles it contains. Null when they cannot all be read: a failed
   * read, a capped one, or a row with a blank column, which is an ACL rather
   * than an absent edge. Any of the three would lose an edge, and a lost edge
   * calls a bundled role assigned.
   */
  async function readContainment(heldIds, get, shouldStop) {
    const held = new Set(heldIds);
    const edges = new Map();
    for (let start = 0; start < heldIds.length; start += CONTAINMENT_CHUNK) {
      const chunk = heldIds.slice(start, start + CONTAINMENT_CHUNK);
      const asked = new Set(chunk);
      let rows;
      try {
        rows = await getRows(get, {
          table: CONTAINMENT_TABLE,
          query: "roleIN" + chunk.join(","),
          fields: "role,contains",
          limit: CONTAINMENT_LIMIT + 1,
          /* Two ids a row and nothing to display. */
          options: { displayAll: false },
        });
      } catch (error) {
        return shouldStop() ? { stale: true } : null;
      }
      if (shouldStop()) return { stale: true };
      if (rows.length > CONTAINMENT_LIMIT) return null;
      for (const row of rows) {
        const parent = rawValue(row && row.role).toLowerCase();
        const child = rawValue(row && row.contains).toLowerCase();
        if (!SYS_ID_PATTERN.test(parent) || !SYS_ID_PATTERN.test(child)) return null;
        /* A row about a role not asked for is a condition that did not hold,
         * and a role the account does not hold bundles nothing here. */
        if (!asked.has(parent) || parent === child || !held.has(child)) continue;
        if (!edges.has(parent)) edges.set(parent, new Set());
        edges.get(parent).add(child);
      }
    }
    return { edges };
  }

  /*
   * Assigned: every direct grant, contained or not, and every inherited role
   * no other held role contains. The rest are said to come with those, which
   * is true only if each is reachable from one -- so a containment cycle that
   * nothing assigned reaches is assigned too, one role at a time, rather than
   * hidden behind a claim that would not hold.
   */
  function assignedRoleIds(byRole, edges) {
    const contained = new Set();
    edges.forEach((children) => children.forEach((child) => contained.add(child)));
    const assigned = new Set();
    byRole.forEach((role, roleId) => {
      if (!role.inherited || !contained.has(roleId)) assigned.add(roleId);
    });
    const reached = new Set();
    const reach = (from) => {
      const queue = [from];
      reached.add(from);
      while (queue.length) {
        (edges.get(queue.pop()) || new Set()).forEach((child) => {
          if (reached.has(child)) return;
          reached.add(child);
          queue.push(child);
        });
      }
    };
    assigned.forEach(reach);
    byRole.forEach((role, roleId) => {
      if (reached.has(roleId)) return;
      assigned.add(roleId);
      reach(roleId);
    });
    return assigned;
  }

  /*
   * Every role one account effectively holds, for the confirmation, and which
   * of them someone actually assigned. The effective table lists direct
   * grants, group grants and every role that came inside another held role
   * alike: ordinary accounts on a customer instance held 59-133, of which
   * 10-14 were left once each role another HELD role contains was set aside.
   * What is left is every direct grant and each inherited role nothing held
   * contains -- granted by one of the account's own groups for 57 of the 58
   * measured, which is what lets the panel say "through groups".
   *
   * The same effective table a role search reads, and the same rules:
   * duplicate rows collapse, a direct row wins over an inherited one, and no
   * group or parent role is ever named -- granted_by is empty on the PDI and
   * one unreadable value on every customer row, and included_in_role is empty.
   *
   * "Assigned" is claimed only from a complete picture. A capped role read, or
   * containment that could not all be read, returns the plain direct and
   * inherited split with `containment: "unavailable"` instead.
   *
   * Verified on the PDI and a customer instance: the role's display value is
   * its name, `inherited` is never empty and `state` is always `active`.
   */
  async function readUserRoles(userSysId, options) {
    const opts = options || {};
    const get = opts.get || defaultTransport;
    const shouldStop = opts.shouldStop || (() => false);
    const user = assertSafeSysId(userSysId);
    const stale = () => ({
      stale: true, direct: [], inherited: [], assigned: null, bundled: null,
      containment: "unavailable", unnamed: 0, capped: false,
    });
    const rows = await getRows(get, {
      table: MEMBERSHIP_TABLE,
      query: "user=" + user + "^state=active",
      fields: "user,role,inherited",
      limit: USER_ROLE_LIMIT + 1,
    });
    if (shouldStop()) return stale();
    const byRole = new Map();
    let unnamed = 0;
    rows.slice(0, USER_ROLE_LIMIT).forEach((row) => {
      /* A row about anyone else is a condition that did not hold. */
      if (rawValue(row && row.user).toLowerCase() !== user) return;
      const roleId = rawValue(row && row.role).toLowerCase();
      if (!SYS_ID_PATTERN.test(roleId)) return;
      const name = displayValue(row && row.role).trim();
      const inherited = isTrue(row && row.inherited);
      const previous = byRole.get(roleId);
      if (!previous || (previous.inherited && !inherited)) byRole.set(roleId, { name, inherited });
    });
    const capped = rows.length > USER_ROLE_LIMIT;
    const named = [];
    byRole.forEach((role, roleId) => {
      /* A restricted name comes back blank, or as the bare sys_id; neither is
       * a name, so it is counted rather than printed. It still takes part in
       * containment: its id is as good as any other. */
      if (!role.name || role.name.toLowerCase() === roleId) unnamed += 1;
      else named.push({ roleId, name: role.name, inherited: role.inherited });
    });

    /* Only an inherited role can be set aside, so an account with none needs
     * no containment read. A capped read is missing roles whose containment
     * would matter, so it gets none either. */
    let containment = null;
    if (!capped) {
      const anyInherited = Array.from(byRole.values()).some((role) => role.inherited);
      containment = anyInherited
        ? await readContainment(Array.from(byRole.keys()), get, shouldStop)
        : { edges: new Map() };
      if (containment && containment.stale) return stale();
    }

    const names = (list) => list.map((role) => role.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const found = {
      stale: false,
      direct: names(named.filter((role) => !role.inherited)),
      inherited: names(named.filter((role) => role.inherited)),
      assigned: null,
      bundled: null,
      containment: "unavailable",
      unnamed,
      capped,
    };
    if (containment) {
      const assigned = assignedRoleIds(byRole, containment.edges);
      found.assigned = names(named.filter((role) => assigned.has(role.roleId)));
      found.bundled = names(named.filter((role) => !assigned.has(role.roleId)));
      found.containment = "applied";
    }
    return found;
  }

  /* ------------------------------------------------------------------ *
   * The mutation's only input
   * ------------------------------------------------------------------ */

  /*
   * encodeURIComponent is what makes the URL safe -- it percent-encodes /, ?,
   * #, % and everything else, so no value can escape the path segment or
   * append a query. This validation therefore exists to catch BUGS, not to
   * sanitise, and it must not reject identities the platform actually issues:
   * email-shaped and non-Latin user IDs are ordinary, and a character
   * allowlist would reject both, failing first on a customer instance with
   * international users.
   */
  function validateUserName(value) {
    if (typeof value !== "string") {
      return { ok: false, code: "validation", error: "No user ID was supplied." };
    }
    if (!value || !value.trim()) {
      return { ok: false, code: "validation", error: "No user ID was supplied." };
    }
    if (value.length > MAX_USER_NAME_LENGTH) {
      return {
        ok: false,
        code: "validation",
        error: "That user ID is longer than ServiceNow allows.",
      };
    }
    /* Harmless once encoded -- but their presence means the value did not come
     * from a verified row. */
    if (/[\u0000-\u001F\u007F]/.test(value)) {
      return { ok: false, code: "validation", error: "That user ID contains control characters." };
    }
    /* The response's way home is the STRING "null" when there was no original.
     * It is never stored and never POSTed. */
    if (value === "null") {
      return { ok: false, code: "validation", error: "That is not a real user ID." };
    }
    return { ok: true, userName: value };
  }

  function buildUserUrl(origin, user) {
    const sysId = assertSafeSysId(user && user.sysId);
    return String(origin || "") + "/" + USER_TABLE + ".do?sys_id=" + encodeURIComponent(sysId);
  }

  /* ServiceNow's classic impersonation dialog: a stock UI page, verified on a
   * customer instance as baseline and unmodified. The panel offers it when
   * Stop is refused; GlideLens only opens it and never submits it. */
  function buildImpersonateDialogUrl(origin) {
    return String(origin || "") + "/impersonate_dialog.do";
  }

  function createSessionTracker() {
    const engine = globalThis.SNRecordSearch;
    if (engine && typeof engine.createSessionTracker === "function") {
      return engine.createSessionTracker();
    }
    let current = 0;
    return {
      next() { current += 1; return current; },
      cancel() { current += 1; },
      isCurrent(id) { return id === current; },
    };
  }

  globalThis.SNImpersonate = {
    USER_TABLE,
    ROLE_TABLE,
    MEMBERSHIP_TABLE,
    CONTAINMENT_TABLE,
    GROUP_TABLE,
    GROUP_MEMBER_TABLE,
    DICTIONARY_TABLE,
    CHOICE_TABLE,
    TABLE_ALLOWLIST,
    USER_CANDIDATE_LIMIT,
    ROLE_ONLY_USER_LIMIT,
    RESULT_LIMIT,
    ROLE_SUGGESTION_CANDIDATE_LIMIT,
    ROLE_SUGGESTION_LIMIT,
    GROUP_SUGGESTION_CANDIDATE_LIMIT,
    GROUP_SUGGESTION_LIMIT,
    MEMBERSHIP_LIMIT,
    ATTRIBUTE_VALUE_LIMIT,
    RECENT_LIMIT,
    USER_ROLE_LIMIT,
    CONTAINMENT_CHUNK,
    CONTAINMENT_LIMIT,
    MIN_USER_ANCHOR,
    MIN_ROLE_ANCHOR,
    MAX_USER_NAME_LENGTH,
    SEARCH_FIELDS,
    REQUIRED_USER_FIELDS,
    OPTIONAL_USER_FIELDS,
    DISPLAY_FIELDS,
    ELIGIBILITY_CONDITIONS,
    rawValue,
    displayValue,
    queryValueProblem,
    extractUserAnchor,
    extractRoleAnchor,
    searchOrder,
    parseSearch,
    eligibilityClauses,
    attributeCondition,
    buildUserTextQuery,
    buildUserSysIdQuery,
    buildUserIdsQuery,
    buildAttributeOnlyQuery,
    buildMembershipQuery,
    buildRoleQuery,
    buildGroupMemberQuery,
    buildGroupQuery,
    groupAnchors,
    normalizeDictionaryRow,
    attributeFieldsFrom,
    resolveUserSchema,
    userReadFields,
    verifyUserRow,
    isEligibleRow,
    normalizeUser,
    rankUser,
    sortUsers,
    dedupeMemberships,
    verifyMembershipRows,
    groupMemberIds,
    findRoles,
    findGroups,
    choiceValuesFrom,
    referenceValuesFrom,
    verifyAttributeField,
    loadAttributeValues,
    resolveLanguage,
    runSearch,
    readRecentUsers,
    readUserRoles,
    validateUserName,
    buildUserUrl,
    buildImpersonateDialogUrl,
    createSessionTracker,
    /* One argument only: the admitted reference table is getRows's to pass,
     * never an exported caller's. */
    tableGet: (request) => defaultTransport(request),
  };
})();

/*
 * content.js — runs in the ISOLATED world, in EVERY frame of the instance.
 *
 * Why all frames: the classic ServiceNow UI runs the actual app inside an
 * iframe named "gsft_main". The toolbar/shell is the top frame. Form DOM
 * (labels, fields) lives in gsft_main. By injecting into all frames we make
 * sure DOM features run where the form actually is.
 *
 * This world can read/modify the DOM but CANNOT read page JS globals
 * (g_form, g_user, g_ck). For those we use chrome.scripting in popup.js
 * with world:"MAIN". Here we only touch the DOM.
 */

const SNH = {
  fieldNamesOn: false,
  transIconsOn: false,
  varInsightOn: false,
  // Cached affecting-logic for the open catalog item, so every icon click and
  // re-apply reuses one fetch: { rows, setCount, setIds, itemName, itemSysId, index }.
  varInsightData: null,
  lastPrefillVariables: [],
  lastPrefillSource: null,
  lastPrefillResult: null,
};
const SNH_FRAME_COMMAND_SOURCE = "SN_DEV_HELPER_FRAME_COMMAND";
const SNH_PREFILL_PROGRESS_SOURCE = "SN_DEV_HELPER_PREFILL_PROGRESS";
/* Deliberately far above the worker's own inactivity bound: this only catches
 * a reply that never arrives at all, never a fill that is merely slow. */
const PREFILL_REPLY_CEILING_MS = 900000;
const WORKSPACE_FIELD_ATTRS = [
  "data-field-name",
  "data-fieldname",
  "data-field",
  "field-name",
  "fieldname",
  "field",
  "data-column-name",
  "data-column",
  "column-name",
  "column",
  "data-name",
  "name",
];
const WORKSPACE_FIELD_DENYLIST = new Set([
  "actions",
  "append",
  "backward",
  "bottom",
  "button",
  "checkbox",
  "clear",
  "combobox",
  "content",
  "control",
  "controls",
  "default",
  "end",
  "error",
  "footer",
  "form",
  "forward",
  "header",
  "help",
  "icon",
  "input",
  "label",
  "leading",
  "left",
  "list",
  "menu",
  "message",
  "prepend",
  "record",
  "right",
  "search",
  "start",
  "suffix",
  "table",
  "text",
  "top",
  "trailing",
  "trigger",
  "value",
]);

function handleFrameCommand(type) {
  if (type === "TOGGLE_FIELD_NAMES") return toggleFieldNames();
  if (type === "TOGGLE_TRANSLATIONS") return toggleTranslationIcons();
  if (type === "TOGGLE_VARIABLE_INSIGHT") {
    // Service Portal catalog forms live in the top frame; only it owns the icons.
    if (window === window.top) toggleVariableInsightIcons().catch(() => {});
    return null;
  }
  return null;
}

function broadcastFrameCommand(type) {
  chrome.runtime.sendMessage({ type });
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg) return;
  if (event.origin && event.origin !== location.origin) return;

  if (msg.source === SNH_FRAME_COMMAND_SOURCE) {
    handleFrameCommand(msg.type);
  }

  if (msg.source === SNH_PREFILL_PROGRESS_SOURCE) {
    const progress = msg.message || "Filling portal form…";
    if (window === window.top) showToast(progress, false, 6000);
    /* The worker uses these as the liveness heartbeat for the fill it is
     * awaiting, so it has to hear from the top frame too — not only from a
     * sub-frame that needs its toast relayed. `relay` says which is which. */
    chrome.runtime.sendMessage({
      type: "PREFILL_PROGRESS",
      message: progress,
      relay: window !== window.top,
    }).catch(() => {});
  }
});

function decodedVariants(text) {
  const values = [];
  let value = String(text || "");
  for (let i = 0; i < 3 && value; i++) {
    values.push(value);
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch (e) {
      break;
    }
  }
  return values;
}

function recordContextFromText(text) {
  for (const value of decodedVariants(text)) {
    const workspace = value.match(
      /\/now\/(?:[^/?#]+\/)*record\/([^/?#]+)\/([0-9a-f]{32})(?:[/?#]|$)/i
    );
    if (workspace) return { table: workspace[1], sysId: workspace[2] };

    const classic = value.match(/\/([a-z][a-z0-9_]*)\.do(?:[?#]|$)/i);
    const sysId = sysIdFromText(value);
    if (classic) {
      const routeTable = classic[1];
      const table = routeTable.toLowerCase().endsWith("_list")
        ? routeTable.slice(0, -"_list".length)
        : routeTable;
      return { table, sysId };
    }
  }
  return { table: null, sysId: sysIdFromText(text) };
}

// Preserve the complete Workspace experience path. recordContextFromText is
// intentionally lossy because its other callers need only table/sys_id; the
// Variable Values router must distinguish the single `sow` segment from other
// and multi-segment experiences before it decides which form reader may run.
function workspaceRecordContextFromText(text) {
  for (const value of decodedVariants(text)) {
    const match = value.match(
      /\/now\/((?:[^/?#]+\/)*)record\/([^/?#]+)\/([0-9a-f]{32})(?:[/?#]|$)/i
    );
    if (!match) continue;
    const experiencePath = match[1]
      .split("/")
      .filter(Boolean)
      .map((part) => part.toLowerCase());
    return {
      experiencePath,
      table: String(match[2] || "").toLowerCase(),
      sysId: String(match[3] || "").toLowerCase(),
    };
  }
  return null;
}

/*
 * Workspace Variable Values is allowlisted per (experience path, table) PAIR,
 * never by either half alone. Widening this list is a deliberate act: each
 * entry means that surface's live rendering and its stored-side routing were
 * both verified, and a pair that is absent is refused with the truthful
 * unsupported message rather than guessed at.
 *
 * Matching the pair matters. `psm/workspace` may not borrow the RITM reader
 * because it is a Workspace route, and `sow` may not borrow the producer
 * reader because the table happens to be producer-backed. Segment count is not
 * the rule and never was the point: `sow` is one segment and `psm/workspace`
 * is two, and both are refused for any table not named beside them.
 *
 * `kind` selects the stored reader, not the panel wording: `ritm` reads
 * sc_item_option through the RITM's catalog item, `producer` reads the
 * record's own question_answer rows.
 */
const WORKSPACE_SUPPORTED_SURFACES = [
  { experiencePath: ["sow"], table: "sc_req_item", kind: "ritm" },
  { experiencePath: ["psm", "workspace"], table: "sn_slm_case", kind: "producer" },
  { experiencePath: ["psm", "workspace"], table: "sn_slm_task", kind: "producer" },
];

function workspaceSurfaceKey(experiencePath, table) {
  return (Array.isArray(experiencePath) ? experiencePath.join("/") : "") + ":" + table;
}

// The route's surface, or null when this exact pair is not supported.
function workspaceSupportedSurface(route) {
  if (!route || !Array.isArray(route.experiencePath)) return null;
  const path = route.experiencePath.join("/");
  const match = WORKSPACE_SUPPORTED_SURFACES.find(
    (surface) =>
      surface.experiencePath.join("/") === path && surface.table === route.table
  );
  // Shape-checked here rather than through isSysId so this gate stays with the
  // other route helpers and depends on nothing defined further down the file.
  if (!match || !/^[0-9a-f]{32}$/i.test(String(route.sysId || ""))) return null;
  return { kind: match.kind, key: workspaceSurfaceKey(match.experiencePath, match.table) };
}

function workspaceRecordContextMatches(left, right) {
  if (!left || !right) return false;
  return (
    Array.isArray(left.experiencePath) &&
    Array.isArray(right.experiencePath) &&
    left.experiencePath.join("/") === right.experiencePath.join("/") &&
    left.table === right.table &&
    left.sysId === right.sysId
  );
}

function isTechnicalFieldName(value) {
  if (!value) return false;
  const text = String(value).trim();
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/i.test(text)) return false;
  return !WORKSPACE_FIELD_DENYLIST.has(text.toLowerCase());
}

function parseClassicLabel(labelEl) {
  const parts = labelEl.id.split(".");
  if (parts.length < 3) return null;
  return {
    table: parts[1],
    field: parts.slice(2).join("."),
    target: labelEl,
  };
}

function walkRoots(root, visit) {
  if (!root || !root.querySelectorAll) return;
  visit(root);
  root.querySelectorAll("*").forEach((el) => {
    if (el.shadowRoot) walkRoots(el.shadowRoot, visit);
  });
}

function getWorkspaceFieldInfo(el, context) {
  for (const attr of WORKSPACE_FIELD_ATTRS) {
    const raw = el.getAttribute && el.getAttribute(attr);
    if (!raw) continue;

    let value = raw.trim();
    if (value.includes(".") && context.table && value.startsWith(context.table + ".")) {
      value = value.slice(context.table.length + 1);
    }
    if (!isTechnicalFieldName(value)) continue;

    if (
      ["name", "field", "data-name"].includes(attr) &&
      !isLikelyWorkspaceFieldElement(el)
    ) {
      continue;
    }
    return {
      table: context.table,
      field: value,
      target: findWorkspaceInsertTarget(el),
    };
  }
  return null;
}

function isServiceNowComponent(el) {
  const name = el.localName || "";
  return name.startsWith("now-") || name.startsWith("sn-") || name.includes("record");
}

function isInsideServiceNowShadow(el) {
  const root = el.getRootNode && el.getRootNode();
  return root && root.host && isServiceNowComponent(root.host);
}

function isLikelyWorkspaceFieldElement(el) {
  if (isServiceNowComponent(el) || isInsideServiceNowShadow(el)) return true;

  const role = el.getAttribute && el.getAttribute("role");
  if (["textbox", "combobox", "checkbox", "spinbutton"].includes(role)) return true;

  const tag = el.localName || "";
  if (["input", "textarea", "select"].includes(tag)) return true;

  return Boolean(
    el.closest &&
      el.closest(
        'now-record-form-field,now-record-reference,sn-record-form-field,[data-component-id*="field" i],[class*="field" i]'
      )
  );
}

function findWorkspaceInsertTarget(el) {
  if (el.shadowRoot) {
    const label = el.shadowRoot.querySelector(
      'label,[part~="label"],[class*="label" i],[data-label]'
    );
    if (label) return label;
  }

  const labelled = el.closest &&
    el.closest('label,[data-field-name],[data-fieldname],[data-field],[field-name],[fieldname],[field]');
  if (labelled) return labelled;

  const root = el.getRootNode && el.getRootNode();
  if (root && root.querySelector) {
    const label = root.querySelector(
      'label,[part~="label"],[class*="label" i],[data-label]'
    );
    if (label) return label;
  }

  if (["input", "textarea", "select"].includes(el.localName)) {
    return el.parentElement || (root && root.host) || el;
  }
  return el;
}

function appendFieldBadge(target, field, extraClass) {
  const badge = document.createElement("span");
  badge.className = "snh-fieldname" + (extraClass ? " " + extraClass : "");
  badge.textContent = " [" + field + "]";
  badge.style.cssText =
    "color:#0a7d4f;font-size:11px;font-weight:700;margin-left:5px;" +
    "font-family:monospace;letter-spacing:.2px;";
  target.appendChild(badge);
}

function getClassicFields() {
  return Array.from(document.querySelectorAll('[id^="label."]'))
    .map(parseClassicLabel)
    .filter(Boolean);
}

function getWorkspaceFields() {
  const context = recordContextFromText(location.href);
  if (!context.table) return [];

  const fields = [];
  const seen = new WeakMap();
  walkRoots(document, (root) => {
    root.querySelectorAll("*").forEach((el) => {
      if (el.classList && (el.classList.contains("snh-fieldname") || el.classList.contains("snh-trans-icon"))) {
        return;
      }
      const info = getWorkspaceFieldInfo(el, context);
      if (!info || !info.target) return;

      let targetFields = seen.get(info.target);
      if (!targetFields) {
        targetFields = new Set();
        seen.set(info.target, targetFields);
      }
      if (targetFields.has(info.field)) return;
      targetFields.add(info.field);
      fields.push(info);
    });
  });
  return fields;
}

function removeSnhElements(selector) {
  document.querySelectorAll(selector).forEach((n) => n.remove());
  walkRoots(document, (root) => {
    if (root === document) return;
    root.querySelectorAll(selector).forEach((n) => n.remove());
  });
}

function toggleFieldNames(force) {
  const turnOn = typeof force === "boolean" ? force : !SNH.fieldNamesOn;
  SNH.fieldNamesOn = turnOn;

  removeSnhElements(".snh-fieldname");
  if (!turnOn) {
    syncToggleObserver();
    return 0;
  }

  let count = 0;
  getClassicFields().forEach(({ field, target }) => {
    appendFieldBadge(target, field);
    count++;
  });

  getWorkspaceFields().forEach(({ field, target }) => {
    appendFieldBadge(target, field, "snh-workspace-fieldname");
    count++;
  });
  syncToggleObserver();
  return count;
}

/*
 * Translation icons: two clickable icons next to each form label.
 *
 *  1. Globe  -> sys_documentation  (per-language LABEL / plural / hint).
 *               Keyed by table.field, NOT per record.
 *  2. Glyph  -> sys_translated_text (per-record translated VALUES, for fields
 *               flagged translatable). Keyed by the record's sys_id.
 *
 * Inheritance: a field shown on a form may be defined on a PARENT table
 * (e.g. task.short_description on an incident form), and its sys_documentation
 * rows are keyed to the parent. So before opening, we resolve the field's
 * DEFINING table by walking the sys_db_object.super_class chain and checking
 * sys_dictionary at each level. This uses same-origin authenticated GETs from
 * the gsft_main frame (the session cookie carries auth). If an instance
 * enforces a CSRF token on GET, the calls fail and we fall back to the form
 * table — never worse than before.
 */

// Lucide "globe" (label/documentation translations).
const ICON_DOC =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9"></circle>' +
  '<path d="M3 12h18"></path>' +
  '<path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"></path></svg>';

// Lucide "languages" (data-value translations).
const ICON_VALUE =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path>' +
  '<path d="M2 5h12"></path><path d="M7 2h1"></path>' +
  '<path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>';

// Lucide "workflow" (client scripts / UI policy actions affecting a variable).
const ICON_VAR_LOGIC =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="3" width="7" height="7" rx="1"></rect>' +
  '<rect x="14" y="14" width="7" height="7" rx="1"></rect>' +
  '<path d="M6.5 10v3a2 2 0 0 0 2 2H14"></path></svg>';

/*
 * Single-row Table API read.
 *
 * This used to fetch directly from the isolated world. That carries the session
 * cookie but NOT the CSRF token, and an instance that enforces the token on REST
 * GETs answers 401 — observed on a real instance for every call. The failure was
 * silent: resolveDefiningTable() caught it and fell back to the form table, so
 * inherited fields resolved to the wrong table and their translations looked
 * absent rather than misfiled.
 *
 * Delegating to snGetMany routes the read through the MAIN-world helper, which
 * attaches X-UserToken from g_ck. Slower than a direct fetch by a message hop,
 * and correct on instances a direct fetch cannot read at all.
 */
async function snGet(table, query, fields) {
  return snGetMany(table, query, fields, 1);
}

async function snGetMany(table, query, fields, limit, options) {
  const resp = await chrome.runtime.sendMessage({
    type: "SN_TABLE_GET",
    table,
    query,
    fields,
    limit: limit || 200,
    options: options || {},
  });
  if (!resp || !resp.ok) {
    throw new Error((resp && resp.error) || "Couldn't read " + table);
  }
  return resp.result || [];
}

function snFieldValue(row, field) {
  const raw = row && row[field];
  if (raw == null) return "";
  if (typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.value != null) return String(raw.value);
    if (raw.display_value != null) return String(raw.display_value);
    return "";
  }
  return String(raw);
}

function snFieldDisplay(row, field) {
  const raw = row && row[field];
  if (raw == null) return "";
  if (typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.display_value != null) return String(raw.display_value);
    if (raw.value != null) return String(raw.value);
    return "";
  }
  return String(raw);
}

function isEmptyPrefillValue(value) {
  return value == null || String(value).trim() === "";
}

function isSysId(value) {
  return /^[0-9a-f]{32}$/i.test(String(value || ""));
}

function normalizeSourceInput(input) {
  const text = String(input || "").trim();
  const sysId = sysIdFromText(text) || (/^[0-9a-f]{32}$/i.test(text) ? text : null);
  if (sysId) return { kind: "sys_id", value: sysId.toLowerCase() };

  const ticketMatch = text.match(/[A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/);
  const value = (ticketMatch ? ticketMatch[0] : text).replace(/\^/g, "").trim();
  return { kind: "number", value };
}

async function resolveVariableSource(input) {
  const parsed = normalizeSourceInput(input);
  if (!parsed.value) throw new Error("Enter a ticket number or sys_id.");

  const taskQuery =
    parsed.kind === "sys_id"
      ? "sys_id=" + parsed.value
      : "number=" + parsed.value;
  const taskRows = await snGetMany(
    "task",
    taskQuery,
    "sys_id,number,sys_class_name",
    2
  );
  const task = taskRows[0];

  if (!task) {
    if (parsed.kind === "sys_id") {
      const catalogItem = await resolveCatalogItemDefinition(parsed.value);
      if (catalogItem) {
        const itemName = catalogItem.name ? " (" + catalogItem.name + ")" : "";
        throw new Error(
          "That sys_id is the catalog item/record producer definition" +
            itemName +
            ". Paste a submitted ticket/record number or sys_id instead."
        );
      }
      return {
        mode: "producer",
        sysId: parsed.value,
        table: null,
        number: null,
        requestItemId: null,
      };
    }
    throw new Error("No task found for " + parsed.value + ".");
  }

  const sysId = snFieldValue(task, "sys_id");
  const table = snFieldValue(task, "sys_class_name");
  const number = snFieldValue(task, "number");

  if (table === "sc_req_item") {
    return { mode: "catalog", sysId, table, number, requestItemId: sysId };
  }

  if (table === "sc_task") {
    const taskDetails = await snGetMany("sc_task", "sys_id=" + sysId, "request_item", 1);
    const requestItemId = snFieldValue(taskDetails[0], "request_item");
    if (!requestItemId) throw new Error("Catalog task has no request item.");
    return { mode: "catalog", sysId, table, number, requestItemId };
  }

  if (table === "sc_request") {
    const ritms = await snGetMany(
      "sc_req_item",
      "request=" + sysId,
      "sys_id,number",
      10
    );
    if (ritms.length === 1) {
      return {
        mode: "catalog",
        sysId,
        table,
        number,
        requestItemId: snFieldValue(ritms[0], "sys_id"),
      };
    }
    if (ritms.length > 1) {
      throw new Error("REQ has " + ritms.length + " items. Paste a specific RITM.");
    }
    throw new Error("REQ has no requested items.");
  }

  return { mode: "producer", sysId, table, number, requestItemId: null };
}

async function resolveCatalogItemDefinition(sysId) {
  const tables = ["sc_cat_item_producer", "sc_cat_item"];
  for (const table of tables) {
    try {
      const rows = await snGetMany(
        table,
        "sys_id=" + sysId,
        "sys_id,name,sys_class_name",
        1,
        { displayAll: true, excludeRefLinks: true }
      );
      if (rows.length) {
        return {
          table,
          name: snFieldDisplay(rows[0], "name"),
          className: snFieldValue(rows[0], "sys_class_name"),
        };
      }
    } catch (e) {}
  }
  return null;
}

const UNSUPPORTED_VARIABLE_TYPES = new Set([
  "11",
  "12",
  "14",
  "15",
  "17",
  "19",
  "20",
  "24",
  "25",
  "31",
  "32",
  "container",
  "container_end",
  "container_start",
  "encrypted",
  "label",
  "macro",
  "password",
  "rich_text_label",
]);

function normalizeVariableType(type) {
  return String(type || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function isAttachmentVariableType(type) {
  const normalized = normalizeVariableType(type);
  return normalized === "33" || normalized === "attachment";
}

// Page furniture: layout dividers, instructional HTML, captions, the container
// boundaries, and the embedded-widget types. None of them has a value on either
// side, so the panel drops them outright rather than listing them as
// permanently uncomparable noise. Their policy entries stay structural so a row
// that somehow reaches the comparison is still never fetched. Type labels are
// matched alongside the numbers because a definition may carry either: types 14
// and 17 read "Custom"/"Custom with Label" on current releases and "Macro"/
// "Macro with Label" on older ones. No structural type reaches the panel now.
const PANEL_OMITTED_VARIABLE_TYPES = new Set([
  "11",
  "12",
  "14",
  "15",
  "17",
  "19",
  "20",
  "24",
  "32",
  "break",
  "container_end",
  "container_split",
  "container_start",
  "custom",
  "custom_with_label",
  "label",
  "macro",
  "macro_with_label",
  "rich_text_label",
  "ui_page",
]);

function isPanelOmittedVariableType(type, typeDisplay) {
  return [normalizeVariableType(type), normalizeVariableType(typeDisplay)].some(
    (candidate) => PANEL_OMITTED_VARIABLE_TYPES.has(candidate)
  );
}

function isMultiRowVariableSetType(type) {
  const normalized = normalizeVariableType(type);
  return (
    normalized === "34" ||
    normalized === "multi_row" ||
    normalized === "multi_row_variable_set" ||
    normalized === "multi-row_variable_set"
  );
}

function isUnsupportedVariableType(type) {
  const normalized = normalizeVariableType(type);
  return normalized && UNSUPPORTED_VARIABLE_TYPES.has(normalized);
}

// Detects a multi-row variable set from an item_option_new_set record, whose
// own `type` reads "one_to_many"/"Multiple Rows" rather than the variable-level
// codes handled by isMultiRowVariableSetType.
function isMultiRowSetType(typeValue, typeDisplay) {
  const value = normalizeVariableType(typeValue);
  const display = normalizeVariableType(typeDisplay);
  return (
    value === "one_to_many" ||
    display.indexOf("multi") >= 0 ||
    isMultiRowVariableSetType(typeValue)
  );
}

// Numeric question-type codes are not stable enough to infer visibility here.
// In particular, 18 is Lookup Select Box on the verified developer instance,
// so treating it as Hidden mislabels ordinary variables. Only an explicit type
// label is accepted; the native path also uses the form's own visibility report.
function isHiddenVariableType(type, typeDisplay) {
  return (
    normalizeVariableType(type) === "hidden" ||
    normalizeVariableType(typeDisplay) === "hidden"
  );
}

function isSecretVariableType(type) {
  const normalized = normalizeVariableType(type);
  return (
    normalized === "25" ||
    normalized === "masked" ||
    normalized === "password" ||
    normalized === "encrypted"
  );
}

function parseVariableOrder(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return { known: false, value: 0 };
  const order = Number(text);
  return Number.isFinite(order)
    ? { known: true, value: order }
    : { known: false, value: 0 };
}

function normalizeSourceVariable(row, mapping) {
  const name = snFieldValue(row, mapping.name).trim();
  const value = snFieldValue(row, mapping.value);
  const type = snFieldValue(row, mapping.type);
  if (!name) return { variable: null, skipped: 0 };
  if (isEmptyPrefillValue(value) && !isMultiRowVariableSetType(type)) {
    return { variable: null, skipped: 0 };
  }
  if (isUnsupportedVariableType(type)) return { variable: null, skipped: 1 };
  const order = parseVariableOrder(mapping.order ? snFieldValue(row, mapping.order) : "");

  return {
    variable: {
      name,
      label: snFieldDisplay(row, mapping.label),
      type,
      value,
      displayValue: snFieldDisplay(row, mapping.value),
      order: order.value,
      orderKnown: order.known,
      sourceSysId: mapping.sysId ? snFieldValue(row, mapping.sysId) : "",
      questionId: mapping.questionId ? snFieldValue(row, mapping.questionId) : "",
      variableSet: mapping.variableSet ? snFieldValue(row, mapping.variableSet) : "",
      referenceTable:
        (mapping.referenceTable ? snFieldValue(row, mapping.referenceTable) : "") ||
        (mapping.lookupTable ? snFieldValue(row, mapping.lookupTable) : "") ||
        (mapping.listTable ? snFieldValue(row, mapping.listTable) : ""),
    },
    skipped: 0,
  };
}

function addVariablesFromRows(target, rows, mapping) {
  let skipped = 0;
  rows.forEach((row, index) => {
    const normalized = normalizeSourceVariable(row, mapping);
    skipped += normalized.skipped;
    if (!normalized.variable) return;
    if (!target.has(normalized.variable.name)) {
      normalized.variable.sourceIndex = target.size + index / 100000;
      target.set(normalized.variable.name, normalized.variable);
    }
  });
  return skipped;
}

async function fetchCatalogVariables(requestItemId) {
  const rows = await snGetMany(
    "sc_item_option_mtom",
    "request_item=" + requestItemId,
    [
      "sc_item_option.sys_id",
      "sc_item_option.value",
      "sc_item_option.item_option_new",
      "sc_item_option.item_option_new.name",
      "sc_item_option.item_option_new.question_text",
      "sc_item_option.item_option_new.type",
      "sc_item_option.item_option_new.order",
      "sc_item_option.item_option_new.variable_set",
      "sc_item_option.item_option_new.reference",
      "sc_item_option.item_option_new.lookup_table",
      "sc_item_option.item_option_new.list_table",
    ].join(","),
    300,
    { displayAll: true, excludeRefLinks: true }
  );
  const variables = new Map();
  const skipped = addVariablesFromRows(variables, rows, {
    name: "sc_item_option.item_option_new.name",
    label: "sc_item_option.item_option_new.question_text",
    type: "sc_item_option.item_option_new.type",
    order: "sc_item_option.item_option_new.order",
    value: "sc_item_option.value",
    sysId: "sc_item_option.sys_id",
    questionId: "sc_item_option.item_option_new",
    variableSet: "sc_item_option.item_option_new.variable_set",
    referenceTable: "sc_item_option.item_option_new.reference",
    lookupTable: "sc_item_option.item_option_new.lookup_table",
    listTable: "sc_item_option.item_option_new.list_table",
  });
  return { variables, skipped };
}

async function fetchProducerVariables(source) {
  const sysId = typeof source === "string" ? source : source && source.sysId;
  const table = typeof source === "object" && source ? source.table : "";
  const fields = [
    "sys_id",
    "value",
    "table_name",
    "table_sys_id",
    "document",
    "question",
    "question.active",
    "question.name",
    "question.question_text",
    "question.type",
    "question.order",
    "question.variable_set",
    "question.reference",
    "question.lookup_table",
    "question.list_table",
  ].join(",");
  const queries = table && sysId
    ? ["table_sys_id=" + sysId + "^table_name=" + table]
    : [];
  const variables = new Map();
  let skipped = 0;
  let readAny = false;
  const queriesUsed = [];

  for (const query of queries) {
    try {
      const rows = await snGetMany("question_answer", query, fields, 300, {
        displayAll: true,
        excludeRefLinks: true,
      });
      if (!rows.length) continue;
      readAny = true;
      queriesUsed.push(query);
      skipped += addVariablesFromRows(variables, rows, {
        name: "question.name",
        label: "question.question_text",
        type: "question.type",
        order: "question.order",
        value: "value",
        sysId: "sys_id",
        questionId: "question",
        variableSet: "question.variable_set",
        referenceTable: "question.reference",
        lookupTable: "question.lookup_table",
        listTable: "question.list_table",
      });
    } catch (e) {}
  }

  return { variables, skipped, readAny, queryUsed: queriesUsed.join(" | ") };
}

function isAttachmentVariable(variable) {
  return isAttachmentVariableType((variable && variable.type) || "");
}

function isMultiRowVariableSet(variable) {
  return isMultiRowVariableSetType((variable && variable.type) || "");
}

/*
 * Prefill copies values across unchanged.
 *
 * It used to mutate a few of them on the way past, appending random letters to
 * four variables matched by name so a copied record would clear a uniqueness
 * constraint on one instance's catalog. Same mistake as the hardcoded
 * prefill-timing Set — one tenant's vocabulary deciding behaviour for everyone
 * — but worse, because it silently CORRUPTED the copied value for anybody else
 * whose variables happened to share those names, with nothing in the UI saying
 * it had happened. The names are deliberately not repeated here; they were
 * somebody's internal catalog and this repo is public.
 *
 * Do not reintroduce name matching. If clearing a uniqueness constraint is
 * worth solving, it is a visible, opt-in transform the user asks for and can
 * see in the result, not a rule keyed off variable names.
 */

function splitSysIdList(value) {
  return String(value == null ? "" : value)
    .split(",")
    .map((item) => item.trim())
    .filter(isSysId);
}

function splitMaybeSysIdList(value) {
  return String(value == null ? "" : value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function resolveAttachmentDisplayValues(variables, onProgress) {
  const attachmentVariables = Array.from(variables.values()).filter(
    (variable) => isAttachmentVariable(variable) && splitSysIdList(variable.value).length > 0
  );
  if (!attachmentVariables.length) return;

  const ids = [];
  attachmentVariables.forEach((variable) => {
    splitSysIdList(variable.value).forEach((id) => {
      if (ids.indexOf(id) < 0) ids.push(id);
    });
  });
  if (!ids.length) return;

  if (onProgress) onProgress("Resolving attachment names…");

  try {
    const rows = await snGetMany(
      "sys_attachment",
      ids.length === 1 ? "sys_id=" + ids[0] : "sys_idIN" + ids.join(","),
      "sys_id,file_name,content_type,size_bytes,table_name,table_sys_id",
      ids.length,
      { displayAll: true, excludeRefLinks: true }
    );
    const byId = {};
    rows.forEach((row) => {
      const id = snFieldValue(row, "sys_id");
      if (!id) return;
      byId[id] = {
        sysId: id,
        fileName: snFieldDisplay(row, "file_name") || id,
        contentType: snFieldValue(row, "content_type"),
        sizeBytes: snFieldValue(row, "size_bytes"),
        tableName: snFieldValue(row, "table_name"),
        tableSysId: snFieldValue(row, "table_sys_id"),
      };
    });

    attachmentVariables.forEach((variable) => {
      const variableIds = splitMaybeSysIdList(variable.value);
      const attachments = variableIds.map((id) => byId[id]).filter(Boolean);
      if (!attachments.length) return;
      variable.attachments = attachments;
      variable.displayValue = attachments.map((attachment) => attachment.fileName).join(",");
    });
  } catch (e) {
    /* Keep the raw attachment sys_id if metadata lookup is blocked. */
  }
}

function candidateMultiRowParents(source, variables) {
  const ids = [];
  const parentById = {};
  const add = (value, parent) => {
    if (!isSysId(value)) return;
    if (ids.indexOf(value) < 0) ids.push(value);
    if (parent && !parentById[value]) parentById[value] = parent;
  };
  add(source && source.requestItemId);
  add(source && source.sysId);
  variables.forEach((variable) => {
    if (!isMultiRowVariableSet(variable)) return;
    add(variable.sourceSysId, variable);
    add(variable.questionId, variable);
    add(variable.variableSet, variable);
  });
  return { ids, parentById };
}

async function fetchMultiRowAnswerRows(parentIds) {
  const rows = [];
  const seen = new Set();
  const queries = [];
  const fields = [
    "sys_id",
    "parent_id",
    "row_index",
    "variable_set",
    "variable_set.name",
    "variable_set.internal_name",
    "variable_set.title",
    "item_option_new",
    "item_option_new.name",
    "item_option_new.question_text",
    "item_option_new.type",
    "item_option_new.order",
    "item_option_new.reference",
    "item_option_new.lookup_table",
    "item_option_new.list_table",
    "value",
  ].join(",");

  for (const parentId of parentIds) {
    const query = "parent_id=" + parentId;
    try {
      const result = await snGetMany("sc_multi_row_question_answer", query, fields, 1000, {
        displayAll: true,
        excludeRefLinks: true,
      });
      if (result.length) queries.push(query);
      result.forEach((row) => {
        row.__queryParentId = parentId;
        const key =
          snFieldValue(row, "sys_id") ||
          [
            snFieldValue(row, "parent_id"),
            snFieldValue(row, "variable_set"),
            snFieldValue(row, "row_index"),
            snFieldValue(row, "item_option_new"),
            snFieldValue(row, "value"),
          ].join(":");
        if (seen.has(key)) return;
        seen.add(key);
        rows.push(row);
      });
    } catch (e) {}
  }

  return { rows, queryUsed: queries.join(" | ") };
}

function addMultiRowVariablesFromAnswerRows(target, rows, parentById) {
  if (!rows.length) return 0;

  const parentVariables = Array.from(target.values()).filter(isMultiRowVariableSet);
  const bySet = {};
  rows.forEach((row) => {
    const setId = snFieldValue(row, "variable_set") || "unknown";
    const queryParent = row.__queryParentId && parentById && parentById[row.__queryParentId];
    const groupKey = queryParent ? "parent:" + row.__queryParentId : "set:" + setId;
    if (!bySet[groupKey]) bySet[groupKey] = [];
    bySet[groupKey].push(row);
  });

  Object.keys(bySet).forEach((groupKey) => {
    const answerRows = bySet[groupKey];
    const first = answerRows[0] || {};
    const setId = snFieldValue(first, "variable_set") || "unknown";
    const queryParent = first.__queryParentId && parentById && parentById[first.__queryParentId];
    const setName =
      snFieldValue(first, "variable_set.internal_name") ||
      snFieldValue(first, "variable_set.name") ||
      setId;
    const setLabel =
      snFieldDisplay(first, "variable_set.title") ||
      snFieldDisplay(first, "variable_set.name") ||
      setName;
    const parent =
      queryParent ||
      parentVariables.find((variable) => variable.variableSet === setId || variable.questionId === setId) ||
      parentVariables.find((variable) => variable.name === setName);
    const name = (parent && parent.name) || setName;
    if (!name || name === "unknown") return;

    const rowsByIndex = {};
    const displayRowsByIndex = {};
    answerRows.forEach((row, answerIndex) => {
      const rowIndex = snFieldValue(row, "row_index") || String(answerIndex + 1);
      const columnName =
        snFieldValue(row, "item_option_new.name") ||
        snFieldValue(row, "item_option_new") ||
        "column_" + answerIndex;
      if (!columnName) return;
      if (!rowsByIndex[rowIndex]) rowsByIndex[rowIndex] = {};
      if (!displayRowsByIndex[rowIndex]) displayRowsByIndex[rowIndex] = {};
      rowsByIndex[rowIndex][columnName] = snFieldValue(row, "value");
      displayRowsByIndex[rowIndex][columnName] = snFieldDisplay(row, "value");
    });

    const orderedIndexes = Object.keys(rowsByIndex).sort((a, b) => Number(a) - Number(b));
    const valueRows = orderedIndexes.map((rowIndex) => rowsByIndex[rowIndex]);
    const displayRows = orderedIndexes.map((rowIndex) => displayRowsByIndex[rowIndex]);
    if (!valueRows.length) return;

    target.set(name, {
      name,
      label: (parent && parent.label) || setLabel,
      type: (parent && parent.type) || "multi_row_variable_set",
      value: JSON.stringify(valueRows),
      displayValue: JSON.stringify(displayRows),
      order: parent && Number.isFinite(parent.order) ? parent.order : 0,
      orderKnown: Boolean(parent && parent.orderKnown),
      sourceSysId: parent && parent.sourceSysId,
      questionId: parent && parent.questionId,
      variableSet: setId,
      rowCount: valueRows.length,
      columns: Array.from(
        new Set(
          answerRows
            .map((row) => snFieldValue(row, "item_option_new.name") || snFieldValue(row, "item_option_new"))
            .filter(Boolean)
        )
      ),
      sourceIndex: parent && Number.isFinite(parent.sourceIndex) ? parent.sourceIndex : target.size,
    });
  });

  return Object.keys(bySet).length;
}

function currentCatalogItemDefinitionSysId() {
  try {
    const url = new URL(location.href);
    const sysId = url.searchParams.get("sys_id");
    if (isSysId(sysId)) return sysId;
  } catch (e) {}

  try {
    const el = document.querySelector(
      "[cat-item-sys-id],[data-item-sys-id],[data-sys-id]"
    );
    const sysId =
      (el &&
        (el.getAttribute("cat-item-sys-id") ||
          el.getAttribute("data-item-sys-id") ||
          el.getAttribute("data-sys-id"))) ||
      "";
    if (isSysId(sysId)) return sysId;
  } catch (e) {}
  return "";
}

async function applyVariableSetPlacementOrder(variables, catalogItemSysId, onProgress) {
  variables.forEach((variable) => {
    variable.variableSetOrder = 0;
    variable.variableSetOrderKnown = false;
    variable.effectiveOrder = variable.order;
    variable.effectiveOrderKnown = variable.orderKnown;
  });

  if (!isSysId(catalogItemSysId)) return;
  const setIds = Array.from(
    new Set(
      Array.from(variables.values())
        .map((variable) => String(variable.variableSet || "").trim())
        .filter(isSysId)
    )
  );
  if (!setIds.length) return;
  if (onProgress) onProgress("Resolving variable set placement order…");

  try {
    const rows = await snGetMany(
      "io_set_item",
      "sc_cat_item=" + catalogItemSysId + "^variable_setIN" + setIds.join(","),
      "variable_set,order",
      setIds.length,
      { displayAll: true, excludeRefLinks: true }
    );
    const placementBySet = {};
    rows.forEach((row) => {
      const setId = snFieldValue(row, "variable_set");
      const placement = parseVariableOrder(snFieldValue(row, "order"));
      if (isSysId(setId) && placement.known) {
        placementBySet[setId] = placement.value;
      }
    });

    variables.forEach((variable) => {
      const setId = String(variable.variableSet || "").trim();
      if (!Object.prototype.hasOwnProperty.call(placementBySet, setId)) return;
      variable.variableSetOrder = placementBySet[setId];
      variable.variableSetOrderKnown = true;
      variable.effectiveOrder = placementBySet[setId];
      variable.effectiveOrderKnown = true;
    });
  } catch (e) {
    /* Fall back to each child variable's own order if io_set_item is unavailable. */
  }
}

function sortVariablesForFill(variables) {
  return Array.from(variables.values()).sort((a, b) => {
    const aIsMrvs = isMultiRowVariableSet(a);
    const bIsMrvs = isMultiRowVariableSet(b);
    if (aIsMrvs !== bIsMrvs) return aIsMrvs ? 1 : -1;
    if (a.effectiveOrderKnown !== b.effectiveOrderKnown) {
      return a.effectiveOrderKnown ? -1 : 1;
    }
    const orderA = Number.isFinite(a.effectiveOrder) ? a.effectiveOrder : 0;
    const orderB = Number.isFinite(b.effectiveOrder) ? b.effectiveOrder : 0;
    if (orderA !== orderB) return orderA - orderB;
    if (
      a.variableSet &&
      b.variableSet &&
      a.variableSet === b.variableSet
    ) {
      if (a.orderKnown !== b.orderKnown) return a.orderKnown ? -1 : 1;
      const innerOrderA = Number.isFinite(a.order) ? a.order : 0;
      const innerOrderB = Number.isFinite(b.order) ? b.order : 0;
      if (innerOrderA !== innerOrderB) return innerOrderA - innerOrderB;
    }
    const indexA = Number.isFinite(a.sourceIndex) ? a.sourceIndex : 999999;
    const indexB = Number.isFinite(b.sourceIndex) ? b.sourceIndex : 999999;
    if (indexA !== indexB) return indexA - indexB;
    return String(a.name || "").localeCompare(String(b.name || ""));
  }).map((variable, index) => {
    variable.fillOrder = index + 1;
    return variable;
  });
}

async function fetchSourceVariables(source, onProgress) {
  const variables = new Map();
  let skipped = 0;
  let hadReadError = false;

  if (source.mode === "catalog" && source.requestItemId) {
    try {
      if (onProgress) onProgress("Reading catalog variables…");
      const catalog = await fetchCatalogVariables(source.requestItemId);
      skipped += catalog.skipped;
      catalog.variables.forEach((variable, name) => variables.set(name, variable));
    } catch (e) {
      hadReadError = true;
    }
  }

  try {
    if (onProgress) onProgress("Reading producer variables…");
    const producer = await fetchProducerVariables(source);
    skipped += producer.skipped;
    if (producer.queryUsed) source.producerAnswerQuery = producer.queryUsed;
    producer.variables.forEach((variable, name) => {
      if (!variables.has(name)) variables.set(name, variable);
    });
  } catch (e) {
    if (source.mode === "producer") hadReadError = true;
  }

  try {
    const parents = candidateMultiRowParents(source, variables);
    if (parents.ids.length) {
      if (onProgress) onProgress("Reading multi-row variable sets…");
      const mrvs = await fetchMultiRowAnswerRows(parents.ids);
      if (mrvs.queryUsed) source.multiRowAnswerQuery = mrvs.queryUsed;
      addMultiRowVariablesFromAnswerRows(variables, mrvs.rows, parents.parentById);
    }
  } catch (e) {}

  if (!variables.size && hadReadError) {
    throw new Error("Couldn't read variables. Check access to catalog variable tables.");
  }

  await applyVariableSetPlacementOrder(
    variables,
    currentCatalogItemDefinitionSysId(),
    onProgress
  );
  await resolveAttachmentDisplayValues(variables, onProgress);

  return { variables: sortVariablesForFill(variables), skipped };
}

async function prefillPortalVariablesFromTicket(input) {
  const value = String(input || "").trim();
  if (!value) {
    showToast("Enter a ticket number or sys_id", true);
    return;
  }

  showToast("Reading variables…", false, 6000);
  try {
    const source = await resolveVariableSource(value);
    const sourceResult = await fetchSourceVariables(source, (message) => showToast(message, false, 6000));
    const variables = sourceResult.variables;
    SNH.lastPrefillVariables = variables;
    SNH.lastPrefillSource = {
      input: value,
      mode: source.mode,
      sysId: source.sysId,
      table: source.table,
      number: source.number,
      requestItemId: source.requestItemId,
      producerAnswerQuery: source.producerAnswerQuery,
      multiRowAnswerQuery: source.multiRowAnswerQuery,
    };
    if (!variables.length) {
      const suffix = sourceResult.skipped ? " (" + sourceResult.skipped + " unsupported)" : "";
      showToast("No copyable variables found" + suffix, true);
      return;
    }

    showToast("Found " + variables.length + " variables. Filling portal form…", false, 6000);
    await new Promise((resolve) => setTimeout(resolve, 75));
    /*
     * The worker bounds the fill by inactivity, but nothing bounds this await
     * if the worker itself is torn down mid-operation and the reply never
     * arrives. A backstop well above any honest fill turns that into an error
     * rather than a palette that never comes back.
     */
    const resp = await Promise.race([
      chrome.runtime.sendMessage({ type: "FILL_PORTAL_VARIABLES", variables }),
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              error:
                "Prefill did not report back. It may still be running — " +
                "reload the form before trying again.",
            }),
          PREFILL_REPLY_CEILING_MS
        )
      ),
    ]);
    SNH.lastPrefillResult = resp || null;

    if (!resp || !resp.ok) {
      throw new Error((resp && resp.error) || "Couldn't fill portal variables.");
    }
    if (!resp.foundForm) {
      showToast("Open a catalog order form first", true);
      return;
    }

    const skipped = (resp.skipped || 0) + (sourceResult.skipped || 0);
    const already = resp.alreadySet || 0;
    const unmatched = resp.unmatched || 0;
    let message = "Filled " + (resp.filled || 0) + " of " + variables.length + " variables";
    const details = [];
    if (already) details.push(already + " already set");
    if (unmatched) details.push(unmatched + " not on this form");
    if (skipped) details.push(skipped + " skipped");
    if (details.length) message += " (" + details.join(", ") + ")";
    if (!resp.filled && unmatched === variables.length) {
      message = "No matching variables on this form (" + unmatched + " not found)";
    }
    showToast(message);
  } catch (error) {
    showToast(String(error && error.message ? error.message : error), true);
  }
}

async function copyPortalVariableDebugInfo() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_PORTAL_VARIABLE_DEBUG" });
    if (!resp || !resp.ok) {
      throw new Error((resp && resp.error) || "Couldn't inspect portal form.");
    }
    const report = {
      url: location.href,
      sourceInfo: SNH.lastPrefillSource,
      fillResult: SNH.lastPrefillResult,
      sourceVariables: SNH.lastPrefillVariables.map((variable) => ({
        fillOrder: variable.fillOrder,
        name: variable.name,
        label: variable.label,
        type: variable.type,
        questionOrder: variable.order,
        orderKnown: variable.orderKnown,
        effectiveOrder: variable.effectiveOrder,
        effectiveOrderKnown: variable.effectiveOrderKnown,
        questionId: variable.questionId,
        variableSet: variable.variableSet,
        variableSetOrder: variable.variableSetOrder,
        variableSetOrderKnown: variable.variableSetOrderKnown,
        referenceTable: variable.referenceTable,
        referenceDisplayField: variable.referenceDisplayField,
        valueLength: variable.value ? String(variable.value).length : 0,
        displayValue: variable.displayValue,
        rowCount: variable.rowCount,
        attachmentNames: Array.isArray(variable.attachments)
          ? variable.attachments.map((attachment) => attachment.fileName)
          : undefined,
      })),
      frames: resp.frames || [],
    };
    await copyText(JSON.stringify(report, null, 2));
    showToast("Copied portal variable debug info");
  } catch (error) {
    showToast(String(error && error.message ? error.message : error), true);
  }
}

/*
 * Hidden portal variables: for a catalog item currently being filled out,
 * find variables that are permanently "Hidden" type, or currently switched
 * off by a UI Policy/catalog client script. Read-only inspector — never
 * forces the live Angular form to reveal real editable fields.
 */

const SENSITIVE_VARIABLE_NAME_PATTERN =
  /(password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|authorization)/i;

function isSensitiveVariableName(name, label) {
  return (
    SENSITIVE_VARIABLE_NAME_PATTERN.test(String(name || "")) ||
    SENSITIVE_VARIABLE_NAME_PATTERN.test(String(label || ""))
  );
}

/*
 * Native RITM comparison policy. This is deliberately a positive allowlist:
 * only explicitly approved types may enter the stored-value request.
 * Every other observed type has an explicit non-fetching disposition, and a
 * type missing from the map is denied by default.
 */
const NATIVE_INTERNAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

const NATIVE_VARIABLE_TYPE_POLICIES = new Map([
  ["1", { disposition: "comparable", comparisonMode: "boolean" }],
  ["2", { disposition: "comparable", comparisonMode: "scalar" }],
  ["3", { disposition: "comparable", comparisonMode: "scalar" }],
  ["4", { disposition: "denied" }],
  ["5", { disposition: "comparable", comparisonMode: "scalar" }],
  ["6", { disposition: "comparable", comparisonMode: "scalar" }],
  ["7", { disposition: "comparable", comparisonMode: "boolean" }],
  ["8", { disposition: "comparable", comparisonMode: "scalar" }],
  ["9", { disposition: "comparable", comparisonMode: "date" }],
  ["10", { disposition: "comparable", comparisonMode: "datetime" }],
  ["11", { disposition: "structural" }],
  ["12", { disposition: "structural" }],
  ["14", { disposition: "structural" }],
  ["15", { disposition: "structural" }],
  ["16", { disposition: "comparable", comparisonMode: "scalar" }],
  ["17", { disposition: "structural" }],
  ["18", { disposition: "comparable", comparisonMode: "scalar" }],
  ["19", { disposition: "structural" }],
  ["20", { disposition: "structural" }],
  ["21", { disposition: "comparable", comparisonMode: "set" }],
  ["22", { disposition: "comparable", comparisonMode: "scalar" }],
  ["23", { disposition: "denied" }],
  ["24", { disposition: "structural" }],
  ["25", { disposition: "secret" }],
  ["26", { disposition: "comparable", comparisonMode: "scalar" }],
  ["27", { disposition: "comparable", comparisonMode: "scalar" }],
  ["28", { disposition: "comparable", comparisonMode: "scalar" }],
  ["29", { disposition: "denied" }],
  ["31", { disposition: "comparable", comparisonMode: "scalar" }],
  ["32", { disposition: "structural" }],
  ["33", { disposition: "comparable", comparisonMode: "scalar" }],
  ["34", { disposition: "mrvs" }],
  ["40", { disposition: "denied" }],
  ["masked", { disposition: "secret" }],
  ["password", { disposition: "secret" }],
  ["encrypted", { disposition: "secret" }],
  ["multi_row", { disposition: "mrvs" }],
  ["multi_row_variable_set", { disposition: "mrvs" }],
  ["multi-row_variable_set", { disposition: "mrvs" }],
]);

/*
 * A multi-row variable set is exposed as ONE value holding every column of
 * every row, and the columns inside that value are not represented the way the
 * same type is represented as a standalone variable. So the type allowlist a
 * surface proves for its ordinary variables says nothing about what is safe
 * inside a set, and these are separate, per-surface lists.
 *
 * The distinction is not theoretical. A Date/Time column inside a set came
 * back as "21-04-2026 07:13:37" while storage held "2026-04-21 14:13:37" —
 * formatted to the user's date format and shifted into the session timezone,
 * where the same type read as a standalone variable is raw canonical UTC.
 * Comparing that set would have reported a difference in a record where none
 * exists. Date and Date/Time columns are therefore excluded on every surface;
 * a set containing one is listed with its stored rows and never compared.
 *
 * Everything listed below was observed raw inside the container, with the
 * display labels appearing in the entry's parallel displayValue array instead:
 * references as sys_ids against display names, choices as stored values
 * against labels, attachments as attachment sys_ids against file names.
 */
/*
 * SOW's list is short because that is all its sets have been seen to hold, and
 * a deliberate attempt to widen it found nothing to widen it with: of the sets
 * on that instance holding another type, every candidate request item rendered
 * no catalog form at all on the Workspace route -- no form component, no
 * Variables tab, nothing in the fields map -- while a control record mounted
 * normally in the same session. Multi Line Text, Checkbox, Email and Duration
 * are each waiting on a record that both holds one and renders its form.
 * Duration is worth suspecting when it does: it is a formatted type, so expect
 * it to behave like a date inside a container rather than like raw text.
 */
const WORKSPACE_SOW_MRVS_COLUMN_TYPES = new Set(["5", "6", "8"]);
const WORKSPACE_SUPPLIER_MRVS_COLUMN_TYPES = new Set([
  "1", "2", "5", "6", "7", "8", "33",
]);

// Workspace values come from undocumented component state, so comparison is
// independently positive-allowlisted per verified layer. Never inherit a
// classic-comparable type merely because its stored representation is known.
//
// Type 1 (Yes/No) does not have one stored spelling. It holds "Yes"/"No" on
// the configured instance, and the stock one holds BOTH — "Yes" from an
// order placed through the portal and "true" from one placed through the
// catalog API, which stored verbatim what it was handed. The spelling
// follows the write path rather than the platform, which is exactly why it
// is compared by boolean meaning rather than as a raw string:
// that mode folds yes/no, true/false and 1/0 into the same two buckets on both
// sides, and an empty value stays its own state. A raw comparison would report
// a difference between spellings that mean the same thing.
//
// Type 18 (Lookup Select Box) is a choice pair, not a reference: its raw value
// is the lookup table's value column, which was free text in 256 of 293 stored
// rows on the configured instance, a sys_id in 28 and comma-bearing text in 9.
// Validating it as a sys_id would have refused most real lookups.
//
// Type 33 (Attachment) is validated as a sys_id, which is what every observed
// value was — the attachment's own record, against a file name in
// displayValue. A multi-attachment value would fall outside that shape and
// stay uncompared, which is the right direction to fail in.
//
// Types 18 and 33 were each re-proven on a second instance, against a
// catalog fixture the platform itself ordered rather than a hand-written
// row: the lookup in both shapes it takes, and a real attachment.
//
// Type 34 is the multi-row variable set. Its live value is the whole set at
// once, so it carries the same all-columns-safe precondition the classic path
// applies, on top of this per-surface proof.
const WORKSPACE_SOW_RITM_TYPE_POLICIES = new Map([
  ["1", { disposition: "comparable", comparisonMode: "boolean", validator: "boolean-pair", layer: 1 }],
  ["2", { disposition: "comparable", comparisonMode: "scalar", validator: "text-pair", layer: 1 }],
  ["5", { disposition: "comparable", comparisonMode: "scalar", validator: "choice-pair", layer: 1 }],
  ["6", { disposition: "comparable", comparisonMode: "scalar", validator: "text-pair", layer: 1 }],
  ["7", { disposition: "comparable", comparisonMode: "boolean", validator: "boolean-pair", layer: 1 }],
  ["8", { disposition: "comparable", comparisonMode: "scalar", validator: "sys-id", layer: 1 }],
  ["9", { disposition: "comparable", comparisonMode: "date", validator: "date-pair", layer: 1 }],
  ["10", { disposition: "comparable", comparisonMode: "datetime", validator: "datetime-pair", layer: 1 }],
  ["18", { disposition: "comparable", comparisonMode: "scalar", validator: "choice-pair", layer: 1 }],
  ["21", { disposition: "comparable", comparisonMode: "set", validator: "sys-id-list", layer: 1 }],
  ["26", { disposition: "comparable", comparisonMode: "scalar", validator: "text-pair", layer: 1 }],
  ["31", { disposition: "comparable", comparisonMode: "scalar", validator: "sys-id", layer: 1 }],
  ["33", { disposition: "comparable", comparisonMode: "scalar", validator: "sys-id", layer: 1 }],
  ["34", {
    disposition: "mrvs",
    validator: "mrvs-pair",
    layer: 1,
    columnTypes: WORKSPACE_SOW_MRVS_COLUMN_TYPES,
  }],
]);

/*
 * Per-type evidence does not transfer between Workspace surfaces: every entry
 * above was proven against one component on one route. The supplier surfaces
 * render through the same `sn-catalog-form` and the same `variables.<name>`
 * fields map, but each type still had to be re-proven there against
 * question_answer storage before it was listed below.
 *
 * Deliberately absent, and why:
 *
 * - 9 and 31 had no stored example on any probed supplier record, so there is
 *   no evidence to allowlist from.
 *
 * 10 (Date/Time) was withheld here for one release because the only supplier
 * record that stored one never rendered it into the form, so the
 * raw-to-display-to-zone proof could not run. A supplier task that does render
 * one supplied it: raw "2026-08-23 17:51:39" against a display of
 * "23-08-2026 10:51:39" under a session zone seven hours behind UTC and a
 * dd-MM-yyyy user format — the same canonical-UTC-plus-formatted-display pair
 * the SOW proof rests on, in a zone and format that would have exposed a
 * substitution rather than hidden it.
 *
 * Two of the probed values did differ, and both were the comparison working:
 * a hidden Checkbox whose committed state was empty while storage held
 * "false", and a Multi Line Text holding an application JSON payload with a
 * localised display label inside it, recomputed by the form in the session
 * language. Neither is a representation defect, so neither type is withheld.
 */
const WORKSPACE_SUPPLIER_TYPE_POLICIES = new Map([
  ["1", { disposition: "comparable", comparisonMode: "boolean", validator: "boolean-pair", layer: 1 }],
  ["2", { disposition: "comparable", comparisonMode: "scalar", validator: "text-pair", layer: 1 }],
  ["5", { disposition: "comparable", comparisonMode: "scalar", validator: "choice-pair", layer: 1 }],
  ["6", { disposition: "comparable", comparisonMode: "scalar", validator: "text-pair", layer: 1 }],
  ["7", { disposition: "comparable", comparisonMode: "boolean", validator: "boolean-pair", layer: 1 }],
  ["8", { disposition: "comparable", comparisonMode: "scalar", validator: "sys-id", layer: 1 }],
  ["10", { disposition: "comparable", comparisonMode: "datetime", validator: "datetime-pair", layer: 1 }],
  ["18", { disposition: "comparable", comparisonMode: "scalar", validator: "choice-pair", layer: 1 }],
  ["21", { disposition: "comparable", comparisonMode: "set", validator: "sys-id-list", layer: 1 }],
  ["26", { disposition: "comparable", comparisonMode: "scalar", validator: "text-pair", layer: 1 }],
  ["33", { disposition: "comparable", comparisonMode: "scalar", validator: "sys-id", layer: 1 }],
  ["34", {
    disposition: "mrvs",
    validator: "mrvs-pair",
    layer: 1,
    columnTypes: WORKSPACE_SUPPLIER_MRVS_COLUMN_TYPES,
  }],
]);

// Keyed by the same "<experience path>:<table>" pair the router allowlists, so
// a surface can never silently inherit another surface's proven types. A
// surface with no entry compares nothing and lists every variable instead.
const WORKSPACE_TYPE_POLICIES_BY_SURFACE = new Map([
  ["sow:sc_req_item", WORKSPACE_SOW_RITM_TYPE_POLICIES],
  ["psm/workspace:sn_slm_case", WORKSPACE_SUPPLIER_TYPE_POLICIES],
  ["psm/workspace:sn_slm_task", WORKSPACE_SUPPLIER_TYPE_POLICIES],
]);

/*
 * Surfaces whose component is known to hand a boolean-typed variable a real
 * JavaScript boolean rather than a string, and may therefore have one read as
 * the value `true`/`false`.
 *
 * Its own list, not a property of the type policy, because this is a statement
 * about a component's representation and those never transfer between surfaces.
 * SOW is absent because nothing proves it either way: no request item on either
 * verified instance exposes a boolean-typed variable at all. If one turns up,
 * probe it before adding the surface here.
 */
const WORKSPACE_BOOLEAN_VALUE_SURFACES = new Set([
  "psm/workspace:sn_slm_case",
  "psm/workspace:sn_slm_task",
]);

const NATIVE_PROTOTYPE_COLLISION_NAMES = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  ...Object.getOwnPropertyNames(Function.prototype),
]);

const NATIVE_DEFINITION_LIMIT = 300;
const NATIVE_SET_LIMIT = 100;
const NATIVE_SET_DEFINITION_LIMIT = 500;
const NATIVE_STORED_METADATA_LIMIT = 300;
const NATIVE_VALUE_BATCH_SIZE = 50;

function nativeTypePolicy(type, typeDisplay) {
  const candidates = [normalizeVariableType(type), normalizeVariableType(typeDisplay)];
  for (const candidate of candidates) {
    if (candidate && NATIVE_VARIABLE_TYPE_POLICIES.has(candidate)) {
      return NATIVE_VARIABLE_TYPE_POLICIES.get(candidate);
    }
  }
  return { disposition: "denied" };
}

function classifyNativeVariable(definition) {
  const def = definition || {};
  if (
    isSecretVariableType(def.type) ||
    isSecretVariableType(def.typeDisplay) ||
    isSensitiveVariableName(def.name, def.label)
  ) {
    return { disposition: "secret" };
  }
  return nativeTypePolicy(def.type, def.typeDisplay);
}

// The canonical key a multi-row variable set is allowlisted under, whichever
// spelling of the type the definition arrived with.
const WORKSPACE_MRVS_POLICY_KEY = "34";

function classifyWorkspaceVariable(definition, surfaceKey) {
  const nativePolicy = classifyNativeVariable(definition);
  if (
    nativePolicy.disposition === "secret" ||
    nativePolicy.disposition === "structural"
  ) {
    return nativePolicy;
  }
  const policies = WORKSPACE_TYPE_POLICIES_BY_SURFACE.get(String(surfaceKey || ""));
  // A multi-row set stays an MRVS row on every surface — it is always listed,
  // and it keeps its own stored read. What the surface decides is only whether
  // its live representation has been proven here, and so whether the row can
  // be compared at all. A surface with no proof returns the bare mrvs
  // disposition, which carries no validator and therefore never compares.
  if (nativePolicy.disposition === "mrvs") {
    const proven = policies && policies.get(WORKSPACE_MRVS_POLICY_KEY);
    return proven && proven.disposition === "mrvs" ? proven : { disposition: "mrvs" };
  }
  if (!policies) return { disposition: "denied" };
  const numericType = normalizeVariableType(definition && definition.type);
  return policies.get(numericType) || { disposition: "denied" };
}

/*
 * One rule for "may this Workspace row's live value be read", shared by the
 * request builder and the panel's candidate count. They used to state it
 * twice, which meant a row could be requested but never counted as something
 * the panel promised to check, or counted and never requested.
 *
 * A multi-row set is the reason the rule is not simply "comparable". Reading
 * one returns the entire set — every column of every row in a single value —
 * so three things must hold, not one: the surface has proven the container
 * representation, the classic all-columns-safe precondition already passed,
 * and every column's type is one this surface has verified the container's
 * own rendering of. A set failing any of them is listed with its stored rows
 * and never read.
 */
function workspaceLiveReadAllowed(definition, policy) {
  const def = definition || {};
  const rule = policy || {};
  if (!def.name || !isSysId(def.questionId)) return false;
  if (NATIVE_PROTOTYPE_COLLISION_NAMES.has(def.name)) return false;
  if (rule.disposition === "comparable") return true;
  if (rule.disposition === "mrvs") {
    return Boolean(
      rule.validator &&
      rule.columnTypes &&
      def.liveReadAllowed === true &&
      Array.isArray(def.mrvsColumnTypes) &&
      def.mrvsColumnTypes.length > 0 &&
      def.mrvsColumnTypes.every(
        (column) => column && rule.columnTypes.has(column.type)
      )
    );
  }
  return false;
}

/*
 * The names no live read may touch, on either world: a name held by more than
 * one definition, or by more than one stored row. Both g_form and the Workspace
 * fields map resolve a name to whichever entry they choose, so reading one
 * could attribute another variable's value to this row.
 *
 * The two counts stay separate on purpose. A definition and its own stored row
 * share a name by construction, so counting them together would call every
 * ordinary variable a duplicate.
 *
 * Every caller takes the set from here. The request builders used to derive it
 * from definitions alone while the panel derived it from definitions AND stored
 * rows, so a name duplicated only in storage was read and then not counted as
 * read -- the panel checked something it never promised to check.
 */
function nativeDuplicateNameSet(definitions, storedMetadataRows) {
  const definitionCounts = new Map();
  const storedCounts = new Map();
  const bump = (counts, name) => {
    if (!name) return;
    counts.set(name, (counts.get(name) || 0) + 1);
  };
  (definitions || []).forEach((definition) => bump(definitionCounts, definition && definition.name));
  (storedMetadataRows || []).forEach((row) => bump(storedCounts, row && row.name));
  const duplicates = new Set();
  definitionCounts.forEach((count, name) => { if (count > 1) duplicates.add(name); });
  storedCounts.forEach((count, name) => { if (count > 1) duplicates.add(name); });
  return duplicates;
}

/*
 * Was a live read actually requested for this definition? The request builders
 * and the panel's accounting must answer this identically, because the panel
 * describes what the read did: a row it never asked for may not be given a
 * reason that describes the form's state.
 */
function nativeLiveReadRequested(definition, policy, duplicateName) {
  const def = definition || {};
  return Boolean(
    def.name &&
    (policy || {}).disposition !== "secret" &&
    !duplicateName &&
    (!def.isMrvs || def.liveReadAllowed === true) &&
    !NATIVE_PROTOTYPE_COLLISION_NAMES.has(def.name)
  );
}

function workspaceLiveReadRequested(definition, policy, duplicateName) {
  // A secret twin needs no separate test: it is only ever a duplicate name,
  // and a duplicate name is refused here on its own.
  return Boolean(!duplicateName && workspaceLiveReadAllowed(definition, policy));
}

/*
 * Why a Workspace multi-row row was listed rather than compared. Each branch
 * names a different fact, because they are different facts: a surface that
 * never reads sets, a set whose columns the classic safety rule already
 * refused, a set whose columns were never enumerated, and a set holding a
 * column type whose in-container rendering this surface has not verified. The
 * one thing none of them may say is that no live value was available — the
 * form was never asked, so that would be a claim about the form.
 */
function nativeMrvsNotReadReason(definition, policy, options) {
  const def = definition || {};
  const rule = policy || {};
  const opts = options || {};
  // In the order the request builders reject, so the reason names the first
  // thing that actually stopped the read.
  if (opts.duplicateName) {
    return "The variable name is shared by another row on this record, so no" +
      " live rows were read: the form would resolve the name to whichever of" +
      " them it chooses.";
  }
  if (!def.name) {
    return "The set has no readable name, so no live rows were read.";
  }
  if (NATIVE_PROTOTYPE_COLLISION_NAMES.has(def.name)) {
    return "The variable name collides with the form API prototype, so no live" +
      " rows were read.";
  }
  if (opts.workspaceMode && (!rule.validator || !rule.columnTypes)) {
    return "Multi-row variable sets are listed but not compared on this" +
      " Workspace surface, so no live rows were read.";
  }
  if (def.liveReadAllowed !== true) {
    return def.liveReadBlockedReason ||
      "Live multi-row rows were not read because the set's columns could not" +
      " all be verified as safe and comparable.";
  }
  if (opts.workspaceMode) {
    if (!Array.isArray(def.mrvsColumnTypes) || !def.mrvsColumnTypes.length) {
      return "The set's column definitions were not read, so no live rows were" +
        " read.";
    }
    const unproven = [];
    def.mrvsColumnTypes.forEach((column) => {
      if (!column || rule.columnTypes.has(column.type)) return;
      const label = String(column.label || column.type || "").trim() || "unknown";
      if (unproven.indexOf(label) < 0) unproven.push(label);
    });
    if (unproven.length) {
      return "No live rows were read: this Workspace surface has not verified" +
        " how " + unproven.sort().join(", ") + " is represented inside a" +
        " multi-row set.";
    }
  }
  // Deliberately not a statement about the form: every branch above is a
  // reason the form was never asked, and so is anything that reaches here.
  return "No live rows were read for this set.";
}

function normalizedNativeSet(value) {
  return new Set(
    String(value == null ? "" : value)
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean)
  );
}

function normalizedNativeBoolean(value) {
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return "true";
  if (normalized === "false" || normalized === "0" || normalized === "no") return "false";
  // Empty is deliberately not false: stored empty versus a live false/default
  // is an observed difference, not membership in the same boolean bucket.
  return null;
}

function nativeValuesEqual(storedValue, liveValue, comparisonMode) {
  if (comparisonMode === "boolean") {
    const storedBoolean = normalizedNativeBoolean(storedValue);
    const liveBoolean = normalizedNativeBoolean(liveValue);
    if (storedBoolean !== null && liveBoolean !== null) {
      return storedBoolean === liveBoolean;
    }
  }
  if (comparisonMode === "date" || comparisonMode === "datetime") {
    // Both sides share one fixed format by the time they reach here: the
    // stored value natively for a Date and after the zone conversion for a
    // Date/Time, the live value after the page-side normalisation.
    return String(storedValue == null ? "" : storedValue).trim() ===
      String(liveValue == null ? "" : liveValue).trim();
  }
  if (comparisonMode !== "set") {
    return String(storedValue == null ? "" : storedValue) ===
      String(liveValue == null ? "" : liveValue);
  }
  const stored = normalizedNativeSet(storedValue);
  const live = normalizedNativeSet(liveValue);
  if (stored.size !== live.size) return false;
  for (const token of stored) {
    if (!live.has(token)) return false;
  }
  return true;
}

// Render a UTC instant as a wall clock in one IANA zone. Intl resolves the
// offset for that exact instant, so DST needs no rule table.
function nativeZoneWallClock(epochMs, timeZone) {
  if (!timeZone || !Number.isFinite(epochMs)) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(epochMs));
    const part = (type) => {
      const found = parts.find((entry) => entry.type === type);
      return found ? found.value : "";
    };
    // Some engines render midnight as hour 24 under hour12: false.
    const hour = part("hour") === "24" ? "00" : part("hour");
    const rendered = part("year") + "-" + part("month") + "-" + part("day") +
      " " + hour + ":" + part("minute") + ":" + part("second");
    return NATIVE_INTERNAL_DATE_TIME_PATTERN.test(rendered) ? rendered : "";
  } catch (e) {
    return "";
  }
}

function nativeInternalDateTimeToEpoch(value) {
  const match = NATIVE_INTERNAL_DATE_TIME_PATTERN.exec(
    String(value == null ? "" : value).trim()
  );
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(epoch);
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second
  ) ? epoch : NaN;
}

// A Date/Time variable stores UTC and renders in the signed-in user's timezone,
// so the stored side is converted to that user's wall clock before it is
// compared. Anything unresolvable returns "" and the row is left uncompared
// rather than compared across zones.
function nativeStoredDateTimeInZone(storedValue, timeZone) {
  return nativeZoneWallClock(nativeInternalDateTimeToEpoch(storedValue), timeZone);
}

function nativeRecordIdentityMatches(initialIdentity, finalIdentity) {
  return Boolean(
    initialIdentity &&
    finalIdentity &&
    /^[a-z][a-z0-9_]*$/.test(initialIdentity.table) &&
    finalIdentity.table === initialIdentity.table &&
    isSysId(initialIdentity.sysId) &&
    finalIdentity.sysId === initialIdentity.sysId
  );
}

const VARIABLE_DEFINITION_FIELDS = [
  "sys_id",
  "name",
  "question_text",
  "type",
  "order",
  "variable_set",
  "reference",
  "lookup_table",
  "list_table",
  "default_value",
].join(",");

// Resolve each variable set's display name, internal (g_form) name, and whether
// it is a multi-row variable set. Best-effort: names are cosmetic and MRVS
// consolidation degrades gracefully to per-column rows if this fails.
async function fetchVariableSetMeta(setIds) {
  const meta = new Map();
  if (!setIds.length) return meta;
  try {
    const rows = await snGetMany(
      "item_option_new_set",
      "sys_idIN" + setIds.join(","),
      "sys_id,name,internal_name,title,type",
      setIds.length,
      { displayAll: true, excludeRefLinks: true }
    );
    rows.forEach((row) => {
      const id = snFieldValue(row, "sys_id");
      if (!isSysId(id)) return;
      const internalName = snFieldValue(row, "internal_name");
      const title =
        snFieldDisplay(row, "title") || internalName || snFieldDisplay(row, "name") || "";
      meta.set(id, {
        id,
        internalName,
        name: snFieldValue(row, "name"),
        title,
        isMrvs: isMultiRowSetType(snFieldValue(row, "type"), snFieldDisplay(row, "type")),
      });
    });
  } catch (e) {
    /* Set metadata is best-effort; membership still resolves without it. */
  }
  return meta;
}

async function fetchCatalogItemVariableDefinitions(catalogItemSysId) {
  const definitions = new Map();

  const addRows = (rows, meta, skipMrvsChildren) => {
    rows.forEach((row) => {
      const name = snFieldValue(row, "name").trim();
      if (!name || definitions.has(name)) return;
      const variableSet = snFieldValue(row, "variable_set");
      const setInfo = meta && meta.get(variableSet);
      // MRVS columns are surfaced as a single consolidated parent row instead.
      if (skipMrvsChildren && setInfo && setInfo.isMrvs) return;
      const type = snFieldValue(row, "type");
      const typeDisplay = snFieldDisplay(row, "type") || type;
      if (
        isUnsupportedVariableType(type) &&
        !isSecretVariableType(type) &&
        !isSecretVariableType(typeDisplay)
      ) return;

      const label = snFieldDisplay(row, "question_text") || name;
      const secret =
        isSecretVariableType(type) ||
        isSecretVariableType(typeDisplay) ||
        isSensitiveVariableName(name, label);
      definitions.set(name, {
        name,
        label,
        type,
        typeDisplay,
        variableSet,
        setName: (setInfo && setInfo.title) || "",
        referenceTable:
          snFieldValue(row, "reference") ||
          snFieldValue(row, "lookup_table") ||
          snFieldValue(row, "list_table"),
        secret,
        defaultValue: secret ? "" : snFieldValue(row, "default_value"),
        hiddenType: isHiddenVariableType(type, typeDisplay),
        questionId: snFieldValue(row, "sys_id"),
        isMrvs: false,
      });
    });
  };

  const directRows = await snGetMany(
    "item_option_new",
    "cat_item=" + catalogItemSysId,
    VARIABLE_DEFINITION_FIELDS,
    300,
    { displayAll: true, excludeRefLinks: true }
  );
  addRows(directRows, null, false);

  const setRows = await snGetMany(
    "io_set_item",
    "sc_cat_item=" + catalogItemSysId,
    "variable_set,order",
    100,
    { displayAll: true, excludeRefLinks: true }
  );
  const setIds = Array.from(
    new Set(setRows.map((row) => snFieldValue(row, "variable_set")).filter(isSysId))
  );

  if (setIds.length) {
    const meta = await fetchVariableSetMeta(setIds);
    const setVariableRows = await snGetMany(
      "item_option_new",
      "variable_setIN" + setIds.join(","),
      VARIABLE_DEFINITION_FIELDS,
      500,
      { displayAll: true, excludeRefLinks: true }
    );
    addRows(setVariableRows, meta, true);

    // One consolidated row per multi-row variable set, keyed by its internal
    // name so g_form.getValue(<name>) yields the whole JSON-array value.
    meta.forEach((info) => {
      if (!info.isMrvs) return;
      const key = (info.internalName || info.name || "").trim();
      if (!key || definitions.has(key)) return;
      definitions.set(key, {
        name: key,
        label: info.title || key,
        type: "multi_row_variable_set",
        typeDisplay: "Multi-Row Variable Set",
        variableSet: info.id,
        setName: info.title || "",
        referenceTable: "",
        secret: false,
        defaultValue: "",
        hiddenType: false,
        questionId: info.id,
        isMrvs: true,
      });
    });
  }

  return { variables: Array.from(definitions.values()), setCount: setIds.length };
}

function nativeDefinitionFromRow(row, setInfo, sourceIndex) {
  const type = snFieldValue(row, "type");
  const typeDisplay = snFieldDisplay(row, "type") || type;
  const name = snFieldValue(row, "name").trim();
  const label = snFieldDisplay(row, "question_text") || name || "Unnamed variable";
  const variableSet = snFieldValue(row, "variable_set");
  const policy = nativeTypePolicy(type, typeDisplay);
  return {
    name,
    label,
    type,
    typeDisplay,
    variableSet,
    setName: (setInfo && setInfo.title) || "",
    questionId: snFieldValue(row, "sys_id"),
    hiddenType: isHiddenVariableType(type, typeDisplay),
    isMrvs: policy.disposition === "mrvs",
    inactive: snFieldValue(row, "active") === "false",
    sourceIndex,
  };
}

/* Reading a live MRVS returns the whole JSON object, not one requested column.
 * It is therefore safe only when the complete column definition set is known
 * and every column is positively comparable. Otherwise a masked or sensitive
 * child could cross the MAIN-world boundary inside an apparently ordinary set. */
function nativeMrvsColumnsSafe(rows, complete) {
  if (!complete || !Array.isArray(rows) || !rows.length) return false;
  const definitions = rows.map((row, index) => nativeDefinitionFromRow(row, null, index));
  const nameCounts = new Map();
  definitions.forEach((definition) => {
    if (!definition.name) return;
    nameCounts.set(definition.name, (nameCounts.get(definition.name) || 0) + 1);
  });
  return definitions.every((definition) => {
    const policy = classifyNativeVariable(definition);
    return Boolean(
      definition.name &&
      isSysId(definition.questionId) &&
      (nameCounts.get(definition.name) || 0) === 1 &&
      !NATIVE_PROTOTYPE_COLLISION_NAMES.has(definition.name) &&
      policy.disposition === "comparable"
    );
  });
}

/* The column types a multi-row set is built from, in definition order and with
 * their display labels, so a caller can decide whether every column's
 * representation is one it has actually verified. Distinct from
 * nativeMrvsColumnsSafe, which asks whether the columns are safe to read at
 * all; this asks what is in there. */
function nativeMrvsColumnTypes(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    name: snFieldValue(row, "name").trim(),
    type: normalizeVariableType(snFieldValue(row, "type")),
    label: snFieldDisplay(row, "type") || snFieldValue(row, "type"),
  }));
}

/*
 * Date and Date/Time columns inside a multi-row set, which no reader can
 * compare.
 *
 * A standalone Date/Time variable reads back as raw canonical UTC and the
 * comparison converts the stored value into the form's timezone to match it.
 * The same type INSIDE a set does not: the whole set arrives as one value and
 * the date cell inside it is already formatted to the user's date format and
 * shifted into the session timezone. Measured on one record, the set held
 * "21-04-2026 07:13:37" where storage held "2026-04-21 14:13:37" — a real
 * record reported as differing when nothing about it had changed.
 *
 * Converting the cell back was rejected, though not because it cannot be done:
 * the standalone path already parses a displayed date with the page's own
 * parser and fails closed when it cannot. The reason is that a set is compared
 * as a whole. Every cell would have to normalise, the cell's type is known only
 * from the set's column definitions, and any cell that failed would have to
 * refuse the entire set — so the honest outcome for a set holding one is the
 * refusal it already gets, reached with far less machinery. A set holding a
 * date column is therefore listed with its stored rows and never compared, on
 * every surface including the classic form.
 */
const NATIVE_MRVS_UNCOMPARABLE_COLUMN_TYPES = new Set(["9", "10"]);

function nativeMrvsDateColumnLabels(definition) {
  const columns = Array.isArray(definition && definition.mrvsColumnTypes)
    ? definition.mrvsColumnTypes
    : [];
  const labels = [];
  columns.forEach((column) => {
    if (!column || !NATIVE_MRVS_UNCOMPARABLE_COLUMN_TYPES.has(column.type)) return;
    const label = String(column.label || column.type || "").trim() || "a date column";
    if (labels.indexOf(label) < 0) labels.push(label);
  });
  return labels.sort();
}

function applyNativeMrvsLiveReadPolicy(definitions, mrvsResult) {
  const result = mrvsResult || {};
  const metadataComplete =
    result.mrvsReadStatus === "success" || result.mrvsReadStatus === "empty";
  (definitions || []).forEach((definition) => {
    if (!definition || !definition.isMrvs) return;
    const storedSet = result.mrvsValuesBySetId &&
      result.mrvsValuesBySetId.get(definition.variableSet);
    const storedMetadataSafe = Boolean(
      metadataComplete &&
      (!storedSet || (
        !(storedSet.withheldColumns || []).length &&
        !storedSet.indexIncomplete
      ))
    );
    const columnsSafe = definition.mrvsColumnsSafe === true && storedMetadataSafe;
    const dateColumns = nativeMrvsDateColumnLabels(definition);
    definition.liveReadAllowed = Boolean(columnsSafe && !dateColumns.length);
    if (definition.liveReadAllowed) {
      definition.liveReadBlockedReason = "";
    } else if (!columnsSafe) {
      // Safety first: a column that could not be verified may be a secret, and
      // that is a stronger reason to refuse than an uncomparable date.
      definition.liveReadBlockedReason =
        "Live multi-row value was not read because its columns could not all be verified as safe and comparable.";
    } else {
      definition.liveReadBlockedReason =
        "No live rows were read: the form renders " + dateColumns.join(", ") +
        " inside a set in the user's date format and timezone, which cannot be" +
        " compared with the stored value.";
    }
  });
}

const NATIVE_VARIABLE_DEFINITION_FIELDS = [
  "sys_id",
  "active",
  "name",
  "question_text",
  "type",
  "order",
  "variable_set",
  "reference",
  "lookup_table",
  "list_table",
].join(",");

async function fetchNativeVariableSetMeta(setIds) {
  const meta = new Map();
  if (!setIds.length) return meta;
  const rows = await snGetMany(
    "item_option_new_set",
    "sys_idIN" + setIds.join(","),
    "sys_id,name,internal_name,title,type",
    setIds.length,
    { displayAll: true, excludeRefLinks: true }
  );
  rows.forEach((row) => {
    const id = snFieldValue(row, "sys_id");
    if (!isSysId(id)) return;
    const internalName = snFieldValue(row, "internal_name");
    meta.set(id, {
      id,
      internalName,
      name: snFieldValue(row, "name"),
      title: snFieldDisplay(row, "title") || internalName || snFieldDisplay(row, "name"),
      isMrvs: isMultiRowSetType(snFieldValue(row, "type"), snFieldDisplay(row, "type")),
    });
  });
  if (setIds.some((id) => !meta.has(id))) {
    throw new Error("One or more variable-set definitions were inaccessible.");
  }
  return meta;
}

/*
 * Definition enumeration for native RITMs. Unlike the portal reader, this
 * keeps unsupported types, unnamed structural rows, and duplicate names. A
 * partial definition list is returned only with an explicit truncated status.
 */
async function fetchNativeCatalogItemVariableDefinitions(catalogItemSysId) {
  const directRows = await snGetMany(
    "item_option_new",
    "cat_item=" + catalogItemSysId,
    NATIVE_VARIABLE_DEFINITION_FIELDS,
    NATIVE_DEFINITION_LIMIT,
    { displayAll: true, excludeRefLinks: true }
  );
  const setRows = await snGetMany(
    "io_set_item",
    "sc_cat_item=" + catalogItemSysId,
    "variable_set,order",
    NATIVE_SET_LIMIT,
    { displayAll: true, excludeRefLinks: true }
  );
  const setIds = Array.from(
    new Set(setRows.map((row) => snFieldValue(row, "variable_set")).filter(isSysId))
  );
  const setMeta = await fetchNativeVariableSetMeta(setIds);
  const setVariableRows = setIds.length
    ? await snGetMany(
        "item_option_new",
        "variable_setIN" + setIds.join(","),
        NATIVE_VARIABLE_DEFINITION_FIELDS,
        NATIVE_SET_DEFINITION_LIMIT,
        { displayAll: true, excludeRefLinks: true }
      )
    : [];

  const definitions = [];
  const mrvsColumnRows = new Map();
  setVariableRows.forEach((row) => {
    const setId = snFieldValue(row, "variable_set");
    const info = setMeta.get(setId);
    if (!info || !info.isMrvs) return;
    if (!mrvsColumnRows.has(setId)) mrvsColumnRows.set(setId, []);
    mrvsColumnRows.get(setId).push(row);
  });
  const mrvsColumnReadComplete = setVariableRows.length < NATIVE_SET_DEFINITION_LIMIT;
  const isOmittedRow = (row) => isPanelOmittedVariableType(
    snFieldValue(row, "type"),
    snFieldDisplay(row, "type")
  );
  directRows.forEach((row) => {
    if (isOmittedRow(row)) return;
    definitions.push(nativeDefinitionFromRow(row, null, definitions.length));
  });
  setVariableRows.forEach((row) => {
    if (isOmittedRow(row)) return;
    const info = setMeta.get(snFieldValue(row, "variable_set"));
    if (info && info.isMrvs) return;
    definitions.push(nativeDefinitionFromRow(row, info, definitions.length));
  });
  setMeta.forEach((info) => {
    if (!info.isMrvs) return;
    const name = String(info.internalName || info.name || "").trim();
    definitions.push({
      name,
      label: info.title || name || "Multi-Row Variable Set",
      type: "34",
      typeDisplay: "Multi-Row Variable Set",
      variableSet: info.id,
      setName: info.title || "",
      questionId: info.id,
      hiddenType: false,
      isMrvs: true,
      mrvsColumnsSafe: nativeMrvsColumnsSafe(
        mrvsColumnRows.get(info.id) || [],
        mrvsColumnReadComplete
      ),
      mrvsColumnTypes: nativeMrvsColumnTypes(mrvsColumnRows.get(info.id) || []),
      sourceIndex: definitions.length,
    });
  });

  const truncated =
    directRows.length >= NATIVE_DEFINITION_LIMIT ||
    setRows.length >= NATIVE_SET_LIMIT ||
    setVariableRows.length >= NATIVE_SET_DEFINITION_LIMIT;
  return {
    definitions,
    setCount: setIds.length,
    mrvsSetIds: Array.from(setMeta.values())
      .filter((info) => info.isMrvs)
      .map((info) => info.id),
    definitionReadStatus: truncated ? "truncated" : "success",
  };
}

const NATIVE_STORED_METADATA_FIELDS = [
  "sc_item_option.sys_id",
  "sc_item_option.item_option_new",
  "sc_item_option.item_option_new.name",
  "sc_item_option.item_option_new.question_text",
  "sc_item_option.item_option_new.type",
  // The answer's own variable set, so a definition reconciled from this row
  // reports the set the record actually answered rather than the stale one.
  "sc_item_option.item_option_new.variable_set",
  // Metadata only, and the same flag the producer reader takes from
  // question.active, so a definition reconciled from this row carries the
  // retired state instead of silently reading as current.
  "sc_item_option.item_option_new.active",
].join(",");

function nativeStoredMetadataFromRow(row, definitionById) {
  const prefix = "sc_item_option.item_option_new";
  const questionId = snFieldValue(row, prefix);
  const type = snFieldValue(row, prefix + ".type");
  const typeDisplay = snFieldDisplay(row, prefix + ".type") || type;
  const name = snFieldValue(row, prefix + ".name").trim();
  const label = snFieldDisplay(row, prefix + ".question_text") || name;
  const definition = definitionById.get(questionId);
  const metadataPolicy = classifyNativeVariable({ name, label, type, typeDisplay });
  const definitionPolicy = definition ? classifyNativeVariable(definition) : { disposition: "denied" };
  const secret =
    metadataPolicy.disposition === "secret" ||
    definitionPolicy.disposition === "secret";
  const fetchAllowed = Boolean(
    definition &&
    !secret &&
    metadataPolicy.disposition === "comparable" &&
    definitionPolicy.disposition === "comparable" &&
    metadataPolicy.comparisonMode === definitionPolicy.comparisonMode
  );
  return {
    optionSysId: snFieldValue(row, "sc_item_option.sys_id"),
    questionId,
    name,
    label,
    type,
    typeDisplay,
    variableSet: snFieldValue(row, prefix + ".variable_set"),
    hiddenType: isHiddenVariableType(type, typeDisplay),
    inactive: snFieldValue(row, prefix + ".active") === "false",
    secret,
    policy: metadataPolicy,
    fetchAllowed,
    valueAvailable: false,
    storedValue: null,
  };
}

/*
 * Two-phase stored read. Phase one intentionally omits every value column;
 * phase two asks sc_item_option for values only for rows positively classified
 * as comparable by both the definition read and the metadata read.
 */
async function readNativeRitmMetadataRows(requestItemSysId) {
  try {
    return {
      rows: await snGetMany(
        "sc_item_option_mtom",
        "request_item=" + requestItemSysId,
        NATIVE_STORED_METADATA_FIELDS,
        NATIVE_STORED_METADATA_LIMIT,
        { displayAll: true, excludeRefLinks: true }
      ),
      failed: false,
    };
  } catch (error) {
    return { rows: [], failed: true };
  }
}

async function fetchNativeRitmStoredValues(
  requestItemSysId,
  definitions,
  definitionReadStatus,
  preloadedRows
) {
  // The reader has already read these to reconcile the definitions against the
  // record's own answers, and reading them twice would ask the same question of
  // the instance for no gain.
  //
  // A FAILED preload is final rather than retried. The caller reconciles against
  // whatever that read returned, so a failure there means the definitions were
  // reconciled against zero answers; retrying here and succeeding would show
  // stored values against definitions the swap was never repaired on -- the
  // pre-reconciliation behaviour returning silently on a transient failure, and
  // the two reads disagreeing is the exact thing the shared read prevents.
  if (preloadedRows && preloadedRows.failed) {
    return {
      storedReadStatus: "failed",
      storedReadError: "Stored variable rows could not be read.",
      metadataRows: [],
    };
  }
  const read = preloadedRows || (await readNativeRitmMetadataRows(requestItemSysId));
  const metadataRows = read.rows;
  if (read.failed) {
    return {
      storedReadStatus: "failed",
      storedReadError: "Stored variable rows could not be read.",
      metadataRows: [],
    };
  }

  const definitionById = new Map();
  definitions.forEach((definition) => {
    if (isSysId(definition.questionId) && !definitionById.has(definition.questionId)) {
      definitionById.set(definition.questionId, definition);
    }
  });
  const metadata = metadataRows.map((row) => nativeStoredMetadataFromRow(row, definitionById));
  const truncated =
    definitionReadStatus === "truncated" ||
    metadataRows.length >= NATIVE_STORED_METADATA_LIMIT;
  if (!metadataRows.length) {
    return {
      storedReadStatus: truncated ? "truncated" : "empty",
      storedReadError: truncated ? "The variable list reached its read limit." : "",
      metadataRows: metadata,
    };
  }
  if (truncated) {
    return {
      storedReadStatus: "truncated",
      storedReadError: "The variable list reached its read limit.",
      metadataRows: metadata,
    };
  }

  const allowedIds = Array.from(
    new Set(
      metadata
        .filter((row) => row.fetchAllowed && isSysId(row.optionSysId))
        .map((row) => row.optionSysId)
    )
  );
  const valuesById = new Map();
  try {
    for (let index = 0; index < allowedIds.length; index += NATIVE_VALUE_BATCH_SIZE) {
      const batch = allowedIds.slice(index, index + NATIVE_VALUE_BATCH_SIZE);
      const valueRows = await snGetMany(
        "sc_item_option",
        "sys_idIN" + batch.join(","),
        "sys_id,value",
        batch.length,
        { excludeRefLinks: true }
      );
      valueRows.forEach((row) => {
        const id = snFieldValue(row, "sys_id");
        if (batch.indexOf(id) >= 0) valuesById.set(id, snFieldValue(row, "value"));
      });
      if (batch.some((id) => !valuesById.has(id))) {
        throw new Error("A requested stored value was inaccessible.");
      }
    }
  } catch (error) {
    return {
      storedReadStatus: "failed",
      storedReadError: "Stored values could not be read.",
      metadataRows: metadata,
    };
  }

  metadata.forEach((row) => {
    if (!row.fetchAllowed || !valuesById.has(row.optionSysId)) return;
    row.storedValue = valuesById.get(row.optionSysId);
    row.valueAvailable = true;
  });
  return { storedReadStatus: "success", storedReadError: "", metadataRows: metadata };
}

/*
 * Multi-row variable sets do not store a value on the question row, so no
 * sc_item_option / question_answer read can ever produce one. Their cells live
 * in sc_multi_row_question_answer, keyed by the owning record (parent_id) and
 * the variable set. Reading them is what turns an MRVS row from "we never
 * looked" into a real stored side.
 */
const NATIVE_MRVS_ANSWER_LIMIT = 1000;

const NATIVE_MRVS_METADATA_FIELDS = [
  "sys_id",
  "parent_id",
  "row_index",
  "variable_set",
  "item_option_new",
  "item_option_new.name",
  "item_option_new.question_text",
  "item_option_new.type",
].join(",");

// Screen one MRVS cell by its own column type. A masked column inside a set is
// still a secret, so the same default-deny rule that guards ordinary variables
// decides whether this cell's id may enter the value request.
function nativeMrvsCellFromRow(row, sourceIndex) {
  const columnName = snFieldValue(row, "item_option_new.name").trim();
  const type = snFieldValue(row, "item_option_new.type");
  const typeDisplay = snFieldDisplay(row, "item_option_new.type") || type;
  const label = snFieldDisplay(row, "item_option_new.question_text") || columnName;
  const policy = classifyNativeVariable({ name: columnName, label, type, typeDisplay });
  const rowIndexText = snFieldValue(row, "row_index").trim();
  const rowIndex = Number(rowIndexText);
  return {
    answerId: snFieldValue(row, "sys_id"),
    setId: snFieldValue(row, "variable_set"),
    columnName,
    label,
    type,
    typeDisplay,
    policy,
    secret: policy.disposition === "secret",
    // row_index is authoritative when present; read order is the only ordering
    // left when it is not, and is kept separately so it cannot masquerade as a
    // real index.
    rowIndex: rowIndexText && Number.isFinite(rowIndex) ? rowIndex : null,
    sourceIndex,
    fetchAllowed: Boolean(
      columnName &&
      isSysId(snFieldValue(row, "sys_id")) &&
      policy.disposition === "comparable" &&
      !NATIVE_PROTOTYPE_COLLISION_NAMES.has(columnName)
    ),
    valueAvailable: false,
    storedValue: null,
  };
}

// Group screened cells into one ordered array of row objects per set, matching
// the shape g_form.getValue() returns for a multi-row variable set. A column
// whose value was withheld is recorded by name rather than silently omitted,
// so the caller can refuse to compare instead of reporting a false difference.
function assembleNativeMrvsSets(cells) {
  const bySet = new Map();
  cells.forEach((cell) => {
    // A cell with no readable set id cannot be attributed to anything, so it
    // is the one case with nowhere to record it.
    if (!isSysId(cell.setId)) return;
    if (!bySet.has(cell.setId)) {
      bySet.set(cell.setId, {
        rows: new Map(),
        withheld: new Set(),
        modes: {},
        indexIncomplete: false,
      });
    }
    const set = bySet.get(cell.setId);
    // A column whose name could not be read is withheld rather than dropped.
    // Dropping it leaves the row short of a key, and the comparison would then
    // treat the missing cell as empty and report a difference — or worse, agree
    // with a live side that is also missing it.
    if (!cell.columnName) {
      set.withheld.add("(unnamed column)");
      return;
    }
    if (!cell.fetchAllowed || !cell.valueAvailable) {
      set.withheld.add(cell.columnName);
      return;
    }
    set.modes[cell.columnName] = cell.policy.comparisonMode || "scalar";
    // row_index is what groups cells into rows. Without it each cell keys on
    // its own source index, which turns one real row of N columns into N
    // single-column rows -- and the comparison would then report those
    // fabricated rows as confident differences against the live set. Read
    // order is not a substitute, so the set is withheld instead.
    if (cell.rowIndex == null) set.indexIncomplete = true;
    const key = cell.rowIndex == null ? "s:" + cell.sourceIndex : "i:" + cell.rowIndex;
    if (!set.rows.has(key)) {
      set.rows.set(key, { rowIndex: cell.rowIndex, sourceIndex: cell.sourceIndex, values: {} });
    }
    const target = set.rows.get(key);
    if (cell.sourceIndex < target.sourceIndex) target.sourceIndex = cell.sourceIndex;
    target.values[cell.columnName] = String(cell.storedValue == null ? "" : cell.storedValue);
  });

  const assembled = new Map();
  bySet.forEach((set, setId) => {
    const ordered = Array.from(set.rows.values()).sort((a, b) => {
      if (a.rowIndex != null && b.rowIndex != null && a.rowIndex !== b.rowIndex) {
        return a.rowIndex - b.rowIndex;
      }
      if (a.rowIndex != null && b.rowIndex == null) return -1;
      if (a.rowIndex == null && b.rowIndex != null) return 1;
      return a.sourceIndex - b.sourceIndex;
    });
    assembled.set(setId, {
      rows: ordered.map((entry) => entry.values),
      withheldColumns: Array.from(set.withheld).sort(),
      indexIncomplete: Boolean(set.indexIncomplete),
      comparisonModes: set.modes,
    });
  });
  return assembled;
}

/*
 * Two-phase MRVS read, matching the ordinary stored read: phase one asks for
 * cell and column identity with no value column, phase two asks the same table
 * for values only for cells whose column type was positively allowlisted.
 */
async function fetchNativeMrvsStoredValues(parentSysId, mrvsSetIds) {
  const setIds = Array.from(new Set((mrvsSetIds || []).filter(isSysId)));
  // Tri-state, not a boolean: "present", "absent" or "unknown". A probe that
  // could not be answered still refuses, but it may not be reported as having
  // found rows -- that would assert something about this record's storage that
  // no read established. The name carries no "present" so a caller cannot treat
  // it as a boolean by accident and silently turn "unknown" into "yes".
  let detachedMrvsRows = "absent";
  const withoutValues = (status, error) => ({
    mrvsReadStatus: status,
    mrvsReadError: error || "",
    mrvsValuesBySetId: new Map(),
    detachedMrvsRows,
  });
  if (!isSysId(parentSysId) || !setIds.length) return withoutValues("skipped", "");

  // Does this record hold rows under a set the catalog item no longer attaches?
  // An item's attached sets change, and a record answered before such a change
  // stores its rows under the old set; without knowing that, a set with no rows
  // is indistinguishable from a record with none, and the panel compares zero
  // stored rows against a populated form -- a difference manufactured by the
  // query.
  //
  // Only the yes/no matters, never which sets or how many, so this is a bounded
  // existence probe. It used to be a widened `parent_id=X` metadata read whose
  // rows were filtered afterwards, which let detached cells consume the row cap:
  // one record with enough of them truncated the read and refused EVERY set on
  // the record over rows that were never going to be read.
  //
  // `NOT IN` verified live: on a record holding 44 rows across two sets, IN the
  // first returned 26, NOT IN the first returned 18, NOT IN both returned 0, and
  // NOT IN an unrelated id returned all 44 -- so the condition is applied rather
  // than silently ignored.
  try {
    const detachedProbe = await snGetMany(
      "sc_multi_row_question_answer",
      "parent_id=" + parentSysId + "^variable_setNOT IN" + setIds.join(","),
      "sys_id",
      1,
      { excludeRefLinks: true }
    );
    detachedMrvsRows = detachedProbe.length > 0 ? "present" : "absent";
  } catch (error) {
    // Unknown refuses exactly as "present" does -- a set with no stored rows
    // declines to compare rather than reporting a difference it cannot rule out
    // having invented -- but it says so in its own words, because no read
    // established that this record holds detached rows.
    detachedMrvsRows = "unknown";
  }

  let metadataRows;
  try {
    metadataRows = await snGetMany(
      "sc_multi_row_question_answer",
      "parent_id=" + parentSysId + "^variable_setIN" + setIds.join(","),
      NATIVE_MRVS_METADATA_FIELDS,
      NATIVE_MRVS_ANSWER_LIMIT,
      { displayAll: true, excludeRefLinks: true }
    );
  } catch (error) {
    return withoutValues("failed", "Multi-row variable set rows could not be read.");
  }
  if (!metadataRows.length) return withoutValues("empty", "");
  if (metadataRows.length >= NATIVE_MRVS_ANSWER_LIMIT) {
    return withoutValues("truncated", "The multi-row answer list reached its read limit.");
  }

  const enumerated = new Set(setIds);
  // The query already restricts this, but an ignored server condition returns
  // unrelated rows rather than an error, so the set is re-checked here too.
  const cells = metadataRows
    .map((row, index) => nativeMrvsCellFromRow(row, index))
    .filter((cell) => enumerated.has(cell.setId));
  const allowedIds = Array.from(
    new Set(cells.filter((cell) => cell.fetchAllowed).map((cell) => cell.answerId))
  );
  const valuesById = new Map();
  try {
    for (let index = 0; index < allowedIds.length; index += NATIVE_VALUE_BATCH_SIZE) {
      const batch = allowedIds.slice(index, index + NATIVE_VALUE_BATCH_SIZE);
      const valueRows = await snGetMany(
        "sc_multi_row_question_answer",
        "sys_idIN" + batch.join(","),
        "sys_id,value",
        batch.length,
        { excludeRefLinks: true }
      );
      valueRows.forEach((row) => {
        const answerId = snFieldValue(row, "sys_id");
        if (batch.indexOf(answerId) >= 0) valuesById.set(answerId, snFieldValue(row, "value"));
      });
      if (batch.some((answerId) => !valuesById.has(answerId))) {
        throw new Error("A requested multi-row value was inaccessible.");
      }
    }
  } catch (error) {
    return withoutValues("failed", "Multi-row variable set values could not be read.");
  }

  cells.forEach((cell) => {
    if (!cell.fetchAllowed || !valuesById.has(cell.answerId)) return;
    cell.storedValue = valuesById.get(cell.answerId);
    cell.valueAvailable = true;
  });
  return {
    mrvsReadStatus: "success",
    mrvsReadError: "",
    mrvsValuesBySetId: assembleNativeMrvsSets(cells),
    detachedMrvsRows,
  };
}

/*
 * The column names this variable set actually defines. Binding a row's keys to
 * them is what ties an array of objects to THIS set rather than to any array of
 * objects a form might hand back.
 */
function nativeMrvsColumnNameSet(definition) {
  return new Set(
    (Array.isArray(definition && definition.mrvsColumnTypes)
      ? definition.mrvsColumnTypes
      : []
    ).map((column) => column && column.name).filter(Boolean)
  );
}

/*
 * Is this parsed value a comparable multi-row shape: an array of plain objects
 * whose every cell is a string and whose every key is one of the set's own
 * columns?
 *
 * Representation-agnostic on purpose, so it applies on every surface without
 * transferring any surface's per-type evidence. It is a precondition for the
 * comparison itself being meaningful rather than a claim about a component: a
 * number, a null or a nested object reaching the comparison stringifies to
 * something like "[object Object]" and reports a difference that says nothing.
 * An unknown key means the form and the enumerated definition disagree, which
 * is a real inconsistency and refused rather than compared.
 *
 * An empty column set refuses everything. It used to pass the key check, which
 * was an allow-by-default clause inside a deny-by-default validator; nothing
 * reaches it today because a live read is only requested for a set whose named
 * columns were all resolved, and it should stay unreachable rather than become
 * the one hole in the rule.
 */
function nativeMrvsRowsWellFormed(rows, columnNames) {
  const columns = columnNames || new Set();
  return (
    Array.isArray(rows) &&
    rows.every((entry) => (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.keys(entry).every((key) => (
        typeof entry[key] === "string" && columns.has(key)
      ))
    ))
  );
}

function parseNativeMrvsRows(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

/*
 * Compare two multi-row values structurally. g_form emits object keys in form
 * order and the reassembled stored side emits them in read order, so a raw
 * string compare reports a difference between identical data. Row order is
 * meaningful and is kept; key order is not and is ignored. A key present on one
 * side only is compared as an empty string, since an absent cell and an empty
 * cell mean the same thing in a multi-row set.
 */
function nativeMrvsValuesEqual(storedRows, liveRows, comparisonModes) {
  if (!Array.isArray(storedRows) || !Array.isArray(liveRows)) return false;
  if (storedRows.length !== liveRows.length) return false;
  const modes = comparisonModes || {};
  for (let index = 0; index < storedRows.length; index += 1) {
    const stored = storedRows[index] || {};
    const live = liveRows[index] || {};
    if (!stored || typeof stored !== "object" || !live || typeof live !== "object") return false;
    const keys = new Set([...Object.keys(stored), ...Object.keys(live)]);
    for (const key of keys) {
      if (!nativeValuesEqual(stored[key], live[key], modes[key] || "scalar")) return false;
    }
  }
  return true;
}

const NATIVE_PRODUCER_METADATA_FIELDS = [
  "sys_id",
  "table_name",
  "table_sys_id",
  "document",
  "question",
  "question.active",
  "question.name",
  "question.question_text",
  "question.type",
  "question.order",
  "question.variable_set",
  "question.reference",
  "question.lookup_table",
  "question.list_table",
  "question.cat_item",
].join(",");

function nativeProducerDefinitionFromRow(row, sourceIndex) {
  const type = snFieldValue(row, "question.type");
  const typeDisplay = snFieldDisplay(row, "question.type") || type;
  const name = snFieldValue(row, "question.name").trim();
  const label = snFieldDisplay(row, "question.question_text") || name || "Unnamed variable";
  const policy = nativeTypePolicy(type, typeDisplay);
  return {
    name,
    label,
    type,
    typeDisplay,
    variableSet: snFieldValue(row, "question.variable_set"),
    setName: "",
    questionId: snFieldValue(row, "question"),
    hiddenType: isHiddenVariableType(type, typeDisplay),
    isMrvs: policy.disposition === "mrvs",
    inactive: snFieldValue(row, "question.active") === "false",
    sourceIndex,
  };
}

function nativeProducerMetadataFromRow(row, definition, options) {
  const opts = options || {};
  const rowDefinition = nativeProducerDefinitionFromRow(row, -1);
  const metadataPolicy = classifyNativeVariable(rowDefinition);
  const definitionPolicy = definition
    ? classifyNativeVariable(definition)
    : opts.requireDefinition
      ? { disposition: "denied" }
      : metadataPolicy;
  const isMrvsChild = Boolean(
    rowDefinition.variableSet &&
    opts.mrvsSetIds &&
    opts.mrvsSetIds.has(rowDefinition.variableSet)
  );
  const secret =
    metadataPolicy.disposition === "secret" ||
    definitionPolicy.disposition === "secret";
  return {
    optionSysId: snFieldValue(row, "sys_id"),
    questionId: rowDefinition.questionId,
    name: rowDefinition.name,
    type: rowDefinition.type,
    typeDisplay: rowDefinition.typeDisplay,
    secret,
    policy: isMrvsChild ? { disposition: "mrvs" } : metadataPolicy,
    fetchAllowed: Boolean(
      !secret &&
      !isMrvsChild &&
      isSysId(rowDefinition.questionId) &&
      metadataPolicy.disposition === "comparable" &&
      definitionPolicy.disposition === "comparable" &&
      metadataPolicy.comparisonMode === definitionPolicy.comparisonMode
    ),
    valueAvailable: false,
    storedValue: null,
  };
}

function consolidateProducerAnswerDefinitions(answerDefinitions, setMeta) {
  const definitions = [];
  answerDefinitions.forEach((definition) => {
    if (isPanelOmittedVariableType(definition.type, definition.typeDisplay)) return;
    const info = setMeta.get(definition.variableSet);
    if (info && info.isMrvs) return;
    definitions.push(Object.assign({}, definition, {
      setName: (info && info.title) || definition.setName || "",
      sourceIndex: definitions.length,
    }));
  });
  setMeta.forEach((info) => {
    if (!info.isMrvs) return;
    const name = String(info.internalName || info.name || "").trim();
    definitions.push({
      name,
      label: info.title || name || "Multi-Row Variable Set",
      type: "34",
      typeDisplay: "Multi-Row Variable Set",
      variableSet: info.id,
      setName: info.title || "",
      questionId: info.id,
      hiddenType: false,
      isMrvs: true,
      // Answers-only enumeration never reads the set's column definitions, so
      // neither the safety rule nor the column types can be established here.
      mrvsColumnsSafe: false,
      mrvsColumnTypes: null,
      sourceIndex: definitions.length,
    });
  });
  return definitions;
}

/*
 * Reconcile the catalog item's definition list with the record's own answers.
 *
 * The item is enumerated at all because it lists variables this record never
 * answered, which is worth showing. But an item's attached variable sets change
 * over time, and a record answered before such a change holds answers against
 * the OLD question rows while the item now defines new ones carrying the same
 * names. Observed live: an item attaching a 2024 commodities set, while a 2025
 * case answered — and the form still binds — a different set's questions of
 * exactly those names.
 *
 * The catalog-derived definition is then wrong about this record in the one way
 * that matters, its question id. Storage holds nothing under that id, so the
 * row reads "no stored row exists" for a variable the record plainly answered;
 * and the Workspace live read asks the form for an id the form does not have,
 * which refuses the entire snapshot and empties the panel.
 *
 * The record's own answer is the better authority: it is this record's data,
 * and it is the question the form is actually bound to. So where exactly one
 * unanswered catalog definition and exactly one answer share a name, the answer
 * wins, and the row says so.
 *
 * Deliberately narrow. A catalog definition whose own id IS answered is left
 * alone, so a genuine duplicate name still reaches the duplicate-name guard
 * instead of being silently resolved here. Multi-row parents are never
 * substituted: they are keyed by variable set, not by an answer row.
 */
/*
 * The request-item reader has no separate answer list: its definitions come
 * from the catalog item and its stored rows are matched to them by question id.
 * These are the same answers in definition shape, so the one reconciler serves
 * both readers -- the swap it repairs is a property of catalog items, not of
 * whichever table stores the values.
 */
function nativeAnswerDefinitionsFromStoredRows(metadataRows) {
  return (metadataRows || [])
    .filter((row) => row && row.name && isSysId(row.questionId))
    .map((row, index) => ({
      name: row.name,
      label: row.label || row.name,
      type: row.type,
      typeDisplay: row.typeDisplay,
      variableSet: row.variableSet || "",
      setName: "",
      questionId: row.questionId,
      // Both computed, never assumed. A substituted definition replaces the
      // catalog one wholesale, so hardcoding these put a Hidden variable in the
      // absent bucket and dropped a retired variable's inactive state -- both of
      // which the producer reader derives from the same two fields.
      hiddenType: isHiddenVariableType(row.type, row.typeDisplay),
      inactive: Boolean(row.inactive),
      isMrvs: false,
      sourceIndex: index,
    }));
}

function reconcileProducerDefinitionsWithAnswers(definitions, answerDefinitions, setMeta) {
  const list = Array.isArray(definitions) ? definitions : [];
  const answers = Array.isArray(answerDefinitions) ? answerDefinitions : [];
  const sets = setMeta || new Map();
  const answeredIds = new Set(
    answers.map((answer) => answer && answer.questionId).filter(isSysId)
  );
  const answersByName = new Map();
  answers.forEach((answer) => {
    if (!answer || !answer.name || !isSysId(answer.questionId)) return;
    // A named set the map cannot identify is refused rather than assumed
    // ordinary: the multi-row check below is what keeps a set's child answer
    // from substituting a plain variable, and it can only speak for sets it
    // knows. A blank variable set is a direct variable and needs no entry.
    if (isSysId(answer.variableSet) && !sets.has(answer.variableSet)) return;
    const info = sets.get(answer.variableSet);
    if (info && info.isMrvs) return;
    if (!answersByName.has(answer.name)) answersByName.set(answer.name, []);
    answersByName.get(answer.name).push(answer);
  });
  const nameCounts = new Map();
  list.forEach((definition) => {
    if (!definition || !definition.name) return;
    nameCounts.set(definition.name, (nameCounts.get(definition.name) || 0) + 1);
  });

  return list
    .map((definition) => {
      if (!definition || definition.isMrvs || !definition.name) return definition;
      if (answeredIds.has(definition.questionId)) return definition;
      if ((nameCounts.get(definition.name) || 0) !== 1) return definition;
      const candidates = answersByName.get(definition.name) || [];
      if (candidates.length !== 1) return definition;
      const answer = candidates[0];
      if (answer.questionId === definition.questionId) return definition;
      const info = sets.get(answer.variableSet);
      return Object.assign({}, answer, {
        // The answer's own set, never the stale one the catalog list named.
        setName: (info && info.title) || "",
        sourceIndex: definition.sourceIndex,
        definitionFromAnswer: true,
      });
    })
    .filter((definition) => !(
      definition &&
      definition.definitionFromAnswer &&
      isPanelOmittedVariableType(definition.type, definition.typeDisplay)
    ));
}

/* Record-producer targets store answers directly in question_answer. The first
 * read asks only for answer identity and question metadata. Values are fetched
 * in explicit batches from the same table only for positively allowlisted
 * rows, so masked, unknown, missing-definition, structural, and MRVS values
 * never cross the Table API message boundary. */
async function fetchNativeProducerRecordData(table, recordSysId) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(table || "")) || !isSysId(recordSysId)) {
    throw new Error("The classic record identity was not safe to query.");
  }

  const metadataRows = await snGetMany(
    "question_answer",
    "table_sys_id=" + recordSysId + "^table_name=" + table,
    NATIVE_PRODUCER_METADATA_FIELDS,
    NATIVE_STORED_METADATA_LIMIT,
    { displayAll: true, excludeRefLinks: true }
  );
  const answerDefinitions = metadataRows.map((row, index) =>
    nativeProducerDefinitionFromRow(row, index)
  );
  const answerSetIds = Array.from(new Set(
    answerDefinitions.map((definition) => definition.variableSet).filter(isSysId)
  ));

  if (!metadataRows.length) {
    return {
      recordProducerFound: false,
      definitions: [],
      setCount: 0,
      definitionEnumerationStatus: "unavailable",
      storedReadStatus: "empty",
      storedReadError: "",
      metadataRows: [],
    };
  }
  if (metadataRows.length >= NATIVE_STORED_METADATA_LIMIT) {
    const metadata = metadataRows.map((row, index) =>
      nativeProducerMetadataFromRow(row, answerDefinitions[index])
    );
    return {
      recordProducerFound: true,
      definitions: answerDefinitions,
      setCount: answerSetIds.length,
      definitionEnumerationStatus: "truncated",
      storedReadStatus: "truncated",
      storedReadError: "The record producer answer list reached its read limit.",
      metadataRows: metadata,
    };
  }

  let setMeta;
  try {
    setMeta = await fetchNativeVariableSetMeta(answerSetIds);
  } catch (error) {
    const metadata = metadataRows.map((row, index) =>
      nativeProducerMetadataFromRow(row, answerDefinitions[index], {
        requireDefinition: true,
        mrvsSetIds: new Set(answerSetIds),
      })
    );
    return {
      recordProducerFound: true,
      definitions: answerDefinitions,
      setCount: answerSetIds.length,
      definitionEnumerationStatus: "failed",
      storedReadStatus: "failed",
      storedReadError: "Variable-set definitions could not be read. No stored values were fetched.",
      metadataRows: metadata,
    };
  }

  const catalogItemCandidates = Array.from(new Set(
    metadataRows.map((row) => snFieldValue(row, "question.cat_item")).filter(isSysId)
  ));
  let definitions = consolidateProducerAnswerDefinitions(answerDefinitions, setMeta);
  let setCount = answerSetIds.length;
  let definitionEnumerationStatus = "answers-only";
  let definitionReadStatus = "success";
  let mrvsSetIds = new Set(
    Array.from(setMeta.values()).filter((info) => info.isMrvs).map((info) => info.id)
  );

  if (catalogItemCandidates.length === 1) {
    let definitionResult;
    try {
      definitionResult = await fetchNativeCatalogItemVariableDefinitions(catalogItemCandidates[0]);
    } catch (error) {
      const metadata = metadataRows.map((row) =>
        nativeProducerMetadataFromRow(row, null, {
          requireDefinition: true,
          mrvsSetIds,
        })
      );
      return {
        recordProducerFound: true,
        definitions,
        setCount,
        definitionEnumerationStatus: "failed",
        storedReadStatus: "failed",
        storedReadError: "Record producer definitions could not be read. No stored values were fetched.",
        metadataRows: metadata,
      };
    }
    definitions = definitionResult.definitions;
    setCount = definitionResult.setCount;
    definitionReadStatus = definitionResult.definitionReadStatus;
    mrvsSetIds = new Set(definitionResult.mrvsSetIds || []);
    definitionEnumerationStatus =
      definitionReadStatus === "truncated" ? "truncated" : "success";
    // The item's list is authoritative about which variables exist; this
    // record's answers are authoritative about which question each of its own
    // values belongs to.
    definitions = reconcileProducerDefinitionsWithAnswers(
      definitions,
      answerDefinitions,
      setMeta
    );
  }

  const definitionById = new Map();
  definitions.forEach((definition) => {
    if (isSysId(definition.questionId) && !definitionById.has(definition.questionId)) {
      definitionById.set(definition.questionId, definition);
    }
  });
  const requireDefinition = definitionEnumerationStatus === "success";
  const metadata = metadataRows.map((row) =>
    nativeProducerMetadataFromRow(row, definitionById.get(snFieldValue(row, "question")), {
      requireDefinition,
      mrvsSetIds,
    })
  );

  if (definitionReadStatus === "truncated") {
    return {
      recordProducerFound: true,
      definitions,
      setCount,
      definitionEnumerationStatus,
      storedReadStatus: "truncated",
      storedReadError: "The record producer definition list reached its read limit.",
      metadataRows: metadata,
    };
  }

  const allowedIds = Array.from(
    new Set(
      metadata
        .filter((row) => row.fetchAllowed && isSysId(row.optionSysId))
        .map((row) => row.optionSysId)
    )
  );
  const valuesById = new Map();
  try {
    for (let index = 0; index < allowedIds.length; index += NATIVE_VALUE_BATCH_SIZE) {
      const batch = allowedIds.slice(index, index + NATIVE_VALUE_BATCH_SIZE);
      const valueRows = await snGetMany(
        "question_answer",
        "sys_idIN" + batch.join(","),
        "sys_id,value",
        batch.length,
        { excludeRefLinks: true }
      );
      valueRows.forEach((row) => {
        const answerId = snFieldValue(row, "sys_id");
        if (batch.indexOf(answerId) >= 0) {
          valuesById.set(answerId, snFieldValue(row, "value"));
        }
      });
      if (batch.some((answerId) => !valuesById.has(answerId))) {
        throw new Error("A requested record producer value was inaccessible.");
      }
    }
  } catch (error) {
    return {
      recordProducerFound: true,
      definitions,
      setCount,
      definitionEnumerationStatus,
      storedReadStatus: "failed",
      storedReadError: "Stored record producer values could not be read.",
      metadataRows: metadata,
    };
  }

  metadata.forEach((row) => {
    if (!row.fetchAllowed || !valuesById.has(row.optionSysId)) return;
    row.storedValue = valuesById.get(row.optionSysId);
    row.valueAvailable = true;
  });
  // A producer-backed record owns its multi-row answers directly: parent_id is
  // the target record, not an intermediate request item.
  const mrvsResult = await fetchNativeMrvsStoredValues(
    recordSysId,
    Array.from(mrvsSetIds)
  );
  applyNativeMrvsLiveReadPolicy(definitions, mrvsResult);
  return Object.assign({
    recordProducerFound: true,
    definitions,
    setCount,
    definitionEnumerationStatus,
    storedReadStatus: "success",
    storedReadError: "",
    metadataRows: metadata,
  }, mrvsResult);
}

async function fetchNativeRitmRecordData(requestItemSysId) {
  const ritmRows = await snGetMany(
    "sc_req_item",
    "sys_id=" + requestItemSysId,
    "cat_item",
    2,
    { excludeRefLinks: true }
  );
  if (ritmRows.length !== 1) throw new Error("The current RITM could not be read.");
  const catalogItemSysId = snFieldValue(ritmRows[0], "cat_item");
  if (!isSysId(catalogItemSysId)) throw new Error("The current RITM has no readable catalog item.");

  const definitionResult = await fetchNativeCatalogItemVariableDefinitions(catalogItemSysId);

  // The item says which variables exist; this record's own answers say which
  // question each of its values belongs to. Where an item has swapped a
  // variable set since the record was created, those disagree, and without
  // this the row reports a variable the record plainly answered as unstored --
  // and the Workspace live read asks the form for an id it does not have,
  // which empties the panel.
  const metadataRead = await readNativeRitmMetadataRows(requestItemSysId);
  const answerDefinitions = nativeAnswerDefinitionsFromStoredRows(
    metadataRead.rows.map((row) => nativeStoredMetadataFromRow(row, new Map()))
  );
  const ritmSetMeta = new Map();
  (definitionResult.mrvsSetIds || []).forEach((setId) => {
    if (isSysId(setId)) ritmSetMeta.set(setId, { id: setId, isMrvs: true, title: "" });
  });
  definitionResult.definitions.forEach((definition) => {
    if (!definition || !isSysId(definition.variableSet)) return;
    if (ritmSetMeta.has(definition.variableSet)) return;
    ritmSetMeta.set(definition.variableSet, {
      id: definition.variableSet,
      isMrvs: false,
      title: definition.setName || "",
    });
  });
  // The map so far describes the sets the ITEM attaches, but the swap this
  // reconciler repairs is precisely a set the item no longer attaches -- so an
  // answer stored under one is a set the map has never heard of, and its
  // multi-row nature is unknowable from the item alone. The producer reader
  // does not have this gap because it reads metadata for every set its own
  // answers name; this closes it the same way. It also supplies the set title
  // that a substituted row would otherwise leave blank.
  //
  // An unresolved set stays absent from the map, and the reconciler refuses to
  // substitute from a set it cannot identify.
  const unknownAnswerSetIds = Array.from(new Set(
    answerDefinitions
      .map((answer) => answer.variableSet)
      .filter((setId) => isSysId(setId) && !ritmSetMeta.has(setId))
  ));
  if (unknownAnswerSetIds.length) {
    try {
      (await fetchNativeVariableSetMeta(unknownAnswerSetIds)).forEach((info, setId) => {
        ritmSetMeta.set(setId, info);
      });
    } catch (error) {
      /* Left absent on purpose: unidentifiable, therefore not substitutable. */
    }
  }
  // A truncated answer read cannot support reconciliation: the answer that
  // would resolve a name may be one of the rows past the cap, and "exactly one
  // answer shares this name" is then a statement about a partial list. The
  // producer reader returns before reconciling for the same reason.
  const answersTruncated =
    metadataRead.rows.length >= NATIVE_STORED_METADATA_LIMIT;
  if (!metadataRead.failed && !answersTruncated) {
    definitionResult.definitions = reconcileProducerDefinitionsWithAnswers(
      definitionResult.definitions,
      answerDefinitions,
      ritmSetMeta
    );
  }

  const storedResult = await fetchNativeRitmStoredValues(
    requestItemSysId,
    definitionResult.definitions,
    definitionResult.definitionReadStatus,
    metadataRead
  );
  const mrvsResult = await fetchNativeMrvsStoredValues(
    requestItemSysId,
    definitionResult.mrvsSetIds
  );
  applyNativeMrvsLiveReadPolicy(definitionResult.definitions, mrvsResult);
  return Object.assign({}, definitionResult, storedResult, mrvsResult);
}

function nativeVariableBucket(definition, liveResult) {
  const live = liveResult || {};
  if (definition.isMrvs) return { bucket: "mrvs", hidden: false };
  if (definition.hiddenType) return { bucket: "hidden-type", hidden: true };
  if (live.gFormReportedVisible === false) return { bucket: "invisible", hidden: true };
  if (live.gFormReportedVisible === true) return { bucket: "visible", hidden: false };
  if (live.foundEl && live.visible === false) return { bucket: "invisible", hidden: true };
  if (!live.foundEl) return { bucket: "absent", hidden: true };
  return { bucket: "visible", hidden: false };
}

function workspaceVariableBucket(definition, liveResult) {
  const live = liveResult || {};
  if (definition.isMrvs) {
    return { bucket: "mrvs", hidden: null, visibilityState: "unknown" };
  }
  if (definition.hiddenType) {
    return { bucket: "hidden-type", hidden: true, visibilityState: "hidden" };
  }
  if (live.visible === false) {
    return { bucket: "invisible", hidden: true, visibilityState: "hidden" };
  }
  if (live.visible === true) {
    return { bucket: "visible", hidden: false, visibilityState: "visible" };
  }
  return { bucket: "live-unavailable", hidden: null, visibilityState: "unknown" };
}

function nativeUnresolvedZoneReason(zoneSource) {
  if (zoneSource === "no-page-zone") {
    return "The form did not expose its active timezone, so no comparison was run.";
  }
  return "The form timezone could not be resolved, so no comparison was run.";
}

function nativeDateComparisonNote(comparisonMode, storedValue, comparedValue, timeZone, zoneSource) {
  if (comparisonMode === "datetime") {
    return " Stored " + storedValue + " is UTC, which is " + comparedValue +
      (timeZone ? " in the form timezone (" + timeZone + ")" : " in the form timezone") +
      "; that is what was compared with the form.";
  }
  if (comparisonMode === "date") {
    return " Stored " + storedValue + " is the internal date format; the form" +
      " shows the same day in the user date format.";
  }
  return "";
}

function nativeDifferenceReason(storedValue, liveValue) {
  if (String(storedValue) === "" && String(liveValue) !== "") {
    return "Stored value is empty; the live value differs.";
  }
  if (String(storedValue) !== "" && String(liveValue) === "") {
    return "Stored and live values differ; the live value is empty.";
  }
  return "Stored and live values differ.";
}

/*
 * Which cells the comparison found different, judged by the same per-column
 * modes the verdict used. The panel marks exactly these.
 *
 * It cannot re-derive them from the values it renders: a Yes/No or Checkbox
 * column folds "Yes" and "true" into one bucket, so a raw string compare in the
 * panel would paint a changed cell inside a set the comparison called a match.
 */
function nativeMrvsDifferingCells(storedRows, liveRows, comparisonModes) {
  const stored = Array.isArray(storedRows) ? storedRows : [];
  const live = Array.isArray(liveRows) ? liveRows : [];
  const modes = comparisonModes || {};
  const cells = [];
  const rowCount = Math.max(stored.length, live.length);
  for (let index = 0; index < rowCount; index += 1) {
    const storedRow = stored[index];
    const liveRow = live[index];
    const columns = new Set([
      ...Object.keys(storedRow || {}),
      ...Object.keys(liveRow || {}),
    ]);
    columns.forEach((column) => {
      // A row missing from one side differs in every column it has, which is
      // what makes a row-count difference visible cell by cell.
      const differs = !storedRow || !liveRow
        ? true
        : !nativeValuesEqual(storedRow[column], liveRow[column], modes[column] || "scalar");
      if (differs) cells.push({ row: index, column });
    });
  }
  return cells;
}

function nativeMrvsDifferenceReason(storedRows, liveRows) {
  if (storedRows.length !== liveRows.length) {
    return "Stored has " + storedRows.length + " row" +
      (storedRows.length === 1 ? "" : "s") + "; the live form has " +
      liveRows.length + ".";
  }
  return "Stored and live rows differ.";
}

function validWorkspaceCanonicalDate(value, dateTime) {
  const pattern = dateTime
    ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
    : /^(\d{4})-(\d{2})-(\d{2})$/;
  const match = String(value == null ? "" : value).match(pattern);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = dateTime ? Number(match[4]) : 0;
  const minute = dateTime ? Number(match[5]) : 0;
  const second = dateTime ? Number(match[6]) : 0;
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second
  );
}

function workspaceLiveValueForComparison(policy, live, timeZone, definition) {
  const source = live || {};
  if (!source.foundEntry) {
    return { ok: false, reason: "Live value unavailable in this Workspace source." };
  }
  if (source.canRead !== true) {
    return {
      ok: false,
      reason: source.canRead === false
        ? "Workspace reports that this variable is not readable."
        : "Workspace did not provide a positive read permission for this variable.",
    };
  }
  if (!source.liveValueAvailable) {
    return {
      ok: false,
      reason: source.valueReadFailed
        ? "The live Workspace value could not be read."
        : "Live value unavailable in this Workspace source.",
    };
  }
  const value = String(source.liveValue);
  const displayAvailable = source.liveDisplayValueAvailable === true;
  const displayValue = displayAvailable ? String(source.liveDisplayValue) : "";
  if (policy.validator === "text-pair") {
    return displayAvailable && value === displayValue
      ? { ok: true, value }
      : { ok: false, reason: "The live Workspace text representation could not be verified." };
  }
  if (policy.validator === "boolean-pair") {
    // Checkbox has a known value domain, unlike free text, so an agreeing pair
    // is not sufficient on its own. An unrecognised future representation must
    // stay "not comparable" rather than fall through to a raw string comparison
    // that would report a difference between states that may be identical.
    // Empty stays comparable: stored empty against a live false is an observed
    // difference the panel is meant to surface, not an unverified shape.
    const recognisedBoolean = value === "" || normalizedNativeBoolean(value) !== null;
    return displayAvailable && value === displayValue && recognisedBoolean
      ? { ok: true, value }
      : { ok: false, reason: "The live Workspace checkbox representation could not be verified." };
  }
  if (policy.validator === "choice-pair") {
    // Layer 1 exposes the stored choice value through `value` and the rendered
    // label through `displayValue`. They may be equal, label-different, or even
    // whitespace-different, so the display string proves only the observed pair
    // shape; it is never substituted for the raw value being compared.
    return displayAvailable
      ? { ok: true, value }
      : { ok: false, reason: "The live Workspace choice representation could not be verified." };
  }
  if (policy.validator === "sys-id") {
    return value === "" || isSysId(value)
      ? { ok: true, value }
      : { ok: false, reason: "The live Workspace reference representation could not be verified." };
  }
  if (policy.validator === "sys-id-list") {
    const members = value === ""
      ? []
      : value.split(",").map((part) => part.trim()).filter(Boolean);
    return members.every(isSysId)
      ? { ok: true, value }
      : { ok: false, reason: "The live Workspace list representation could not be verified." };
  }
  if (policy.validator === "mrvs-pair") {
    // The Workspace form exposes a multi-row set as one container entry whose
    // raw value is the JSON row array and whose displayValue is the SAME array
    // with display labels substituted. Requiring both to parse as arrays of
    // plain objects, of equal length, with identical column names row for row,
    // is what separates that verified shape from any other JSON a future
    // component might put behind this key. Only the raw array is compared.
    //
    // Every observed cell was a string, and every key was one of the set's own
    // columns. Both are required rather than assumed: a number, null or a
    // nested object would otherwise reach the comparison, where a nested object
    // stringifies to "[object Object]" and reports a difference that says
    // nothing. Binding the keys to this set's columns is what ties the array to
    // this variable set rather than to any array of objects.
    const columnNames = nativeMrvsColumnNameSet(definition);
    const liveRows = parseNativeMrvsRows(value);
    const displayRows = displayAvailable ? parseNativeMrvsRows(displayValue) : null;
    const plainRows = (rows) => nativeMrvsRowsWellFormed(rows, columnNames);
    if (
      !plainRows(liveRows) ||
      !plainRows(displayRows) ||
      liveRows.length !== displayRows.length ||
      liveRows.some((entry, index) => {
        const liveKeys = Object.keys(entry).sort();
        const displayKeys = Object.keys(displayRows[index]).sort();
        return (
          liveKeys.length !== displayKeys.length ||
          liveKeys.some((key, keyIndex) => key !== displayKeys[keyIndex])
        );
      })
    ) {
      return {
        ok: false,
        reason: "The live Workspace multi-row representation could not be verified.",
      };
    }
    return { ok: true, value };
  }
  if (policy.validator === "date-pair") {
    if (value === "" && displayAvailable && displayValue === "") {
      return { ok: true, value: "" };
    }
    return (
      validWorkspaceCanonicalDate(value, false) &&
      source.liveDateNormalised === true &&
      source.liveDateValue === value
    )
      ? { ok: true, value }
      : { ok: false, reason: "The live Workspace date representation could not be verified." };
  }
  if (policy.validator === "datetime-pair") {
    if (value === "" && displayAvailable && displayValue === "") {
      return { ok: true, value: "" };
    }
    const displayedForRaw = nativeStoredDateTimeInZone(value, timeZone);
    return (
      validWorkspaceCanonicalDate(value, true) &&
      source.liveDateNormalised === true &&
      displayedForRaw &&
      displayedForRaw === source.liveDateValue
    )
      ? { ok: true, value }
      : { ok: false, reason: "The live Workspace Date/Time representation could not be verified." };
  }
  return { ok: false, reason: "The Workspace live representation is not verified." };
}

function buildNativeVariableRows(definitions, storedResult, liveResults, options) {
  const opts = options || {};
  const userTimeZone = opts.timeZone || "";
  const zoneSource = opts.zoneSource || "";
  const workspaceMode = Boolean(opts.workspace);
  const workspaceSurface = String(opts.workspaceSurfaceKey || "");
  const policyResolver = workspaceMode
    ? (definition) => classifyWorkspaceVariable(definition, workspaceSurface)
    : classifyNativeVariable;
  const visibilityResolver = workspaceMode
    ? workspaceVariableBucket
    : nativeVariableBucket;
  const duplicateNames = nativeDuplicateNameSet(
    definitions,
    storedResult.metadataRows
  );

  return (definitions || []).map((definition) => {
    const storedMatches = (storedResult.metadataRows || []).filter(
      (row) => row.questionId && row.questionId === definition.questionId
    );
    const live = (liveResults || []).find(
      (entry) =>
        entry &&
        entry.questionId === definition.questionId &&
        entry.name === definition.name
    ) || {};
    const visibility = visibilityResolver(definition, live);
    const policy = policyResolver(definition);
    const duplicateName = Boolean(
      definition.name && duplicateNames.has(definition.name)
    );
    // Exactly what the request builder for this world decided, so the panel can
    // never describe a read it did not make.
    const liveReadRequested = workspaceMode
      ? workspaceLiveReadRequested(definition, policy, duplicateName)
      : nativeLiveReadRequested(definition, policy, duplicateName);
    const storedPresent = storedMatches.length > 0;
    const stored = storedMatches.length === 1 ? storedMatches[0] : null;
    const secret = policy.disposition === "secret" || storedMatches.some((row) => row.secret);
    // A multi-row set stores nothing on its own question row, so storedMatches
    // is empty for it by construction. Its stored side comes from the separate
    // sc_multi_row_question_answer read instead.
    const isMrvsRow = Boolean(definition.isMrvs || policy.disposition === "mrvs");
    const isDateMode =
      policy.comparisonMode === "date" || policy.comparisonMode === "datetime";
    const mrvsStatus = storedResult.mrvsReadStatus || "skipped";
    const mrvsSet =
      isMrvsRow && storedResult.mrvsValuesBySetId
        ? storedResult.mrvsValuesBySetId.get(definition.variableSet)
        : null;
    const row = {
      mode: "native",
      name: definition.name,
      label: definition.label,
      type: definition.typeDisplay || definition.type,
      setName: definition.setName || "",
      isMrvs: isMrvsRow,
      inactive: Boolean(definition.inactive),
      bucket: visibility.bucket,
      hidden: visibility.hidden,
      visibilityState: visibility.visibilityState ||
        (visibility.hidden ? "hidden" : "visible"),
      secret,
      workspaceCandidate: false,
      liveLayer: live.liveLayer || null,
      isModified: typeof live.isModified === "boolean" ? live.isModified : null,
      storedPresent,
      // "found" | "absent" | "not-read". storedPresent alone cannot tell a row
      // that is genuinely unstored from one that was never looked up, and
      // rendering both as "(not stored)" states a fact the read never checked.
      storedLookup: "not-read",
      storedRowCount: null,
      liveRowCount: null,
      storedValue: null,
      liveValue: null,
      liveValueAvailable: false,
      comparison: "not-comparable",
      reason: "",
      value: "",
      valueSource: "none",
      gFormReportedVisible:
        live.gFormReportedVisible == null ? null : live.gFormReportedVisible,
    };
    // Exactly the rows workspaceLiveValueRequests asked the form for, so the
    // panel's "all N were checked" can never count a row no read covered.
    row.workspaceCandidate = Boolean(workspaceMode && liveReadRequested && !secret);

    if (!secret && live.liveValueAvailable) {
      row.liveValue = String(live.liveValue == null ? "" : live.liveValue);
      row.liveValueAvailable = true;
      row.value = row.liveValue;
      row.valueSource = "live";
    }
    if (!secret && stored && stored.valueAvailable) {
      row.storedValue = String(stored.storedValue == null ? "" : stored.storedValue);
    }

    const liveMrvsRows = isMrvsRow && row.liveValueAvailable
      ? parseNativeMrvsRows(row.liveValue)
      : null;
    if (Array.isArray(liveMrvsRows)) row.liveRowCount = liveMrvsRows.length;

    if (secret) {
      row.storedLookup = "not-read";
    } else if (isMrvsRow) {
      if (mrvsStatus === "success") {
        const storedMrvsRows = mrvsSet ? mrvsSet.rows : [];
        row.storedLookup = "found";
        row.storedRowCount = storedMrvsRows.length;
        row.storedValue = JSON.stringify(storedMrvsRows);
      } else if (mrvsStatus === "empty") {
        row.storedLookup = "absent";
        row.storedRowCount = 0;
      }
    } else if (
      storedResult.storedReadStatus === "failed" ||
      storedResult.storedReadStatus === "truncated"
    ) {
      row.storedLookup = "not-read";
    } else if (!storedPresent) {
      row.storedLookup = "absent";
    } else if (stored && stored.valueAvailable) {
      row.storedLookup = "found";
    }

    if (secret) {
      row.reason = "Secret value was not read.";
    } else if (isMrvsRow) {
      if (mrvsStatus === "failed" || mrvsStatus === "truncated") {
        row.reason = storedResult.mrvsReadError ||
          "Multi-row variable set values were not read.";
      } else if (mrvsStatus !== "success" && mrvsStatus !== "empty") {
        row.reason = "Multi-row variable set values were not read.";
      } else if (mrvsSet && mrvsSet.withheldColumns.length) {
        // Ahead of the detached branches: a set whose every column was withheld
        // has an entry with zero rows, because assembleNativeMrvsSets creates
        // the entry before the withheld early-return. Judged only on "no rows",
        // such a set on a record that also holds detached rows would say none
        // were found. Rows were found; they were withheld.
        row.reason = "Columns were not read, so no comparison was run: " +
          mrvsSet.withheldColumns.join(", ") + ".";
      } else if (mrvsSet && mrvsSet.indexIncomplete) {
        row.reason = "Stored rows are missing a row index, so they could not be" +
          " grouped and no comparison was run.";
      } else if (
        (!mrvsSet || !mrvsSet.rows.length) &&
        storedResult.detachedMrvsRows === "present"
      ) {
        // This record stores multi-row rows under a set the catalog item does
        // not attach, so "no stored rows" here is a statement about the item's
        // current set list, not about the record. Comparing it against a
        // populated form would report a difference that the read created.
        //
        // Ahead of the empty branch on purpose: the stored read is filtered to
        // the enumerated sets, so a record whose rows are ALL detached reads as
        // empty, which is exactly the case this reason exists to explain.
        row.reason = "No stored rows were found for this set, and this record" +
          " stores multi-row rows under a variable set the catalog item no" +
          " longer attaches, so no comparison was run.";
      } else if (
        (!mrvsSet || !mrvsSet.rows.length) &&
        storedResult.detachedMrvsRows === "unknown"
      ) {
        // Same refusal, different claim. The probe did not answer, so whether
        // this record holds rows under a dropped set is unknown -- and saying it
        // does would assert a fact about storage that no read established.
        row.reason = "No stored rows were found for this set, and the check for" +
          " rows under a variable set the catalog item no longer attaches could" +
          " not be completed, so no comparison was run.";
      } else if (mrvsStatus === "empty") {
        // Zero rows across every enumerated set on this record. That is a real
        // state, but it is also what a wrong parent record would look like, so
        // it is reported rather than compared against a populated live form.
        row.reason = "No multi-row answers are stored for this record.";
      } else if (!liveReadRequested) {
        // Say what actually happened. This row's stored rows are real and its
        // live rows were never asked for, so anything that sounds like an
        // absent or unreadable live value would be a claim about a form that
        // was never tested. This branch must stay ahead of the availability
        // one, which describes a read that did happen.
        row.reason = nativeMrvsNotReadReason(definition, policy, {
          workspaceMode,
          duplicateName,
        });
      } else if (!row.liveValueAvailable) {
        row.reason = definition.liveReadBlockedReason || (live.valueReadFailed
          ? "The live multi-row value could not be read."
          : "No live multi-row value was available.");
      } else if (!Array.isArray(liveMrvsRows)) {
        row.reason = "The live multi-row value was not a readable JSON array.";
      } else {
        // The classic side used to accept any JSON array here, so a cell that
        // was not a string reached the comparison and reported a meaningless
        // "Differs". The shape requirement is representation-agnostic, so it
        // applies on both surfaces without either inheriting the other's
        // per-type evidence; the Workspace validator additionally checks the
        // value/display pair, which is that component's own contract.
        const verified = workspaceMode
          ? workspaceLiveValueForComparison(policy, live, userTimeZone, definition)
          : nativeMrvsRowsWellFormed(liveMrvsRows, nativeMrvsColumnNameSet(definition))
            ? { ok: true, value: row.liveValue }
            : {
              ok: false,
              reason: "The live multi-row rows did not match this set's columns," +
                " so no comparison was run.",
            };
        if (!verified.ok) {
          row.reason = verified.reason;
        } else {
          const storedMrvsRows = mrvsSet ? mrvsSet.rows : [];
          const equal = nativeMrvsValuesEqual(
            storedMrvsRows,
            liveMrvsRows,
            mrvsSet ? mrvsSet.comparisonModes : {}
          );
          row.comparison = equal ? "match" : "differs";
          // Only ever set alongside a verdict, so the panel cannot mark a cell
          // on a row whose sides were never compared.
          row.mrvsCellDiffs = equal
            ? []
            : nativeMrvsDifferingCells(
              storedMrvsRows,
              liveMrvsRows,
              mrvsSet ? mrvsSet.comparisonModes : {}
            );
          row.reason = equal
            ? (workspaceMode
              ? "Stored and live Workspace rows match."
              : "Stored and live rows match.")
            : nativeMrvsDifferenceReason(storedMrvsRows, liveMrvsRows);
        }
      }
    } else if (storedResult.storedReadStatus === "failed") {
      row.reason = "Stored values were unavailable; no comparison was run.";
    } else if (storedResult.storedReadStatus === "truncated") {
      row.reason = "The stored read was truncated; no comparison was run.";
    } else if (!definition.name) {
      row.reason = "The variable has no readable name.";
    } else if (NATIVE_PROTOTYPE_COLLISION_NAMES.has(definition.name)) {
      row.reason = "The variable name collides with the form API prototype.";
    } else if (duplicateName || storedMatches.length > 1) {
      row.reason = "Duplicate variable name; no arbitrary row was selected.";
    } else if (
      !workspaceMode &&
      definition.definitionFromAnswer &&
      live.foundEl === false &&
      row.liveValueAvailable
    ) {
      // The definition came from this record's own answer because the catalog
      // item now defines a different variable of the same name. The classic
      // reader resolves `variables.<name>`, so if the form is bound to the
      // item's NEW question instead, that read returned the new variable's
      // value and comparing it against this record's older answer would report
      // a difference between two different variables. The form not rendering
      // this question id is exactly that case.
      row.reason = "Definition taken from this record's own answer, but the" +
        " form does not render that question, so the live value belongs to a" +
        " different variable of the same name and no comparison was run.";
    } else if (policy.disposition === "structural") {
      row.reason = "Structural variable type has no comparable value.";
    } else if (policy.disposition !== "comparable") {
      row.reason = "Variable type is not verified for comparison.";
    } else if (!storedPresent) {
      row.reason =
        storedResult.storedReadStatus === "empty"
          ? "This record has no stored variable rows."
          : "No stored row exists for this variable.";
    } else if (!stored || !stored.fetchAllowed || !stored.valueAvailable) {
      row.reason = "Stored metadata was not positively classified as comparable.";
    } else if (workspaceMode) {
      const verified = workspaceLiveValueForComparison(policy, live, userTimeZone);
      if (!verified.ok) {
        row.reason = verified.reason;
      } else {
        const equal = nativeValuesEqual(
          row.storedValue,
          verified.value,
          policy.comparisonMode
        );
        row.comparison = equal ? "match" : "differs";
        row.reason = equal
          ? "Stored and live Workspace values match."
          : nativeDifferenceReason(row.storedValue, verified.value);
      }
    } else if (!row.liveValueAvailable) {
      row.reason = live.namespaceUnavailable
        ? "The classic form did not expose catalog variables through the verified variables.* namespace."
        : live.valueReadFailed
          ? "The live form value could not be read."
          : "No live form value was available.";
    } else if (isDateMode && row.liveValue && !live.liveDateNormalised) {
      // An unparsed date is left uncompared: the raw display string and the
      // stored internal value would never match, so comparing them would
      // report a difference that does not exist.
      row.reason = "The live date could not be read in the user date format.";
    } else if (
      policy.comparisonMode === "datetime" &&
      row.storedValue &&
      !nativeStoredDateTimeInZone(row.storedValue, userTimeZone)
    ) {
      row.reason = userTimeZone
        ? "The stored date and time could not be read in the user timezone (" +
          userTimeZone + ")."
        : nativeUnresolvedZoneReason(zoneSource);
    } else {
      const liveForComparison =
        isDateMode && row.liveValue ? live.liveDateValue : row.liveValue;
      const storedForComparison =
        policy.comparisonMode === "datetime" && row.storedValue
          ? nativeStoredDateTimeInZone(row.storedValue, userTimeZone)
          : row.storedValue;
      const equal = nativeValuesEqual(storedForComparison, liveForComparison, policy.comparisonMode);
      row.comparison = equal ? "match" : "differs";
      row.reason = equal ? "Stored and live values match." : nativeDifferenceReason(
        storedForComparison,
        liveForComparison
      );
      if (
        isDateMode &&
        row.storedValue &&
        liveForComparison &&
        (equal || policy.comparisonMode === "datetime")
      ) {
        row.reason += nativeDateComparisonNote(
          policy.comparisonMode,
          row.storedValue,
          storedForComparison,
          userTimeZone,
          zoneSource
        );
      }
    }
    if (definition.definitionFromAnswer && row.reason) {
      row.reason += " Definition taken from this record's own answer: the" +
        " catalog item now defines a different variable with this name.";
    }
    if (row.inactive && row.reason) {
      row.reason = "Inactive variable. " + row.reason;
    }
    return row;
  }).filter((row) => !row.inactive || row.storedPresent);
}

// Build one row per variable, keeping every variable (visible and hidden).
// Visibility is a tag, not a filter: a mis-detected element downgrades a row
// from "visible" to a wrong hidden bucket at worst — it never drops the row.
function buildVariableRows(definitions, perVariableResults) {
  const resultByName = new Map();
  (perVariableResults || []).forEach((entry) => {
    if (entry && entry.name) resultByName.set(entry.name, entry);
  });

  return definitions.map((def) => {
    const domResult = resultByName.get(def.name) || {};
    let bucket;
    let hidden;
    if (def.isMrvs) {
      // A multi-row set renders as a grid, not a single field, so DOM/gForm
      // visibility can't classify it — give it its own bucket, not "hidden".
      bucket = "mrvs";
      hidden = false;
    } else if (def.hiddenType) {
      bucket = "hidden-type";
      hidden = true;
    } else if (domResult.foundEl && domResult.visible === false) {
      bucket = "invisible";
      hidden = true;
    } else if (!domResult.foundEl) {
      bucket = "absent";
      hidden = true;
    } else {
      bucket = "visible";
      hidden = false;
    }

    let value = "";
    let valueSource = "none";
    if (def.secret) {
      value = "[REDACTED]";
      valueSource = "redacted";
    } else if (domResult.liveValueAvailable) {
      value = domResult.liveValue;
      valueSource = "live";
    } else if (def.defaultValue) {
      value = def.defaultValue;
      valueSource = "default";
    }

    return {
      name: def.name,
      label: def.label,
      type: def.typeDisplay,
      setName: def.setName || "",
      isMrvs: Boolean(def.isMrvs),
      bucket,
      hidden,
      secret: def.secret,
      value,
      valueSource,
      gFormReportedVisible:
        domResult.gFormReportedVisible == null ? null : domResult.gFormReportedVisible,
    };
  });
}

async function showHiddenPortalVariables() {
  const catalogItemSysId = currentCatalogItemDefinitionSysId();
  if (!isSysId(catalogItemSysId)) {
    showToast("Open a Service Portal catalog item first", true);
    return;
  }

  showToast("Reading variable definitions…", false, 6000);
  try {
    const { variables: definitions, setCount } = await fetchCatalogItemVariableDefinitions(
      catalogItemSysId
    );
    if (!definitions.length) {
      showToast("No variables found on this catalog item", true);
      return;
    }

    showToast("Checking " + definitions.length + " variables…", false, 6000);
    const resp = await chrome.runtime.sendMessage({
      type: "GET_HIDDEN_PORTAL_VARIABLES",
      catalogItemSysId,
      variables: definitions,
    });
    if (!resp || !resp.ok) {
      throw new Error((resp && resp.error) || "Couldn't inspect the form.");
    }
    if (!resp.foundForm) {
      showToast("Open a catalog order form first", true);
      return;
    }

    const rows = buildVariableRows(definitions, resp.perVariable);
    globalThis.SNHiddenVariablesUI.showResults({
      foundForm: resp.foundForm,
      setCount,
      rows,
    });
    closePalette();
  } catch (error) {
    showToast(String(error && error.message ? error.message : error), true);
  }
}

async function probeNativeRecordVariables(variables, options) {
  const opts = options || {};
  const resp = await chrome.runtime.sendMessage({
    type: "GET_NATIVE_RECORD_VARIABLES",
    variables: Array.isArray(variables) ? variables : [],
    expectedIdentity: opts.expectedIdentity || null,
    softNoMatchOnFailure: Boolean(opts.softNoMatchOnFailure),
  });
  if (!resp || !resp.ok) {
    throw new Error((resp && resp.error) || "Couldn't inspect the classic form.");
  }
  return resp;
}

async function probeWorkspaceVariableSnapshot(variables) {
  const resp = await chrome.runtime.sendMessage({
    type: "GET_WORKSPACE_VARIABLE_SNAPSHOT",
    variables: Array.isArray(variables) ? variables : [],
  });
  if (!resp || !resp.ok || !resp.snapshot) {
    throw new Error((resp && resp.error) || "Couldn't inspect the Workspace record.");
  }
  return resp.snapshot;
}

function workspaceSnapshotMatchesRoute(snapshot, route) {
  return Boolean(
    snapshot &&
    snapshot.identityStatus === "verified" &&
    snapshot.identity &&
    snapshot.identity.table === route.table &&
    snapshot.identity.sysId === route.sysId &&
    workspaceRecordContextMatches(snapshot.route, route)
  );
}

function workspacePanelCapabilities(panelState) {
  const comparison = panelState === "complete" || panelState === "partial";
  return {
    comparison,
    liveValues: comparison,
    differing: comparison,
    liveVisibility: comparison,
  };
}

function showWorkspaceVariableValuesError(message) {
  globalThis.SNHiddenVariablesUI.showResults({
    mode: "native",
    recordKind: "workspace",
    panelState: "refused",
    capabilities: workspacePanelCapabilities("refused"),
    foundForm: false,
    setCount: 0,
    storedReadStatus: "failed",
    fatalError: message,
    checkedCount: 0,
    candidateCount: 0,
    uncheckedCount: 0,
    rows: [],
  });
  closePalette();
}

/*
 * The two stored readers report definition completeness under different names:
 * the RITM reader enumerates a catalog item and sets `definitionReadStatus`,
 * while the producer reader sets `definitionEnumerationStatus`. Reading only
 * the first left every producer-backed Workspace panel stuck on "partial" even
 * when every candidate had been checked, because the field was undefined.
 *
 * `answers-only` counts as complete here on purpose, and only because of what
 * the panel actually claims: that every listed comparable variable was checked
 * against storage. It never claims to list variables the producer defines but
 * this record never answered. A truncated, failed or unavailable enumeration is
 * a different thing and stays incomplete.
 */
function workspaceDefinitionsComplete(recordData) {
  const data = recordData || {};
  if (typeof data.definitionEnumerationStatus === "string") {
    return (
      data.definitionEnumerationStatus === "success" ||
      data.definitionEnumerationStatus === "answers-only"
    );
  }
  return data.definitionReadStatus === "success";
}

function workspacePanelState(recordData, formStatus, rows) {
  const candidates = (rows || []).filter((row) => row.workspaceCandidate);
  const checked = candidates.filter(
    (row) => row.comparison === "match" || row.comparison === "differs"
  );
  const definitionComplete = workspaceDefinitionsComplete(recordData);
  const storedComplete =
    recordData.storedReadStatus === "success" ||
    recordData.storedReadStatus === "empty";
  let panelState = "partial";
  if (formStatus !== "available") {
    if (!storedComplete) {
      panelState = "stored-unavailable";
    } else {
      panelState = recordData.storedReadStatus === "empty"
        ? "no-editor-empty"
        : "stored-only";
    }
  } else if (definitionComplete && storedComplete && candidates.length === 0) {
    panelState = "no-candidate";
  } else if (
    definitionComplete &&
    storedComplete &&
    candidates.length > 0 &&
    checked.length === candidates.length
  ) {
    panelState = "complete";
  }
  return {
    panelState,
    candidateCount: candidates.length,
    checkedCount: checked.length,
    uncheckedCount: Math.max(0, candidates.length - checked.length),
  };
}

/*
 * One Workspace reader for every allowlisted surface. The route decided which
 * surface this is; `surface.kind` decides only which stored reader owns the
 * record, and `surface.key` keeps the live type policy pinned to the surface
 * that was actually verified. The identity gate, the route recheck and the
 * final-snapshot discard rule are identical for all of them.
 */
async function showWorkspaceVariableValues(route, surface, initialSnapshot) {
  if (!workspaceSnapshotMatchesRoute(initialSnapshot, route)) {
    showWorkspaceVariableValuesError(
      (initialSnapshot && initialSnapshot.identityReason) ||
      "The Workspace record identity could not be verified. Nothing was compared."
    );
    return;
  }

  showToast("Reading stored variable metadata…", false, 6000);
  let recordData;
  try {
    recordData = surface.kind === "producer"
      ? await fetchNativeProducerRecordData(route.table, route.sysId)
      : await fetchNativeRitmRecordData(route.sysId);
  } catch (error) {
    showWorkspaceVariableValuesError(
      "Stored variable metadata could not be read. No values were compared."
    );
    return;
  }
  // A producer-backed table with no matching question_answer rows is not a
  // record this reader can speak for. Say so instead of presenting an empty
  // panel that reads as "this record has no variables".
  if (surface.kind === "producer" && !recordData.recordProducerFound) {
    showWorkspaceVariableValuesError(
      "No record producer variable answers were found for this Workspace record. Nothing was compared."
    );
    return;
  }

  const finalRoute = workspaceRecordContextFromText(location.href);
  if (!workspaceRecordContextMatches(route, finalRoute)) {
    showWorkspaceVariableValuesError(
      "The Workspace route moved while stored values were being read. Nothing was compared."
    );
    return;
  }
  const requests = workspaceLiveValueRequests(
    recordData.definitions,
    surface.key,
    nativeDuplicateNameSet(recordData.definitions, recordData.metadataRows)
  );
  showToast("Reading live Workspace values…", false, 6000);
  const finalSnapshot = await probeWorkspaceVariableSnapshot(requests);
  if (
    !workspaceSnapshotMatchesRoute(finalSnapshot, route) ||
    finalSnapshot.formStatus !== initialSnapshot.formStatus
  ) {
    showWorkspaceVariableValuesError(
      (finalSnapshot && finalSnapshot.identityReason) ||
      "The Workspace form moved while values were being read. Nothing was compared."
    );
    return;
  }

  const rows = buildNativeVariableRows(
    recordData.definitions,
    recordData,
    finalSnapshot.perVariable,
    {
      workspace: true,
      workspaceSurfaceKey: surface.key,
      timeZone: finalSnapshot.timeZone || "",
      zoneSource: finalSnapshot.timeZone ? "page" : "no-page-zone",
    }
  );
  const state = workspacePanelState(recordData, finalSnapshot.formStatus, rows);
  globalThis.SNHiddenVariablesUI.showResults({
    mode: "native",
    recordKind: "workspace",
    panelState: state.panelState,
    capabilities: workspacePanelCapabilities(state.panelState),
    foundForm: finalSnapshot.formStatus === "available",
    setCount: recordData.setCount,
    storedReadStatus: recordData.storedReadStatus,
    storedReadError: recordData.storedReadError,
    checkedCount: state.checkedCount,
    candidateCount: state.candidateCount,
    uncheckedCount: state.uncheckedCount,
    rows,
  });
  closePalette();
}

function showNativeVariableValuesError(message, recordKind) {
  globalThis.SNHiddenVariablesUI.showResults({
    mode: "native",
    recordKind: recordKind || "record",
    foundForm: false,
    setCount: 0,
    storedReadStatus: "failed",
    fatalError: message,
    rows: [],
  });
  closePalette();
}

// True when any definition sharing this name is classified secret.
function nativeNameHoldsSecret(definitions, name) {
  if (!name) return false;
  return (definitions || []).some(
    (definition) =>
      definition.name === name &&
      classifyNativeVariable(definition).disposition === "secret"
  );
}

function nativeLiveValueRequests(definitions, duplicateNames) {
  // A name shared by two definitions, or by two stored rows, is already
  // uncomparable, and g_form resolves it to whichever one it chooses. If either
  // of them is secret, reading "the other one" by that name can surface the
  // secret's value in an ordinary row, so no duplicate name is ever read.
  const duplicates = duplicateNames || nativeDuplicateNameSet(definitions, []);

  return (definitions || []).map((definition) => {
    const policy = classifyNativeVariable(definition);
    const duplicateName = Boolean(
      definition.name && duplicates.has(definition.name)
    );
    const ownSecret = policy.disposition === "secret";
    return {
      name: definition.name,
      fieldName: definition.name ? "variables." + definition.name : "",
      questionId: definition.questionId,
      // A duplicate of a secret is treated as secret itself: the probe must not
      // touch that name at all, not even to ask whether it is visible.
      secret: ownSecret ||
        (duplicateName && nativeNameHoldsSecret(definitions, definition.name)),
      duplicateName,
      dateKind:
        policy.comparisonMode === "date" || policy.comparisonMode === "datetime"
          ? policy.comparisonMode
          : "",
      readValue: nativeLiveReadRequested(definition, policy, duplicateName),
    };
  });
}

function workspaceLiveValueRequests(definitions, surfaceKey, duplicateNames) {
  const list = Array.isArray(definitions) ? definitions : [];
  const duplicates = duplicateNames || nativeDuplicateNameSet(list, []);

  return list.flatMap((definition) => {
    const def = definition || {};
    const policy = classifyWorkspaceVariable(def, surfaceKey);
    const duplicateName = Boolean(def.name && duplicates.has(def.name));
    if (!workspaceLiveReadRequested(def, policy, duplicateName)) {
      return [];
    }
    return [{
      name: def.name,
      fieldName: "variables." + def.name,
      // A multi-row set's question id is its variable set. The Workspace form
      // exposes the set as one container entry under that same id, so the
      // MAIN-world identity gate needs no special case for it.
      questionId: def.questionId,
      type: normalizeVariableType(def.type),
      dateKind:
        policy.comparisonMode === "date" || policy.comparisonMode === "datetime"
          ? policy.comparisonMode
          : "",
      // May a real JavaScript boolean be accepted as this entry's value?
      //
      // The supplier component settles a checkbox's value into a raw boolean
      // rather than a string. Measured on a supplier case: the entry arrives as
      // the string "true" and, about a second later, becomes boolean `true` and
      // stays there — so the panel, which always runs after that, saw a value it
      // refused and reported the live value as unavailable when the form had it
      // all along. Only the field hidden by a UI policy settled that way; the
      // six rendered boolean variables on the same record stayed strings, which
      // fits a rendered control writing its value back as text while a field
      // that never renders keeps the raw one.
      //
      // Decided here rather than in the snapshot for the same reason `dateKind`
      // is: this is a per-surface, per-policy judgement and the snapshot must
      // not make one. SOW is deliberately excluded — no request item exposes a
      // boolean-typed variable at all, so there is nothing to prove it with, and
      // per-type evidence never transfers between surfaces.
      booleanKind: Boolean(
        policy.comparisonMode === "boolean" &&
        WORKSPACE_BOOLEAN_VALUE_SURFACES.has(surfaceKey)
      ),
      liveLayer: policy.layer,
    }];
  });
}

async function finishNativeVariableValues(
  initialIdentity,
  recordData,
  recordKind,
  initialWorkspaceRoute
) {
  const liveRequests = nativeLiveValueRequests(
    recordData.definitions,
    nativeDuplicateNameSet(recordData.definitions, recordData.metadataRows)
  );
  showToast("Reading live form values…", false, 6000);
  let finalWorkspaceRoute = null;
  if (initialWorkspaceRoute) {
    finalWorkspaceRoute = workspaceRecordContextFromText(location.href);
    if (!workspaceRecordContextMatches(initialWorkspaceRoute, finalWorkspaceRoute)) {
      showNativeVariableValuesError(
        "The Workspace route moved while stored values were being read. Nothing was compared.",
        recordKind
      );
      return;
    }
  }
  const liveProbe = await probeNativeRecordVariables(liveRequests, {
    expectedIdentity: finalWorkspaceRoute
      ? { table: finalWorkspaceRoute.table, sysId: finalWorkspaceRoute.sysId }
      : null,
    softNoMatchOnFailure: Boolean(finalWorkspaceRoute),
  });
  const finalIdentity = liveProbe.identity;
  if (!liveProbe.foundGForm || !nativeRecordIdentityMatches(initialIdentity, finalIdentity)) {
    showNativeVariableValuesError(
      "The form moved to another record while stored values were being read. Nothing was compared.",
      recordKind
    );
    return;
  }

  const needsTimeZone = liveRequests.some((request) => request.dateKind === "datetime");
  const pageTimeZone = String(liveProbe.timeZone || "").trim();
  const zone = {
    timeZone: needsTimeZone ? pageTimeZone : "",
    zoneSource: needsTimeZone
      ? (pageTimeZone ? "page" : "no-page-zone")
      : "none",
  };
  const rows = buildNativeVariableRows(
    recordData.definitions,
    recordData,
    liveProbe.perVariable,
    zone
  );
  globalThis.SNHiddenVariablesUI.showResults({
    mode: "native",
    recordKind,
    foundForm: true,
    setCount: recordData.setCount,
    storedReadStatus: recordData.storedReadStatus,
    storedReadError: recordData.storedReadError,
    rows,
  });
  closePalette();
}

async function showNativeRitmVariableValues(initialProbe, workspaceRoute) {
  const initialIdentity = initialProbe && initialProbe.identity;
  if (
    !nativeRecordIdentityMatches(initialIdentity, initialIdentity) ||
    initialIdentity.table !== "sc_req_item"
  ) {
    showNativeVariableValuesError(
      "The classic form did not provide a verified RITM identity.",
      "ritm"
    );
    return;
  }

  showToast("Reading stored variable metadata…", false, 6000);
  let recordData;
  try {
    recordData = await fetchNativeRitmRecordData(initialIdentity.sysId);
  } catch (error) {
    showToast("Variable definitions could not be read. No values were inspected.", true);
    return;
  }

  await finishNativeVariableValues(initialIdentity, recordData, "ritm", workspaceRoute);
}

async function showNativeProducerVariableValues(initialProbe, workspaceRoute) {
  const initialIdentity = initialProbe && initialProbe.identity;
  if (!nativeRecordIdentityMatches(initialIdentity, initialIdentity)) {
    showNativeVariableValuesError(
      "The classic form did not provide a verified record identity.",
      "producer"
    );
    return;
  }

  showToast("Reading record producer answer metadata…", false, 6000);
  let recordData;
  try {
    recordData = await fetchNativeProducerRecordData(
      initialIdentity.table,
      initialIdentity.sysId
    );
  } catch (error) {
    showToast("Record producer variable definitions could not be read. No values were inspected.", true);
    return;
  }
  if (!recordData.recordProducerFound) {
    showToast("No record producer variable answers were found for this classic record.", true);
    return;
  }
  await finishNativeVariableValues(initialIdentity, recordData, "producer", workspaceRoute);
}

/* One context-sensitive command: classic RITMs use sc_item_option storage,
 * other classic records use matching question_answer rows, and a page without
 * a classic g_form keeps the existing Service Portal path unchanged. */
async function showVariableValues() {
  showToast("Checking the current form…", false, 6000);
  try {
    if (window !== window.top) {
      showToast("Variable Values must run from the top-level ServiceNow page.", true);
      return;
    }
    const workspaceRoute = workspaceRecordContextFromText(location.href);
    const initialProbe = await probeNativeRecordVariables([], {
      expectedIdentity: workspaceRoute
        ? { table: workspaceRoute.table, sysId: workspaceRoute.sysId }
        : null,
      softNoMatchOnFailure: Boolean(workspaceRoute),
    });
    if (initialProbe.foundGForm) {
      if (!nativeRecordIdentityMatches(initialProbe.identity, initialProbe.identity)) {
        showNativeVariableValuesError(
          "The classic form did not provide a verified record identity.",
          "record"
        );
        return;
      }
      if (initialProbe.identity.table === "sc_req_item") {
        await showNativeRitmVariableValues(initialProbe, workspaceRoute);
      } else {
        await showNativeProducerVariableValues(initialProbe, workspaceRoute);
      }
      return;
    }
    if (workspaceRoute) {
      const surface = workspaceSupportedSurface(workspaceRoute);
      if (surface) {
        const initialWorkspaceSnapshot = await probeWorkspaceVariableSnapshot([]);
        await showWorkspaceVariableValues(
          workspaceRoute,
          surface,
          initialWorkspaceSnapshot
        );
      } else {
        showWorkspaceVariableValuesError(
          "Variable Values does not yet support this Workspace record. No comparison was made and no variable values were read."
        );
      }
      return;
    }
    await showHiddenPortalVariables();
  } catch (error) {
    showToast(String(error && error.message ? error.message : error), true);
  }
}

/* =====================================================================
 * "What affects this catalog item"
 *
 * Read-only sibling of showHiddenPortalVariables: lists the catalog client
 * scripts (catalog_script_client) and catalog UI policies (catalog_ui_policy)
 * bound to the current item or any variable set attached to it. All reads are
 * same-origin authenticated GETs via snGetMany — no new permissions, and a
 * token-enforced GET degrades to a toast like every other Table API caller.
 *
 * Field-name asymmetry to remember: the item link is `cat_item` on
 * catalog_script_client but `catalog_item` on catalog_ui_policy.
 * ===================================================================== */

const CATALOG_CLIENT_FIELDS = [
  "sys_id", "name", "type", "cat_variable", "variable", "cat_item", "variable_set",
  "active", "order", "applies_catalog", "applies_sc_task", "applies_req_item",
].join(",");

// The onChange-watched variable column differs across ServiceNow versions
// (`cat_variable` vs `variable`), and reference values sometimes carry an
// `IO:` prefix. Return the first candidate that resolves to a sys_id.
function catalogWatchedVariableId(row) {
  for (const field of ["cat_variable", "variable"]) {
    let value = snFieldValue(row, field).trim();
    if (value.indexOf("IO:") === 0) value = value.slice(3);
    if (isSysId(value)) return value;
  }
  return "";
}

const CATALOG_UIP_FIELDS = [
  "sys_id", "short_description", "catalog_item", "variable_set",
  "active", "order", "on_load", "reverse_if_false", "catalog_conditions",
  "applies_catalog", "applies_sc_task", "applies_req_item",
].join(",");

const CATALOG_UIP_ACTION_FIELDS = [
  "sys_id", "ui_policy", "catalog_variable", "variable",
  "mandatory", "visible", "disabled", "value", "order",
].join(",");

// The variable a UI policy action targets. Like catalogWatchedVariableId, the
// reference column name drifts across versions (`catalog_variable` vs
// `variable`) and values sometimes carry an `IO:` prefix.
function catalogActionVariableId(row) {
  for (const field of ["catalog_variable", "variable"]) {
    let value = snFieldValue(row, field).trim();
    if (value.indexOf("IO:") === 0) value = value.slice(3);
    if (isSysId(value)) return value;
  }
  return "";
}

// A UI policy action stores each effect as a 3-state string: "true" applies it,
// "false" applies the opposite, anything else ("ignore"/"leave") means untouched.
// Turn the set into a short human phrase for the scoped view.
function describeCatalogActionEffect(action) {
  const parts = [];
  if (action.visible === "true") parts.push("shows");
  else if (action.visible === "false") parts.push("hides");
  if (action.mandatory === "true") parts.push("mandatory");
  else if (action.mandatory === "false") parts.push("optional");
  if (action.disabled === "true") parts.push("read-only");
  else if (action.disabled === "false") parts.push("editable");
  if (action.value) parts.push("sets value");
  return parts.join(", ");
}

function snBool(row, field) {
  const v = snFieldValue(row, field).trim().toLowerCase();
  return v === "true" || v === "1";
}

function catalogViewFlags(row) {
  return {
    catalog: snBool(row, "applies_catalog"),
    task: snBool(row, "applies_sc_task"),
    ritm: snBool(row, "applies_req_item"),
  };
}

// Where a script/policy is attached: this item, or a named variable set.
function catalogBoundTo(row, itemField, itemSysId, setNames) {
  const setId = snFieldValue(row, "variable_set");
  if (isSysId(setId)) {
    return "Variable set: " + (setNames.get(setId) || "(set " + setId.slice(0, 8) + "…)");
  }
  const itemId = snFieldValue(row, itemField);
  if (isSysId(itemId) && itemId === itemSysId) return "This item";
  if (isSysId(itemId)) return "Another catalog item";
  return "This item";
}

async function fetchCatalogAffectingLogic(catalogItemSysId) {
  // Variable sets attached to the item (same source the values panel uses).
  const setRows = await snGetMany(
    "io_set_item",
    "sc_cat_item=" + catalogItemSysId,
    "variable_set,order",
    100,
    { displayAll: true, excludeRefLinks: true }
  );
  const setIds = Array.from(
    new Set(setRows.map((row) => snFieldValue(row, "variable_set")).filter(isSysId))
  );
  const setNames = new Map();
  if (setIds.length) {
    const meta = await fetchVariableSetMeta(setIds);
    meta.forEach((info, id) => setNames.set(id, info.title || ""));
  }

  const setClause = setIds.length ? "^ORvariable_setIN" + setIds.join(",") : "";
  const clientRows = await snGetMany(
    "catalog_script_client",
    "cat_item=" + catalogItemSysId + setClause,
    CATALOG_CLIENT_FIELDS,
    200,
    { displayAll: true, excludeRefLinks: true }
  );
  const uipRows = await snGetMany(
    "catalog_ui_policy",
    "catalog_item=" + catalogItemSysId + setClause,
    CATALOG_UIP_FIELDS,
    200,
    { displayAll: true, excludeRefLinks: true }
  );

  // UI policy ACTIONS make a policy variable-specific: each row hides/mandates/
  // sets a single variable. Fetch the actions for the policies we found, keyed
  // back to their policy so we can attribute them per variable.
  const uipIds = Array.from(
    new Set(uipRows.map((row) => snFieldValue(row, "sys_id")).filter(isSysId))
  );
  let actionRows = [];
  if (uipIds.length) {
    actionRows = await snGetMany(
      "catalog_ui_policy_action",
      "ui_policyIN" + uipIds.join(","),
      CATALOG_UIP_ACTION_FIELDS,
      300,
      { displayAll: true, excludeRefLinks: true }
    );
  }
  const actionsByPolicy = new Map();
  actionRows.forEach((row) => {
    const policyId = snFieldValue(row, "ui_policy");
    const variableId = catalogActionVariableId(row);
    if (!isSysId(policyId) || !isSysId(variableId)) return;
    const list = actionsByPolicy.get(policyId) || [];
    list.push({
      variable: variableId,
      mandatory: snFieldValue(row, "mandatory").trim().toLowerCase(),
      visible: snFieldValue(row, "visible").trim().toLowerCase(),
      disabled: snFieldValue(row, "disabled").trim().toLowerCase(),
      value: snFieldDisplay(row, "value"),
    });
    actionsByPolicy.set(policyId, list);
  });

  // Resolve every referenced variable sys_id (onChange-watched AND action
  // targets) to a developer-facing name and question label in one lookup. The
  // reference is to item_option_new, so raw values read as noise ungrouped.
  const variableIds = Array.from(
    new Set(
      [
        ...clientRows.map((row) => catalogWatchedVariableId(row)),
        ...actionRows.map((row) => catalogActionVariableId(row)),
      ].filter(isSysId)
    )
  );
  const variableInfo = new Map();
  if (variableIds.length) {
    const varRows = await snGetMany(
      "item_option_new",
      "sys_idIN" + variableIds.join(","),
      "sys_id,name,question_text",
      variableIds.length,
      { displayAll: true, excludeRefLinks: true }
    );
    varRows.forEach((r) => {
      variableInfo.set(snFieldValue(r, "sys_id"), {
        name: snFieldValue(r, "name"),
        label: snFieldDisplay(r, "question_text"),
      });
    });
  }

  const rows = [];

  clientRows.forEach((row) => {
    const order = parseVariableOrder(snFieldValue(row, "order"));
    const variableId = catalogWatchedVariableId(row);
    const info = variableInfo.get(variableId) || {};
    rows.push({
      kind: "client",
      id: snFieldValue(row, "sys_id"),
      name: snFieldDisplay(row, "name"),
      subtype: snFieldDisplay(row, "type"),
      variable: variableId,
      variableName: info.name || "",
      variableLabel: info.label || "",
      boundTo: catalogBoundTo(row, "cat_item", catalogItemSysId, setNames),
      active: snBool(row, "active"),
      views: catalogViewFlags(row),
      order: order.value,
      orderKnown: order.known,
      conditions: "",
    });
  });

  uipRows.forEach((row) => {
    const order = parseVariableOrder(snFieldValue(row, "order"));
    const policyId = snFieldValue(row, "sys_id");
    const actions = (actionsByPolicy.get(policyId) || []).map((action) => {
      const info = variableInfo.get(action.variable) || {};
      return {
        variable: action.variable,
        variableName: info.name || "",
        variableLabel: info.label || "",
        mandatory: action.mandatory,
        visible: action.visible,
        disabled: action.disabled,
        value: action.value,
        effect: describeCatalogActionEffect(action),
      };
    });
    const extras = [];
    if (snBool(row, "on_load")) extras.push("on load");
    if (snBool(row, "reverse_if_false")) extras.push("reverses");
    if (actions.length) {
      extras.push(actions.length + (actions.length === 1 ? " var" : " vars"));
    }
    rows.push({
      kind: "uip",
      id: policyId,
      name: snFieldDisplay(row, "short_description"),
      subtype: extras.join(" · "),
      variable: "",
      variableName: "",
      variableLabel: "",
      actions,
      boundTo: catalogBoundTo(row, "catalog_item", catalogItemSysId, setNames),
      active: snBool(row, "active"),
      views: catalogViewFlags(row),
      order: order.value,
      orderKnown: order.known,
      conditions: snFieldValue(row, "catalog_conditions"),
    });
  });

  // Item-bound before set-bound, then by order, then name.
  const boundRank = (r) => (r.boundTo === "This item" ? 0 : 1);
  rows.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      boundRank(a) - boundRank(b) ||
      (a.order || 0) - (b.order || 0) ||
      String(a.name).localeCompare(String(b.name))
  );

  return { rows, setCount: setIds.length, setIds };
}

async function showCatalogInsight() {
  const catalogItemSysId = currentCatalogItemDefinitionSysId();
  if (!isSysId(catalogItemSysId)) {
    showToast("Open a Service Portal catalog item first", true);
    return;
  }

  showToast("Reading catalog client scripts and UI policies…", false, 6000);
  try {
    const { rows, setCount, setIds } = await fetchCatalogAffectingLogic(catalogItemSysId);
    let itemName = "";
    try {
      const itemRows = await snGetMany(
        "sc_cat_item",
        "sys_id=" + catalogItemSysId,
        "name",
        1,
        { displayAll: true, excludeRefLinks: true }
      );
      if (itemRows.length) itemName = snFieldDisplay(itemRows[0], "name");
    } catch (e) {
      /* name is cosmetic; ignore */
    }

    globalThis.SNCatalogInsightUI.showResults({
      rows,
      setCount,
      itemName,
      itemSysId: catalogItemSysId,
      setIds,
    });
    closePalette();
  } catch (error) {
    showToast(String(error && error.message ? error.message : error), true);
  }
}

/* =====================================================================
 * Variable insight icons (Service Portal catalog forms)
 *
 * A per-variable sibling of "What affects this catalog item": drops a small
 * icon next to each rendered catalog variable; clicking it opens the Catalog
 * Insight panel scoped to that one variable (its onChange client scripts and
 * the UI policy actions that target it). Toggle with Alt+double-click or the
 * command palette. Read-only throughout.
 *
 * Two-worlds bridge: a variable's internal name and definition sys_id live only
 * in the Angular `field` model, invisible to this isolated world. background.js
 * runs mapPortalVariableAnchors() in the MAIN world, which stamps data-snh-var*
 * onto each variable element; we then anchor icons off those stamps.
 * ===================================================================== */

// Index the affecting-logic rows by the variable each item targets, keyed by
// BOTH internal name and definition sys_id so a DOM stamp can match on either.
// "count" = onChange client scripts watching it + UI policy actions on it.
function buildVariableLogicIndex(rows) {
  const byName = new Map();
  const bySysId = new Map();
  const bump = (map, key, label) => {
    if (!key) return;
    const cur = map.get(key) || { count: 0, label: "" };
    cur.count += 1;
    if (!cur.label && label) cur.label = label;
    map.set(key, cur);
  };
  (rows || []).forEach((row) => {
    if (row.kind === "client" && row.variable) {
      bump(byName, row.variableName, row.variableLabel);
      bump(bySysId, row.variable, row.variableLabel);
    } else if (row.kind === "uip" && Array.isArray(row.actions)) {
      row.actions.forEach((action) => {
        bump(byName, action.variableName, action.variableLabel);
        bump(bySysId, action.variable, action.variableLabel);
      });
    }
  });
  return { byName, bySysId };
}

function lookupVariableLogic(index, name, sysId) {
  if (!index) return { count: 0, label: name };
  const bySys = (sysId && index.bySysId.get(sysId)) || null;
  const byName = (name && index.byName.get(name)) || null;
  return {
    count: Math.max((bySys && bySys.count) || 0, (byName && byName.count) || 0),
    label: (bySys && bySys.label) || (byName && byName.label) || name,
  };
}

// Where to hang the icon for a stamped `.field-actual` element. Most variables
// carry a `sp_field_label_<name>` span in the same .form-group; booleans and a
// few others don't, so we fall back to the control container itself.
function varInsightAnchorFor(fieldActualEl, type) {
  const wrapper = fieldActualEl.closest(".form-group") || fieldActualEl.parentElement;
  if (!wrapper) return null;
  if (type !== "boolean") {
    const labelSpan = wrapper.querySelector("span[id^='sp_field_label_']");
    if (labelSpan) return labelSpan;
  }
  return fieldActualEl;
}

// The catalog form is a light surface, so use a deeper teal than the dark panels.
function makeVariableInsightIcon(name, sysId, info) {
  const count = (info && info.count) || 0;
  const btn = document.createElement("span");
  btn.className = "snh-var-insight";
  btn.setAttribute("role", "button");
  btn.tabIndex = 0;
  btn.title = count
    ? count +
      (count === 1
        ? " client script / UI policy action affects "
        : " client scripts / UI policy actions affect ") +
      "“" + name + "” — click to view"
    : "No variable-specific logic on “" + name +
      "” — click to see what runs on this form";
  btn.innerHTML =
    ICON_VAR_LOGIC +
    (count
      ? '<span style="font:600 9px/1 -apple-system,BlinkMacSystemFont,' +
        "'Segoe UI',sans-serif;color:inherit\">" + count + "</span>"
      : "");
  btn.style.cssText =
    "display:inline-flex;align-items:center;gap:3px;vertical-align:middle;" +
    "margin-left:6px;color:" + (count ? "#0f9e8e" : "#8a8f99") +
    ";cursor:pointer;line-height:0;";
  const handler = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openVariableInsight(name, sysId);
  };
  btn.addEventListener("click", handler);
  btn.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") handler(event);
  });
  btn.addEventListener("mouseenter", () => (btn.style.opacity = "0.7"));
  btn.addEventListener("mouseleave", () => (btn.style.opacity = "1"));
  return btn;
}

function openVariableInsight(name, sysId) {
  const data = SNH.varInsightData;
  if (!data || !globalThis.SNCatalogInsightUI) {
    showToast("Reopen the variable icons and try again", true);
    return;
  }
  const info = lookupVariableLogic(data.index, name, sysId);
  globalThis.SNCatalogInsightUI.showResults({
    rows: data.rows,
    setCount: data.setCount,
    setIds: data.setIds,
    itemName: data.itemName,
    itemSysId: data.itemSysId,
    focusVariable: { name, sysId, label: (info && info.label) || name },
  });
}

// (Re)stamp variable identities via the MAIN world only when something is
// unstamped — a fresh render or the first pass. ng-hide toggles keep the stamp,
// so the common re-render skips the round trip. Then anchor a missing icon on
// every stamped variable (rich-text labels carry no logic, so they're skipped).
async function injectVariableInsightIcons() {
  if (!SNH.varInsightOn || !SNH.varInsightData) return 0;

  const needsStamp =
    !document.querySelector("[data-snh-var]") ||
    Boolean(document.querySelector("span.field-actual[ng-switch]:not([data-snh-var])"));
  if (needsStamp) {
    let resp = null;
    try {
      resp = await chrome.runtime.sendMessage({ type: "MAP_PORTAL_VARIABLES" });
    } catch (e) {
      resp = null;
    }
    if (!resp || !resp.ok || !resp.foundForm) return 0;
  }

  const index = SNH.varInsightData.index;
  let count = 0;
  document.querySelectorAll("[data-snh-var]").forEach((el) => {
    const name = el.getAttribute("data-snh-var");
    if (!name) return;
    const type = el.getAttribute("data-snh-var-type") || "";
    if (type === "rich_text_label") return;
    const sysId = el.getAttribute("data-snh-var-sysid") || "";
    const anchor = varInsightAnchorFor(el, type);
    if (!anchor || anchor.querySelector(":scope > .snh-var-insight")) return;
    anchor.appendChild(makeVariableInsightIcon(name, sysId, lookupVariableLogic(index, name, sysId)));
    count++;
  });
  return count;
}

async function toggleVariableInsightIcons(force) {
  const turnOn = typeof force === "boolean" ? force : !SNH.varInsightOn;

  removeSnhElements(".snh-var-insight");
  document.querySelectorAll("[data-snh-var]").forEach((el) => {
    el.removeAttribute("data-snh-var");
    el.removeAttribute("data-snh-var-sysid");
    el.removeAttribute("data-snh-var-type");
  });

  if (!turnOn) {
    SNH.varInsightOn = false;
    syncVarInsightObserver();
    return 0;
  }

  const catalogItemSysId = currentCatalogItemDefinitionSysId();
  if (!isSysId(catalogItemSysId)) {
    SNH.varInsightOn = false;
    syncVarInsightObserver();
    showToast("Open a Service Portal catalog item first", true);
    return 0;
  }

  try {
    if (!SNH.varInsightData || SNH.varInsightData.itemSysId !== catalogItemSysId) {
      showToast("Reading catalog client scripts and UI policies…", false, 6000);
      const data = await fetchCatalogAffectingLogic(catalogItemSysId);
      let itemName = "";
      try {
        const itemRows = await snGetMany(
          "sc_cat_item", "sys_id=" + catalogItemSysId, "name", 1,
          { displayAll: true, excludeRefLinks: true }
        );
        if (itemRows.length) itemName = snFieldDisplay(itemRows[0], "name");
      } catch (e) {
        /* name is cosmetic */
      }
      SNH.varInsightData = {
        rows: data.rows,
        setCount: data.setCount,
        setIds: data.setIds,
        itemName,
        itemSysId: catalogItemSysId,
        index: buildVariableLogicIndex(data.rows),
      };
    }
  } catch (error) {
    SNH.varInsightOn = false;
    syncVarInsightObserver();
    showToast(String(error && error.message ? error.message : error), true);
    return 0;
  }

  SNH.varInsightOn = true;
  const count = await injectVariableInsightIcons();
  syncVarInsightObserver();
  showToast(
    count
      ? "Variable insight icons on — Alt+double-click to hide"
      : "No catalog variables found on this form",
    !count,
    2400
  );
  return count;
}

/*
 * Re-apply for Service Portal. Unlike the classic observer, catalog forms are an
 * Angular SPA: fields are recreated on section moves and variable-set loads
 * (losing the stamp AND the icon), while ng-hide toggles keep both. A debounced
 * observer gated by a cheap staleness check restores the icons; the MAIN-world
 * round trip only fires when a variable is genuinely unstamped.
 */
const SNH_VAR_REAPPLY_DEBOUNCE_MS = 350;
let snhVarObserver = null;
let snhVarTimer = null;
let snhVarBusy = false;

function varInsightStale() {
  if (!SNH.varInsightOn) return false;
  if (document.querySelector("span.field-actual[ng-switch]:not([data-snh-var])")) return true;
  const stamped = document.querySelectorAll("[data-snh-var]");
  for (const el of stamped) {
    const type = el.getAttribute("data-snh-var-type") || "";
    if (type === "rich_text_label") continue;
    const anchor = varInsightAnchorFor(el, type);
    if (anchor && !anchor.querySelector(":scope > .snh-var-insight")) return true;
  }
  return false;
}

function queueVarReapply() {
  if (snhVarTimer) clearTimeout(snhVarTimer);
  snhVarTimer = setTimeout(runVarReapply, SNH_VAR_REAPPLY_DEBOUNCE_MS);
}

async function runVarReapply() {
  snhVarTimer = null;
  if (!snhVarObserver || !SNH.varInsightOn || snhVarBusy) return;

  // Navigated (SPA) to a different catalog item: the cached logic index no
  // longer matches this form. Tear the icons down rather than show stale data;
  // the user Alt+double-clicks again on the new item. The OFF path is fully
  // synchronous, so this completes before any await.
  const currentItem = currentCatalogItemDefinitionSysId();
  if (
    SNH.varInsightData &&
    isSysId(currentItem) &&
    currentItem !== SNH.varInsightData.itemSysId
  ) {
    SNH.varInsightData = null;
    toggleVariableInsightIcons(false);
    return;
  }

  if (!varInsightStale()) return;
  snhVarBusy = true;
  snhVarObserver.disconnect();
  try {
    await injectVariableInsightIcons();
  } catch (e) {
    /* keep the feature alive across a bad render */
  } finally {
    snhVarBusy = false;
    if (snhVarObserver) {
      snhVarObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }
}

function syncVarInsightObserver() {
  if (!SNH.varInsightOn) {
    if (snhVarTimer) {
      clearTimeout(snhVarTimer);
      snhVarTimer = null;
    }
    if (snhVarObserver) {
      snhVarObserver.disconnect();
      snhVarObserver = null;
    }
    return;
  }
  if (snhVarObserver) return;
  snhVarObserver = new MutationObserver(queueVarReapply);
  snhVarObserver.observe(document.documentElement, { childList: true, subtree: true });
}

// Walk up the table hierarchy to find where the field's dictionary entry lives.
async function resolveDefiningTable(startTable, field) {
  let table = startTable;
  for (let hop = 0; hop < 8 && table; hop++) {
    const dict = await snGet("sys_dictionary", `name=${table}^element=${field}`, "sys_id");
    if (dict.length) return table; // defined directly on this table
    const obj = await snGet("sys_db_object", `name=${table}`, "super_class.name");
    const parent = obj.length && snFieldValue(obj[0], "super_class.name");
    if (!parent) break;
    table = parent;
  }
  return null;
}

function openList(table, query) {
  const url =
    location.origin + "/" + table + "_list.do?sysparm_query=" +
    encodeURIComponent(query);
  chrome.runtime.sendMessage({ type: "OPEN_URL", url });
}

function sysIdFromText(text) {
  if (!text) return null;
  let value = String(text);
  for (let i = 0; i < 3; i++) {
    const workspaceMatch = value.match(
      /\/now\/(?:[^/?#]+\/)*record\/[^/?#]+\/([0-9a-f]{32})(?:[/?#]|$)/i
    );
    if (workspaceMatch) return workspaceMatch[1];

    const match = value.match(/(?:[?&]sys_?id=|sys_?id=)([0-9a-f]{32})/i);
    if (match) return match[1];
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch (e) {
      break;
    }
  }
  return null;
}

async function getCurrentRecordSysId() {
  const localId = sysIdFromText(location.href);
  if (localId) return localId;
  const resp = await chrome.runtime.sendMessage({ type: "GET_SYS_ID" });
  return resp && resp.sysId ? resp.sysId : null;
}

function recordSysIdFromInput(input) {
  const text = String(input || "").trim();
  const sysId = sysIdFromText(text) || (isSysId(text) ? text : null);
  return sysId ? sysId.toLowerCase() : null;
}

function openCustomerUpdatesBySysId(input) {
  const sysId = recordSysIdFromInput(input);
  if (!sysId) {
    throw new Error("Enter a valid 32-character sys_id.");
  }
  openList("sys_update_xml", "category=customer^nameLIKE" + sysId);
}

async function openCurrentPlaybookCustomerUpdates() {
  const sysId = await getCurrentRecordSysId();
  if (!isSysId(sysId)) {
    throw new Error("No playbook sys_id found in the current page.");
  }
  openList(
    "sys_update_xml",
    "category=customer^name=sys_pd_process_definition_" + sysId.toLowerCase()
  );
}

function openPlaybookExecutionsBySysId(input) {
  const sysId = recordSysIdFromInput(input);
  if (!sysId) {
    throw new Error("Enter a valid 32-character sys_id.");
  }
  openList("sys_pd_context", "input_record=" + sysId);
  closePalette();
}

async function openCurrentRecordPlaybookExecutions() {
  const sysId = await getCurrentRecordSysId();
  if (!isSysId(sysId)) {
    showArgInput({
      id: "open-playbook-executions-by-sysid",
      label: "Playbooks",
      description: "Open playbook executions for this record…",
      inputLabel: "Record sys_id or URL",
      placeholder: "record sys_id or ServiceNow record URL",
      keepOpen: true,
      run: openPlaybookExecutionsBySysId,
    });
    return;
  }
  openPlaybookExecutionsBySysId(sysId);
}

async function openLabelTranslations(formTable, field) {
  let table = formTable;
  try {
    const resolved = await resolveDefiningTable(formTable, field);
    if (resolved) table = resolved;
  } catch (e) {
    /* token-enforced GET or network error: fall back to form table */
  }
  openList("sys_documentation", `name=${table}^element=${field}`);
}

function openValueTranslations(formTable, field) {
  // Prefer the current record's sys_id (from the form URL) so we land on the
  // values for THIS record; documentkey + fieldname is table-agnostic.
  const sysId = sysIdFromText(location.href);
  const query =
    sysId && /^[0-9a-f]{32}$/i.test(sysId)
      ? `documentkey=${sysId}^fieldname=${field}`
      : `tablename=${formTable}^fieldname=${field}`;
  openList("sys_translated_text", query);
}

function makeIcon(svg, title, color, onClick) {
  const btn = document.createElement("span");
  btn.className = "snh-trans-icon";
  btn.setAttribute("role", "button");
  btn.tabIndex = 0;
  btn.title = title;
  btn.innerHTML = svg;
  btn.style.cssText =
    "display:inline-flex;align-items:center;vertical-align:middle;" +
    "margin-left:5px;color:" + color + ";cursor:pointer;line-height:0;";
  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  };
  btn.addEventListener("click", handler);
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") handler(e);
  });
  btn.addEventListener("mouseenter", () => (btn.style.opacity = "0.65"));
  btn.addEventListener("mouseleave", () => (btn.style.opacity = "1"));
  return btn;
}

/* =====================================================================
 * WHICH FIELDS CAN HAVE VALUE TRANSLATIONS
 *
 * sys_translated_text only ever holds rows for fields whose dictionary type is
 * translatable. Verified against a live instance: task, incident, sc_req_item
 * and change_request have ZERO such fields between them, so the value icon used
 * to render beside every label on every form and always open an empty list.
 *
 * The lookup is one query per table hierarchy, cached for the page's life, and
 * it is deliberately kept OFF the synchronous toggle path: toggleTranslationIcons
 * still returns its count immediately, renders the globe everywhere, and value
 * icons arrive when the query lands. That keeps the popup's response contract
 * and the re-apply path unchanged.
 * ===================================================================== */

const SNH_TRANSLATABLE_TYPES =
  "translated,translated_text,translated_html,translated_field";

// table -> Set<field> once known, or null when the lookup failed. A missing
// entry means "not fetched yet". Failure maps to null rather than an empty set
// so a broken lookup shows the icon everywhere instead of hiding a working one.
const snhTranslatableFields = new Map();
const snhTranslatablePending = new Map();

// The defining table matters here: a translatable field on a parent shows up on
// a child's form, so the whole chain has to be queried, not just the form table.
async function tableHierarchy(startTable) {
  const chain = [];
  let table = startTable;
  for (let hop = 0; hop < 8 && table; hop++) {
    if (chain.includes(table)) break; // a cyclic super_class would spin forever
    chain.push(table);
    const obj = await snGet("sys_db_object", `name=${table}`, "super_class.name");
    const parent = obj.length && snFieldValue(obj[0], "super_class.name");
    if (!parent) break;
    table = parent;
  }
  return chain;
}

async function fetchTranslatableFields(table) {
  const chain = await tableHierarchy(table);
  if (!chain.length) return new Set();
  const rows = await snGetMany(
    "sys_dictionary",
    `nameIN${chain.join(",")}^internal_typeIN${SNH_TRANSLATABLE_TYPES}`,
    "element",
    500
  );
  const fields = new Set();
  rows.forEach((row) => {
    const element = snFieldValue(row, "element");
    if (element) fields.add(element);
  });
  return fields;
}

function ensureTranslatableFields(table) {
  if (snhTranslatableFields.has(table)) return;
  if (snhTranslatablePending.has(table)) return;
  const pending = fetchTranslatableFields(table)
    .then((fields) => {
      snhTranslatableFields.set(table, fields);
      // One line per table per page. This is a developer tool and its users live
      // in the console; more importantly, the fallback below is indistinguishable
      // from "no filtering happened", so silence here would make a failed lookup
      // impossible to tell apart from stale code.
      console.info(
        `[GlideLens] ${table}: ${fields.size} field(s) can have value translations`,
        fields.size ? Array.from(fields) : ""
      );
    })
    .catch((error) => {
      snhTranslatableFields.set(table, null);
      console.warn(
        `[GlideLens] could not determine translatable fields for ${table}; ` +
          "showing the value icon on every field rather than hiding a working one.",
        error
      );
    })
    .then(() => {
      snhTranslatablePending.delete(table);
      decorateValueIconsFor(table);
    })
    // A throw in the late pass must not surface as an unhandled rejection; the
    // globe is already rendered, so the worst case is a missing value icon.
    .catch(() => {});
  snhTranslatablePending.set(table, pending);
}

function fieldSupportsValueTranslation(table, field) {
  const known = snhTranslatableFields.get(table);
  if (known === undefined) return false; // unresolved; a later pass fills it in
  if (known === null) return true; // lookup failed; don't hide a working icon
  return known.has(field);
}

function makeValueTranslationIcon(table, field) {
  const icon = makeIcon(
    ICON_VALUE,
    `Value translations for ${table}.${field} (sys_translated_text)`,
    "#8a5cd6",
    () => openValueTranslations(table, field)
  );
  // Own class so the late pass can tell a decorated label from a bare one. It
  // keeps .snh-trans-icon too, so teardown and the staleness check still see it.
  icon.classList.add("snh-trans-value");
  return icon;
}

/*
 * Second pass, run when a table's lookup resolves. It mutates the DOM while the
 * re-apply observer is live, so it disconnects first for the same reason
 * runQueuedReapply() does. The staleness check cannot be tripped into a loop by
 * this: it asks for any .snh-trans-icon, and the globe is already there.
 */
function decorateValueIconsFor(table) {
  if (!SNH.transIconsOn) return; // toggled off while the query was in flight

  if (snhToggleObserver) snhToggleObserver.disconnect();
  try {
    const add = (entry) => {
      if (!entry || entry.table !== table || !entry.field || !entry.target) return;
      if (!fieldSupportsValueTranslation(entry.table, entry.field)) return;
      if (entry.target.querySelector(":scope > .snh-trans-value")) return;
      entry.target.appendChild(makeValueTranslationIcon(entry.table, entry.field));
    };
    getClassicFields().forEach(add);
    getWorkspaceFields().forEach(add);
  } finally {
    if (snhToggleObserver) observeForReapply();
  }
}

function toggleTranslationIcons(force) {
  const turnOn = typeof force === "boolean" ? force : !SNH.transIconsOn;
  SNH.transIconsOn = turnOn;

  removeSnhElements(".snh-trans-icon");
  if (!turnOn) {
    syncToggleObserver();
    return 0;
  }

  let count = 0;
  const tables = new Set();
  const appendIcons = ({ table, field, target }) => {
    if (!table || !field || !target) return;
    // The globe is unconditional: sys_documentation is keyed by table.field and
    // any field can have a translated LABEL, whatever its type.
    target.appendChild(
      makeIcon(
        ICON_DOC,
        `Label translations for ${table}.${field} (sys_documentation)`,
        "#3b7ddd",
        () => openLabelTranslations(table, field)
      )
    );
    if (fieldSupportsValueTranslation(table, field)) {
      target.appendChild(makeValueTranslationIcon(table, field));
    }
    tables.add(table);
    count++;
  };

  getClassicFields().forEach(appendIcons);
  getWorkspaceFields().forEach(appendIcons);
  // No-ops for tables already resolved, so a re-apply costs nothing.
  tables.forEach(ensureTranslatableFields);
  syncToggleObserver();
  return count;
}

/* =====================================================================
 * TOGGLE PERSISTENCE
 *
 * Classic forms re-render on section switches, related-list refreshes and
 * UI Policy runs, which throws away our badges and icons. A MutationObserver
 * puts them back. Three things keep that from becoming a loop or a tax on
 * every keystroke:
 *
 *  1. Re-applying a toggle MUTATES the DOM, so the observer would see its own
 *     writes and re-fire forever. We disconnect around the re-apply;
 *     disconnect() also empties the pending record queue, so nothing our own
 *     writes produced survives to the next observe().
 *  2. A re-render arrives as a burst of mutations, not one, so the re-apply is
 *     debounced on the trailing edge.
 *  3. Both toggles are a full teardown + rescan (see toggleFieldNames), which
 *     is far too heavy to run per burst. We first ask a cheap question — is any
 *     classic label missing its decoration? — and bail when the answer is no.
 *
 * CLASSIC UI ONLY. getWorkspaceFields() walks every element in every shadow
 * root; running that against a Workspace SPA's mutation volume would cost more
 * than the feature is worth. Workspace forms still decorate on demand, they
 * just don't survive a re-render yet.
 * ===================================================================== */

const SNH_REAPPLY_DEBOUNCE_MS = 200;
let snhToggleObserver = null;
let snhReapplyTimer = null;

function anyToggleOn() {
  return SNH.fieldNamesOn || SNH.transIconsOn;
}

/*
 * Cheap staleness check. Deliberately driven by getClassicFields() rather than
 * raw label counts: it returns exactly the set the toggles decorate, so "every
 * field has its decoration" is reachable. Comparing counts instead would let a
 * label the parser skips — or a badge added by the workspace pass — wedge this
 * permanently stale and rebuild on a 200ms loop forever.
 */
function classicDecorationStale() {
  const fields = getClassicFields();
  if (!fields.length) return false;
  return fields.some(
    ({ target }) =>
      (SNH.fieldNamesOn && !target.querySelector(":scope > .snh-fieldname")) ||
      (SNH.transIconsOn && !target.querySelector(":scope > .snh-trans-icon"))
  );
}

function reapplyToggles() {
  // Honour both flags: a re-render wipes whatever was on, so restore all of it.
  if (SNH.fieldNamesOn) toggleFieldNames(true);
  if (SNH.transIconsOn) toggleTranslationIcons(true);
}

function runQueuedReapply() {
  snhReapplyTimer = null;
  if (!snhToggleObserver || !anyToggleOn()) return;
  if (!classicDecorationStale()) return;

  snhToggleObserver.disconnect();
  try {
    reapplyToggles();
  } finally {
    // Re-arm even if a rebuild threw, otherwise one bad form kills the feature
    // for the rest of the page's life. Null-guarded because this runs in a
    // finally: reapplyToggles() re-enters syncToggleObserver(), which tears the
    // observer down when it sees no classic fields. That can't happen today
    // (the rebuild is synchronous, so the DOM can't change under it after the
    // staleness check found fields), but a finally is the wrong place to
    // discover it if that ever stops being true.
    if (snhToggleObserver) observeForReapply();
  }
}

function queueReapply() {
  if (snhReapplyTimer) clearTimeout(snhReapplyTimer);
  snhReapplyTimer = setTimeout(runQueuedReapply, SNH_REAPPLY_DEBOUNCE_MS);
}

function observeForReapply() {
  // childList + subtree only. Attribute and character-data records would
  // multiply the volume without telling us anything the staleness check
  // doesn't already answer.
  snhToggleObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

/*
 * Called from both toggles, on the on AND off paths. Starts the observer lazily
 * so instance pages with no toggle in use never pay for one, and tears it down
 * once the last toggle goes off.
 */
function syncToggleObserver() {
  const shouldRun = anyToggleOn() && getClassicFields().length > 0;

  if (!shouldRun) {
    if (snhReapplyTimer) {
      clearTimeout(snhReapplyTimer);
      snhReapplyTimer = null;
    }
    if (snhToggleObserver) {
      snhToggleObserver.disconnect();
      snhToggleObserver = null;
    }
    return;
  }

  // Already running — including the re-entrant call from reapplyToggles(),
  // where we are mid-rebuild with the observer deliberately disconnected and
  // runQueuedReapply() owns re-arming it.
  if (snhToggleObserver) return;

  snhToggleObserver = new MutationObserver(queueReapply);
  observeForReapply();
}

/*
 * Every branch here answers synchronously, so this listener must not return
 * true. `return true` means "a reply is coming later, hold the channel open",
 * and for the branches that never reply it left the sender's promise unsettled
 * until Chrome tore the port down. Answer in each branch, return false once.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "TOGGLE_FIELD_NAMES") {
    const count = toggleFieldNames(msg.force);
    sendResponse({ ok: true, count, on: SNH.fieldNamesOn });
    return false;
  }
  if (msg && msg.type === "TOGGLE_TRANSLATIONS") {
    const count = toggleTranslationIcons(msg.force);
    sendResponse({ ok: true, count, on: SNH.transIconsOn });
    return false;
  }
  if (msg && msg.type === "TOGGLE_PALETTE") {
    // Only the top frame owns the palette to avoid duplicate overlays. Every
    // frame still answers, so the sender is never left waiting on a port.
    const owned = window === window.top;
    if (owned) togglePalette();
    sendResponse({ ok: true, owned });
    return false;
  }
  if (msg && msg.type === "DISCOVER_FRAME" && msg.requestId) {
    // The service worker cannot safely use executeScript({ allFrames: true }):
    // one uninjectionable ServiceNow helper frame can leave that promise
    // pending forever. Content scripts already run in every eligible frame, so
    // announce this frame back and let the worker target each responder by id.
    chrome.runtime.sendMessage({
      type: "FRAME_AVAILABLE",
      requestId: msg.requestId,
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === "PREFILL_PROGRESS") {
    const shown = window === window.top;
    if (shown) showToast(msg.message || "Filling portal form…", false, 6000);
    sendResponse({ ok: true, shown });
    return false;
  }
  return false;
});

function togglePalette() {
  paletteHost ? closePalette() : openPalette();
}

/* =====================================================================
 * COMMAND PALETTE
 * Rendered into a shadow root so SN styles can't bleed in.
 * Only mounted in the top frame (shell); messages dispatched down to
 * gsft_main frames for DOM-touching commands via chrome.runtime.sendMessage.
 * ===================================================================== */

const DEV_LINKS = [
  ["Background Scripts",  "/sys.scripts.modern.do"],
  ["Script Includes",     "/sys_script_include_list.do"],
  ["Business Rules",      "/sys_script_list.do"],
  ["Client Scripts",      "/sys_script_client_list.do"],
  ["UI Actions",          "/sys_ui_action_list.do"],
  ["System Logs",         "/syslog_list.do?sysparm_query=ORDERBYDESCsys_created_on"],
  ["Update Sets",         "/sys_update_set_list.do"],
  ["Scheduled Jobs",      "/sysauto_script_list.do"],
  ["Fix Scripts",         "/sys_script_fix_list.do"],
  ["Sys Properties",      "/sys_properties_list.do"],
  ["REST Explorer",       "/$restapi.do"],
  ["Flow Designer",       "/$flow-designer.do"],
];

function buildCommands() {
  const navTo = (path) =>
    chrome.runtime.sendMessage({ type: "OPEN_URL", url: location.origin + path });
  const debugTimeline = globalThis.SNDebugTimelineUI;
  const debugTimelineRecording =
    debugTimeline &&
    typeof debugTimeline.isRecording === "function" &&
    debugTimeline.isRecording();
  const isPlaybookDefinitionPage = decodedVariants(location.href).some(
    (url) => url.includes("sys_pd_process_definition")
  );

  // "Toggle field names" was retired in 0.10.0 — snUtils covers it. The palette
  // command and the Alt+Shift+F manifest command are both gone, so nothing
  // dispatches TOGGLE_FIELD_NAMES; toggleFieldNames() and its message handler
  // are kept so the feature can be re-listed rather than rewritten.
  const cmds = [
    {
      id: "toggle-translations",
      label: "Translations",
      description: "Show or hide field translation controls",
      keywords: ["globe", "i18n", "l10n", "translate", "sys_documentation", "sys_translated_text"],
      group: "Tools",
      run: () => broadcastFrameCommand("TOGGLE_TRANSLATIONS"),
    },
    ...(debugTimelineRecording
      ? [{
          id: "stop-debug-timeline",
          favoriteKey: "debug-timeline",
          label: "Debug Timeline",
          description: "Stop recording and view captured activity",
          keywords: ["debug", "timeline", "trace", "record", "g_form", "glideajax", "error"],
          group: "Tools",
          keepOpen: true,
          run: async () => {
            if (!debugTimeline || typeof debugTimeline.stopAndView !== "function") {
              throw new Error("Debug Timeline UI is unavailable.");
            }
            await debugTimeline.stopAndView();
            closePalette();
          },
        }]
      : [{
          id: "start-debug-timeline",
          favoriteKey: "debug-timeline",
          label: "Debug Timeline",
          description: "Start recording form activity, GlideAjax calls, and errors",
          keywords: ["debug", "timeline", "trace", "record", "g_form", "glideajax", "error"],
          group: "Tools",
          keepOpen: true,
          run: async () => {
            if (!debugTimeline || typeof debugTimeline.start !== "function") {
              throw new Error("Debug Timeline UI is unavailable.");
            }
            showToast("Starting Debug Timeline…", false, 6000);
            const response = await debugTimeline.start();
            showToast(
              "Recording across " + (response.frameCount || 1) + " frame" +
                ((response.frameCount || 1) === 1 ? "" : "s"),
              false,
              1200
            );
            setTimeout(closePalette, 450);
          },
        }]),
    {
      id: "copy-sysid",
      label: "sys_id",
      description: "Copy the current record sys_id",
      keywords: ["copy", "sys_id", "record", "id", "guid"],
      group: "Record",
      keepOpen: true,
      run: async () => {
        const id = await getCurrentRecordSysId();
        if (id) {
          try {
            await copyText(id);
            showToast("Copied " + id);
          } catch (e) {
            showCopyFallback(id);
          }
        } else {
          showToast("No record sys_id found", true);
        }
      },
    },
    {
      id: "record-search",
      label: "Record Lens",
      description: "Search verified records across readable tables",
      keywords: [
        "record", "search", "find", "table api", "sys_id", "number",
        "name", "email", "incident", "catalog item",
      ],
      group: "Record",
      run: openRecordSearch,
    },
    {
      id: "open-playbook-executions",
      label: "Playbooks",
      description: "Open playbook executions for this record",
      keywords: ["playbook", "execution", "executions", "process automation", "pad", "sys_pd_context", "input_record"],
      group: "Record",
      keepOpen: true,
      run: openCurrentRecordPlaybookExecutions,
    },
    ...(isPlaybookDefinitionPage
      ? [{
          id: "open-current-playbook-customer-updates",
          label: "Playbook Updates",
          description: "Open captured updates for this playbook activity",
          keywords: ["playbook", "customer update", "update xml", "sys_update_xml", "process definition"],
          group: "Record",
          keepOpen: true,
          run: openCurrentPlaybookCustomerUpdates,
        }]
      : []),
    {
      id: "open-customer-updates-by-sysid",
      label: "Customer Updates",
      description: "Open captured customer updates by sys_id…",
      keywords: ["customer update", "update xml", "sys_update_xml", "sys_id", "record"],
      group: "Record",
      input: true,
      inputLabel: "Record sys_id or URL",
      placeholder: "record sys_id or ServiceNow record URL",
      keepOpen: true,
      run: openCustomerUpdatesBySysId,
    },
    {
      id: "prefill-variables",
      label: "Variable Prefill",
      description: "Copy catalog-variable values from another ticket…",
      keywords: ["variable", "prefill", "copy", "ritm", "sctask", "req", "catalog", "portal", "clone"],
      group: "Catalog",
      input: true,
      inputLabel: "Source ticket or sys_id",
      placeholder: "RITM/SCTASK/REQ/task number or submitted record sys_id",
      keepOpen: true,
      run: prefillPortalVariablesFromTicket,
    },
    // "Copy portal variable debug info" was unlisted in 0.10.0. It reports the
    // last prefill run's internals, which is a diagnostic for developing that
    // feature rather than something to hand a user, and it says nothing useful
    // unless a prefill has just run. copyPortalVariableDebugInfo() and the
    // GET_PORTAL_VARIABLE_DEBUG handler stay for debugging prefill by hand.
    {
      id: "show-variable-values",
      label: "Variable Values",
      description: "Inspect current catalog-variable values",
      keywords: ["variable", "value", "values", "form", "hidden", "catalog", "ui policy", "client script", "variable set", "sc_cat_item"],
      group: "Catalog",
      keepOpen: true,
      run: showVariableValues,
    },
    {
      id: "catalog-affecting-logic",
      label: "Catalog Logic",
      description: "Inspect catalog client scripts and UI policies",
      keywords: ["catalog", "client script", "ui policy", "onchange", "onload", "onsubmit", "affects", "debug", "logic", "catalog_script_client", "catalog_ui_policy"],
      group: "Catalog",
      keepOpen: true,
      run: showCatalogInsight,
    },
    {
      id: "toggle-variable-insight",
      label: "Variable Insight",
      description: "Show or hide per-variable insight icons",
      keywords: ["variable", "icon", "client script", "ui policy", "onchange", "action", "affects", "catalog", "insight", "double click", "alt"],
      group: "Catalog",
      hint: "Alt+double-click",
      keepOpen: true,
      run: () => broadcastFrameCommand("TOGGLE_VARIABLE_INSIGHT"),
    },
    {
      id: "code-search",
      label: "Code Search",
      description: "Search verified code and configuration…",
      keywords: [
        "code", "search", "grep", "find", "source", "script", "ref qual",
        "reference qualifier", "dictionary", "transform", "variable",
        "script include", "business rule",
      ],
      group: "Tools",
      input: true,
      inputLabel: "Search term",
      placeholder: "text to find; optional table:<name>",
      /* No keepOpen: the palette closes on Enter and the search runs on into
       * its own panel, rather than sitting on top of the results. */
      run: (arg) => {
        const term = (arg || "").trim();
        if (!term) return;
        return runCodeSearch(term);
      },
    },
    {
      id: "refresh-code-search-coverage",
      label: "Search Sources",
      description: "Refresh available Code Search sources",
      keywords: [
        "code search", "coverage", "index", "sources", "stale", "cache",
        "refresh", "recheck", "search group", "sn_codesearch", "missing hits",
      ],
      group: "Tools",
      keepOpen: true,
      run: refreshCodeSearchCoverage,
    },
    {
      id: "open-table-list",
      label: "Table List",
      description: "Open a list for a named table…",
      keywords: ["navigate", "jump", "list", "table", "open"],
      group: "Navigate",
      input: true,
      inputLabel: "Table name",
      placeholder: "table name (e.g. incident)",
      run: (arg) => {
        if (!arg) return;
        navTo("/" + arg.trim() + "_list.do");
      },
    },
    {
      id: "open-table-new",
      label: "New Record",
      description: "Open a new record form for a named table…",
      keywords: ["new", "create", "insert", "table"],
      group: "Navigate",
      input: true,
      inputLabel: "Table name",
      placeholder: "table name (e.g. incident)",
      run: (arg) => {
        if (!arg) return;
        navTo("/" + arg.trim() + ".do?sys_id=-1");
      },
    },
    ...DEV_LINKS.map(([label, path]) => ({
      id: "devlink-" + path,
      label,
      description: "Open " + label,
      keywords: [label.toLowerCase(), "dev", "link"],
      group: "Dev Links",
      run: () => navTo(path),
    })),
  ];
  return validatePaletteCommands(cmds);
}

/* =====================================================================
 * RECORD SEARCH
 *
 * The engine and panel are lazy because record lookup is occasional and needs
 * its own UI with separate table and term inputs. Reads use the single
 * token-bearing-frame transport in background.js, never the all-frame helper.
 * ===================================================================== */

let recordSearchSession = null;

async function ensureRecordSearchLoaded() {
  if (globalThis.SNRecordSearch && globalThis.SNRecordSearchUI) return true;
  const response = await chrome.runtime.sendMessage({ type: "INJECT_RECORD_SEARCH" });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || "Couldn't load Record Search.");
  }
  return Boolean(globalThis.SNRecordSearch && globalThis.SNRecordSearchUI);
}

async function openRecordSearch() {
  await ensureRecordSearchLoaded();
  const engine = globalThis.SNRecordSearch;
  const ui = globalThis.SNRecordSearchUI;
  if (!recordSearchSession) recordSearchSession = engine.createSessionTracker();

  /* URL-only detection is deliberately conservative. The candidate is still
   * resolved through sys_db_object before it becomes selectable; no workspace
   * route discovery or guessed schema is involved. */
  const pageContext = recordContextFromText(location.href);
  const initialTable = pageContext.table && /^[a-z][a-z0-9_]*$/.test(pageContext.table)
    ? pageContext.table.toLowerCase()
    : null;

  const runCurrent = async (operation) => {
    const sessionId = recordSearchSession.next();
    const isStale = () => !recordSearchSession.isCurrent(sessionId);
    return operation(isStale);
  };

  ui.open({
    initialTable,
    onCancel: () => recordSearchSession.cancel(),
    onFindTables: (input) => runCurrent(() => engine.findTables(input)),
    onResolveTable: (table) => runCurrent((isStale) => engine.resolveTableInfo(table, {
      origin: location.origin,
      shouldStop: isStale,
    })),
    onSearch: async (input) => {
      const parsed = engine.parseSearch(input && input.table, input && input.term);
      if (!parsed.ok) {
        const error = new Error(parsed.error);
        error.code = parsed.code || "validation";
        throw error;
      }
      return runCurrent((isStale) => engine.runSearch(parsed, {
        origin: location.origin,
        shouldStop: isStale,
        fields: input && input.fields,
      }));
    },
  });
}

/* =====================================================================
 * CODE SEARCH
 *
 * Orchestration only — the engine is code_search.js and the panel is
 * code_search_ui.js, both injected on demand rather than shipped in
 * content_scripts (they are the largest scripts here, for a feature used
 * occasionally).
 * ===================================================================== */

let codeSearchSession = null;

async function ensureCodeSearchLoaded() {
  if (globalThis.SNCodeSearch && globalThis.SNCodeSearchUI) return true;
  const response = await chrome.runtime.sendMessage({ type: "INJECT_CODE_SEARCH" });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || "Couldn't load code search.");
  }
  return Boolean(globalThis.SNCodeSearch && globalThis.SNCodeSearchUI);
}

async function runCodeSearch(rawTerm) {
  try {
    await ensureCodeSearchLoaded();
  } catch (error) {
    showToast(String(error.message || error), true);
    return;
  }

  const engine = globalThis.SNCodeSearch;
  const ui = globalThis.SNCodeSearchUI;

  const parsed = engine.parseQuery(rawTerm);
  if (!parsed.ok) {
    showToast(parsed.error, true, 7000);
    return;
  }

  /* One tracker for the page, so a second search invalidates the first rather
   * than racing it into the panel. */
  if (!codeSearchSession) codeSearchSession = engine.createSessionTracker();
  const sessionId = codeSearchSession.next();
  const isStale = () => !codeSearchSession.isCurrent(sessionId);

  ui.open({
    term: parsed.term,
    tables: parsed.filters.tables,
    onCancel: () => codeSearchSession.cancel(),
  });

  try {
    /* The probe is per-origin and cached for a week; a failure means "unknown",
     * so the search still runs against everything the registry declares. The
     * coverage map is the same deal for Tier 1: unreadable config means the
     * instance's own code search is unavailable here, which is a normal state
     * and not an error — the adapters cover the ground either way. */
    const [probeResult, coverage] = await Promise.all([
      engine.loadProbe(location.origin),
      engine.loadCoverage(location.origin),
    ]);
    if (isStale()) return;

    /*
     * The panel renders what each source hands it, so overlap has to be
     * removed on the way IN — deduping the final result would leave the
     * already-painted duplicates on screen.
     *
     * Tier 1 finishes before the adapters start, so first-writer-wins here
     * means the instance's own hit is kept and the adapter's copy of the same
     * record is dropped. Overlap is expected wherever a table is only
     * partially covered: sys_ui_action is indexed as name,script, so its
     * adapter still runs for `condition` and re-finds the `script` hits.
     */
    const seenHits = Object.create(null);
    const onSource = (summary, hits) => {
      if (isStale()) return;
      const fresh = (hits || []).filter((hit) => {
        const key = engine.dedupeKey(hit.table, hit.sysId, hit.field);
        if (seenHits[key]) return false;
        seenHits[key] = true;
        return true;
      });
      ui.addSource(Object.assign({}, summary, { count: fresh.length }), fresh);
    };

    /* Tier 1 first, because what it managed to search decides which adapters
     * are redundant. It streams its own sources into the panel as it goes. */
    const tier1 = await engine.runApiSearch(parsed, {
      coverage,
      shouldStop: isStale,
      onSource,
    });
    if (isStale()) return;

    /* Tier 1 being unavailable is routine, not an error — but it has to be
     * SAID. Silence would leave the impression the instance's own index was
     * consulted and came back empty. */
    if (!tier1.available) {
      onSource(
        {
          id: "instance-search",
          label: "Instance code search",
          table: "",
          kind: "instance",
          status: engine.SOURCE_STATUS.ABSENT,
          count: 0,
          missingFields: [],
          unverified: false,
          error: tier1.reason || "",
        },
        []
      );
    }

    const result = await engine.runSearch(parsed, {
      probe: probeResult,
      skipTargets: engine.adaptersCoveredBy(tier1, coverage, engine.SEARCH_TARGETS),
      shouldStop: isStale,
      onSource,
    });
    if (isStale()) return;

    ui.complete(result);
  } catch (error) {
    if (isStale()) return;
    ui.showError(String(error.message || error));
  }
}

/*
 * What code search can reach is cached per origin for a week — the dictionary
 * probe and the instance's own coverage map both. That is right for a search
 * run many times a day and wrong the moment someone adds a table to a search
 * group: until this command existed, the only way out was clearing extension
 * storage by hand.
 *
 * The symptom is missing hits, not an error, so the command is named after the
 * symptom rather than after the caches it happens to clear.
 */
async function refreshCodeSearchCoverage() {
  try {
    await ensureCodeSearchLoaded();
  } catch (error) {
    showToast(String(error.message || error), true);
    return;
  }

  const engine = globalThis.SNCodeSearch;
  showToast("Rechecking code search coverage…", false, 30000);
  try {
    const result = await engine.refreshCapabilities(location.origin);
    showToast(result.change.summary, !result.ok, result.ok ? 9000 : 11000);
  } catch (error) {
    showToast(
      "Couldn't recheck coverage: " + String(error.message || error),
      true,
      9000
    );
  }
}

const PALETTE_GROUP_ORDER = [
  "Favorite",
  "Tools",
  "Record",
  "Catalog",
  "Navigate",
  "Dev Links",
];

function paletteFavoriteKey(cmd) {
  return cmd && (cmd.favoriteKey || cmd.id);
}

function normalizePaletteFavoriteKey(value) {
  if (value === "start-debug-timeline" || value === "stop-debug-timeline") {
    return "debug-timeline";
  }
  return value;
}

function validatePaletteCommands(cmds) {
  const labels = new Map();
  for (const cmd of cmds) {
    const label = String(cmd && cmd.label || "").trim();
    const description = String(cmd && cmd.description || "").trim();
    if (!cmd || !cmd.id || !label || !description) {
      throw new Error("Every palette command needs an id, label, and description.");
    }
    if (cmd.input && !String(cmd.inputLabel || "").trim()) {
      throw new Error("Input command " + cmd.id + " needs an explicit inputLabel.");
    }
    const key = label.toLowerCase();
    if (labels.has(key)) {
      throw new Error(
        "Duplicate palette label \"" + label + "\" on " + labels.get(key) + " and " + cmd.id + "."
      );
    }
    labels.set(key, cmd.id);
  }
  return cmds;
}

/*
 * How well a command answers the query, lowest is best.
 *
 * Descriptions and keywords are searched as well as labels, so a command's own
 * complete label can also match some OTHER command through that command's
 * description. Without this, ordering was declaration order alone, and typing
 * "Variable Values" made Variable Prefill the active row -- its description
 * reads "Copy catalog-variable values from another ticket", which contains the
 * whole query, and it is declared first. Enter then ran the wrong command.
 * A label match must outrank a description or keyword match.
 */
function paletteMatchTier(cmd, query) {
  const label = String(cmd && cmd.label || "").toLowerCase();
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.includes(query)) return 2;
  return 3;
}

/*
 * Groups must stay CONTIGUOUS: the renderer opens a new group header whenever
 * cmd.group changes as it walks this list, so interleaving groups by relevance
 * would repeat headers. Rank each group by its best-matching member, keep the
 * declared PALETTE_GROUP_ORDER as the tiebreak between equally good groups, and
 * sort within a group by tier and then declaration order.
 */
function orderPaletteCommands(cmds, query) {
  const q = String(query || "").trim().toLowerCase();
  const ranks = new Map(PALETTE_GROUP_ORDER.map((group, index) => [group, index]));
  const groupRank = (cmd) => (ranks.has(cmd.group) ? ranks.get(cmd.group) : ranks.size);
  const entries = cmds.map((cmd, index) => ({
    cmd,
    index,
    tier: q ? paletteMatchTier(cmd, q) : 0,
  }));

  const bestTier = new Map();
  for (const entry of entries) {
    const current = bestTier.get(entry.cmd.group);
    if (current === undefined || entry.tier < current) bestTier.set(entry.cmd.group, entry.tier);
  }

  return entries
    .sort((left, right) => (
      bestTier.get(left.cmd.group) - bestTier.get(right.cmd.group) ||
      groupRank(left.cmd) - groupRank(right.cmd) ||
      left.tier - right.tier ||
      left.index - right.index
    ))
    .map((entry) => entry.cmd);
}

function paletteCommandMatches(cmd, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  return [cmd.label, cmd.description, ...(cmd.keywords || [])]
    .some((value) => String(value || "").toLowerCase().includes(q));
}

function preparePaletteCommands(cmds, query, favoriteKey) {
  const q = String(query || "").trim().toLowerCase();
  const matches = orderPaletteCommands(cmds.filter((cmd) => paletteCommandMatches(cmd, q)), q);
  if (!q && favoriteKey) {
    const favorite = cmds.find((cmd) => paletteFavoriteKey(cmd) === favoriteKey);
    if (favorite) {
      return [
        Object.assign({}, favorite, { group: "Favorite" }),
        ...matches.filter((cmd) => paletteFavoriteKey(cmd) !== favoriteKey),
      ];
    }
  }
  return matches;
}

function paletteOptionId(cmd) {
  return "snh-command-option-" + String(cmd.id).replace(/[^a-z0-9_-]+/gi, "-");
}

/* ---- Palette state ---- */
let paletteHost = null;
let paletteShadow = null;
let paletteInput = null;
let paletteList = null;
let paletteToast = null;
let paletteCount = null;
let paletteFavoriteButton = null;
let paletteActiveShortcut = null;
let palettePreviousFocus = null;
let palettePosition = null;
let paletteDragCleanup = null;
let activeIndex = 0;
let filteredCmds = [];
let activeInputCmd = null; // command waiting for a text argument
const PALETTE_FAVORITE_STORAGE_KEY = "paletteFavoriteCommandId";
let paletteFavoriteCommandId = null;

const PALETTE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  :host{
    all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    /* Two-accent system: teal = structure/selection/focus, pink = brand/pinned. */
    --teal:#31d4c4;
    --pink:#ff6fae;
    --palette-bg:#181a24;
    --palette-input:#10121a;
    --palette-raised:#252938;
    --palette-border:#4a5066;
    --palette-border-subtle:#343a4d;
    --palette-text:#f5f7ff;
    --palette-body:#d8dbea;
    --palette-secondary:#b4bbcc;
    --palette-muted:#a3aabe;
    --palette-placeholder:#929aae;
    --palette-accent:var(--teal);
    --palette-favorite:var(--pink);
    --palette-selected:#34385a;
    --palette-hover:#262a3a;
  }
  #overlay{
    position:fixed;inset:0;z-index:2147483647;
    background:rgba(10,10,18,.18);display:flex;
    align-items:flex-start;justify-content:center;padding:clamp(48px,10vh,112px) 16px 24px;
  }
  #box{
    position:relative;background:var(--palette-bg);border:1px solid var(--palette-border);border-radius:12px;
    width:600px;max-width:calc(100vw - 20px);
    box-shadow:0 28px 80px rgba(0,0,0,.65);overflow:hidden;
  }
  #palette-head{
    display:flex;align-items:center;justify-content:space-between;
    padding:14px 16px 10px;gap:16px;cursor:grab;
    user-select:none;touch-action:none;
  }
  #palette-head.dragging{cursor:grabbing}
  #palette-kicker{
    color:var(--pink);font-size:10px;font-weight:800;letter-spacing:.12em;
    line-height:1.2;text-transform:uppercase;
  }
  #palette-title{
    color:var(--palette-text);font-size:15px;font-weight:650;line-height:1.35;margin-top:2px;
  }
  #palette-title-row{display:flex;align-items:center;gap:5px}
  #drag-indicator{
    display:block;width:18px;height:18px;flex:0 0 18px;
    opacity:.88;transition:opacity .08s;
  }
  #palette-head:hover #drag-indicator,#palette-head.dragging #drag-indicator{opacity:1}
  #palette-drag-hint{color:var(--palette-muted);font-size:10px;line-height:1.35;margin-top:2px}
  #shortcut-key{
    display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:26px;
    padding:0 8px;border:1px solid var(--palette-border);border-bottom-color:#687087;border-radius:6px;
    background:var(--palette-raised);color:var(--palette-body);font:12px ui-monospace,SFMono-Regular,Consolas,monospace;
    box-shadow:0 1px 0 rgba(255,255,255,.06);
  }
  #search-wrap{
    display:flex;align-items:center;margin:0 12px 10px;padding:0 4px 0 12px;
    min-height:42px;border:1px solid var(--palette-border);border-radius:8px;
    background:var(--palette-input);gap:10px;
  }
  #search-wrap:focus-within{
    border-color:var(--teal);box-shadow:0 0 0 3px color-mix(in srgb, var(--teal) 22%, transparent);
  }
  #search{
    flex:1;background:transparent;border:none;outline:none;
    min-width:0;color:var(--palette-text);font-size:14px;caret-color:var(--palette-accent);
  }
  #search::placeholder{color:var(--palette-placeholder)}
  #kbd-hint{color:var(--palette-muted);font-size:10px;white-space:nowrap;padding:0 7px}
  #results{
    max-height:min(420px,55vh);overflow-y:auto;padding:4px 8px 8px;
    scrollbar-color:#596078 transparent;scrollbar-width:thin;
  }
  .group-label{
    display:flex;align-items:center;gap:11px;
    color:color-mix(in srgb, var(--teal) 74%, #d2d6e2);font-size:11px;font-weight:800;
    letter-spacing:.14em;text-transform:uppercase;padding:13px 10px 6px;
  }
  .group-label::after{
    content:"";flex:1;height:1px;
    background:linear-gradient(90deg, color-mix(in srgb, var(--teal) 34%, transparent), transparent);
  }
  .command-group{display:block}
  .cmd-row{display:block}
  .cmd{
    position:relative;display:flex;align-items:center;height:42px;padding:4px 58px 4px 10px;
    cursor:pointer;color:var(--palette-body);font-size:13px;border:1px solid transparent;
    border-radius:7px;transition:background .08s,border-color .08s,color .08s;
  }
  .cmd.active{
    background:color-mix(in srgb, var(--teal) 12%, var(--palette-selected));
    border-color:color-mix(in srgb, var(--teal) 42%, var(--palette-border));
    color:#fff;box-shadow:inset 3px 0 0 var(--palette-accent);
  }
  .cmd:hover:not(.active){background:var(--palette-hover)}
  .cmd-content{
    display:grid;grid-template-columns:minmax(94px,132px) minmax(0,1fr);
    align-items:center;gap:10px;width:100%;min-width:0;
  }
  .cmd-label{
    display:block;justify-self:start;width:max-content;max-width:100%;min-width:0;
    padding:3px 7px;border:1px solid #4d5570;border-radius:5px;
    background:#2b3041;color:#f2f5ff;font-size:11px;font-weight:700;line-height:15px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;
  }
  .cmd.active .cmd-label{
    border-color:color-mix(in srgb, var(--teal) 58%, #4d5570);
    background:color-mix(in srgb, var(--teal) 13%, #2b3041);color:#fff;
  }
  .cmd-description{
    min-width:0;color:var(--palette-secondary);font-size:12px;line-height:15px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .cmd.active .cmd-description{
    display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;
    white-space:normal;color:#f4f7ff;overflow:hidden;
  }
  .cmd-input-row{
    display:flex;flex-direction:column;align-items:stretch;padding:14px 16px 16px;
    border-top:1px solid var(--palette-border-subtle);gap:8px;
  }
  .cmd-input-label{color:var(--palette-accent);font-size:11px;font-weight:650}
  #arg-input{
    width:100%;background:var(--palette-input);border:1px solid var(--palette-border);border-radius:7px;outline:none;
    color:var(--palette-text);font-size:13px;padding:9px 10px;
  }
  #arg-input:focus{border-color:var(--teal);box-shadow:0 0 0 3px color-mix(in srgb, var(--teal) 22%, transparent)}
  #arg-input::placeholder{color:var(--palette-placeholder)}
  #toast{
    display:none;padding:10px 16px;font-size:12px;
    border-top:1px solid var(--palette-border-subtle);color:#a8e6b8;
  }
  #toast.err{color:#ff9d9d}
  #empty{padding:34px 16px;color:var(--palette-secondary);font-size:13px;text-align:center}
  #palette-footer{
    display:flex;align-items:center;justify-content:space-between;gap:16px;
    min-height:38px;padding:8px 16px;border-top:1px solid var(--palette-border-subtle);
    color:var(--palette-muted);font-size:11px;
  }
  #active-shortcut{
    color:var(--palette-secondary);font:10px ui-monospace,SFMono-Regular,Consolas,monospace;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  #favorite-command{
    position:absolute;z-index:4;right:25px;display:inline-flex;align-items:center;justify-content:center;
    width:28px;height:28px;transform:translateY(-50%);border:1px solid transparent;border-radius:6px;
    background:color-mix(in srgb, var(--palette-raised) 88%, transparent);color:var(--palette-muted);
    cursor:pointer;font-size:17px;line-height:1;
  }
  #favorite-command:hover,#favorite-command:focus{
    border-color:var(--palette-favorite);color:var(--palette-favorite);outline:none;
  }
  #favorite-command[aria-pressed="true"]{color:var(--palette-favorite)}
  #favorite-command:disabled{opacity:.45;cursor:default;border-color:var(--palette-border);color:var(--palette-muted)}
  #favorite-command[hidden]{display:none}
  #key-help{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end}
  #key-help span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
  kbd{
    min-width:22px;padding:2px 5px;border:1px solid var(--palette-border);border-radius:4px;
    background:var(--palette-raised);color:#c1c7d8;text-align:center;
    font:9px ui-monospace,SFMono-Regular,Consolas,monospace;
  }
  @media (max-width:520px){
    #overlay{padding:24px 10px}
    #palette-footer{align-items:flex-start;flex-direction:column;gap:6px}
    #key-help{justify-content:flex-start}
    #results{max-height:58vh}
    .cmd-content{grid-template-columns:minmax(86px,108px) minmax(0,1fr);gap:7px}
  }
`;

function showToast(msg, isErr, durationMs) {
  if (!paletteToast) return;
  paletteToast.textContent = msg;
  paletteToast.className = isErr ? "err" : "";
  paletteToast.style.display = "block";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    if (paletteToast) paletteToast.style.display = "none";
  }, durationMs || 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw e;
    return true;
  }
}

function showCopyFallback(text) {
  if (!paletteToast) return;
  paletteToast.innerHTML = "";
  const label = document.createElement("span");
  label.textContent = "Copy blocked. sys_id: ";
  const code = document.createElement("input");
  code.value = text;
  code.readOnly = true;
  code.style.cssText =
    "width:100%;margin-top:6px;background:#151522;border:1px solid #3a3a5c;" +
    "color:#e0e0f0;border-radius:4px;padding:5px;font:12px monospace;";
  paletteToast.appendChild(label);
  paletteToast.appendChild(code);
  paletteToast.className = "err";
  paletteToast.style.display = "block";
  code.focus();
  code.select();
}

function getPaletteStorage() {
  if (
    typeof chrome === "undefined" ||
    !chrome.storage ||
    !chrome.storage.local
  ) {
    return null;
  }
  return chrome.storage.local;
}

function loadPaletteFavorite(callback) {
  const storage = getPaletteStorage();
  if (!storage) {
    callback();
    return;
  }
  storage.get(PALETTE_FAVORITE_STORAGE_KEY, (result) => {
    if (!chrome.runtime.lastError) {
      const value = result && result[PALETTE_FAVORITE_STORAGE_KEY];
      const stored = typeof value === "string" ? value : null;
      paletteFavoriteCommandId = normalizePaletteFavoriteKey(stored);
      if (stored && stored !== paletteFavoriteCommandId) {
        savePaletteFavorite(paletteFavoriteCommandId);
      }
    }
    callback();
  });
}

function savePaletteFavorite(commandId) {
  const storage = getPaletteStorage();
  if (!storage) return;
  if (commandId) {
    const update = {};
    update[PALETTE_FAVORITE_STORAGE_KEY] = commandId;
    storage.set(update);
  } else {
    storage.remove(PALETTE_FAVORITE_STORAGE_KEY);
  }
}

function commandsForPalette(cmds, query) {
  return preparePaletteCommands(cmds, query, paletteFavoriteCommandId);
}

function toggleFavoriteCommand(cmd) {
  if (!cmd || !cmd.id) return;
  const commandKey = paletteFavoriteKey(cmd);
  const isFavorite = paletteFavoriteCommandId === commandKey;
  paletteFavoriteCommandId = isFavorite ? null : commandKey;
  savePaletteFavorite(paletteFavoriteCommandId);
  renderResults(paletteInput ? paletteInput.value : "");
  const nextIndex = filteredCmds.findIndex(
    (candidate) => paletteFavoriteKey(candidate) === commandKey
  );
  if (nextIndex >= 0) {
    activeIndex = nextIndex;
    highlightActive();
  }
  showToast(
    paletteFavoriteCommandId
      ? "Favorite command set: " + cmd.label
      : "Favorite command cleared"
  );
}

function updateActivePaletteControls() {
  const cmd = filteredCmds[activeIndex] || null;
  if (paletteInput) {
    if (cmd) paletteInput.setAttribute("aria-activedescendant", paletteOptionId(cmd));
    else paletteInput.removeAttribute("aria-activedescendant");
  }
  if (paletteFavoriteButton) {
    const isFavorite = Boolean(
      cmd && paletteFavoriteCommandId === paletteFavoriteKey(cmd)
    );
    paletteFavoriteButton.disabled = !cmd;
    paletteFavoriteButton.textContent = isFavorite ? "★" : "☆";
    paletteFavoriteButton.title = isFavorite ? "Clear favorite command" : "Favorite command";
    paletteFavoriteButton.setAttribute("aria-pressed", isFavorite ? "true" : "false");
    paletteFavoriteButton.setAttribute(
      "aria-label",
      cmd
        ? (isFavorite ? "Clear favorite command " : "Favorite command ") + cmd.label
        : "Favorite command"
    );
    positionPaletteFavoriteButton();
  }
  if (paletteActiveShortcut) {
    paletteActiveShortcut.textContent = cmd && cmd.hint ? "Shortcut: " + cmd.hint : "";
    paletteActiveShortcut.hidden = !(cmd && cmd.hint);
  }
}

function positionPaletteFavoriteButton() {
  if (!paletteFavoriteButton || !paletteList || !paletteShadow) return;
  const active = paletteList.querySelector(".cmd.active");
  const box = paletteShadow.getElementById("box");
  if (!active || !box) {
    paletteFavoriteButton.hidden = true;
    return;
  }

  const activeRect = active.getBoundingClientRect();
  const listRect = paletteList.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  const visible = activeRect.bottom > listRect.top && activeRect.top < listRect.bottom;
  paletteFavoriteButton.hidden = !visible;
  if (visible) {
    paletteFavoriteButton.style.top =
      (activeRect.top - boxRect.top + activeRect.height / 2) + "px";
  }
}

function renderResults(query) {
  if (!paletteList) return;
  const cmds = buildCommands();
  filteredCmds = commandsForPalette(cmds, query);

  paletteList.innerHTML = "";

  if (!filteredCmds.length) {
    paletteList.innerHTML = '<div id="empty">No commands match</div>';
    activeIndex = 0;
    if (paletteCount) paletteCount.textContent = "0 commands";
    updateActivePaletteControls();
    return;
  }

  activeIndex = Math.min(activeIndex, filteredCmds.length - 1);

  if (paletteCount) {
    paletteCount.textContent =
      filteredCmds.length + (filteredCmds.length === 1 ? " command" : " commands");
  }

  let lastGroup = null;
  let groupElement = null;
  filteredCmds.forEach((cmd, i) => {
    if (cmd.group && cmd.group !== lastGroup) {
      groupElement = document.createElement("div");
      groupElement.className = "command-group";
      groupElement.setAttribute("role", "group");
      const gl = document.createElement("div");
      gl.className = "group-label";
      gl.id = "snh-command-group-" + String(cmd.group).toLowerCase().replace(/[^a-z0-9]+/g, "-");
      gl.textContent = cmd.group;
      groupElement.setAttribute("aria-labelledby", gl.id);
      groupElement.appendChild(gl);
      paletteList.appendChild(groupElement);
      lastGroup = cmd.group;
    }
    const row = document.createElement("div");
    row.className = "cmd-row";
    const el = document.createElement("div");
    el.className = "cmd" + (i === activeIndex ? " active" : "");
    el.id = paletteOptionId(cmd);
    el.dataset.idx = i;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", i === activeIndex ? "true" : "false");
    const content = document.createElement("span");
    content.className = "cmd-content";
    const label = document.createElement("span");
    const labelId = el.id + "-label";
    label.id = labelId;
    label.className = "cmd-label";
    label.textContent = cmd.label;
    const description = document.createElement("span");
    const descriptionId = el.id + "-description";
    description.id = descriptionId;
    description.className = "cmd-description";
    description.textContent = cmd.description;
    el.setAttribute("aria-labelledby", labelId + " " + descriptionId);
    content.appendChild(label);
    content.appendChild(description);
    el.appendChild(content);
    el.addEventListener("mouseenter", () => {
      activeIndex = i;
      highlightActive();
    });
    el.addEventListener("click", () => selectCommand(filteredCmds[i]));
    row.appendChild(el);
    (groupElement || paletteList).appendChild(row);
  });

  highlightActive();
}

function highlightActive() {
  if (!paletteList) return;
  paletteList.querySelectorAll(".cmd").forEach((el) => {
    const isActive = Number(el.dataset.idx) === activeIndex;
    el.classList.toggle("active", isActive);
    el.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  const active = paletteList.querySelector(".cmd.active");
  if (active) active.scrollIntoView({ block: "nearest" });
  updateActivePaletteControls();
}

function selectCommand(cmd) {
  if (!cmd) return;
  if (cmd.input) {
    showArgInput(cmd);
    return;
  }
  Promise.resolve(cmd.run()).catch((error) => {
    showToast(String(error && error.message ? error.message : error), true);
  });
  if (!cmd.keepOpen) closePalette();
}

function showArgInput(cmd) {
  if (!paletteShadow || !paletteList || !paletteInput) return;

  activeInputCmd = cmd;
  const shadow = paletteShadow;
  // Hide results, show arg input row
  paletteList.style.display = "none";
  const existingRow = shadow.getElementById("arg-row");
  if (existingRow) existingRow.remove();
  const box = shadow.getElementById("box");
  const toast = shadow.getElementById("toast");
  if (!box || !toast) return;

  const row = document.createElement("div");
  row.id = "arg-row";
  row.className = "cmd-input-row";
  const inputLabel = document.createElement("label");
  inputLabel.className = "cmd-input-label";
  inputLabel.htmlFor = "arg-input";
  inputLabel.textContent = cmd.inputLabel;
  const argInput = document.createElement("input");
  argInput.id = "arg-input";
  argInput.placeholder = cmd.placeholder || "";
  argInput.autocomplete = "off";
  argInput.spellcheck = false;
  row.appendChild(inputLabel);
  row.appendChild(argInput);
  box.insertBefore(row, toast);

  argInput.value = "";
  argInput.focus();
  argInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = activeInputCmd;
      const value = argInput.value.trim();
      if (!cmd) return;
      Promise.resolve(cmd.run(value)).catch((error) => {
        showToast(String(error && error.message ? error.message : error), true);
      });
      if (!cmd.keepOpen) closePalette();
    }
    if (e.key === "Escape") {
      activeInputCmd = null;
      if (row.isConnected) row.remove();
      if (paletteList) paletteList.style.display = "";
      if (paletteInput) paletteInput.focus();
    }
    e.stopPropagation();
  };
}

function clampPalettePosition(box, left, top, dimensions) {
  const gutter = 8;
  const size = dimensions || box.getBoundingClientRect();
  const maxLeft = Math.max(gutter, window.innerWidth - size.width - gutter);
  const maxTop = Math.max(gutter, window.innerHeight - size.height - gutter);
  return {
    left: Math.min(Math.max(gutter, left), maxLeft),
    top: Math.min(Math.max(gutter, top), maxTop),
  };
}

function positionPaletteBox(box, left, top, dimensions) {
  if (!box) return;
  const next = clampPalettePosition(box, left, top, dimensions);
  box.style.position = "fixed";
  box.style.left = next.left + "px";
  box.style.top = next.top + "px";
  box.style.margin = "0";
  palettePosition = next;
}

function resetPalettePosition(box) {
  palettePosition = null;
  if (!box) return;
  box.style.position = "";
  box.style.left = "";
  box.style.top = "";
  box.style.margin = "";
}

function makePaletteDraggable(box, handle) {
  if (!box || !handle) return () => {};
  let drag = null;
  let pendingPosition = null;
  let dragFrame = 0;

  const flushDragPosition = () => {
    dragFrame = 0;
    if (!drag || !pendingPosition) return;
    positionPaletteBox(
      box,
      pendingPosition.left,
      pendingPosition.top,
      { width: drag.width, height: drag.height }
    );
    pendingPosition = null;
  };

  const stopDragging = (e) => {
    if (!drag) return;
    if (dragFrame) {
      window.cancelAnimationFrame(dragFrame);
      dragFrame = 0;
    }
    flushDragPosition();
    drag = null;
    pendingPosition = null;
    handle.classList.remove("dragging");
    try {
      if (e && handle.hasPointerCapture(e.pointerId)) {
        handle.releasePointerCapture(e.pointerId);
      }
    } catch (error) {}
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const rect = box.getBoundingClientRect();
    drag = {
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
    handle.classList.add("dragging");
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (error) {}
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    pendingPosition = {
      left: e.clientX - drag.offsetX,
      top: e.clientY - drag.offsetY,
    };
    if (!dragFrame) {
      dragFrame = window.requestAnimationFrame(flushDragPosition);
    }
  };

  const onPointerUp = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    stopDragging(e);
  };

  const onDoubleClick = (e) => {
    e.preventDefault();
    stopDragging(e);
    resetPalettePosition(box);
  };

  const onResize = () => {
    if (!palettePosition) return;
    positionPaletteBox(box, palettePosition.left, palettePosition.top);
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUp);
  handle.addEventListener("pointercancel", onPointerUp);
  handle.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("resize", onResize);

  return () => {
    if (dragFrame) window.cancelAnimationFrame(dragFrame);
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", onPointerUp);
    handle.removeEventListener("pointercancel", onPointerUp);
    handle.removeEventListener("dblclick", onDoubleClick);
    window.removeEventListener("resize", onResize);
  };
}

function trapPaletteFocus(event) {
  if (event.key !== "Tab" || !paletteShadow) return;
  const focusable = Array.from(
    paletteShadow.querySelectorAll('input:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"])')
  ).filter((element) => !element.hidden);
  if (!focusable.length) return;

  const current = paletteShadow.activeElement;
  const currentIndex = focusable.indexOf(current);
  const nextIndex = event.shiftKey
    ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
    : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
  event.preventDefault();
  focusable[nextIndex].focus();
}

function openPalette() {
  if (paletteHost) {
    paletteInput && paletteInput.focus();
    return;
  }

  palettePreviousFocus = document.activeElement;
  paletteHost = document.createElement("div");
  paletteHost.id = "snh-palette-host";
  document.body.appendChild(paletteHost);
  paletteShadow = paletteHost.attachShadow({ mode: "closed" });

  paletteShadow.innerHTML = `
    <style>${PALETTE_CSS}</style>
    <div id="overlay">
      <div id="box" role="dialog" aria-modal="true" aria-labelledby="palette-title">
        <div id="palette-head" title="Drag to move. Double-click to recenter.">
          <div>
            <div id="palette-kicker">GlideLens</div>
            <div id="palette-title-row">
              <img id="drag-indicator" src="${chrome.runtime.getURL("icons/drag-indicator.svg")}" alt="" aria-hidden="true" />
              <div id="palette-title">Command palette</div>
            </div>
            <div id="palette-drag-hint">Drag header to move. Double-click to recenter.</div>
          </div>
          <span id="shortcut-key" aria-label="Backslash shortcut">\\</span>
        </div>
        <div id="search-wrap">
          <input id="search" role="combobox" aria-label="Search commands" aria-autocomplete="list" aria-controls="results" aria-expanded="true" placeholder="Search commands…" autocomplete="off" spellcheck="false" />
          <span id="kbd-hint">Type to filter</span>
        </div>
        <div id="results" role="listbox" aria-label="Available commands"></div>
        <button id="favorite-command" type="button" aria-pressed="false" hidden>☆</button>
        <div id="toast"></div>
        <div id="palette-footer">
          <span id="active-shortcut" hidden></span>
          <span id="result-count" aria-live="polite"></span>
          <div id="key-help" aria-label="Keyboard controls">
            <span><kbd>Up / Down</kbd> Navigate</span>
            <span><kbd>Enter</kbd> Run</span>
            <span><kbd>Esc</kbd> Close</span>
          </div>
        </div>
      </div>
    </div>
  `;

  paletteInput = paletteShadow.getElementById("search");
  paletteList  = paletteShadow.getElementById("results");
  paletteToast = paletteShadow.getElementById("toast");
  paletteCount = paletteShadow.getElementById("result-count");
  paletteFavoriteButton = paletteShadow.getElementById("favorite-command");
  paletteActiveShortcut = paletteShadow.getElementById("active-shortcut");
  const paletteBox = paletteShadow.getElementById("box");
  const paletteHead = paletteShadow.getElementById("palette-head");
  paletteDragCleanup = makePaletteDraggable(paletteBox, paletteHead);
  if (palettePosition) {
    positionPaletteBox(paletteBox, palettePosition.left, palettePosition.top);
  }

  activeIndex = 0;
  activeInputCmd = null;
  loadPaletteFavorite(() => {
    if (!paletteHost || !paletteInput) return;
    activeIndex = 0;
    renderResults(paletteInput.value);
  });
  paletteInput.focus();

  paletteInput.addEventListener("input", () => {
    activeIndex = 0;
    renderResults(paletteInput.value);
  });

  paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredCmds.length) activeIndex = (activeIndex + 1) % filteredCmds.length;
      highlightActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredCmds.length) {
        activeIndex = (activeIndex - 1 + filteredCmds.length) % filteredCmds.length;
      }
      highlightActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectCommand(filteredCmds[activeIndex]);
    }
  });

  if (paletteFavoriteButton) {
    paletteFavoriteButton.addEventListener("click", () => {
      toggleFavoriteCommand(filteredCmds[activeIndex]);
    });
  }

  if (paletteList) {
    paletteList.addEventListener("scroll", positionPaletteFavoriteButton, { passive: true });
  }

  if (paletteBox) {
    paletteBox.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
        return;
      }
      trapPaletteFocus(event);
    });
  }

  const overlay = paletteShadow.getElementById("overlay");
  if (overlay) overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePalette();
  });
}

function closePalette() {
  if (paletteHost) {
    if (paletteDragCleanup) paletteDragCleanup();
    paletteDragCleanup = null;
    paletteHost.remove();
    paletteHost = null;
    paletteShadow = null;
    paletteInput = null;
    paletteList = null;
    paletteToast = null;
    paletteCount = null;
    paletteFavoriteButton = null;
    paletteActiveShortcut = null;
    activeInputCmd = null;
    if (palettePreviousFocus && typeof palettePreviousFocus.focus === "function") {
      try {
        palettePreviousFocus.focus({ preventScroll: true });
      } catch (e) {
        palettePreviousFocus.focus();
      }
    }
    palettePreviousFocus = null;
  }
}

// Bare \ listener — attached in EVERY frame, because in the classic UI the
// keypress usually lands inside the gsft_main iframe, not the top frame.
// The top frame owns the single palette; sub-frames route the trigger up
// through the background worker. Editable controls are ignored so users can
// still type a backslash into fields and code editors.
const handledPaletteKeyEvents = new WeakSet();

function isEditablePaletteShortcutTarget(e) {
  const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
  return path.some((node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (node.isContentEditable) return true;
    if (typeof node.matches !== "function") return false;
    return node.matches(
      '[contenteditable=""],[contenteditable="true"],[role="textbox"],' +
      ".CodeMirror,.CodeMirror-code,.monaco-editor,.ace_editor"
    );
  });
}

function handlePaletteShortcut(e) {
  if (handledPaletteKeyEvents.has(e) || e.repeat) return;
  const isBareBackslash =
    e.key === "\\" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
  if (isBareBackslash && !isEditablePaletteShortcutTarget(e)) {
    handledPaletteKeyEvents.add(e);
    e.preventDefault();
    e.stopPropagation();
    if (window === window.top) {
      togglePalette();
    } else {
      chrome.runtime.sendMessage({ type: "TOGGLE_PALETTE" });
    }
  }
}

window.addEventListener("keydown", handlePaletteShortcut, true);
document.addEventListener("keydown", handlePaletteShortcut, true);

// Alt+double-click toggles the per-variable insight icons on a Service Portal
// catalog form. Gated: turning them ON requires an open catalog item, so a
// stray Alt+double-click anywhere else is a silent no-op. Turning them OFF works
// anywhere. The command palette entry is the discoverable alternative.
if (window === window.top) {
  document.addEventListener(
    "dblclick",
    (event) => {
      if (!event.altKey) return;
      const turningOn = !SNH.varInsightOn;
      if (turningOn && !isSysId(currentCatalogItemDefinitionSysId())) return;
      toggleVariableInsightIcons().catch(() => {});
    },
    true
  );
}

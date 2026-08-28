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
    if (window === window.top) {
      showToast(msg.message || "Filling portal form…", false, 6000);
    } else {
      chrome.runtime.sendMessage({
        type: "PREFILL_PROGRESS",
        message: msg.message || "Filling portal form…",
      });
    }
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
  "14",
  "15",
  "17",
  "19",
  "20",
  "24",
  "25",
  "31",
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

// "18" is this instance's observed type code for the Hidden question type;
// unlike the numeric codes above it isn't documented, so the display string
// ("hidden") is checked too and takes precedence if the code ever differs.
function isHiddenVariableType(type) {
  const normalized = normalizeVariableType(type);
  return normalized === "18" || normalized === "hidden";
}

function isSecretVariableType(type) {
  const normalized = normalizeVariableType(type);
  return normalized === "password" || normalized === "encrypted";
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
    const resp = await chrome.runtime.sendMessage({
      type: "FILL_PORTAL_VARIABLES",
      variables,
    });
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
      if (isUnsupportedVariableType(type) && !isSecretVariableType(type)) return;

      const label = snFieldDisplay(row, "question_text") || name;
      const secret = isSecretVariableType(type) || isSensitiveVariableName(name, label);
      definitions.set(name, {
        name,
        label,
        type,
        typeDisplay: snFieldDisplay(row, "type") || type,
        variableSet,
        setName: (setInfo && setInfo.title) || "",
        referenceTable:
          snFieldValue(row, "reference") ||
          snFieldValue(row, "lookup_table") ||
          snFieldValue(row, "list_table"),
        secret,
        defaultValue: secret ? "" : snFieldValue(row, "default_value"),
        hiddenType: isHiddenVariableType(type),
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "TOGGLE_FIELD_NAMES") {
    const count = toggleFieldNames(msg.force);
    sendResponse({ ok: true, count, on: SNH.fieldNamesOn });
  }
  if (msg && msg.type === "TOGGLE_TRANSLATIONS") {
    const count = toggleTranslationIcons(msg.force);
    sendResponse({ ok: true, count, on: SNH.transIconsOn });
  }
  if (msg && msg.type === "TOGGLE_PALETTE") {
    // Only the top frame owns the palette to avoid duplicate overlays.
    if (window === window.top) togglePalette();
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
  }
  if (msg && msg.type === "PREFILL_PROGRESS") {
    if (window === window.top) showToast(msg.message || "Filling portal form…", false, 6000);
  }
  return true;
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
      description: "Search verified records across readable tables…",
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
      description: "Open playbook executions for this record…",
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
      run: showHiddenPortalVariables,
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

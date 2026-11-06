/*
 * A simulated instance for the Update Set Lens and Version Lens engines.
 *
 * DEV-ONLY, required by the suites, never by the extension. In-memory
 * sys_update_set, sys_update_xml, sys_update_version, sys_remote_update_set,
 * sys_metadata and sys_metadata_delete behind a small encoded-query evaluator
 * that answers the way the Table API does, including the two behaviours that
 * shaped both plans -- `name=` ignores case and trailing spaces, and
 * X-Total-Count only when asked for. Every request is kept, so a test can see
 * what was read as well as what was concluded.
 *
 * Synthetic data only: no set, user, record or instance here is real.
 */
const assert = require("node:assert");

const plain = (value) => JSON.parse(JSON.stringify(value));
const id = (n) => Number(n).toString(16).padStart(32, "0");
const guid = (n) => "a" + Number(n).toString(16).padStart(31, "0");

const LABELS = {
  "in progress": "In progress",
  complete: "Complete",
  ignore: "Ignore",
  committed: "Committed",
  previewed: "Previewed",
  loaded: "Loaded",
  backedout: "Backed out",
  partial: "Partial",
  current: "Current",
  previous: "Previous",
};

function parseQuery(query) {
  const conditions = [];
  const order = [];
  String(query || "").split("^").filter(Boolean).forEach((part) => {
    if (part.startsWith("ORDERBYDESC")) return order.push({ field: part.slice(11), desc: true });
    if (part.startsWith("ORDERBY")) return order.push({ field: part.slice(7), desc: false });
    const match = part.match(/^([a-z_]+?)(IN|LIKE|>|=)(.*)$/);
    assert.ok(match, "the simulated instance does not understand " + part);
    conditions.push({ field: match[1], op: match[2], value: match[3] });
  });
  return { conditions, order };
}

function test1(row, condition) {
  const value = String(row[condition.field] == null ? "" : row[condition.field]);
  if (condition.op === "IN") return condition.value.split(",").includes(value);
  if (condition.op === "LIKE") return value.toLowerCase().includes(condition.value.toLowerCase());
  if (condition.op === ">") return value > condition.value;
  /* ServiceNow's name match ignores case and trailing spaces (G3). */
  if (condition.field === "name") return value.trimEnd().toLowerCase() === condition.value.trimEnd().toLowerCase();
  return value === condition.value;
}

function fakeInstance(data, options) {
  const opts = options || {};
  const tables = {
    sys_update_set: data.sets || [],
    sys_update_xml: data.xml || [],
    sys_update_version: data.versions || [],
    sys_remote_update_set: data.remote || [],
    sys_metadata: data.metadata || [],
    sys_metadata_delete: data.deleted || [],
  };
  Object.assign(tables, data.tables || {});
  const names = new Map((data.sets || []).map((row) => [row.sys_id, row.name]));
  const requests = [];
  const display = (table, field, row) => {
    if (row.display && row.display[field] != null) return String(row.display[field]);
    const value = row[field] == null ? "" : String(row[field]);
    if (field === "state") return LABELS[value] || value;
    if (["parent", "merged_to", "base_update_set"].includes(field)) return names.get(value) || "";
    if (field === "application" || field === "sys_scope") return value === "global" ? "Global" : value;
    if (field === "update_source") return value ? "Source " + value.slice(-2) : "";
    if (/_on$|_date$/.test(field)) return value ? "D(" + value + ")" : "";
    return value;
  };
  const transport = async (request) => {
    requests.push(plain(request));
    if (opts.answer) {
      const custom = await opts.answer(request);
      if (custom !== undefined) return custom;
    }
    const rows = tables[request.table];
    assert.ok(rows, "unknown table " + request.table);
    const { conditions, order } = parseQuery(request.query);
    let hit = rows.filter((row) => conditions.every((condition) => test1(row, condition)));
    order.slice().reverse().forEach(({ field, desc }) => {
      hit = hit.slice().sort((a, b) => {
        const left = String(a[field] || "");
        const right = String(b[field] || "");
        return (left < right ? -1 : left > right ? 1 : 0) * (desc ? -1 : 1);
      });
    });
    const total = hit.length;
    hit = hit.slice(0, request.limit);
    const fields = String(request.fields).split(",");
    const displayAll = request.options && request.options.displayAll;
    /* A field named in row.masked matches its query but comes back blank, as
     * a field ACL answers: present and empty, never omitted. */
    const result = hit.map((row) => {
      const out = {};
      fields.forEach((field) => {
        const masked = Array.isArray(row.masked) && row.masked.includes(field);
        const value = masked || row[field] == null ? "" : String(row[field]);
        out[field] = displayAll ? { value, display_value: masked ? "" : display(request.table, field, row) } : value;
      });
      return out;
    });
    const reply = { ok: true, result };
    if (request.options && request.options.withTotal && !opts.noTotals) reply.total = total;
    return reply;
  };
  return { transport, requests, tables };
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function setRow(n, extra) {
  return Object.assign({
    sys_id: id(n),
    name: "Set " + n,
    state: "complete",
    is_default: "false",
    application: "global",
    parent: "",
    base_update_set: "",
    merged_to: "",
    remote_sys_id: "",
    origin_sys_id: "",
    sys_created_by: "dev.one",
    sys_created_on: "2026-10-01 10:00:00",
    sys_updated_on: "2026-10-02 10:00:" + String(n % 60).padStart(2, "0"),
    completed_on: "",
  }, extra);
}

let xmlCounter = 5000;
function xmlRow(setId, name, g, hash, extra) {
  xmlCounter += 1;
  return Object.assign({
    sys_id: id(xmlCounter),
    name,
    update_set: setId,
    remote_update_set: "",
    action: "INSERT_OR_UPDATE",
    type: "Script Include",
    target_name: name.replace(/_[0-9a-f]{32}$/, ""),
    update_guid: g,
    payload_hash: hash,
    category: "customer",
  }, extra);
}

function versionRow(name, setId, state, g, hash, created, extra) {
  return Object.assign({
    name,
    state,
    source: setId,
    source_table: "sys_update_set",
    update_guid: g,
    payload_hash: hash,
    action: "INSERT_OR_UPDATE",
    reverted_from: "",
    sys_created_by: "dev.one",
    sys_created_on: created,
  }, extra);
}

module.exports = {
  LABELS,
  plain,
  id,
  guid,
  parseQuery,
  fakeInstance,
  setRow,
  xmlRow,
  versionRow,
};

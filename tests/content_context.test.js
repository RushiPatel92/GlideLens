/* Tests for conservative table/sys_id detection from ServiceNow page URLs. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadContextHelpers() {
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const contextStart = source.indexOf("function decodedVariants");
  const contextEnd = source.indexOf("function isTechnicalFieldName", contextStart);
  const sysIdStart = source.indexOf("function sysIdFromText");
  const sysIdEnd = source.indexOf("async function getCurrentRecordSysId", sysIdStart);
  assert.ok(contextStart >= 0 && contextEnd > contextStart, "record context helpers not found");
  assert.ok(sysIdStart >= 0 && sysIdEnd > sysIdStart, "sys_id helper not found");

  return new Function(
    source.slice(contextStart, contextEnd) +
      source.slice(sysIdStart, sysIdEnd) +
      "\nreturn { recordContextFromText, workspaceRecordContextFromText, " +
        "workspaceRecordContextMatches, workspaceSupportedSurface, " +
        "WORKSPACE_SUPPORTED_SURFACES, sysIdFromText };"
  )();
}

const helpers = loadContextHelpers();
const SYS_ID = "00000000000000000000000000000001";

test("classic list routes preselect the underlying table", () => {
  assert.deepStrictEqual(
    helpers.recordContextFromText(
      "https://example.service-now.com/sn_example_case_list.do?"
    ),
    { table: "sn_example_case", sysId: null }
  );
});

test("classic record routes retain the complete table name", () => {
  assert.deepStrictEqual(
    helpers.recordContextFromText(
      "https://example.service-now.com/sn_example_case.do?sys_id=" + SYS_ID
    ),
    { table: "sn_example_case", sysId: SYS_ID }
  );
});

test("Workspace record routes are unaffected", () => {
  assert.deepStrictEqual(
    helpers.recordContextFromText(
      "https://example.service-now.com/now/workspace/example/record/sn_example_case/" + SYS_ID
    ),
    { table: "sn_example_case", sysId: SYS_ID }
  );
});

test("Workspace Variable Values retains the complete experience path", () => {
  assert.deepStrictEqual(
    helpers.workspaceRecordContextFromText(
      "https://example.service-now.com/now/sow/record/sc_req_item/" + SYS_ID +
        "/params/selected-tab-index/0"
    ),
    { experiencePath: ["sow"], table: "sc_req_item", sysId: SYS_ID }
  );
  assert.deepStrictEqual(
    helpers.workspaceRecordContextFromText(
      "https://example.service-now.com/now/workspace/agent/record/sc_req_item/" + SYS_ID
    ),
    { experiencePath: ["workspace", "agent"], table: "sc_req_item", sysId: SYS_ID }
  );
});

test("Workspace route matching includes every experience segment", () => {
  const sow = { experiencePath: ["sow"], table: "sc_req_item", sysId: SYS_ID };
  assert.strictEqual(helpers.workspaceRecordContextMatches(sow, { ...sow }), true);
  assert.strictEqual(
    helpers.workspaceRecordContextMatches(sow, {
      experiencePath: ["workspace", "agent"],
      table: "sc_req_item",
      sysId: SYS_ID,
    }),
    false
  );
});

/*
 * Workspace support is allowlisted by the (experience path, table) PAIR. The
 * earlier rule -- one segment, and that segment is "sow" -- was never the real
 * safety property; it was the shape the only supported surface happened to
 * have. These assertions pin the pair rule itself, including that every
 * half-match is still refused.
 */
test("Workspace support is decided by the experience path and table together", () => {
  const surfaceOf = (url) =>
    helpers.workspaceSupportedSurface(helpers.workspaceRecordContextFromText(url));
  const url = (path, table) =>
    "https://example.service-now.com/now/" + path + "/record/" + table + "/" + SYS_ID;

  assert.deepStrictEqual(surfaceOf(url("sow", "sc_req_item")), {
    kind: "ritm",
    key: "sow:sc_req_item",
  });
  assert.deepStrictEqual(surfaceOf(url("psm/workspace", "sn_slm_case")), {
    kind: "producer",
    key: "psm/workspace:sn_slm_case",
  });
  assert.deepStrictEqual(surfaceOf(url("psm/workspace", "sn_slm_task")), {
    kind: "producer",
    key: "psm/workspace:sn_slm_task",
  });

  // Every half-match is refused: the right table on the wrong experience, the
  // right experience with the wrong table, a prefix of a supported path, a
  // reversed path, a longer path, and an unrelated multi-segment experience.
  [
    url("sow", "sn_slm_case"),
    url("sow", "sn_slm_task"),
    url("psm/workspace", "sc_req_item"),
    url("psm", "sn_slm_case"),
    url("workspace", "sn_slm_case"),
    url("workspace/psm", "sn_slm_case"),
    url("psm/workspace/extra", "sn_slm_case"),
    url("workspace/agent", "sc_req_item"),
    url("sow", "incident"),
  ].forEach((candidate) => {
    assert.strictEqual(surfaceOf(candidate), null, candidate + " must be refused");
  });

  assert.strictEqual(surfaceOf("https://example.service-now.com/incident.do"), null);
  assert.strictEqual(helpers.workspaceSupportedSurface(null), null);
});

/*
 * A record opened as a SUB-TAB nests its route inside the route of the tab that
 * owns it. The owner used to win the experience path -- the greedy group
 * swallowed the whole trail, giving
 * "psm/workspace/record/<owner table>/<id>/params/selected-tab-index/6/sub",
 * which matches no allowlisted pair -- so every sub-tab refused while its form
 * was plainly on screen.
 *
 * Only the parse was wrong. Measured live on a supplier case: exactly one
 * catalog form was mounted, it was the SUB-record's, and every corroborating
 * ancestor identity was the sub-record's too, so the identity gate needed no
 * loosening and keeps its full strength here.
 */
const OWNER_ID = "00000000000000000000000000000002";
const subTabUrl = (experience, ownerTable, table, sysId) =>
  "https://example.service-now.com/now/" + experience + "/record/" + ownerTable +
  "/" + OWNER_ID + "/params/selected-tab-index/6/sub/record/" + table + "/" + (sysId || SYS_ID);

test("a record opened as a sub-tab resolves to the sub-record, not the tab owner", () => {
  const url = subTabUrl("psm/workspace", "sn_slm_case", "sn_slm_task");

  assert.deepStrictEqual(helpers.workspaceRecordContextFromText(url), {
    experiencePath: ["psm", "workspace"],
    table: "sn_slm_task",
    sysId: SYS_ID,
  });
  assert.deepStrictEqual(
    helpers.workspaceSupportedSurface(helpers.workspaceRecordContextFromText(url)),
    { kind: "producer", key: "psm/workspace:sn_slm_task" }
  );

  // The owner's identity must never be the one that gets read.
  assert.notStrictEqual(helpers.workspaceRecordContextFromText(url).sysId, OWNER_ID);
});

test("a sub-tab is allowlisted by its own pair, and a supported owner never vouches for it", () => {
  const surfaceOf = (url) =>
    helpers.workspaceSupportedSurface(helpers.workspaceRecordContextFromText(url));

  // An unlisted sub-record table is refused even though the owner is supported.
  assert.strictEqual(surfaceOf(subTabUrl("psm/workspace", "sn_slm_case", "incident")), null);
  // An unsupported experience is refused however supported both tables are.
  assert.strictEqual(surfaceOf(subTabUrl("sow", "sn_slm_case", "sn_slm_task")), null);
  // And the pair rule still applies to the sub-record, not to the owner.
  assert.strictEqual(surfaceOf(subTabUrl("sow", "sc_req_item", "sn_slm_case")), null);
});

test("only a sub-record segment moves the identity, and the innermost one wins", () => {
  const other = "00000000000000000000000000000003";
  const base =
    "https://example.service-now.com/now/psm/workspace/record/sn_slm_case/" + OWNER_ID;

  // A trailing path that is not a sub-record leaves the tab's own record alone.
  assert.deepStrictEqual(
    helpers.workspaceRecordContextFromText(base + "/params/selected-tab-index/6"),
    { experiencePath: ["psm", "workspace"], table: "sn_slm_case", sysId: OWNER_ID }
  );

  // Nested deeper, the record on screen is the last one, not the first.
  assert.deepStrictEqual(
    helpers.workspaceRecordContextFromText(
      base + "/params/x/1/sub/record/sn_slm_task/" + other +
        "/params/y/2/sub/record/sn_slm_task/" + SYS_ID
    ),
    { experiencePath: ["psm", "workspace"], table: "sn_slm_task", sysId: SYS_ID }
  );

  // The encoded form of a sub-tab route resolves identically.
  assert.deepStrictEqual(
    helpers.workspaceRecordContextFromText(
      encodeURIComponent(subTabUrl("psm/workspace", "sn_slm_case", "sn_slm_task"))
    ),
    { experiencePath: ["psm", "workspace"], table: "sn_slm_task", sysId: SYS_ID }
  );
});

test("a supported pair still needs a well-formed record id", () => {
  assert.strictEqual(
    helpers.workspaceSupportedSurface({
      experiencePath: ["psm", "workspace"],
      table: "sn_slm_case",
      sysId: "not-a-sys-id",
    }),
    null
  );
  assert.strictEqual(
    helpers.workspaceSupportedSurface({ table: "sn_slm_case", sysId: SYS_ID }),
    null
  );
});

test("route matching still rejects a changed experience on a supported table", () => {
  const before = {
    experiencePath: ["psm", "workspace"],
    table: "sn_slm_case",
    sysId: SYS_ID,
  };
  assert.strictEqual(helpers.workspaceRecordContextMatches(before, { ...before }), true);
  assert.strictEqual(
    helpers.workspaceRecordContextMatches(before, { ...before, experiencePath: ["sow"] }),
    false
  );
  assert.strictEqual(
    helpers.workspaceRecordContextMatches(before, { ...before, table: "sn_slm_task" }),
    false
  );
});

test("every supported surface names a known stored reader", () => {
  assert.ok(helpers.WORKSPACE_SUPPORTED_SURFACES.length > 0);
  helpers.WORKSPACE_SUPPORTED_SURFACES.forEach((surface) => {
    assert.ok(Array.isArray(surface.experiencePath) && surface.experiencePath.length > 0);
    assert.match(surface.table, /^[a-z][a-z0-9_]*$/);
    assert.ok(["ritm", "producer"].includes(surface.kind), surface.table + " kind");
  });
});

test("an encoded classic list URL is decoded before table detection", () => {
  assert.deepStrictEqual(
    helpers.recordContextFromText(
      encodeURIComponent("https://example.service-now.com/example_record_list.do?")
    ),
    { table: "example_record", sysId: null }
  );
});

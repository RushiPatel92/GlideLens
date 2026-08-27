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
      "\nreturn { recordContextFromText, sysIdFromText };"
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

test("an encoded classic list URL is decoded before table detection", () => {
  assert.deepStrictEqual(
    helpers.recordContextFromText(
      encodeURIComponent("https://example.service-now.com/example_record_list.do?")
    ),
    { table: "example_record", sysId: null }
  );
});

/*
 * Tests for the counting logic in code_search_ui.js.
 *
 *   node --test tests/code_search_ui.test.js
 *
 * DEV-ONLY, like its siblings. The panel itself needs a DOM and is not tested
 * here — but the two numbers it prints are logic, and they are the reason these
 * tests exist: hit identity is table+sysId+FIELD, so one record matching in
 * three fields is three findings. Printing that as "3" beside a button that
 * then opens one record is a count contradicting itself one click later.
 *
 * The module assigns to globalThis and touches the DOM only inside mount(), so
 * it loads under node:vm with no browser, the same way code_search.js does.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadUI() {
  const file = path.join(__dirname, "..", "code_search_ui.js");
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context.SNCodeSearchUI;
}

const UI = loadUI();

const hit = (sysId, field, table) => ({
  table: table || "sys_ui_action",
  sysId,
  field,
});

test("the panel module loads without a DOM", () => {
  assert.ok(UI, "SNCodeSearchUI missing from globalThis");
  assert.strictEqual(typeof UI.countRecords, "function");
});

test("one record matching three fields counts as one record", () => {
  const hits = [hit("a", "name"), hit("a", "condition"), hit("a", "script")];
  assert.strictEqual(hits.length, 3, "three findings");
  assert.strictEqual(UI.countRecords(hits), 1, "one record");
});

test("records are counted per table, so the same sys_id in two tables is two", () => {
  const hits = [hit("same", "script", "sys_script"), hit("same", "script", "sys_ui_action")];
  assert.strictEqual(UI.countRecords(hits), 2);
});

test("counting an empty or missing list does not throw", () => {
  assert.strictEqual(UI.countRecords([]), 0);
  assert.strictEqual(UI.countRecords(null), 0);
});

test("a record's field matches are clustered together", () => {
  /* The real interleaving: Tier 1 streams its hits before the adapters do, so
   * one UI Action's `script` hit (instance index) and its `condition` hit (our
   * adapter) arrive with other records in between. */
  const hits = [
    hit("a", "script"),
    hit("b", "script"),
    hit("a", "condition"),
    hit("b", "name"),
    hit("a", "name"),
  ];
  const clustered = UI.clusterByRecord(hits).map((h) => h.sysId + "." + h.field);
  assert.deepStrictEqual(Array.from(clustered), [
    "a.script",
    "a.condition",
    "a.name",
    "b.script",
    "b.name",
  ]);
});

test("clustering keeps records in the order they first appeared", () => {
  const hits = [hit("z", "script"), hit("m", "script"), hit("z", "name")];
  const order = UI.clusterByRecord(hits).map((h) => h.sysId);
  assert.deepStrictEqual(Array.from(order), ["z", "z", "m"]);
});

test("clustering never loses or duplicates a hit", () => {
  const hits = [
    hit("a", "script"),
    hit("b", "script"),
    hit("a", "condition"),
    hit("c", "name"),
    hit("b", "condition"),
  ];
  const clustered = UI.clusterByRecord(hits);
  assert.strictEqual(clustered.length, hits.length);
  hits.forEach((original) => {
    assert.ok(clustered.indexOf(original) !== -1, "hit survived clustering");
  });
});

/* Tests for the pure command-palette model and its accessibility invariants. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const contentFile = path.join(__dirname, "..", "content.js");
const contentSource = fs.readFileSync(contentFile, "utf8");

function loadPaletteHelpers() {
  const start = contentSource.indexOf("const PALETTE_GROUP_ORDER");
  const end = contentSource.indexOf("/* ---- Palette state ---- */", start);
  assert.ok(start >= 0 && end > start, "palette helper block not found");

  return new Function(
    contentSource.slice(start, end) +
      "\nreturn { PALETTE_GROUP_ORDER, paletteFavoriteKey, " +
      "normalizePaletteFavoriteKey, validatePaletteCommands, " +
      "orderPaletteCommands, paletteCommandMatches, " +
      "preparePaletteCommands, paletteOptionId };"
  )();
}

const palette = loadPaletteHelpers();

function loadBuiltCommands(debugTimelineUI) {
  const commandStart = contentSource.indexOf("const DEV_LINKS");
  const commandEnd = contentSource.indexOf("let recordSearchSession", commandStart);
  const helperStart = contentSource.indexOf("const PALETTE_GROUP_ORDER");
  const helperEnd = contentSource.indexOf("/* ---- Palette state ---- */", helperStart);
  assert.ok(commandStart >= 0 && commandEnd > commandStart, "command block not found");

  const noop = () => {};
  const factory = new Function(
    "chrome", "location", "globalThis", "decodedVariants",
    "openRecordSearch", "openCurrentRecordPlaybookExecutions",
    "openCurrentPlaybookCustomerUpdates", "openCustomerUpdatesBySysId",
    "prefillPortalVariablesFromTicket", "showHiddenPortalVariables",
    "showVariableValues",
    "showCatalogInsight", "refreshCodeSearchCoverage",
    contentSource.slice(commandStart, commandEnd) +
      contentSource.slice(helperStart, helperEnd) +
      "\nreturn buildCommands();"
  );

  return factory(
    { runtime: { sendMessage: noop } },
    { href: "https://example.service-now.com/incident.do", origin: "https://example.service-now.com" },
    { SNDebugTimelineUI: debugTimelineUI || null },
    () => [],
    noop, noop, noop, noop, noop, noop, noop, noop, noop
  );
}

function command(overrides) {
  return Object.assign({
    id: "sample",
    label: "Sample",
    description: "Run the sample action",
    keywords: [],
    group: "Tools",
  }, overrides);
}

test("search matches labels, descriptions, and legacy keywords", () => {
  const commands = [
    command({
      id: "code-search",
      label: "Code Search",
      description: "Search verified code and configuration…",
      keywords: ["grep", "scripts"],
    }),
  ];

  assert.strictEqual(palette.preparePaletteCommands(commands, "code search", null).length, 1);
  assert.strictEqual(palette.preparePaletteCommands(commands, "configuration", null).length, 1);
  assert.strictEqual(palette.preparePaletteCommands(commands, "GREP", null).length, 1);
  assert.strictEqual(palette.preparePaletteCommands(commands, "records", null).length, 0);
});

test("current built-ins expose the accepted unique command labels", () => {
  const builtIns = loadBuiltCommands().filter((item) => !item.id.startsWith("devlink-"));

  assert.deepStrictEqual(
    builtIns.map((item) => item.label),
    [
      "Translations", "Debug Timeline", "sys_id", "Record Lens", "Playbooks",
      "Customer Updates", "Variable Prefill", "Variable Values", "Catalog Logic",
      "Variable Insight", "Code Search", "Search Sources", "Table List", "New Record",
    ]
  );
  assert.ok(builtIns.every((item) => item.description));
  assert.ok(builtIns.filter((item) => item.input).every((item) => item.inputLabel));
});

test("groups render in the declared order while preserving order within a group", () => {
  const commands = [
    command({ id: "nav", label: "Table List", group: "Navigate" }),
    command({ id: "record-a", label: "Record A", group: "Record" }),
    command({ id: "tool-a", label: "Tool A", group: "Tools" }),
    command({ id: "record-b", label: "Record B", group: "Record" }),
    command({ id: "catalog", label: "Catalog Logic", group: "Catalog" }),
  ];

  assert.deepStrictEqual(
    palette.preparePaletteCommands(commands, "", null).map((item) => item.id),
    ["tool-a", "record-a", "record-b", "catalog", "nav"]
  );
});

test("a command's own exact label makes it the active row", () => {
  /*
   * Descriptions are searched too, so a complete label can match a DIFFERENT
   * command through that command's description. Before relevance tiers, typing
   * "Variable Values" made Variable Prefill row 0 -- its description contains
   * "catalog-variable values" and it is declared first -- so Enter ran the
   * wrong command. Every built-in must win on its own name.
   */
  const builtIns = loadBuiltCommands();

  for (const cmd of builtIns) {
    const prepared = palette.preparePaletteCommands(builtIns, cmd.label, null);
    assert.ok(prepared.length > 0, `"${cmd.label}" matched nothing`);
    assert.strictEqual(
      prepared[0].id,
      cmd.id,
      `typing "${cmd.label}" makes "${prepared[0].label}" the active row, not "${cmd.label}"`
    );
  }
});

test("a label match outranks a description match", () => {
  const commands = [
    command({
      id: "prefill",
      label: "Variable Prefill",
      description: "Copy catalog-variable values from another ticket",
      group: "Catalog",
    }),
    command({
      id: "values",
      label: "Variable Values",
      description: "Inspect current catalog-variable values",
      group: "Catalog",
    }),
  ];

  assert.deepStrictEqual(
    palette.preparePaletteCommands(commands, "Variable Values", null).map((item) => item.id),
    ["values", "prefill"]
  );
});

test("an exact label in a later group still ranks first, and groups stay whole", () => {
  /*
   * The group carrying the best match leads, but groups must stay contiguous:
   * the renderer opens a header whenever cmd.group changes, so a group split in
   * two renders its header twice.
   */
  const commands = [
    command({ id: "catalog", label: "Catalog Logic", group: "Catalog",
      description: "Inspect catalog client scripts and UI policies" }),
    command({ id: "tool", label: "Client Tools", group: "Tools",
      description: "Unrelated client scripts helper" }),
    command({ id: "devlink", label: "Client Scripts", group: "Dev Links",
      description: "Open the client scripts list" }),
    // Dev Links needs a SECOND member, one that matches only by description
    // (tier 3) while its sibling matches exactly (tier 0). A flat relevance
    // sort would put every other group's tier-3 command between the two and
    // split Dev Links in half; ranking whole groups keeps them adjacent.
    // Without this command the contiguity assertion below cannot fail,
    // because one command per group is contiguous under any ordering.
    command({ id: "devlink-2", label: "Business Rules", group: "Dev Links",
      description: "Open business rules, not client scripts" }),
  ];

  const prepared = palette.preparePaletteCommands(commands, "Client Scripts", null);
  assert.strictEqual(prepared[0].id, "devlink");
  assert.deepStrictEqual(
    prepared.map((item) => item.id),
    ["devlink", "devlink-2", "tool", "catalog"],
    "Dev Links leads as a whole group, then Tools and Catalog by declared order"
  );

  // A group is contiguous when its first appearance is where its run starts,
  // so the count of runs equals the count of distinct groups.
  const groups = prepared.map((item) => item.group);
  const runs = groups.filter((group, index) => index === 0 || group !== groups[index - 1]);
  assert.deepStrictEqual(
    runs,
    [...new Set(groups)],
    "a group split into two runs renders its header twice"
  );
});

test("an empty query keeps the declared order untouched", () => {
  const commands = [
    command({ id: "tool-a", label: "Zebra", group: "Tools" }),
    command({ id: "tool-b", label: "Alpha", group: "Tools" }),
    command({ id: "record", label: "Record A", group: "Record" }),
  ];

  assert.deepStrictEqual(
    palette.preparePaletteCommands(commands, "", null).map((item) => item.id),
    ["tool-a", "tool-b", "record"]
  );
});

test("a favorite appears once at the top in its own group", () => {
  const commands = [
    command({ id: "one", label: "One", group: "Record" }),
    command({ id: "two", label: "Two", group: "Tools" }),
  ];

  const prepared = palette.preparePaletteCommands(commands, "", "one");
  assert.deepStrictEqual(prepared.map((item) => item.id), ["one", "two"]);
  assert.strictEqual(prepared[0].group, "Favorite");
});

test("Debug Timeline favorites survive start and stop state changes", () => {
  const start = command({
    id: "start-debug-timeline",
    favoriteKey: "debug-timeline",
    label: "Debug Timeline",
  });
  const stop = command({
    id: "stop-debug-timeline",
    favoriteKey: "debug-timeline",
    label: "Debug Timeline",
  });

  assert.strictEqual(palette.normalizePaletteFavoriteKey("start-debug-timeline"), "debug-timeline");
  assert.strictEqual(palette.normalizePaletteFavoriteKey("stop-debug-timeline"), "debug-timeline");
  assert.strictEqual(palette.paletteFavoriteKey(start), "debug-timeline");
  assert.strictEqual(
    palette.preparePaletteCommands([stop], "", "debug-timeline")[0].group,
    "Favorite"
  );
});

test("duplicate visible labels and implicit input labels are rejected", () => {
  assert.throws(
    () => palette.validatePaletteCommands([
      command({ id: "a", label: "Same" }),
      command({ id: "b", label: "same" }),
    ]),
    /Duplicate palette label/
  );
  assert.throws(
    () => palette.validatePaletteCommands([
      command({ id: "input", input: true }),
    ]),
    /explicit inputLabel/
  );
});

test("rendering keeps interactive controls outside options and announces selection", () => {
  assert.match(contentSource, /groupElement\.setAttribute\("role", "group"\)/);
  assert.match(contentSource, /paletteInput\.setAttribute\("aria-activedescendant"/);
  assert.match(contentSource, /el\.setAttribute\("aria-labelledby", labelId \+ " " \+ descriptionId\)/);
  assert.match(contentSource, /<button id="favorite-command"/);
  assert.doesNotMatch(contentSource, /el\.appendChild\(favorite\)/);
  assert.match(contentSource, /function trapPaletteFocus\(event\)/);
  assert.match(contentSource, /\.cmd-label\{\s*display:block;justify-self:start;width:max-content;max-width:100%/);
});

test("result panels use the same stable feature headings", () => {
  const files = {
    "record_search_ui.js": /<h2>Record Lens<\/h2>/,
    "catalog_insight_ui.js": /<h2 id="snh-catalog-insight-title">Catalog Logic<\/h2>/,
    "code_search_ui.js": /<h2>Code Search <span class="term"><\/span><\/h2>/,
    "hidden_variables_ui.js": /const panelTitle = workspaceMode[\s\S]*\["stored-only", "no-editor-empty", "no-candidate"\][\s\S]*\? "Stored Variables"[\s\S]*: "Variable Values"[\s\S]*<h2 id="snh-hidden-title">\$\{panelTitle\} /,
    "debug_timeline_ui.js": /<h2 id="snh-debug-title">Debug Timeline /,
  };

  for (const [file, pattern] of Object.entries(files)) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.match(source, pattern, file);
  }
});

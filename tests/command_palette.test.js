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

function loadBuiltCommands(debugTimelineUI, options) {
  const opts = options || {};
  const commandStart = contentSource.indexOf("const DEV_LINKS");
  const commandEnd = contentSource.indexOf("let recordSearchSession", commandStart);
  const helperStart = contentSource.indexOf("const PALETTE_GROUP_ORDER");
  const helperEnd = contentSource.indexOf("/* ---- Palette state ---- */", helperStart);
  assert.ok(commandStart >= 0 && commandEnd > commandStart, "command block not found");

  const noop = () => {};
  const factory = new Function(
    "chrome", "location", "globalThis", "decodedVariants",
    "isWorkspaceRecordRoute",
    "openRecordSearch", "openCurrentRecordPlaybookExecutions",
    "openCurrentPlaybookCustomerUpdates", "openCustomerUpdatesBySysId",
    "prefillPortalVariablesFromTicket", "showHiddenPortalVariables",
    "showVariableValues",
    "showCatalogInsight", "refreshCodeSearchCoverage", "openImpersonate",
    "openUpdateSetLens", "openVersionLens",
    contentSource.slice(commandStart, commandEnd) +
      contentSource.slice(helperStart, helperEnd) +
      /* What the access check last answered on this page. */
      "\nupdateHistoryAccess = " + JSON.stringify(opts.access || "unknown") + ";" +
      "\nreturn buildCommands();"
  );

  return factory(
    { runtime: { sendMessage: noop } },
    { href: "https://example.service-now.com/incident.do", origin: "https://example.service-now.com" },
    { SNDebugTimelineUI: debugTimelineUI || null },
    /* Page-conditional commands are decided from the decoded URL, so a test
     * that wants one has to supply what decodedVariants would have seen. */
    () => opts.decodedUrls || [],
    () => Boolean(opts.workspaceRoute),
    noop, noop, noop, noop, noop, noop, noop, noop, noop, noop,
    function openUpdateSetLens() {},
    function openVersionLens() {}
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
      "Translation Lens", "Debug Timeline", "sys_id", "Record Lens", "Playbooks",
      "Customer Updates", "Version Lens", "Variable Prefill", "Variable Values", "Catalog Logic",
      "Variable Insight", "Code Search", "Impersonate", "Search Sources",
      "Update Set Lens", "Table List", "New Record",
    ]
  );
  assert.ok(builtIns.every((item) => item.description));
  assert.ok(builtIns.filter((item) => item.input).every((item) => item.inputLabel));
});

/*
 * Update Set Lens: three words, the owner's deliberate exception to the
 * two-word label rule. It is not an input command, because on a set's form it
 * opens on that set without asking; the description's ellipsis says it asks
 * everywhere else, with the input label and placeholder it carries.
 */
test("Update Set Lens is a Tools command that asks only when the page gives no set", () => {
  const builtIns = loadBuiltCommands();
  const lens = builtIns.find((item) => item.id === "update-set-lens");
  assert.ok(lens);
  assert.strictEqual(lens.label, "Update Set Lens");
  assert.strictEqual(lens.favoriteKey, "update-set-lens");
  assert.strictEqual(lens.group, "Tools");
  assert.strictEqual(lens.description, "Check an update set for stale updates and where it has moved…");
  assert.ok(lens.description.endsWith("…"));
  assert.strictEqual(lens.inputLabel, "Update set name, sys_id or link");
  assert.ok(lens.placeholder);
  assert.strictEqual(lens.input, undefined, "the page decides whether to ask");
  assert.strictEqual(lens.keepOpen, true);
  assert.strictEqual(lens.run.name, "openUpdateSetLens");
  assert.strictEqual(builtIns.filter((item) => item.label.toLowerCase() === "update set lens").length, 1);

  /* Its own label makes it the active row. */
  assert.strictEqual(palette.preparePaletteCommands(builtIns, "Update Set Lens", null)[0].id, "update-set-lens");

  /* "update set" prefixes both it and the Update Sets dev link. Both are a
   * label-prefix match, so the declared group order decides: Tools before Dev
   * Links. Pinned here rather than assumed. */
  const both = palette.preparePaletteCommands(builtIns, "update set", null).map((item) => item.id);
  assert.strictEqual(both[0], "update-set-lens");
  assert.ok(both.includes("devlink-/sys_update_set_list.do"));
  assert.ok(both.indexOf("update-set-lens") < both.indexOf("devlink-/sys_update_set_list.do"));
  /* And the dev link still wins its own label. */
  assert.strictEqual(palette.preparePaletteCommands(builtIns, "Update Sets", null)[0].id, "devlink-/sys_update_set_list.do");

  /* The Tools group keeps its order, Update Set Lens at its end. */
  const tools = builtIns.filter((item) => item.group === "Tools").map((item) => item.label);
  assert.deepStrictEqual(tools, [
    "Translation Lens", "Debug Timeline", "Code Search", "Impersonate", "Search Sources", "Update Set Lens",
  ]);
});

/*
 * Version Lens: a Record command beside Customer Updates, asking only when the
 * page gives no record, like Update Set Lens. The two share keywords
 * ("update set", "collision", "version"), and they sit in different groups,
 * so declaration order never decides between them: the group's best match
 * does, then the declared group order. Each pin below was worked out from that
 * rule and is held here rather than assumed.
 */
test("Version Lens is a Record command that asks only when the page gives no record, and ranks as pinned", () => {
  const builtIns = loadBuiltCommands();
  const lens = builtIns.find((item) => item.id === "version-lens");
  assert.ok(lens);
  assert.strictEqual(lens.label, "Version Lens");
  assert.strictEqual(lens.favoriteKey, "version-lens");
  assert.strictEqual(lens.group, "Record");
  assert.strictEqual(lens.description, "See which update sets hold this record, and which version runs…");
  assert.ok(lens.description.endsWith("…"));
  assert.strictEqual(lens.inputLabel, "Record link, sys_id or update name");
  assert.ok(lens.placeholder);
  assert.strictEqual(lens.input, undefined, "the page decides whether to ask");
  assert.strictEqual(lens.keepOpen, true);
  assert.strictEqual(lens.run.name, "openVersionLens");
  for (const keyword of ["collision", "conflict", "competing", "overwrite", "update set", "customer update",
    "sys_update_xml", "sys_update_version", "captured", "version", "who changed", "history"]) {
    assert.ok(lens.keywords.includes(keyword), keyword);
  }
  assert.strictEqual(builtIns.filter((item) => item.label.toLowerCase() === "version lens").length, 1);
  assert.strictEqual(palette.preparePaletteCommands(builtIns, "Version Lens", null)[0].id, "version-lens");

  /* Declared right after Customer Updates; the Record group keeps its order. */
  const record = builtIns.filter((item) => item.group === "Record").map((item) => item.label);
  assert.deepStrictEqual(record, ["sys_id", "Record Lens", "Playbooks", "Customer Updates", "Version Lens"]);

  /* "version": its label prefix (tier 1) puts Record ahead of Update Set
   * Lens's keyword match in Tools (tier 3). */
  assert.strictEqual(palette.preparePaletteCommands(builtIns, "version", null)[0].id, "version-lens");
  /* "update set": Update Set Lens and the Update Sets link match by label
   * prefix; Version Lens only by keyword and description. */
  const updateSet = palette.preparePaletteCommands(builtIns, "update set", null).map((item) => item.id);
  assert.strictEqual(updateSet[0], "update-set-lens");
  assert.ok(updateSet.includes("version-lens"));
  assert.ok(updateSet.indexOf("update-set-lens") < updateSet.indexOf("version-lens"));
  /* "collision": a keyword of both, so the declared group order decides:
   * Tools, then Record. */
  const collision = palette.preparePaletteCommands(builtIns, "collision", null).map((item) => item.id);
  assert.deepStrictEqual(collision, ["update-set-lens", "version-lens"]);
});

/*
 * Two commands whose labels share a first word, one of them page-conditional.
 * The decision to call it "Translation Assistant" rested on the claim that both
 * still win on their own names; that claim was never executed, because the
 * default harness has no LF page and so never lists the second command.
 */
test("Translation Assistant and Translation Lens coexist and each wins its own label", () => {
  const onLfPage = loadBuiltCommands(null, {
    decodedUrls: ["https://example.service-now.com/sn_lf_comparison_ui.do?sysparm_caller_mode=adhoc"],
  });
  const assistant = onLfPage.find((item) => item.id === "translation-assistant");
  assert.ok(assistant, "the command must be listed on the comparison page");
  assert.strictEqual(assistant.label, "Translation Assistant");
  assert.strictEqual(assistant.description, "Prepare and fill translations");
  assert.strictEqual(assistant.run.name, "runTranslationAssistant");

  /* It is absent everywhere else: an ordinary form must not offer it. */
  assert.ok(!loadBuiltCommands().some((item) => item.id === "translation-assistant"));

  /* No duplicate visible label, and no other validation complaint. */
  palette.validatePaletteCommands(onLfPage);

  for (const label of ["Translation Assistant", "Translation Lens"]) {
    const prepared = palette.preparePaletteCommands(onLfPage, label, null);
    assert.ok(prepared.length > 0, `"${label}" matched nothing`);
    assert.strictEqual(
      prepared[0].label,
      label,
      `typing "${label}" makes "${prepared[0].label}" the active row`
    );
  }

  /* And every other built-in still wins its own name with the extra command in
   * the list, since shared keywords could have moved any of them. */
  for (const cmd of onLfPage) {
    const prepared = palette.preparePaletteCommands(onLfPage, cmd.label, null);
    assert.strictEqual(prepared[0].id, cmd.id, `"${cmd.label}" no longer ranks first`);
  }
});

test("Translation Lens preserves the retired translation-toggle favorite key", () => {
  const translationLens = loadBuiltCommands().find((item) => item.id === "translation-lens");
  assert.ok(translationLens);
  assert.strictEqual(translationLens.favoriteKey, "toggle-translations");
  assert.strictEqual(palette.paletteFavoriteKey(translationLens), "toggle-translations");
  assert.strictEqual(translationLens.keepOpen, true);
  assert.strictEqual(translationLens.description, "Audit translations on this form");
  assert.strictEqual(translationLens.run.name, "showTranslationLens");
});

test("Translation Lens on a Workspace route offers a classic-form link instead of reading", () => {
  /* Same id, label, keywords and favourite key, so a pinned command and a
   * typed search behave identically on both surfaces; only what Enter does
   * changes, and the description says so before it is pressed. Enter shows
   * a notice with a link; it never navigates on its own. */
  const route = {
    experiencePath: ["sow"],
    table: "incident",
    sysId: "00000000000000000000000000000001",
  };
  const classic = loadBuiltCommands().find((item) => item.id === "translation-lens");
  const workspace = loadBuiltCommands(null, { workspaceRoute: route })
    .find((item) => item.id === "translation-lens");
  assert.ok(workspace);
  assert.strictEqual(workspace.label, classic.label);
  assert.strictEqual(workspace.favoriteKey, classic.favoriteKey);
  assert.deepStrictEqual(workspace.keywords, classic.keywords);
  assert.strictEqual(workspace.group, classic.group);
  assert.strictEqual(workspace.description, "Get a link to this record's classic form to audit translations");
  assert.strictEqual(workspace.run.name, "showTranslationLensWorkspaceNotice");
  assert.strictEqual(workspace.keepOpen, true, "the notice lives in the palette toast");
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

test("every result panel wears the shared palette and stops page inheritance at the host", () => {
  /* There is no build step to share CSS, so each panel carries a verbatim copy
   * of the tokens. The Translation Assistant first shipped with a light theme
   * of its own -- white card, green button, no host reset -- and nothing
   * noticed, because nothing compared the copies. Globbed rather than listed,
   * so a panel added later is held to the same rule without anyone
   * remembering to add it here. */
  const root = path.join(__dirname, "..");
  const panels = fs.readdirSync(root).filter((name) => /_ui\.js$/.test(name)).sort();
  assert.ok(panels.length >= 7, "the glob must actually find the panels: " + panels.join(", "));

  for (const file of panels) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /--teal:#31d4c4;--pink:#ff6fae/,
      file + " must use the shared teal and pink, not a palette of its own");
    assert.match(source, /:host\{[^}]*all:initial/,
      file + " must stop the ServiceNow page's inherited font and colour at the shadow host");
    /* A present reset is not an effective one: a later host rule carrying
     * all:inherit undid it while the match above still passed (Codex review,
     * P3). Only a :host rule can undo it -- anything inside the shadow tree
     * inherits from the reset host -- so no host rule may inherit. Node cannot
     * compute styles; the static render's hostile page is where a leak that
     * gets past this would show. */
    for (const block of source.match(/:host[^{]*\{[^}]*\}/g) || []) {
      assert.doesNotMatch(block, /:\s*(?:inherit|unset|revert)\b/,
        file + " must not take anything from the page at the host: " + block);
    }
    assert.doesNotMatch(source, /\ball\s*:\s*(?:inherit|unset|revert)\b/,
      file + " must not reset everything back to the page's values");
  }
});

test("every list panel takes the same share of the screen", () => {
  /* Each panel owns its stylesheet, so the size rule is a copy in every file.
   * The copies had drifted to six different sizes, 880 to 1360 px wide and
   * 680 to 1100 px high, which left most of a large monitor empty. One rule
   * now grows to 1800 px and keeps a 24 px margin on a laptop. Globbed like
   * the palette test above, so a panel added later is held to it. The
   * Translation Assistant is a form read top to bottom whose height fits its
   * content, so it keeps its own size. */
  const root = path.join(__dirname, "..");
  const panels = fs.readdirSync(root)
    .filter((name) => /_ui\.js$/.test(name) && name !== "translation_assistant_ui.js")
    .sort();
  assert.ok(panels.length >= 8, "the glob must actually find the panels: " + panels.join(", "));

  /* The shared size, and the narrow-screen layouts' full-window size. Any
   * other width or height on the panel, a min- or max- one included, is the
   * drift this test exists to stop. */
  const allowed = {
    width: ["min(1800px,calc(100vw - 48px))", "100%"],
    height: ["calc(100vh - 48px)", "calc(100vh - 16px)"],
  };

  for (const file of panels) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const rules = source.match(/\.panel\{[^}]*\}/g) || [];
    assert.ok(
      rules.some((rule) =>
        /(?<![\w-])width:min\(1800px,calc\(100vw - 48px\)\)/.test(rule) &&
        /(?<![\w-])height:calc\(100vh - 48px\)/.test(rule)),
      file + " must use the shared panel size"
    );
    for (const rule of rules) {
      for (const [, property, value] of rule.matchAll(/(?<![\w-])((?:min-|max-)?(?:width|height)):([^;}]*)/g)) {
        assert.ok((allowed[property] || []).includes(value.trim()),
          file + " must not size the panel with " + property + ":" + value.trim());
      }
    }
    /* 100vw counts a page scrollbar and the fixed overlay does not, so with
     * one showing it is the overlay's own padding that keeps the margin. */
    assert.ok(
      (source.match(/\.overlay\{[^}]*\}/g) || []).some((rule) => /padding:24px/.test(rule)),
      file + " must pad its overlay by the same 24 px as the panel's margin"
    );
  }
});

/* ------------------------------------------------------------------ *
 * Admin-only commands: listed only where this session can read
 * sys_update_xml, which stock ServiceNow opens to admins.
 * ------------------------------------------------------------------ */

const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const ADMIN_ONLY_IDS = [
  "open-current-playbook-customer-updates", "open-customer-updates-by-sysid", "open-playbook-executions",
  "refresh-code-search-coverage", "update-set-lens", "version-lens",
];

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, "block not found: " + start);
  return source.slice(from, to);
}

test("without update history access the palette drops exactly the admin-only commands and every Dev Link", () => {
  /* A playbook definition page, so Playbook Updates is listed too. */
  const onPlaybook = { decodedUrls: ["https://example.service-now.com/sys_pd_process_definition.do?sys_id=1"] };
  const built = (access) => loadBuiltCommands(null, Object.assign({ access }, onPlaybook));
  const ids = (access) => built(access).map((item) => item.id);
  const all = ids("unknown");
  const devLinks = built("unknown").filter((item) => item.group === "Dev Links").map((item) => item.id);
  assert.strictEqual(devLinks.length, 12);
  assert.ok(devLinks.every((id) => id.startsWith("devlink-")));
  const hidden = ADMIN_ONLY_IDS.concat(devLinks).sort();
  for (const id of hidden) assert.ok(all.includes(id), id);
  assert.deepStrictEqual(ids("readable"), all, "readable changes nothing");
  const refused = ids("refused");
  assert.deepStrictEqual(all.filter((id) => !refused.includes(id)).sort(), hidden);
  assert.deepStrictEqual(refused, all.filter((id) => !hidden.includes(id)), "everything else keeps its order");
  /* What a non-admin keeps, by label, so a regrouped command shows up here. */
  assert.deepStrictEqual(built("refused").map((item) => item.label), [
    "Translation Lens", "Debug Timeline", "sys_id", "Record Lens", "Variable Prefill", "Variable Values",
    "Catalog Logic", "Variable Insight", "Code Search", "Impersonate", "Table List", "New Record",
  ]);
});

const HERE = "https://example.service-now.com";

function loadAccessCheck(snGetMany) {
  return new Function(
    "snGetMany", "location",
    between(contentSource, "const ADMIN_ONLY_COMMANDS", "function buildCommands()") +
      "\nreturn { checkUpdateHistoryAccess, commandsForAccess," +
      " state: () => ({ access: updateHistoryAccess, asked: updateHistoryAsked }) };"
  )(snGetMany, { origin: HERE });
}

function refusal(status) {
  const error = new Error("refused");
  if (status !== undefined) error.status = status;
  return error;
}

test("the access check is one row of sys_update_xml, uncounted, that a 403 settles", async () => {
  const reads = [];
  const gate = loadAccessCheck(async (...request) => { reads.push(request); return [{ sys_id: "a" }]; });
  assert.deepStrictEqual(gate.state(), { access: "unknown", asked: false });
  const first = gate.checkUpdateHistoryAccess();
  assert.strictEqual(gate.checkUpdateHistoryAccess(), first, "one read in flight, shared");
  await first;
  /* expectedOrigin: a frame embedded from another instance must not answer
   * for this one, either way. */
  assert.deepStrictEqual(reads, [["sys_update_xml", "", "sys_id", 1,
    { expectedOrigin: HERE, requireToken: true, noCount: true, settleOnRefusal: true }]]);
  assert.deepStrictEqual(gate.state(), { access: "readable", asked: true });
  assert.strictEqual(gate.checkUpdateHistoryAccess(), null, "a known answer reads nothing more");
  assert.strictEqual(reads.length, 1);
});

test("only a 403 hides the commands; any other failure leaves them and asks again", async () => {
  const refused = loadAccessCheck(async () => { throw refusal(403); });
  await refused.checkUpdateHistoryAccess();
  assert.deepStrictEqual(refused.state(), { access: "refused", asked: true });
  assert.strictEqual(refused.checkUpdateHistoryAccess(), null);
  assert.deepStrictEqual(refused.commandsForAccess([
    { id: "version-lens", group: "Record" }, { id: "record-search", group: "Record" },
    { id: "devlink-/a_new_link.do", group: "Dev Links" },
  ]), [{ id: "record-search", group: "Record" }], "a Dev Link added later is covered by its group");

  /* A timeout or a frame that never answered (no status), a signed-out
   * session (401), a page with no token (0) or a server fault (500). */
  for (const status of [undefined, 0, 401, 500]) {
    let reads = 0;
    const gate = loadAccessCheck(async () => { reads += 1; throw refusal(status); });
    await gate.checkUpdateHistoryAccess();
    assert.deepStrictEqual(gate.state(), { access: "unknown", asked: true }, String(status));
    assert.deepStrictEqual(gate.commandsForAccess([{ id: "version-lens" }]), [{ id: "version-lens" }]);
    await gate.checkUpdateHistoryAccess();
    assert.strictEqual(reads, 2, "an unanswered check is asked again on the next open");
  }
});

const FULL_LIST = [{ id: "update-set-lens" }, { id: "impersonate" }, { id: "record-search" }];
const NON_ADMIN_LIST = [{ id: "impersonate" }, { id: "record-search" }];

/*
 * The wait, its Enter handling and the placeholder, with the palette around
 * them faked. `page.lists` is what each successive non-waiting draw shows
 * (the last one repeats); like the real renderResults, a draw keeps the row
 * number and clamps it to the new list.
 */
function loadPaletteWait(page) {
  let api = null;
  const timers = [];
  const lists = (page.lists || [FULL_LIST]).slice();
  const factory = new Function(
    "paletteHost", "paletteInput", "paletteList", "paletteCount", "filteredCmds", "activeIndex", "activeInputCmd",
    "paletteAwaitingAccess", "paletteAccessWaitExpired", "paletteFavoriteReady", "paletteEnterPending",
    "PALETTE_ACCESS_WAIT_MS", "PALETTE_CHECKING_TEXT", "updateHistoryAsked",
    "checkUpdateHistoryAccess", "renderResults", "selectCommand", "updateActivePaletteControls", "highlightActive",
    "setTimeout", "clearTimeout", "document",
    between(contentSource, "function renderPaletteWaiting(", "function selectCommand(") +
      "\nreturn { waitForPaletteAccess, runActivePaletteCommand, runPendingPaletteEnter, renderPaletteWaiting," +
      " state: () => ({ waiting: paletteAwaitingAccess, pending: paletteEnterPending })," +
      " expired: () => paletteAccessWaitExpired," +
      " active: () => (filteredCmds[activeIndex] || {}).id || null," +
      " select: (i) => { activeIndex = i; }," +
      " showList: (list) => { filteredCmds = list; activeIndex = Math.max(0, Math.min(activeIndex, list.length - 1)); }," +
      /* openPalette's favourite callback: ready, draw, run a kept Enter. */
      " favoriteLoaded: () => { paletteFavoriteReady = true; renderResults(); runPendingPaletteEnter(); }," +
      " openInput: () => { activeInputCmd = { id: 'an input row' }; }," +
      " close: () => { paletteHost = null; } };"
  );
  const list = {
    innerHTML: "x", children: [], attrs: {},
    appendChild(node) { this.children.push(node); },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
  };
  const count = { textContent: "17 commands" };
  api = factory(
    { id: "snh-palette-host" }, { value: "lens" }, list, count, [], 0, null,
    false, Boolean(page.expired), page.favoriteReady !== false, false,
    1500, "Checking this account's access…", Boolean(page.asked),
    () => page.check,
    /* The real renderResults draws the placeholder while waiting. */
    () => {
      const now = api.state();
      page.renders.push(now.waiting ? "waiting" : "list");
      if (!now.waiting) api.showList(lists.length > 1 ? lists.shift() : lists[0]);
    },
    (cmd) => page.ran.push(cmd ? cmd.id : null),
    () => {},
    () => { page.highlights = (page.highlights || 0) + 1; },
    (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    (handle) => { if (timers[handle - 1]) timers[handle - 1].cleared = true; },
    { createElement: (tag) => ({ tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) }
  );
  return { api, timers, list, count };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("the first open waits for the answer, keeps an early Enter, and runs it once the list is drawn", async () => {
  const answer = deferred();
  const page = { check: answer.promise, renders: [], ran: [] };
  const { api, timers } = loadPaletteWait(page);
  api.waitForPaletteAccess();
  assert.deepStrictEqual(api.state(), { waiting: true, pending: false });
  assert.deepStrictEqual(timers.map((t) => t.ms), [1500]);
  api.runActivePaletteCommand();
  assert.deepStrictEqual(api.state(), { waiting: true, pending: true });
  assert.deepStrictEqual(page.ran, [], "nothing runs before the list is drawn");
  answer.resolve();
  await answer.promise;
  await null;
  assert.deepStrictEqual(page.renders, ["list"]);
  assert.deepStrictEqual(page.ran, ["update-set-lens"], "the kept Enter runs the active row, once");
  assert.deepStrictEqual(api.state(), { waiting: false, pending: false });
  assert.strictEqual(timers[0].cleared, true);
  api.runActivePaletteCommand();
  assert.deepStrictEqual(page.ran, ["update-set-lens", "update-set-lens"], "later Enters run at once");
});

test("past the wait the full list is drawn, and a late answer only redraws it", async () => {
  const answer = deferred();
  const page = { check: answer.promise, renders: [], ran: [] };
  const { api, timers } = loadPaletteWait(page);
  api.waitForPaletteAccess();
  api.runActivePaletteCommand();
  timers[0].fn();
  assert.deepStrictEqual(page.renders, ["list"]);
  assert.deepStrictEqual(page.ran, ["update-set-lens"]);
  assert.strictEqual(api.expired(), true, "the wait ran out on this page");
  answer.resolve();
  await answer.promise;
  await null;
  assert.deepStrictEqual(page.renders, ["list", "list"], "the answer redraws");
  assert.deepStrictEqual(page.ran, ["update-set-lens"], "and runs nothing more");
});

test("a late refusal keeps the highlighted command, not the row number", async () => {
  const answer = deferred();
  const page = { check: answer.promise, lists: [FULL_LIST, NON_ADMIN_LIST], renders: [], ran: [] };
  const { api, timers } = loadPaletteWait(page);
  api.waitForPaletteAccess();
  timers[0].fn();
  api.select(2);
  assert.strictEqual(api.active(), "record-search");
  answer.resolve();
  await answer.promise;
  await null;
  /* Row 2 no longer exists and row 1 is Impersonate: it must stay on Record Lens. */
  assert.strictEqual(api.active(), "record-search");
  assert.ok(page.highlights >= 1, "and the highlight is redrawn");
  api.runActivePaletteCommand();
  assert.deepStrictEqual(page.ran, ["record-search"]);
});

test("a late refusal of the highlighted command itself lands on the first row", async () => {
  const answer = deferred();
  const page = { check: answer.promise, lists: [FULL_LIST, NON_ADMIN_LIST], renders: [], ran: [] };
  const { api, timers } = loadPaletteWait(page);
  api.waitForPaletteAccess();
  timers[0].fn();
  api.select(0);
  assert.strictEqual(api.active(), "update-set-lens");
  answer.resolve();
  await answer.promise;
  await null;
  assert.strictEqual(api.active(), "impersonate");
});

test("a kept Enter waits for the favourite as well as the access answer, whichever comes last", async () => {
  /* Access first, favourite after. */
  const answer = deferred();
  const page = { check: answer.promise, favoriteReady: false, renders: [], ran: [] };
  const { api } = loadPaletteWait(page);
  api.waitForPaletteAccess();
  api.runActivePaletteCommand();
  answer.resolve();
  await answer.promise;
  await null;
  assert.deepStrictEqual(page.ran, [], "the list without its favourite is not the one the Enter was for");
  assert.strictEqual(api.state().pending, true);
  api.favoriteLoaded();
  assert.deepStrictEqual(page.ran, ["update-set-lens"]);
  assert.strictEqual(api.state().pending, false);

  /* Favourite first, access after. */
  const later = deferred();
  const other = { check: later.promise, favoriteReady: false, renders: [], ran: [] };
  const second = loadPaletteWait(other);
  second.api.waitForPaletteAccess();
  second.api.runActivePaletteCommand();
  second.api.favoriteLoaded();
  assert.deepStrictEqual(other.ran, [], "still waiting for the access answer");
  later.resolve();
  await later.promise;
  await null;
  assert.deepStrictEqual(other.ran, ["update-set-lens"]);

  /* No access wait at all: an Enter before the favourite is kept too. */
  const known = { check: null, favoriteReady: false, renders: [], ran: [] };
  const third = loadPaletteWait(known);
  third.api.waitForPaletteAccess();
  third.api.runActivePaletteCommand();
  assert.deepStrictEqual(known.ran, []);
  third.api.favoriteLoaded();
  assert.deepStrictEqual(known.ran, ["update-set-lens"]);
});

test("a kept Enter is dropped, not run, if an input row took the keyboard meanwhile", async () => {
  const answer = deferred();
  const page = { check: answer.promise, renders: [], ran: [] };
  const { api } = loadPaletteWait(page);
  api.waitForPaletteAccess();
  api.runActivePaletteCommand();
  api.openInput();
  answer.resolve();
  await answer.promise;
  await null;
  assert.deepStrictEqual(page.ran, []);
  assert.strictEqual(api.state().pending, false, "and not kept for a later draw");
  api.runPendingPaletteEnter();
  assert.deepStrictEqual(page.ran, []);
});

test("once a wait has run out on a page, later opens draw at once while the check hangs", () => {
  const hanging = new Promise(() => {});
  const page = { check: hanging, expired: true, renders: [], ran: [] };
  const { api, timers } = loadPaletteWait(page);
  api.waitForPaletteAccess();
  assert.deepStrictEqual(api.state(), { waiting: false, pending: false });
  assert.strictEqual(timers.length, 0);
});

test("no wait once a page has an answer, or after a check that answered nothing", async () => {
  const known = { check: null, renders: [], ran: [] };
  const first = loadPaletteWait(known);
  first.api.waitForPaletteAccess();
  assert.deepStrictEqual(first.api.state(), { waiting: false, pending: false });
  assert.strictEqual(first.timers.length, 0);

  const answer = deferred();
  const again = { check: answer.promise, asked: true, renders: [], ran: [] };
  const second = loadPaletteWait(again);
  second.api.waitForPaletteAccess();
  assert.deepStrictEqual(second.api.state(), { waiting: false, pending: false });
  assert.strictEqual(second.timers.length, 0, "the list is drawn as usual meanwhile");
  answer.resolve();
  await answer.promise;
  await null;
  assert.deepStrictEqual(again.renders, ["list"], "a later answer still redraws");
});

test("an answer for a palette that has closed draws nothing and runs nothing", async () => {
  const answer = deferred();
  const page = { check: answer.promise, renders: [], ran: [] };
  const { api, timers } = loadPaletteWait(page);
  api.waitForPaletteAccess();
  api.runActivePaletteCommand();
  api.close();
  answer.resolve();
  await answer.promise;
  await null;
  timers[0].fn();
  assert.deepStrictEqual(page.renders, []);
  assert.deepStrictEqual(page.ran, []);
});

test("while waiting the listbox holds no option or status child: it is busy and the live count speaks", () => {
  const { api, list, count } = loadPaletteWait({ check: null, renders: [], ran: [] });
  api.renderPaletteWaiting();
  assert.strictEqual(list.innerHTML, "");
  assert.strictEqual(list.attrs["aria-busy"], "true");
  assert.strictEqual(list.children.length, 1);
  assert.strictEqual(list.children[0].id, "checking");
  assert.strictEqual(list.children[0].attrs["aria-hidden"], "true", "the visible line is for sight only");
  assert.strictEqual(list.children[0].attrs.role, undefined, "a listbox may own options and groups alone");
  assert.strictEqual(list.children[0].textContent, "Checking this account's access…");
  assert.strictEqual(count.textContent, "Checking this account's access…", "the footer count is the polite live region");
  /* The live region it relies on, and the constant the content script uses. */
  assert.match(contentSource, /<span id="result-count" aria-live="polite"><\/span>/);
  assert.match(contentSource, /const PALETTE_CHECKING_TEXT = "Checking this account's access…";/);
});

test("the palette is wired to the wait: it starts on open, gates Enter and is reset on close", () => {
  const open = between(contentSource, "function openPalette() {", "function closePalette() {");
  assert.ok(open.indexOf("waitForPaletteAccess();") >= 0 && open.indexOf("waitForPaletteAccess();") < open.indexOf("loadPaletteFavorite("));
  assert.match(open, /e\.key === "Enter"\) \{\s*e\.preventDefault\(\);\s*runActivePaletteCommand\(\);/);
  /* The favourite callback marks it ready, draws, then runs a kept Enter. */
  assert.match(open, /paletteFavoriteReady = true;\s*renderResults\(paletteInput\.value\);\s*runPendingPaletteEnter\(\);/);
  const close = between(contentSource, "function closePalette() {", "function isEditablePaletteShortcutTarget(");
  assert.match(close, /paletteAwaitingAccess = false;\s*paletteFavoriteReady = false;\s*paletteEnterPending = false;/);
  assert.ok(!/paletteAccessWaitExpired/.test(close), "a wait that ran out holds for the page, not the open");
  const render = between(contentSource, "function renderResults(query) {", "const cmds = buildCommands();");
  assert.match(render, /if \(paletteAwaitingAccess\) \{\s*renderPaletteWaiting\(\);\s*return;\s*\}\s*paletteList\.removeAttribute\("aria-busy"\);/);
});

function loadTableReadSettles() {
  return new Function(
    between(backgroundSource, "function tableReadSettles(", "/* A read that found nothing") + "\nreturn tableReadSettles;"
  )();
}

/* The MAIN-world reader as it runs in a frame of `origin`. */
function loadTableReader(origin, fetch) {
  return new Function(
    "location", "g_ck", "fetch",
    between(backgroundSource, "async function tableApiGetInPage(", "async function codeSearchApiGetInPage(") +
      "\nreturn tableApiGetInPage;"
  )({ origin }, "tok", fetch);
}

/* The worker's side: one frame's 403 ends the read only when asked to. */
test("a 403 settles the shared table read only for a caller that asks, and never from another instance", () => {
  const settles = loadTableReadSettles();
  assert.strictEqual(settles({ ok: true }, {}), true);
  assert.strictEqual(settles({ ok: false, status: 403 }, {}), false, "other callers wait for a success, as before");
  assert.strictEqual(settles({ ok: false, status: 403 }, { settleOnRefusal: true }), true);
  assert.strictEqual(settles({ ok: false, status: 403, wrongOrigin: true }, { settleOnRefusal: true }), false);
  for (const status of [0, 401, 500]) {
    assert.strictEqual(settles({ ok: false, status }, { settleOnRefusal: true }), false, String(status));
  }
  assert.strictEqual(settles(null, { settleOnRefusal: true }), false);
  const route = between(backgroundSource, 'if (msg && msg.type === "SN_TABLE_GET"', 'if (msg && msg.type === "SN_TRANSLATION_GET"');
  assert.match(route, /accept: \(value\) => tableReadSettles\(value, request\.options\)/);
});

test("with the check's own options, a frame of another instance answers for neither side", async () => {
  const reads = [];
  await loadAccessCheck(async (...request) => { reads.push(request); return []; }).checkUpdateHistoryAccess();
  const [table, query, fields, limit, options] = reads[0];
  const request = { table, query, fields, limit, options };
  const settles = loadTableReadSettles();
  const answer = (status) => async () => ({ ok: status === 200, status, json: async () => ({ result: [{ sys_id: "a" }] }) });
  const OTHER = "https://other.service-now.com";

  /* Refused there, or readable there: either way that frame is out. */
  for (const status of [403, 200]) {
    const there = await loadTableReader(OTHER, answer(status))(request);
    assert.deepStrictEqual([there.ok, there.wrongOrigin, there.status], [false, true, 0], String(status));
    assert.strictEqual(settles(there, options), false, String(status));
  }
  /* This instance's own refusal still settles it. */
  const here = await loadTableReader(HERE, answer(403))(request);
  assert.strictEqual(here.status, 403);
  assert.strictEqual(settles(here, options), true);
});

test("noCount adds sysparm_no_count only when asked", async () => {
  const urls = [];
  const reader = loadTableReader(HERE,
    async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ result: [] }) }; });
  const request = { table: "sys_update_xml", query: "", fields: "sys_id", limit: 1 };
  await reader(Object.assign({ options: { noCount: true, requireToken: true, settleOnRefusal: true } }, request));
  await reader(Object.assign({ options: {} }, request));
  assert.strictEqual(new URL(urls[0]).searchParams.get("sysparm_no_count"), "true");
  assert.strictEqual(urls[0].replace("&sysparm_no_count=true", ""), urls[1], "the option adds exactly one parameter");
  assert.ok(!urls[1].includes("sysparm_no_count"));
});

test("result panels use the same stable feature headings", () => {
  const files = {
    "record_search_ui.js": /<h2>Record Lens<\/h2>/,
    "catalog_insight_ui.js": /<h2 id="snh-catalog-insight-title">Catalog Logic<\/h2>/,
    "code_search_ui.js": /<h2>Code Search <span class="term"><\/span><\/h2>/,
    "hidden_variables_ui.js": /const panelTitle = workspaceMode[\s\S]*\["stored-only", "no-editor-empty", "no-candidate"\][\s\S]*\? "Stored Variables"[\s\S]*: "Variable Values"[\s\S]*<h2 id="snh-hidden-title">\$\{panelTitle\} /,
    "debug_timeline_ui.js": /<h2 id="snh-debug-title">Debug Timeline /,
    "translation_lens_ui.js": /el\("h2", "", "Translation Lens"\)/,
    "translation_assistant_ui.js": /el\("h2", "", "Translation Assistant"\)/,
    "update_set_lens_ui.js": /el\("h2", "", "Update Set Lens"\)/,
    "version_lens_ui.js": /el\("h2", "", "Version Lens"\)/,
  };

  for (const [file, pattern] of Object.entries(files)) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.match(source, pattern, file);
  }
});

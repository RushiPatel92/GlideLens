/*
 * Translation Assistant runtime-boundary tests. No browser or live instance.
 *
 * The engine suite covers what is a pure function; this covers what is not:
 * the frame routing, the worker routes, the panel contract content.js depends
 * on, the packaging allowlist, and the rules that only exist as source.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const contentSource = read("content.js");
const backgroundSource = read("background.js");
const packageSource = read("package.mjs");
const uiSource = read("translation_assistant_ui.js");
const engineSource = read("translation_assistant.js");
const manifestSource = read("manifest.json");

/* Comments stripped, for the assertions that must look at code rather than at
 * the prose describing it. These files document the prohibitions they keep, so
 * a search for "innerHTML" finds the sentence promising not to use it. */
const stripComments = (source) =>
  String(source).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
const uiCode = stripComments(uiSource);

/* Line endings are normalised before any search: a Windows working copy has
 * CRLF while the repository stores LF, so a sentinel spanning a newline would
 * match or fail on how the tree was checked out rather than on the code. */
function between(source, startText, endText) {
  const text = String(source).replace(/\r\n/g, "\n");
  const start = text.indexOf(startText);
  const end = text.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, "source block not found: " + startText);
  return text.slice(start, end);
}

test("the content script pins the complete panel contract it depends on", () => {
  const declared = between(contentSource, "const TRANSLATION_ASSISTANT_UI_METHODS = [", "];");
  ["open", "showDraft", "showError", "close"].forEach((method) => {
    assert.ok(declared.includes('"' + method + '"'), method + " must be in the pinned contract");
    assert.ok(
      new RegExp("^\\s{4}" + method + ",$", "m").test(uiSource.replace(/\r\n/g, "\n")),
      method + " must actually be exported by the panel"
    );
  });
  /* Phase 2 ships no write path, so the panel must not be claiming one. */
  assert.ok(!/showPreview|applyRows|onApply/.test(uiSource),
    "the apply step belongs to phase 3; the panel must not pretend to offer it");
});

test("the command is listed from the URL and only acts on a probed scope", () => {
  const listing = between(contentSource, "const isLfComparisonPage", "const cmds = [");
  assert.ok(listing.includes("decodedVariants(location.href)"),
    "the page usually runs in gsft_main, so the decoded URL is what the palette frame can see");
  assert.ok(listing.includes("LF_COMPARISON_PAGE_MARKER"));

  const command = between(contentSource, '...(isLfComparisonPage', ': []),');
  assert.ok(command.includes('label: "Translation Assistant"'));
  assert.ok(command.includes('description: "Prepare and fill translations"'));
  assert.ok(command.includes("run: runTranslationAssistant"));

  /* The URL is a claim; the scope is the evidence. The run path must refuse on
   * what the probe says rather than on what the URL implied. */
  const runner = between(contentSource, "async function runTranslationAssistant(", "function translationLensUi(");
  assert.ok(runner.includes("GET_LF_ASSISTANT_CONTEXT"));
  assert.ok(runner.includes("if (!response.selected)"),
    "no selected frame must end in a stated refusal, never a half-populated draft");
  assert.ok(runner.includes("translationAssistantRefusal"));
});

test("a refusal distinguishes the wrong mode from the wrong page", () => {
  const refusal = between(contentSource, "function translationAssistantRefusal(", "async function runTranslationAssistant(");
  assert.ok(refusal.includes("isAdhoc === false"),
    "ad-hoc is the only mode this build handles, and saying so is not the same as saying the page is missing");
  assert.ok(/not in ad-hoc mode/.test(refusal));
  assert.ok(/Edit Translations/.test(refusal), "the other case has to say where to go");
});

test("the context read resolves frames fresh and caches no frame handle", () => {
  const reader = between(backgroundSource, "async function readLfAssistantContext(", "/* ------");
  assert.ok(reader.includes("injectInDiscoveredFrames"), "per-frame injection, not allFrames");
  assert.ok(!/allFrames/.test(reader));
  assert.ok(reader.includes('world: "MAIN"'), "the Angular scope is only reachable from the MAIN world");

  /* The frame id may be reported, but nothing may keep it: a reload gives the
   * same page a new id, and a cached one would refuse every returning draft. */
  const runner = between(contentSource, "async function runTranslationAssistant(", "function translationLensUi(");
  assert.ok(!/frameId/.test(runner.replace(/\/\*[\s\S]*?\*\//g, "")),
    "the orchestrator must not carry a frame id into the draft");
  const stored = between(engineSource, "function storedDraft(", "}");
  assert.ok(!/frameId/.test(stored), "and the persisted draft must not hold one either");
});

test("the MAIN-world reader reports why a frame is not the page", () => {
  const inspector = between(backgroundSource, "function inspectLfAssistantContext(", "function selectLfAssistantFrame(");
  ["no .main-content in this frame", "no page-owned angular", "not the comparison UI"].forEach((reason) => {
    assert.ok(inspector.includes(reason), "missing a distinct reason: " + reason);
  });
  assert.ok(inspector.includes("isAdhocMode"));
  /* All three independent reasons a field is un-editable are read, not inferred
   * from a lock, and the accessor that can throw has its own guard. */
  assert.ok(inspector.includes("isReadOnlyMode"));
  assert.ok(inspector.includes("isLastRequestInProgress"));
  assert.ok(between(inspector, "out.requestInProgress = null;", "const params").includes("catch"),
    "isLastRequestInProgress throws when additionalInfo is undefined, so it needs its own guard");
  /* The bound copy, so text the user has typed but not published survives. */
  assert.ok(inspector.includes("retrieveCurrentContent"));
  assert.ok(inspector.includes("groupedItemsToTranslate"));
});

test("the reader never writes to the page", () => {
  const inspector = between(backgroundSource, "function inspectLfAssistantContext(", "function selectLfAssistantFrame(");
  ["updateDocumentContent", "CustomEvent.fire", "translatedValue =", "$apply"].forEach((write) => {
    assert.ok(!inspector.includes(write), "phase 2 ships no write path: found " + write);
  });
  assert.ok(!/APPLY_LF_ASSISTANT/.test(backgroundSource), "the apply route belongs to phase 3");
  assert.ok(!/APPLY_LF_ASSISTANT/.test(contentSource));
});

test("the draft is persisted in session memory, through the engine's own cap", () => {
  const store = between(backgroundSource, "const LF_ASSISTANT_DRAFTS_KEY", "// Self-contained MAIN-world reader for classic RITM");
  assert.ok(store.includes("chrome.storage.session"), "memory, so the item's text never reaches the profile");
  assert.ok(!/storage\.local|storage\.sync/.test(store));
  assert.ok(store.includes("putDraft") && store.includes("getDraft"),
    "the cap and the lookup come from the engine rather than being written twice");
  assert.ok(/importScripts\("translation_assistant\.js"\)/.test(backgroundSource),
    "which is why the worker imports the engine");

  /* No new permission: storage already covers .session. */
  const manifest = JSON.parse(manifestSource);
  assert.deepStrictEqual(manifest.permissions, ["scripting", "storage", "clipboardWrite"]);
  assert.ok(!manifest.permissions.includes("downloads"),
    "an object URL on an <a download> needs no downloads permission");
});

test("the draft is held before it is shown", () => {
  const runner = between(contentSource, "async function runTranslationAssistant(", "function translationLensUi(");
  const save = runner.indexOf("SAVE_LF_ASSISTANT_DRAFT");
  const show = runner.indexOf("ui.showDraft(");
  assert.ok(save > 0 && show > save,
    "a file the user can download must already be addressable by a reply when they get it");
  assert.ok(between(runner, "SAVE_LF_ASSISTANT_DRAFT", "ui.showDraft(").includes("throw new Error"),
    "and a store that refused must stop the draft being offered at all");
});

test("both output routes write the one string the engine serialised", () => {
  const download = between(uiSource, "function download(draft, button)", "async function copy(draft)");
  const copy = between(uiSource, "async function copy(draft)", "function showDraft(");
  assert.ok(download.includes("str(draft && draft.serialized)"));
  assert.ok(copy.includes("str(draft && draft.serialized)"));
  /* The panel must not assemble a payload: that is how the file came to ship
   * without the instructions the clipboard route had. */
  assert.ok(!/JSON\.stringify/.test(download + copy));
  assert.ok(download.includes("revokeObjectURL"), "the object URL is released");
  /* One button, one text link - never two buttons of equal weight. */
  const body = between(uiSource, 'const primary = el("div", "primary");', "if (draft.counts");
  assert.strictEqual((body.match(/el\("button", "secondary"/g) || []).length, 1);
  assert.ok(body.includes('"Download JSON"'));
  assert.ok(body.includes('"Copy prompt + JSON instead"'));
});

test("the panel renders instance text only through textContent", () => {
  /* Comments are stripped first: this file documents the prohibitions it keeps,
   * so a naive search finds the prose rather than the code. */
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(uiCode),
    "reply and page text are untrusted input; textContent is the whole control");
  /* The closed root is not what makes that safe, and the file says so. */
  assert.ok(/attachShadow\(\{ mode: "closed" \}\)/.test(uiCode));
  assert.ok(uiSource.includes("does nothing about what this file renders"));
});

test("every exclusion bucket the engine can report has panel wording", () => {
  const context = { globalThis: null, crypto: nodeCrypto.webcrypto };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(engineSource, context, { filename: "translation_assistant.js" });
  const reasons = Object.values(context.SNTranslationAssistant.REASON);
  const buckets = between(uiSource, "const BUCKETS = [", "];");
  reasons.forEach((reason) => {
    assert.ok(buckets.includes('key: "' + reason + '"'),
      "no reason may be counted without being named: " + reason);
  });
});

test("the panel does not repeat the platform's claim that locked means verified", () => {
  /* The platform's own tooltip says locked fields contain verified
   * translations. In ad-hoc mode the flag is derived from whether a translation
   * exists, so an unreviewed machine translation sets it just as firmly, and no
   * wording the user reads may repeat the claim. */
  assert.ok(!/verified/i.test(uiCode),
    "no user-facing string may call a locked field verified");
  assert.ok(uiCode.includes("unlock it on this page first"),
    "and the workflow that follows from that has to be stated");
});

test("engine and panel are packaged lazily and injected together", () => {
  const ship = between(packageSource, "const SHIP = [", "];");
  assert.ok(ship.includes('"translation_assistant.js"'),
    "a file absent from SHIP ships nothing and the feature dies silently in the packaged build");
  assert.ok(ship.includes('"translation_assistant_ui.js"'));

  const manifest = JSON.parse(manifestSource);
  const declared = manifest.content_scripts[0].js;
  assert.ok(!declared.includes("translation_assistant.js"), "injected on first use, not at document_idle");
  assert.ok(!declared.includes("translation_assistant_ui.js"));

  const route = between(backgroundSource, 'INJECT_TRANSLATION_ASSISTANT', "return true;");
  assert.ok(route.includes('files: ["translation_assistant.js", "translation_assistant_ui.js"]'));
  assert.ok(route.includes("frameIds: [sender.frameId || 0]"), "into the frame that asked");
  assert.ok(!route.includes('world: "MAIN"'), "the engine and panel belong to the isolated world");
});

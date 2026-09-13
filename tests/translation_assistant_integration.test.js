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
  /* The fill is a callback, not a fifth method: the panel asks, the worker
   * writes, and the contract content.js pins does not grow. */
  const runner = between(contentSource, "async function runTranslationAssistant(", "function translationLensUi(");
  assert.ok(/onFill: \(request\) => fillTranslationAssistantReply\(request\)/.test(runner));
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
    assert.ok(!inspector.includes(write), "the context read must not write: found " + write);
  });
});

test("the one write is the page's own event, fired by the worker into one frame", () => {
  /* Phase 3 replaces phase 2's "no write path" assertions with the shape of
   * the write there now is. */
  const writer = between(backgroundSource, "async function writeLfAssistantContent(", "const LF_ASSISTANT_APPLY_TIMEOUT_MS");
  assert.strictEqual((stripComments(writer).match(/CustomEvent\.fire\(/g) || []).length, 1);
  assert.ok(writer.includes('"updateDocumentContent"'));
  assert.ok(!writer.includes("$apply"), "the page's own listener runs the digest");
  assert.ok(!/translatedValue\s*=[^=]/.test(writer), "the writer sets no value itself; the engine's merge does");
  assert.ok(/const changedAt = differenceAt\(before, request\.base, ""\);/.test(writer),
    "it fires only when the page still holds what the merge was built from");

  ["content.js", "translation_assistant_ui.js"].forEach((name) => {
    const source = name === "content.js" ? contentSource : uiSource;
    assert.ok(!/CustomEvent\.fire|updateDocumentContent/.test(stripComments(source)),
      name + " must not write to the page; only the worker's writer does");
  });

  const apply = between(backgroundSource, "async function applyLfAssistantReply(", "/* ------");
  assert.ok(apply.includes('world: "MAIN"'));
  assert.ok(apply.includes("frameIds: [read.selected.frameId]"),
    "one frame: the one this fill's own fresh read selected");
  assert.ok(!/allFrames/.test(apply));
  assert.ok(apply.includes("readLfAssistantContext(tabId)"), "read fresh on every fill");
  assert.ok(/msg\.type === "APPLY_LF_ASSISTANT" && sender\.tab/.test(backgroundSource));
});

test("a navigation or a closed tab releases the fill lock", () => {
  const updated = between(backgroundSource, "chrome.tabs.onUpdated.addListener(", "\n});");
  assert.ok(updated.includes("releaseLfAssistantApplyLock(tabId, null)"));
  const removed = between(backgroundSource, "chrome.tabs.onRemoved.addListener(", "\n});");
  assert.ok(removed.includes("releaseLfAssistantApplyLock(tabId, null)"));
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

/* The behavioural version of this lives at the end of the file. A source-order
 * check is kept as well because it is the cheap guard: it fails loudly if the
 * save is ever moved after the render, which is the shape of the mistake. */
test("the draft is held before it is shown, in source order", () => {
  const runner = between(contentSource, "async function runTranslationAssistant(", "function translationLensUi(");
  const save = runner.indexOf("SAVE_LF_ASSISTANT_DRAFT");
  const show = runner.indexOf("ui.showDraft(");
  assert.ok(save > 0 && show > save,
    "a file the user can download must already be addressable by a reply when they get it");
});

test("both output routes write the one string the engine serialised", () => {
  const download = between(uiSource, "function download(draft, button)", "async function copy(draft, link)");
  const copy = between(uiSource, "async function copy(draft, link)", "function showDraft(");
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

/* ==================================================================== *
 * Behavioural: the worker's draft store and the content script's runner
 * are executed here, not read.
 *
 * Codex's phase 2 review, 2026-09-10, found four defects that a source
 * assertion cannot see, and one of them was in the assertion above: it
 * checked that a save appears before a render in the TEXT of the file,
 * which a fire-and-forget save satisfies just as well as an awaited one.
 * The blocks below are lifted from their real files by the same anchors
 * the source tests use -- move one and these fail loudly rather than
 * silently testing nothing.
 * ==================================================================== */

const engineSourceText = read("translation_assistant.js");

function deferred() {
  const box = {};
  box.promise = new Promise((resolve, reject) => {
    box.resolve = resolve;
    box.reject = reject;
  });
  return box;
}

/* Lets every already-queued microtask run before the test looks. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ *
 * The worker's draft store
 * ------------------------------------------------------------------ */

function loadDraftStore(options) {
  const opts = options || {};
  const block = between(
    backgroundSource,
    "const LF_ASSISTANT_DRAFTS_KEY",
    "// Self-contained MAIN-world reader for classic RITM"
  );
  const context = { globalThis: null, crypto: nodeCrypto.webcrypto, console, Promise };
  context.globalThis = context;

  const cell = {};
  let writes = 0;
  context.chrome = {
    storage: {
      session: {
        get(key) {
          /* A real storage.get is asynchronous. Resolving it a tick late is
           * what lets two callers read the same store before either writes,
           * which is the whole of finding 1. */
          const answer = Object.prototype.hasOwnProperty.call(cell, key)
            ? { [key]: cell[key] } : {};
          return opts.slowGet
            ? new Promise((resolve) => setImmediate(() => resolve(answer)))
            : Promise.resolve(answer);
        },
        set(item) {
          writes += 1;
          /* Lets a test hold one write open, so the next save is genuinely
           * queued behind it rather than merely started later. */
          const gate = opts.holdSet && opts.holdSet(writes);
          return Promise.resolve(gate || null).then(() => {
            Object.assign(cell, item);
          });
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(engineSourceText, context, { filename: "translation_assistant.js" });
  vm.runInContext(block, context, { filename: "background.js (draft store)" });
  return { context, cell };
}

function storedDraftFixture(exportId) {
  return {
    exportId,
    identity: {
      artifactInternalName: "catalog_item",
      artifactSysId: "0".repeat(31) + "1",
      sourceLanguage: "en",
      targetLanguage: "fr",
    },
    elementCount: 1,
    createdAt: 1000,
    map: { 1: { elementId: "Variable: Cost centre: Question", fieldIndex: 0, members: [] } },
  };
}

test("two saves in flight at once both survive", async () => {
  const store = loadDraftStore({ slowGet: true });
  const first = "a".repeat(32);
  const second = "c".repeat(32);

  await Promise.all([
    store.context.saveLfAssistantDraft(storedDraftFixture(first)),
    store.context.saveLfAssistantDraft(storedDraftFixture(second)),
  ]);

  /* Both callers were told the draft was held, and the panel offers a
   * downloadable file on the strength of that. A file whose draft was
   * overwritten by a concurrent save is a file no reply can address. */
  assert.ok(await store.context.readLfAssistantDraft(first),
    "the first draft was reported saved, so it has to be there");
  assert.ok(await store.context.readLfAssistantDraft(second));
});

test("a save cancelled while it waits in the queue is never written", async () => {
  /* The second round of the review, 2026-09-10. Gating the runner before it
   * sends the save closes the window during the page read; it does nothing
   * about the window between the send and the worker's write, which the new
   * write queue can hold open for as long as another save takes. */
  const gate = deferred();
  const store = loadDraftStore({ slowGet: true, holdSet: (n) => (n === 5 ? gate.promise : null) });
  const early = ["0", "1", "2", "3"].map((n) => n.padStart(32, "e"));
  for (const id of early) {
    await store.context.saveLfAssistantDraft(storedDraftFixture(id));
  }

  const blocking = "f".repeat(32);
  const abandoned = "9".repeat(32);
  const held = store.context.saveLfAssistantDraft(storedDraftFixture(blocking));
  const doomed = store.context.saveLfAssistantDraft(storedDraftFixture(abandoned), "ta-9-1000");
  await settle();

  store.context.cancelLfAssistantDraft("ta-9-1000");
  gate.resolve();
  await Promise.all([held, doomed]);

  assert.strictEqual(await store.context.readLfAssistantDraft(abandoned), null,
    "a draft nobody ever saw must not be written");
  assert.ok(await store.context.readLfAssistantDraft(early[0]),
    "and must not evict a draft the user may already have downloaded");
});

test("a cancellation is not forgotten while its save is still queued", async () => {
  /* Third round, 2026-09-10. The recall list was bounded at 20 and evicted
   * oldest-first with no regard for whether the save it spoke for had run.
   * Twenty later cancellations therefore un-cancelled a queued one. */
  const gate = deferred();
  const store = loadDraftStore({ slowGet: true, holdSet: (n) => (n === 1 ? gate.promise : null) });

  const blocking = "f".repeat(32);
  const abandoned = "9".repeat(32);
  const held = store.context.saveLfAssistantDraft(storedDraftFixture(blocking));
  const doomed = store.context.saveLfAssistantDraft(storedDraftFixture(abandoned), "ta-1-1000");
  await settle();

  store.context.cancelLfAssistantDraft("ta-1-1000");
  /* Enough unrelated dismissals to push it out of a 20-entry history. */
  for (let index = 0; index < 20; index += 1) {
    store.context.cancelLfAssistantDraft("ta-noise-" + index);
  }

  gate.resolve();
  const [, result] = await Promise.all([held, doomed]);
  assert.strictEqual(result.cancelled, true,
    "a recall that has not been acted on yet cannot expire");
  assert.strictEqual(await store.context.readLfAssistantDraft(abandoned), null);
});

test("one tab's recall cannot drop another tab's draft", async () => {
  /* Tokens are minted per frame as ta-<n>-<Date.now()>, so two tabs starting
   * their first run in the same millisecond mint the same one. The worker has
   * one queue for every tab, so it scopes the token by sender. */
  const store = loadDraftStore({ slowGet: true });
  const key = store.context.lfAssistantRunKey;
  const mine = "a".repeat(32);

  const save = store.context.saveLfAssistantDraft(
    storedDraftFixture(mine), key({ tab: { id: 7 } }, "ta-1-1000")
  );
  store.context.cancelLfAssistantDraft(key({ tab: { id: 9 } }, "ta-1-1000"));
  const result = await save;

  assert.strictEqual(result.cancelled, false);
  assert.ok(await store.context.readLfAssistantDraft(mine),
    "a dismissal in one tab must not discard what another tab is holding");
});

test("both draft routes scope the run token to the sender", () => {
  const save = between(backgroundSource, '"SAVE_LF_ASSISTANT_DRAFT" && sender.tab', "return true;");
  const cancel = between(backgroundSource, '"CANCEL_LF_ASSISTANT_DRAFT" && sender.tab', "return true;");
  assert.ok(/lfAssistantRunKey\(sender, msg\.runToken\)/.test(save));
  assert.ok(/lfAssistantRunKey\(sender, msg\.runToken\)/.test(cancel),
    "a raw token from one tab would address another tab's queued save");
});

test("the panel's links take the same guarded route as Translation Lens", () => {
  const runner = between(contentSource, "async function runTranslationAssistant(", "function translationLensUi(");
  assert.ok(/onOpenUrl: \(url\) => openTranslationUrl\(url\)/.test(runner),
    "the shared-translation links go through the same same-origin check the Lens uses");

  /* Executed rather than searched for: the source check this replaces kept
   * passing with the origin comparison disabled (Codex review, P3). */
  const guard = between(contentSource, "function openTranslationUrl(", "const TRANSLATION_LENS_WORKSPACE_MESSAGE");
  const sent = [];
  const context = {
    URL,
    location: { origin: "https://example.service-now.com" },
    chrome: { runtime: { sendMessage: (message) => { sent.push(message); return Promise.resolve(); } } },
  };
  vm.createContext(context);
  vm.runInContext(guard, context, { filename: "content.js (openTranslationUrl)" });

  context.openTranslationUrl("/sys_translated_list.do?sysparm_query=language%3Dfr");
  assert.strictEqual(sent.length, 1, "a same-origin link reaches the worker");
  assert.strictEqual(sent[0].type, "OPEN_URL");
  assert.strictEqual(sent[0].url,
    "https://example.service-now.com/sys_translated_list.do?sysparm_query=language%3Dfr");

  for (const url of [
    "https://elsewhere.example.com/sys_translated_list.do",
    "//elsewhere.example.com/sys_translated_list.do",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => context.openTranslationUrl(url), /stay on this instance|invalid/, url);
  }
  assert.strictEqual(sent.length, 1, "and nothing refused ever does");
});

test("the store still caps at the engine's limit under concurrency", async () => {
  const store = loadDraftStore({ slowGet: true });
  const ids = [];
  for (let index = 0; index < 8; index += 1) {
    ids.push(String(index).padStart(32, "d"));
  }
  await Promise.all(ids.map((id) => store.context.saveLfAssistantDraft(storedDraftFixture(id))));
  const held = store.cell.translationAssistantDrafts;
  assert.ok(held.drafts.length <= 5, "the engine's cap is not widened by serialising writes");
  /* The cap keeps the newest, so the last one written must still be there. */
  assert.ok(await store.context.readLfAssistantDraft(ids[ids.length - 1]));
});

/* ------------------------------------------------------------------ *
 * The content script's runner
 * ------------------------------------------------------------------ */

const LF_CONTENT_FIXTURE = [{
  groupName: "Variable: Cost centre",
  label: "Question",
  id: "Variable: Cost centre: Question",
  isInternal: false,
  fieldInfo: [{
    originalValue: "Cost centre",
    textType: "plain",
    isFieldLocked: false,
    additionalParameters: {
      sysId: "e".repeat(32),
      name: "question_text",
      type: "translated_field",
      table: "question",
      scope: "global",
    },
  }],
}];

function loadRunner(options) {
  const opts = options || {};
  const block = between(
    contentSource,
    "const TRANSLATION_ASSISTANT_UI_METHODS",
    "function translationLensUi("
  );
  const context = {
    globalThis: null,
    crypto: nodeCrypto.webcrypto,
    console,
    Promise,
    Date,
    setTimeout,
  };
  context.globalThis = context;

  const calls = [];
  const toasts = [];
  const sent = [];
  let captured = null;

  const panel = {
    open(request) {
      captured = request.callbacks || {};
      calls.push({ method: "open", fingerprint: request.fingerprint });
      return true;
    },
    showDraft(request) {
      calls.push({ method: "showDraft", fingerprint: request.fingerprint, draft: request.draft });
      return true;
    },
    showError(request) {
      calls.push({ method: "showError", fingerprint: request.fingerprint, message: request.message });
      return true;
    },
    close() { return true; },
  };

  context.showToast = (message, isError) => toasts.push({ message, isError: !!isError });
  context.chrome = {
    runtime: {
      sendMessage(message) {
        sent.push(message);
        return opts.send(message, { context, panel });
      },
    },
  };

  vm.createContext(context);
  vm.runInContext(engineSourceText, context, { filename: "translation_assistant.js" });
  /* The language-name read goes through the content script's shared Table API
   * helper, which lives outside the block. Lifted too, so the read reaches the
   * messaging shim rather than dying on a missing name inside a catch. */
  vm.runInContext(
    between(contentSource, "async function snGetMany(", "function snFieldValue("),
    context,
    { filename: "content.js (snGetMany)" }
  );
  vm.runInContext(block, context, { filename: "content.js (assistant block)" });
  if (opts.panelPresent !== false) context.SNTranslationAssistantUI = panel;

  return {
    context,
    calls,
    toasts,
    sent,
    panel,
    dismiss() {
      assert.ok(captured && typeof captured.onClose === "function",
        "the panel is opened with an onClose the runner uses to learn about a dismissal");
      captured.onClose("close-button");
    },
    fill(request) {
      assert.ok(captured && typeof captured.onFill === "function",
        "the panel is opened with an onFill that carries its reply to the worker");
      return captured.onFill(request);
    },
    of(method) { return calls.filter((entry) => entry.method === method); },
  };
}

function contextAnswer(overrides) {
  return {
    ok: true,
    selected: {
      frameId: 5,
      context: Object.assign({
        isLfPage: true,
        isAdhoc: true,
        artifactInternalName: "catalog_item",
        artifactSysId: "0".repeat(31) + "1",
        sourceLanguage: "en",
        targetLanguage: "fr",
        content: LF_CONTENT_FIXTURE,
        elementCount: 1,
      }, overrides || {}),
    },
    rejected: [],
  };
}

test("a run dismissed while the page is being read saves nothing", async () => {
  const contextRead = deferred();
  const harness = loadRunner({
    send(message) {
      if (message.type === "GET_LF_ASSISTANT_CONTEXT") return contextRead.promise;
      return Promise.resolve({ ok: true });
    },
  });

  const run = harness.context.runTranslationAssistant();
  await settle();
  harness.dismiss();
  contextRead.resolve(contextAnswer());
  await run;

  assert.ok(!harness.sent.some((message) => message.type === "SAVE_LF_ASSISTANT_DRAFT"),
    "an abandoned run must not write to a store that outlives it");
  assert.strictEqual(harness.of("showDraft").length, 0);
  assert.strictEqual(harness.of("showError").length, 0, "nobody is watching, so nothing is reported");
});

test("dismissing a run cancels the save it has already handed to the worker", async () => {
  const save = deferred();
  const harness = loadRunner({
    send(message) {
      if (message.type === "GET_LF_ASSISTANT_CONTEXT") return Promise.resolve(contextAnswer());
      if (message.type === "SAVE_LF_ASSISTANT_DRAFT") return save.promise;
      return Promise.resolve({ ok: true });
    },
  });

  const run = harness.context.runTranslationAssistant();
  await settle();
  const sent = harness.sent.find((message) => message.type === "SAVE_LF_ASSISTANT_DRAFT");
  assert.ok(sent, "the save is in flight before the user dismisses");
  assert.ok(sent.runToken, "and it carries the run's own token, so it can still be recalled");

  harness.dismiss();
  save.resolve({ ok: true, held: 5 });
  await run;

  const cancel = harness.sent.find((message) => message.type === "CANCEL_LF_ASSISTANT_DRAFT");
  assert.ok(cancel, "a dismissal has to reach the queue the save is sitting in");
  assert.strictEqual(cancel.runToken, sent.runToken);
  assert.strictEqual(harness.of("showDraft").length, 0);
});

test("starting another run recalls the save the previous one left queued", async () => {
  /* ui.open() unmounts the old panel without firing onClose, so a replacement
   * run supersedes its predecessor everywhere except in the one place that
   * could still write. */
  const firstSave = deferred();
  let saves = 0;
  const harness = loadRunner({
    send(message) {
      if (message.type === "GET_LF_ASSISTANT_CONTEXT") return Promise.resolve(contextAnswer());
      if (message.type === "SAVE_LF_ASSISTANT_DRAFT") {
        saves += 1;
        return saves === 1 ? firstSave.promise : Promise.resolve({ ok: true, held: 1 });
      }
      return Promise.resolve({ ok: true });
    },
  });

  const first = harness.context.runTranslationAssistant();
  await settle();
  const firstSent = harness.sent.find((message) => message.type === "SAVE_LF_ASSISTANT_DRAFT");
  assert.ok(firstSent && firstSent.runToken, "the first run's save is in flight");

  const second = harness.context.runTranslationAssistant();
  await settle();

  const recall = harness.sent.find((message) =>
    message.type === "CANCEL_LF_ASSISTANT_DRAFT" && message.runToken === firstSent.runToken);
  assert.ok(recall, "a superseded run's draft must not be written any more than a dismissed one's");

  firstSave.resolve({ ok: true, held: 1 });
  await Promise.all([first, second]);
  assert.strictEqual(harness.of("showDraft").length, 1, "only the run the user is watching renders");
});

test("a slow first run never opens over the panel a later run already owns", async () => {
  const loads = [deferred(), deferred()];
  let injections = 0;
  const harness = loadRunner({
    panelPresent: false,
    send(message, tools) {
      if (message.type === "INJECT_TRANSLATION_ASSISTANT") {
        const box = loads[injections];
        injections += 1;
        return box.promise.then(() => {
          tools.context.SNTranslationAssistantUI = tools.panel;
          return { ok: true };
        });
      }
      if (message.type === "GET_LF_ASSISTANT_CONTEXT") return Promise.resolve(contextAnswer());
      return Promise.resolve({ ok: true, held: 1 });
    },
  });

  const first = harness.context.runTranslationAssistant();
  const second = harness.context.runTranslationAssistant();
  await settle();

  /* The user's second invocation wins the race to load. */
  loads[1].resolve();
  await settle();
  loads[0].resolve();
  await Promise.all([first, second]);

  const opens = harness.of("open");
  assert.strictEqual(opens.length, 1, "the older run must not replace the panel the user is looking at");
  const shown = harness.of("showDraft");
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].fingerprint, opens[0].fingerprint);
});

test("the draft is not offered until the store has accepted it", async () => {
  const save = deferred();
  const harness = loadRunner({
    send(message) {
      if (message.type === "GET_LF_ASSISTANT_CONTEXT") return Promise.resolve(contextAnswer());
      if (message.type === "SAVE_LF_ASSISTANT_DRAFT") return save.promise;
      return Promise.resolve({ ok: true });
    },
  });

  const run = harness.context.runTranslationAssistant();
  await settle();
  assert.strictEqual(harness.of("showDraft").length, 0,
    "a file the user can download must already be addressable by a reply when they get it");

  save.resolve({ ok: true, held: 1 });
  await run;
  assert.strictEqual(harness.of("showDraft").length, 1);
});

test("a store that refuses stops the draft being offered at all", async () => {
  const harness = loadRunner({
    send(message) {
      if (message.type === "GET_LF_ASSISTANT_CONTEXT") return Promise.resolve(contextAnswer());
      if (message.type === "SAVE_LF_ASSISTANT_DRAFT") {
        return Promise.resolve({ ok: false, error: "session storage is full" });
      }
      return Promise.resolve({ ok: true });
    },
  });

  await harness.context.runTranslationAssistant();
  assert.strictEqual(harness.of("showDraft").length, 0);
  const errors = harness.of("showError");
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /session storage is full/);
});

/* ------------------------------------------------------------------ *
 * Language names: "French", not "fr"
 * ------------------------------------------------------------------ */

const LANGUAGE_ROWS = [{ id: "en", name: "English" }, { id: "fr", name: "French" }];

test("the draft names the language pair from sys_language", async () => {
  const harness = loadRunner({
    send(message) {
      if (message.type === "GET_LF_ASSISTANT_CONTEXT") return Promise.resolve(contextAnswer());
      if (message.type === "SN_TABLE_GET") return Promise.resolve({ ok: true, result: LANGUAGE_ROWS });
      return Promise.resolve({ ok: true, held: 1 });
    },
  });

  await harness.context.runTranslationAssistant();
  const read = harness.sent.filter((message) => message.type === "SN_TABLE_GET");
  assert.strictEqual(read.length, 1, "one read for the pair");
  assert.strictEqual(read[0].table, "sys_language");
  assert.strictEqual(read[0].query, "idINen,fr");
  assert.strictEqual(read[0].fields, "id,name");

  const shown = harness.of("showDraft");
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].draft.languages.sourceLanguageName, "English");
  assert.strictEqual(shown[0].draft.languages.targetLanguageName, "French");
  assert.match(shown[0].draft.payload.prompt, /from English into French/);
  assert.strictEqual(shown[0].draft.payload.targetLanguage, "fr", "the identity stays the code");
});

test("a refused name read still produces the draft, with the codes", async () => {
  const harness = loadRunner({
    send(message) {
      if (message.type === "GET_LF_ASSISTANT_CONTEXT") return Promise.resolve(contextAnswer());
      if (message.type === "SN_TABLE_GET") return Promise.resolve({ ok: false, error: "HTTP 403 reading sys_language" });
      return Promise.resolve({ ok: true, held: 1 });
    },
  });

  await harness.context.runTranslationAssistant();
  assert.strictEqual(harness.of("showError").length, 0, "a missing name is not an error");
  const shown = harness.of("showDraft");
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].draft.languages.targetLanguageName, "fr");
  assert.strictEqual(harness.toasts.length, 0);
});

test("a run dismissed while the language names are read saves nothing", async () => {
  const nameRead = deferred();
  const harness = loadRunner({
    send(message) {
      if (message.type === "GET_LF_ASSISTANT_CONTEXT") return Promise.resolve(contextAnswer());
      if (message.type === "SN_TABLE_GET") return nameRead.promise;
      return Promise.resolve({ ok: true, held: 1 });
    },
  });

  const run = harness.context.runTranslationAssistant();
  await settle();
  assert.ok(harness.sent.some((message) => message.type === "SN_TABLE_GET"), "the name read is in flight");
  harness.dismiss();
  nameRead.resolve({ ok: true, result: LANGUAGE_ROWS });
  await run;

  assert.ok(!harness.sent.some((message) => message.type === "SAVE_LF_ASSISTANT_DRAFT"),
    "an abandoned run must not write to a store that outlives it");
  assert.strictEqual(harness.of("showDraft").length, 0);
});

test("page codes that are not language-shaped send no name read", async () => {
  const harness = loadRunner({
    send(message) {
      if (message.type === "GET_LF_ASSISTANT_CONTEXT") {
        return Promise.resolve(contextAnswer({ sourceLanguage: "javascript:x", targetLanguage: "fr^ORid=en" }));
      }
      if (message.type === "SN_TABLE_GET") return Promise.resolve({ ok: true, result: LANGUAGE_ROWS });
      return Promise.resolve({ ok: true, held: 1 });
    },
  });

  await harness.context.runTranslationAssistant();
  assert.ok(!harness.sent.some((message) => message.type === "SN_TABLE_GET"),
    "a query built from those would carry a script or an extra filter");
  assert.strictEqual(harness.of("showDraft").length, 1, "and the draft is still made");
});

/* ------------------------------------------------------------------ *
 * Refusals (Codex phase 2 review, finding 7)
 * ------------------------------------------------------------------ */

function refusalFor(rejected) {
  const block = between(contentSource, "function translationAssistantRefusal(", "async function runTranslationAssistant(");
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(block, context, { filename: "content.js (refusal)" });
  return context.translationAssistantRefusal(rejected);
}

test("a frame that never answered is not reported as the wrong page", () => {
  /* ARCHITECTURE.md: a negative answer from one frame says nothing about a
   * frame that never answered. Telling a user who is ON the comparison page to
   * go and find it is the worst available answer. */
  const message = refusalFor([
    { frameId: 0, answered: true, isLfPage: false, isAdhoc: null, why: "no .main-content in this frame" },
    { frameId: 5, answered: false, isLfPage: false, isAdhoc: null, why: "timed out after 5000 ms" },
  ]);
  assert.ok(!/press Edit Translations/.test(message),
    "an inconclusive read must not produce conclusive navigation advice: " + message);
  assert.match(message, /again/, "the user is told what to do instead: " + message);
});

test("a page that really is not the comparison UI still says so plainly", () => {
  const message = refusalFor([
    { frameId: 0, answered: true, isLfPage: false, isAdhoc: null, why: "no page-owned angular" },
  ]);
  assert.match(message, /press Edit Translations/);
});

test("the wrong mode outranks every other refusal", () => {
  const message = refusalFor([
    { frameId: 0, answered: false, isLfPage: false, isAdhoc: null, why: "timed out" },
    { frameId: 5, answered: true, isLfPage: true, isAdhoc: false, why: "" },
  ]);
  assert.match(message, /ad-hoc mode/);
});

test("the worker tells the panel which frames failed to answer", () => {
  const block = between(backgroundSource, "async function readLfAssistantContext(", "/* ---");
  assert.ok(/answered:/.test(block),
    "'not the page' and 'never answered' are different answers and the panel has to tell them apart");
});

/* ==================================================================== *
 * Phase 3: the fill, executed.
 *
 * The worker's fill route runs against a real engine, a faked page read and
 * a faked executeScript; the page-side writer runs against a faked Angular
 * scope. The failure modes worth pinning here -- a timed-out write that is
 * still live, a stale array reverting an edit, a lock released early -- are
 * all invisible to a source assertion.
 * ==================================================================== */

const json = (value) => JSON.parse(JSON.stringify(value));

function loadEngineContext() {
  const context = { globalThis: null, crypto: nodeCrypto.webcrypto };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(engineSourceText, context, { filename: "translation_assistant.js" });
  return context.SNTranslationAssistant;
}

const FILL_TA = loadEngineContext();

let fillSysId = 0;
function fillField(source, extra) {
  fillSysId += 1;
  const info = Object.assign({
    originalValue: source,
    textType: "plain",
    isFieldLocked: false,
    additionalParameters: {
      sysId: String(fillSysId).padStart(32, "c"),
      name: "question_text",
      type: "translated_field",
      table: "question",
      scope: "global",
    },
  }, extra || {});
  return info;
}

const FILL_IDENTITY = {
  artifactInternalName: "catalog_item",
  artifactSysId: "0".repeat(31) + "1",
  sourceLanguage: "en",
  targetLanguage: "fr",
};

/* Three rows: a plain one to fill, one whose placeholder the reply drops, and a
 * rich text row carrying a translation that R1 never fills but always rewrites
 * as part of the array. */
function fillContent() {
  return [
    { groupName: "Variable: Cost centre", label: "Question", id: "Variable: Cost centre: Question", isInternal: false,
      fieldInfo: [fillField("Cost centre")] },
    { groupName: "Variable: Charge", label: "Question", id: "Variable: Charge: Question", isInternal: false,
      fieldInfo: [fillField("Charge ${account}")] },
    { groupName: "Basic Info", label: "Description", id: "Basic Info: Description", isInternal: false,
      fieldInfo: [fillField("<p>Notes</p>", {
        textType: "html",
        translatedValue: "<p>Brouillon</p>",
        additionalParameters: {
          sysId: "d".repeat(32), name: "description", type: "translated_html", table: "sc_cat_item", scope: "global",
        },
      })] },
  ];
}

function fillFixture() {
  const content = fillContent();
  const draft = json(FILL_TA.buildDraft(Object.assign({ content: json(content), exportId: "f".repeat(32), now: 1 }, FILL_IDENTITY)));
  const reply = json(draft.payload);
  reply.rows.forEach((row) => {
    row.target = row.source === "Cost centre" ? "Centre de coût" : "Débiter le compte";
  });
  return { content, stored: json(FILL_TA.storedDraft(draft)), replyText: JSON.stringify(reply) };
}

function readAnswer(content, overrides) {
  return {
    selected: {
      frameId: 5,
      context: Object.assign({
        isLfPage: true,
        isAdhoc: true,
        readOnlyMode: false,
        requestInProgress: false,
        content: json(content),
        elementCount: content.length,
      }, FILL_IDENTITY, overrides || {}),
    },
    rejected: [],
  };
}

function loadFill(options) {
  const opts = options || {};
  const block = between(backgroundSource, "const LF_ASSISTANT_APPLY_TIMEOUT_MS", "/* ------");
  const timers = [];
  const injections = [];
  let reads = 0;
  const context = {
    globalThis: null,
    crypto: nodeCrypto.webcrypto,
    console,
    Promise,
    /* The ceiling is driven by hand, so a test decides when "10 seconds"
     * have passed rather than waiting for them. */
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(engineSourceText, context, { filename: "translation_assistant.js" });
  context.assistantEngine = () => context.SNTranslationAssistant;
  context.errorText = (error) => String((error && error.message) || error);
  context.writeLfAssistantContent = function writeLfAssistantContent() {};
  context.readLfAssistantDraft = async (exportId) =>
    (opts.stored && opts.stored.exportId === exportId ? json(opts.stored) : null);
  context.readLfAssistantContext = async () => {
    reads += 1;
    return opts.read();
  };
  context.chrome = {
    scripting: {
      executeScript(injection) {
        injections.push(injection);
        return opts.write(injection);
      },
    },
  };
  vm.runInContext(block, context, { filename: "background.js (fill)" });
  return {
    context,
    injections,
    get reads() { return reads; },
    fill: (msg) => context.applyLfAssistantReply(7, Object.assign({ type: "APPLY_LF_ASSISTANT" }, msg)),
    expire: () => timers.splice(0).forEach((fn) => fn()),
  };
}

const landedAnswer = (landed, missed) =>
  Promise.resolve([{ frameId: 5, result: { written: true, why: "", landed, missed: missed || [] } }]);

test("a fill writes every passing row, holds a placeholder mismatch back, and reports what landed", async () => {
  const fixture = fillFixture();
  const harness = loadFill({
    stored: fixture.stored,
    read: () => readAnswer(fixture.content),
    write: () => landedAnswer(1),
  });

  const result = json(await harness.fill({ replyText: fixture.replyText }));
  assert.strictEqual(result.ok, true, result.message);
  assert.strictEqual(result.written, true);
  assert.strictEqual(result.landed, 1);
  assert.strictEqual(result.attempted, 1, "the placeholder row is advisory, so it waits for a yes");

  assert.strictEqual(harness.injections.length, 1);
  const injection = harness.injections[0];
  assert.strictEqual(injection.world, "MAIN");
  assert.deepStrictEqual(json(injection.target), { tabId: 7, frameIds: [5] });
  const request = json(injection.args[0]);
  assert.deepStrictEqual(request.base, json(fixture.content), "the writer compares against the read the merge used");
  assert.strictEqual(request.merged[0].fieldInfo[0].translatedValue, "Centre de coût");
  assert.ok(!("translatedValue" in request.merged[1].fieldInfo[0]), "the mismatch was not written");
  assert.deepStrictEqual(request.expected.map((entry) => [entry.elementIndex, entry.fieldIndex, entry.value]),
    [[0, 0, "Centre de coût"]]);

  const charge = result.report.rows.find((row) => row.source === "Charge ${account}");
  assert.strictEqual(charge.warning, "placeholder");
  assert.ok(!result.report.filled.includes(charge.k));
});

test("Fill anyway includes a placeholder row only when that row is asked for", async () => {
  const fixture = fillFixture();
  const harness = loadFill({
    stored: fixture.stored,
    read: () => readAnswer(fixture.content),
    write: () => landedAnswer(2),
  });
  const charge = json(FILL_TA.buildDraft(Object.assign({ content: json(fixture.content), exportId: "f".repeat(32), now: 1 }, FILL_IDENTITY)))
    .payload.rows.find((row) => row.source === "Charge ${account}").k;

  /* Shapes the engine would choke on are dropped before it sees them. */
  await harness.fill({ replyText: fixture.replyText, include: [String(charge), { k: charge }, 2.5, -1],
    overrides: [null, { k: "1" }, { k: 1, reviewed: [{ identityKey: 3, target: {} }] }] });
  assert.ok(!("translatedValue" in json(harness.injections[0].args[0]).merged[1].fieldInfo[0]));

  await harness.fill({ replyText: fixture.replyText, include: [charge] });
  assert.strictEqual(json(harness.injections[1].args[0]).merged[1].fieldInfo[0].translatedValue, "Débiter le compte");
});

test("untouched rows survive the array replacement byte for byte", async () => {
  const fixture = fillFixture();
  const harness = loadFill({
    stored: fixture.stored,
    read: () => readAnswer(fixture.content),
    write: () => landedAnswer(1),
  });
  await harness.fill({ replyText: fixture.replyText });
  const request = json(harness.injections[0].args[0]);
  assert.deepStrictEqual(request.merged[1], request.base[1]);
  assert.deepStrictEqual(request.merged[2], request.base[2],
    "the rich text row and its existing draft translation are carried through untouched");
  const filled = json(request.merged[0]);
  delete filled.fieldInfo[0].translatedValue;
  assert.deepStrictEqual(filled, request.base[0], "the filled row gains translatedValue and nothing else");
});

test("a fill that never settles is indeterminate, and a retry is refused until it does", async () => {
  /* The plan's named test: a timeout followed by a read that succeeds must not
   * unlock a retry while the first injection is still live, because that
   * injection carries a snapshot of every other row and can still land. */
  const fixture = fillFixture();
  const pending = deferred();
  let writes = 0;
  const harness = loadFill({
    stored: fixture.stored,
    read: () => readAnswer(fixture.content),
    write: () => {
      writes += 1;
      return writes === 1 ? pending.promise : landedAnswer(1);
    },
  });

  const first = harness.fill({ replyText: fixture.replyText });
  await settle();
  harness.expire();
  const timedOut = json(await first);
  assert.strictEqual(timedOut.ok, false);
  assert.strictEqual(timedOut.indeterminate, true, "a timeout is not a no");
  assert.match(timedOut.message, /may still be filling/);

  const readsBefore = harness.reads;
  const retry = json(await harness.fill({ replyText: fixture.replyText }));
  assert.strictEqual(retry.code, "busy");
  assert.strictEqual(harness.injections.length, 1, "nothing else is sent while the first may land");
  assert.strictEqual(harness.reads, readsBefore, "and the lock is checked before the page is read");

  pending.resolve([{ frameId: 5, result: { written: true, landed: 1, missed: [] } }]);
  await settle();
  const after = json(await harness.fill({ replyText: fixture.replyText }));
  assert.strictEqual(after.ok, true, "the lock releases when the injection settles");
  assert.strictEqual(harness.injections.length, 2);
});

test("releasing a tab's lock, as a navigation does, lets the next fill run", async () => {
  const fixture = fillFixture();
  const harness = loadFill({
    stored: fixture.stored,
    read: () => readAnswer(fixture.content),
    write: () => (harness.injections.length === 1 ? new Promise(() => {}) : landedAnswer(1)),
  });
  const first = harness.fill({ replyText: fixture.replyText });
  await settle();
  harness.expire();
  await first;
  harness.context.releaseLfAssistantApplyLock(7, null);
  assert.strictEqual(json(await harness.fill({ replyText: fixture.replyText })).ok, true);
});

test("a navigation while a fill is still reading the page stops that fill, and only the next one injects", async () => {
  /* Codex review, P2: the navigation handler deleted the lock while the first
   * fill was awaiting its read. A second fill then started, and when the
   * first read resolved the first fill carried on to inject as well -- two
   * unsettled injections, the older built from a page that had unloaded. */
  const fixture = fillFixture();
  const firstRead = deferred();
  let reads = 0;
  const harness = loadFill({
    stored: fixture.stored,
    read: () => {
      reads += 1;
      return reads === 1 ? firstRead.promise : readAnswer(fixture.content);
    },
    write: () => landedAnswer(1),
  });

  const first = harness.fill({ replyText: fixture.replyText });
  await settle();
  assert.strictEqual(reads, 1, "the first fill is waiting on its read");
  /* The page reloads: the navigation handler releases the tab's lock. */
  harness.context.releaseLfAssistantApplyLock(7, null);
  const second = json(await harness.fill({ replyText: fixture.replyText }));
  assert.strictEqual(second.ok, true, "the fresh page accepts a fill");
  assert.strictEqual(harness.injections.length, 1);

  firstRead.resolve(readAnswer(fixture.content));
  const stale = json(await first);
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.code, "navigated");
  assert.match(stale.message, /reloaded or moved while the fill was being prepared/);
  assert.strictEqual(harness.injections.length, 1, "the fill that lost its page never injects");
});

test("a stale fill leaving does not release a newer fill's lock that is still held", async () => {
  /* Codex, on the test above: it finishes the newer fill before the stale
   * one resolves, so it never showed the stale fill's finally leaving a
   * still-running newer lock alone. Here the newer fill's injection is still
   * pending when the stale read resolves. */
  const fixture = fillFixture();
  const firstRead = deferred();
  const secondWrite = deferred();
  let reads = 0;
  const harness = loadFill({
    stored: fixture.stored,
    read: () => {
      reads += 1;
      return reads === 1 ? firstRead.promise : readAnswer(fixture.content);
    },
    write: () => secondWrite.promise,
  });

  const first = harness.fill({ replyText: fixture.replyText });
  await settle();
  harness.context.releaseLfAssistantApplyLock(7, null);
  const second = harness.fill({ replyText: fixture.replyText });
  await settle();
  assert.strictEqual(harness.injections.length, 1, "the newer fill has injected and is waiting");

  firstRead.resolve(readAnswer(fixture.content));
  const stale = json(await first);
  assert.strictEqual(stale.code, "navigated");
  const meanwhile = json(await harness.fill({ replyText: fixture.replyText }));
  assert.strictEqual(meanwhile.code, "busy", "the newer fill's lock is still held after the stale one left");
  assert.strictEqual(harness.injections.length, 1);

  secondWrite.resolve([{ frameId: 5, result: { written: true, confirmed: true, landed: 1, missed: [], missedFields: [] } }]);
  assert.strictEqual(json(await second).ok, true);
  await settle();
  assert.strictEqual(json(await harness.fill({ replyText: fixture.replyText })).code, undefined,
    "and it releases when its own injection settles");
});

test("a write the page could not confirm comes back unconfirmed with its rows, and a half-landed row by field", async () => {
  const fixture = fillFixture();
  let answer = { written: true, confirmed: false, why: "boom", landed: 0, missed: [], missedFields: [] };
  const harness = loadFill({
    stored: fixture.stored,
    read: () => readAnswer(fixture.content),
    write: () => Promise.resolve([{ frameId: 5, result: answer }]),
  });
  const unconfirmed = json(await harness.fill({ replyText: fixture.replyText }));
  assert.strictEqual(unconfirmed.ok, true);
  assert.strictEqual(unconfirmed.written, true);
  assert.strictEqual(unconfirmed.confirmed, false);
  assert.strictEqual(unconfirmed.why, "boom");
  assert.strictEqual(unconfirmed.attempted, 1, "the attempted rows still come back");
  assert.strictEqual(unconfirmed.landed, 0);
  assert.ok(unconfirmed.report.filled.length === 1, "with the report that names them");

  answer = {
    written: true, confirmed: true, landed: 1,
    missed: [1, "1", -2], missedFields: [{ k: 1, identityKey: "second" }, { k: "1", identityKey: "x" }, { k: 2 }],
  };
  const partial = json(await harness.fill({ replyText: fixture.replyText }));
  assert.strictEqual(partial.confirmed, true);
  assert.deepStrictEqual(partial.missed, [1], "only row numbers pass");
  assert.deepStrictEqual(partial.missedFields, [{ k: 1, identityKey: "second" }], "only well-formed field entries pass");
});

test("every page precondition refuses the whole fill before anything is written", async () => {
  const fixture = fillFixture();
  const cases = [
    { name: "read-only mode", read: () => readAnswer(fixture.content, { readOnlyMode: true }), code: "read_only" },
    { name: "a request in flight", read: () => readAnswer(fixture.content, { requestInProgress: true }), code: "request_in_progress" },
    { name: "additionalInfo undefined (the accessor threw)", read: () => readAnswer(fixture.content, { requestInProgress: null }), code: "request_in_progress" },
    { name: "another item", read: () => readAnswer(fixture.content, { artifactSysId: "0".repeat(31) + "2" }), code: "identity_moved" },
    { name: "another language", read: () => readAnswer(fixture.content, { targetLanguage: "de" }), code: "identity_moved" },
    { name: "a changed element count", read: () => readAnswer(fixture.content.concat(fixture.content[0])), code: "element_count" },
    { name: "no comparison page", read: () => ({ selected: null, rejected: [{ frameId: 0, answered: true, isLfPage: false }] }), code: "no_page" },
  ];
  for (const entry of cases) {
    const harness = loadFill({ stored: fixture.stored, read: entry.read, write: () => landedAnswer(1) });
    const result = json(await harness.fill({ replyText: fixture.replyText }));
    assert.strictEqual(result.ok, false, entry.name);
    assert.strictEqual(result.code, entry.code, entry.name);
    assert.strictEqual(harness.injections.length, 0, entry.name + ": nothing written");
    const again = json(await harness.fill({ replyText: fixture.replyText }));
    assert.notStrictEqual(again.code, "busy", entry.name + ": a refusal releases the lock");
  }
});

test("a reply from a draft this browser no longer has refuses before the page is read", async () => {
  const fixture = fillFixture();
  const harness = loadFill({ stored: null, read: () => readAnswer(fixture.content), write: () => landedAnswer(1) });
  const result = json(await harness.fill({ replyText: fixture.replyText }));
  assert.strictEqual(result.code, "unknown_draft");
  assert.match(result.message, /no longer has/);
  assert.strictEqual(harness.reads, 0);

  const garbled = json(await harness.fill({ replyText: "Sure! Here you go: {not json" }));
  assert.strictEqual(garbled.code, "unparseable");
  assert.match(garbled.excerpt, /^Sure!/);
});

test("a writer that refuses is reported as nothing filled, and releases the lock", async () => {
  const fixture = fillFixture();
  let answer = { written: false, why: "changed", landed: 0, missed: [] };
  const harness = loadFill({
    stored: fixture.stored,
    read: () => readAnswer(fixture.content),
    write: () => Promise.resolve([{ frameId: 5, result: answer }]),
  });
  const refused = json(await harness.fill({ replyText: fixture.replyText }));
  assert.strictEqual(refused.ok, false);
  assert.match(refused.message, /nothing was filled/i);
  answer = { written: true, landed: 0, missed: [1] };
  const short = json(await harness.fill({ replyText: fixture.replyText }));
  assert.strictEqual(short.ok, true, "a refusal did not hold the lock");
  assert.strictEqual(short.landed, 0, "the count is what landed, never what was attempted");
  assert.deepStrictEqual(short.missed, [1]);
});

/* ------------------------------------------------------------------ *
 * The page-side writer
 * ------------------------------------------------------------------ */

/* Two copies, as the platform keeps them: the original the page was loaded
 * with, and the bound copy the boxes edit, which retrieveCurrentContent
 * flattens over the original. A user's typing lands ONLY in the bound copy,
 * so a writer that read the original instead would never see it (Codex
 * review, P3: with one copy standing in for both, that mutation passed). */
function fakePage(content, options) {
  const opts = options || {};
  const state = { fired: [] };
  const scope = {
    isAdhocMode: () => opts.adhoc !== false,
    isReadOnlyMode: () => !!opts.readOnly,
    isLastRequestInProgress: () => {
      if (opts.noAdditionalInfo) throw new TypeError("Cannot read properties of undefined (reading 'readOnly')");
      return !!opts.inProgress;
    },
    itemsToTranslate: { adhoc: { documentContent: { content: json(content) } } },
    groupedItemsToTranslate: { adhoc: { documentContent: { bound: json(content) } } },
    retrieveCurrentContent: (grouped, original) => {
      if (opts.readbackThrows && state.fired.length) throw new TypeError("Cannot read properties of undefined (reading 'content')");
      return grouped.bound;
    },
  };
  const context = {
    Promise,
    Date,
    setTimeout,
    URLSearchParams,
    /* The document the read came from: its time origin and the identity the
     * reader picks from the scope or the URL. A test replaces either to stand
     * for a replacement page. */
    performance: { timeOrigin: opts.timeOrigin === undefined ? 1000 : opts.timeOrigin },
    location: { search: opts.search || "" },
    document: { querySelector: (selector) => (selector === ".main-content" ? {} : null) },
    angular: { element: () => ({ scope: () => scope }) },
    CustomEvent: {
      fire(name, payload) {
        state.fired.push(name);
        if (name === "updateDocumentContent" && !opts.ignoreEvent) {
          scope.itemsToTranslate.adhoc.documentContent.content = payload.detail;
          scope.groupedItemsToTranslate.adhoc.documentContent.bound = json(payload.detail);
        }
      },
    },
  };
  Object.assign(scope, opts.identity || {});
  vm.createContext(context);
  vm.runInContext(
    between(backgroundSource, "async function writeLfAssistantContent(", "const LF_ASSISTANT_APPLY_TIMEOUT_MS"),
    context,
    { filename: "background.js (writer)" }
  );
  return { state, scope, write: (request) => context.writeLfAssistantContent(request) };
}

function writerRequest(content, settleMs) {
  const merged = json(content);
  merged[0].fieldInfo[0].translatedValue = "Centre de coût";
  const params = content[0].fieldInfo[0].additionalParameters;
  return {
    base: json(content),
    merged,
    settleMs: settleMs || 0,
    expected: [{
      k: 1, value: "Centre de coût", elementIndex: 0, fieldIndex: 0,
      type: params.type, table: params.table, name: params.name, sysId: params.sysId,
    }],
    /* As the fake page answers by default: no artifact fields on the scope
     * or the URL, and the document created at time origin 1000. */
    identity: { artifactInternalName: "", artifactSysId: "", sourceLanguage: "", targetLanguage: "", documentStamp: 1000 },
  };
}

test("the writer fires once, and counts only fields that hold the value on their own record", async () => {
  const content = fillContent();
  const page = fakePage(content);
  const result = json(await page.write(writerRequest(content)));
  assert.deepStrictEqual(page.state.fired, ["updateDocumentContent"]);
  assert.strictEqual(result.written, true);
  assert.strictEqual(result.landed, 1);

  const other = fakePage(content);
  const request = writerRequest(content);
  request.expected[0].sysId = "e".repeat(32);
  const misaddressed = json(await other.write(request));
  assert.strictEqual(misaddressed.landed, 0, "the right value on the wrong record does not count");
  assert.deepStrictEqual(misaddressed.missed, [1]);
});

test("the writer refuses when the page moved since the read, so an edit is never reverted", async () => {
  const content = fillContent();
  const page = fakePage(content);
  /* The user typed into another row after the worker read the page. Typing
   * reaches the bound copy only; the original still matches the read. */
  const bound = page.scope.groupedItemsToTranslate.adhoc.documentContent.bound;
  bound[1].fieldInfo[0].translatedValue = "typed by hand";
  assert.ok(!("translatedValue" in page.scope.itemsToTranslate.adhoc.documentContent.content[1].fieldInfo[0]));
  const result = json(await page.write(writerRequest(content)));
  assert.strictEqual(result.written, false, "the writer read the bound copy, where the typing is");
  assert.strictEqual(result.why, "changed");
  /* The row had no translation, so the edit added the key rather than changing
   * a value. */
  assert.strictEqual(result.changedAt, "[1].fieldInfo[0]{keys}",
    "where it moved, by field name and index, never by value");
  assert.deepStrictEqual(page.state.fired, [], "nothing fired");
  assert.strictEqual(bound[1].fieldInfo[0].translatedValue, "typed by hand", "and the typing is still there");
});

test("an untouched page is not refused because its snapshot came back through Chrome", async () => {
  /* Found live on the PDI: executeScript hands objects back with their keys in
   * sorted order, and Angular leaves $$hashKey on the model, so a compare of the
   * two as JSON text refused a page nobody had touched. The unit test that
   * passed then handed both sides the same key order. */
  const sortKeys = (value) => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
      return Object.keys(value).sort().reduce((out, key) => {
        out[key] = sortKeys(value[key]);
        return out;
      }, {});
    }
    return value;
  };
  const content = fillContent();
  const page = fakePage(content);
  page.scope.itemsToTranslate.adhoc.documentContent.content.forEach((element, index) => {
    element.$$hashKey = "object:" + (index + 10);
  });
  const request = writerRequest(content);
  request.base = sortKeys(request.base);
  assert.notStrictEqual(JSON.stringify(request.base), JSON.stringify(content), "the fixture really is reordered");

  const result = json(await page.write(request));
  assert.strictEqual(result.written, true, "refused at " + result.changedAt);
  assert.strictEqual(result.landed, 1);
});

test("the writer re-checks each page state and refuses on any it cannot confirm", async () => {
  const content = fillContent();
  for (const [option, why] of [
    [{ readOnly: true }, "read_only"],
    [{ inProgress: true }, "request_in_progress"],
    [{ noAdditionalInfo: true }, "request_in_progress"],
    [{ adhoc: false }, "not_page"],
  ]) {
    const page = fakePage(content, option);
    const result = json(await page.write(writerRequest(content)));
    assert.strictEqual(result.written, false, JSON.stringify(option));
    assert.strictEqual(result.why, why, JSON.stringify(option));
    assert.deepStrictEqual(page.state.fired, [], JSON.stringify(option));
  }
});

test("a page that ignores the event is reported as filled nowhere, after a short settle", async () => {
  const content = fillContent();
  const page = fakePage(content, { ignoreEvent: true });
  const result = json(await page.write(writerRequest(content, 250)));
  assert.strictEqual(result.written, true, "the event was fired");
  assert.strictEqual(result.confirmed, true, "the model was read back, and held nothing");
  assert.strictEqual(result.landed, 0);
  assert.deepStrictEqual(result.missed, [1]);
  assert.deepStrictEqual(result.missedFields, [{ k: 1, identityKey: "" }]);
});

test("a shared row that half landed is reported by field, not only by row", async () => {
  /* Codex review, P2: two fields on one row. The writer used to return the
   * row number alone, so the panel could not tell one landing from none. */
  const content = fillContent();
  content.push({ groupName: "Variable: Cost centre (copy)", label: "Question", id: "Variable: Cost centre (copy): Question",
    isInternal: false, fieldInfo: [fillField("Cost centre")] });
  const page = fakePage(content);
  const request = writerRequest(content);
  request.merged[3].fieldInfo[0].translatedValue = "Centre de coût";
  const params = content[3].fieldInfo[0].additionalParameters;
  request.expected[0].identityKey = "first";
  request.expected.push({
    k: 1, identityKey: "second", value: "Centre de coût", elementIndex: 3, fieldIndex: 0,
    type: params.type, table: params.table, name: params.name, sysId: "e".repeat(32),
  });
  const result = json(await page.write(request));
  assert.strictEqual(result.written, true);
  assert.strictEqual(result.landed, 1);
  assert.deepStrictEqual(result.missed, [1], "the row, once");
  assert.deepStrictEqual(result.missedFields, [{ k: 1, identityKey: "second" }], "and which field of it");
});

test("a fill the writer cannot read back is unconfirmed, never a count", async () => {
  /* Codex review, P2: the event fired, then retrieveCurrentContent threw. That
   * came back as written with zero landed and nothing missed, which the panel
   * read as a success. The page holds what it took; the honest answer is that
   * the writer cannot say what. */
  const content = fillContent();
  const page = fakePage(content, { readbackThrows: true });
  const result = json(await page.write(writerRequest(content, 250)));
  assert.deepStrictEqual(page.state.fired, ["updateDocumentContent"]);
  assert.strictEqual(result.written, true);
  assert.strictEqual(result.confirmed, false);
  assert.match(result.why, /reading 'content'/);
  assert.strictEqual(result.landed, 0);
  assert.deepStrictEqual(result.missed, []);
  assert.deepStrictEqual(result.missedFields, []);
});

test("the writer refuses a replacement page holding the same content", async () => {
  /* Codex review, P2: the ownership checks close the worker's side, but the
   * injection targets a frame number, and a replacement page -- the item
   * reopened for another language, or reloaded before anything is typed --
   * can hold content identical to the read the merge was built from. The
   * content compare cannot tell them apart; the document's time origin and
   * the identity the reader picked can. */
  const content = fillContent();
  for (const [option, what] of [
    [{ timeOrigin: 2000 }, "a reloaded document"],
    [{ search: "?sysparm_target_language=de" }, "another target language from the URL"],
    [{ identity: { targetLanguage: "de" } }, "another target language on the scope"],
    [{ identity: { artifactSysId: "e".repeat(32) } }, "another item"],
  ]) {
    const page = fakePage(content, option);
    const result = json(await page.write(writerRequest(content)));
    assert.strictEqual(result.written, false, what);
    assert.strictEqual(result.why, "other_page", what);
    assert.deepStrictEqual(page.state.fired, [], what + ": nothing fired");
  }
  /* And the page the read came from, identified the same way, is written. */
  const same = fakePage(content, { search: "?sysparm_target_language=fr", timeOrigin: 4321 });
  const request = writerRequest(content);
  request.identity.targetLanguage = "fr";
  request.identity.documentStamp = 4321;
  assert.strictEqual(json(await same.write(request)).written, true);
});

test("the reader reports the document it read, and the fill hands the writer that identity", async () => {
  const inspector = between(backgroundSource, "function inspectLfAssistantContext(", "function selectLfAssistantFrame(");
  assert.ok(inspector.includes("out.documentStamp ="), "the reader records the document's time origin");
  assert.ok(inspector.includes("performance.timeOrigin"));

  const fixture = fillFixture();
  const harness = loadFill({
    stored: fixture.stored,
    read: () => readAnswer(fixture.content, { documentStamp: 98765 }),
    write: () => landedAnswer(1),
  });
  assert.strictEqual(json(await harness.fill({ replyText: fixture.replyText })).ok, true);
  const identity = json(harness.injections[0].args[0].identity);
  assert.deepStrictEqual(identity, {
    artifactInternalName: "catalog_item",
    artifactSysId: "0".repeat(31) + "1",
    sourceLanguage: "en",
    targetLanguage: "fr",
    documentStamp: 98765,
  });
  assert.match(harness.context.lfAssistantWriteRefusal("other_page"), /replaced just as it was being filled/);
});

/* ------------------------------------------------------------------ *
 * The content script's Fill
 * ------------------------------------------------------------------ */

test("the panel's Fill reaches the worker as one request, and a missing page gets the draft's sentence", async () => {
  let answer = { ok: false, code: "no_page", rejected: [{ frameId: 0, answered: true, isLfPage: false, why: "no page-owned angular" }] };
  const harness = loadRunner({
    send(message) {
      if (message.type === "GET_LF_ASSISTANT_CONTEXT") return Promise.resolve(contextAnswer());
      if (message.type === "APPLY_LF_ASSISTANT") {
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      }
      return Promise.resolve({ ok: true, held: 1 });
    },
  });
  await harness.context.runTranslationAssistant();

  const refused = await harness.fill({ text: "{ }", include: [2], overrides: [] });
  const sent = harness.sent.filter((message) => message.type === "APPLY_LF_ASSISTANT");
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(json(sent[0]), { type: "APPLY_LF_ASSISTANT", replyText: "{ }", include: [2], overrides: [] });
  assert.match(refused.message, /press Edit Translations/);

  answer = new Error("The message port closed before a response was received.");
  const gone = await harness.fill({ text: "{ }" });
  assert.strictEqual(gone.indeterminate, true, "a worker that vanished mid-fill may have filled");
});

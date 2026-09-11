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
  const guard = between(contentSource, "function openTranslationUrl(", "const TRANSLATION_LENS_WORKSPACE_MESSAGE");
  assert.ok(guard.includes("target.origin !== location.origin"),
    "and that check still refuses another origin before the worker ever sees it");
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
    of(method) { return calls.filter((entry) => entry.method === method); },
  };
}

function contextAnswer() {
  return {
    ok: true,
    selected: {
      frameId: 5,
      context: {
        isLfPage: true,
        isAdhoc: true,
        artifactInternalName: "catalog_item",
        artifactSysId: "0".repeat(31) + "1",
        sourceLanguage: "en",
        targetLanguage: "fr",
        content: LF_CONTENT_FIXTURE,
        elementCount: 1,
      },
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

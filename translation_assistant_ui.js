/*
 * Isolated-world visual panel for the "Translation Assistant" command.
 *
 * Phase 2 is the read path only: it shows what an item has, what it cannot
 * translate and why, and hands the payload out. Nothing here writes to the
 * page. The paste box, the preview and Apply arrive with phase 3.
 *
 * The exact contract content.js validates before any page data is read:
 *
 *   open({ fingerprint, context, callbacks })
 *   showDraft({ fingerprint, draft })
 *   showError({ fingerprint, message })
 *   close({ fingerprint, reason })
 *
 * The panel mounts on open(), before the read lands, because resolving a frame
 * and reading an Angular scope is not instant and a blank screen is worse than
 * a stated wait. Every call carries the run fingerprint, and anything whose
 * fingerprint does not match the open panel is discarded rather than rendered,
 * so a slow first run cannot overwrite a fast second one.
 *
 * Rules this file exists to keep:
 *
 *   - One primary route and one escape hatch, never two buttons of equal
 *     weight. Download leads because a file outlives a clipboard and because
 *     the payload carries its own instructions; the copy link is there for a
 *     model with no file upload. Nobody is asked to compare them.
 *   - Every excluded field is named with its reason and counted. A field this
 *     build will not translate is a stated limit, never a silent omission.
 *   - "Locked" is never described as verified. In ad-hoc mode the flag is
 *     derived from whether a translation exists, so the panel says the field
 *     already has one and says how to redo it.
 *   - Both routes emit the identical bytes, from the one string the engine
 *     serialised. The panel never assembles a payload of its own.
 *
 * Safety: every instance-derived string is inserted with textContent. No
 * innerHTML, no insertAdjacentHTML, no template interpolation into markup. The
 * closed shadow root is not what makes that safe -- it controls what page
 * script can reach into, and does nothing about what this file renders.
 */

(() => {
  if (globalThis.SNTranslationAssistantUI) return;

  const HOST_ID = "snh-translation-assistant-results";
  const TITLE_ID = "snh-translation-assistant-title";

  const UI_CSS = `
  .overlay { position: fixed; inset: 0; z-index: 2147483600; display: flex;
    align-items: flex-start; justify-content: center; padding: 48px 16px;
    background: rgba(14, 19, 24, 0.55); font: 14px/1.5 -apple-system,
    BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
  .panel { background: #fff; color: #1b1f23; width: 100%; max-width: 560px;
    border-radius: 10px; box-shadow: 0 18px 48px rgba(0,0,0,.32);
    max-height: calc(100vh - 96px); display: flex; flex-direction: column; }
  .header { display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; padding: 16px 18px 10px; border-bottom: 1px solid #e3e6e8; }
  .header h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .subtitle { color: #5c6670; font-size: 13px; margin-top: 2px; }
  .close { border: 1px solid #c8ced3; background: #fff; border-radius: 6px;
    padding: 4px 10px; cursor: pointer; font-size: 13px; color: #1b1f23; }
  .close:hover { background: #f4f6f7; }
  .body { padding: 14px 18px 18px; overflow: auto; }
  .status { color: #5c6670; }
  .error { color: #8a1c1c; }
  .tally { list-style: none; margin: 0 0 12px; padding: 0; }
  .tally li { display: flex; gap: 10px; padding: 3px 0; }
  .tally .n { min-width: 2.5em; text-align: right; font-variant-numeric: tabular-nums;
    font-weight: 600; }
  .tally .why { color: #5c6670; }
  .tally li.total { border-top: 1px solid #e3e6e8; margin-top: 6px; padding-top: 8px; }
  .tally li.none .n, .tally li.none .what { color: #5c6670; font-weight: 400; }
  .primary { margin: 14px 0 10px; }
  .primary button { background: #1b5e4a; color: #fff; border: 0; border-radius: 6px;
    padding: 9px 16px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .primary button:hover { background: #17513f; }
  .primary button:disabled { background: #9aa7ae; cursor: default; }
  .hint { color: #3c454d; margin: 0 0 6px; }
  .privacy { color: #5c6670; margin: 0 0 12px; }
  .secondary { background: none; border: 0; padding: 0; color: #1b5e4a;
    text-decoration: underline; cursor: pointer; font-size: 13px; font-family: inherit; }
  .note { color: #3c454d; border-left: 3px solid #d7dbdf; padding: 2px 0 2px 10px;
    margin: 12px 0 0; }
  `;

  let host = null;
  let shadow = null;
  let bodyEl = null;
  let subtitleEl = null;
  let callbacks = {};
  let runFingerprint = null;
  let previousFocus = null;

  const str = (value) => (typeof value === "string" ? value : "");
  const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
  const isFn = (value) => typeof value === "function";

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function safeActiveElement() {
    try {
      return document.activeElement;
    } catch (error) {
      return null;
    }
  }

  function sameRun(fingerprint) {
    return !!runFingerprint && !!fingerprint && fingerprint === runFingerprint;
  }

  function notify(message, isError) {
    if (isFn(callbacks.onNotify)) callbacks.onNotify(message, !!isError);
  }

  function unmount() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
    bodyEl = null;
    subtitleEl = null;
    runFingerprint = null;
    if (previousFocus && isFn(previousFocus.focus)) {
      try {
        previousFocus.focus();
      } catch (error) { /* the element may be gone; losing focus is not a failure */ }
    }
    previousFocus = null;
  }

  function userClose(reason) {
    const onClose = callbacks.onClose;
    unmount();
    if (isFn(onClose)) onClose(reason);
  }

  function onKeyDown(event) {
    if (event && event.key === "Escape") {
      event.stopPropagation();
      userClose("escape");
    }
  }

  function mount(context) {
    previousFocus = safeActiveElement();
    host = el("div");
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: "closed" });

    const style = el("style");
    style.textContent = UI_CSS;
    shadow.appendChild(style);

    const overlay = el("div", "overlay");
    overlay.addEventListener("click", (event) => {
      if (event && event.target === overlay) userClose("overlay");
    });
    overlay.addEventListener("keydown", onKeyDown);

    const panel = el("section", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", TITLE_ID);

    const header = el("header", "header");
    const heading = el("div");
    const title = el("h2", "", "Translation Assistant");
    title.id = TITLE_ID;
    subtitleEl = el("div", "subtitle", languagePair(context));
    heading.appendChild(title);
    heading.appendChild(subtitleEl);
    const closeButton = el("button", "close", "Close");
    closeButton.type = "button";
    closeButton.addEventListener("click", () => userClose("close-button"));
    header.appendChild(heading);
    header.appendChild(closeButton);
    panel.appendChild(header);

    bodyEl = el("div", "body");
    bodyEl.setAttribute("aria-live", "polite");
    panel.appendChild(bodyEl);

    overlay.appendChild(panel);
    shadow.appendChild(overlay);
    closeButton.focus();
  }

  /* The codes are all the page has when no display name came back with it. */
  function languagePair(context) {
    const source = str(context && (context.sourceLanguageName || context.sourceLanguage));
    const target = str(context && (context.targetLanguageName || context.targetLanguage));
    if (!source || !target) return "";
    return source + " → " + target;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function open(options) {
    const request = options || {};
    const fingerprint = str(request.fingerprint);
    if (!fingerprint) return false;
    if (host) unmount();
    callbacks = request.callbacks && typeof request.callbacks === "object" ? request.callbacks : {};
    runFingerprint = fingerprint;
    mount(request.context);
    clear(bodyEl);
    bodyEl.appendChild(el("p", "status", "Reading this item…"));
    return true;
  }

  function showError(options) {
    const request = options || {};
    if (!sameRun(request.fingerprint)) return false;
    clear(bodyEl);
    bodyEl.appendChild(el("p", "error",
      str(request.message) || "Translation Assistant could not read this page."));
    return true;
  }

  /*
   * One row per exclusion bucket, each naming its reason. The wording for the
   * locked bucket is deliberate: the platform's own tooltip calls locked fields
   * verified, which in ad-hoc mode is untrue, because an unreviewed machine
   * translation derives the same flag.
   */
  const BUCKETS = [
    { key: "rich_text", what: "rich text", why: "cannot be filled safely yet" },
    { key: "locked", what: "already translated", why: "unlock in ServiceNow to redo one" },
    { key: "shared_with_ineligible", what: "share a translation with one of those",
      why: "filling them would rewrite it" },
    { key: "uncertain_destination", what: "may share a translation with each other",
      why: "GlideLens cannot prove it, so it leaves them alone" },
    { key: "shared_message", what: "script messages", why: "shared by every script using the key" },
    { key: "unsupported_type", what: "other field types", why: "not covered by this release" },
    { key: "empty_source", what: "empty", why: "nothing to translate" },
  ];

  function tallyList(draft) {
    const counts = (draft && draft.counts) || {};
    const list = el("ul", "tally");

    const total = el("li");
    total.appendChild(el("span", "n", String(count(counts.fields))));
    total.appendChild(el("span", "what", "fields on this item"));
    list.appendChild(total);

    BUCKETS.forEach((bucket) => {
      const n = count(counts[bucket.key]);
      if (!n) return;
      const row = el("li");
      row.appendChild(el("span", "n", String(n)));
      row.appendChild(el("span", "what", bucket.what));
      row.appendChild(el("span", "why", "(excluded — " + bucket.why + ")"));
      list.appendChild(row);
    });

    const eligible = count(counts.eligible);
    const row = el("li", eligible ? "total" : "total none");
    row.appendChild(el("span", "n", String(eligible)));
    row.appendChild(el("span", "what", eligible === 1 ? "to translate" : "to translate"));
    list.appendChild(row);
    return list;
  }

  function downloadName(draft) {
    const languages = (draft && draft.languages) || {};
    const part = (value) => str(value).replace(/[^A-Za-z0-9-]/g, "").slice(0, 12);
    const source = part(languages.sourceLanguage) || "source";
    const target = part(languages.targetLanguage) || "target";
    /* The artifact's own name is customer content, so the file is named after
     * the language pair and the draft id instead. */
    return "glidelens-translation-" + source + "-" + target + "-" +
      str(draft && draft.exportId).slice(0, 8) + ".json";
  }

  function download(draft, button) {
    const text = str(draft && draft.serialized);
    if (!text) {
      notify("There is nothing to download.", true);
      return;
    }
    let url = "";
    try {
      const blob = new Blob([text], { type: "application/json" });
      url = URL.createObjectURL(blob);
      const anchor = el("a");
      anchor.href = url;
      anchor.download = downloadName(draft);
      /* Inside the shadow root: the click never reaches page script, and the
       * node is removed immediately afterwards. */
      shadow.appendChild(anchor);
      anchor.click();
      shadow.removeChild(anchor);
      notify("Draft downloaded. Upload it to your AI tool.", false);
      if (button) button.textContent = "Download again";
    } catch (error) {
      notify("The download could not start: " + String(error && error.message ? error.message : error), true);
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  async function copy(draft) {
    const text = str(draft && draft.serialized);
    if (!text) {
      notify("There is nothing to copy.", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      notify("Prompt and JSON copied. Paste it into your AI tool.", false);
    } catch (error) {
      notify("Copying failed. Use Download JSON instead.", true);
    }
  }

  function showDraft(options) {
    const request = options || {};
    if (!sameRun(request.fingerprint)) return false;
    const draft = request.draft || {};
    clear(bodyEl);
    if (subtitleEl) subtitleEl.textContent = languagePair(draft.languages) || subtitleEl.textContent;

    bodyEl.appendChild(tallyList(draft));

    if (!count(draft.counts && draft.counts.eligible)) {
      bodyEl.appendChild(el("p", "hint",
        "Nothing to translate here. Every field is excluded for one of the reasons above."));
      bodyEl.appendChild(unlockNote());
      return true;
    }

    const primary = el("div", "primary");
    const button = el("button", "", "Download JSON");
    button.type = "button";
    button.addEventListener("click", () => download(draft, button));
    primary.appendChild(button);
    bodyEl.appendChild(primary);

    bodyEl.appendChild(el("p", "hint",
      "Upload the file to your AI tool and say: “Follow the instructions in this file.”"));
    bodyEl.appendChild(el("p", "privacy",
      "The file holds this item's field text. It leaves your browser when you upload it somewhere."));

    const copyLink = el("button", "secondary", "Copy prompt + JSON instead");
    copyLink.type = "button";
    copyLink.addEventListener("click", () => { copy(draft); });
    bodyEl.appendChild(copyLink);

    if (draft.counts && count(draft.counts.locked)) bodyEl.appendChild(unlockNote());
    if (draft.sharedRows) bodyEl.appendChild(sharedNote(draft.sharedRows));
    return true;
  }

  function unlockNote() {
    return el("p", "note",
      "A field that already has a translation is left alone. To have one redone, " +
      "unlock it on this page first, then run Translation Assistant again.");
  }

  /* Stated once, above the routes, because it is the platform's storage model
   * and the user is entitled to know it before they publish. */
  function sharedNote(rows) {
    const n = count(rows);
    return el("p", "note",
      n === 1
        ? "One of these translations is shared: publishing it changes that translation " +
          "for every catalog item on this instance whose field uses the same English text."
        : n + " of these translations are shared: publishing them changes those translations " +
          "for every catalog item on this instance whose fields use the same English text.");
  }

  function close(options) {
    const request = options || {};
    if (!sameRun(request.fingerprint)) return false;
    /* A programmatic close is the orchestrator's own decision, so onClose --
     * which content.js uses to learn that the user dismissed a live run -- is
     * deliberately not fired here. */
    unmount();
    return true;
  }

  globalThis.SNTranslationAssistantUI = {
    open,
    showDraft,
    showError,
    close,
  };
})();

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
 *   - Every excluded field is counted under a named reason. A field this build
 *     will not translate is a stated limit, never a silent omission.
 *   - The tally is one accounting system, and it is counted in FIELDS. The
 *     exported row count is a different number -- two fields can share one
 *     destination -- and where they differ the panel says so rather than
 *     printing one where the reader is subtracting the other.
 *   - It wears the shared GlideLens palette and chrome: a dark panel, teal for
 *     focus and grouping, pink for the one primary action, and a footer that
 *     states what the panel never does. There is no build step to share CSS,
 *     so every panel carries a verbatim copy of the tokens and a test in
 *     command_palette.test.js catches a panel that drifts from them.
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
    *{box-sizing:border-box}
    :host{
      all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      /* The shared GlideLens palette, copied verbatim from the sibling panels.
         Teal = grouping/selection/focus; pink = the one primary action. */
      --teal:#31d4c4;--pink:#ff6fae;--band:#2a2a46;
      --flag:#f0d79b;--flag-bg:#3a3320;--flag-line:#5c5031;
      --info:#a9d5ff;--info-bg:#24364a;--info-line:#365573;
      --gap:#ff9d9d;--gap-bg:#3a2530;--gap-line:#5c3a48;
    }
    button{font:inherit}
    .overlay{
      position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.52);
      display:flex;align-items:center;justify-content:center;padding:12px;
    }
    .panel{
      width:min(620px,calc(100vw - 24px));max-height:calc(100vh - 24px);
      display:flex;flex-direction:column;overflow:hidden;
      background:#1e1e2e;border:1px solid #3a3a5c;border-radius:12px;
      box-shadow:0 28px 80px rgba(0,0,0,.65);color:#dedeee;font-size:13px;line-height:1.5;
    }
    .header{
      display:flex;align-items:flex-start;gap:14px;padding:18px 20px 14px;
      border-bottom:1px solid #2e2e4e;
    }
    .heading{flex:1;min-width:0}
    h2{font-size:17px;line-height:1.2;margin:0 0 5px;color:#f5f5ff;font-weight:650}
    .subtitle{font-size:12px;color:#85859f;line-height:1.5}
    .subtitle .mono{
      font:11px ui-monospace,SFMono-Regular,Consolas,monospace;
      color:color-mix(in srgb, var(--teal) 70%, #cfeee9);
    }
    .close{
      border:0;background:transparent;color:#85859f;padding:3px 5px;
      font-size:12px;line-height:1;cursor:pointer;border-radius:5px;
    }
    .close:hover{color:#fff;background:#2d2d48}
    .body{padding:16px 20px 18px;overflow:auto}
    .status{color:#aaaac1;margin:0}
    .bar-indeterminate{
      height:2px;background:#2b2b46;border-radius:2px;overflow:hidden;margin-top:9px;
    }
    .bar-indeterminate span{
      display:block;height:100%;width:36%;border-radius:2px;background:var(--teal);
      animation:snh-ta-slide 1.5s linear infinite;
    }
    @keyframes snh-ta-slide{from{transform:translateX(-100%)}to{transform:translateX(280%)}}
    .error{
      margin:0;padding:9px 12px;border-radius:7px;color:#ffc9c9;
      background:var(--gap-bg);border:1px solid var(--gap-line);
    }
    .tally{list-style:none;margin:0 0 4px;padding:0}
    .tally li{display:flex;align-items:baseline;gap:10px;padding:4px 0}
    .tally .n{
      min-width:2.6em;text-align:right;font-variant-numeric:tabular-nums;
      font-weight:650;color:#f0f0fa;
    }
    .tally .why{color:#85859f;font-size:12px}
    .tally li.total{border-top:1px solid #2e2e4e;margin-top:6px;padding-top:9px}
    .tally li.none .n,.tally li.none .what{color:#85859f;font-weight:400}
    .primary{margin:16px 0 12px}
    .primary button{
      background:color-mix(in srgb, var(--pink) 82%, #3a2740);
      border:1px solid color-mix(in srgb, var(--pink) 70%, #5a3a4c);color:#fff;
      border-radius:7px;padding:8px 16px;font-size:13px;font-weight:650;cursor:pointer;
    }
    .primary button:hover{background:color-mix(in srgb, var(--pink) 92%, #3a2740)}
    .hint{color:#c9c9dc;margin:0 0 6px}
    .privacy{color:#85859f;font-size:12px;margin:0 0 12px}
    .secondary{
      background:none;border:0;padding:0;cursor:pointer;font-size:12px;
      color:color-mix(in srgb, var(--teal) 84%, white);text-decoration:underline;
      text-underline-offset:2px;
    }
    .secondary:hover{color:#fff}
    .note{margin:14px 0 0;padding:9px 12px;border-radius:7px;font-size:12px;line-height:1.5}
    .note.info{color:var(--info);background:var(--info-bg);border:1px solid var(--info-line)}
    .note.flag{color:var(--flag);background:var(--flag-bg);border:1px solid var(--flag-line)}
    .toolbar{
      display:flex;align-items:center;gap:8px;padding:11px 14px;flex-wrap:wrap;
      border-top:1px solid #2e2e4e;background:#1b1b2b;
    }
    .toolbar-note{font-size:11px;color:#67677e;flex:1;min-width:150px}
    .toolbar button{
      border:1px solid #3a3a5c;background:#292941;color:#d8d8ea;
      border-radius:6px;padding:6px 9px;cursor:pointer;font-size:12px;
    }
    .toolbar button:hover{background:#343453;color:#fff}
    :focus-visible{outline:2px solid var(--teal);outline-offset:1px}
    @media (prefers-reduced-motion: reduce){
      *{animation:none !important;transition:none !important}
      .bar-indeterminate span{width:100%}
    }
    @media(max-width:680px){.overlay{padding:8px}.panel{width:100%}.header{padding:14px}}
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
  const plural = (n, word) => (n === 1 ? word : word + "s");

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
    const heading = el("div", "heading");
    const title = el("h2", "", "Translation Assistant");
    title.id = TITLE_ID;
    subtitleEl = el("div", "subtitle");
    renderSubtitle(context);
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

    /* The footer every GlideLens panel carries: what the panel will never do,
     * then Close. Worded to stay true once phase 3 fills the page, because
     * filling the page model is not saving -- Publish stays the user's step. */
    const toolbar = el("footer", "toolbar");
    toolbar.appendChild(el("span", "toolbar-note",
      "Never saves or publishes — Translation Assistant leaves Publish to you."));
    const footerClose = el("button", "", "Close");
    footerClose.type = "button";
    footerClose.addEventListener("click", () => userClose("footer-close"));
    toolbar.appendChild(footerClose);
    panel.appendChild(toolbar);

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

  /* What the panel is for, then the language pair in the house's teal mono
   * accent -- the same shape as the Translation Lens subtitle. Built from
   * spans rather than markup, because the pair is page-derived text. */
  function renderSubtitle(context) {
    if (!subtitleEl) return;
    clear(subtitleEl);
    subtitleEl.appendChild(el("span", "", "Hands this item's untranslated fields to your own AI tool"));
    const pair = languagePair(context);
    if (!pair) return;
    subtitleEl.appendChild(el("span", "", " — "));
    subtitleEl.appendChild(el("span", "mono", pair));
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
    /* The house's indeterminate bar, so a slow frame read looks like work
     * rather than a stall. Reduced motion freezes it at full width. */
    const bar = el("div", "bar-indeterminate");
    bar.appendChild(el("span"));
    bodyEl.appendChild(bar);
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

    const fields = count(counts.fields);
    const total = el("li");
    total.appendChild(el("span", "n", String(fields)));
    total.appendChild(el("span", "what", plural(fields, "field") + " on this item"));
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

    /* Fields, not rows, because this line is read as arithmetic against the
     * total above. Two fields sharing one destination are one exported row and
     * two fields; printing the row count here left a gap that no exclusion
     * bucket accounted for, and the demo item never showed it because none of
     * its eligible groups had a second member. */
    const rows = count(counts.eligible);
    const eligible = count(counts.eligibleFields) || rows;
    const row = el("li", eligible ? "total" : "total none");
    row.appendChild(el("span", "n", String(eligible)));
    row.appendChild(el("span", "what", "to translate"));
    if (rows && rows !== eligible) {
      row.appendChild(el("span", "why",
        "(in " + rows + " " + plural(rows, "translation row") + " — some fields share one)"));
    }
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
    if (draft.languages) renderSubtitle(draft.languages);

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
    /* instanceWideRows, never sharedRows. A row with one member on this item is
     * still shared instance-wide when the platform keys it by source string,
     * and that is the common case, not the exception. */
    if (draft.instanceWideRows) bodyEl.appendChild(sharedNote(draft.instanceWideRows));
    return true;
  }

  function unlockNote() {
    return el("p", "note info",
      "A field that already has a translation is left alone. To have one redone, " +
      "unlock it on this page first, then run Translation Assistant again.");
  }

  /* Stated once, above the routes, because it is the platform's storage model
   * and the user is entitled to know it before they publish. "Source text",
   * not "English text": the source language is whatever the picker says it is.
   */
  function sharedNote(rows) {
    const n = count(rows);
    return el("p", "note flag",
      n === 1
        ? "One of these translations is shared: publishing it changes that translation " +
          "for every catalog item on this instance whose field uses the same source text."
        : n + " of these translations are shared: publishing them changes those translations " +
          "for every catalog item on this instance whose fields use the same source text.");
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

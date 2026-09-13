/*
 * Isolated-world visual panel for the "Translation Assistant" command.
 *
 * Two steps on one panel. The export shows what an item has, what it cannot
 * translate and why, and hands the payload out. Under it, the reply comes back:
 * pasted or uploaded, handed to callbacks.onFill, and reported. The panel never
 * touches the page itself -- the worker re-reads, re-checks and fills -- and it
 * never saves or publishes.
 *
 * There is no preview step before the fill, by the owner's decision: the
 * comparison page is the preview, since nothing is saved until Publish and a
 * reload discards every fill. So the report is where the panel earns its
 * keep. It names every row that was not filled and why, offers the two choices
 * a user can make -- fill a placeholder mismatch anyway, overwrite a field
 * changed on the page against the values shown -- and lists each translation a
 * fill replaced, with the old text, so it can be put back.
 *
 * The exact contract content.js validates before any page data is read:
 *
 *   open({ fingerprint, context, callbacks })
 *   showDraft({ fingerprint, draft })
 *   showError({ fingerprint, message })
 *   close({ fingerprint, reason })
 *
 * callbacks.onFill({ text, include, overrides }) resolves to the worker's
 * answer; the panel renders it only if the same run is still on screen.
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
 *     will not translate is a stated limit, never a silent omission. Two of
 *     the buckets -- already translated, and rich text -- open into a list
 *     on request, each field linked to where its translation is kept. The
 *     counts stay first; the list is for checking, not reading.
 *   - The tally is one accounting system, and it is counted in FIELDS. The
 *     exported row count is a different number -- two fields can share one
 *     destination -- and where they differ the panel says so rather than
 *     printing one where the reader is subtracting the other.
 *   - It wears the shared GlideLens palette and chrome: a dark panel, teal for
 *     focus and grouping, pink for the one primary action, and a footer that
 *     states what the panel never does. There is no build step to share CSS,
 *     so every panel carries a verbatim copy of the tokens and a test in
 *     command_palette.test.js catches a panel that drifts from them.
 *   - Feedback lands on the control that was pressed. The command palette's
 *     toast is gone by the time this panel is up, so a notice sent there is
 *     never seen: a copy that worked looked exactly like one that did not.
 *   - A claim the user cannot check is named and linked. Every shared
 *     translation is listed, with a link to the fields that use its text and
 *     another to the sys_translated row a publish would write.
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
      width:min(880px,calc(100vw - 24px));max-height:calc(100vh - 24px);
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
    .note p{margin:0}
    .shared-list{list-style:none;margin:8px 0 0;padding:0}
    .shared-list li{padding:6px 0 5px;border-top:1px solid var(--flag-line)}
    .shared-list li:first-child{border-top:0}
    .shared-list .src{display:block;color:#fff3d6;font-weight:650;overflow-wrap:anywhere}
    .shared-list .where{color:#b9ad8a}
    /* Every listed field keeps one shape however long its text: the text on
       its own lines, then a foot line with where the field lives on the left
       and its links on the right. A wrapping row let the length of the text
       decide which line each piece landed on, so no two entries matched. */
    .foot{display:flex;align-items:center;gap:14px;margin-top:2px;font-size:11px}
    .foot .where{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .foot .verify,.foot .verify-links,.foot .verify-none{margin-left:auto;flex:none}
    .verify{
      background:none;border:0;padding:0;cursor:pointer;font-size:11px;
      color:color-mix(in srgb, var(--teal) 84%, white);text-decoration:underline;
      text-underline-offset:2px;white-space:nowrap;
    }
    .verify:hover{color:#fff}
    .verify-links{display:flex;gap:12px}
    .note .sub{margin:6px 0 0;font-size:11px;color:#b9ad8a}
    [hidden]{display:none !important}
    .toggle{
      margin-left:auto;background:none;border:0;padding:0;cursor:pointer;font-size:11px;
      color:color-mix(in srgb, var(--teal) 84%, white);text-decoration:underline;
      text-underline-offset:2px;white-space:nowrap;
    }
    .toggle:hover{color:#fff}
    .tally li.detail{display:block;padding:2px 0 10px 3.2em}
    .excluded-list{list-style:none;margin:0;padding:0 0 0 12px;border-left:2px solid #2e2e4e}
    .tally .excluded-list li{display:block;padding:8px 0;border-top:1px solid #29293f}
    .tally .excluded-list li:first-child{border-top:0;padding-top:2px}
    /* One line each, the whole text on hover: the list is for checking which
       field was left out, not for reading it. */
    .excluded-list .src,.excluded-list .tgt{
      display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .excluded-list .src{color:#ececf8}
    .excluded-list .tgt{color:color-mix(in srgb, var(--teal) 70%, #cfeee9)}
    .excluded-list .untranslated{display:block;color:#85859f;font-size:12px}
    .excluded-list .where{color:#85859f}
    .verify-none{font-size:11px;color:#b9ad8a}
    .step{margin:22px 0 0;padding:16px 0 0;border-top:1px solid #2e2e4e}
    h3{font-size:14px;line-height:1.3;margin:0 0 5px;color:#f0f0fa;font-weight:650}
    .reply{
      display:block;width:100%;min-height:96px;resize:vertical;margin:8px 0 10px;padding:8px 10px;
      font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;color:#dedeee;
      background:#16162a;border:1px solid #3a3a5c;border-radius:7px;
    }
    .reply:focus{border-color:var(--teal);outline:none}
    .reply-actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
    .action{
      border:1px solid #4a4a70;background:#2c2c48;color:#f0f0fa;border-radius:7px;
      padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;
    }
    .action:hover{background:#37375a;color:#fff}
    .action:disabled,.choice:disabled{opacity:.55;cursor:default}
    .reply-status{margin:8px 0 0;font-size:12px;color:#aaaac1;min-height:1em}
    .reply-status.err{color:#ffc9c9}
    .report-head{margin:0 0 6px;color:#f5f5ff;font-size:14px;font-weight:650}
    .report-sub{margin:0 0 10px;color:#aaaac1;font-size:12px}
    .excerpt{
      margin:6px 0 0;padding:8px 10px;border-radius:7px;background:#16162a;color:#aaaac1;
      font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;
    }
    /* One report entry reads top to bottom like a form field: which field,
       its text, then a labelled pair of values (the reply's against the
       page's), and last the reason with its button beside it. Every piece
       keeps to one line, whole on hover, so entries line up with each other. */
    .report-list{list-style:none;margin:6px 0 14px;padding:0 0 0 12px;border-left:2px solid #2e2e4e}
    .report-list li{padding:10px 0;border-top:1px solid #29293f}
    .report-list li:first-child{border-top:0;padding-top:2px}
    .report-list .field,.report-list .src,.report-list .pair dd{
      display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .report-list .field{font-size:11px;color:#85859f;margin-bottom:1px}
    .report-list .src{color:#ececf8;font-weight:650}
    .report-list .pair{
      display:grid;grid-template-columns:max-content minmax(0,1fr);column-gap:10px;row-gap:2px;
      margin:4px 0 0;font-size:12px;
    }
    .report-list .pair dt{color:#85859f;white-space:nowrap}
    .report-list .pair dd{margin:0}
    .report-list .pair dd.tgt{color:color-mix(in srgb, var(--teal) 70%, #cfeee9)}
    .report-list .pair dd.was{color:#c9c9dc}
    .report-list .pair .mem{margin-left:8px;font-size:11px;color:#85859f}
    .report-list .verdict{display:flex;align-items:center;gap:12px;margin-top:6px}
    .report-list .reason{flex:1;min-width:0;color:var(--flag);font-size:12px;line-height:1.4}
    .choice{
      flex:none;border:1px solid #4a4a70;background:#2c2c48;color:#f0f0fa;border-radius:6px;
      padding:4px 10px;font-size:12px;cursor:pointer;
    }
    .choice:hover{background:#37375a}
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
    @media(max-width:680px){.overlay{padding:8px}.panel{width:100%}.header{padding:14px}.foot{flex-wrap:wrap}}
  `;

  let host = null;
  let shadow = null;
  let bodyEl = null;
  let subtitleEl = null;
  let callbacks = {};
  let runFingerprint = null;
  let previousFocus = null;
  /* One fill at a time from this panel. The worker holds the real lock; this
   * only stops a second click sending a request the worker would refuse. */
  let filling = false;
  /* What this run's fills have put on the page, by row: see recordWritten. */
  let fillHistory = new Map();

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

  /*
   * Feedback on the control that was pressed, the way Translation Lens confirms
   * its copy. notify() reaches the command palette's toast, and the palette has
   * closed by the time this panel is on screen, so nothing sent there is seen.
   */
  const FLASH_MS = 2200;
  function flash(node, text) {
    if (!node) return;
    if (node.flashRestore === undefined) node.flashRestore = node.textContent;
    node.textContent = text;
    if (node.flashTimer) clearTimeout(node.flashTimer);
    node.flashTimer = setTimeout(() => {
      node.flashTimer = null;
      node.textContent = node.flashRestore;
    }, FLASH_MS);
  }

  /* A lasting label change, which also cancels any flash still pending so the
   * flash cannot put the old label back over it. */
  function relabel(node, text) {
    if (!node) return;
    if (node.flashTimer) {
      clearTimeout(node.flashTimer);
      node.flashTimer = null;
    }
    node.flashRestore = text;
    node.textContent = text;
  }

  function currentOrigin() {
    try {
      return (typeof location !== "undefined" && location && location.origin) || "";
    } catch (error) {
      return "";
    }
  }

  /* Same-origin http(s) only, as in Translation Lens; the worker checks again. */
  function validatedUrl(value) {
    const raw = str(value).trim();
    const origin = currentOrigin();
    if (!raw || !origin || typeof URL !== "function") return "";
    let parsed;
    try { parsed = new URL(raw, origin); } catch (error) { return ""; }
    if (parsed.origin !== origin) return "";
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.href;
  }

  function openUrl(url) {
    const safe = validatedUrl(url);
    if (!safe || !isFn(callbacks.onOpenUrl)) return false;
    try {
      const outcome = callbacks.onOpenUrl(safe);
      if (outcome && isFn(outcome.catch)) outcome.catch(() => {});
    } catch (error) { /* navigation is best-effort; the panel stays open */ }
    return true;
  }

  /*
   * Translation Lens's rules for what a list link may carry: a table or
   * column starts with a letter, a language is sys_language.id-shaped (fr,
   * es-MX, pb), and a value the encoded-query language cannot carry -- empty,
   * over 255 characters, a caret or a line break -- gets no link rather than a
   * wrong one. And one rule more: the server evaluates a value that is a
   * javascript: expression instead of matching it as words, and encoding the
   * URL does not stop it (Codex review, measured on the PDI). So any value
   * naming that scheme is refused, in any case and wherever it sits.
   * Refusing too much costs a link; refusing too little opens a list whose
   * filter is someone's script.
   */
  const TABLE_PATTERN = /^[a-z][a-z0-9_]*$/;
  const LANGUAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
  function queryValueProblem(value) {
    const text = str(value);
    if (/javascript\s*:/i.test(text)) return "a list filter would run this text as a script";
    if (!text || text.length > 255 || /[\^\r\n]/.test(text)) return "a list filter cannot express this text";
    return "";
  }
  function queryValueOk(value) {
    return !queryValueProblem(value);
  }

  /*
   * Every record in the field's own table whose column holds this text: the
   * fields that would pick up a translation published for it. Built only from
   * the page's own (table, column). The server's = is case-insensitive, as the
   * platform's lookup is; it does not fold accents, which the lookup also
   * does, so the list can under-show.
   */
  function whereUsedUrl(row) {
    const table = str(row && row.table);
    const column = str(row && row.column);
    const source = str(row && row.source);
    if (!TABLE_PATTERN.test(table) || !TABLE_PATTERN.test(column) || !queryValueOk(source)) return "";
    return `/${table}_list.do?sysparm_query=${encodeURIComponent(`${column}=${source}`)}`;
  }

  /*
   * The row a publish writes for this field: sys_translated keyed on (name,
   * element, value, language), with name the page's own table -- the defining
   * table, which is where these rows live -- and the same key Translation Lens
   * links to. Some instances also hold record-keyed sys_translated_text rows
   * for these fields and which store renders is unverified, so this names only
   * the one the save path writes.
   */
  function storedTranslationUrl(row, language) {
    const table = str(row && row.table);
    const column = str(row && row.column);
    const source = str(row && row.source);
    const lang = str(language);
    if (!TABLE_PATTERN.test(table) || !TABLE_PATTERN.test(column) ||
      !LANGUAGE_PATTERN.test(lang) || !queryValueOk(source)) return "";
    const query = `name=${table}^element=${column}^value=${source}^language=${lang}`;
    return `/sys_translated_list.do?sysparm_query=${encodeURIComponent(query)}`;
  }

  /*
   * Where an excluded field's translation is kept, for the lists behind the
   * "already translated" and "rich text" counts. A shared-text field uses the
   * same sys_translated key as the shared list. A per-record field is keyed by
   * the record's sys_id in sys_translated_text. tablename is left out on
   * purpose: that column can hold the concrete table (item_option_new) while
   * the page names the defining one (question), and a sys_id is unique without
   * it. That precaution has not yet been checked on a live instance.
   */
  const SYS_ID_PATTERN = /^[0-9a-f]{32}$/;
  function excludedStoreUrl(entry, language) {
    const lang = str(language);
    if (!LANGUAGE_PATTERN.test(lang)) return "";
    const store = str(entry && entry.store);
    if (store === "sys_translated") return storedTranslationUrl(entry, lang);
    if (store !== "sys_translated_text") return "";
    const sysId = str(entry && entry.sysId).toLowerCase();
    const column = str(entry && entry.column);
    if (!SYS_ID_PATTERN.test(sysId) || !TABLE_PATTERN.test(column)) return "";
    const query = `documentkey=${sysId}^fieldname=${column}^language=${lang}`;
    return `/sys_translated_text_list.do?sysparm_query=${encodeURIComponent(query)}`;
  }

  /* Rich text arrives as markup, so the list shows it as plain words. Every
   * other type is literal text and keeps every character -- "Enter <account>
   * here" is not markup -- with only its runs of white space folded, as one
   * line would fold them anyway. Both go in through textContent like
   * everything else here, never as markup. */
  const SPACE = String.fromCharCode(32);
  function plainWords(value) {
    return str(value).replace(/<[^>]*>/g, SPACE).replace(/\s+/g, SPACE).trim();
  }
  function oneLine(value) {
    return str(value).replace(/\s+/g, SPACE).trim();
  }
  function shorten(text, limit) {
    if (text.length <= limit) return text;
    const cut = text.slice(0, limit - 1);
    const space = cut.lastIndexOf(SPACE);
    /* A whole word, unless one unbroken run of characters fills the preview. */
    const kept = space > limit / 2 ? cut.slice(0, space) : cut;
    return `${kept.replace(/[\s,;:.]+$/, "")}…`;
  }

  /* Quoted and shortened at a whole word. The stylesheet keeps it to one
   * line, which can clip even a short text in a narrow window, so the whole
   * text is always one hover away: the literal value for plain text, the
   * plain words for rich text. */
  const PREVIEW_CHARS = 140;
  function quotedPreview(className, prefix, value, rich, tag) {
    const shown = rich ? plainWords(value) : oneLine(value);
    const node = el(tag || "span", className, `${prefix}“${shorten(shown, PREVIEW_CHARS)}”`);
    const whole = rich ? shown : str(value);
    if (whole) node.title = whole;
    return node;
  }

  /* The line under a listed field: where it lives, cut to one line with the
   * whole of it on hover, and at the right whatever links it has. */
  function footLine(where, trailing) {
    if (!where && !trailing) return null;
    const foot = el("div", "foot");
    const whereNode = el("span", "where", where);
    if (where) whereNode.title = where;
    foot.appendChild(whereNode);
    if (trailing) foot.appendChild(trailing);
    return foot;
  }

  /* The two counts that can open into a list. The counts stay the first thing
   * shown; the list is there to check, not to read. */
  const DETAIL_BUCKETS = new Set(["locked", "rich_text"]);

  function excludedList(entries, languages) {
    const language = str(languages && languages.targetLanguage);
    const languageLabel = str(languages && languages.targetLanguageName) || language;
    const inLanguage = languageLabel ? `${languageLabel} translation` : "translation";
    const ul = el("ul", "excluded-list");
    entries.forEach((entry) => {
      const li = el("li");
      /* Only rich text is markup; the engine puts every HTML field in that
       * bucket before it looks at locks. */
      const rich = entry.reason === "rich_text";
      li.appendChild(quotedPreview("src", "", entry.source, rich));
      /* Whether a translation exists is a property of the value, not of what
       * survives once markup is stripped: "<compte>" is a translation. */
      li.appendChild(str(entry.target)
        ? quotedPreview("tgt", "→ ", entry.target, rich)
        : el("span", "untranslated", `no ${inLanguage} yet`));
      const url = excludedStoreUrl(entry, language);
      let trailing = null;
      if (url && isFn(callbacks.onOpenUrl)) {
        trailing = el("button", "verify", `Stored ${inLanguage} ↗`);
        trailing.type = "button";
        trailing.addEventListener("click", () => { openUrl(url); });
      } else if (str(entry.store) === "sys_translated" && queryValueProblem(entry.source)) {
        /* Stored under its text, so a text no filter can carry gets no link,
         * and the entry says so rather than leaving a gap. */
        trailing = el("span", "verify-none", `no list link: ${queryValueProblem(entry.source)}`);
      }
      const foot = footLine([str(entry.label), str(entry.groupName)].filter(Boolean).join(" · "), trailing);
      if (foot) li.appendChild(foot);
      ul.appendChild(li);
    });
    return ul;
  }

  function unmount() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
    bodyEl = null;
    subtitleEl = null;
    runFingerprint = null;
    filling = false;
    fillHistory = new Map();
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
    fillHistory = new Map();
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

    const excluded = Array.isArray(draft && draft.excluded) ? draft.excluded : [];
    BUCKETS.forEach((bucket) => {
      const n = count(counts[bucket.key]);
      if (!n) return;
      const row = el("li");
      row.appendChild(el("span", "n", String(n)));
      row.appendChild(el("span", "what", bucket.what));
      row.appendChild(el("span", "why", "(excluded — " + bucket.why + ")"));
      list.appendChild(row);

      const entries = DETAIL_BUCKETS.has(bucket.key)
        ? excluded.filter((entry) => entry && entry.reason === bucket.key) : [];
      if (!entries.length) return;
      const detail = el("li", "detail");
      detail.hidden = true;
      detail.appendChild(excludedList(entries, draft.languages));
      const toggle = el("button", "toggle", "Show them");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        detail.hidden = !detail.hidden;
        toggle.textContent = detail.hidden ? "Show them" : "Hide";
        toggle.setAttribute("aria-expanded", detail.hidden ? "false" : "true");
      });
      row.appendChild(toggle);
      list.appendChild(detail);
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
      relabel(button, "Download again");
    } catch (error) {
      notify("The download could not start: " + String(error && error.message ? error.message : error), true);
      flash(button, "Download failed — try Copy instead");
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  async function copy(draft, link) {
    const text = str(draft && draft.serialized);
    if (!text) {
      notify("There is nothing to copy.", true);
      flash(link, "Nothing to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      notify("Prompt and JSON copied. Paste it into your AI tool.", false);
      flash(link, "Copied — paste it into your AI tool");
    } catch (error) {
      notify("Copying failed. Use Download JSON instead.", true);
      flash(link, "Copy failed — use Download JSON instead");
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
    copyLink.addEventListener("click", () => { copy(draft, copyLink); });
    bodyEl.appendChild(copyLink);

    if (draft.counts && count(draft.counts.locked)) bodyEl.appendChild(unlockNote());
    /* instanceWide, never sharedRows. A row with one member on this item is
     * still shared instance-wide when the platform keys it by source string,
     * and that is the common case, not the exception. */
    if (Array.isArray(draft.instanceWide) && draft.instanceWide.length) {
      bodyEl.appendChild(sharedNote(draft.instanceWide, draft.languages));
    }
    bodyEl.appendChild(replySection(""));
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
  function sharedNote(rows, languages) {
    const list = Array.isArray(rows) ? rows : [];
    const n = list.length;
    const language = str(languages && languages.targetLanguage);
    const languageLabel = str(languages && languages.targetLanguageName) || language;
    const inLanguage = languageLabel ? `${languageLabel} translation` : "translation";
    const linked = isFn(callbacks.onOpenUrl);
    const box = el("div", "note flag");
    box.appendChild(el("p", "",
      n === 1
        ? "One of these translations is shared: publishing it changes that translation " +
          "for every catalog item on this instance whose field uses the same source text."
        : n + " of these translations are shared: publishing them changes those translations " +
          "for every catalog item on this instance whose fields use the same source text."));
    if (linked) {
      /* Every row listed here is unlocked. In ad-hoc mode that usually means
       * no translation exists yet, so the stored list is usually empty, and
       * saying so stops an empty list reading as a broken link. But a
       * translation unlocked to be redone is unlocked too and still stored
       * (Codex review), so the sentence names both cases rather than
       * promising the first. */
      box.appendChild(el("p", "sub",
        `Each links to the fields that use its text, and to where its ${inLanguage} ` +
        "is stored — empty unless one was published and then unlocked to be redone."));
    }

    /* Named, and linked to where each text is used and where its translation
     * is kept, so the claim above can be checked rather than taken on trust. */
    const ul = el("ul", "shared-list");
    list.forEach((row) => {
      const li = el("li");
      li.appendChild(el("span", "src", `“${str(row.source)}”`));
      const where = [str(row.kind), str(row.context)].filter(Boolean).join(" · ");
      const links = [
        { url: whereUsedUrl(row), label: "Where this text is used ↗" },
        { url: storedTranslationUrl(row, language), label: `Stored ${inLanguage} ↗` },
      ].filter((entry) => entry.url);
      let trailing = null;
      if (links.length && linked) {
        trailing = el("span", "verify-links");
        links.forEach((entry) => {
          const link = el("button", "verify", entry.label);
          link.type = "button";
          link.addEventListener("click", () => { openUrl(entry.url); });
          trailing.appendChild(link);
        });
      } else if (queryValueProblem(row.source)) {
        trailing = el("span", "verify-none", `no list links: ${queryValueProblem(row.source)}`);
      }
      const foot = footLine(where, trailing);
      if (foot) li.appendChild(foot);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }

  /* ------------------------------------------------------ step 2: the reply */

  function say(node, text, isError) {
    if (!node) return;
    node.textContent = text;
    node.className = isError ? "reply-status err" : "reply-status";
  }

  /* A reply is capped at 5 MB of text by the engine; this only stops a file
   * that cannot be one from being read into memory at all. */
  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

  /*
   * Where the model's reply comes back. Fill is a plain button, not the pink
   * one: on the export view Download keeps the one primary. The upload is the
   * escape hatch, as Copy is for the export, and it only loads the file into
   * the box -- choosing a file should not write to the page by itself.
   */
  function replySection(text) {
    const section = el("section", "step");
    section.appendChild(el("h3", "", "Got the reply back?"));
    section.appendChild(el("p", "hint",
      "Paste it here to fill the page. Nothing is saved until you press Publish, and reloading " +
      "the page before then discards every fill."));
    const box = el("textarea", "reply");
    box.setAttribute("aria-label", "The reply from your AI tool");
    box.setAttribute("spellcheck", "false");
    box.value = str(text);
    section.appendChild(box);

    const actions = el("div", "reply-actions");
    const fill = el("button", "action", "Fill the page");
    fill.type = "button";
    const upload = el("button", "secondary", "Upload a file instead");
    upload.type = "button";
    const picker = el("input");
    picker.type = "file";
    picker.setAttribute("accept", ".json,application/json,text/plain");
    picker.hidden = true;
    actions.appendChild(fill);
    actions.appendChild(upload);
    actions.appendChild(picker);
    section.appendChild(actions);
    const status = el("p", "reply-status");
    status.setAttribute("aria-live", "polite");
    section.appendChild(status);

    fill.addEventListener("click", () => {
      const reply = str(box.value);
      if (!reply.trim()) {
        say(status, "Paste the reply first, or upload its file.", true);
        return;
      }
      runFill({ text: reply, include: [], overrides: [] }, [fill, upload], status);
    });
    upload.addEventListener("click", () => {
      picker.value = "";
      picker.click();
    });
    picker.addEventListener("change", () => { loadReplyFile(picker, box, status); });
    return section;
  }

  async function loadReplyFile(picker, box, status) {
    const file = picker.files && picker.files[0];
    if (!file) return;
    if (Number(file.size) > MAX_UPLOAD_BYTES) {
      say(status, "That file is too large to be a reply.", true);
      return;
    }
    try {
      box.value = await file.text();
      say(status, `Loaded ${str(file.name) || "the file"}. Press Fill the page.`, false);
    } catch (error) {
      say(status, "That file could not be read.", true);
    }
  }

  async function runFill(request, controls, status) {
    if (filling || !isFn(callbacks.onFill)) return;
    const fingerprint = runFingerprint;
    filling = true;
    controls.forEach((node) => { node.disabled = true; });
    say(status, "Filling the page…", false);
    let result;
    try {
      result = await callbacks.onFill(request);
    } catch (error) {
      result = { ok: false, message: "The fill could not run: " + String(error && error.message ? error.message : error) };
    }
    /* Closed or replaced while it waited: nothing to show. The fill itself is
     * the worker's, and has run or not either way. */
    if (!sameRun(fingerprint)) return;
    filling = false;
    showReport(request, result || { ok: false, message: "No answer came back from the fill." });
  }

  const tokens = (list) => (Array.isArray(list) && list.length ? list.map(str).join(" ") : "none");

  /* Why a row was not filled, in the user's terms. Never "verified", and never
   * a reason the engine did not give. */
  function reasonFor(row) {
    const detail = (row && row.detail) || {};
    const who = str(detail.elementId);
    switch (str(row && row.verdict)) {
      case "fill":
        return row.warning === "placeholder"
          ? `placeholders differ — the source has ${tokens(detail.source)}, the translation has ${tokens(detail.target)}`
          : "";
      case "not_returned": return "not in the reply";
      case "blank": return "blank in the reply — an existing translation is never cleared";
      case "locked":
        return who
          ? `“${who}” is locked, and they share one translation — unlock it on the page to fill this`
          : "locked — unlock it on the page to fill this";
      case "too_long":
        return `${count(detail.length)} characters — this field holds ${count(detail.maxLength)}`;
      case "source_changed": return "its source text changed since the draft — draft again to translate it";
      case "edited":
        return row.overrideVoid
          ? "changed on the page again since you chose to overwrite it"
          : "changed on the page since the draft";
      case "not_exported":
        return who
          ? `shares its translation with “${who}”, which was not in the draft — draft again`
          : "shares its translation with a field that was not in the draft — draft again";
      case "missing": return "no longer on this page";
      case "ineligible": return "can no longer be filled on this page";
      default: return str(row && row.verdict) || "not filled";
    }
  }

  /* One entry: which field, its source text, then the values that matter for
   * it as a labelled pair -- the reply's translation against what the page
   * holds, or against what a fill replaced. A label per value replaced the
   * arrow and the "on the page" prefix, which read as one run of text. */
  function reportRow(row, pairs) {
    const li = el("li");
    const where = [str(row.kind), str(row.context)].filter(Boolean).join(" · ");
    if (where) {
      const field = el("span", "field", where);
      field.title = where;
      li.appendChild(field);
    }
    li.appendChild(quotedPreview("src", "", row.source, false));
    const shown = (pairs || []).filter((pair) => str(pair[2]));
    if (shown.length) {
      const dl = el("dl", "pair");
      shown.forEach(([label, className, value, member]) => {
        dl.appendChild(el("dt", "", label));
        const dd = quotedPreview(className, "", value, false, "dd");
        if (str(member)) {
          const who = el("span", "mem", str(member));
          who.title = str(member);
          dd.appendChild(who);
        }
        dl.appendChild(dd);
      });
      li.appendChild(dl);
    }
    return li;
  }

  /* The page's value for a row: one line when its fields agree, and one line
   * per field, each naming its field, when they do not -- a shared row must
   * never show one value in place of another (Codex review). An empty field
   * says so rather than being left out. */
  function valuePairs(label, className, members) {
    const list = (members || []).map((member) => ({
      name: str(member && member.elementId),
      value: str(member && member.liveTarget),
    }));
    const distinct = list.map((entry) => entry.value).filter((value, i, all) => all.indexOf(value) === i);
    if (list.length <= 1 || distinct.length <= 1) return [[label, className, distinct[0] || "(empty)"]];
    return list.map((entry, i) => [i ? "" : label, className, entry.value || "(empty)", entry.name]);
  }

  /* The last line of an entry: why it stands there, and beside it the one
   * thing the user can do about it, when there is one. */
  function verdictLine(reason, choice) {
    const line = el("div", "verdict");
    line.appendChild(el("span", "reason", reason));
    if (choice) line.appendChild(choice);
    return line;
  }

  /*
   * Every FIELD a fill wrote on this page during this run, by record
   * identity, with the text it held before and whether the page confirmed
   * the write. Kept across clicks: after Fill anyway or Overwrite the worker
   * evaluates the earlier rows as unchanged, because the page now holds
   * their replacement -- but the replacement is still unpublished, and the
   * old text is still what a user needs to put a field back. The first write
   * of a field is the one that knew the old text, so it is never replaced;
   * a field written later joins. Keyed by field, not by row number: a row
   * number belongs to one draft, and a reply from another draft can reuse it
   * for another destination. A refused click leaves the page as it was, so
   * the history shows through a refusal too.
   */
  let historySeq = 0;
  function recordWritten(rows, wroteMember, confirmed) {
    historySeq += 1;
    rows.forEach((row) => {
      (row.members || []).forEach((member) => {
        const id = str(member && member.identityKey);
        if (!id || !wroteMember(row, member)) return;
        const known = fillHistory.get(id);
        if (known) {
          /* Written again by a later reply. The old text is still what the
           * field held before any fill, but what it holds now, and whether
           * the page confirmed it, are this write's -- an unconfirmed write
           * over a confirmed one leaves the field uncertain (Codex review). */
          known.row = row;
          known.confirmed = !!confirmed;
          known.seq = historySeq;
          return;
        }
        fillHistory.set(id, {
          /* The stored translation this field writes to, stable across drafts. */
          destination: str(row.destinationKey) || `row:${row.k}`,
          row,
          elementId: str(member.elementId),
          liveTarget: str(member.liveTarget),
          confirmed: !!confirmed,
          seq: historySeq,
        });
      });
    });
  }

  /* The history grouped the way the page stores it: one group per
   * destination, holding every written field that shares that stored
   * translation. The group shows the most recent write's row, so its target
   * is what the page holds now. Shared translations are counted by
   * destination, not by field, so two fields sharing one stored row count
   * once. */
  function historyGroups() {
    const groups = new Map();
    fillHistory.forEach((entry) => {
      let group = groups.get(entry.destination);
      if (!group) {
        group = { row: entry.row, seq: entry.seq, members: [], confirmed: true };
        groups.set(entry.destination, group);
      } else if (entry.seq > group.seq) {
        group.row = entry.row;
        group.seq = entry.seq;
      }
      group.members.push({ elementId: entry.elementId, liveTarget: entry.liveTarget });
      if (!entry.confirmed) group.confirmed = false;
    });
    return Array.from(groups.values());
  }

  /* What a user must know before Publish about what this run has put on the
   * page: any write the page never confirmed, which translations were
   * replaced, with their old text because clearing the box would not bring
   * one back (a blank publishes as a deletion), and how many of the filled
   * translations are shared. An unconfirmed write is never presented as a
   * replacement that happened: its old text is kept, labelled as attempted. */
  function recoverySections() {
    const groups = historyGroups();
    const unconfirmed = Array.from(fillHistory.values()).filter((entry) => !entry.confirmed).length;
    const unconfirmedNode = unconfirmed
      ? el("p", "note flag",
        `${unconfirmed} attempted ${plural(unconfirmed, "fill")} on this page ${unconfirmed === 1 ? "was" : "were"} ` +
        "never confirmed by the page — check " + (unconfirmed === 1 ? "that field" : "those fields") + " before you publish.")
      : null;

    const replaced = groups.filter((group) => group.members.some((member) => member.liveTarget));
    let replacedNode = null;
    if (replaced.length) {
      replacedNode = el("div");
      replacedNode.appendChild(el("h3", "", `Replaced ${replaced.length} existing ${plural(replaced.length, "translation")}`));
      replacedNode.appendChild(el("p", "report-sub",
        "To keep an old one, type it back into its box before you publish — clearing the box deletes it."));
      const ul = el("ul", "report-list");
      replaced.forEach((group) => {
        ul.appendChild(reportRow(group.row, [[group.confirmed ? "Filled" : "Attempted", "tgt", group.row.target]]
          .concat(valuePairs("Was", "was", group.members))));
      });
      replacedNode.appendChild(ul);
    }

    const sharedGroups = groups.filter((group) => group.row.instanceWide);
    const shared = sharedGroups.length;
    const how = sharedGroups.some((group) => !group.confirmed) ? "filled or attempted" : "filled";
    const sharedNode = shared
      ? el("p", "note flag",
        shared === 1
          ? `One translation ${how} on this page is shared: publishing it changes that translation for every ` +
            "catalog item on this instance whose field uses the same source text."
          : `${shared} translations ${how} on this page are shared: publishing them changes those translations ` +
            "for every catalog item on this instance whose fields use the same source text.")
      : null;
    return { unconfirmed: unconfirmedNode, replaced: replacedNode, shared: sharedNode };
  }

  function showReport(request, result) {
    clear(bodyEl);
    const res = result || {};
    if (!res.ok) {
      if (res.indeterminate) {
        bodyEl.appendChild(el("p", "note flag", str(res.message) ||
          "The fill may still be running. Check the page before filling again."));
      } else {
        bodyEl.appendChild(el("p", "error", str(res.message) || "Nothing was filled."));
        if (str(res.excerpt)) {
          bodyEl.appendChild(el("p", "report-sub", "The reply starts:"));
          bodyEl.appendChild(el("pre", "excerpt", str(res.excerpt)));
        }
      }
      const recovery = recoverySections();
      if (recovery.unconfirmed) bodyEl.appendChild(recovery.unconfirmed);
      if (recovery.replaced) bodyEl.appendChild(recovery.replaced);
      if (recovery.shared) bodyEl.appendChild(recovery.shared);
      bodyEl.appendChild(replySection(request.text));
      return;
    }

    const report = res.report || {};
    const rows = Array.isArray(report.rows) ? report.rows : [];
    const filled = new Set((Array.isArray(report.filled) ? report.filled : []).map(Number));
    const missedRows = new Set((Array.isArray(res.missed) ? res.missed : []).map(Number));
    /* Which member of a row did not take, when the worker could say. Several
     * fields can share one row, and one landing while another misses is both
     * a replacement to remember and a field to check. A miss named by row
     * only is the whole row. */
    const missedFields = (Array.isArray(res.missedFields) ? res.missedFields : [])
      .filter((entry) => entry && typeof entry.identityKey === "string");
    const missedMembers = new Set(missedFields.map((entry) => entry.identityKey));
    const detailed = new Set(missedFields.map((entry) => Number(entry.k)));
    const memberMissed = (row, member) =>
      missedMembers.has(str(member.identityKey)) || (missedRows.has(row.k) && !detailed.has(row.k));
    const unconfirmed = !!res.written && res.confirmed === false;
    const wroteMember = (row, member) =>
      !!res.written && filled.has(row.k) && (unconfirmed || !memberMissed(row, member));
    const landed = count(res.landed);
    const attempted = count(res.attempted);

    if (unconfirmed) {
      /* The event fired and the page holds what it took, but the model could
       * not be read back: no count is honest, so every attempted field is one
       * to look at. */
      bodyEl.appendChild(el("p", "note flag",
        `Attempted to fill ${attempted} ${plural(attempted, "field")}, but the page could not confirm it` +
        (str(res.why) ? ` (${str(res.why)})` : "") + ". Check each one on the page before you publish."));
    } else if (res.written && landed === attempted) {
      bodyEl.appendChild(el("p", "report-head", `Filled ${landed} ${plural(landed, "field")}.`));
    } else if (res.written) {
      bodyEl.appendChild(el("p", "note flag",
        `Filled ${landed} of ${attempted} fields — ${attempted - landed} did not take on the page. ` +
        "Check those before you publish."));
    } else {
      bodyEl.appendChild(el("p", "report-head", "Nothing was filled."));
    }
    if (res.written) {
      bodyEl.appendChild(el("p", "hint",
        "Review them on the page, then press Publish. To leave one out, correct or clear its box " +
        "before publishing; reloading the page discards every fill."));
    }

    /* A row is one translation, which several fields can share, so it is
     * counted as one. */
    const unchanged = rows.filter((row) => row.verdict === "unchanged").length;
    if (unchanged) {
      bodyEl.appendChild(el("p", "report-sub",
        `${unchanged} ${plural(unchanged, "translation")} in the reply ${unchanged === 1 ? "is" : "are"} already on the page.`));
    }
    if (count(report.unknown)) {
      bodyEl.appendChild(el("p", "report-sub",
        `${count(report.unknown)} ${plural(count(report.unknown), "row")} in the reply ` +
        `${count(report.unknown) === 1 ? "is" : "are"} not part of this draft and ${count(report.unknown) === 1 ? "was" : "were"} ignored.`));
    }

    const controls = [];
    const status = el("p", "reply-status");
    status.setAttribute("aria-live", "polite");

    if (res.written) recordWritten(rows, wroteMember, !unconfirmed);
    const recovery = recoverySections();
    if (recovery.unconfirmed && !unconfirmed) bodyEl.appendChild(recovery.unconfirmed);
    if (recovery.replaced) bodyEl.appendChild(recovery.replaced);

    const order = { fill: 0, block: 1, skip: 2 };
    const left = rows
      .filter((row) => missedRows.has(row.k) || (!filled.has(row.k) && row.verdict !== "unchanged"))
      .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.k - b.k);
    if (left.length) {
      bodyEl.appendChild(el("h3", "", `Not filled (${left.length})`));
      const ul = el("ul", "report-list");
      left.forEach((row) => {
        const overridable = row.verdict === "edited" && row.overridable;
        let pairs = [["Reply", "tgt", row.target]];
        /* The page's value is shown only for the row it can be overwritten
         * against, which is the value that the override is bound to. */
        if (overridable) pairs = pairs.concat(valuePairs("On the page", "was", row.members));
        const li = reportRow(row, pairs);
        let reason = reasonFor(row);
        if (missedRows.has(row.k)) {
          const members = row.members || [];
          const names = members.filter((member) => memberMissed(row, member))
            .map((member) => str(member.elementId)).filter(Boolean);
          reason = names.length && names.length < members.length
            ? `did not take on the page for ${names.map((name) => `“${name}”`).join(", ")}, though the rest ` +
              "of this row did — check it before you publish"
            : "did not take on the page — check this field before you publish";
        }

        let choice = null;
        if (!missedRows.has(row.k) && row.status === "fill" && row.warning) {
          choice = el("button", "choice", "Fill anyway");
          choice.type = "button";
          choice.addEventListener("click", () => runFill({
            text: request.text,
            include: (request.include || []).concat(row.k),
            overrides: request.overrides || [],
          }, controls, status));
        } else if (overridable) {
          /* Bound to exactly the values shown here. If the page moves again
           * before the fill runs, the engine voids it and the row comes back. */
          choice = el("button", "choice", "Overwrite");
          choice.type = "button";
          choice.addEventListener("click", () => runFill({
            text: request.text,
            include: request.include || [],
            overrides: (request.overrides || []).filter((entry) => entry.k !== row.k).concat({
              k: row.k,
              reviewed: (row.members || []).map((member) => ({
                identityKey: str(member.identityKey),
                target: str(member.liveTarget),
              })),
            }),
          }, controls, status));
        }
        if (choice) controls.push(choice);
        li.appendChild(verdictLine(reason, choice));
        ul.appendChild(li);
      });
      bodyEl.appendChild(ul);
    }

    if (recovery.shared) bodyEl.appendChild(recovery.shared);

    bodyEl.appendChild(status);
    const again = el("button", "secondary", "Fill from a different reply");
    again.type = "button";
    again.addEventListener("click", () => {
      if (filling) return;
      clear(bodyEl);
      bodyEl.appendChild(replySection(""));
    });
    controls.push(again);
    bodyEl.appendChild(again);
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

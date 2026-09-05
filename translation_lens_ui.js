/*
 * Isolated-world visual panel for the "Translation Lens" command.
 *
 * The exact contract content.js validates before any translation data is read:
 *
 *   open({ fingerprint, context, callbacks })
 *   setProgress({ fingerprint, phase, detail })
 *   showResults({ fingerprint, result, section, partial })
 *   showError({ fingerprint, message })
 *   close({ fingerprint, reason })
 *   formatResultsAsText(result)
 *
 * The panel mounts on open(), before the first read lands, and fills in as
 * each section arrives -- a 60 s budget behind a results-only API is up to a
 * minute of blank screen. Every call except formatResultsAsText carries the
 * run fingerprint, and anything whose fingerprint does not match the open
 * panel is discarded rather than rendered, so a slow first run cannot
 * overwrite a fast second one.
 *
 * Truthfulness rules this file exists to keep:
 *   - Absent data is never coverage. A row the engine could not assess stays
 *     Unavailable, Unverified or Not applicable, is excluded from the score,
 *     and is named as such -- never folded into Missing, never into 100%.
 *   - A missing state carrying blank:true renders as Blank, not Missing.
 *   - Messages keep their own denominator and headline and never move the
 *     main coverage score.
 *   - Every status is a symbol plus words, never colour alone.
 *
 * Safety: this file builds no ServiceNow query and no URL. Navigation happens
 * only through callbacks.onOpenUrl with a URL the engine result supplied and
 * this panel re-validated as same-origin; the copied report is only what
 * callbacks.onCopyReport returned. Every instance-derived string is inserted
 * with textContent, and no row's source or translated text is ever displayed.
 */

(() => {
  if (globalThis.SNTranslationLensUI) return;

  const HOST_ID = "snh-translation-lens-results";
  const TITLE_ID = "snh-translation-lens-title";
  const LOOKUP_ID = "snh-translation-lens-lookup";

  /* Symbol plus words for every state translation_lens.js can produce, plus
   * the two the panel derives: "blank" (a missing state carrying blank:true)
   * and "extra" (a language outside the counted set that still has rows).
   * Tone is only a colour class; it never carries meaning on its own. */
  const STATE_META = {
    direct: { symbol: "✓", text: "Direct", tone: "ok" },
    same_as_source: { symbol: "≈", text: "Same as source", tone: "flag" },
    fallback: { symbol: "◐", text: "Fallback", tone: "info" },
    missing: { symbol: "—", text: "Missing", tone: "gap" },
    blank: { symbol: "∅", text: "Blank", tone: "gap" },
    partial: { symbol: "◑", text: "Partial", tone: "gap" },
    conflict: { symbol: "≠", text: "Conflict", tone: "flag" },
    unverified: { symbol: "~", text: "Unverified", tone: "muted" },
    unavailable: { symbol: "?", text: "Unavailable", tone: "muted" },
    not_applicable: { symbol: "·", text: "Not applicable", tone: "muted" },
    extra: { symbol: "+", text: "Extra", tone: "info" },
  };

  const ASPECT_LABEL = {
    label: "Label",
    value: "Value",
    source: "Question text",
    choices: "Choices",
    choice: "Choice",
    message: "Message",
    "set title": "Set title",
  };

  /* Footer button order, and the name each translation table is called by in
   * the panel. Also used for the store line on an expanded row. */
  const STORE_TARGETS = [
    { store: "sys_documentation", label: "Field Labels" },
    { store: "sys_choice", label: "Choices" },
    { store: "sys_translated", label: "Translated Names / Fields" },
    { store: "sys_translated_text", label: "Translated Text" },
    { store: "sys_ui_message", label: "Messages" },
  ];
  const STORE_LABEL = STORE_TARGETS.reduce((map, target) => {
    map[target.store] = target.label;
    return map;
  }, Object.create(null));

  const FILTERS = [
    { id: "all", label: "All" },
    { id: "missing", label: "Missing only" },
    { id: "labels", label: "Labels" },
    { id: "values", label: "Values" },
    { id: "choices", label: "Choices" },
    { id: "messages", label: "Messages" },
  ];
  const SECTION_FILTERS = new Set(["labels", "values", "choices", "messages"]);

  /* Stores whose content column is never requested, so a repeated row can be
   * counted but not compared. The panel must not imply the texts differ. */
  const PRESENCE_ONLY_STORES = new Set(["sys_translated_text", "sys_ui_message"]);

  /* One expanded choices row can hold hundreds of base values; render a
   * bounded window and say how many were left out rather than building a
   * five-figure DOM inside a scroll container. */
  const CHOICE_RENDER_CAP = 200;
  const EVIDENCE_LANGUAGE_CAP = 10;
  const SEARCH_DEBOUNCE_MS = 160;

  const MESSAGE_SCOPE_NOTE =
    "Scanned from the client scripts and UI policies attached to this surface. " +
    "It cannot see UI actions, server-side logic, widgets, or any key built at " +
    "run time, so this is coverage of the keys that could be found -- not of " +
    "every key this page uses. It never moves the score above.";

  const UI_CSS = `
    *{box-sizing:border-box}
    :host{
      all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      /* Teal = grouping/selection/focus; pink = primary action. Status colours
         stay muted because every state is also spelled out in words. */
      --teal:#31d4c4;--pink:#ff6fae;--band:#2a2a46;
      --ok:#8fd6ab;--ok-bg:#22362c;--ok-line:#37543f;
      --gap:#ff9d9d;--gap-bg:#3a2530;--gap-line:#5c3a48;
      --flag:#f0d79b;--flag-bg:#3a3320;--flag-line:#5c5031;
      --info:#a9d5ff;--info-bg:#24364a;--info-line:#365573;
      --muted:#a3a3ba;--muted-bg:#282840;--muted-line:#3a3a58;
    }
    button,input{font:inherit}
    .overlay{
      position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.52);
      display:flex;align-items:center;justify-content:center;padding:24px;
    }
    .panel{
      width:min(980px,calc(100vw - 32px));height:min(720px,calc(100vh - 40px));
      display:flex;flex-direction:column;overflow:hidden;
      background:#1e1e2e;border:1px solid #3a3a5c;border-radius:12px;
      box-shadow:0 28px 80px rgba(0,0,0,.65);color:#dedeee;
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
    .subtitle .flagword{color:#e0c187}
    .subtitle .sep{color:#4d4d68;padding:0 5px}
    .close{
      border:0;background:transparent;color:#85859f;padding:3px 5px;
      font-size:12px;line-height:1;cursor:pointer;border-radius:5px;
    }
    .close:hover{color:#fff;background:#2d2d48}
    .summary{
      display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 20px;
      border-bottom:1px solid #292944;color:#aaaac1;font-size:11px;
    }
    .summary .sep{color:#4d4d68}
    .summary .muted{color:#8686a0}
    .score{
      font-size:15px;font-weight:650;color:#f0f0fa;padding:1px 9px;border-radius:6px;
      background:#2c2d4a;border:1px solid #3c3e62;
    }
    .score.pending{color:#b6b6d0;font-weight:600;font-size:12px}
    .count{color:#e6e6f5}
    .count b{color:#f0f0fa;font-weight:650}
    .chip-warn{
      color:var(--flag);background:var(--flag-bg);border:1px solid var(--flag-line);
      border-radius:5px;padding:2px 8px;
    }
    .chip-msg{
      color:var(--info);background:var(--info-bg);border:1px solid var(--info-line);
      border-radius:5px;padding:2px 8px;
    }
    .chip-stop{
      color:var(--gap);background:var(--gap-bg);border:1px solid var(--gap-line);
      border-radius:5px;padding:2px 8px;
    }
    .banner{
      padding:9px 20px;font-size:12px;border-bottom:1px solid #292944;line-height:1.5;
    }
    .banner.progress{color:#cfeee9;background:color-mix(in srgb, var(--teal) 10%, #21283a)}
    .banner.error{color:#ffc9c9;background:#39222c;border-bottom-color:#5c3a48}
    .banner .what{font-weight:650;padding-right:6px}
    .bar-indeterminate{
      height:2px;background:#2b2b46;border-radius:2px;overflow:hidden;margin-top:7px;
    }
    .bar-indeterminate span{
      display:block;height:100%;width:36%;border-radius:2px;background:var(--teal);
      animation:snh-tl-slide 1.5s linear infinite;
    }
    @keyframes snh-tl-slide{
      0%{transform:translateX(-110%)}100%{transform:translateX(320%)}
    }
    .controls{
      display:flex;align-items:center;gap:8px;padding:10px 14px;flex-wrap:wrap;
      border-bottom:1px solid #292944;
    }
    .filters{display:flex;gap:6px;flex-wrap:wrap}
    .filter,.toggle{
      border:1px solid #68689a;background:#3f4067;color:#e6e6f5;
      border-radius:6px;padding:5px 9px;cursor:pointer;font-size:11px;
    }
    .filter:hover:not(:disabled),.toggle:hover:not(:disabled){background:#4a4b78;color:#fff}
    .filter.active,.toggle.active{
      background:color-mix(in srgb, var(--teal) 30%, #23303a);
      border-color:var(--teal);color:#eafffb;
    }
    .toggle{display:inline-flex;align-items:center;gap:6px}
    .toggle .dot{width:7px;height:7px;border-radius:50%;background:#55556f;flex:none}
    .toggle.active .dot{background:var(--teal)}
    .filter:disabled,.toggle:disabled,.toolbar button:disabled,.lookup button:disabled{
      opacity:.45;cursor:not-allowed;
    }
    .langwrap{position:relative}
    .popover{
      position:absolute;top:calc(100% + 6px);left:0;z-index:5;width:300px;
      max-height:320px;overflow:auto;padding:8px;border-radius:8px;
      background:#26263d;border:1px solid #4a4a72;box-shadow:0 18px 40px rgba(0,0,0,.55);
    }
    .popover .pop-note{font-size:10px;color:#8686a0;padding:2px 4px 7px;line-height:1.45}
    .popover .pop-actions{display:flex;gap:6px;flex-wrap:wrap;padding:0 2px 8px}
    .popover .pop-actions button{
      border:1px solid #5b5b86;background:#33345a;color:#dcdcf0;border-radius:5px;
      padding:4px 8px;font-size:10px;cursor:pointer;
    }
    .popover .pop-actions button:hover{background:#41426b;color:#fff}
    .lang-option{
      display:flex;align-items:center;gap:8px;padding:4px 5px;border-radius:5px;
      font-size:11px;color:#dcdcf0;cursor:pointer;
    }
    .lang-option:hover{background:#31314f}
    .lang-option .lang-id{
      font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:#9fb9d8;flex:none;
      min-width:46px;
    }
    .lang-option .lang-name{
      min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a8a8c2;
    }
    .search{
      margin-left:auto;width:220px;max-width:38vw;background:#313150;
      border:1px solid #575780;border-radius:6px;color:#f0f0fa;
      outline:none;padding:7px 9px;font-size:12px;
    }
    .search:focus{border-color:var(--teal);background:#37375a}
    .search::placeholder{color:#a4a4be}
    .rows{flex:1;overflow:auto;padding:0 0 8px}
    .group{border-bottom:1px solid #23233a}
    .group-head{
      display:flex;align-items:center;gap:9px;padding:9px 16px;width:100%;
      cursor:pointer;text-align:left;border:0;border-top:1px solid #262640;
      background:linear-gradient(90deg, color-mix(in srgb, var(--teal) 18%, var(--band)), var(--band) 48%);
      box-shadow:inset 3px 0 0 var(--teal);color:#dedeee;
      position:sticky;top:0;z-index:1;
    }
    .group-head:hover{filter:brightness(1.08)}
    .group-head.sub{
      padding-left:26px;box-shadow:inset 3px 0 0 #6f6f90;background:#25253c;position:static;
    }
    .group-head.plain{
      box-shadow:inset 3px 0 0 var(--flag);
      background:linear-gradient(90deg, color-mix(in srgb, var(--flag) 16%, var(--band)), var(--band) 48%);
    }
    .group-caret{color:color-mix(in srgb, var(--teal) 55%, #9a9ab4);font-size:10px;width:10px;flex:none}
    .group-name{font-size:12px;font-weight:650;color:color-mix(in srgb, var(--teal) 78%, white);flex:none}
    .group-head.sub .group-name,.group-head.plain .group-name{color:#c9c9e0}
    .group-note{
      font-size:10px;color:#8585a0;min-width:0;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap;
    }
    .group-count{
      margin-left:auto;flex:none;border-radius:10px;padding:1px 9px;font-size:11px;font-weight:600;
      background:color-mix(in srgb, var(--teal) 22%, var(--band));
      color:color-mix(in srgb, var(--teal) 55%, white);
      border:1px solid color-mix(in srgb, var(--teal) 30%, transparent);
    }
    .group-cov{
      flex:none;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700;
      background:#20202f;color:#c9c9e0;border:1px solid #2e2e46;
    }
    .section-note{
      padding:9px 20px;font-size:11px;color:#8f8fa8;line-height:1.55;
      border-bottom:1px solid #23233a;background:#20202f;
    }
    .row{
      display:grid;grid-template-columns:minmax(0,1fr) 116px 148px minmax(0,190px) 14px;
      gap:12px;align-items:center;width:100%;text-align:left;padding:9px 18px;
      border:0;border-bottom:1px solid #292941;background:transparent;
      font-size:12px;color:#d7d7e8;cursor:pointer;
    }
    .row:hover{background:#26263e}
    .row-name{min-width:0}
    .row-title{
      display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f0f0fa;
    }
    .row-el{
      font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#85859f;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;margin-top:2px;
    }
    .badge{
      justify-self:start;padding:3px 7px;border-radius:4px;font-size:10px;
      white-space:nowrap;width:max-content;
      color:#aeb0d4;background:#2c2d4a;border:1px solid #3c3e62;
    }
    .cov{display:flex;flex-direction:column;gap:4px;min-width:0}
    .cov-num{font-size:11px;color:#c6c6d8;display:flex;gap:6px;align-items:baseline}
    .cov-num .pct{color:#8686a0;font-size:10px}
    .cov-word{font-size:11px;color:var(--muted)}
    .bar{height:5px;border-radius:3px;background:#33334f;overflow:hidden}
    .bar span{display:block;height:100%;border-radius:3px;background:var(--ok)}
    .bar.part span{background:var(--flag)}
    .bar.none span{background:var(--gap)}
    .row-tags{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
    .tag{
      padding:2px 6px;border-radius:4px;font-size:10px;white-space:nowrap;
      background:var(--muted-bg);border:1px solid var(--muted-line);color:var(--muted);
    }
    .tag.gap{color:var(--gap);background:var(--gap-bg);border-color:var(--gap-line)}
    .tag.flag{color:var(--flag);background:var(--flag-bg);border-color:var(--flag-line)}
    .tag.info{color:var(--info);background:var(--info-bg);border-color:var(--info-line)}
    .caret{color:#6f6f88;font-size:10px;flex:none;justify-self:end}
    .row-detail{padding:11px 18px 14px 30px;border-bottom:1px solid #292941;background:#212134}
    .meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:10px;color:#8686a0;margin-bottom:9px}
    .meta b{color:#b6b6d0;font-weight:600;padding-right:4px}
    .meta .mono{font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:#9fb9d8}
    .chips{display:flex;flex-wrap:wrap;gap:5px}
    .chip{
      display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:5px;
      font-size:10px;line-height:1.6;border:1px solid var(--muted-line);
      background:var(--muted-bg);color:var(--muted);
    }
    button.chip{cursor:pointer}
    button.chip:hover{filter:brightness(1.3)}
    .chip .sym{font-size:11px;min-width:11px;text-align:center;flex:none}
    .chip .lang{font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:#e2e2f2;flex:none}
    .chip .what{white-space:nowrap}
    .chip.ok{color:var(--ok);background:var(--ok-bg);border-color:var(--ok-line)}
    .chip.gap{color:var(--gap);background:var(--gap-bg);border-color:var(--gap-line)}
    .chip.flag{color:var(--flag);background:var(--flag-bg);border-color:var(--flag-line)}
    .chip.info{color:var(--info);background:var(--info-bg);border-color:var(--info-line)}
    .chip.ok .lang,.chip.gap .lang,.chip.flag .lang,.chip.info .lang{color:inherit}
    .chips-note{font-size:11px;color:#8686a0;padding:2px 0}
    .evidence{margin:11px 0 0;padding:0;list-style:none}
    .evidence li{
      font-size:11px;color:#a0a0b8;line-height:1.6;padding:2px 0 2px 13px;position:relative;
    }
    .evidence li::before{content:"•";position:absolute;left:0;color:#5b5b7e}
    .choice-list{margin:11px 0 0;border-top:1px solid #2c2c46}
    .choice{
      display:grid;grid-template-columns:minmax(0,230px) 92px minmax(0,1fr);gap:10px;
      align-items:start;padding:7px 0;border-bottom:1px solid #2a2a42;
    }
    .choice-label{font-size:11px;color:#dcdcf0;min-width:0;overflow-wrap:anywhere}
    .choice-value{
      font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:#9fb9d8;
      display:block;margin-top:2px;overflow-wrap:anywhere;
    }
    .choice-cov{font-size:10px;color:#a0a0b8}
    .lookup{
      display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 20px;
      border-top:1px solid #2e2e4e;background:#20202f;
    }
    .lookup label{font-size:11px;color:#a0a0b8;flex:none}
    .lookup input{
      width:230px;max-width:50vw;background:#313150;border:1px solid #575780;
      border-radius:6px;color:#f0f0fa;outline:none;padding:6px 9px;font-size:12px;
    }
    .lookup input:focus{border-color:var(--teal)}
    .lookup button{
      border:1px solid #5b5b86;background:#33345a;color:#dcdcf0;border-radius:6px;
      padding:6px 10px;font-size:11px;cursor:pointer;
    }
    .lookup button:hover:not(:disabled){background:#41426b;color:#fff}
    .lookup .lookup-note{font-size:11px;color:#8686a0;flex:1;min-width:160px;line-height:1.5}
    .lookup .lookup-note.err{color:#ffc9c9}
    .empty{padding:40px 20px;text-align:center;color:#74748b;font-size:13px;line-height:1.6}
    .empty .hint{display:block;margin-top:6px;font-size:11px;color:#5f5f76}
    .toolbar{
      display:flex;align-items:center;gap:8px;padding:11px 14px;flex-wrap:wrap;
      border-top:1px solid #2e2e4e;background:#1b1b2b;
    }
    .toolbar-note{font-size:11px;color:#67677e;flex:1;min-width:150px}
    .toolbar button{
      border:1px solid #3a3a5c;background:#292941;color:#d8d8ea;
      border-radius:6px;padding:6px 9px;cursor:pointer;font-size:12px;
    }
    .toolbar button:hover:not(:disabled){background:#343453;color:#fff}
    .toolbar button.store{
      background:color-mix(in srgb, var(--teal) 12%, transparent);
      border-color:color-mix(in srgb, var(--teal) 46%, #3a3a5c);
      color:color-mix(in srgb, var(--teal) 84%, white);font-size:11px;
    }
    .toolbar button.store:hover:not(:disabled){
      background:color-mix(in srgb, var(--teal) 20%, transparent);color:#fff;
    }
    .toolbar .primary{
      background:color-mix(in srgb, var(--pink) 82%, #3a2740);
      border-color:color-mix(in srgb, var(--pink) 70%, #5a3a4c);color:#fff;
    }
    .toolbar .primary:hover:not(:disabled){background:color-mix(in srgb, var(--pink) 92%, #3a2740)}
    :focus-visible{outline:2px solid var(--teal);outline-offset:1px}
    @media (prefers-reduced-motion: reduce){
      *{animation:none !important;transition:none !important}
      .bar-indeterminate span{width:100%}
    }
    @media(max-width:720px){
      .overlay{padding:8px}
      .panel{width:100%;height:calc(100vh - 16px)}
      .header{padding:14px}
      .summary{padding:9px 14px;gap:8px}
      .controls{align-items:stretch;flex-direction:column}
      .search{width:100%;max-width:none;margin-left:0}
      .langwrap{width:100%}
      .popover{width:100%}
      .row{grid-template-columns:1fr;gap:6px;padding:10px 14px}
      .row-tags{justify-content:flex-start}
      .caret{justify-self:start}
      .row-detail{padding-left:14px}
      .choice{grid-template-columns:1fr;gap:5px}
      .lookup input{width:100%;max-width:none}
    }
  `;

  /* ------------------------------------------------------------------ *
   * Module state. One panel at a time; `panel` is null when unmounted.
   * ------------------------------------------------------------------ */

  let host = null;
  let shadow = null;
  let keydownHandler = null;
  let previousFocus = null;
  let copyResetTimer = null;
  let panel = null;

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  const isFn = (value) => typeof value === "function";
  const str = (value) => String(value == null ? "" : value);

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = String(content);
    return node;
  }

  function clearNode(node) {
    if (node) node.textContent = "";
  }

  function humanize(value) {
    const raw = str(value).replace(/[_\-]+/g, " ").trim();
    if (!raw) return "";
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  function plural(count, one, many) {
    return count + " " + (count === 1 ? one : (many || one + "s"));
  }

  const aspectLabel = (aspect) => ASPECT_LABEL[str(aspect)] || humanize(aspect) || "Value";
  const storeLabel = (store) => STORE_LABEL[str(store)] || str(store);

  function separator(parent) {
    parent.appendChild(el("span", "sep", "·"));
  }

  function metaItem(parent, label, value, mono) {
    if (!str(value)) return;
    const wrap = el("span");
    wrap.appendChild(el("b", "", label));
    wrap.appendChild(el("span", mono ? "mono" : "", value));
    parent.appendChild(wrap);
  }

  /* The engine is the authority on its own aggregates and its own report
   * text. Both are re-derived here only when it is absent (unit tests, or a
   * panel that outlived an engine reload). */
  function engineApi() {
    const api = globalThis.SNTranslationLens;
    return api && typeof api === "object" ? api : null;
  }

  /* Mirrors COVERED_STATES / EXCLUDED_STATES in translation_lens.js. The
   * engine is the authority and is used whenever it is present; this copy
   * exists only for the engine-less fallback below, and the two must be
   * changed together. Letting them drift would make a scoped count disagree
   * with the row it was counted from. */
  const LOCAL_COVERED_STATES = new Set(["direct", "same_as_source"]);
  const LOCAL_EXCLUDED_STATES = new Set(["unavailable", "unverified", "not_applicable"]);

  function localCoverage(states, languageIds) {
    let covered = 0;
    let counted = 0;
    const missing = [];
    const unavailable = [];
    (languageIds || []).forEach((id) => {
      const state = (states && states[id]) ? str(states[id].state) : "missing";
      if (LOCAL_EXCLUDED_STATES.has(state)) {
        if (state === "unavailable") unavailable.push(id);
        return;
      }
      counted++;
      if (LOCAL_COVERED_STATES.has(state)) covered++;
      else missing.push(id);
    });
    return {
      covered,
      counted,
      percent: counted ? Math.round((covered / counted) * 100) : null,
      missing,
      unavailable,
    };
  }

  function coverageFor(states, languageIds) {
    const api = engineApi();
    if (api && isFn(api.coverageFromStates)) {
      try { return api.coverageFromStates(states, languageIds); } catch (error) { /* fall through */ }
    }
    return localCoverage(states, languageIds);
  }

  function localSectionSummary(rows, languageIds) {
    const scope = Array.isArray(languageIds) ? languageIds : null;
    const list = Array.isArray(rows) ? rows : [];
    let covered = 0;
    let counted = 0;
    let complete = 0;
    let partial = 0;
    let none = 0;
    list.forEach((row) => {
      const coverage = scope ? localCoverage(row && row.states, scope) : (row && row.coverage);
      if (!coverage || !Number(coverage.counted)) return;
      covered += Number(coverage.covered) || 0;
      counted += Number(coverage.counted) || 0;
      if (coverage.covered === coverage.counted) complete++;
      else if (Number(coverage.covered) > 0) partial++;
      else none++;
    });
    return {
      covered,
      counted,
      percent: counted ? Math.round((covered / counted) * 100) : null,
      complete,
      partial,
      none,
      rowCount: list.length,
      scoped: !!scope,
      scopeCount: scope ? scope.length : null,
    };
  }

  function summaryOf(rows, languageIds) {
    const scope = Array.isArray(languageIds) ? languageIds : null;
    const api = engineApi();
    if (api && isFn(api.sectionSummary)) {
      try {
        const summary = api.sectionSummary(rows, scope || undefined);
        /* An engine predating the scope argument would ignore it and hand back
         * the all-language number, which must never be painted as the
         * selected-language one. The flag is the proof it was honoured. */
        if (!scope || (summary && summary.scoped === true)) return summary;
      } catch (error) { /* fall through */ }
    }
    return localSectionSummary(rows, scope);
  }

  /* ------------------------------------------------------------------ *
   * Language scope.
   *
   * The picker began as a pure display filter, and the panel promised the
   * score would never move with it, so that hiding a column could not hide a
   * gap. That guarantee survives; it is simply no longer the only number on
   * screen. Twenty-odd active languages make "0 complete" the headline for an
   * item that is finished in every language anyone ships, which tells the
   * reader nothing they can act on.
   *
   * So the counts follow the selection, and the all-language score is drawn
   * beside them whenever the two can differ. Both, never one.
   * ------------------------------------------------------------------ */

  /* Held for the duration of one paint. Every row asks for the scope up to
   * four times -- coverage cell, tags, evidence, gaps filter -- and deriving
   * it allocates two arrays each time. On the configured instance one item
   * renders four hundred rows and over ten thousand chips, so recomputing it
   * per row is the difference between a free lookup and a few thousand
   * pointless array builds per repaint. paint() is the only entry point that
   * can change the answer, so clearing it there is sufficient. */
  let scopeCached = false;
  let scopeValue = null;

  function invalidateLanguageScope() {
    scopeCached = false;
    scopeValue = null;
  }

  function languageScope() {
    if (scopeCached) return scopeValue;
    const counted = countedLanguageIds();
    const visible = visibleLanguageIds();
    scopeValue = visible.length === counted.length ? null : visible;
    scopeCached = true;
    return scopeValue;
  }

  /* Takes anything carrying states beside a precomputed coverage: a section
   * row, or one of a row's choice entries. */
  function scopedCoverage(entry) {
    const scope = languageScope();
    if (!scope) return (entry && entry.coverage) || {};
    return coverageFor(entry && entry.states, scope);
  }

  /* ------------------------------------------------------------------ *
   * Run identity. A late call from a superseded run must never paint.
   * ------------------------------------------------------------------ */

  function sameRun(fingerprint) {
    return Boolean(panel) && str(fingerprint) === str(panel.fingerprint);
  }

  /* ------------------------------------------------------------------ *
   * Result reading
   * ------------------------------------------------------------------ */

  /* Recurses, because a catalog run nests its native form fields in a
   * subsection and a walker that stopped at the top level would undercount
   * every one of those rows. */
  function forEachRow(visit) {
    if (!panel) return;
    const walk = (sections) => {
      (sections || []).forEach((section) => {
        if (!section) return;
        (section.rows || []).forEach((row) => {
          if (row) visit(row, section);
        });
        walk(section.subsections);
      });
    };
    walk(panel.sections);
  }

  function activeContext() {
    const base = (panel && panel.context) || {};
    const fromResult = (panel && panel.result && panel.result.context) || {};
    const merged = Object.assign({}, base);
    Object.keys(fromResult).forEach((key) => {
      const value = fromResult[key];
      if (value !== "" && value != null) merged[key] = value;
    });
    return merged;
  }

  function languageContext() {
    return (panel && panel.result && panel.result.languages) || null;
  }

  function countedLanguageIds() {
    const languages = languageContext();
    if (languages && Array.isArray(languages.countedLanguageIds) && languages.countedLanguageIds.length) {
      return languages.countedLanguageIds.slice();
    }
    /* Before the run completes there is no language context yet, but every
     * row the engine has already emitted is keyed by exactly the languages it
     * counted, so the set is derivable without guessing at one. */
    const seen = new Set();
    const out = [];
    forEachRow((row) => {
      Object.keys(row.states || {}).forEach((id) => {
        if (seen.has(id)) return;
        seen.add(id);
        out.push(id);
      });
    });
    return out;
  }

  function visibleLanguageIds() {
    const counted = countedLanguageIds();
    if (!panel || !panel.selection) return counted;
    return counted.filter((id) => panel.selection.has(id));
  }

  function languageName(id) {
    const languages = languageContext();
    const active = (languages && languages.active) || [];
    const match = active.find((entry) => entry && str(entry.id) === str(id));
    return match ? str(match.name) || str(id) : str(id);
  }

  function stateKind(entry) {
    if (!entry) return "unknown";
    const state = str(entry.state) || "unknown";
    if (state === "missing" && entry.blank === true) return "blank";
    return state;
  }

  function metaFor(kind) {
    return STATE_META[kind] || { symbol: "·", text: humanize(kind) || "Unknown", tone: "muted" };
  }

  function choiceEntries(row) {
    const evidence = (row && row.evidence) || {};
    return Array.isArray(evidence.choices) ? evidence.choices : [];
  }

  /* Form-mode choice entries are plain objects; catalog-mode choice entries
   * are whole analysed rows. Read both shapes rather than assuming one. */
  function entryNearDuplicates(entry) {
    if (!entry) return null;
    if (entry.nearDuplicates) return entry.nearDuplicates;
    return (entry.evidence && entry.evidence.nearDuplicates) || null;
  }

  /* Scoped, so the gaps filter cannot offer a row whose only gap is in a
   * language the reader has deselected. */
  function rowHasGap(row) {
    const coverage = scopedCoverage(row);
    return Boolean(coverage && Number(coverage.counted) > 0 && coverage.covered < coverage.counted);
  }

  function stateValues(row) {
    const states = (row && row.states) || {};
    return Object.keys(states).map((id) => states[id]);
  }

  function rowSearchText(row) {
    const parts = [
      row.element, row.label, aspectLabel(row.aspect), row.store, row.internalType,
      row.definingTable, row.concreteTable, row.registrationTable,
    ];
    choiceEntries(row).forEach((entry) => {
      parts.push(entry && entry.label);
      parts.push(entry && entry.value);
    });
    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  /* Rows that are real but that nobody works from. help_tag and example_text
   * repeat the same boilerplate under every question on an item, and a
   * table-sourced choice row has nothing to translate at all. They are folded
   * away by default and counted in the toggle's label -- never dropped, so
   * the copied report still carries them and the score still counts whatever
   * they contribute. Hiding is a view, not a measurement. */
  const MINOR_ASPECTS = new Set(["help_tag", "example_text"]);

  function isMinorRow(row) {
    if (!row) return false;
    if (MINOR_ASPECTS.has(str(row.aspect))) return true;
    return Boolean(row.evidence && row.evidence.minor);
  }

  function minorRowCount() {
    let count = 0;
    forEachRow((row) => { if (isMinorRow(row)) count++; });
    return count;
  }

  function matchesControls(row, groupId) {
    if (!panel.showMinor && isMinorRow(row)) return false;
    if (panel.search && rowSearchText(row).indexOf(panel.search) < 0) return false;
    if (panel.filter === "all") return true;
    if (panel.filter === "missing") return rowHasGap(row);
    return str(groupId) === panel.filter;
  }

  /* ------------------------------------------------------------------ *
   * URLs. The panel builds none; it only re-validates what it was handed
   * and refuses anything that is not same-origin.
   * ------------------------------------------------------------------ */

  function currentOrigin() {
    try {
      if (typeof location === "object" && location && location.origin) return String(location.origin);
    } catch (error) { /* no location in a unit-test context */ }
    return "";
  }

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

  function linkTarget(value) {
    if (!value) return "";
    if (typeof value === "string") return validatedUrl(value);
    if (typeof value === "object") return validatedUrl(value.list || value.url || "");
    return "";
  }

  function rowListUrl(row) {
    const links = (row && row.links) || null;
    return links ? linkTarget(links.list) : "";
  }

  function newRecordUrl(links, languageId) {
    const map = links && links.newRecord;
    if (!map || typeof map !== "object") return "";
    return validatedUrl(map[languageId]);
  }

  function storeListUrl(store) {
    const links = (panel && panel.result && panel.result.links) || null;
    if (!links || typeof links !== "object") return "";
    return linkTarget(links[store]);
  }

  function openUrl(url) {
    const callbacks = (panel && panel.callbacks) || {};
    const safe = validatedUrl(url);
    if (!safe || !isFn(callbacks.onOpenUrl)) return;
    try {
      const outcome = callbacks.onOpenUrl(safe);
      if (outcome && isFn(outcome.catch)) outcome.catch(() => {});
    } catch (error) { /* navigation is best-effort; the panel stays open */ }
  }

  /* ------------------------------------------------------------------ *
   * Mount / unmount
   * ------------------------------------------------------------------ */

  function safeActiveElement() {
    try {
      return (typeof document === "object" && document && document.activeElement) || null;
    } catch (error) { return null; }
  }

  function focusableElements() {
    const out = [];
    const walk = (node) => {
      const children = node && node.children ? Array.from(node.children) : [];
      children.forEach((child) => {
        const tag = str(child.tagName).toLowerCase();
        const tabindex = isFn(child.getAttribute) ? child.getAttribute("tabindex") : null;
        const focusable = tag === "button" || tag === "input" || tag === "select" || tag === "textarea";
        if (!child.disabled && (focusable || tabindex === "0")) out.push(child);
        walk(child);
      });
    };
    walk(shadow);
    return out;
  }

  function restoreFocus() {
    const target = previousFocus;
    previousFocus = null;
    if (!target || !isFn(target.focus)) return;
    try { target.focus({ preventScroll: true }); } catch (error) {
      try { target.focus(); } catch (ignored) { /* the invoker is gone */ }
    }
  }

  function unmount() {
    if (keydownHandler && typeof window === "object" && window && isFn(window.removeEventListener)) {
      window.removeEventListener("keydown", keydownHandler, true);
    }
    keydownHandler = null;
    if (copyResetTimer) {
      try { clearTimeout(copyResetTimer); } catch (error) { /* ignore */ }
      copyResetTimer = null;
    }
    if (panel && panel.searchTimer) {
      try { clearTimeout(panel.searchTimer); } catch (error) { /* ignore */ }
      panel.searchTimer = null;
    }
    if (host && isFn(host.remove)) host.remove();
    host = null;
    shadow = null;
    panel = null;
    restoreFocus();
  }

  function userClose(reason) {
    const callbacks = (panel && panel.callbacks) || {};
    unmount();
    if (!isFn(callbacks.onClose)) return;
    try { callbacks.onClose({ reason: str(reason) || "user" }); } catch (error) { /* ignore */ }
  }

  function toggleShowMinor() {
    if (!panel) return;
    panel.showMinor = !panel.showMinor;
    paint();
  }

  function toggleExpandAll() {
    panel.expandAll = !panel.expandAll;
    if (!panel.expandAll) panel.expanded.clear();
    paint();
  }

  function toggleIncludeInactive() {
    const callbacks = (panel && panel.callbacks) || {};
    /* Inactive variables and choices are excluded by the engine before a row
     * ever exists, so this cannot be applied to a finished result locally --
     * it needs a re-run. Without that callback the control stays disabled
     * rather than pretending to filter. */
    if (!isFn(callbacks.onSetIncludeInactive)) return;
    panel.includeInactive = !panel.includeInactive;
    paint();
    try { callbacks.onSetIncludeInactive(panel.includeInactive); } catch (error) { /* ignore */ }
  }

  function mount() {
    previousFocus = safeActiveElement();
    host = document.createElement("div");
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = UI_CSS;
    shadow.appendChild(style);

    const overlay = el("div", "overlay");
    overlay.addEventListener("click", (event) => {
      if (event && event.target === overlay) userClose("overlay");
    });

    const section = el("section", "panel");
    section.setAttribute("role", "dialog");
    section.setAttribute("aria-modal", "true");
    section.setAttribute("aria-labelledby", TITLE_ID);
    overlay.appendChild(section);

    const header = el("header", "header");
    const heading = el("div", "heading");
    const title = el("h2", "", "Translation Lens");
    title.id = TITLE_ID;
    const subtitle = el("div", "subtitle");
    heading.appendChild(title);
    heading.appendChild(subtitle);
    const closeButton = el("button", "close", "Close");
    closeButton.type = "button";
    closeButton.addEventListener("click", () => userClose("close-button"));
    header.appendChild(heading);
    header.appendChild(closeButton);
    section.appendChild(header);

    const summary = el("div", "summary");
    summary.setAttribute("aria-live", "polite");
    section.appendChild(summary);

    const status = el("div", "status");
    status.setAttribute("aria-live", "polite");
    section.appendChild(status);

    const controls = el("div", "controls");
    const filters = el("div", "filters");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Row filters");
    const filterButtons = FILTERS.map((entry) => {
      const button = el("button", "filter", entry.label);
      button.type = "button";
      button.setAttribute("data-filter", entry.id);
      button.addEventListener("click", () => {
        panel.filter = entry.id;
        paint();
      });
      filters.appendChild(button);
      return { id: entry.id, button };
    });
    controls.appendChild(filters);

    const langWrap = el("div", "langwrap");
    const langButton = el("button", "toggle");
    langButton.type = "button";
    langButton.setAttribute("aria-haspopup", "true");
    langButton.setAttribute("aria-expanded", "false");
    langButton.addEventListener("click", () => {
      panel.pickerOpen = !panel.pickerOpen;
      paint();
    });
    const langSlot = el("div", "popover-slot");
    langWrap.appendChild(langButton);
    langWrap.appendChild(langSlot);
    controls.appendChild(langWrap);

    const inactiveButton = el("button", "toggle");
    inactiveButton.type = "button";
    inactiveButton.setAttribute("aria-pressed", "false");
    inactiveButton.appendChild(el("span", "dot"));
    inactiveButton.appendChild(el("span", "", "Include inactive"));
    inactiveButton.addEventListener("click", toggleIncludeInactive);
    controls.appendChild(inactiveButton);

    const minorButton = el("button", "toggle");
    minorButton.type = "button";
    minorButton.setAttribute("aria-pressed", "false");
    minorButton.appendChild(el("span", "dot"));
    const minorLabel = el("span", "", "Minor rows");
    minorButton.appendChild(minorLabel);
    minorButton.addEventListener("click", toggleShowMinor);
    controls.appendChild(minorButton);

    const expandButton = el("button", "toggle", "Expand all");
    expandButton.type = "button";
    expandButton.setAttribute("aria-pressed", "false");
    expandButton.addEventListener("click", toggleExpandAll);
    controls.appendChild(expandButton);

    const search = document.createElement("input");
    search.className = "search";
    search.type = "search";
    search.placeholder = "Search element, label or store…";
    search.setAttribute("aria-label", "Search rows");
    /* Debounced, because renderRows() rebuilds the whole list and a real
     * target is far larger than a form: a 400-row catalog item on a 23-language
     * instance renders over 10,000 chips with every row expanded, and an
     * undebounced keystroke would rebuild all of them per character. */
    search.addEventListener("input", () => {
      const typed = str(search.value).trim().toLowerCase();
      if (typed === panel.search) return;
      panel.search = typed;
      if (panel.searchTimer) clearTimeout(panel.searchTimer);
      panel.searchTimer = setTimeout(() => {
        panel.searchTimer = null;
        if (panel && panel.refs) renderRows();
      }, SEARCH_DEBOUNCE_MS);
    });
    controls.appendChild(search);
    section.appendChild(controls);

    const rows = el("div", "rows");
    section.appendChild(rows);

    /* The manual key box lives outside the scrolling list on purpose: a
     * progressive section landing mid-keystroke rebuilds that list, and an
     * input rebuilt under the caret loses both its text and the focus. */
    const lookup = el("div", "lookup");
    section.appendChild(lookup);

    const toolbar = el("footer", "toolbar");
    const toolbarNote = el(
      "span", "toolbar-note",
      "Read-only — Translation Lens never saves or changes a record."
    );
    toolbar.appendChild(toolbarNote);
    const storeButtons = STORE_TARGETS.map((target) => {
      const button = el("button", "store", target.label);
      button.type = "button";
      button.addEventListener("click", () => openUrl(storeListUrl(target.store)));
      toolbar.appendChild(button);
      return { store: target.store, label: target.label, button };
    });
    const footerClose = el("button", "", "Close");
    footerClose.type = "button";
    footerClose.addEventListener("click", () => userClose("footer-close"));
    toolbar.appendChild(footerClose);
    const copyButton = el("button", "primary", "Copy report");
    copyButton.type = "button";
    copyButton.addEventListener("click", () => { copyReport(); });
    toolbar.appendChild(copyButton);
    section.appendChild(toolbar);

    shadow.appendChild(overlay);

    panel.refs = {
      overlay, section, subtitle, summary, status, controls, filterButtons,
      langButton, langSlot, inactiveButton, minorButton, minorLabel, expandButton, search, rows, lookup,
      storeButtons, copyButton, closeButton,
    };

    keydownHandler = (event) => {
      if (!host || !shadow || !event) return;
      if (event.key === "Escape") {
        if (isFn(event.preventDefault)) event.preventDefault();
        if (isFn(event.stopPropagation)) event.stopPropagation();
        if (panel && panel.pickerOpen) {
          panel.pickerOpen = false;
          paint();
          return;
        }
        userClose("escape");
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (!focusable.length) return;
      const current = shadow.activeElement;
      const index = focusable.indexOf(current);
      const nextIndex = event.shiftKey
        ? (index <= 0 ? focusable.length - 1 : index - 1)
        : (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
      if (isFn(event.preventDefault)) event.preventDefault();
      focusable[nextIndex].focus();
    };
    if (typeof window === "object" && window && isFn(window.addEventListener)) {
      window.addEventListener("keydown", keydownHandler, true);
    }
    if (isFn(closeButton.focus)) closeButton.focus();
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function paint() {
    if (!panel || !panel.refs) return;
    invalidateLanguageScope();
    renderSubtitle();
    renderSummary();
    renderStatus();
    renderControlState();
    renderRows();
    renderLookup();
    renderToolbarState();
  }

  function renderSubtitle() {
    const node = panel.refs.subtitle;
    clearNode(node);
    const context = activeContext();
    const surface = str(context.surface) || humanize(context.mode) || "This surface";
    node.appendChild(el("span", "", surface));
    if (str(context.table)) {
      separator(node);
      node.appendChild(el("span", "mono", str(context.table)));
    }
    if (context.isNewRecord) {
      separator(node);
      node.appendChild(el(
        "span", "flagword",
        "New record — labels and choices only; there is no saved value to assess."
      ));
    }
    const languages = languageContext();
    if (languages) {
      separator(node);
      node.appendChild(el(
        "span", languages.assumedBase ? "flagword" : "",
        languages.assumedBase
          ? "Base language assumed to be " + str(languages.baseLanguage) +
            " — glide.sys.language could not be read"
          : "Base language " + str(languages.baseLanguage)
      ));
    }
  }

  function warningCounts() {
    const counts = {
      conflict: 0, unavailable: 0, nearDuplicate: 0, stranded: 0,
      override: 0, alternate: 0, extra: 0, unverified: 0, sameAsSource: 0,
    };
    forEachRow((row) => {
      const evidence = row.evidence || {};
      const values = stateValues(row);
      if (values.some((entry) => entry && entry.state === "conflict")) counts.conflict++;
      if (values.some((entry) => entry && entry.state === "unavailable")) counts.unavailable++;
      if (values.some((entry) => entry && entry.state === "unverified")) counts.unverified++;
      if (values.some((entry) => entry && entry.state === "same_as_source")) counts.sameAsSource++;
      if (evidence.nearDuplicates && evidence.nearDuplicates.rowCount) counts.nearDuplicate++;
      if (evidence.stranded && evidence.stranded.rowCount) counts.stranded++;
      if (evidence.overrides && evidence.overrides.rowCount) counts.override++;
      if (evidence.extras && evidence.extras.rowCount) counts.extra++;
      if ((evidence.alternateRegistrations && evidence.alternateRegistrations.rowCount) ||
        (evidence.alternateSources && evidence.alternateSources.rowCount)) counts.alternate++;
    });
    return counts;
  }

  function mainSectionRows() {
    const rows = [];
    panel.sections.forEach((section) => {
      if (str(section.id) === "messages") return;
      (section.rows || []).forEach((row) => rows.push(row));
    });
    return rows;
  }

  function messageSectionRows() {
    const section = panel.sections.find((item) => str(item.id) === "messages");
    return (section && section.rows) || [];
  }

  /* The engine's own aggregate is the all-language one, so it can be taken
   * verbatim only while nothing is deselected. */
  function overallMainSummary() {
    if (panel.status === "complete" && panel.result && panel.result.summary) {
      return panel.result.summary;
    }
    return summaryOf(mainSectionRows());
  }

  function mainSummary() {
    const scope = languageScope();
    return scope ? summaryOf(mainSectionRows(), scope) : overallMainSummary();
  }

  function messagesSummary() {
    const scope = languageScope();
    if (scope) return summaryOf(messageSectionRows(), scope);
    if (panel.status === "complete" && panel.result && panel.result.messageSummary) {
      return panel.result.messageSummary;
    }
    return summaryOf(messageSectionRows());
  }

  function addCount(parent, value, word) {
    const wrap = el("span", "count");
    wrap.appendChild(el("b", "", String(value)));
    wrap.appendChild(el("span", "", " " + word));
    parent.appendChild(wrap);
  }

  function renderSummary() {
    const node = panel.refs.summary;
    clearNode(node);

    if (panel.result && panel.result.unavailable) {
      node.appendChild(el(
        "span", "chip-stop",
        "Active languages could not be read — nothing on this page was assessed."
      ));
      const failures = (panel.result.failures || []).length;
      if (failures) node.appendChild(el("span", "chip-warn", plural(failures, "read failure")));
      return;
    }

    const scope = languageScope();
    const summary = mainSummary();
    const complete = panel.status === "complete";
    const scoreText = summary.counted ? summary.percent + "%" : "—";
    const score = el("span", complete ? "score" : "score pending", scoreText);
    score.setAttribute(
      "aria-label",
      summary.counted
        ? summary.percent + " percent covered across " +
          (scope ? "the " + scope.length + " selected languages" : "every counted language")
        : "No coverage has been counted yet"
    );
    node.appendChild(score);
    if (!summary.counted) {
      node.appendChild(el(
        "span", "muted",
        scope ? "nothing counted in the selected languages" : "nothing counted yet"
      ));
    }

    addCount(node, summary.complete, "complete");
    separator(node);
    addCount(node, summary.partial, "partial");
    separator(node);
    addCount(node, summary.none, "missing / none");

    const counted = countedLanguageIds();
    const visible = visibleLanguageIds();
    separator(node);
    node.appendChild(el(
      "span", "muted",
      counted.length
        ? visible.length + " of " + counted.length + " languages shown"
        : "languages not read yet"
    ));

    /* The counts above follow the selection. This one never does, and it is
     * drawn whenever the two can differ, so narrowing the picker can never be
     * mistaken for closing a gap. */
    if (scope) {
      const overall = overallMainSummary();
      separator(node);
      const all = el(
        "span", "muted",
        overall.counted
          ? "all " + counted.length + " languages: " + overall.percent + "%"
          : "all " + counted.length + " languages: nothing counted"
      );
      all.title =
        "Coverage across every counted language. Hiding a language moves the " +
        "score on the left, never this one.";
      node.appendChild(all);
    }

    if (!complete && !panel.errorMessage) {
      node.appendChild(el("span", "chip-msg", "still reading — counts are partial"));
    }

    const warnings = warningCounts();
    if (warnings.conflict) node.appendChild(el("span", "chip-warn", plural(warnings.conflict, "row") + " with a conflict"));
    if (warnings.unavailable) node.appendChild(el("span", "chip-warn", plural(warnings.unavailable, "row") + " not read"));
    if (warnings.nearDuplicate) node.appendChild(el("span", "chip-warn", plural(warnings.nearDuplicate, "row") + " with near-duplicates"));
    if (warnings.stranded) node.appendChild(el("span", "chip-warn", plural(warnings.stranded, "row") + " with stranded rows"));
    if (warnings.override) node.appendChild(el("span", "chip-warn", plural(warnings.override, "row") + " with overrides"));

    const failures = ((panel.result && panel.result.failures) || []).length;
    if (failures) node.appendChild(el("span", "chip-warn", plural(failures, "read failure")));

    const messages = messagesSummary();
    if (messages && messages.rowCount) {
      node.appendChild(el(
        "span", "chip-msg",
        "Messages " + messages.covered + "/" + messages.counted +
        " across " + plural(messages.rowCount, "key") + " — counted separately"
      ));
    }
  }

  function renderStatus() {
    const node = panel.refs.status;
    clearNode(node);
    if (panel.errorMessage) {
      const banner = el("div", "banner error");
      banner.appendChild(el("span", "what", "Translation Lens stopped:"));
      banner.appendChild(el("span", "", panel.errorMessage));
      if (panel.sections.length) {
        banner.appendChild(el(
          "div", "",
          "The sections that had already been read are shown below. Everything else is unknown, not covered."
        ));
      }
      node.appendChild(banner);
      return;
    }
    if (panel.status === "complete") return;
    const banner = el("div", "banner progress");
    banner.appendChild(el("span", "what", "Reading…"));
    banner.appendChild(el(
      "span", "",
      str(panel.detail) || humanize(panel.phase) || "Starting"
    ));
    const bar = el("div", "bar-indeterminate");
    bar.appendChild(el("span"));
    banner.appendChild(bar);
    node.appendChild(banner);
  }

  function renderControlState() {
    const refs = panel.refs;
    refs.filterButtons.forEach((entry) => {
      const active = entry.id === panel.filter;
      entry.button.className = active ? "filter active" : "filter";
      entry.button.setAttribute("aria-pressed", active ? "true" : "false");
    });

    const counted = countedLanguageIds();
    const visible = visibleLanguageIds();
    refs.langButton.textContent = "Languages " + visible.length + " of " + counted.length;
    refs.langButton.setAttribute(
      "aria-label",
      "Language filter: " + visible.length + " of " + counted.length +
      " languages shown. The score counts the shown languages; the " +
      "all-language score is kept beside it."
    );
    refs.langButton.disabled = !counted.length;
    refs.langButton.className = panel.selection && panel.selection.size !== counted.length
      ? "toggle active" : "toggle";
    refs.langButton.setAttribute("aria-expanded", panel.pickerOpen ? "true" : "false");
    if (!counted.length) panel.pickerOpen = false;
    renderLanguagePicker();

    const callbacks = panel.callbacks || {};
    const canRerun = isFn(callbacks.onSetIncludeInactive);
    refs.inactiveButton.disabled = !canRerun;
    refs.inactiveButton.className = panel.includeInactive ? "toggle active" : "toggle";
    refs.inactiveButton.setAttribute("aria-pressed", panel.includeInactive ? "true" : "false");
    refs.inactiveButton.title = canRerun
      ? "Include inactive variables and choices, and read them again"
      : "Inactive rows are excluded before the read, so this needs a re-run that this build cannot request";

    const minorCount = minorRowCount();
    refs.minorLabel.textContent = panel.showMinor
      ? "Hide minor rows"
      : "Minor rows" + (minorCount ? " (" + minorCount + ")" : "");
    refs.minorButton.disabled = !minorCount;
    refs.minorButton.className = panel.showMinor ? "toggle active" : "toggle";
    refs.minorButton.setAttribute("aria-pressed", panel.showMinor ? "true" : "false");
    refs.minorButton.title = minorCount
      ? "help_tag and example_text rows, and choice rows whose options come from a table " +
        "rather than a choice list. Hidden by default; they are still counted and still copied."
      : "Nothing on this surface is folded away";

    refs.expandButton.textContent = panel.expandAll ? "Collapse all" : "Expand all";
    refs.expandButton.className = panel.expandAll ? "toggle active" : "toggle";
    refs.expandButton.setAttribute("aria-pressed", panel.expandAll ? "true" : "false");
  }

  function renderLanguagePicker() {
    const slot = panel.refs.langSlot;
    clearNode(slot);
    if (!panel.pickerOpen) return;
    const counted = countedLanguageIds();
    const selected = panel.selection;

    const popover = el("div", "popover");
    popover.setAttribute("role", "group");
    popover.setAttribute("aria-label", "Languages shown");
    popover.appendChild(el(
      "div", "pop-note",
      "The score counts the languages you leave selected, so you can see whether " +
      "the ones you ship are done. The score across all " + counted.length +
      " non-base languages stays on screen beside it, so narrowing this list " +
      "can never hide a gap."
    ));

    const actions = el("div", "pop-actions");
    const allButton = el("button", "", "All");
    allButton.type = "button";
    allButton.addEventListener("click", () => {
      panel.selection = null;
      paint();
    });
    actions.appendChild(allButton);
    const noneButton = el("button", "", "None");
    noneButton.type = "button";
    noneButton.addEventListener("click", () => {
      panel.selection = new Set();
      paint();
    });
    actions.appendChild(noneButton);

    const api = engineApi();
    const languages = languageContext();
    if (api && isFn(api.englishVariantPreset) && languages) {
      const presetButton = el("button", "", "Hide English variants and pseudo");
      presetButton.type = "button";
      presetButton.addEventListener("click", () => {
        let preset = [];
        try { preset = api.englishVariantPreset(languages) || []; } catch (error) { preset = []; }
        panel.selection = new Set(preset.map(str));
        paint();
      });
      actions.appendChild(presetButton);
    }
    popover.appendChild(actions);

    counted.forEach((id) => {
      const option = el("label", "lang-option");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !selected || selected.has(id);
      box.setAttribute("aria-label", languageName(id) + " (" + id + ")");
      box.addEventListener("change", () => {
        if (!panel.selection) panel.selection = new Set(counted);
        if (box.checked) panel.selection.add(id);
        else panel.selection.delete(id);
        paint();
      });
      option.appendChild(box);
      option.appendChild(el("span", "lang-id", id));
      option.appendChild(el("span", "lang-name", languageName(id)));
      popover.appendChild(option);
    });
    slot.appendChild(popover);
  }

  function sectionNote(section) {
    if (str(section.id) !== "messages") return "";
    const parts = [MESSAGE_SCOPE_NOTE];
    const scan = section.scan;
    if (scan) {
      if (Number(scan.dynamicCount)) {
        parts.push(plural(Number(scan.dynamicCount), "dynamic key") + " were not checked.");
      }
      if (Array.isArray(scan.invalid) && scan.invalid.length) {
        parts.push(plural(scan.invalid.length, "key") + " could not be expressed safely in a query.");
      }
      if (scan.capped && Number(scan.omittedCount)) {
        parts.push("The key list hit its cap; " + plural(Number(scan.omittedCount), "key") + " were omitted.");
      }
    }
    return parts.join(" ");
  }

  function rowKey(groupId, row) {
    return [groupId, str(row.id), str(row.element), str(row.aspect)].join("|");
  }

  function uncountedWord(row) {
    const evidence = row.evidence || {};
    const kinds = stateValues(row).map((entry) => str(entry && entry.state));
    if (evidence.unavailable || kinds.some((kind) => kind === "unavailable")) return "Unavailable — not read";
    if (evidence.unverified || kinds.some((kind) => kind === "unverified")) return "Unverified";
    if (evidence.skippedForNewRecord) return "New record — no value";
    if (evidence.notApplicable || (kinds.length && kinds.every((kind) => kind === "not_applicable"))) {
      return "Not applicable";
    }
    return "Not counted";
  }

  function coverageCell(row) {
    const cell = el("span", "cov");
    const coverage = scopedCoverage(row);
    const counted = Number(coverage.counted) || 0;
    if (!counted) {
      cell.appendChild(el("span", "cov-word", uncountedWord(row)));
      return cell;
    }
    const covered = Number(coverage.covered) || 0;
    const percent = Math.round((covered / counted) * 100);
    const bar = el("span", "bar" + (covered === counted ? "" : (covered ? " part" : " none")));
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", covered + " of " + counted + " languages covered");
    const fill = el("span");
    fill.style.width = percent + "%";
    bar.appendChild(fill);
    cell.appendChild(bar);
    const num = el("span", "cov-num");
    num.appendChild(el("span", "", covered + "/" + counted));
    num.appendChild(el("span", "pct", percent + "%"));
    cell.appendChild(num);
    return cell;
  }

  function tagCell(row) {
    const cell = el("span", "row-tags");
    const evidence = row.evidence || {};
    const coverage = scopedCoverage(row);
    const values = stateValues(row);
    const add = (tone, text) => cell.appendChild(el("span", "tag " + tone, text));

    const conflicts = values.filter((entry) => entry && entry.state === "conflict").length;
    if (conflicts) add("flag", plural(conflicts, "conflict"));
    const blanks = values.filter((entry) => entry && entry.state === "missing" && entry.blank === true).length;
    if (blanks) add("gap", plural(blanks, "blank row"));
    const unavailable = (coverage.unavailable || []).length;
    if (unavailable) add("", unavailable + " not read");
    if (evidence.nearDuplicates && evidence.nearDuplicates.rowCount) {
      add("flag", plural(evidence.nearDuplicates.rowCount, "near-duplicate"));
    }
    if (evidence.stranded && evidence.stranded.rowCount) {
      add("flag", plural(evidence.stranded.rowCount, "stranded row"));
    }
    if (evidence.overrides && evidence.overrides.rowCount) {
      add("info", plural(evidence.overrides.rowCount, "override"));
    }
    if (evidence.extras && evidence.extras.rowCount) {
      add("info", plural(evidence.extras.rowCount, "extra row"));
    }
    return cell;
  }

  function chipWords(entry, kind, store) {
    const meta = metaFor(kind);
    const presenceOnly = PRESENCE_ONLY_STORES.has(str(store));
    let words = meta.text;
    if (kind === "fallback" && entry && entry.fallbackLanguage) {
      words += " via " + str(entry.fallbackLanguage);
    }
    if (kind === "partial" && entry && Array.isArray(entry.missingAtoms) && entry.missingAtoms.length) {
      words += " (" + entry.missingAtoms.join(", ") + " missing)";
    }
    if (kind === "conflict" && entry && Number(entry.conflictCount)) {
      words += " (" + entry.conflictCount + " texts)";
    }
    if (entry && Number(entry.duplicateCount) && kind !== "conflict") {
      words += presenceOnly
        ? " · " + plural(Number(entry.duplicateCount) + 1, "row")
        : " · " + plural(Number(entry.duplicateCount), "duplicate");
    }
    return words;
  }

  function chipTitle(entry, kind, store, languageId) {
    const parts = [languageName(languageId) + " (" + languageId + ")"];
    if (entry && str(entry.reason)) parts.push(str(entry.reason));
    if (PRESENCE_ONLY_STORES.has(str(store)) && entry && Number(entry.duplicateCount)) {
      parts.push("Repeated rows are counted but never compared: this store's text column is never read.");
    }
    if (kind === "unavailable") parts.push("The read did not complete, so this is unknown — not missing.");
    return parts.join(" — ");
  }

  function stateChip(options) {
    const opts = options || {};
    const languageId = str(opts.languageId);
    const entry = (opts.states || {})[languageId] || null;
    const kind = stateKind(entry);
    const meta = metaFor(kind);
    const url = (kind === "missing" || kind === "blank")
      ? newRecordUrl(opts.links, languageId) : "";
    const node = url ? el("button", "chip " + meta.tone) : el("span", "chip " + meta.tone);
    if (url) {
      node.type = "button";
      node.setAttribute(
        "aria-label",
        "Open a prefilled new " + storeLabel(opts.store) + " record for " +
        languageName(languageId)
      );
      node.addEventListener("click", (event) => {
        if (event && isFn(event.stopPropagation)) event.stopPropagation();
        openUrl(url);
      });
    }
    node.appendChild(el("span", "sym", meta.symbol));
    node.appendChild(el("span", "lang", languageId));
    node.appendChild(el("span", "what", chipWords(entry, kind, opts.store)));
    node.title = chipTitle(entry, kind, opts.store, languageId);
    return node;
  }

  function extraChips(parent, row) {
    const evidence = row.evidence || {};
    const extras = evidence.extras;
    const counted = new Set(countedLanguageIds());
    if (!extras || !Array.isArray(extras.languages)) return;
    const outside = extras.languages.filter((id) => !counted.has(str(id)));
    outside.slice(0, EVIDENCE_LANGUAGE_CAP).forEach((id) => {
      const meta = STATE_META.extra;
      const chip = el("span", "chip " + meta.tone);
      chip.appendChild(el("span", "sym", meta.symbol));
      chip.appendChild(el("span", "lang", str(id)));
      chip.appendChild(el("span", "what", meta.text));
      chip.title = "Rows exist for this language, but it is outside the counted set.";
      parent.appendChild(chip);
    });
  }

  function evidenceLine(list, text) {
    if (!text) return;
    list.appendChild(el("li", "", text));
  }

  function languageList(summary) {
    const ids = (summary && Array.isArray(summary.languages)) ? summary.languages : [];
    if (!ids.length) return "";
    const shown = ids.slice(0, EVIDENCE_LANGUAGE_CAP).join(", ");
    return ids.length > EVIDENCE_LANGUAGE_CAP
      ? shown + " and " + (ids.length - EVIDENCE_LANGUAGE_CAP) + " more"
      : shown;
  }

  function renderEvidence(detail, row) {
    const evidence = row.evidence || {};
    const coverage = scopedCoverage(row);
    const list = el("ul", "evidence");

    if (evidence.skippedForNewRecord) {
      evidenceLine(list, "This record has not been saved, so it has no stored value to assess.");
    }
    if (evidence.notApplicableReason) {
      evidenceLine(list, "Not applicable: " + str(evidence.notApplicableReason) + ".");
    } else if (evidence.notApplicable) {
      evidenceLine(list, "Not applicable: this row holds nothing translatable.");
    }
    if (evidence.unverifiedReason) {
      evidenceLine(list, "Unverified: " + str(evidence.unverifiedReason) + ". It is named, never counted as covered.");
    }
    if (evidence.unavailable) {
      evidenceLine(list, "The read for this row did not complete. Its languages are unknown, not missing.");
    }
    if (Array.isArray(evidence.candidateStores) && evidence.candidateStores.length) {
      evidenceLine(list, "Storage unverified for this field type. Candidate stores: " +
        evidence.candidateStores.map((store) => storeLabel(store) + " (" + store + ")").join(", ") + ".");
    }
    if (Array.isArray(evidence.applicableAtoms) && evidence.applicableAtoms.length > 1) {
      evidenceLine(list, "Counted atoms: " + evidence.applicableAtoms.join(", ") +
        ". A language whose label is translated while one of the others is not counts as Partial.");
    }
    if ((coverage.unavailable || []).length) {
      evidenceLine(list, "Not read for: " + coverage.unavailable.join(", ") +
        ". Excluded from the denominator rather than counted as missing.");
    }
    if (evidence.overrides && evidence.overrides.rowCount) {
      evidenceLine(list, plural(evidence.overrides.rowCount, "row") +
        " sit on a table other than the defining one" +
        (languageList(evidence.overrides) ? " (" + languageList(evidence.overrides) + ")" : "") +
        ". Which one the platform renders is unverified, so both are named and neither is assumed.");
    }
    if (evidence.shadowed && evidence.shadowed.rowCount) {
      evidenceLine(list, plural(evidence.shadowed.rowCount, "shadowed row") +
        " on a shallower table in the chain. The deepest table's row is the one counted.");
    }
    if (evidence.stranded && evidence.stranded.rowCount) {
      evidenceLine(list, plural(evidence.stranded.rowCount, "row") +
        " exist in the store this field type does not use" +
        (languageList(evidence.stranded) ? " (" + languageList(evidence.stranded) + ")" : "") +
        ". Reported, never counted.");
    }
    if (evidence.alternateRegistrations && evidence.alternateRegistrations.rowCount) {
      evidenceLine(list, plural(evidence.alternateRegistrations.rowCount, "row") +
        " register this same source string under another table.");
    }
    if (evidence.alternateSources && evidence.alternateSources.rowCount) {
      evidenceLine(list, plural(evidence.alternateSources.rowCount, "choice row") +
        " exist for this element on another table.");
    }
    if (evidence.nearDuplicates && evidence.nearDuplicates.rowCount) {
      evidenceLine(list, plural(evidence.nearDuplicates.rowCount, "near-duplicate row") +
        " differ from the source only by case. Never counted; whether the platform resolves them is unverified.");
    }
    if (evidence.extras && evidence.extras.rowCount) {
      evidenceLine(list, plural(evidence.extras.rowCount, "extra row") +
        " exist outside the counted set" +
        (languageList(evidence.extras) ? " (" + languageList(evidence.extras) + ")" : "") + ".");
    }
    if (Number(evidence.choiceCount)) {
      evidenceLine(list, plural(Number(evidence.choiceCount), "base choice") + " were assessed.");
    }
    if (list.children && list.children.length) detail.appendChild(list);
  }

  function renderChoices(detail, row, languages) {
    const entries = choiceEntries(row);
    if (!entries.length) return;
    const wrap = el("div", "choice-list");
    entries.slice(0, CHOICE_RENDER_CAP).forEach((entry) => {
      const line = el("div", "choice");
      const label = el("div", "choice-label");
      label.appendChild(el("span", "", str(entry.label) || "(no label)"));
      const technical = [];
      if (str(entry.value)) technical.push("value " + str(entry.value));
      if (str(entry.dependentValue)) technical.push("under " + str(entry.dependentValue));
      if (technical.length) label.appendChild(el("span", "choice-value", technical.join(" · ")));
      line.appendChild(label);

      const coverage = scopedCoverage(entry);
      line.appendChild(el(
        "div", "choice-cov",
        Number(coverage.counted)
          ? (coverage.covered || 0) + "/" + coverage.counted
          : "not counted"
      ));

      const chips = el("div", "chips");
      languages.forEach((id) => {
        chips.appendChild(stateChip({
          states: entry.states,
          links: entry.links,
          store: entry.store || row.store,
          languageId: id,
        }));
      });
      const near = entryNearDuplicates(entry);
      if (near && near.rowCount) {
        chips.appendChild(el("span", "tag flag", plural(near.rowCount, "near-duplicate")));
      }
      line.appendChild(chips);
      wrap.appendChild(line);
    });
    if (entries.length > CHOICE_RENDER_CAP) {
      wrap.appendChild(el(
        "div", "chips-note",
        (entries.length - CHOICE_RENDER_CAP) + " more base choices are not listed here; they are still counted above."
      ));
    }
    detail.appendChild(wrap);
  }

  function renderRowDetail(row, languages) {
    const detail = el("div", "row-detail");

    const meta = el("div", "meta");
    metaItem(meta, "Store", row.store ? storeLabel(row.store) + " · " + str(row.store) : "", true);
    metaItem(meta, "Type", str(row.internalType), true);
    metaItem(meta, "Defined on", str(row.definingTable), true);
    metaItem(meta, "This table", str(row.concreteTable), true);
    metaItem(meta, "Registered under", str(row.registrationTable), true);
    if (meta.children && meta.children.length) detail.appendChild(meta);

    const listUrl = rowListUrl(row);
    if (listUrl) {
      const open = el("button", "chip info", null);
      open.type = "button";
      open.appendChild(el("span", "sym", "↗"));
      open.appendChild(el("span", "what", "Open the matching rows in the platform"));
      open.addEventListener("click", (event) => {
        if (event && isFn(event.stopPropagation)) event.stopPropagation();
        openUrl(listUrl);
      });
      detail.appendChild(open);
    }

    const chips = el("div", "chips");
    if (!languages.length) {
      const counted = countedLanguageIds();
      chips.appendChild(el(
        "div", "chips-note",
        counted.length
          ? "Every language is hidden by the language filter. The score above still counts all " +
            counted.length + "."
          : "The active language list has not been read yet."
      ));
    } else {
      languages.forEach((id) => {
        chips.appendChild(stateChip({
          states: row.states,
          links: row.links,
          store: row.store,
          languageId: id,
        }));
      });
      extraChips(chips, row);
    }
    detail.appendChild(chips);

    renderEvidence(detail, row);
    renderChoices(detail, row, languages);
    return detail;
  }

  function renderRow(parent, row, groupId, languages) {
    const key = rowKey(groupId, row);
    const expanded = panel.expandAll || panel.expanded.has(key);
    const head = el("button", "row");
    head.type = "button";
    head.setAttribute("aria-expanded", expanded ? "true" : "false");

    const name = el("span", "row-name");
    name.appendChild(el("span", "row-title", str(row.label) || str(row.element) || "(unnamed)"));
    if (str(row.element) && str(row.element) !== str(row.label)) {
      name.appendChild(el("span", "row-el", str(row.element)));
    }
    head.appendChild(name);
    head.appendChild(el("span", "badge", aspectLabel(row.aspect)));
    head.appendChild(coverageCell(row));
    head.appendChild(tagCell(row));
    head.appendChild(el("span", "caret", expanded ? "▾" : "▸"));
    head.addEventListener("click", () => {
      if (panel.expandAll) {
        /* Collapsing one row out of an expand-all leaves the others open. */
        panel.expandAll = false;
        panel.expanded = new Set(allRowKeys());
      }
      if (panel.expanded.has(key)) panel.expanded.delete(key);
      else panel.expanded.add(key);
      paint();
    });
    parent.appendChild(head);
    if (expanded) parent.appendChild(renderRowDetail(row, languages));
  }

  function allRowKeys() {
    const keys = [];
    eachRenderableGroup((group) => {
      (group.rows || []).forEach((row) => keys.push(rowKey(str(group.id), row)));
    });
    panel.lookupRows.forEach((row) => keys.push(rowKey("__lookups", row)));
    return keys;
  }

  /* Every group that can hold rows. A section carrying subsections is
   * represented by those subsections and never by its own `rows`, which
   * repeat them verbatim so the engine can summarise the section in one
   * pass -- rendering both would list every form field twice. */
  function eachRenderableGroup(visit) {
    panel.sections.forEach((section) => {
      const subs = Array.isArray(section.subsections) ? section.subsections : [];
      if (subs.length) subs.forEach((sub) => visit(sub, section));
      else visit(section, null);
    });
  }

  function subsectionsOf(section) {
    return Array.isArray(section.subsections) ? section.subsections : [];
  }

  function matchingRows(section) {
    return (section.rows || []).filter((row) => matchesControls(row, str(section.id)));
  }

  function isCollapsed(id) {
    return panel.collapsedSections.has(str(id));
  }

  function groupHead(section, id, collapsed, shownCount, totalCount, isSub) {
    const head = el("button", isSub ? "group-head sub" : "group-head");
    head.type = "button";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
    head.appendChild(el("span", "group-caret", collapsed ? "▸" : "▾"));
    head.appendChild(el("span", "group-name", str(section.label) || humanize(id)));
    head.appendChild(el(
      "span", "group-count",
      shownCount === totalCount ? String(totalCount) : shownCount + " of " + totalCount
    ));
    /* Each section carries its own score, counted over the same language
     * selection as the headline so the two can never disagree. Counted over
     * every row the section holds, including any folded away -- hiding a row
     * changes what is listed, never what was measured. */
    const sectionSummary = summaryOf(section.rows || [], languageScope());
    if (sectionSummary.counted) {
      const cov = el("span", "group-cov", sectionSummary.percent + "%");
      cov.setAttribute(
        "aria-label",
        (str(section.label) || humanize(id)) + ": " + sectionSummary.percent +
        " percent covered, " + sectionSummary.covered + " of " + sectionSummary.counted +
        " language slots"
      );
      cov.title =
        sectionSummary.covered + "/" + sectionSummary.counted + " language slots · " +
        sectionSummary.complete + " complete · " + sectionSummary.partial + " partial · " +
        sectionSummary.none + " missing";
      head.appendChild(cov);
    }
    head.addEventListener("click", () => {
      if (collapsed) panel.collapsedSections.delete(id);
      else panel.collapsedSections.add(id);
      paint();
    });
    return head;
  }

  function renderGroup(parent, section, languages, isSub) {
    const id = str(section.id);
    const rows = matchingRows(section);
    const total = (section.rows || []).length;
    if (!rows.length && SECTION_FILTERS.has(panel.filter) && panel.filter !== id) return 0;

    const group = el("div", "group");
    const collapsed = isCollapsed(id);
    group.appendChild(groupHead(section, id, collapsed, rows.length, total, isSub));

    if (!collapsed) {
      const note = sectionNote(section);
      if (note) group.appendChild(el("div", "section-note", note));
      if (!rows.length) {
        group.appendChild(el(
          "div", "section-note",
          total
            ? "No row in this section matches the current filter or search."
            : "The engine produced no rows of this kind for this surface."
        ));
      }
      rows.forEach((row) => renderRow(group, row, id, languages));
    }
    parent.appendChild(group);
    return rows.length;
  }

  /* A catalog definition form contributes its native fields as a nested,
   * collapsed group: they belong to the same surface but are a different
   * question from the item's own catalog text, and opening the panel on a
   * 40-field form should not bury the variables under them. */
  function renderSectionTree(parent, section, languages) {
    const subs = subsectionsOf(section);
    if (!subs.length) return renderGroup(parent, section, languages, false);

    const id = str(section.id);
    const shown = subs.reduce((count, sub) => count + matchingRows(sub).length, 0);
    const total = subs.reduce((count, sub) => count + (sub.rows || []).length, 0);
    if (!shown && SECTION_FILTERS.has(panel.filter) &&
      !subs.some((sub) => str(sub.id) === panel.filter)) return 0;

    const group = el("div", "group");
    const collapsed = isCollapsed(id);
    group.appendChild(groupHead(section, id, collapsed, shown, total, false));
    if (!collapsed) subs.forEach((sub) => renderGroup(group, sub, languages, true));
    parent.appendChild(group);
    return shown;
  }

  function renderFailures(parent) {
    const failures = (panel.result && panel.result.failures) || [];
    if (!failures.length) return;
    const group = el("div", "group");
    const collapsed = isCollapsed("__failures");
    const head = el("button", "group-head plain");
    head.type = "button";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
    head.appendChild(el("span", "group-caret", collapsed ? "▸" : "▾"));
    head.appendChild(el("span", "group-name", "Read failures"));
    head.appendChild(el(
      "span", "group-note",
      "Rows these reads would have covered are Unavailable, never Missing"
    ));
    head.appendChild(el("span", "group-count", String(failures.length)));
    head.addEventListener("click", () => {
      if (collapsed) panel.collapsedSections.delete("__failures");
      else panel.collapsedSections.add("__failures");
      paint();
    });
    group.appendChild(head);
    if (!collapsed) {
      const list = el("ul", "evidence");
      failures.forEach((failure) => {
        const bits = [str(failure.table) || "unknown table"];
        if (Number(failure.status)) bits.push("HTTP " + failure.status);
        if (str(failure.code)) bits.push(str(failure.code));
        if (failure.truncated) bits.push("truncated at its row cap");
        const line = el("li", "", bits.join(" · ") + (str(failure.error) ? " — " + str(failure.error) : ""));
        list.appendChild(line);
      });
      const wrap = el("div", "section-note");
      wrap.appendChild(list);
      group.appendChild(wrap);
    }
    parent.appendChild(group);
  }

  function renderLookupGroup(parent, languages) {
    if (!panel.lookupRows.length) return 0;
    /* Filtered as message rows, because that is what they are. */
    const rows = panel.lookupRows.filter((row) => matchesControls(row, "messages"));
    if (!rows.length && panel.filter !== "all") return 0;
    const group = el("div", "group");
    const collapsed = isCollapsed("__lookups");
    const head = el("button", "group-head plain");
    head.type = "button";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
    head.appendChild(el("span", "group-caret", collapsed ? "▸" : "▾"));
    head.appendChild(el("span", "group-name", "Manual key lookups"));
    head.appendChild(el(
      "span", "group-note",
      "Typed by hand, so they are outside the scan's denominator above"
    ));
    head.appendChild(el(
      "span", "group-count",
      rows.length === panel.lookupRows.length
        ? String(panel.lookupRows.length)
        : rows.length + " of " + panel.lookupRows.length
    ));
    head.addEventListener("click", () => {
      if (collapsed) panel.collapsedSections.delete("__lookups");
      else panel.collapsedSections.add("__lookups");
      paint();
    });
    group.appendChild(head);
    if (!collapsed) {
      rows.forEach((row) => renderRow(group, row, "__lookups", languages));
    }
    parent.appendChild(group);
    return rows.length;
  }

  function renderRows() {
    const node = panel.refs.rows;
    clearNode(node);
    const languages = visibleLanguageIds();
    let shown = 0;
    let groups = 0;
    panel.sections.forEach((section) => {
      groups++;
      shown += renderSectionTree(node, section, languages);
    });
    shown += renderLookupGroup(node, languages);
    renderFailures(node);

    if (!groups) {
      const empty = el("div", "empty", panel.errorMessage
        ? "No section was read before the run stopped."
        : "Reading this surface…");
      empty.appendChild(el(
        "span", "hint",
        panel.errorMessage
          ? "Nothing here is known to be covered or missing."
          : "Sections appear as each read lands."
      ));
      node.appendChild(empty);
      return;
    }
    if (!shown) {
      const empty = el("div", "empty", "No row matches the current filter or search.");
      empty.appendChild(el("span", "hint", "The counts above still describe every row that was read."));
      node.appendChild(empty);
    }
  }

  function renderLookup() {
    const node = panel.refs.lookup;
    const hasMessages = panel.sections.some((section) => str(section.id) === "messages");
    const callbacks = panel.callbacks || {};
    if (!hasMessages || !isFn(callbacks.onLookupMessage)) {
      if (node.children && node.children.length) clearNode(node);
      return;
    }
    if (node.children && node.children.length) {
      /* Built once so typing survives a progressive section landing. */
      updateLookupNote();
      return;
    }
    const label = el("label", "", "Look up a message key");
    label.setAttribute("for", LOOKUP_ID);
    node.appendChild(label);
    const input = document.createElement("input");
    input.id = LOOKUP_ID;
    input.type = "text";
    input.placeholder = "sys_ui_message key";
    input.addEventListener("input", () => { panel.lookupKey = str(input.value); });
    input.addEventListener("keydown", (event) => {
      if (event && event.key === "Enter") {
        if (isFn(event.preventDefault)) event.preventDefault();
        runLookup();
      }
    });
    node.appendChild(input);
    const button = el("button", "", "Look up");
    button.type = "button";
    button.addEventListener("click", runLookup);
    node.appendChild(button);
    const note = el("div", "lookup-note", "Any key, whether or not the scan found it. Read-only.");
    node.appendChild(note);
    panel.refs.lookupInput = input;
    panel.refs.lookupButton = button;
    panel.refs.lookupNote = note;
  }

  function updateLookupNote() {
    const note = panel.refs.lookupNote;
    if (!note) return;
    note.className = panel.lookupError ? "lookup-note err" : "lookup-note";
    note.textContent = panel.lookupError || panel.lookupStatus ||
      "Any key, whether or not the scan found it. Read-only.";
  }

  function runLookup() {
    const callbacks = panel.callbacks || {};
    const key = str(panel.lookupKey).trim();
    if (!key || !isFn(callbacks.onLookupMessage)) return;
    panel.lookupError = "";
    panel.lookupStatus = "Looking up “" + key + "”…";
    if (panel.refs.lookupButton) panel.refs.lookupButton.disabled = true;
    updateLookupNote();
    const fingerprint = panel.fingerprint;
    Promise.resolve()
      .then(() => callbacks.onLookupMessage(key))
      .then((outcome) => {
        if (!sameRun(fingerprint)) return;
        const row = outcome && outcome.row;
        if (row) addLookupRow(row);
        panel.lookupStatus = "";
        panel.lookupError = outcome && outcome.ok === false
          ? str(outcome.error) || "That key could not be read."
          : "";
        if (row && panel.lookupError) {
          panel.lookupError += " The row below shows what is known, not that it is missing.";
        }
      })
      .catch((error) => {
        if (!sameRun(fingerprint)) return;
        panel.lookupStatus = "";
        panel.lookupError = str(error && error.message) || String(error);
      })
      .then(() => {
        if (!sameRun(fingerprint)) return;
        if (panel.refs.lookupButton) panel.refs.lookupButton.disabled = false;
        paint();
      });
  }

  /* A looked-up key is kept out of the engine's own sections on purpose. The
   * scan's denominator describes the keys the scan could find; folding a
   * hand-typed key into it would restate that claim as something wider, and
   * writing into the result object would put the key in the copied report as
   * though the scan had found it. */
  function addLookupRow(row) {
    const index = panel.lookupRows.findIndex((item) => item && str(item.id) === str(row.id));
    if (index >= 0) panel.lookupRows[index] = row;
    else panel.lookupRows.push(row);
  }

  function renderToolbarState() {
    panel.refs.storeButtons.forEach((entry) => {
      const url = storeListUrl(entry.store);
      entry.button.disabled = !url;
      entry.button.title = url
        ? "Open " + entry.store + " filtered to this context"
        : "No list target for " + entry.store + " was supplied with this result";
    });
  }

  /* ------------------------------------------------------------------ *
   * Report text
   * ------------------------------------------------------------------ */

  function reportWarnings(row) {
    const evidence = row.evidence || {};
    const warnings = [];
    if (evidence.nearDuplicates && evidence.nearDuplicates.rowCount) warnings.push("near-duplicate");
    if (evidence.stranded && evidence.stranded.rowCount) warnings.push("stranded");
    if (evidence.alternateRegistrations && evidence.alternateRegistrations.rowCount) {
      warnings.push("alternate-registration");
    }
    const values = stateValues(row);
    if (values.some((entry) => entry && entry.state === "conflict")) warnings.push("conflict");
    if (values.some((entry) => entry && entry.state === "unavailable")) warnings.push("unavailable");
    return warnings;
  }

  /* Deliberately free of translated text, raw record values, hostnames, URLs
   * and sys_ids. It carries element names, aspects, counts and language ids
   * only -- the same shape the engine's own formatter produces. */
  function localReport(result) {
    const lines = ["Translation Lens"];
    const context = (result && result.context) || {};
    lines.push("Context: " + [
      str(context.mode) || str(context.surface) || "unknown",
      str(context.table),
    ].filter(Boolean).join(" / "));
    if (context.isNewRecord) lines.push("New record: no per-record value was assessed.");
    const languages = result && result.languages;
    if (languages) {
      lines.push("Languages: " + (languages.shownCount == null ? "?" : languages.shownCount) +
        " shown; " + ((languages.countedLanguageIds || []).length) + " counted; base " +
        str(languages.baseLanguage));
    } else {
      lines.push("Languages: not read.");
    }
    if (result && result.unavailable) {
      lines.push("Result: unavailable -- nothing on this page was assessed.");
    }
    ((result && result.sections) || []).forEach((section) => {
      lines.push("");
      lines.push(str(section.label) || str(section.id));
      (section.rows || []).forEach((row) => {
        const coverage = row.coverage || {};
        const missing = (coverage.missing || []).join(",") || "none";
        const warnings = reportWarnings(row);
        lines.push("- " + str(row.element) + " [" + str(row.aspect) + "]: " +
          (coverage.covered || 0) + "/" + (coverage.counted || 0) +
          "; missing=" + missing +
          (warnings.length ? "; warnings=" + warnings.join(",") : ""));
      });
    });
    ((result && result.failures) || []).forEach((failure) => {
      lines.push("Read failure: " + str(failure.table) + " (" + (failure.status || "unavailable") + ")");
    });
    return lines.join("\n");
  }

  function currentSnapshot() {
    if (!panel) return null;
    if (panel.result && panel.status === "complete") return panel.result;
    return {
      version: (panel.result && panel.result.version) || "",
      context: activeContext(),
      languages: languageContext(),
      sections: panel.sections.slice(),
      failures: (panel.result && panel.result.failures) || [],
      unavailable: Boolean(panel.result && panel.result.unavailable),
    };
  }

  function formatResultsAsText(result) {
    const substituted = !result;
    const snapshot = result || currentSnapshot();
    const api = engineApi();
    let body = "";
    if (api && isFn(api.formatResultsAsText)) {
      try { body = str(api.formatResultsAsText(snapshot)); } catch (error) { body = ""; }
    }
    if (!body) body = localReport(snapshot);
    if (substituted && panel && panel.status !== "complete") {
      body += "\n\nPartial run: this report was taken while sections were still being read." +
        (panel.errorMessage ? " The run stopped: " + panel.errorMessage : "");
    }
    return body;
  }

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.readOnly = true;
      textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw error;
    }
  }

  function flashCopyButton(text) {
    const button = panel && panel.refs && panel.refs.copyButton;
    if (!button) return;
    button.textContent = text;
    if (copyResetTimer) {
      try { clearTimeout(copyResetTimer); } catch (error) { /* ignore */ }
    }
    copyResetTimer = setTimeout(() => {
      copyResetTimer = null;
      if (panel && panel.refs && panel.refs.copyButton) {
        panel.refs.copyButton.textContent = "Copy report";
      }
    }, 1600);
  }

  function copyReport() {
    if (!panel) return Promise.resolve(false);
    const callbacks = panel.callbacks || {};
    const fingerprint = panel.fingerprint;
    return Promise.resolve()
      .then(() => (isFn(callbacks.onCopyReport)
        ? callbacks.onCopyReport()
        : formatResultsAsText(panel.result)))
      .then((report) => writeClipboard(str(report)))
      .then(() => {
        if (sameRun(fingerprint)) flashCopyButton("Copied");
        return true;
      })
      .catch(() => {
        if (sameRun(fingerprint)) flashCopyButton("Copy failed");
        return false;
      });
  }

  /* ------------------------------------------------------------------ *
   * Section bookkeeping
   * ------------------------------------------------------------------ */

  function registerSection(section) {
    if (!section || !section.id) return;
    const id = str(section.id);
    if (!panel.seenSections.has(id)) {
      panel.seenSections.add(id);
      if (section.collapsed) panel.collapsedSections.add(id);
    }
    (Array.isArray(section.subsections) ? section.subsections : []).forEach((sub) => {
      if (!sub || !sub.id) return;
      const subId = str(sub.id);
      if (panel.seenSections.has(subId)) return;
      panel.seenSections.add(subId);
      if (sub.collapsed) panel.collapsedSections.add(subId);
    });
  }

  function upsertSection(section) {
    if (!section || !section.id) return;
    registerSection(section);
    const id = str(section.id);
    const index = panel.sections.findIndex((item) => str(item.id) === id);
    if (index < 0) panel.sections.push(section);
    else panel.sections[index] = section;
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  function open(options) {
    const request = options || {};
    if (typeof document !== "object" || !document || !isFn(document.createElement)) return false;
    if (typeof window === "object" && window && window.top && window !== window.top) return false;
    if (panel) unmount();
    panel = {
      fingerprint: str(request.fingerprint),
      context: Object.assign({}, request.context || {}),
      callbacks: request.callbacks || {},
      status: "loading",
      phase: "",
      detail: "",
      errorMessage: "",
      result: null,
      sections: [],
      seenSections: new Set(),
      collapsedSections: new Set(),
      expanded: new Set(),
      expandAll: false,
      filter: "all",
      showMinor: false,
      search: "",
      searchTimer: null,
      selection: null,
      includeInactive: false,
      pickerOpen: false,
      lookupRows: [],
      lookupKey: "",
      lookupStatus: "",
      lookupError: "",
      refs: null,
    };
    mount();
    paint();
    return true;
  }

  function setProgress(options) {
    const request = options || {};
    if (!sameRun(request.fingerprint)) return false;
    panel.phase = str(request.phase);
    panel.detail = str(request.detail);
    if (panel.status !== "complete") renderStatus();
    return true;
  }

  function showResults(options) {
    const request = options || {};
    if (!sameRun(request.fingerprint)) return false;
    if (request.section) {
      upsertSection(request.section);
      if (panel.status !== "complete") panel.status = "partial";
    }
    if (request.result) {
      const result = request.result;
      panel.result = result;
      (result.sections || []).forEach(registerSection);
      panel.sections = Array.isArray(result.sections) ? result.sections.slice() : [];
      panel.status = request.partial === true ? "partial" : "complete";
      if (panel.status === "complete") panel.errorMessage = "";
    }
    paint();
    return true;
  }

  function showError(options) {
    const request = options || {};
    if (!sameRun(request.fingerprint)) return false;
    panel.errorMessage = str(request.message) || "Translation Lens could not finish.";
    panel.status = "error";
    paint();
    return true;
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

  globalThis.SNTranslationLensUI = {
    open,
    setProgress,
    showResults,
    showError,
    close,
    formatResultsAsText,
  };
})();

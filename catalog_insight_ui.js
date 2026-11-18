/*
 * Isolated-world UI for the "Catalog Logic" command.
 * Loaded before content.js so the command-palette action can call the
 * public API. Read-only: lists the catalog client scripts and catalog UI
 * policies that target the current catalog item (and its variable sets),
 * each row's name a link to the platform record. Never runs or edits them.
 */

(() => {
  if (globalThis.SNCatalogInsightUI) return;

  let resultsHost = null;
  let resultsShadow = null;
  let resultsKeydownHandler = null;
  // What had focus when the panel opened (a Variable Insight mark, say), so
  // closing it does not leave focus on the page itself.
  let previousFocus = null;
  let lastResult = null;
  let activeFilter = "all";
  let searchQuery = "";
  let hideInactive = false;
  let groupByVariable = false;
  // The summary's "won't run here" count, pressed: only those rows, on top of
  // the type filter, Active only and the search.
  let wontRunOnly = false;
  // When the panel is opened from a per-variable icon, we scope every view to
  // the logic that targets that one variable until "Show all" clears it.
  let focusVariable = null;
  const collapsedGroups = new Set();

  const KIND_LABEL = { client: "Client script", uip: "UI policy" };
  const RECORD_TABLE = { client: "catalog_script_client", uip: "catalog_ui_policy" };

  const escapeHtml = (value) =>
    String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const UI_CSS = `
    *{box-sizing:border-box}
    :host{
      all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      /* Teal = grouping/selection/focus/links; pink = primary action. */
      --teal:#31d4c4;--pink:#ff6fae;--band:#2a2a46;
    }
    button,input{font:inherit}
    .overlay{
      position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.52);
      display:flex;align-items:center;justify-content:center;padding:24px;
    }
    .panel{
      width:min(1800px,calc(100vw - 48px));height:calc(100vh - 48px);
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
    .subtitle{font-size:12px;color:#9a9ab3;line-height:1.45;max-width:90ch}
    .close{
      border:0;background:transparent;color:#9a9ab3;padding:3px 5px;
      font-size:12px;line-height:1;cursor:pointer;border-radius:5px;
    }
    .close:hover{color:#fff;background:#2d2d48}
    .summary{
      display:flex;gap:18px;align-items:center;padding:10px 20px;
      border-bottom:1px solid #292944;color:#aaaac1;font-size:11px;
    }
    .summary strong{color:#f0f0fa;font-size:13px;margin-right:4px}
    .summary .muted{color:#9a9ab3}
    .summary .muted strong{color:#c6c6d8}
    .summary .chip-warn{
      color:#e0c187;background:#332c1b;border:1px solid #574a2c;
      border-radius:5px;padding:2px 8px;font-size:11px;cursor:pointer;
    }
    .summary .chip-warn:hover{background:#3d3420;color:#f0d79b}
    .summary .chip-warn:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
    .summary .chip-warn[aria-pressed="true"]{background:#4a3c1c;border-color:#c9a24f;color:#f7e2b0}
    .summary .chip-warn strong{color:#f0d79b}
    .warning{margin-left:auto;color:#d2b779}
    .focus-banner{
      display:flex;align-items:center;gap:10px;padding:9px 20px;font-size:12px;
      color:#cfeee9;border-bottom:1px solid #292944;
      background:color-mix(in srgb, var(--teal) 12%, #21283a);
    }
    .focus-banner .focus-what{color:#c8c8dc}
    .focus-banner strong{color:#eafffb;font-weight:650}
    .focus-banner .focus-name{
      font:11px ui-monospace,SFMono-Regular,Consolas,monospace;
      color:color-mix(in srgb, var(--teal) 70%, #cfeee9);
    }
    .focus-banner .focus-clear{
      margin-left:auto;border:1px solid #5b5b86;background:#3f4067;color:#e6e6f5;
      border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;
    }
    .focus-banner .focus-clear:hover{background:#4a4b78;color:#fff}
    .controls{
      display:flex;align-items:center;gap:8px;padding:10px 14px;
      border-bottom:1px solid #292944;
    }
    .filters{display:flex;gap:6px;flex-wrap:wrap}
    .filter{
      border:1px solid #68689a;background:#3f4067;color:#e6e6f5;
      border-radius:6px;padding:5px 9px;cursor:pointer;font-size:11px;
    }
    .filter:hover{background:#4a4b78;color:#fff}
    .filter.active{
      background:color-mix(in srgb, var(--teal) 30%, #23303a);
      border-color:var(--teal);color:#eafffb;
      box-shadow:0 0 0 1px color-mix(in srgb, var(--teal) 40%, transparent);
    }
    .toggle{
      border:1px solid #68689a;background:#3f4067;color:#e6e6f5;
      border-radius:6px;padding:5px 9px;cursor:pointer;font-size:11px;
      display:inline-flex;align-items:center;gap:6px;
    }
    .toggle:hover{background:#4a4b78;color:#fff}
    .toggle.active{
      background:color-mix(in srgb, var(--teal) 28%, #23303a);
      border-color:var(--teal);color:#eafffb;
    }
    .toggle .dot{width:7px;height:7px;border-radius:50%;background:#55556f}
    .toggle.active .dot{background:var(--teal)}
    .search{
      margin-left:auto;width:230px;max-width:38vw;background:#313150;
      border:1px solid #575780;border-radius:6px;color:#f0f0fa;
      outline:none;padding:7px 9px;font-size:12px;
    }
    .search:focus{border-color:var(--teal);background:#37375a}
    .search::placeholder{color:#a4a4be}
    .rows{flex:1;overflow:auto;padding:6px 0}
    .group{border-bottom:1px solid #23233a}
    .group-head{
      display:flex;align-items:center;gap:9px;padding:9px 16px;cursor:pointer;
      width:100%;margin:0;border:0;font:inherit;color:inherit;text-align:left;
      background:linear-gradient(90deg, color-mix(in srgb, var(--teal) 20%, var(--band)), var(--band) 48%);
      box-shadow:inset 3px 0 0 var(--teal);
      border-top:1px solid color-mix(in srgb, var(--teal) 26%, #262640);
      position:sticky;top:-6px;z-index:1;user-select:none;
    }
    .group-head:hover{filter:brightness(1.08)}
    .group-head:focus-visible{outline:2px solid var(--teal);outline-offset:-2px}
    .group-caret{color:color-mix(in srgb, var(--teal) 55%, #9a9ab4);font-size:10px;width:10px;flex:none}
    .group-name{
      font:12px ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:600;
      color:color-mix(in srgb, var(--teal) 82%, white);white-space:nowrap;flex:none;
    }
    /* The form-level group recedes on purpose, though it comes first. */
    .group.none{--teal:#6f6f90}
    .group.none .group-name{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#c8c8dc}
    /* The whole head does one thing, so the question label wraps rather than
       truncating behind a click of its own. */
    .group-label{font-size:11px;color:#c8c8dc;min-width:0;overflow-wrap:anywhere}
    /* A variable whose name never came back: its label, or "Variable not
       found", in plain type, then its sys_id, dimmer. */
    .group-name.unresolved{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      white-space:normal;flex:0 1 auto;min-width:0;overflow-wrap:anywhere}
    .group-id{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#9a9ab3;min-width:0;
      overflow-wrap:anywhere}
    .group-count{
      margin-left:auto;flex:none;border-radius:10px;padding:1px 9px;font-size:11px;font-weight:600;
      background:color-mix(in srgb, var(--teal) 26%, var(--band));
      color:color-mix(in srgb, var(--teal) 55%, white);
      border:1px solid color-mix(in srgb, var(--teal) 34%, transparent);
    }
    /* Rows: one verdict per row, facts in labelled columns. The header and
       each row's top line share one template (Name | Type and trigger |
       Applies on | Order | On this form = minmax(0,1fr) 210px 150px 44px
       128px); the three facts sit in one list spanning the middle tracks. */
    .rows{container:rows / inline-size}
    .cols,.row-top{display:grid;grid-template-columns:minmax(0,1fr) 428px 128px;column-gap:12px;
      align-items:start}
    .vals,.facts{display:grid;grid-template-columns:210px 150px 44px;column-gap:12px;margin:0;min-width:0}
    /* Sticky at the list's own top edge: top:0 would stop 6px short, under
       the list's top padding, and a scrolled row showed through the gap. */
    .cols{position:sticky;top:-6px;z-index:2;height:30px;padding:7px 18px;background:#1e1e2e;
      border-bottom:1px solid #2e2e4e;font-size:11px;color:#9a9ab3}
    .cols span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cols .num{text-align:right}
    /* Right below the header, which keeps its place while a group scrolls:
       the header's 30px, less the same 6px. */
    .group-head{top:24px}
    .group-rows .row{padding-left:30px}
    .row{padding:10px 18px;border-bottom:1px solid #292941;font-size:12px;color:#d7d7e8}
    .row:hover{background:#26263e}
    .row.flagged{box-shadow:inset 3px 0 0 #a5842f}
    .namecell{min-width:0}
    .name{
      display:block;max-width:100%;border:0;background:transparent;padding:0;margin:0;cursor:pointer;
      text-align:left;color:#f0f0fa;font-size:13px;font-weight:600;line-height:1.35;
      text-decoration:underline;text-decoration-color:#6c6c90;text-underline-offset:2px;
      overflow-wrap:anywhere;
    }
    .name:hover{color:#fff;text-decoration-color:var(--teal)}
    .name:focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-radius:3px}
    .row.inactive .name{color:#9a9ab3;text-decoration-color:#55556f}
    .bound{font-size:11.5px;color:#b9b9cf;margin-top:2px;overflow-wrap:anywhere}
    .cond,.effect{
      margin-top:3px;font-size:11px;line-height:1.45;color:#c9c9dc;overflow-wrap:anywhere;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
    }
    .cond .if{color:#9a9ab3;margin-right:5px}
    .cond code{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#c9c9dc}
    .fact{min-width:0}
    .fact dt{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
      clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .fact dd{margin:0;color:#dedeee;line-height:1.4;overflow-wrap:anywhere}
    .fact .sub{display:block;color:#9a9ab3;font-size:11px;margin-top:1px}
    .fact.order dd{text-align:right;font-variant-numeric:tabular-nums}
    .none{color:#9a9ab3}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
      clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .verdict{min-width:0}
    .badge{
      display:inline-block;padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:650;
      letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;border:1px solid;
    }
    .badge.warn{color:#f0d79b;background:#3a3320;border-color:#5c5031}
    .badge.off{color:#c3c3d8;background:#2c2d4a;border-color:#4a4a6e}
    .reason{margin:6px 0 0;font-size:12px;line-height:1.45;color:#c8c8dc;max-width:90ch}
    .reason .v{font-weight:650}
    .v.warn{color:#f0d79b}.v.off{color:#c3c3d8}
    /* Narrow: no header; the name and its badge, then the facts as a
       labelled list. The same nodes as the wide form. */
    @container rows (max-width:759px){
      .cols{display:none}
      .group-head{top:-6px}
      .row-top{grid-template-columns:minmax(0,1fr) auto}
      .namecell{grid-column:1;grid-row:1}
      .verdict{grid-column:2;grid-row:1}
      .facts{grid-column:1 / -1;grid-row:2;grid-template-columns:max-content minmax(0,1fr);
        gap:2px 10px;margin-top:6px;font-size:12px}
      .fact{display:contents}
      .fact dt{position:static;width:auto;height:auto;margin:0;overflow:visible;clip:auto;
        white-space:normal;color:#9a9ab3;font-size:11px;padding-top:1px}
      .fact .sub{display:inline;margin:0 0 0 6px}
      .fact.order dd{text-align:left}
    }
    .empty{padding:48px 20px;text-align:center;color:#9a9ab3;font-size:13px;max-width:90ch;margin:0 auto}
    .toolbar{
      display:flex;align-items:center;gap:8px;padding:11px 14px;flex-wrap:wrap;
      border-top:1px solid #2e2e4e;background:#1b1b2b;
    }
    .toolbar-note{font-size:11px;color:#9a9ab3;flex:1;min-width:140px;max-width:90ch;margin-right:auto}
    .toolbar button{
      border:1px solid #3a3a5c;background:#292941;color:#d8d8ea;
      border-radius:6px;padding:6px 9px;cursor:pointer;font-size:12px;
    }
    .toolbar button:hover{background:#343453;color:#fff}
    .toolbar button:disabled{opacity:.4;cursor:not-allowed}
    .toolbar button:disabled:hover{background:#292941;color:#d8d8ea}
    /* "In platform ↗" — secondary navigation: teal outline that still pops. */
    .toolbar button[data-action='open-scripts'],
    .toolbar button[data-action='open-policies']{
      background:color-mix(in srgb, var(--teal) 12%, transparent);
      border-color:color-mix(in srgb, var(--teal) 52%, #3a3a5c);
      color:color-mix(in srgb, var(--teal) 84%, white);
    }
    .toolbar button[data-action='open-scripts']:hover,
    .toolbar button[data-action='open-policies']:hover{
      background:color-mix(in srgb, var(--teal) 20%, transparent);color:#fff;
    }
    /* Primary action = the one pink button. */
    .toolbar .primary{
      background:color-mix(in srgb, var(--pink) 82%, #3a2740);
      border-color:color-mix(in srgb, var(--pink) 70%, #5a3a4c);color:#fff;
    }
    .toolbar .primary:hover{background:color-mix(in srgb, var(--pink) 92%, #3a2740)}
    @media(max-width:640px){
      .overlay{padding:8px}.panel{width:100%;height:calc(100vh - 16px)}
      .header{padding:14px}.summary{padding:9px 14px;gap:10px;flex-wrap:wrap}
      .warning{width:100%;margin-left:0}.controls{align-items:stretch;flex-direction:column}
      .search{width:100%;max-width:none;margin-left:0}
      .row{padding:10px 14px}
    }
  `;

  const closeResults = () => {
    if (resultsKeydownHandler) {
      window.removeEventListener("keydown", resultsKeydownHandler, true);
      resultsKeydownHandler = null;
    }
    if (resultsHost) resultsHost.remove();
    resultsHost = null;
    resultsShadow = null;
    // Every way out (either Close, Escape, a click outside) ends here. A
    // mouse click on Close had focused that button, so removing the panel
    // dropped focus to the page.
    const restore = previousFocus;
    previousFocus = null;
    if (restore && typeof restore.focus === "function") {
      try {
        restore.focus({ preventScroll: true });
      } catch (e) {
        try { restore.focus(); } catch (ignored) { /* the opener is gone */ }
      }
    }
  };

  // The panel is aria-modal, so Tab and Shift+Tab go round its own controls
  // and never reach the page behind it. A control in a closed group, or a
  // summary chip hidden at zero, is not displayed, so it is passed over.
  const keepTabInside = (event) => {
    const focusable = Array.from(resultsShadow.querySelectorAll("button, input"))
      .filter((node) => !node.disabled && node.checkVisibility());
    if (!focusable.length) return;
    const index = focusable.indexOf(resultsShadow.activeElement);
    const next = event.shiftKey
      ? (index <= 0 ? focusable.length - 1 : index - 1)
      : (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
    event.preventDefault();
    focusable[next].focus();
  };

  const allRows = () => (lastResult && lastResult.rows) || [];

  // A row's own words. The variables it is about are not among them: those
  // belong to the place it is filed under (see searchFinds).
  const rowOwnText = (row) =>
    [row.name, KIND_LABEL[row.kind], row.subtype, row.boundTo, row.conditions]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  // A variable as its group head shows it: name and question label, and the
  // sys_id only where it stands in for a name that never came back.
  const placeText = (place) =>
    [place.name, place.label, place.name ? "" : place.sysId]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  // The search is asked of a row in each place it is filed, so a search for a
  // variable finds a UI policy under that variable and not under the others
  // it changes. A match on the row's own words finds it everywhere it is filed.
  const searchFinds = (row, place) =>
    !searchQuery || rowOwnText(row).includes(searchQuery) || placeText(place).includes(searchQuery);

  // Where the "Group by variable" view files each row. An onChange client
  // script goes under the variable it watches. A UI policy goes under every
  // variable one of its actions changes, carrying the actions for that one so
  // the row can say what it does there. The rest (onLoad and onSubmit scripts,
  // policies that change no variable) is form-level and shares one group.
  // Scoped to one variable, a policy is filed under that variable only.
  // A place is keyed by the variable's name, or by its sys_id when the name
  // never came back; `name` stays empty then, so the head can say so.
  const NO_VARIABLE = "\0none";
  const FORM_LEVEL = [{ key: NO_VARIABLE, name: "", sysId: "", label: "", acts: [] }];
  const placeFor = (sysId, name, label) =>
    ({ key: name || sysId, name: name || "", sysId: sysId || "", label: label || "", acts: [] });
  const groupPlacesOf = (row) => {
    if (row.kind === "client") {
      if (!row.variable) return FORM_LEVEL;
      return [placeFor(row.variable, row.variableName, row.variableLabel)];
    }
    const actions = focusVariable
      ? rowActionsForFocus(row)
      : Array.isArray(row.actions) ? row.actions : [];
    const places = new Map();
    actions.forEach((action) => {
      const place = placeFor(action.variable, action.variableName, action.variableLabel);
      if (!place.key) return;
      if (!places.has(place.key)) places.set(place.key, place);
      places.get(place.key).acts.push(action);
    });
    return places.size ? Array.from(places.values()) : FORM_LEVEL;
  };

  // Does a row target the focused variable? onChange client scripts match by the
  // watched variable (sys_id or name); UI policies match when one of their
  // actions targets it. Everything else (onLoad/onSubmit, variable-less UI
  // policies) is form-level and excluded from the scoped view.
  const rowActionsForFocus = (row) => {
    if (!focusVariable || row.kind !== "uip" || !Array.isArray(row.actions)) return [];
    return row.actions.filter(
      (a) =>
        (focusVariable.sysId && a.variable === focusVariable.sysId) ||
        (focusVariable.name && a.variableName === focusVariable.name)
    );
  };
  const matchesFocus = (row) => {
    if (!focusVariable) return true;
    if (row.kind === "client") {
      return (
        (focusVariable.sysId && row.variable === focusVariable.sysId) ||
        (focusVariable.name && row.variableName === focusVariable.name)
      );
    }
    if (row.kind === "uip") return rowActionsForFocus(row).length > 0;
    return false;
  };

  const filteredRows = () =>
    allRows().filter((row) => {
      if (!matchesFocus(row)) return false;
      if (activeFilter !== "all" && row.kind !== activeFilter) return false;
      if (hideInactive && !row.active) return false;
      if (wontRunOnly && !wontRunHere(row)) return false;
      // The flat list keeps a row the search finds in any of its places.
      return !searchQuery || groupPlacesOf(row).some((place) => searchFinds(row, place));
    });

  const openRecord = (row) => {
    const table = RECORD_TABLE[row.kind];
    if (!table || !row.id) return;
    const url = location.origin + "/" + table + ".do?sys_id=" + encodeURIComponent(row.id);
    try {
      chrome.runtime.sendMessage({ type: "OPEN_URL", url });
    } catch (e) {
      window.open(url, "_blank", "noopener");
    }
  };

  // Open the whole filtered set in the platform list, mirroring the exact
  // query fetchCatalogAffectingLogic used (item plus any attached variable
  // sets). Complements each row's name link.
  const openList = (kind) => {
    const table = RECORD_TABLE[kind];
    const itemId = lastResult && lastResult.itemSysId;
    if (!table || !itemId) return;
    const itemField = kind === "client" ? "cat_item" : "catalog_item";
    const setIds = (lastResult && lastResult.setIds) || [];
    let query = itemField + "=" + itemId;
    if (setIds.length) query += "^ORvariable_setIN" + setIds.join(",");
    const url =
      location.origin + "/" + table + "_list.do?sysparm_query=" + encodeURIComponent(query);
    try {
      chrome.runtime.sendMessage({ type: "OPEN_URL", url });
    } catch (e) {
      window.open(url, "_blank", "noopener");
    }
  };

  const VIEW_WORDS = { catalog: "Catalog item", task: "Task", ritm: "RITM" };
  const viewWords = (row) =>
    ["catalog", "task", "ritm"].filter((key) => row.views && row.views[key]).map((key) => VIEW_WORDS[key]);

  const andList = (words) =>
    words.length < 2 ? words.join("") : words.slice(0, -1).join(", ") + " and " + words[words.length - 1];

  // Active, but set to run on Task or RITM views only: the summary's count
  // and its filter.
  const wontRunHere = (row) => Boolean(row.active && row.views && !row.views.catalog);

  // "Why isn't this firing?" — evaluated against the catalog order form, the
  // runtime this panel is opened from. Returns null when nothing blocks it.
  // Inactive wins: a row that is both never runs anywhere, which is the
  // stronger answer, and the summary counts it as inactive only.
  const WONT_RUN = "Won't run here";
  const firingIssue = (row) => {
    if (!row.active) {
      return { kind: "off", verdict: "Inactive", reason: "This never runs." };
    }
    if (wontRunHere(row)) {
      const where = ["task", "ritm"].filter((key) => row.views[key]).map((key) => VIEW_WORDS[key]);
      return {
        kind: "warn",
        verdict: WONT_RUN,
        reason: where.length
          ? "It applies on " + andList(where) + " only, not while ordering this item."
          : "It applies on no view, so not while ordering this item.",
      };
    }
    return null;
  };

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  };

  // A list's own "variables", not the engine's shorthand "N vars".
  const spellSubtype = (subtype) =>
    String(subtype || "").replace(/\b(\d+) vars?\b/g, (_, n) => n + (n === "1" ? " variable" : " variables"));

  const fact = (className, label, fill) => {
    const wrap = make("div", "fact" + (className ? " " + className : ""));
    wrap.append(make("dt", null, label));
    const value = make("dd");
    fill(value);
    wrap.append(value);
    return wrap;
  };

  const dimDash = (node, spoken) => {
    const dash = make("span", "none", "–");
    dash.setAttribute("aria-hidden", "true");
    node.append(dash, make("span", "sr-only", spoken));
  };

  // For sight: each row's facts carry their own labels for assistive
  // technology, so the header is not read as well.
  const buildHeader = () => {
    const header = make("div", "cols");
    header.setAttribute("aria-hidden", "true");
    const vals = make("span", "vals");
    vals.append(make("span", null, "Type and trigger"), make("span", null, "Applies on"),
      make("span", "num", "Order"));
    header.append(make("span", null, "Name"), vals, make("span", null, "On this form"));
    return header;
  };

  // `acts`: the UI policy actions to spell out under the name. The grouped
  // view passes the ones for the row's group; otherwise, the scoped view's.
  const buildRowEl = (row, acts) => {
    const issue = firingIssue(row);
    const el = make("div",
      "row" + (row.active ? "" : " inactive") + (issue && issue.kind === "warn" ? " flagged" : ""));
    const top = make("div", "row-top");

    // Name (the control that opens the record), what it is bound to, and the
    // policy's condition, raw.
    const nameCell = make("div", "namecell");
    const name = make("button", "name", row.name || "(unnamed)");
    name.type = "button";
    name.title = "Open the " + KIND_LABEL[row.kind].toLowerCase() + " record";
    name.addEventListener("click", () => openRecord(row));
    nameCell.append(name);
    if (row.boundTo) nameCell.append(make("div", "bound", row.boundTo));
    if (row.conditions) {
      const cond = make("div", "cond");
      cond.title = row.conditions;
      cond.append(make("span", "if", "If"), make("code", null, row.conditions));
      nameCell.append(cond);
    }
    // Under a variable, spell out what this UI policy actually does to that
    // variable (hides / makes mandatory / sets value…).
    const shownActs = acts || rowActionsForFocus(row);
    if (shownActs.length) {
      const eff = shownActs.map((a) => a.effect).filter(Boolean).join(" · ");
      if (eff) {
        const actEl = make("div", "effect", "→ " + eff);
        actEl.title = eff;
        nameCell.append(actEl);
      }
    }

    const facts = make("dl", "facts");
    facts.append(
      fact("type", "Type and trigger", (dd) => {
        dd.append(document.createTextNode(KIND_LABEL[row.kind]));
        const watched = row.kind === "client" ? row.variableName || row.variable : "";
        const sub = spellSubtype(row.subtype) + (row.subtype && watched ? " · " : "") + (watched || "");
        if (sub) dd.append(make("span", "sub", sub));
      }),
      fact("views", "Applies on", (dd) => {
        const words = viewWords(row);
        if (words.length) dd.textContent = words.join(", ");
        else dimDash(dd, "no view");
      }),
      fact("order", "Order", (dd) => {
        if (row.orderKnown) dd.textContent = String(row.order);
        else dimDash(dd, "not known");
      })
    );

    // A badge only when something stops the row firing on this form. For
    // sight only: the reason sentence below starts with the same words, so a
    // screen reader would otherwise hear the verdict twice.
    const verdict = make("div", "verdict");
    if (issue) {
      const badge = make("span", "badge " + issue.kind, issue.verdict);
      badge.setAttribute("aria-hidden", "true");
      verdict.append(badge);
    }

    top.append(nameCell, facts, verdict);
    el.append(top);
    if (issue) {
      const reason = make("p", "reason");
      reason.append(make("span", "v " + issue.kind, issue.verdict + "."),
        document.createTextNode(" " + issue.reason));
      el.append(reason);
    }
    return el;
  };

  const renderEmpty = (list) => {
    const empty = document.createElement("div");
    empty.className = "empty";
    if (focusVariable && allRows().length) {
      empty.textContent =
        "No client scripts or UI policy actions target “" +
        (focusVariable.label || focusVariable.name) +
        "”. Form-level logic may still apply — use Show all.";
    } else {
      empty.textContent = allRows().length
        ? "Nothing matches these filters."
        : "No catalog client scripts or UI policies target this item.";
    }
    list.appendChild(empty);
  };

  const renderFlat = (list, rows) => {
    rows.forEach((row) => list.appendChild(buildRowEl(row)));
  };

  // What a group's count means, for a screen reader: the bare number alone
  // says nothing after the variable's name.
  const countWords = (items) => {
    const clients = items.filter(({ row }) => row.kind === "client").length;
    const policies = items.length - clients;
    return [
      clients ? clients + (clients === 1 ? " client script" : " client scripts") : "",
      policies ? policies + (policies === 1 ? " UI policy" : " UI policies") : "",
    ].filter(Boolean).join(", ");
  };

  // "Group by variable": the form-level group first, then one group per
  // variable in name order, and last any variable whose name never came back.
  // A UI policy that changes several variables is in each of their groups,
  // so the group counts can add up to more than the total. Each head is a
  // button that opens and closes its group in place: nothing is redrawn, so
  // focus stays on the head, and the rows it controls are always drawn
  // (hidden when closed) so aria-controls always has a target.
  let groupSeq = 0;
  const renderGrouped = (list, rows) => {
    const groups = new Map();
    rows.forEach((row) => {
      groupPlacesOf(row).forEach((place) => {
        if (!searchFinds(row, place)) return;
        if (!groups.has(place.key)) {
          groups.set(place.key, { name: place.name, sysId: place.sysId, label: "", items: [] });
        }
        const group = groups.get(place.key);
        if (!group.label && place.label) group.label = place.label;
        group.items.push({ row, acts: place.acts });
      });
    });

    const sortText = (group) => (group.name || group.label || group.sysId).toLowerCase();
    const keys = Array.from(groups.keys())
      .filter((k) => k !== NO_VARIABLE)
      .sort((a, b) => {
        const ga = groups.get(a);
        const gb = groups.get(b);
        if (Boolean(ga.name) !== Boolean(gb.name)) return ga.name ? -1 : 1;
        // Unnamed: those with a question label, then bare sys_ids.
        if (Boolean(ga.label) !== Boolean(gb.label)) return ga.label ? -1 : 1;
        return sortText(ga).localeCompare(sortText(gb));
      });
    if (groups.has(NO_VARIABLE)) keys.unshift(NO_VARIABLE);

    keys.forEach((key) => {
      const { name, sysId, label, items } = groups.get(key);
      const isNone = key === NO_VARIABLE;

      const group = make("div", "group" + (isNone ? " none" : ""));
      const head = make("button", "group-head");
      head.type = "button";
      const caret = make("span", "group-caret");
      caret.setAttribute("aria-hidden", "true");
      head.append(caret);

      if (isNone) {
        head.append(make("span", "group-name", "Not variable-specific"),
          make("span", "group-label", "onLoad and onSubmit scripts, and UI policies that change no variable"));
      } else if (name) {
        head.append(make("span", "group-name", name));
        if (label) head.append(make("span", "group-label", label));
      } else {
        /* With a label to name it, the 32-character sys_id is for the eye
           only; without one it is the only thing that tells groups apart. */
        const id = make("span", "group-id", sysId);
        if (label) id.setAttribute("aria-hidden", "true");
        head.append(make("span", "group-name unresolved", label || "Variable name not available"), id);
      }
      const count = make("span", "group-count", String(items.length));
      count.setAttribute("aria-hidden", "true");
      head.append(count, make("span", "sr-only", ", " + countWords(items)));

      const body = make("div", "group-rows");
      body.id = "snh-ci-group-" + (++groupSeq);
      head.setAttribute("aria-controls", body.id);
      items.forEach(({ row, acts }) => body.appendChild(buildRowEl(row, acts)));

      const paint = () => {
        const collapsed = collapsedGroups.has(key);
        head.setAttribute("aria-expanded", collapsed ? "false" : "true");
        caret.textContent = collapsed ? "▸" : "▾";
        body.hidden = collapsed;
      };
      head.addEventListener("click", () => {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key);
        else collapsedGroups.add(key);
        paint();
      });
      paint();

      group.append(head, body);
      list.appendChild(group);
    });
  };

  const renderRows = () => {
    if (!resultsShadow) return;
    const list = resultsShadow.querySelector(".rows");
    if (!list) return;
    list.textContent = "";

    const rows = filteredRows();
    if (!rows.length) {
      renderEmpty(list);
      return;
    }

    // One header for the list; the grouped view uses the same rows, so it
    // shares it, and its group heads stick below it.
    list.appendChild(buildHeader());
    if (groupByVariable) renderGrouped(list, rows);
    else renderFlat(list, rows);
  };

  const resultsAsText = () => {
    const rows = filteredRows();
    const lines = [
      "GlideLens — Catalog Logic",
      "Read-only; catalog client scripts and UI policies targeting this item.",
      (lastResult && lastResult.itemName ? "Item: " + lastResult.itemName : ""),
      "Rows: " + rows.length + " of " + allRows().length,
      "",
    ].filter((line) => line !== "");
    rows.forEach((row) => {
      const watched = row.kind === "client" ? row.variableName || row.variable : "";
      const subtype = spellSubtype(row.subtype) + (row.subtype && watched ? " · " : "") + (watched || "");
      const issue = firingIssue(row);
      const views = viewWords(row);
      const bits = [
        KIND_LABEL[row.kind],
        subtype,
        row.name || "(unnamed)",
        row.boundTo,
        "applies on " + (views.length ? views.join(", ") : "no view"),
        // The same words as the badge and its sentence.
        issue ? issue.verdict + ". " + issue.reason : "Active",
      ].filter(Boolean);
      let line = bits.join(" — ");
      if (row.conditions) line += " — If " + row.conditions;
      lines.push(line);
    });
    return lines.join("\n");
  };

  const copyList = async () => {
    const text = resultsAsText();
    try {
      await navigator.clipboard.writeText(text);
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
    if (resultsShadow) {
      const copyButton = resultsShadow.querySelector("[data-action='copy']");
      if (copyButton) {
        const previous = copyButton.textContent;
        copyButton.textContent = "Copied";
        setTimeout(() => {
          if (copyButton) copyButton.textContent = previous;
        }, 1400);
      }
    }
  };

  const showResults = (result) => {
    if (window !== window.top) return;
    closeResults();
    previousFocus = document.activeElement;
    lastResult = result;
    activeFilter = "all";
    searchQuery = "";
    hideInactive = false;
    wontRunOnly = false;
    focusVariable = result.focusVariable || null;
    /* The whole item opens grouped by variable: going through the logic one
     * variable at a time is how it is read. Opened from a variable's insight
     * icon, every row is already about that one variable, so it opens flat
     * until "Show all" widens it. */
    groupByVariable = !focusVariable;
    collapsedGroups.clear();

    const rows = result.rows || [];
    const clientCount = rows.filter((r) => r.kind === "client").length;
    const uipCount = rows.filter((r) => r.kind === "uip").length;
    const inactiveCount = rows.filter((r) => !r.active).length;
    const notFiringCount = rows.filter(wontRunHere).length;
    const setsNote = result.setCount
      ? result.setCount + (result.setCount === 1 ? " variable set" : " variable sets")
      : "";

    resultsHost = document.createElement("div");
    resultsHost.id = "snh-catalog-insight-results";
    document.documentElement.appendChild(resultsHost);
    resultsShadow = resultsHost.attachShadow({ mode: "closed" });
    resultsShadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="overlay">
        <section class="panel" role="dialog" aria-modal="true" aria-labelledby="snh-catalog-insight-title">
          <header class="header">
            <div class="heading">
              <h2 id="snh-catalog-insight-title">Catalog Logic</h2>
              <div class="subtitle">Catalog client scripts and catalog UI policies bound to this item or its variable sets. Open a record from its name. Read-only — nothing here runs or edits the logic.</div>
            </div>
            <button class="close" type="button">Close</button>
          </header>
          <div class="summary">
            <span><strong data-count="total">0</strong>total</span>
            <span><strong data-count="client">0</strong>client scripts</span>
            <span><strong data-count="uip">0</strong>UI policies</span>
            <span class="muted" data-count-wrap="inactive"><strong data-count="inactive">0</strong>inactive</span>
            <button class="chip-warn" type="button" data-count-wrap="notfiring" data-action="wont-run" aria-pressed="false" title="Show only these rows: active, but set to run on Task or RITM views only, so not while ordering this item"><strong data-count="notfiring">0</strong>won't run here</button>
            ${setsNote ? "<span>" + setsNote + "</span>" : ""}
            ${result.itemName ? '<span style="margin-left:auto;color:#9a9ab3">' + escapeHtml(result.itemName) + "</span>" : ""}
          </div>
          ${
            focusVariable
              ? '<div class="focus-banner"><span class="focus-what">Affecting</span>' +
                "<strong>" +
                escapeHtml(focusVariable.label || focusVariable.name) +
                "</strong>" +
                '<span class="focus-name">' +
                escapeHtml(focusVariable.name) +
                "</span>" +
                '<button class="focus-clear" type="button" data-action="clear-focus">Show all</button></div>'
              : ""
          }
          <div class="controls">
            <div class="filters" aria-label="Type filters">
              <button class="filter active" type="button" data-filter="all" aria-pressed="true">All</button>
              <button class="filter" type="button" data-filter="client" aria-pressed="false">Client scripts</button>
              <button class="filter" type="button" data-filter="uip" aria-pressed="false">UI policies</button>
            </div>
            <button class="toggle" type="button" data-toggle="active" aria-pressed="false">
              <span class="dot"></span>Active only
            </button>
            <button class="toggle${groupByVariable ? " active" : ""}" type="button" data-toggle="group" aria-pressed="${groupByVariable ? "true" : "false"}">
              <span class="dot"></span>Group by variable
            </button>
            <input class="search" type="search" placeholder="Search name, type, variable…" aria-label="Search" />
          </div>
          <div class="rows"></div>
          <footer class="toolbar">
            <span class="toolbar-note">Read-only — nothing here runs or edits the logic.</span>
            <button type="button" data-action="open-scripts" title="Open catalog_script_client filtered to this item, in the platform">Scripts in platform ↗</button>
            <button type="button" data-action="open-policies" title="Open catalog_ui_policy filtered to this item, in the platform">Policies in platform ↗</button>
            <button type="button" data-action="close">Close</button>
            <button class="primary" type="button" data-action="copy">Copy list</button>
          </footer>
        </section>
      </div>
    `;

    const writeCount = (key, value) => {
      const el = resultsShadow.querySelector("[data-count='" + key + "']");
      if (el) el.textContent = String(value);
    };
    writeCount("total", rows.length);
    writeCount("client", clientCount);
    writeCount("uip", uipCount);
    writeCount("inactive", inactiveCount);
    writeCount("notfiring", notFiringCount);

    // The inactive / won't-run chips are noise when zero — hide them.
    const setWrapVisible = (key, visible) => {
      const wrap = resultsShadow.querySelector("[data-count-wrap='" + key + "']");
      if (wrap) wrap.style.display = visible ? "" : "none";
    };
    setWrapVisible("inactive", inactiveCount > 0);
    setWrapVisible("notfiring", notFiringCount > 0);

    resultsShadow.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        activeFilter = button.dataset.filter || "all";
        resultsShadow.querySelectorAll("[data-filter]").forEach((candidate) => {
          candidate.classList.toggle("active", candidate === button);
          candidate.setAttribute("aria-pressed", candidate === button ? "true" : "false");
        });
        renderRows();
      });
    });

    const activeToggle = resultsShadow.querySelector("[data-toggle='active']");
    if (activeToggle) {
      activeToggle.addEventListener("click", () => {
        hideInactive = !hideInactive;
        activeToggle.classList.toggle("active", hideInactive);
        activeToggle.setAttribute("aria-pressed", hideInactive ? "true" : "false");
        renderRows();
      });
    }

    const wontRunToggle = resultsShadow.querySelector("[data-action='wont-run']");
    if (wontRunToggle) {
      wontRunToggle.addEventListener("click", () => {
        wontRunOnly = !wontRunOnly;
        wontRunToggle.setAttribute("aria-pressed", wontRunOnly ? "true" : "false");
        renderRows();
      });
    }

    const groupToggle = resultsShadow.querySelector("[data-toggle='group']");
    const setGrouped = (on) => {
      groupByVariable = on;
      if (groupToggle) {
        groupToggle.classList.toggle("active", on);
        groupToggle.setAttribute("aria-pressed", on ? "true" : "false");
      }
    };
    if (groupToggle) {
      groupToggle.addEventListener("click", () => {
        setGrouped(!groupByVariable);
        renderRows();
      });
    }

    const search = resultsShadow.querySelector(".search");
    if (search) {
      search.addEventListener("input", () => {
        searchQuery = search.value.trim().toLowerCase();
        renderRows();
      });
    }

    const clearFocusButton = resultsShadow.querySelector("[data-action='clear-focus']");
    if (clearFocusButton) {
      clearFocusButton.addEventListener("click", () => {
        focusVariable = null;
        const banner = resultsShadow.querySelector(".focus-banner");
        if (banner) banner.remove();
        // The whole item now, so the whole item's default view.
        setGrouped(true);
        renderRows();
        // The button went with its banner. Focus goes to the toggle that
        // just changed, right before the list, rather than to the page.
        if (groupToggle) groupToggle.focus();
      });
    }

    const closeButton = resultsShadow.querySelector(".close");
    const footerClose = resultsShadow.querySelector("[data-action='close']");
    const copyButton = resultsShadow.querySelector("[data-action='copy']");
    if (closeButton) closeButton.addEventListener("click", closeResults);
    if (footerClose) footerClose.addEventListener("click", closeResults);
    if (copyButton) copyButton.addEventListener("click", () => copyList().catch(() => {}));

    const scriptsButton = resultsShadow.querySelector("[data-action='open-scripts']");
    const policiesButton = resultsShadow.querySelector("[data-action='open-policies']");
    if (scriptsButton) {
      scriptsButton.disabled = clientCount === 0;
      scriptsButton.addEventListener("click", () => openList("client"));
    }
    if (policiesButton) {
      policiesButton.disabled = uipCount === 0;
      policiesButton.addEventListener("click", () => openList("uip"));
    }

    const overlay = resultsShadow.querySelector(".overlay");
    if (overlay) {
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeResults();
      });
    }

    resultsKeydownHandler = (event) => {
      if (!resultsHost || !resultsShadow) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeResults();
        return;
      }
      if (event.key === "Tab") keepTabInside(event);
    };
    window.addEventListener("keydown", resultsKeydownHandler, true);
    renderRows();
    // A modal dialog takes focus as it opens; Close is where Variable Values
    // puts it too. It goes back to the opener on the way out.
    if (closeButton) closeButton.focus();
  };

  globalThis.SNCatalogInsightUI = { showResults };
})();

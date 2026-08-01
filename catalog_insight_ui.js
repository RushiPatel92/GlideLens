/*
 * Isolated-world UI for the "What affects this catalog item" command.
 * Loaded before content.js so the command-palette action can call the
 * public API. Read-only: lists the catalog client scripts and catalog UI
 * policies that target the current catalog item (and its variable sets),
 * each row a click-through to the platform record. Never runs or edits them.
 */

(() => {
  if (globalThis.SNCatalogInsightUI) return;

  let resultsHost = null;
  let resultsShadow = null;
  let resultsKeydownHandler = null;
  let lastResult = null;
  let activeFilter = "all";
  let searchQuery = "";
  let hideInactive = false;
  let groupByVariable = false;
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
      width:min(880px,calc(100vw - 32px));height:min(680px,calc(100vh - 40px));
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
    .subtitle{font-size:12px;color:#85859f;line-height:1.45}
    .close{
      border:0;background:transparent;color:#85859f;padding:3px 5px;
      font-size:12px;line-height:1;cursor:pointer;border-radius:5px;
    }
    .close:hover{color:#fff;background:#2d2d48}
    .summary{
      display:flex;gap:18px;align-items:center;padding:10px 20px;
      border-bottom:1px solid #292944;color:#aaaac1;font-size:11px;
    }
    .summary strong{color:#f0f0fa;font-size:13px;margin-right:4px}
    .summary .muted{color:#7d7d95}
    .summary .muted strong{color:#c6c6d8}
    .summary .chip-warn{
      color:#e0c187;background:#332c1b;border:1px solid #574a2c;
      border-radius:5px;padding:2px 8px;
    }
    .summary .chip-warn strong{color:#f0d79b}
    .warning{margin-left:auto;color:#d2b779}
    .focus-banner{
      display:flex;align-items:center;gap:10px;padding:9px 20px;font-size:12px;
      color:#cfeee9;border-bottom:1px solid #292944;
      background:color-mix(in srgb, var(--teal) 12%, #21283a);
    }
    .focus-banner .focus-what{color:#8f8fb0}
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
      background:linear-gradient(90deg, color-mix(in srgb, var(--teal) 20%, var(--band)), var(--band) 48%);
      box-shadow:inset 3px 0 0 var(--teal);
      border-top:1px solid color-mix(in srgb, var(--teal) 26%, #262640);
      position:sticky;top:0;z-index:1;user-select:none;
    }
    .group-head:hover{filter:brightness(1.08)}
    .group-caret{color:color-mix(in srgb, var(--teal) 55%, #9a9ab4);font-size:10px;width:10px;flex:none}
    .group-name{
      font:12px ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:600;
      color:color-mix(in srgb, var(--teal) 82%, white);white-space:nowrap;flex:none;
    }
    /* The onLoad/onSubmit/UI-policy bucket recedes on purpose. */
    .group.none{--teal:#6f6f90}
    .group.none .group-name{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .group-label{
      font-size:11px;color:#8585a0;min-width:0;cursor:pointer;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    .group-label.expanded{white-space:normal;overflow:visible;color:#b6b6d0}
    .group-label:hover{color:#c9c9e8}
    .group-count{
      margin-left:auto;flex:none;border-radius:10px;padding:1px 9px;font-size:11px;font-weight:600;
      background:color-mix(in srgb, var(--teal) 26%, var(--band));
      color:color-mix(in srgb, var(--teal) 55%, white);
      border:1px solid color-mix(in srgb, var(--teal) 34%, transparent);
    }
    .group-rows .row{padding-left:30px}
    .row{
      display:grid;grid-template-columns:1fr 168px 150px;gap:12px;
      align-items:center;padding:10px 18px;border-bottom:1px solid #292941;
      font-size:12px;color:#d7d7e8;cursor:pointer;
    }
    .row:hover{background:#26263e}
    .row.inactive{opacity:.55}
    .row.flagged{box-shadow:inset 3px 0 0 #a5842f}
    .row-name{min-width:0}
    .row-title{
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f0f0fa;
      display:flex;align-items:center;gap:7px;
    }
    .open-hint{color:#6f6f88;font-size:10px;flex:none}
    .row:hover .open-hint{color:color-mix(in srgb, var(--teal) 78%, white)}
    .row-bound{
      font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#85859f;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;
    }
    .row-cond{
      font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:#6f6f88;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;
    }
    .kindcell{display:flex;flex-direction:column;gap:4px;min-width:0}
    .badge{
      justify-self:start;padding:3px 7px;border-radius:4px;font-size:10px;
      white-space:nowrap;width:max-content;
      color:#aeb0d4;background:#2c2d4a;border:1px solid #3c3e62;
    }
    .badge.client{color:#a9d5ff;background:#24364a;border-color:#365573}
    .badge.uip{color:#e6c78f;background:#3a3320;border-color:#5c5031}
    .subtype{
      font-size:10px;color:#9898b2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .metacell{
      display:flex;flex-wrap:wrap;gap:5px;font-size:10px;color:#9898b2;align-items:center;
    }
    .tag{padding:2px 6px;border-radius:4px;background:#252539;border:1px solid #34344f;white-space:nowrap}
    .tag.off{color:#ff9d9d;background:#3a2530;border-color:#5c3a48}
    .tag.on{color:#b5e4c2;background:#263b35;border-color:#39594d}
    .tag.warn{color:#f0d79b;background:#3a3320;border-color:#5c5031;cursor:help}
    .empty{padding:48px 20px;text-align:center;color:#74748b;font-size:13px}
    .toolbar{
      display:flex;align-items:center;gap:8px;padding:11px 14px;flex-wrap:wrap;
      border-top:1px solid #2e2e4e;background:#1b1b2b;
    }
    .toolbar-note{font-size:11px;color:#67677e;flex:1;min-width:140px}
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
      .row{grid-template-columns:1fr;gap:5px;padding:10px 14px}
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
  };

  const allRows = () => (lastResult && lastResult.rows) || [];

  const rowSearchText = (row) =>
    [
      row.name,
      KIND_LABEL[row.kind],
      row.subtype,
      row.variableName,
      row.variableLabel,
      row.boundTo,
      row.conditions,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  // How the "Group by variable" view keys each row. onChange client scripts
  // watch a specific variable; everything else (onLoad/onSubmit, UI policies)
  // shares the "not variable-specific" bucket.
  const NO_VARIABLE = " none";
  const groupKeyOf = (row) =>
    row.kind === "client" && row.variable ? row.variableName || row.variable : NO_VARIABLE;

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
      return !searchQuery || rowSearchText(row).includes(searchQuery);
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
  // sets). Complements the per-row click-through.
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

  const viewTags = (row) => {
    const out = [];
    if (row.views && row.views.catalog) out.push("Catalog");
    if (row.views && row.views.task) out.push("Task");
    if (row.views && row.views.ritm) out.push("RITM");
    return out;
  };

  // "Why isn't this firing?" — evaluated against the catalog order form, the
  // runtime this panel is opened from. Returns null when nothing blocks it.
  const firingIssue = (row) => {
    if (!row.active) {
      return { short: "Inactive", detail: "Inactive — this never runs." };
    }
    if (row.views && !row.views.catalog) {
      const where = [];
      if (row.views.task) where.push("Task");
      if (row.views.ritm) where.push("RITM");
      const scope = where.length ? where.join(" / ") + " only" : "no catalog views";
      return {
        short: "Not on catalog form",
        detail: "Won't run while ordering this item — scoped to " + scope + ".",
      };
    }
    return null;
  };

  const buildRowEl = (row) => {
    const issue = firingIssue(row);
    const el = document.createElement("div");
    el.className =
      "row" + (row.active ? "" : " inactive") + (issue && row.active ? " flagged" : "");
    el.title = "Open the " + KIND_LABEL[row.kind].toLowerCase() + " record";

    // Name + bound-to + (policies) condition preview.
    const nameCell = document.createElement("div");
    nameCell.className = "row-name";
    const titleEl = document.createElement("div");
    titleEl.className = "row-title";
    const titleText = document.createElement("span");
    titleText.textContent = row.name || "(unnamed)";
    titleText.style.cssText =
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0";
    const openHint = document.createElement("span");
    openHint.className = "open-hint";
    openHint.textContent = "↗";
    titleEl.append(titleText, openHint);
    const boundEl = document.createElement("div");
    boundEl.className = "row-bound";
    boundEl.textContent = row.boundTo;
    boundEl.title = row.boundTo;
    nameCell.append(titleEl, boundEl);
    if (row.conditions) {
      const condEl = document.createElement("div");
      condEl.className = "row-cond";
      condEl.textContent = "if: " + row.conditions;
      condEl.title = row.conditions;
      nameCell.append(condEl);
    }
    // In the scoped view, spell out what this UI policy actually does to the
    // focused variable (hides / makes mandatory / sets value…).
    const focusActs = rowActionsForFocus(row);
    if (focusActs.length) {
      const eff = focusActs.map((a) => a.effect).filter(Boolean).join(" · ");
      if (eff) {
        const actEl = document.createElement("div");
        actEl.className = "row-cond";
        actEl.textContent = "→ " + eff;
        actEl.title = eff;
        nameCell.append(actEl);
      }
    }

    // Kind + subtype (onLoad/onChange… or "UI policy").
    const kindCell = document.createElement("div");
    kindCell.className = "kindcell";
    const kindBadge = document.createElement("span");
    kindBadge.className = "badge " + row.kind;
    kindBadge.textContent = KIND_LABEL[row.kind];
    kindCell.append(kindBadge);
    if (row.subtype) {
      const sub = document.createElement("span");
      sub.className = "subtype";
      const watched = row.kind === "client" ? row.variableName || row.variable : "";
      sub.textContent = row.subtype + (watched ? " · " + watched : "");
      sub.title = sub.textContent;
      kindCell.append(sub);
    }

    // Active + views + order.
    const metaCell = document.createElement("div");
    metaCell.className = "metacell";
    const activeTag = document.createElement("span");
    activeTag.className = "tag " + (row.active ? "on" : "off");
    activeTag.textContent = row.active ? "Active" : "Inactive";
    if (!row.active && issue) activeTag.title = issue.detail;
    metaCell.append(activeTag);
    viewTags(row).forEach((v) => {
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = v;
      metaCell.append(t);
    });
    // Active but blocked from this form (e.g. RITM-only): say why, at a glance.
    if (row.active && issue) {
      const warn = document.createElement("span");
      warn.className = "tag warn";
      warn.textContent = "⚠ " + issue.short;
      warn.title = issue.detail;
      metaCell.append(warn);
    }
    if (row.orderKnown) {
      const ord = document.createElement("span");
      ord.className = "tag";
      ord.textContent = "#" + row.order;
      metaCell.append(ord);
    }

    el.append(nameCell, kindCell, metaCell);
    el.addEventListener("click", () => openRecord(row));
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

  // "Group by variable": one section per watched variable, then a trailing
  // "Not variable-specific" bucket (onLoad/onSubmit + UI policies). Each header
  // is collapsible; the question label truncates but expands on click.
  const renderGrouped = (list, rows) => {
    const groups = new Map();
    rows.forEach((row) => {
      const key = groupKeyOf(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });

    const keys = Array.from(groups.keys())
      .filter((k) => k !== NO_VARIABLE)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (groups.has(NO_VARIABLE)) keys.push(NO_VARIABLE);

    keys.forEach((key) => {
      const groupRows = groups.get(key);
      const isNone = key === NO_VARIABLE;
      const sample = groupRows.find((r) => r.variableName || r.variableLabel) || groupRows[0];
      const collapsed = collapsedGroups.has(key);

      const group = document.createElement("div");
      group.className = "group" + (isNone ? " none" : "");

      const head = document.createElement("div");
      head.className = "group-head" + (collapsed ? " collapsed" : "");

      const caret = document.createElement("span");
      caret.className = "group-caret";
      caret.textContent = collapsed ? "▸" : "▾";
      head.append(caret);

      const nameEl = document.createElement("span");
      nameEl.className = "group-name";
      nameEl.textContent = isNone
        ? "Not variable-specific"
        : sample.variableName || sample.variable;
      head.append(nameEl);

      const label = !isNone && sample.variableLabel ? sample.variableLabel : "";
      if (label) {
        const labelEl = document.createElement("span");
        labelEl.className = "group-label";
        labelEl.textContent = label;
        labelEl.title = label + "  (click to expand)";
        labelEl.addEventListener("click", (event) => {
          event.stopPropagation();
          labelEl.classList.toggle("expanded");
        });
        head.append(labelEl);
      } else if (isNone) {
        const hint = document.createElement("span");
        hint.className = "group-label";
        hint.textContent = "onLoad / onSubmit / UI policies";
        head.append(hint);
      }

      const count = document.createElement("span");
      count.className = "group-count";
      count.textContent = String(groupRows.length);
      head.append(count);

      head.addEventListener("click", () => {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key);
        else collapsedGroups.add(key);
        renderRows();
      });
      group.append(head);

      if (!collapsed) {
        const body = document.createElement("div");
        body.className = "group-rows";
        groupRows.forEach((row) => body.appendChild(buildRowEl(row)));
        group.append(body);
      }
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

    if (groupByVariable) renderGrouped(list, rows);
    else renderFlat(list, rows);
  };

  const resultsAsText = () => {
    const rows = filteredRows();
    const lines = [
      "GlideLens — What affects this catalog item",
      "Read-only; catalog client scripts and UI policies targeting this item.",
      (lastResult && lastResult.itemName ? "Item: " + lastResult.itemName : ""),
      "Rows: " + rows.length + " of " + allRows().length,
      "",
    ].filter((line) => line !== "");
    rows.forEach((row) => {
      const watched = row.kind === "client" ? row.variableName || row.variable : "";
      const subtype = (row.subtype || "") + (watched ? " · " + watched : "");
      const bits = [
        KIND_LABEL[row.kind],
        subtype,
        row.name || "(unnamed)",
        row.boundTo,
        row.active ? "active" : "inactive",
      ].filter(Boolean);
      let line = bits.join(" — ");
      if (row.active && row.views && !row.views.catalog) line += " — won't run on catalog form";
      if (row.conditions) line += " — if: " + row.conditions;
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
    lastResult = result;
    activeFilter = "all";
    searchQuery = "";
    hideInactive = false;
    groupByVariable = false;
    focusVariable = result.focusVariable || null;
    collapsedGroups.clear();

    const rows = result.rows || [];
    const clientCount = rows.filter((r) => r.kind === "client").length;
    const uipCount = rows.filter((r) => r.kind === "uip").length;
    const inactiveCount = rows.filter((r) => !r.active).length;
    const notFiringCount = rows.filter(
      (r) => r.active && r.views && !r.views.catalog
    ).length;
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
              <h2 id="snh-catalog-insight-title">What affects this catalog item</h2>
              <div class="subtitle">Catalog client scripts and catalog UI policies bound to this item or its variable sets. Click a row to open the record. Read-only — nothing here runs or edits the logic.</div>
            </div>
            <button class="close" type="button">Close</button>
          </header>
          <div class="summary">
            <span><strong data-count="total">0</strong>total</span>
            <span><strong data-count="client">0</strong>client scripts</span>
            <span><strong data-count="uip">0</strong>UI policies</span>
            <span class="muted" data-count-wrap="inactive"><strong data-count="inactive">0</strong>inactive</span>
            <span class="chip-warn" data-count-wrap="notfiring" title="Active, but scoped to RITM/Task views — won't run while ordering this item."><strong data-count="notfiring">0</strong>won't run here</span>
            ${setsNote ? "<span>" + setsNote + "</span>" : ""}
            ${result.itemName ? '<span style="margin-left:auto;color:#8f8fb0">' + escapeHtml(result.itemName) + "</span>" : ""}
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
                '<button class="focus-clear" type="button" data-action="clear-focus">Show all ↗</button></div>'
              : ""
          }
          <div class="controls">
            <div class="filters" aria-label="Type filters">
              <button class="filter active" type="button" data-filter="all">All</button>
              <button class="filter" type="button" data-filter="client">Client scripts</button>
              <button class="filter" type="button" data-filter="uip">UI policies</button>
            </div>
            <button class="toggle" type="button" data-toggle="active" aria-pressed="false">
              <span class="dot"></span>Active only
            </button>
            <button class="toggle" type="button" data-toggle="group" aria-pressed="false">
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

    const groupToggle = resultsShadow.querySelector("[data-toggle='group']");
    if (groupToggle) {
      groupToggle.addEventListener("click", () => {
        groupByVariable = !groupByVariable;
        groupToggle.classList.toggle("active", groupByVariable);
        groupToggle.setAttribute("aria-pressed", groupByVariable ? "true" : "false");
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
        renderRows();
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
      if (event.key !== "Escape" || !resultsHost) return;
      event.preventDefault();
      event.stopPropagation();
      closeResults();
    };
    window.addEventListener("keydown", resultsKeydownHandler, true);
    renderRows();
  };

  globalThis.SNCatalogInsightUI = { showResults };
})();

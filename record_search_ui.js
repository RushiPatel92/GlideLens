/*
 * Isolated-world Record Search panel. Instance values are assigned with
 * textContent; only this file's static shell uses innerHTML.
 */
(() => {
  if (globalThis.SNRecordSearchUI) return;

  let host = null;
  let shadow = null;
  let keydownHandler = null;
  let onFindTables = null;
  let onResolveTable = null;
  let onSearch = null;
  let onCancel = null;
  let requestSequence = 0;
  let lookupSequence = 0;
  let lookupTimer = null;
  let tableOptions = [];
  let activeTableIndex = -1;
  let selectedTable = null;
  let tableInfo = null;
  let selectedFields = new Set();
  let lastResult = null;
  let searchBusy = false;

  const UI_CSS = `
    *{box-sizing:border-box}
    :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      --teal:#31d4c4;--pink:#ff6fae;--panel:#1e1e2e;--raised:#202038;
      --border:#3a3a5c;--text:#dedeee;--muted:#9292aa}
    button,input{font:inherit}
    .overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.52);
      display:flex;align-items:center;justify-content:center;padding:12px}
    .panel{width:min(920px,calc(100vw - 24px));height:min(760px,calc(100vh - 24px));
      display:flex;flex-direction:column;overflow:hidden;background:var(--panel);
      border:1px solid var(--border);border-radius:12px;box-shadow:0 28px 80px rgba(0,0,0,.65);
      color:var(--text)}
    .header{display:flex;align-items:flex-start;gap:14px;padding:18px 20px 14px;
      border-bottom:1px solid #2e2e4e}.heading{flex:1;min-width:0}
    h2{font-size:17px;line-height:1.2;margin:0 0 5px;color:#f5f5ff;font-weight:650}
    .subtitle{font-size:12px;color:var(--muted);line-height:1.45;margin:0}
    .close{border:0;background:transparent;color:var(--muted);padding:3px 5px;font-size:12px;
      cursor:pointer;border-radius:5px}.close:hover{color:#fff;background:#2d2d48}
    .form{padding:14px 20px;border-bottom:1px solid #292944;background:var(--raised)}
    .form-main{display:grid;grid-template-columns:minmax(240px,.9fr) minmax(280px,1.2fr) auto;
      gap:10px;align-items:end}
    label,.field-label{display:flex;flex-direction:column;gap:5px;color:#bdbdd0;
      font-size:11px;font-weight:600;min-width:0}
    input{width:100%;background:#151522;border:1px solid #555578;border-radius:7px;
      color:#f0f0fa;outline:none;padding:9px 10px;font-size:13px;font-weight:400}
    input:focus{border-color:var(--teal);background:#191929;box-shadow:0 0 0 3px rgba(49,212,196,.12)}
    input::placeholder{color:#797993}.combo{position:relative}
    .table-menu{position:absolute;left:0;right:0;top:calc(100% + 5px);z-index:5;
      max-height:270px;overflow:auto;background:#171724;border:1px solid #565681;
      border-radius:8px;box-shadow:0 16px 38px rgba(0,0,0,.55);padding:5px}
    .table-menu[hidden]{display:none}.table-option{display:grid;grid-template-columns:minmax(0,1fr);
      gap:3px;width:100%;padding:9px;border:1px solid transparent;border-radius:6px;
      background:transparent;color:#ececf7;text-align:left;cursor:pointer}
    .table-option:hover,.table-option.active{background:#2c2d49;border-color:#4d5079}
    .table-option.active{box-shadow:inset 3px 0 0 var(--teal)}
    .table-label{font-size:12px;font-weight:650;min-width:0;line-height:1.35;
      overflow-wrap:anywhere;white-space:normal}.table-name{min-width:0;color:#9494af;line-height:1.35;
      font:10px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;
      white-space:normal}
    .menu-message{padding:11px;color:#9999b1;font-size:11px;line-height:1.4}
    .search-btn,.toolbar button,.fields-button,.result-action{border:1px solid #5b5b86;
      background:#3f4067;color:#e6e6f5;border-radius:7px;padding:8px 13px;cursor:pointer;font-size:12px}
    .search-btn{background:var(--pink);border-color:var(--pink);color:#2a0d1a;
      font-weight:650;height:36px}.search-btn:hover{background:#ff85bb}
    button:disabled{opacity:.48;cursor:default}
    .field-line{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:center;
      margin-top:11px}.field-picker{position:relative}.fields-button{min-width:126px;text-align:left}
    .fields-button::after{content:"▾";float:right;margin-left:10px;color:#aaaac5}
    .field-menu{position:absolute;left:0;top:calc(100% + 5px);z-index:4;width:min(400px,80vw);
      max-height:300px;overflow:auto;background:#171724;border:1px solid #565681;
      border-radius:8px;box-shadow:0 16px 38px rgba(0,0,0,.55);padding:6px}
    .field-menu[hidden]{display:none}.field-option{display:grid;grid-template-columns:auto 1fr auto;
      align-items:center;gap:8px;padding:7px 8px;border-radius:5px;color:#d7d7e6;
      font-size:11px;font-weight:400;cursor:pointer}.field-option:hover{background:#292943}
    .field-option input{width:auto;margin:0;accent-color:var(--teal)}
    .field-tech{color:#8585a1;font:10px ui-monospace,SFMono-Regular,Consolas,monospace}
    .manual{color:#e1b678;font-size:9px}.field-summary{min-width:0;color:#9f9fb7;
      font-size:11px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .field-summary strong{color:#e4e4f1;font-weight:600}.selected-table{color:#8f8fa9}
    .status{min-height:40px;display:flex;align-items:center;gap:9px;padding:9px 20px;
      border-bottom:1px solid #292944;color:#aaaac1;font-size:11px}
    .status.validation{color:#efc48f}.status.empty{color:#c2c2d2}
    .status.access,.status.schema,.status.transient{color:#ef9b9b}
    .spinner{width:12px;height:12px;border-radius:50%;border:2px solid #45456b;
      border-top-color:var(--teal);animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){.spinner{animation:none}}
    .rows{flex:1;overflow:auto;padding:6px 0}.empty{padding:46px 20px;text-align:center;
      color:var(--muted);font-size:13px;line-height:1.5}.empty small{display:block;margin-top:7px;color:#74748d}
    .row{position:relative;padding:12px 20px;border-bottom:1px solid #282841;outline:none}
    .row:hover{background:#282842}.row:focus-visible{outline:2px solid var(--teal);outline-offset:-2px;
      background:#282842}.row-top{display:flex;align-items:baseline;gap:10px;margin-bottom:6px}
    .title{color:#f0f0fa;font-size:13px;font-weight:650;min-width:0;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap}.sys-id{margin-left:auto;color:#767690;
      font:10px ui-monospace,SFMono-Regular,Consolas,monospace}
    .values{display:flex;flex-wrap:wrap;gap:5px 12px;color:#aaaac1;font-size:11px;line-height:1.5}
    .value-label{color:#75758e}.row-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
    .result-action{padding:4px 8px;background:#30314f;font-size:10px}
    .result-action:hover{background:#45466e;color:#fff}
    .toolbar{display:flex;align-items:center;gap:8px;padding:11px 16px;border-top:1px solid #2e2e4e;
      background:#20203a}.toolbar-note{flex:1;color:#85859d;font-size:11px}
    .toolbar button:hover:not(:disabled){background:#4a4b78;color:#fff}
    @media(max-width:680px){.overlay{padding:8px}.panel{width:100%;height:calc(100vh - 16px)}
      .form-main{grid-template-columns:1fr}.search-btn{width:100%}.header{padding:14px}
      .field-line{grid-template-columns:1fr}.fields-button{width:100%}.sys-id{display:none}}
  `;

  function engine() { return globalThis.SNRecordSearch; }

  function setStatus(message, kind, loading) {
    if (!shadow) return;
    const status = shadow.querySelector(".status");
    status.textContent = "";
    status.className = "status" + (kind ? " " + kind : "");
    if (loading) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      spinner.setAttribute("aria-label", "Loading");
      status.appendChild(spinner);
    }
    const text = document.createElement("span");
    text.textContent = String(message || "");
    status.appendChild(text);
  }

  function errorKind(error) {
    const code = String(error && error.code || "");
    return ["validation", "access", "schema", "transient"].includes(code)
      ? code : "transient";
  }

  function renderEmpty(message, hint) {
    if (!shadow) return;
    const rows = shadow.querySelector(".rows");
    rows.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = message;
    if (hint) {
      const small = document.createElement("small");
      small.textContent = hint;
      empty.appendChild(small);
    }
    rows.appendChild(empty);
  }

  function setTableMenu(open) {
    if (!shadow) return;
    const menu = shadow.querySelector(".table-menu");
    const input = shadow.querySelector("[data-input='table']");
    menu.hidden = !open;
    input.setAttribute("aria-expanded", String(Boolean(open)));
    if (!open) input.removeAttribute("aria-activedescendant");
  }

  function renderTableOptions(message) {
    if (!shadow) return;
    const menu = shadow.querySelector(".table-menu");
    menu.textContent = "";
    if (message || !tableOptions.length) {
      const note = document.createElement("div");
      note.className = "menu-message";
      note.textContent = message || "No matching readable tables.";
      menu.appendChild(note);
      setTableMenu(true);
      return;
    }
    tableOptions.forEach((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.id = "snh-rs-table-option-" + index;
      button.className = "table-option" + (index === activeTableIndex ? " active" : "");
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === activeTableIndex));
      const label = document.createElement("span");
      label.className = "table-label";
      label.textContent = option.label || option.name;
      const name = document.createElement("span");
      name.className = "table-name";
      name.textContent = option.name;
      button.appendChild(label);
      button.appendChild(name);
      button.addEventListener("mouseenter", () => setActiveTable(index));
      button.addEventListener("click", () => selectTable(option));
      menu.appendChild(button);
    });
    setTableMenu(true);
  }

  function setActiveTable(index) {
    if (!shadow || !tableOptions.length) return;
    activeTableIndex = (index + tableOptions.length) % tableOptions.length;
    shadow.querySelectorAll(".table-option").forEach((option, optionIndex) => {
      const active = optionIndex === activeTableIndex;
      option.classList.toggle("active", active);
      option.setAttribute("aria-selected", String(active));
      if (active) option.scrollIntoView({ block: "nearest" });
    });
    const input = shadow.querySelector("[data-input='table']");
    input.setAttribute("aria-activedescendant", "snh-rs-table-option-" + activeTableIndex);
  }

  function clearTableSelection() {
    requestSequence += 1;
    selectedTable = null;
    tableInfo = null;
    selectedFields = new Set();
    lastResult = null;
    renderFieldControl();
    updateListButton();
  }

  async function lookupTables() {
    if (!shadow || !onFindTables) return;
    const input = shadow.querySelector("[data-input='table']");
    const value = input.value.trim();
    const sequence = ++lookupSequence;
    if (!engine().extractTableLookupAnchor(value)) {
      tableOptions = [];
      activeTableIndex = -1;
      renderTableOptions("Type at least two letters, numbers, or underscores.");
      setStatus("Type at least two characters to find a table.", "validation", false);
      return;
    }
    renderTableOptions("Finding matching tables…");
    try {
      const options = await onFindTables(value);
      if (!shadow || sequence !== lookupSequence) return;
      tableOptions = Array.isArray(options) ? options : [];
      activeTableIndex = tableOptions.length ? 0 : -1;
      renderTableOptions();
      setStatus(
        tableOptions.length
          ? (tableOptions.truncated ? "Showing " : "") + tableOptions.length +
            (tableOptions.length === 1 ? " matching table" : " matching tables") +
            (tableOptions.truncated ? " · type more to narrow, or choose one." : " · choose one.")
          : "No matching readable tables were found.",
        tableOptions.length ? "" : "empty",
        false
      );
    } catch (error) {
      if (!shadow || sequence !== lookupSequence) return;
      tableOptions = [];
      activeTableIndex = -1;
      renderTableOptions(String(error && error.message || error));
      setStatus(String(error && error.message || error), errorKind(error), false);
    }
  }

  function scheduleTableLookup() {
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(lookupTables, 180);
  }

  async function selectTable(option, detected) {
    if (!shadow || !option || !option.name || !onResolveTable) return;
    lookupSequence += 1;
    selectedTable = { name: option.name, label: option.label || option.name };
    tableInfo = null;
    selectedFields = new Set();
    lastResult = null;
    shadow.querySelector("[data-input='table']").value = option.name;
    setTableMenu(false);
    renderFieldControl();
    updateListButton();
    const sequence = ++requestSequence;
    setStatus(
      (detected ? "Detected " : "Checking ") + option.name + " and reading its live dictionary…",
      "",
      true
    );
    try {
      const info = await onResolveTable(option.name);
      if (!shadow || sequence !== requestSequence || !info) return;
      tableInfo = info;
      selectedTable = { name: info.table, label: info.label || info.table };
      selectedFields = new Set((info.defaultFields || []).map((field) => field.name));
      renderFieldControl();
      if (!info.fields || !info.fields.length) {
        setStatus(
          "The table is readable, but no searchable text fields were verified. Exact sys_id lookup can still run.",
          "schema",
          false
        );
      } else {
        setStatus(
          "Ready · " + selectedTable.label + " (" + selectedTable.name + ") · " +
            selectedFields.size + (selectedFields.size === 1 ? " field selected" : " fields selected"),
          "",
          false
        );
      }
      shadow.querySelector("[data-input='term']").focus();
    } catch (error) {
      if (!shadow || sequence !== requestSequence) return;
      tableInfo = null;
      selectedFields = new Set();
      renderFieldControl();
      setStatus(String(error && error.message || error), errorKind(error), false);
      renderEmpty("The table could not be prepared.", String(error && error.message || error));
    }
  }

  function setFieldMenu(open) {
    if (!shadow) return;
    const button = shadow.querySelector(".fields-button");
    const menu = shadow.querySelector(".field-menu");
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(Boolean(open)));
  }

  function updateFieldSummary() {
    if (!shadow) return;
    const summary = shadow.querySelector(".field-summary");
    const button = shadow.querySelector(".fields-button");
    const fields = tableInfo && Array.isArray(tableInfo.fields) ? tableInfo.fields : [];
    const chosen = fields.filter((field) => selectedFields.has(field.name));
    button.disabled = searchBusy || !fields.length;
    button.textContent = chosen.length + (chosen.length === 1 ? " field" : " fields");
    summary.textContent = "";
    if (!selectedTable) {
      summary.textContent = "Choose a table to load verified fields.";
      return;
    }
    const table = document.createElement("span");
    table.className = "selected-table";
    table.textContent = (selectedTable.label || selectedTable.name) + " (" + selectedTable.name + ") · ";
    const fieldsText = document.createElement("strong");
    fieldsText.textContent = chosen.length
      ? "Searching: " + chosen.map((field) => field.label + " [" + field.name + "]").join(", ")
      : "No fields selected";
    summary.appendChild(table);
    summary.appendChild(fieldsText);
  }

  function renderFieldControl() {
    if (!shadow) return;
    const menu = shadow.querySelector(".field-menu");
    menu.textContent = "";
    const fields = tableInfo && Array.isArray(tableInfo.fields) ? tableInfo.fields : [];
    if (!fields.length) {
      const note = document.createElement("div");
      note.className = "menu-message";
      note.textContent = selectedTable ? "No verified text fields available." : "Choose a table first.";
      menu.appendChild(note);
      setFieldMenu(false);
      updateFieldSummary();
      return;
    }
    fields.forEach((field) => {
      const label = document.createElement("label");
      label.className = "field-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedFields.has(field.name);
      checkbox.disabled = searchBusy;
      checkbox.dataset.field = field.name;
      const title = document.createElement("span");
      title.textContent = field.label || field.name;
      const tech = document.createElement("span");
      tech.className = "field-tech";
      tech.textContent = field.name;
      label.appendChild(checkbox);
      label.appendChild(title);
      label.appendChild(tech);
      if (!field.autoSelectable) {
        const manual = document.createElement("span");
        manual.className = "manual";
        manual.textContent = "manual only";
        title.appendChild(document.createTextNode(" "));
        title.appendChild(manual);
      }
      checkbox.addEventListener("change", () => {
        if (checkbox.checked && selectedFields.size >= engine().MAX_SEARCH_FIELDS) {
          checkbox.checked = false;
          setStatus("Select no more than six fields.", "validation", false);
          return;
        }
        if (checkbox.checked) selectedFields.add(field.name);
        else selectedFields.delete(field.name);
        lastResult = null;
        updateFieldSummary();
        updateListButton();
      });
      menu.appendChild(label);
    });
    updateFieldSummary();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw error;
    }
  }

  function resultUrl(result) {
    return engine().buildRecordUrl(location.origin, result);
  }

  function openRecord(result) {
    try {
      chrome.runtime.sendMessage({ type: "OPEN_URL", url: resultUrl(result) });
    } catch (error) {
      setStatus(String(error && error.message || error), "validation", false);
    }
  }

  async function copyResult(value, label) {
    try {
      await copyText(value);
      setStatus(label + " copied to the clipboard.", "", false);
    } catch (error) {
      setStatus("Clipboard access was blocked. Try again from the active page.", "access", false);
    }
  }

  function resultRows() {
    return shadow ? Array.from(shadow.querySelectorAll(".row")) : [];
  }

  function moveResultFocus(current, direction) {
    const rows = resultRows();
    const index = rows.indexOf(current);
    if (!rows.length || index < 0) return;
    const next = direction === "home" ? 0 : direction === "end" ? rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, index + direction));
    rows[next].focus();
    rows[next].scrollIntoView({ block: "nearest" });
  }

  function addResultAction(container, label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-action";
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      action();
    });
    container.appendChild(button);
  }

  function updateListButton() {
    if (!shadow) return;
    const button = shadow.querySelector("[data-action='open-list']");
    const count = lastResult && Array.isArray(lastResult.results) ? lastResult.results.length : 0;
    button.disabled = !count;
    button.textContent = count ? "Open " + count + " in list" : "Open results in list";
  }

  function setSearchBusy(busy) {
    if (!shadow) return;
    searchBusy = Boolean(busy);
    shadow.querySelectorAll("[data-input]").forEach((input) => {
      input.disabled = searchBusy;
    });
    shadow.querySelector(".search-btn").disabled = searchBusy;
    shadow.querySelectorAll(".field-option input").forEach((input) => {
      input.disabled = searchBusy;
    });
    updateFieldSummary();
  }

  function renderResults(result) {
    if (!shadow || !result) return;
    lastResult = result;
    updateListButton();
    const rows = shadow.querySelector(".rows");
    rows.textContent = "";
    const results = Array.isArray(result.results) ? result.results : [];
    const suffix = result.truncated ? " · showing the first 20 verified matches" : "";
    const sortSuffix = result.sortLabel ? " · sorted by " + result.sortLabel : "";
    setStatus(
      results.length + (results.length === 1 ? " verified record" : " verified records") +
        " in " + (result.tableLabel || result.table) + sortSuffix + suffix,
      results.length ? "" : "empty",
      false
    );
    if (!results.length) {
      renderEmpty(
        "No verified matches in the selected fields.",
        "Try another term, select different verified fields, or use an exact sys_id."
      );
      return;
    }

    results.forEach((resultRow, index) => {
      const row = document.createElement("div");
      row.className = "row";
      row.tabIndex = 0;
      row.setAttribute("role", "group");
      row.setAttribute(
        "aria-label",
        (resultRow.title || resultRow.sysId) + " result. Press Enter to open."
      );
      row.dataset.index = String(index);
      row.addEventListener("click", (event) => {
        if (!event.target.closest("button")) openRecord(resultRow);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          moveResultFocus(row, event.key === "ArrowDown" ? 1 : -1);
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          moveResultFocus(row, event.key.toLowerCase());
        } else if ((event.key === "Enter" || event.key === " ") && event.target === row) {
          event.preventDefault();
          openRecord(resultRow);
        }
      });

      const top = document.createElement("div");
      top.className = "row-top";
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = resultRow.title || resultRow.sysId;
      const sysId = document.createElement("span");
      sysId.className = "sys-id";
      sysId.textContent = resultRow.sysId;
      top.appendChild(title);
      top.appendChild(sysId);
      row.appendChild(top);

      const values = document.createElement("div");
      values.className = "values";
      (resultRow.values || []).forEach((item, valueIndex) => {
        if (!item.value || (valueIndex === 0 && item.value === resultRow.title)) return;
        const value = document.createElement("span");
        const valueLabel = document.createElement("span");
        valueLabel.className = "value-label";
        valueLabel.textContent = (item.label || item.field) + ": ";
        value.appendChild(valueLabel);
        value.appendChild(document.createTextNode(item.value));
        values.appendChild(value);
      });
      if (values.childNodes.length) row.appendChild(values);

      const actions = document.createElement("div");
      actions.className = "row-actions";
      addResultAction(actions, "Open record", () => openRecord(resultRow));
      addResultAction(actions, "Copy sys_id", () => copyResult(resultRow.sysId, "sys_id"));
      addResultAction(actions, "Copy URL", () => copyResult(resultUrl(resultRow), "Record URL"));
      row.appendChild(actions);
      rows.appendChild(row);
    });
  }

  async function submit() {
    if (!shadow || !onSearch) return;
    const termInput = shadow.querySelector("[data-input='term']");
    if (!selectedTable || !tableInfo) {
      setStatus("Choose a verified table before searching.", "validation", false);
      return;
    }
    const term = termInput.value.trim();
    const isSysId = /^[0-9a-f]{32}$/i.test(term);
    if (!isSysId && !selectedFields.size) {
      setStatus("Select at least one verified field for a text search.", "validation", false);
      return;
    }
    const sequence = ++requestSequence;
    setSearchBusy(true);
    lastResult = null;
    updateListButton();
    setStatus("Searching the selected verified fields and checking every returned match…", "", true);
    renderEmpty("Searching…", "Results are read-only and stay in this panel.");
    try {
      const result = await onSearch({
        table: selectedTable.name,
        term,
        fields: Array.from(selectedFields),
      });
      if (sequence !== requestSequence || !result || result.stale) return;
      renderResults(result);
    } catch (error) {
      if (sequence !== requestSequence) return;
      const message = String(error && error.message ? error.message : error);
      setStatus(message, errorKind(error), false);
      renderEmpty("The search could not run.", message);
    } finally {
      if (sequence === requestSequence && shadow) setSearchBusy(false);
    }
  }

  function openResultList() {
    if (!lastResult) return;
    try {
      const url = engine().buildResultListUrl(location.origin, lastResult);
      chrome.runtime.sendMessage({ type: "OPEN_URL", url });
    } catch (error) {
      setStatus(String(error && error.message || error), "validation", false);
    }
  }

  function close() {
    requestSequence += 1;
    lookupSequence += 1;
    clearTimeout(lookupTimer);
    if (onCancel) onCancel();
    if (keydownHandler) window.removeEventListener("keydown", keydownHandler, true);
    if (host) host.remove();
    host = null;
    shadow = null;
    keydownHandler = null;
    onFindTables = null;
    onResolveTable = null;
    onSearch = null;
    onCancel = null;
    tableOptions = [];
    activeTableIndex = -1;
    selectedTable = null;
    tableInfo = null;
    selectedFields = new Set();
    lastResult = null;
    searchBusy = false;
  }

  function open(options) {
    close();
    const opts = options || {};
    onFindTables = opts.onFindTables || null;
    onResolveTable = opts.onResolveTable || null;
    onSearch = opts.onSearch || null;
    onCancel = opts.onCancel || null;
    host = document.createElement("div");
    host.id = "sn-dev-helper-record-search";
    /* Closed, like every other GlideLens panel: an open root lets page
     * script read and rewrite results that came from the Table API. */
    shadow = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);
    shadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="overlay">
        <section class="panel" role="dialog" aria-modal="true" aria-label="Record search">
          <header class="header">
            <div class="heading">
              <h2>Record Lens</h2>
              <p class="subtitle">Choose a verified table and fields. GlideLens reads only bounded summaries and opens results in ServiceNow.</p>
            </div>
            <button class="close" type="button" aria-label="Close">✕ Esc</button>
          </header>
          <form class="form">
            <div class="form-main">
              <label>Table
                <span class="combo">
                  <input data-input="table" role="combobox" aria-autocomplete="list"
                    aria-controls="snh-rs-table-menu" aria-expanded="false"
                    placeholder="Search table label or name" autocomplete="off" spellcheck="false">
                  <span class="table-menu" id="snh-rs-table-menu" role="listbox" hidden></span>
                </span>
              </label>
              <label>Text or sys_id
                <input data-input="term" placeholder="number, name, email, or exact sys_id"
                  autocomplete="off" spellcheck="false">
              </label>
              <button class="search-btn" type="submit">Search</button>
            </div>
            <div class="field-line">
              <div class="field-picker">
                <button class="fields-button" type="button" aria-haspopup="listbox"
                  aria-expanded="false" disabled>0 fields</button>
                <div class="field-menu" role="listbox" aria-multiselectable="true" hidden></div>
              </div>
              <div class="field-summary">Choose a table to load verified fields.</div>
            </div>
          </form>
          <div class="status" role="status" aria-live="polite">Search for a table to begin.</div>
          <div class="rows"></div>
          <footer class="toolbar">
            <span class="toolbar-note">Read-only · at most 20 verified results · no record or search history is stored</span>
            <button type="button" data-action="open-list" disabled>Open results in list</button>
            <button type="button" data-action="close">Close</button>
          </footer>
        </section>
      </div>`;

    renderFieldControl();
    renderEmpty(
      "Find a record without loading a full table list.",
      "Type two characters to query a bounded set of matching table labels and names."
    );
    const tableInput = shadow.querySelector("[data-input='table']");
    tableInput.addEventListener("input", () => {
      if (!selectedTable || tableInput.value.trim() !== selectedTable.name) {
        clearTableSelection();
      }
      scheduleTableLookup();
    });
    tableInput.addEventListener("focus", () => {
      if (tableOptions.length) setTableMenu(true);
      else if (tableInput.value.trim()) scheduleTableLookup();
    });
    tableInput.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (shadow.querySelector(".table-menu").hidden) {
          if (tableOptions.length) setTableMenu(true);
          else lookupTables();
        }
        if (tableOptions.length) {
          setActiveTable(activeTableIndex + (event.key === "ArrowDown" ? 1 : -1));
        }
      } else if (event.key === "Enter" && !shadow.querySelector(".table-menu").hidden &&
        activeTableIndex >= 0) {
        event.preventDefault();
        selectTable(tableOptions[activeTableIndex]);
      } else if ((event.key === "Home" || event.key === "End") &&
        !shadow.querySelector(".table-menu").hidden && tableOptions.length) {
        event.preventDefault();
        setActiveTable(event.key === "Home" ? 0 : tableOptions.length - 1);
      } else if (event.key === "Escape" && !shadow.querySelector(".table-menu").hidden) {
        event.preventDefault();
        event.stopPropagation();
        setTableMenu(false);
      }
    });
    shadow.querySelector(".fields-button").addEventListener("click", () => {
      const menu = shadow.querySelector(".field-menu");
      setFieldMenu(menu.hidden);
    });
    shadow.querySelector(".form").addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });
    shadow.querySelector(".close").addEventListener("click", close);
    shadow.querySelector("[data-action='close']").addEventListener("click", close);
    shadow.querySelector("[data-action='open-list']").addEventListener("click", openResultList);
    shadow.addEventListener("click", (event) => {
      if (!event.target.closest(".combo")) setTableMenu(false);
      if (!event.target.closest(".field-picker")) setFieldMenu(false);
    });
    const overlay = shadow.querySelector(".overlay");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    keydownHandler = (event) => {
      if (event.key !== "Escape" || !host) return;
      const tableMenuOpen = !shadow.querySelector(".table-menu").hidden;
      const fieldMenuOpen = !shadow.querySelector(".field-menu").hidden;
      if (tableMenuOpen || fieldMenuOpen) {
        setTableMenu(false);
        setFieldMenu(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", keydownHandler, true);
    if (opts.initialTable && /^[a-z][a-z0-9_]*$/.test(opts.initialTable)) {
      tableInput.value = opts.initialTable;
      selectTable({ name: opts.initialTable, label: opts.initialTable }, true);
    } else {
      tableInput.focus();
    }
  }

  globalThis.SNRecordSearchUI = {
    open,
    close,
    isOpen: () => Boolean(host),
  };
})();

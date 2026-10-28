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
  let onFavoriteOp = null;
  let favorites = [];
  let favoriteBusy = false;
  let tableError = false;
  /* Favourites whose remembered fields could not be verified when opened.
   * Saving their fields this session could persist a passing failure as a
   * loss, so nothing is saved for them until the panel is reopened. */
  let unsavedFavorites = new Set();
  /* The same rule for a favourite's remembered filter fields, and for its
   * shown columns. */
  let unsavedFilterFavorites = new Set();
  let unsavedColumnFavorites = new Set();
  let onFilterFields = null;
  let onFilterValues = null;
  /* Each row is { id, field, value, remove, node }. Ids only ever increase,
   * so a removed row's combobox ids are never reused by a new one. */
  let filterRows = [];
  let filterRowSequence = 0;
  const combos = {};
  /* Which table is selected, as opposed to requestSequence, which a search
   * also moves. A favourite's filter restore is bound to this. */
  let selectionSequence = 0;
  /* The table whose remembered filter rows are still being restored, and
   * whether a filter save was asked for meanwhile. */
  let filterRestorePending = "";
  let filterSaveDeferred = false;
  let requestSequence = 0;
  let lookupSequence = 0;
  let lookupTimer = null;
  let tableOptions = [];
  let activeTableIndex = -1;
  let selectedTable = null;
  let tableInfo = null;
  let selectedFields = new Set();
  /* The fields each result row shows, in the order they were ticked: the
   * first is the row's title. Decoupled from selectedFields, which are only
   * what text is matched against. */
  let selectedColumns = [];
  let lastResult = null;
  let searchBusy = false;
  /* As in Impersonate, a pause in typing, a filter value or a field change
   * asks the controls' question once it differs from the one last asked. */
  const AUTO_SEARCH_DELAY_MS = 500;
  let searchTimer = null;
  let lastRequestKey = "";
  /* Whether the results area shows the table's ready state, not an answer. */
  let atReady = true;
  let searchesInFlight = 0;
  let searchQueued = false;
  let searchFocus = null;
  let quietFocus = false;

  /* [hidden] is restated first and wins: the user-agent rule loses to any
   * author `display`, and the filter area is display:flex. */
  const UI_CSS = `
    [hidden]{display:none!important}
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
    .table-star{color:var(--pink);margin-right:5px}
    .table-tag{display:inline-block;margin-left:6px;padding:0 5px;border:1px solid #6d5b34;
      border-radius:4px;color:#e2b864;font-size:10px;font-weight:600;line-height:1.5}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
      clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .search-btn,.toolbar button,.fields-button,.columns-button,.star-btn,.result-action{border:1px solid #5b5b86;
      background:#3f4067;color:#e6e6f5;border-radius:7px;padding:8px 13px;cursor:pointer;font-size:12px}
    .search-btn{background:var(--pink);border-color:var(--pink);color:#2a0d1a;
      font-weight:650;height:36px}.search-btn:hover{background:#ff85bb}
    button:disabled{opacity:.48;cursor:default}
    .field-line{display:grid;grid-template-columns:auto auto auto minmax(0,1fr);gap:10px;align-items:center;
      margin-top:11px}.field-picker{position:relative}
    .fields-button,.columns-button{min-width:126px;text-align:left}
    .field-line .field-summary{grid-column:4}
    .star-btn{white-space:nowrap}.star-btn[aria-pressed="true"]{background:#4a2338;
      border-color:var(--pink);color:#ffd6e8}.star-btn[aria-pressed="true"] .star-glyph{color:var(--pink)}
    .star-btn:hover:not(:disabled){background:#4a4b78;color:#fff}
    .filters{display:flex;flex-direction:column;gap:8px;margin-top:11px}
    .filter-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) auto;gap:10px;
      align-items:end}
    .fcombo{position:relative;display:block}.fcombo input{padding-right:34px}
    input:disabled{opacity:.5}
    .combo-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;
      background:transparent;color:var(--muted);padding:4px 7px;border-radius:5px;font-size:12px;
      line-height:1;cursor:pointer}
    .combo-clear:hover:not(:disabled),.combo-clear:focus-visible{color:#fff;background:#2d2d48;outline:none}
    .clearable{position:relative;display:block}.combo input,.clearable input{padding-right:34px}
    .menu{position:absolute;left:0;right:0;top:calc(100% + 5px);z-index:6;max-height:270px;
      overflow:auto;background:#171724;border:1px solid #565681;border-radius:8px;
      box-shadow:0 16px 38px rgba(0,0,0,.55);padding:5px}
    .option{display:grid;grid-template-columns:minmax(0,1fr);gap:3px;width:100%;padding:9px;
      border:1px solid transparent;border-radius:6px;background:transparent;color:#ececf7;
      text-align:left;cursor:pointer}
    .option:hover,.option.active{background:#2c2d49;border-color:#4d5079}
    .option.active{box-shadow:inset 3px 0 0 var(--teal)}
    .option-label{font-size:12px;font-weight:650;line-height:1.35;overflow-wrap:anywhere}
    .option-hint{color:#9494af;line-height:1.35;
      font:10px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
    .filter-remove{border:1px solid #5b5b86;background:#30314f;color:#e6e6f5;border-radius:7px;
      padding:8px 11px;cursor:pointer;font-size:12px;height:36px}
    .filter-remove:hover:not(:disabled){background:#45466e;color:#fff}
    .add-filter{align-self:flex-start;border:1px dashed #5b5b86;background:transparent;color:#cfcfe6;
      border-radius:7px;padding:6px 11px;cursor:pointer;font-size:11px}
    .add-filter:hover:not(:disabled){background:#2d2d48;color:#fff}
    .fields-button::after,.columns-button::after{content:"▾";float:right;margin-left:10px;color:#aaaac5}
    .field-menu,.column-menu{position:absolute;left:0;top:calc(100% + 5px);z-index:4;
      width:min(600px,calc(100vw - 260px));max-height:max(160px,min(380px,calc(100vh - 230px)));
      display:flex;flex-direction:column;
      overflow:hidden;background:#171724;border:1px solid #565681;
      border-radius:8px;box-shadow:0 16px 38px rgba(0,0,0,.55);padding:6px}
    .field-menu[hidden],.column-menu[hidden]{display:none}
    .picker-find{flex:none;margin-bottom:4px;padding:7px 9px;font-size:12px}
    .picker-list{overflow:auto;min-height:0}
    .picker-heading{padding:6px 8px 3px;color:#8f8fa9;font-size:9px;font-weight:650;
      letter-spacing:.06em;text-transform:uppercase}
    .picker-heading.rest{margin-top:4px;padding-top:8px;border-top:1px solid #2e2e4e}
    .picker-none:empty{display:none}
    .field-option,.column-option{display:grid;grid-template-columns:auto 1fr auto;
      align-items:center;gap:8px;padding:7px 8px;border-radius:5px;color:#d7d7e6;
      font-size:11px;font-weight:400;cursor:pointer}
    .field-option:hover,.column-option:hover{background:#292943}
    .field-option input,.column-option input{width:auto;margin:0;accent-color:var(--teal)}
    .menu-note{padding:4px 8px 7px;color:#8f8fa9;font-size:10px;line-height:1.4}
    .kind{color:#8fb8e8;font-size:9px}
    .order{display:inline-block;min-width:16px;margin-right:6px;padding:0 4px;border-radius:8px;
      background:#173d3a;color:#c4f7f1;font-size:9px;font-weight:650;text-align:center}
    .value.matched .value-label{color:#6fb3ab}.match-tag{margin-left:5px;padding:0 4px;
      border:1px solid #2f6f68;border-radius:4px;color:#8fe0d6;font-size:9px}
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
    .result-action.copied{background:#173d3a;border-color:var(--teal);color:#c4f7f1;font-weight:650}
    .result-action.copy-failed{background:#4a2330;border-color:#ef9b9b;color:#ffd9d9;font-weight:650}
    .toolbar{display:flex;align-items:center;gap:8px;padding:11px 16px;border-top:1px solid #2e2e4e;
      background:#20203a}.toolbar-note{flex:1;color:#85859d;font-size:11px}
    .toolbar button:hover:not(:disabled){background:#4a4b78;color:#fff}
    @media(max-width:680px){.overlay{padding:8px}.panel{width:100%;height:calc(100vh - 16px)}
      .form-main{grid-template-columns:1fr}.search-btn{width:100%}.header{padding:14px}
      .field-line{grid-template-columns:1fr}.field-line .field-summary{grid-column:auto}
      .filter-row{grid-template-columns:1fr}
      .fields-button,.columns-button,.star-btn{width:100%}.sys-id{display:none}
      .field-menu,.column-menu{width:calc(100vw - 56px);max-height:max(160px,calc(100vh - 340px))}}
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

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function setHidden(node, hidden) {
    if (!node) return;
    node.hidden = Boolean(hidden);
    if (hidden) node.setAttribute("hidden", "hidden");
    else node.removeAttribute("hidden");
  }

  function setDisabled(node, disabled) {
    if (!node) return;
    node.disabled = Boolean(disabled);
    if (disabled) node.setAttribute("disabled", "disabled");
    else node.removeAttribute("disabled");
  }

  function errorMessage(error) {
    return String(error && error.message ? error.message : error);
  }

  /* ------------------------------------------------------------------ *
   * Filter comboboxes
   * ------------------------------------------------------------------ */

  /*
   * Copied from impersonate_ui.js, not shared: FEATURE-BLUEPRINT.md §13.4
   * allows a shared panel base only once two new panels prove its API. Each
   * instance registers under its own key and leaving compares against that
   * key, so every filter row gives its two pickers unique ids and keys.
   * As in Impersonate, picking or clearing a value searches at once, and
   * picking a field opens its values instead.
   */
  function createCombo(config) {
    const state = {
      options: [],
      /* Held apart from menu.children: a trailing note is a child too and
       * must never be reachable as an option. */
      optionNodes: [],
      activeIndex: -1,
      selected: null,
      /* Set once typing unbinds a choice, until a pick or a clear. */
      dropped: false,
      open: false,
      sequence: 0,
      timer: null,
      leaveTimer: null,
      disabled: false,
      /* A precondition of the control's own -- the value picker before a
       * field is chosen -- that a search finishing must not release. */
      blocked: false,
      blockedReason: "",
      quietFocus: false,
    };
    const wrap = el("label", null);
    const labelNode = el("span", null, config.label);
    wrap.appendChild(labelNode);
    const combo = el("span", "fcombo");
    const clearButton = el("button", "combo-clear", "✕");
    clearButton.setAttribute("type", "button");
    clearButton.setAttribute("aria-label", "Clear " + (config.clearLabel || config.label));
    setHidden(clearButton, true);
    const input = el("input");
    input.id = config.id;
    input.setAttribute("type", "text");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", config.id + "-menu");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("placeholder", config.placeholder || "");
    const menu = el("span", "menu");
    menu.id = config.id + "-menu";
    menu.setAttribute("role", "listbox");
    setHidden(menu, true);
    /* A press anywhere in the list keeps focus in the input. */
    menu.addEventListener("mousedown", (event) => {
      if (event && event.preventDefault) event.preventDefault();
    });
    combo.appendChild(input);
    combo.appendChild(clearButton);
    combo.appendChild(menu);
    wrap.appendChild(combo);

    function refreshClear() {
      setHidden(clearButton, state.blocked || !input.value);
      setDisabled(clearButton, state.disabled);
    }

    function focusQuietly() {
      state.quietFocus = true;
      try { input.focus(); } finally { state.quietFocus = false; }
    }

    function setOpen(open) {
      state.open = Boolean(open) && !state.disabled;
      setHidden(menu, !state.open);
      input.setAttribute("aria-expanded", String(state.open));
      if (!state.open) input.removeAttribute("aria-activedescendant");
    }

    function optionId(index) {
      return config.id + "-option-" + index;
    }

    function setActive(index) {
      if (!state.options.length) {
        state.activeIndex = -1;
        return;
      }
      state.activeIndex = (index + state.options.length) % state.options.length;
      state.optionNodes.forEach((node, nodeIndex) => {
        const active = nodeIndex === state.activeIndex;
        node.className = "option" + (active ? " active" : "");
        node.setAttribute("aria-selected", String(active));
        if (active && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
      });
      input.setAttribute("aria-activedescendant", optionId(state.activeIndex));
    }

    function renderOptions(message) {
      menu.textContent = "";
      state.optionNodes = [];
      if (message || !state.options.length) {
        state.options = message ? [] : state.options;
        state.activeIndex = -1;
        menu.appendChild(el("span", "menu-message", message || config.emptyMessage || "No matches."));
        setOpen(true);
        return;
      }
      state.options.forEach((option, index) => {
        const button = el("button", "option");
        button.setAttribute("type", "button");
        button.id = optionId(index);
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", "false");
        button.appendChild(el("span", "option-label", option.label));
        if (option.hint) button.appendChild(el("span", "option-hint", option.hint));
        button.addEventListener("mouseenter", () => setActive(index));
        button.addEventListener("mousedown", (event) => {
          if (event && event.preventDefault) event.preventDefault();
        });
        button.addEventListener("click", (event) => {
          if (event && event.preventDefault) event.preventDefault();
          select(option);
        });
        state.optionNodes.push(button);
        menu.appendChild(button);
      });
      setActive(0);
      setOpen(true);
    }

    /* onSelect(option, how): "pick" and "clear" are finished choices; "edit"
     * is the first keystroke that stops the text naming the bound option. */
    function select(option) {
      state.selected = option || null;
      state.dropped = false;
      input.value = option ? option.label : "";
      setOpen(false);
      refreshClear();
      if (config.onSelect) config.onSelect(option || null, option ? "pick" : "clear");
    }

    function clearSelection(silent) {
      state.selected = null;
      state.dropped = false;
      state.options = [];
      state.optionNodes = [];
      state.activeIndex = -1;
      input.value = "";
      menu.textContent = "";
      setOpen(false);
      refreshClear();
      if (!silent && config.onSelect) config.onSelect(null, "clear");
    }

    function clearByUser() {
      const hadChoice = Boolean(state.selected) || state.dropped;
      state.sequence += 1;
      clearTimeout(state.timer);
      clearSelection(!hadChoice);
    }

    clearButton.addEventListener("mousedown", (event) => {
      if (event && event.preventDefault) event.preventDefault();
    });
    clearButton.addEventListener("click", (event) => {
      if (event && event.preventDefault) event.preventDefault();
      if (state.disabled) return;
      focusQuietly();
      clearByUser();
    });

    async function lookup() {
      if (state.disabled || !config.load) return;
      const sequence = ++state.sequence;
      state.options = [];
      renderOptions("Looking…");
      try {
        const found = await config.load(input.value);
        if (sequence !== state.sequence || !shadow) return;
        state.options = Array.isArray(found) ? found : (found && found.options) || [];
        const note = found && found.note;
        if (!state.options.length) renderOptions(note || config.emptyMessage);
        else {
          renderOptions();
          if (note) menu.appendChild(el("span", "menu-message", note));
        }
      } catch (error) {
        if (sequence !== state.sequence || !shadow) return;
        renderOptions(errorMessage(error));
      }
    }

    function scheduleLookup() {
      clearTimeout(state.timer);
      state.timer = setTimeout(lookup, 180);
    }

    input.addEventListener("input", () => {
      if (!input.value) {
        clearByUser();
        return;
      }
      /* The text no longer names what is bound, so a stale choice must not
       * survive into a query built from what the input now reads. */
      if (state.selected && input.value !== state.selected.label) {
        state.selected = null;
        state.dropped = true;
        if (config.onSelect) config.onSelect(null, "edit");
      }
      refreshClear();
      scheduleLookup();
    });
    /* Leaving ends an edit: a choice that typing unbound is cleared as the
     * button would, judged once focus has settled. */
    function leaveControl() {
      state.leaveTimer = null;
      if (combos[config.key] !== api || state.disabled) return;
      if (shadow && shadow.activeElement === input) return;
      if (state.dropped) {
        clearByUser();
        return;
      }
      state.sequence += 1;
      clearTimeout(state.timer);
      setOpen(false);
    }
    input.addEventListener("blur", () => {
      clearTimeout(state.leaveTimer);
      state.leaveTimer = setTimeout(leaveControl, 0);
    });
    input.addEventListener("focus", () => {
      if (state.disabled || state.quietFocus) return;
      if (state.options.length) setOpen(true);
      else if (input.value || config.loadOnFocus) lookup();
    });
    input.addEventListener("keydown", (event) => {
      const key = event.key;
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        if (!state.open) {
          if (state.options.length) setOpen(true);
          else lookup();
        }
        if (state.options.length) setActive(state.activeIndex + (key === "ArrowDown" ? 1 : -1));
      } else if ((key === "Home" || key === "End") && state.open && state.options.length) {
        event.preventDefault();
        setActive(key === "Home" ? 0 : state.options.length - 1);
      } else if (key === "Enter" && state.open) {
        /* An open list owns Enter, even while it shows only a note such as
         * "Looking…", so the form around it is not submitted from inside a
         * picker. */
        event.preventDefault();
        if (state.activeIndex >= 0 && state.activeIndex < state.options.length) {
          select(state.options[state.activeIndex]);
        }
      } else if (key === "Escape" && state.open) {
        event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        setOpen(false);
      }
    });

    function applyDisabled(busy) {
      state.disabled = Boolean(busy) || state.blocked;
      setDisabled(input, state.disabled);
      if (state.disabled) setOpen(false);
      refreshClear();
      input.setAttribute(
        "placeholder",
        state.blocked ? (state.blockedReason || "") : (config.placeholder || "")
      );
    }

    const api = {
      node: wrap,
      input,
      menu,
      labelNode,
      clearButton,
      get selected() { return state.selected; },
      get isOpen() { return state.open; },
      closeMenu: () => setOpen(false),
      focusQuietly,
      clearSelection,
      /* Binds an option without announcing a pick: a remembered field is
       * restored, not chosen. */
      setSelection(option) {
        state.selected = option || null;
        state.dropped = false;
        input.value = option ? option.label : "";
        refreshClear();
      },
      focusAndOpen() {
        if (state.disabled) return;
        focusQuietly();
        lookup();
      },
      setBusy: (busy) => applyDisabled(busy),
      setBlocked(blocked, reason) {
        state.blocked = Boolean(blocked);
        state.blockedReason = reason || "";
        applyDisabled(false);
      },
      cancelPending() {
        state.sequence += 1;
        clearTimeout(state.timer);
      },
      destroy() {
        state.sequence += 1;
        clearTimeout(state.timer);
        clearTimeout(state.leaveTimer);
        if (combos[config.key] === api) delete combos[config.key];
      },
    };
    combos[config.key] = api;
    return api;
  }

  function anyComboOpen() {
    return Object.keys(combos).some((key) => combos[key] && combos[key].isOpen);
  }

  function closeAllCombos() {
    Object.keys(combos).forEach((key) => combos[key] && combos[key].closeMenu());
  }

  /* ------------------------------------------------------------------ *
   * Filter rows
   * ------------------------------------------------------------------ */

  function filterFieldOption(field) {
    return {
      label: field.label,
      hint: field.name + (field.kind === "reference"
        ? " · reference to " + field.reference
        : " · choice"),
      value: field.name,
      kind: field.kind,
    };
  }

  function currentFilterFieldNames() {
    return filterRows
      .filter((row) => row.field.selected)
      .map((row) => row.field.selected.value);
  }

  async function loadFilterFieldOptions(row, text) {
    if (!onFilterFields || !tableInfo) return { options: [] };
    const table = tableInfo.table;
    const info = await onFilterFields(table);
    if (!tableInfo || tableInfo.table !== table) return { options: [] };
    /* A field already used in another row is not offered again: two values
     * for one field would be an OR, which is a different feature. */
    const used = new Set(filterRows
      .filter((other) => other !== row && other.field.selected)
      .map((other) => other.field.selected.value));
    const typed = String(text || "").trim();
    const needle = row.field.selected && typed === row.field.selected.label ? "" : typed.toLowerCase();
    const options = ((info && info.fields) || [])
      .filter((field) => !used.has(field.name))
      .filter((field) => !needle || field.label.toLowerCase().includes(needle) ||
        field.name.toLowerCase().includes(needle))
      .map(filterFieldOption);
    return { options, note: info && info.truncated ? "More fields exist than were read." : "" };
  }

  async function loadFilterValueOptions(row, text) {
    const field = row.field.selected;
    if (!field) return { options: [], note: "Choose a field first." };
    if (!onFilterValues || !tableInfo) return { options: [] };
    const table = tableInfo.table;
    const typed = String(text || "").trim();
    const term = row.value.selected && typed === row.value.selected.label ? "" : typed;
    const result = await onFilterValues(table, field.value, term);
    if (!tableInfo || tableInfo.table !== table) return { options: [] };
    const notes = [];
    if (result && result.truncated) {
      notes.push(result.kind === "reference"
        ? "More records exist than can be listed — type at least three characters to search them."
        : "More choices exist than were read.");
    }
    if (result && result.note) notes.push(result.note);
    return {
      options: ((result && result.values) || []).map((item) => ({
        label: item.label,
        hint: item.hint || "",
        value: item.value,
      })),
      note: notes.join(" "),
    };
  }

  function renumberFilterRows() {
    filterRows.forEach((row, index) => {
      const n = index + 1;
      row.field.labelNode.textContent = "Filter " + n + " · field";
      row.value.labelNode.textContent = "Filter " + n + " · value";
      row.remove.setAttribute("aria-label", "Remove filter " + n);
    });
  }

  function updateFilterControls() {
    if (!shadow) return;
    const area = shadow.querySelector(".filters");
    const add = shadow.querySelector(".add-filter");
    setHidden(area, !tableInfo || !onFilterFields);
    const full = filterRows.length >= engine().MAX_FILTERS;
    setDisabled(add, searchBusy || full);
    add.title = full ? "Three filters at most" : "Filter by a reference or choice field";
  }

  function addFilterRow(presetField) {
    if (!shadow || !tableInfo || filterRows.length >= engine().MAX_FILTERS) return null;
    const id = ++filterRowSequence;
    const row = { id, field: null, value: null, remove: null, node: el("div", "filter-row") };
    row.field = createCombo({
      key: "filter-" + id + "-field",
      id: "snh-rs-filter-" + id + "-field",
      label: "Filter · field",
      clearLabel: "filter field",
      placeholder: "a reference or choice field",
      emptyMessage: "No reference or choice fields are readable on this table.",
      loadOnFocus: true,
      load: (text) => loadFilterFieldOptions(row, text),
      onSelect: (option, how) => {
        /* A value from the previous field is meaningless against the new
         * one, so changing the field always discards it. */
        row.value.cancelPending();
        row.value.clearSelection(true);
        row.value.setBlocked(!option, "choose a field first");
        lastResult = null;
        updateListButton();
        /* A field alone is half a condition, so a pick opens its values. A
         * clear asks again only if a whole condition went with it -- after
         * the save, as removing a row does, so the search owns the status. */
        if (how === "pick") row.value.focusAndOpen();
        if (how !== "edit") saveFavoriteFilterFields();
        if (how === "clear") searchIfChanged();
      },
    });
    row.value = createCombo({
      key: "filter-" + id + "-value",
      id: "snh-rs-filter-" + id + "-value",
      label: "Filter · value",
      clearLabel: "filter value",
      placeholder: "choose a value",
      emptyMessage: "No values are available for that field.",
      loadOnFocus: true,
      load: (text) => loadFilterValueOptions(row, text),
      onSelect: (option, how) => {
        lastResult = null;
        updateListButton();
        if (how !== "edit") searchIfChanged();
      },
    });
    row.remove = el("button", "filter-remove", "✕");
    row.remove.setAttribute("type", "button");
    row.remove.addEventListener("click", () => removeFilterRow(row));
    row.node.appendChild(row.field.node);
    row.node.appendChild(row.value.node);
    row.node.appendChild(row.remove);
    if (presetField) {
      row.field.setSelection(presetField);
      row.value.setBlocked(false);
    } else {
      row.value.setBlocked(true, "choose a field first");
    }
    if (searchBusy) {
      row.field.setBusy(true);
      row.value.setBusy(true);
      setDisabled(row.remove, true);
    }
    filterRows.push(row);
    shadow.querySelector(".filter-rows").appendChild(row.node);
    renumberFilterRows();
    updateFilterControls();
    return row;
  }

  /* Removing a row unregisters both pickers and cancels anything pending,
   * then gives focus to Add filter so it is not lost with the row. */
  function removeFilterRow(row) {
    if (!shadow || !filterRows.includes(row)) return;
    const hadField = Boolean(row.field.selected);
    row.field.destroy();
    row.value.destroy();
    row.node.remove();
    filterRows = filterRows.filter((other) => other !== row);
    renumberFilterRows();
    updateFilterControls();
    lastResult = null;
    updateListButton();
    shadow.querySelector(".add-filter").focus();
    if (hadField) saveFavoriteFilterFields();
    searchIfChanged();
  }

  function clearFilterRows() {
    filterRows.forEach((row) => {
      row.field.destroy();
      row.value.destroy();
      row.node.remove();
    });
    filterRows = [];
    updateFilterControls();
  }

  /*
   * A favourite remembers filter FIELDS, never values. Each is re-checked
   * against the live filter-field list before its row is created empty.
   *
   * Bound to the table SELECTION, not to the status line: a search started
   * while this reads must not abandon the restore, or the next save would
   * write only the rows on screen over the remembered names. Returns null
   * when the selection moved on, else { note, missing }.
   */
  async function restoreFilterFields(table, names, selection) {
    let info;
    try {
      info = await onFilterFields(table);
    } catch (error) {
      if (!shadow || selection !== selectionSequence) return null;
      unsavedFilterFavorites.add(table);
      return {
        note: " · its filter fields could not be verified right now, so none were added" +
          " and they are kept as saved",
        missing: [],
      };
    }
    if (!shadow || selection !== selectionSequence) return null;
    const offered = new Map(((info && info.fields) || []).map((field) => [field.name, field]));
    /* A row the user added while this read is already on screen. */
    const present = new Set(currentFilterFieldNames());
    const missing = [];
    const noRoom = [];
    let added = 0;
    names.slice(0, engine().MAX_FILTERS).forEach((name) => {
      const field = offered.get(name);
      if (!field) missing.push(name);
      else if (present.has(name)) added += 1;
      else if (addFilterRow(filterFieldOption(field))) added += 1;
      else noRoom.push(name);
    });
    if ((missing.length && info && info.truncated) || noRoom.length) {
      unsavedFilterFavorites.add(table);
      return {
        note: " · filter fields not restored right now: " + missing.concat(noRoom).join(", ") +
          ", so they are kept as saved",
        missing: [],
      };
    }
    return {
      note: (added
        ? " · " + added + (added === 1 ? " remembered filter" : " remembered filters") + " ready for a value"
        : "") +
        (missing.length
          ? " · filter fields no longer offered: " + missing.join(", ") +
            " (dropped when its filters are next saved)"
          : ""),
      missing,
    };
  }

  function cleanFavorites(list) {
    const names = (value) => (Array.isArray(value)
      ? value.filter((field) => typeof field === "string")
      : []);
    return (Array.isArray(list) ? list : [])
      .filter((item) => item && typeof item.name === "string" &&
        /^[a-z][a-z0-9_]*$/.test(item.name))
      .map((item) => ({
        name: item.name,
        label: typeof item.label === "string" && item.label ? item.label : item.name,
        fields: names(item.fields),
        filterFields: names(item.filterFields),
        columns: names(item.columns),
      }));
  }

  function favoriteFor(name) {
    return favorites.find((item) => item.name === name) || null;
  }

  function activeOptionName() {
    const option = tableOptions[activeTableIndex];
    return option ? option.name : "";
  }

  /* The input points at an option only while that option is on screen, so
   * Enter can never take one the menu is not showing. */
  function setTableMenu(open) {
    if (!shadow) return;
    const menu = shadow.querySelector(".table-menu");
    const input = shadow.querySelector("[data-input='table']");
    menu.hidden = !open;
    input.setAttribute("aria-expanded", String(Boolean(open)));
    if (open && activeTableIndex >= 0 && activeTableIndex < tableOptions.length) {
      input.setAttribute("aria-activedescendant", "snh-rs-table-option-" + activeTableIndex);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  /* Renders exactly tableOptions, then an optional note that is not an
   * option. Callers set tableOptions and activeTableIndex first, every time,
   * so the menu and the keyboard model cannot disagree. */
  function renderTableOptions(note) {
    if (!shadow) return;
    const menu = shadow.querySelector(".table-menu");
    menu.textContent = "";
    tableOptions.forEach((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.id = "snh-rs-table-option-" + index;
      button.className = "table-option" + (index === activeTableIndex ? " active" : "");
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === activeTableIndex));
      const label = document.createElement("span");
      label.className = "table-label";
      if (option.starred) {
        const star = document.createElement("span");
        star.className = "table-star";
        star.setAttribute("aria-hidden", "true");
        star.textContent = "★";
        label.appendChild(star);
      }
      label.appendChild(document.createTextNode(option.label || option.name));
      if (option.starred) {
        const announced = document.createElement("span");
        announced.className = "sr-only";
        announced.textContent = ", starred";
        label.appendChild(announced);
      }
      if (option.staging) {
        const separator = document.createElement("span");
        separator.className = "sr-only";
        separator.textContent = ", ";
        const tag = document.createElement("span");
        tag.className = "table-tag";
        tag.textContent = "import set staging";
        label.appendChild(separator);
        label.appendChild(tag);
      }
      const name = document.createElement("span");
      name.className = "table-name";
      name.textContent = option.name;
      button.appendChild(label);
      button.appendChild(name);
      button.addEventListener("mouseenter", () => setActiveTable(index));
      button.addEventListener("click", () => selectTable(option));
      menu.appendChild(button);
    });
    if (note || !tableOptions.length) {
      const message = document.createElement("div");
      message.className = "menu-message";
      message.textContent = note || "No matching readable tables.";
      menu.appendChild(message);
    }
    setTableMenu(true);
  }

  function showFavoriteTables() {
    if (!shadow) return;
    lookupSequence += 1;
    const merged = engine().mergeFavoritesIntoOptions(favorites, [], "", activeOptionName());
    tableOptions = merged.options;
    activeTableIndex = merged.activeIndex;
    renderTableOptions();
    setStatus("Your starred tables · type to find any other", "", false);
  }

  /* Every way of opening the menu on an empty box shows the starred tables,
   * so none of them can show a list left over from earlier typing. */
  function openTableMenu(immediate) {
    if (!shadow) return;
    const value = shadow.querySelector("[data-input='table']").value.trim();
    if (!value && favorites.length) showFavoriteTables();
    else if (tableOptions.length) setTableMenu(true);
    else if (immediate) lookupTables();
    else if (value) scheduleTableLookup();
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
    selectionSequence += 1;
    filterRestorePending = "";
    filterSaveDeferred = false;
    selectedTable = null;
    tableInfo = null;
    tableError = false;
    selectedFields = new Set();
    selectedColumns = [];
    lastResult = null;
    clearFilterRows();
    renderFieldControl();
    updateListButton();
    refreshClearButtons();
    resetResults();
  }

  /* The Table and Text boxes get the filter pickers' ✕, shown whenever there
   * is something to clear. The text box stays live during a search, and so
   * does its ✕. */
  function refreshClearButtons() {
    if (!shadow) return;
    shadow.querySelectorAll("[data-clear]").forEach((button) => {
      const input = shadow.querySelector("[data-input='" + button.dataset.clear + "']");
      setHidden(button, !input.value);
      setDisabled(button, searchBusy && button.dataset.clear !== "term");
    });
  }

  /* Deleting the text by hand runs a lookup on the empty box, which asks for
   * two characters. A clear is deliberate, so it asks nothing: it shows the
   * starred tables, or the opening prompt when there are none. */
  function clearTableByUser() {
    if (!shadow || searchBusy) return;
    const input = shadow.querySelector("[data-input='table']");
    clearTimeout(lookupTimer);
    lookupSequence += 1;
    input.value = "";
    clearTableSelection();
    tableOptions = [];
    activeTableIndex = -1;
    shadow.querySelector(".table-menu").textContent = "";
    setTableMenu(false);
    input.focus();
    /* Focus shows them only when it moves, and the box may already have had it. */
    if (favorites.length) showFavoriteTables();
    else setStatus("Search for a table to begin.", "", false);
  }

  /* A finished question, like clearing a picker, so it is asked at once. */
  function clearTermByUser() {
    if (!shadow) return;
    const input = shadow.querySelector("[data-input='term']");
    input.value = "";
    refreshClearButtons();
    input.focus();
    searchIfChanged();
  }

  /* Matching favourites, in stored order, then live results. */
  function setMergedTableOptions(value, lookupResults) {
    const merged = engine().mergeFavoritesIntoOptions(
      favorites, lookupResults, value, activeOptionName()
    );
    tableOptions = merged.options;
    activeTableIndex = merged.activeIndex;
  }

  async function lookupTables() {
    if (!shadow || !onFindTables) return;
    const input = shadow.querySelector("[data-input='table']");
    const value = input.value.trim();
    const sequence = ++lookupSequence;
    if (!value && favorites.length) {
      showFavoriteTables();
      return;
    }
    if (!engine().extractTableLookupAnchor(value)) {
      tableOptions = [];
      activeTableIndex = -1;
      renderTableOptions("Type at least two letters, numbers, or underscores.");
      setStatus("Type at least two characters to find a table.", "validation", false);
      return;
    }
    /* While the live lookup runs, only favourites matching the text stay as
     * options; with none, nothing is selectable until results arrive. */
    setMergedTableOptions(value, []);
    renderTableOptions(tableOptions.length ? "Finding more tables…" : "Finding matching tables…");
    try {
      const options = await onFindTables(value);
      if (!shadow || sequence !== lookupSequence) return;
      setMergedTableOptions(value, Array.isArray(options) ? options : []);
      renderTableOptions();
      const starredCount = tableOptions.filter((option) => option.starred).length;
      setStatus(
        tableOptions.length
          ? (tableOptions.truncated ? "Showing " : "") + tableOptions.length +
            (tableOptions.length === 1 ? " matching table" : " matching tables") +
            (starredCount ? " · " + starredCount + " starred, listed first" : "") +
            (tableOptions.truncated ? " · type more to narrow, or choose one." : " · choose one.")
          : "No matching readable tables were found.",
        tableOptions.length ? "" : "empty",
        false
      );
    } catch (error) {
      if (!shadow || sequence !== lookupSequence) return;
      const message = String(error && error.message || error);
      setMergedTableOptions(value, []);
      renderTableOptions(message);
      setStatus(message, errorKind(error), false);
    }
  }

  function scheduleTableLookup() {
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(lookupTables, 180);
  }

  async function selectTable(option, detected) {
    if (!shadow || !option || !option.name || !onResolveTable) return;
    lookupSequence += 1;
    const selection = ++selectionSequence;
    filterRestorePending = "";
    filterSaveDeferred = false;
    selectedTable = { name: option.name, label: option.label || option.name };
    tableInfo = null;
    tableError = false;
    selectedFields = new Set();
    selectedColumns = [];
    lastResult = null;
    clearFilterRows();
    shadow.querySelector("[data-input='table']").value = option.name;
    refreshClearButtons();
    setTableMenu(false);
    renderFieldControl();
    updateListButton();
    resetResults();
    const sequence = ++requestSequence;
    /* A favourite's remembered fields are only names. Each one must be
     * confirmed by its own live dictionary row before it is applied. */
    const favorite = favoriteFor(option.name);
    const rememberedFields = favorite ? favorite.fields.slice() : [];
    const rememberedColumns = favorite ? favorite.columns.slice() : [];
    setStatus(
      (detected ? "Detected " : "Checking ") + option.name + " and reading its live dictionary…",
      "",
      true
    );
    try {
      const info = await onResolveTable(option.name, { rememberedFields, rememberedColumns });
      if (!shadow || sequence !== requestSequence || !info) return;
      tableInfo = info;
      selectedTable = { name: info.table, label: info.label || info.table };
      const verdict = (value) => {
        const list = (key) => (value && Array.isArray(value[key]) ? value[key] : []);
        return { verified: list("verified"), absent: list("absent"), unverifiable: list("unverifiable") };
      };
      const fieldsRead = verdict(info.remembered);
      const columnsRead = verdict(info.rememberedColumns);
      const useRemembered = fieldsRead.verified.length > 0 && !fieldsRead.unverifiable.length;
      const useRememberedColumns = columnsRead.verified.length > 0 && !columnsRead.unverifiable.length;
      if (fieldsRead.unverifiable.length) unsavedFavorites.add(info.table);
      if (columnsRead.unverifiable.length) unsavedColumnFavorites.add(info.table);
      selectedFields = new Set(useRemembered
        ? fieldsRead.verified
        : (info.defaultFields || []).map((field) => field.name));
      /* With nothing remembered, a row shows what is searched, as before the
       * two were separate. */
      selectedColumns = useRememberedColumns ? columnsRead.verified.slice() : Array.from(selectedFields);
      renderFieldControl();
      let readyText;
      let readyKind;
      if (!searchableFields().length) {
        readyText = "The table is readable, but no searchable fields were verified. " +
          "Exact sys_id lookup and filters can still run.";
        readyKind = "schema";
      } else {
        readyText =
          "Ready · " + selectedTable.label + " (" + selectedTable.name + ") · searching " +
            selectedFields.size + (selectedFields.size === 1 ? " field" : " fields") +
            (useRemembered ? " · this favourite's remembered fields" : "") +
            " · showing " + selectedColumns.length + (selectedColumns.length === 1 ? " column" : " columns") +
            (useRememberedColumns ? " · its remembered columns" : "") +
            (fieldsRead.absent.length
              ? " · no longer on this table: " + fieldsRead.absent.join(", ") +
                " (dropped when its fields are next saved)"
              : "") +
            (columnsRead.absent.length
              ? " · columns no longer on this table: " + columnsRead.absent.join(", ") +
                " (dropped when its columns are next saved)"
              : "") +
            (fieldsRead.unverifiable.length
              ? " · the remembered fields could not be verified right now, so defaults apply" +
                " and nothing is saved for this favourite until Record Lens is reopened"
              : "") +
            (columnsRead.unverifiable.length
              ? " · the remembered columns could not be verified right now, so the searched" +
                " fields are shown and its columns are not saved until Record Lens is reopened"
              : "");
        readyKind = fieldsRead.absent.length || fieldsRead.unverifiable.length ||
          columnsRead.absent.length || columnsRead.unverifiable.length ? "validation" : "";
      }
      setStatus(readyText, readyKind, false);
      shadow.querySelector("[data-input='term']").focus();
      renderReady();
      let restoreWarned = false;
      const rememberedFilters = favorite ? favorite.filterFields.slice() : [];
      if (rememberedFilters.length && onFilterFields) {
        /* Saves asked for while this restores wait for it, so a partial set
         * of rows is never written over the remembered names. */
        filterRestorePending = info.table;
        let restored = null;
        try {
          restored = await restoreFilterFields(info.table, rememberedFilters, selection);
        } finally {
          if (filterRestorePending === info.table) filterRestorePending = "";
        }
        const deferredSave = filterSaveDeferred;
        filterSaveDeferred = false;
        if (!restored || !shadow) return;
        restoreWarned = /could not|not restored|no longer/.test(restored.note);
        const statusFree = sequence === requestSequence;
        if (statusFree && restored.note) {
          setStatus(readyText + restored.note, readyKind || (restoreWarned ? "validation" : ""), false);
        } else if (!statusFree && restored.missing.length) {
          /* A search owns the status line now, so a field found gone was
           * never announced. It is kept rather than dropped unseen. */
          unsavedFilterFavorites.add(info.table);
        }
        /* A change made during the restore is saved now, naming anything it
         * drops -- unless the remembered names are being held back. */
        if (deferredSave && !unsavedFilterFavorites.has(info.table)) {
          saveFavoriteFilterFields(restored.missing.length
            ? " · dropped, no longer offered: " + restored.missing.join(", ") : "");
        }
      }
      /*
       * A table chosen under text already typed is a finished question,
       * asked once its remembered filter rows are back. Asking earlier took
       * the status line from the restore, so a filter field found gone was
       * never announced and the favourite stopped saving (review B1). A
       * warning, from the fields or the filters, is left on screen to be read
       * instead. Enter pressed meanwhile asked the same question, which
       * searchIfChanged does not ask twice.
       */
      if (termValue() && !readyKind && !restoreWarned) searchIfChanged();
    } catch (error) {
      if (!shadow || sequence !== requestSequence) return;
      tableInfo = null;
      tableError = true;
      selectedFields = new Set();
      selectedColumns = [];
      renderFieldControl();
      setStatus(String(error && error.message || error), errorKind(error), false);
      renderEmpty("The table could not be prepared.", String(error && error.message || error));
    }
  }

  /* Opening one picker closes the other, so two lists never overlap. */
  function setPickerMenu(buttonSelector, menuSelector, open) {
    if (!shadow) return;
    const button = shadow.querySelector(buttonSelector);
    const menu = shadow.querySelector(menuSelector);
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(Boolean(open)));
  }

  function setFieldMenu(open) {
    setPickerMenu(".fields-button", ".field-menu", open);
  }

  function setColumnMenu(open) {
    setPickerMenu(".columns-button", ".column-menu", open);
  }

  function anyPickerOpen() {
    return Boolean(shadow) && (!shadow.querySelector(".field-menu").hidden ||
      !shadow.querySelector(".column-menu").hidden);
  }

  function allFields() {
    return tableInfo && Array.isArray(tableInfo.fields) ? tableInfo.fields : [];
  }

  /* The engine's rule, not a copy of it, so the two cannot drift. */
  function searchableFields() {
    return allFields().filter((field) => engine().isSearchable(field));
  }

  /* The star is its own cell beside the summary, never inside it: the
   * summary clips with an ellipsis and would hide a focusable control. Its
   * name stays "Star this table" and aria-pressed carries the state. It is
   * enabled only once the table is verified, so a detected table cannot be
   * starred under a label that was never read. A favourite that fails to
   * resolve keeps its star, so it can be unstarred from where it fails. */
  function updateStarControl() {
    if (!shadow) return;
    const star = shadow.querySelector(".star-btn");
    const starred = Boolean(selectedTable && favoriteFor(selectedTable.name));
    star.hidden = !onFavoriteOp || !selectedTable || (tableError && !starred);
    star.setAttribute("aria-pressed", String(starred));
    star.disabled = searchBusy || (!tableInfo && !(tableError && starred));
    star.title = starred
      ? "Starred on this instance · press to unstar"
      : "Star this table to list it, with its fields and columns, when the table box is empty";
    star.querySelector(".star-glyph").textContent = starred ? "★" : "☆";
  }

  function applyFavoriteResponse(response) {
    if (response && Array.isArray(response.tables)) {
      const before = favorites.map((item) => item.name).join(",");
      favorites = cleanFavorites(response.tables);
      /* A menu list built from the old set must never be reopened. */
      if (shadow && favorites.map((item) => item.name).join(",") !== before) {
        tableOptions = [];
        activeTableIndex = -1;
        shadow.querySelector(".table-menu").textContent = "";
        setTableMenu(false);
      }
    }
    updateStarControl();
  }

  function favoriteFailure(response) {
    if (response && response.code === "cap") {
      return "You have " + (response.limit || "the maximum number of") +
        " starred tables on this instance. Unstar one first.";
    }
    if (response && response.code === "invalid") {
      return "GlideLens could not save this starred table (" + (response.error || "invalid") + ").";
    }
    return "Starred tables could not be saved right now. Try again.";
  }

  /* Busy is a guard, not `disabled`: disabling the focused button would drop
   * keyboard focus to the page. */
  async function toggleStar() {
    if (!shadow || !onFavoriteOp || !selectedTable || favoriteBusy) return;
    const table = selectedTable;
    const starred = Boolean(favoriteFor(table.name));
    if (!starred && !tableInfo) return;
    const request = starred
      ? { op: "unstar", name: table.name }
      : {
        op: "star",
        name: table.name,
        label: tableInfo.label || table.name,
        fields: Array.from(selectedFields),
        filterFields: currentFilterFieldNames(),
        columns: selectedColumns.slice(),
      };
    favoriteBusy = true;
    let response = null;
    try {
      response = await onFavoriteOp(request);
    } catch (_) {
      response = null;
    }
    favoriteBusy = false;
    if (!shadow) return;
    applyFavoriteResponse(response);
    if (!response || !response.ok) {
      setStatus(favoriteFailure(response), response && response.code === "cap" ? "validation" : "transient", false);
      return;
    }
    unsavedFavorites.delete(table.name);
    unsavedFilterFavorites.delete(table.name);
    unsavedColumnFavorites.delete(table.name);
    /* Unstarring a table that failed to resolve hides the star, which would
     * otherwise take keyboard focus with it. The failed name is of no further
     * use, so the box is cleared and focus returns to it. */
    if (starred && tableError && selectedTable === table) {
      const tableInput = shadow.querySelector("[data-input='table']");
      tableInput.value = "";
      clearTableSelection();
      tableInput.focus();
    }
    const name = (table.label || table.name) + " (" + table.name + ")";
    setStatus(
      (starred
        ? "Removed " + name + " from your starred tables."
        : "Starred " + name + " · it is listed, with these fields and columns, when the table box is empty.") +
        (response.evicted
          ? " The starred tables of the instance changed longest ago were removed to make room."
          : ""),
      "",
      false
    );
  }

  /* Only a starred table writes, and every write is announced. */
  async function saveFavoriteFields() {
    if (!shadow || !onFavoriteOp || !selectedTable || !tableInfo) return;
    const name = selectedTable.name;
    if (!favoriteFor(name)) return;
    if (unsavedFavorites.has(name)) {
      setStatus(
        "Not saved: this favourite's remembered fields could not be verified when it was opened, so they are left as they were.",
        "validation",
        false
      );
      return;
    }
    /* An empty list would come back as the table's defaults, which is not
     * what was chosen, so it is not saved as a choice. */
    if (!selectedFields.size) {
      setStatus("Not saved: choose at least one field to remember for this favourite.", "validation", false);
      return;
    }
    const sequence = requestSequence;
    let response = null;
    try {
      response = await onFavoriteOp({ op: "fields", name, fields: Array.from(selectedFields) });
    } catch (_) {
      response = null;
    }
    if (!shadow) return;
    applyFavoriteResponse(response);
    if (sequence !== requestSequence) return;
    if (response && response.ok) setStatus("Saved as this favourite's search fields", "", false);
    else setStatus(favoriteFailure(response), "transient", false);
  }

  /* The same rules for the shown columns, in the order they are shown. */
  async function saveFavoriteColumns() {
    if (!shadow || !onFavoriteOp || !selectedTable || !tableInfo) return;
    const name = selectedTable.name;
    if (!favoriteFor(name)) return;
    if (unsavedColumnFavorites.has(name)) {
      setStatus(
        "Not saved: this favourite's columns could not be verified when it was opened, so they are left as they were.",
        "validation",
        false
      );
      return;
    }
    const sequence = requestSequence;
    let response = null;
    try {
      response = await onFavoriteOp({ op: "columns", name, columns: selectedColumns.slice() });
    } catch (_) {
      response = null;
    }
    if (!shadow) return;
    applyFavoriteResponse(response);
    if (sequence !== requestSequence) return;
    if (response && response.ok) setStatus("Saved as this favourite's columns", "", false);
    else setStatus(favoriteFailure(response), "transient", false);
  }

  /* Filter FIELD names only. A value is a record identifier and is never
   * sent, so the worker could not store one if it tried. */
  async function saveFavoriteFilterFields(droppedNote) {
    if (!shadow || !onFavoriteOp || !selectedTable || !tableInfo) return;
    const name = selectedTable.name;
    if (!favoriteFor(name)) return;
    if (filterRestorePending === name) {
      filterSaveDeferred = true;
      return;
    }
    if (unsavedFilterFavorites.has(name)) {
      setStatus(
        "Not saved: this favourite's filter fields could not be verified when it was opened, so they are left as they were.",
        "validation",
        false
      );
      return;
    }
    const sequence = requestSequence;
    let response = null;
    try {
      response = await onFavoriteOp({
        op: "filterFields", name, filterFields: currentFilterFieldNames(),
      });
    } catch (_) {
      response = null;
    }
    if (!shadow) return;
    applyFavoriteResponse(response);
    if (sequence !== requestSequence) return;
    if (response && response.ok) {
      setStatus("Saved as this favourite's filter fields" + (droppedNote || ""), "", false);
    } else {
      setStatus(favoriteFailure(response), "transient", false);
    }
  }

  function updateFieldSummary() {
    if (!shadow) return;
    updateStarControl();
    updateFilterControls();
    const summary = shadow.querySelector(".field-summary");
    const fieldsButton = shadow.querySelector(".fields-button");
    const columnsButton = shadow.querySelector(".columns-button");
    const byName = new Map(allFields().map((field) => [field.name, field]));
    const chosen = searchableFields().filter((field) => selectedFields.has(field.name));
    const shown = selectedColumns.map((name) => byName.get(name)).filter(Boolean);
    fieldsButton.disabled = searchBusy || !searchableFields().length;
    fieldsButton.textContent = "Search " + chosen.length + (chosen.length === 1 ? " field" : " fields");
    columnsButton.disabled = searchBusy || !allFields().length;
    /* No columns means a row shows what is searched, which is what the
     * engine does with an empty list (review S1). That state is reached only
     * when a table opens with nothing to search; it is named for what it
     * shows rather than as zero. */
    const showsSearched = !shown.length && chosen.length > 0;
    columnsButton.textContent = showsSearched
      ? "Show searched fields"
      : "Show " + shown.length + (shown.length === 1 ? " column" : " columns");
    summary.textContent = "";
    if (!selectedTable) {
      summary.textContent = "Choose a table to load verified fields.";
      return;
    }
    const table = document.createElement("span");
    table.className = "selected-table";
    table.textContent = (selectedTable.label || selectedTable.name) + " (" + selectedTable.name + ") · " +
      (tableInfo && tableInfo.staging ? "import set staging table · " : "");
    const fieldsText = document.createElement("strong");
    fieldsText.textContent = chosen.length
      ? "Searching: " + chosen.map((field) => field.label + " [" + field.name + "]").join(", ")
      : "No fields selected";
    summary.appendChild(table);
    summary.appendChild(fieldsText);
    if (shown.length || showsSearched) {
      summary.appendChild(el("span", "selected-table", " · Showing: " + (showsSearched
        ? "the searched fields"
        : shown.map((field) => field.label).join(", "))));
    }
  }

  /* Both pickers share one shape: a find box, a note, then the ticked
   * options in their own group above the rest. Options are added to the
   * rest; arrangePicker sorts them. Returns the group to add them to. */
  function buildPicker(menu, note, findLabel) {
    const find = el("input", "picker-find");
    find.type = "text";
    find.placeholder = "Find a field by label or name";
    find.setAttribute("aria-label", findLabel);
    find.setAttribute("autocomplete", "off");
    find.setAttribute("spellcheck", "false");
    find.addEventListener("input", () => filterPicker(menu));
    /* Enter in the box would otherwise submit the search form. */
    find.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
    const list = el("div", "picker-list");
    const rest = el("div", "picker-rest");
    /* Always present and empty while rows match, so a screen reader hears
     * the note when it is written, not a region appearing. */
    const none = el("div", "menu-message picker-none");
    none.setAttribute("role", "status");
    [
      el("div", "picker-heading chosen", "Selected"),
      el("div", "picker-chosen"),
      el("div", "picker-heading rest", "Other fields"),
      rest,
      none,
    ].forEach((node) => list.appendChild(node));
    menu.appendChild(find);
    menu.appendChild(el("div", "menu-note", note));
    menu.appendChild(list);
    return rest;
  }

  /* Ticked options go first, in the order given, and the find box starts
   * empty. Run when a picker opens, never while it is open, so a row never
   * moves out from under the pointer that just ticked it. */
  function arrangePicker(menu, names) {
    const chosen = menu.querySelector(".picker-chosen");
    const rest = menu.querySelector(".picker-rest");
    if (!chosen || !rest) return;
    const options = Array.from(menu.querySelectorAll("[data-name]"))
      .sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order));
    const picked = names
      .map((name) => options.find((option) => option.dataset.name === name))
      .filter(Boolean);
    picked.forEach((option) => chosen.appendChild(option));
    options.filter((option) => !picked.includes(option)).forEach((option) => rest.appendChild(option));
    menu.querySelector(".picker-find").value = "";
    filterPicker(menu);
  }

  /* Matches a field's label or technical name. A group's heading shows only
   * while the group has a visible row, and "Other fields" only when there is
   * a Selected group above it to tell apart from. */
  function filterPicker(menu) {
    const find = menu.querySelector(".picker-find");
    if (!find) return;
    const needle = find.value.trim().toLowerCase();
    const visible = [".picker-chosen", ".picker-rest"].map((selector) => {
      let count = 0;
      Array.from(menu.querySelector(selector).children).forEach((option) => {
        option.hidden = Boolean(needle) && !option.dataset.find.includes(needle);
        if (!option.hidden) count += 1;
      });
      return count;
    });
    menu.querySelector(".picker-heading.chosen").hidden = !visible[0];
    menu.querySelector(".picker-heading.rest").hidden = !visible[0] || !visible[1];
    menu.querySelector(".picker-none").textContent = visible[0] + visible[1] > 0
      ? ""
      : "No field label or name contains “" + find.value.trim() + "”.";
  }

  function arrangeFieldPicker() {
    if (!shadow) return;
    arrangePicker(shadow.querySelector(".field-menu"),
      searchableFields().filter((field) => selectedFields.has(field.name)).map((field) => field.name));
  }

  /* Columns keep their shown order, so the badges read 1, 2, 3 down the list. */
  function arrangeColumnPicker() {
    if (!shadow) return;
    arrangePicker(shadow.querySelector(".column-menu"), selectedColumns.slice());
  }

  /* A checkbox row shared by both pickers. The title is returned so a caller
   * can add to it. */
  function pickerOption(className, dataKey, field, checked, onChange) {
    const label = el("label", className);
    label.dataset.name = field.name;
    label.dataset.find = ((field.label || "") + " " + field.name).toLowerCase();
    const checkbox = el("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.disabled = searchBusy;
    checkbox.dataset[dataKey] = field.name;
    const title = el("span");
    title.appendChild(document.createTextNode(field.label || field.name));
    label.appendChild(checkbox);
    label.appendChild(title);
    label.appendChild(el("span", "field-tech", field.name));
    if (!field.autoSelectable) {
      title.appendChild(document.createTextNode(" "));
      title.appendChild(el("span", "manual", "manual only"));
    }
    checkbox.addEventListener("change", () => onChange(checkbox));
    return { label, title };
  }

  /* Each ticked Show row carries its position, so which column becomes the
   * title is never a guess. Updated in place: rebuilding the list would take
   * focus from the checkbox just pressed. */
  function refreshColumnOrder() {
    if (!shadow) return;
    shadow.querySelectorAll(".column-option").forEach((option) => {
      const box = option.querySelector("input");
      const badge = option.querySelector(".order");
      const index = selectedColumns.indexOf(box.dataset.column);
      box.checked = index >= 0;
      badge.textContent = index >= 0 ? String(index + 1) : "";
      setHidden(badge, index < 0);
    });
  }

  function renderFieldControl() {
    if (!shadow) return;
    const menu = shadow.querySelector(".field-menu");
    const columnMenu = shadow.querySelector(".column-menu");
    menu.textContent = "";
    columnMenu.textContent = "";
    const fields = allFields();
    const searchable = searchableFields();
    if (!fields.length) {
      const text = selectedTable ? "No verified fields available." : "Choose a table first.";
      menu.appendChild(el("div", "menu-message", text));
      columnMenu.appendChild(el("div", "menu-message", text));
      setFieldMenu(false);
      setColumnMenu(false);
      updateFieldSummary();
      return;
    }
    const fieldList = searchable.length
      ? buildPicker(menu, "Text is matched against these. A reference matches its record's display name.",
        "Find a field to search")
      : menu.appendChild(el("div", "menu-message", "No searchable fields available."));
    searchable.forEach((field, index) => {
      const option = pickerOption("field-option", "field", field, selectedFields.has(field.name), (checkbox) => {
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
        saveFavoriteFields();
        scheduleSearch();
      });
      if (field.kind === "reference") {
        option.title.appendChild(document.createTextNode(" "));
        option.title.appendChild(el("span", "kind", "by name"));
      }
      option.label.dataset.order = String(index);
      fieldList.appendChild(option.label);
    });
    const columnList = buildPicker(columnMenu,
      "Each result shows these, in the order ticked. The first is its title.", "Find a column to show");
    fields.forEach((field, index) => {
      const option = pickerOption("column-option", "column", field, false, (checkbox) => {
        if (checkbox.checked && selectedColumns.length >= engine().MAX_SHOW_COLUMNS) {
          checkbox.checked = false;
          setStatus("Show no more than six columns.", "validation", false);
          return;
        }
        if (!checkbox.checked && selectedColumns.length === 1 && selectedColumns[0] === field.name) {
          checkbox.checked = true;
          setStatus("Keep at least one column to show.", "validation", false);
          return;
        }
        selectedColumns = selectedColumns.filter((name) => name !== field.name);
        if (checkbox.checked) selectedColumns.push(field.name);
        lastResult = null;
        refreshColumnOrder();
        updateFieldSummary();
        updateListButton();
        saveFavoriteColumns();
        scheduleSearch();
      });
      /* The space keeps "1" and the label apart when read aloud (review S4);
       * the badge's margin already parts them on screen. */
      const label = option.title.firstChild;
      option.title.insertBefore(el("span", "order"), label);
      option.title.insertBefore(document.createTextNode(" "), label);
      option.label.dataset.order = String(index);
      columnList.appendChild(option.label);
    });
    arrangeFieldPicker();
    arrangeColumnPicker();
    refreshColumnOrder();
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

  /*
   * Reported: the status line sits above the results, away from the button,
   * so a copy read as having done nothing. The pressed button answers for
   * itself, the way Translation Lens confirms its copy; the status line still
   * carries the announcement. Its width is held so the row does not shift.
   */
  const COPY_FLASH_MS = 2000;
  function flashResultAction(button, copied) {
    if (!button) return;
    if (button.flashRestore === undefined) button.flashRestore = button.textContent;
    if (!button.flashTimer && button.style && button.offsetWidth) {
      button.style.minWidth = button.offsetWidth + "px";
    }
    button.textContent = "";
    if (copied) {
      const tick = el("span", null, "✓ ");
      tick.setAttribute("aria-hidden", "true");
      button.appendChild(tick);
    }
    button.appendChild(document.createTextNode(copied ? "Copied" : "Copy failed"));
    button.className = "result-action " + (copied ? "copied" : "copy-failed");
    clearTimeout(button.flashTimer);
    button.flashTimer = setTimeout(() => {
      button.flashTimer = null;
      button.textContent = button.flashRestore;
      button.className = "result-action";
      if (button.style) button.style.minWidth = "";
    }, COPY_FLASH_MS);
  }

  async function copyResult(value, label, button) {
    try {
      await copyText(value);
      flashResultAction(button, true);
      setStatus(label + " copied to the clipboard.", "", false);
    } catch (error) {
      flashResultAction(button, false);
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
      action(button);
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
    /* As in Impersonate, the text box stays live: locking it would swallow
     * the keystrokes after a pause, and the next question waits its turn. */
    shadow.querySelectorAll("[data-input]").forEach((input) => {
      input.disabled = searchBusy && input.dataset.input !== "term";
    });
    shadow.querySelector(".search-btn").disabled = searchBusy;
    shadow.querySelectorAll(".field-option input").forEach((input) => {
      input.disabled = searchBusy;
    });
    shadow.querySelectorAll(".column-option input").forEach((input) => {
      input.disabled = searchBusy;
    });
    Object.keys(combos).forEach((key) => combos[key].setBusy(searchBusy));
    filterRows.forEach((row) => setDisabled(row.remove, searchBusy));
    refreshClearButtons();
    updateFieldSummary();
  }

  function renderResults(result, pendingRows) {
    if (!shadow || !result) return;
    lastResult = result;
    updateListButton();
    const rows = shadow.querySelector(".rows");
    rows.textContent = "";
    const results = Array.isArray(result.results) ? result.results : [];
    const filterCount = Array.isArray(result.filters) ? result.filters.length : 0;
    /* Filter-only results keep the server's order, so a full window is named
     * for what it is: the most recent matches, not the only ones. */
    let suffix = "";
    if (result.filterOnly && result.truncated && result.sortLabel === "most recently updated") {
      suffix = " · the " + results.length + " most recently updated verified matches" +
        (result.serverFull ? " (of at least " + engine().SERVER_LIMIT + ")" : "");
    } else if (result.truncated) {
      suffix = " · showing the first 20 verified matches";
    }
    const sortSuffix = result.sortLabel && !suffix.includes("most recently updated")
      ? " · sorted by " + result.sortLabel : "";
    const filterSuffix = filterCount
      ? " · " + filterCount + (filterCount === 1 ? " filter" : " filters") : "";
    const pendingSuffix = pendingRows
      ? " · " + pendingRows + (pendingRows === 1 ? " filter row has" : " filter rows have") +
        " no value yet"
      : "";
    setStatus(
      results.length + (results.length === 1 ? " verified record" : " verified records") +
        " in " + (result.tableLabel || result.table) + filterSuffix + sortSuffix + suffix +
        pendingSuffix,
      results.length ? "" : "empty",
      false
    );
    if (!results.length) {
      /* Reported: an empty staging table that shared its target's label read
       * as Record Lens not working, and a sys_id search was told about fields
       * it never used. */
      const stagingHint = result.staging
        ? " This is an import set staging table. Its rows are usually removed once they are" +
          " loaded, so the records may be in the table they were loaded into."
        : "";
      if (result.bySysId && !filterCount) {
        renderEmpty(
          "No record with this sys_id in " + (result.tableLabel || result.table) + ".",
          "A sys_id is found only in its record's own table or a parent of it, and only if" +
            " you can read that record." + stagingHint
        );
        return;
      }
      renderEmpty(
        filterCount ? "No verified matches for these filters." : "No verified matches in the selected fields.",
        (filterCount
          ? "Try another value, remove a filter, or change the text."
          : "Try another term, select different verified fields, or use an exact sys_id.") + stagingHint
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
        const value = el("span", item.matched ? "value matched" : "value");
        value.appendChild(el("span", "value-label", (item.label || item.field) + ": "));
        value.appendChild(document.createTextNode(item.value));
        /* Text matched a field the row does not show: it is named here so
         * no row appears without what it matched on. */
        if (item.matched) {
          value.title = "Matched your text. Not one of the shown columns.";
          value.appendChild(document.createTextNode(" "));
          value.appendChild(el("span", "match-tag", "match"));
        }
        values.appendChild(value);
      });
      if (values.childNodes.length) row.appendChild(values);

      const actions = document.createElement("div");
      actions.className = "row-actions";
      addResultAction(actions, "Open record", () => openRecord(resultRow));
      addResultAction(actions, "Copy sys_id", (button) => copyResult(resultRow.sysId, "sys_id", button));
      addResultAction(actions, "Copy URL", (button) => copyResult(resultUrl(resultRow), "Record URL", button));
      row.appendChild(actions);
      rows.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------ *
   * Asking the question
   * ------------------------------------------------------------------ */

  function termValue() {
    return shadow ? shadow.querySelector("[data-input='term']").value.trim() : "";
  }

  /* Only complete rows are part of the question. */
  function completeFilters() {
    return filterRows
      .filter((row) => row.field.selected && row.value.selected)
      .map((row) => ({ field: row.field.selected.value, value: row.value.selected.value }));
  }

  /* Trimmed, as the engine trims it. The shown columns count in their
   * order, because the first is each row's title, and they need a read of
   * their own values. */
  function currentRequestKey() {
    return JSON.stringify([
      selectedTable ? selectedTable.name : "",
      termValue(),
      Array.from(selectedFields).sort(),
      selectedColumns,
      completeFilters().map((filter) => [filter.field, filter.value]),
    ]);
  }

  function renderReady() {
    if (!tableInfo) {
      renderEmpty(
        "Find a record without loading a full table list.",
        favorites.length
          ? "Choose a starred table, or type two characters to query a bounded set of matching table labels and names."
          : "Type two characters to query a bounded set of matching table labels and names."
      );
      return;
    }
    renderEmpty(
      "Search " + (tableInfo.label || tableInfo.table) + ".",
      "Type text or an exact sys_id, or choose a filter value. The results update as you go."
    );
  }

  /* Reported: switching tables left the old table's records on screen. A
   * table change starts over, and nothing asked of the old table is kept. */
  function resetResults() {
    clearTimeout(searchTimer);
    searchTimer = null;
    searchQueued = false;
    lastRequestKey = "";
    atReady = true;
    renderReady();
  }

  /* Results answer one question. When the controls stop asking it, the
   * answer is withdrawn rather than left under a different question, and a
   * read still out for it is dropped. The caller renders the rows. */
  function withdrawResults(message, kind) {
    requestSequence += 1;
    searchQueued = false;
    lastRequestKey = "";
    lastResult = null;
    atReady = false;
    updateListButton();
    setStatus(message, kind, false);
  }

  function showReady() {
    withdrawResults(
      "Ready · " + (selectedTable.label || selectedTable.name) + " (" + selectedTable.name + ")", ""
    );
    atReady = true;
    renderReady();
  }

  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchIfChanged, AUTO_SEARCH_DELAY_MS);
  }

  /*
   * The automatic search, after a pause in typing, a filter value, a field
   * change or a clear. The term is judged by the engine's own parseSearch, so
   * a pause mid-word says what is needed instead of drawing the validation
   * error that Enter would. A question already asked is not asked again;
   * Enter and Search always ask.
   */
  function searchIfChanged() {
    clearTimeout(searchTimer);
    searchTimer = null;
    if (!shadow || !selectedTable || !tableInfo) return;
    const term = termValue();
    const filters = completeFilters();
    if (!term && !filters.length) {
      if (!atReady) showReady();
      return;
    }
    if (term) {
      const parsed = engine().parseSearch(selectedTable.name, term);
      if (!parsed.ok) {
        withdrawResults(parsed.error, "");
        renderEmpty("Keep typing to search.",
          filters.length ? "Or clear the text to search by the filters alone." : "");
        return;
      }
      if (!parsed.isSysId && !selectedFields.size) {
        withdrawResults("Select at least one verified field for a text search.", "validation");
        renderEmpty("No fields are selected.", "Choose fields to search this text, or use an exact sys_id.");
        return;
      }
    }
    if (currentRequestKey() === lastRequestKey) return;
    submit();
  }

  /* A search disables every control but the text box, and a disabled
   * control loses focus. Only an orphaned focus is put back, quietly, so no
   * list reopens. A control the search replaced or removed -- a result row,
   * a filter row a table change dropped -- hands focus to the text box
   * instead, since focusing a detached node would leave it on the page. */
  function restoreFocus(node) {
    if (!shadow || !node || shadow.activeElement) return;
    /* A row in a picker closed meanwhile (Escape during the search) is
     * connected and enabled but not rendered, so focusing it does nothing;
     * its picker's button takes focus instead. */
    const picker = node.closest ? node.closest(".field-picker") : null;
    const list = picker ? node.closest("[role='group']") : null;
    const target = node.isConnected === false || node.disabled || node.hidden
      ? shadow.querySelector("[data-input='term']")
      : list && list.hidden ? picker.querySelector("button") : node;
    const owner = Object.keys(combos).map((key) => combos[key])
      .find((combo) => combo && combo.input === target);
    if (owner) {
      owner.focusQuietly();
      return;
    }
    quietFocus = true;
    try { target.focus(); } finally { quietFocus = false; }
  }

  /* Counted rather than tied to the winning sequence: a read superseded by a
   * newer question must still release the controls. */
  function finishSearch() {
    searchesInFlight = Math.max(0, searchesInFlight - 1);
    if (searchesInFlight || !shadow) return;
    setSearchBusy(false);
    if (searchQueued) {
      searchQueued = false;
      searchIfChanged();
      if (searchesInFlight) return;
    }
    restoreFocus(searchFocus);
    searchFocus = null;
  }

  async function submit() {
    if (!shadow || !onSearch) return;
    /* Asking now makes a pending pause redundant. */
    clearTimeout(searchTimer);
    searchTimer = null;
    if (!selectedTable || !tableInfo) {
      setStatus("Choose a verified table before searching.", "validation", false);
      return;
    }
    const term = termValue();
    const isSysId = /^[0-9a-f]{32}$/i.test(term);
    /* Only complete rows are applied. The rest are counted on the status
     * line, never dropped silently -- with remembered filter fields, an
     * empty row is routine, so the wording stays neutral. */
    const filters = completeFilters();
    const pendingRows = filterRows.length - filters.length;
    if (!term && !filters.length) {
      setStatus(
        pendingRows
          ? "Choose a value for the filter, or enter text or a sys_id."
          : "Enter text or a sys_id, or add a filter.",
        "validation",
        false
      );
      return;
    }
    if (term && !isSysId && !selectedFields.size) {
      setStatus("Select at least one verified field for a text search.", "validation", false);
      return;
    }
    /*
     * One search at a time. Any table can be searched, some are large enough
     * for a LIKE read to take seconds, and a superseded read still runs on
     * the instance. A question asked meanwhile waits for the read out, whose
     * answer is dropped, and only the latest waiting question is asked.
     */
    if (searchesInFlight) {
      searchQueued = true;
      lastRequestKey = "";
      requestSequence += 1;
      return;
    }
    const owner = host;
    const sequence = ++requestSequence;
    lastRequestKey = currentRequestKey();
    atReady = false;
    if (!searchFocus) searchFocus = shadow.activeElement || null;
    searchesInFlight += 1;
    setSearchBusy(true);
    lastResult = null;
    updateListButton();
    closeAllCombos();
    setStatus(
      filters.length
        ? "Searching with " + filters.length + (filters.length === 1 ? " filter" : " filters") +
          " and checking every returned match…"
        : "Searching the selected verified fields and checking every returned match…",
      "",
      true
    );
    renderEmpty("Searching…", "Results are read-only and stay in this panel.");
    try {
      /* The same remembered list the table was resolved with, so the search
       * verifies its fields against the same live read. */
      const requested = (value) => (value && Array.isArray(value.requested) ? value.requested.slice() : []);
      const result = await onSearch({
        table: selectedTable.name,
        term,
        fields: Array.from(selectedFields),
        rememberedFields: requested(tableInfo.remembered),
        columns: selectedColumns.slice(),
        rememberedColumns: requested(tableInfo.rememberedColumns),
        filters,
      });
      if (sequence !== requestSequence || !result || result.stale) return;
      renderResults(result, pendingRows);
    } catch (error) {
      if (sequence !== requestSequence) return;
      /* A failed question is not an answered one: the next change asks again. */
      lastRequestKey = "";
      const message = String(error && error.message ? error.message : error);
      setStatus(message, errorKind(error), false);
      renderEmpty("The search could not run.", message);
    } finally {
      if (owner === host) finishSearch();
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
    clearTimeout(searchTimer);
    searchTimer = null;
    lastRequestKey = "";
    atReady = true;
    searchesInFlight = 0;
    searchQueued = false;
    searchFocus = null;
    if (onCancel) onCancel();
    Object.keys(combos).forEach((key) => combos[key].destroy());
    filterRows = [];
    filterRowSequence = 0;
    selectionSequence += 1;
    filterRestorePending = "";
    filterSaveDeferred = false;
    if (keydownHandler) window.removeEventListener("keydown", keydownHandler, true);
    if (host) host.remove();
    host = null;
    shadow = null;
    keydownHandler = null;
    onFindTables = null;
    onResolveTable = null;
    onSearch = null;
    onCancel = null;
    onFavoriteOp = null;
    favorites = [];
    favoriteBusy = false;
    tableError = false;
    unsavedFavorites = new Set();
    unsavedFilterFavorites = new Set();
    unsavedColumnFavorites = new Set();
    onFilterFields = null;
    onFilterValues = null;
    tableOptions = [];
    activeTableIndex = -1;
    selectedTable = null;
    tableInfo = null;
    selectedFields = new Set();
    selectedColumns = [];
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
    onFavoriteOp = typeof opts.onFavoriteOp === "function" ? opts.onFavoriteOp : null;
    onFilterFields = typeof opts.onFilterFields === "function" ? opts.onFilterFields : null;
    onFilterValues = typeof opts.onFilterValues === "function" ? opts.onFilterValues : null;
    favorites = cleanFavorites(opts.favorites);
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
                  <button class="combo-clear" type="button" data-clear="table" aria-label="Clear table" hidden>✕</button>
                  <span class="table-menu" id="snh-rs-table-menu" role="listbox" hidden></span>
                </span>
              </label>
              <label>Text or sys_id
                <span class="clearable">
                  <input data-input="term" placeholder="number, name, email, or exact sys_id · optional with a filter"
                    autocomplete="off" spellcheck="false">
                  <button class="combo-clear" type="button" data-clear="term" aria-label="Clear text or sys_id" hidden>✕</button>
                </span>
              </label>
              <button class="search-btn" type="submit">Search</button>
            </div>
            <div class="field-line">
              <div class="field-picker" data-picker="fields">
                <button class="fields-button" type="button" aria-controls="snh-rs-field-menu"
                  aria-expanded="false" disabled>Search 0 fields</button>
                <div class="field-menu" id="snh-rs-field-menu" role="group"
                  aria-label="Fields to search" hidden></div>
              </div>
              <div class="field-picker" data-picker="columns">
                <button class="columns-button" type="button" aria-controls="snh-rs-column-menu"
                  aria-expanded="false" disabled>Show 0 columns</button>
                <div class="column-menu" id="snh-rs-column-menu" role="group"
                  aria-label="Columns to show" hidden></div>
              </div>
              <button class="star-btn" type="button" aria-label="Star this table"
                aria-pressed="false" hidden disabled><span class="star-glyph" aria-hidden="true">☆</span> Star</button>
              <div class="field-summary">Choose a table to load verified fields.</div>
            </div>
            <div class="filters" hidden>
              <div class="filter-rows"></div>
              <button class="add-filter" type="button">+ Add filter</button>
            </div>
          </form>
          <div class="status" role="status" aria-live="polite">Search for a table to begin.</div>
          <div class="rows"></div>
          <footer class="toolbar">
            <span class="toolbar-note">Read-only · at most 20 verified results · no record or search history is stored · starred tables, with their fields and columns, are kept on this device</span>
            <button type="button" data-action="open-list" disabled>Open results in list</button>
            <button type="button" data-action="close">Close</button>
          </footer>
        </section>
      </div>`;

    renderFieldControl();
    renderReady();
    const tableInput = shadow.querySelector("[data-input='table']");
    tableInput.addEventListener("input", () => {
      if (!selectedTable || tableInput.value.trim() !== selectedTable.name) {
        clearTableSelection();
      }
      refreshClearButtons();
      scheduleTableLookup();
    });
    /* Searches when typing pauses; Enter and Search still ask at once. */
    shadow.querySelector("[data-input='term']").addEventListener("input", () => {
      refreshClearButtons();
      scheduleSearch();
    });
    /* A press keeps focus in the box, as the filter pickers' ✕ does. */
    shadow.querySelectorAll("[data-clear]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", button.dataset.clear === "table" ? clearTableByUser : clearTermByUser);
    });
    /* Focus handed back after a search must not reopen the menu. */
    tableInput.addEventListener("focus", () => { if (!quietFocus) openTableMenu(false); });
    tableInput.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (shadow.querySelector(".table-menu").hidden) openTableMenu(true);
        if (tableOptions.length) {
          setActiveTable(activeTableIndex + (event.key === "ArrowDown" ? 1 : -1));
        }
      } else if (event.key === "Enter" && !shadow.querySelector(".table-menu").hidden &&
        activeTableIndex >= 0 && activeTableIndex < tableOptions.length) {
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
    /* Opening sorts what is ticked to the top and puts the cursor in the
     * find box, so a long list can be narrowed straight away. */
    const focusFind = (menuSelector) => {
      const find = shadow.querySelector(menuSelector + " .picker-find");
      if (find) find.focus();
    };
    shadow.querySelector(".fields-button").addEventListener("click", () => {
      const open = shadow.querySelector(".field-menu").hidden;
      setColumnMenu(false);
      if (open) arrangeFieldPicker();
      setFieldMenu(open);
      if (open) focusFind(".field-menu");
    });
    shadow.querySelector(".columns-button").addEventListener("click", () => {
      const open = shadow.querySelector(".column-menu").hidden;
      setFieldMenu(false);
      if (open) arrangeColumnPicker();
      setColumnMenu(open);
      if (open) focusFind(".column-menu");
    });
    shadow.querySelector(".star-btn").addEventListener("click", toggleStar);
    shadow.querySelector(".add-filter").addEventListener("click", () => {
      const row = addFilterRow();
      if (row) row.field.focusAndOpen();
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
      const picker = event.target.closest(".field-picker");
      const which = picker ? picker.dataset.picker : "";
      if (which !== "fields") setFieldMenu(false);
      if (which !== "columns") setColumnMenu(false);
    });
    const overlay = shadow.querySelector(".overlay");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    keydownHandler = (event) => {
      if (event.key !== "Escape" || !host) return;
      const tableMenuOpen = !shadow.querySelector(".table-menu").hidden;
      /* Every open menu closes before Escape may close the panel, filter
       * pickers and both field pickers included. */
      if (tableMenuOpen || anyPickerOpen() || anyComboOpen()) {
        const focused = shadow.activeElement;
        const picker = focused && focused.closest(".field-picker");
        setTableMenu(false);
        setFieldMenu(false);
        setColumnMenu(false);
        closeAllCombos();
        /* Focus in a closing picker goes back to its button, not nowhere. */
        if (picker) picker.querySelector("button").focus();
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
      if (opts.favoritesUnavailable) {
        setStatus("Starred tables could not be read right now · type to find a table.", "transient", false);
      } else if (favorites.length && shadow.querySelector(".table-menu").hidden) {
        showFavoriteTables();
      }
    }
  }

  globalThis.SNRecordSearchUI = {
    open,
    close,
    isOpen: () => Boolean(host),
  };
})();

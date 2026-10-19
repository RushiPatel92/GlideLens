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
  /* The same rule for a favourite's remembered filter fields. */
  let unsavedFilterFavorites = new Set();
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
  let lastResult = null;
  let searchBusy = false;

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
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
      clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .search-btn,.toolbar button,.fields-button,.star-btn,.result-action{border:1px solid #5b5b86;
      background:#3f4067;color:#e6e6f5;border-radius:7px;padding:8px 13px;cursor:pointer;font-size:12px}
    .search-btn{background:var(--pink);border-color:var(--pink);color:#2a0d1a;
      font-weight:650;height:36px}.search-btn:hover{background:#ff85bb}
    button:disabled{opacity:.48;cursor:default}
    .field-line{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:10px;align-items:center;
      margin-top:11px}.field-picker{position:relative}.fields-button{min-width:126px;text-align:left}
    .field-line .field-summary{grid-column:3}
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
      .field-line{grid-template-columns:1fr}.field-line .field-summary{grid-column:auto}
      .filter-row{grid-template-columns:1fr}
      .fields-button,.star-btn{width:100%}.sys-id{display:none}}
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
   * Unlike Impersonate, a pick never searches: Record Lens searches on
   * Search, as it always has.
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
        if (how === "pick") row.value.focusAndOpen();
        if (how !== "edit") saveFavoriteFilterFields();
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
      onSelect: () => {
        lastResult = null;
        updateListButton();
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
    lastResult = null;
    clearFilterRows();
    renderFieldControl();
    updateListButton();
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
    lastResult = null;
    clearFilterRows();
    shadow.querySelector("[data-input='table']").value = option.name;
    setTableMenu(false);
    renderFieldControl();
    updateListButton();
    const sequence = ++requestSequence;
    /* A favourite's remembered fields are only names. Each one must be
     * confirmed by its own live dictionary row before it is applied. */
    const favorite = favoriteFor(option.name);
    const rememberedFields = favorite ? favorite.fields.slice() : [];
    setStatus(
      (detected ? "Detected " : "Checking ") + option.name + " and reading its live dictionary…",
      "",
      true
    );
    try {
      const info = await onResolveTable(option.name, { rememberedFields });
      if (!shadow || sequence !== requestSequence || !info) return;
      tableInfo = info;
      selectedTable = { name: info.table, label: info.label || info.table };
      const remembered = info.remembered || {};
      const verified = Array.isArray(remembered.verified) ? remembered.verified : [];
      const absent = Array.isArray(remembered.absent) ? remembered.absent : [];
      const unverifiable = Array.isArray(remembered.unverifiable) ? remembered.unverifiable : [];
      const useRemembered = verified.length > 0 && !unverifiable.length;
      if (unverifiable.length) unsavedFavorites.add(info.table);
      selectedFields = new Set(useRemembered
        ? verified
        : (info.defaultFields || []).map((field) => field.name));
      renderFieldControl();
      let readyText;
      let readyKind;
      if (!info.fields || !info.fields.length) {
        readyText = "The table is readable, but no searchable text fields were verified. " +
          "Exact sys_id lookup and filters can still run.";
        readyKind = "schema";
      } else {
        readyText =
          "Ready · " + selectedTable.label + " (" + selectedTable.name + ") · " +
            selectedFields.size + (selectedFields.size === 1 ? " field selected" : " fields selected") +
            (useRemembered ? " · this favourite's remembered fields" : "") +
            (absent.length
              ? " · no longer on this table: " + absent.join(", ") +
                " (dropped when its fields are next saved)"
              : "") +
            (unverifiable.length
              ? " · the remembered fields could not be verified right now, so defaults apply" +
                " and nothing is saved for this favourite until Record Lens is reopened"
              : "");
        readyKind = absent.length || unverifiable.length ? "validation" : "";
      }
      setStatus(readyText, readyKind, false);
      shadow.querySelector("[data-input='term']").focus();
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
        const statusFree = sequence === requestSequence;
        if (statusFree && restored.note) {
          setStatus(
            readyText + restored.note,
            readyKind || (/could not|not restored|no longer/.test(restored.note) ? "validation" : ""),
            false
          );
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
    } catch (error) {
      if (!shadow || sequence !== requestSequence) return;
      tableInfo = null;
      tableError = true;
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
      : "Star this table to list it, with its fields, when the table box is empty";
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
        : "Starred " + name + " · it is listed, with these search fields, when the table box is empty.") +
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
        saveFavoriteFields();
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
    Object.keys(combos).forEach((key) => combos[key].setBusy(searchBusy));
    filterRows.forEach((row) => setDisabled(row.remove, searchBusy));
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
      renderEmpty(
        filterCount ? "No verified matches for these filters." : "No verified matches in the selected fields.",
        filterCount
          ? "Try another value, remove a filter, or change the text."
          : "Try another term, select different verified fields, or use an exact sys_id."
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
    /* Only complete rows are applied. The rest are counted on the status
     * line, never dropped silently -- with remembered filter fields, an
     * empty row is routine, so the wording stays neutral. */
    const complete = filterRows.filter((row) => row.field.selected && row.value.selected);
    const pendingRows = filterRows.length - complete.length;
    const filters = complete.map((row) => ({
      field: row.field.selected.value,
      value: row.value.selected.value,
    }));
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
    const sequence = ++requestSequence;
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
      const remembered = tableInfo.remembered && Array.isArray(tableInfo.remembered.requested)
        ? tableInfo.remembered.requested
        : [];
      const result = await onSearch({
        table: selectedTable.name,
        term,
        fields: Array.from(selectedFields),
        rememberedFields: remembered.slice(),
        filters,
      });
      if (sequence !== requestSequence || !result || result.stale) return;
      renderResults(result, pendingRows);
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
    onFilterFields = null;
    onFilterValues = null;
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
                  <span class="table-menu" id="snh-rs-table-menu" role="listbox" hidden></span>
                </span>
              </label>
              <label>Text or sys_id
                <input data-input="term" placeholder="number, name, email, or exact sys_id · optional with a filter"
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
            <span class="toolbar-note">Read-only · at most 20 verified results · no record or search history is stored · starred tables and their fields are kept on this device</span>
            <button type="button" data-action="open-list" disabled>Open results in list</button>
            <button type="button" data-action="close">Close</button>
          </footer>
        </section>
      </div>`;

    renderFieldControl();
    renderEmpty(
      "Find a record without loading a full table list.",
      favorites.length
        ? "Choose a starred table, or type two characters to query a bounded set of matching table labels and names."
        : "Type two characters to query a bounded set of matching table labels and names."
    );
    const tableInput = shadow.querySelector("[data-input='table']");
    tableInput.addEventListener("input", () => {
      if (!selectedTable || tableInput.value.trim() !== selectedTable.name) {
        clearTableSelection();
      }
      scheduleTableLookup();
    });
    tableInput.addEventListener("focus", () => openTableMenu(false));
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
    shadow.querySelector(".fields-button").addEventListener("click", () => {
      const menu = shadow.querySelector(".field-menu");
      setFieldMenu(menu.hidden);
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
      /* Every open menu closes before Escape may close the panel, filter
       * pickers included. */
      if (tableMenuOpen || fieldMenuOpen || anyComboOpen()) {
        setTableMenu(false);
        setFieldMenu(false);
        closeAllCombos();
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

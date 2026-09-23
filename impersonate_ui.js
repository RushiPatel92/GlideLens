/*
 * Isolated-world Impersonate panel. Closed shadow root, Record Lens visual
 * language, and the Record Lens keyboard model: a combobox owning a listbox
 * with stable option ids and aria-activedescendant, arrow keys, Home/End,
 * Enter and Escape.
 *
 * Every value is assigned with textContent. Unlike Record Lens and Code
 * Search, this panel has NO innerHTML at all -- not even for its static shell.
 * The two most recently built panels (Translation Lens and Translation
 * Assistant) already dropped it, and here the values on screen are real
 * people's names, titles and email addresses read from an instance we do not
 * control. Leaving no markup path at all is one fewer thing for a test to have
 * to prove is static.
 *
 * The panel never impersonates. It collects a choice, shows a confirmation,
 * and calls back; the POST lives in background.js.
 */
(() => {
  if (globalThis.SNImpersonateUI) return;

  const HOST_ID = "sn-dev-helper-impersonate";

  let host = null;
  let shadow = null;
  let els = null;
  let keydownHandler = null;
  let callbacks = {};

  let searchSequence = 0;
  let mutationSequence = 0;
  let results = [];
  let lastResultForRedraw = null;
  let confirming = null;
  let confirmOpener = null;
  let mutationInFlight = false;
  let searchBusy = false;
  let searchesInFlight = 0;

  const combos = {};

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
    .current{display:flex;align-items:center;gap:12px;padding:12px 20px;
      border-bottom:1px solid #292944;background:#2a2340}
    .current-text{flex:1;min-width:0;font-size:12px;line-height:1.5;color:#f0e3f6}
    .current-name{font-weight:650;color:#fff}
    .current-id{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#c9b6d8}
    .current-note{display:block;margin-top:3px;color:#b7a7c6;font-size:11px}
    .form{padding:14px 20px;border-bottom:1px solid #292944;background:var(--raised)}
    .form-main{display:grid;grid-template-columns:minmax(260px,1.4fr) auto;gap:10px;align-items:end}
    .filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:11px}
    label,.field-label{display:flex;flex-direction:column;gap:5px;color:#bdbdd0;
      font-size:11px;font-weight:600;min-width:0}
    input{width:100%;background:#151522;border:1px solid #555578;border-radius:7px;
      color:#f0f0fa;outline:none;padding:9px 10px;font-size:13px;font-weight:400}
    input:focus{border-color:var(--teal);background:#191929;box-shadow:0 0 0 3px rgba(49,212,196,.12)}
    input::placeholder{color:#797993}input:disabled{opacity:.5}
    .combo{position:relative}
    .menu{position:absolute;left:0;right:0;top:calc(100% + 5px);z-index:5;max-height:270px;
      overflow:auto;background:#171724;border:1px solid #565681;border-radius:8px;
      box-shadow:0 16px 38px rgba(0,0,0,.55);padding:5px}
    .menu[hidden]{display:none}
    .option{display:grid;grid-template-columns:minmax(0,1fr);gap:3px;width:100%;padding:9px;
      border:1px solid transparent;border-radius:6px;background:transparent;color:#ececf7;
      text-align:left;cursor:pointer}
    .option:hover,.option.active{background:#2c2d49;border-color:#4d5079}
    .option.active{box-shadow:inset 3px 0 0 var(--teal)}
    .option-label{font-size:12px;font-weight:650;line-height:1.35;overflow-wrap:anywhere}
    .option-hint{color:#9494af;line-height:1.35;
      font:10px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
    .menu-message{padding:11px;color:#9999b1;font-size:11px;line-height:1.4}
    .search-btn{border:1px solid var(--pink);background:var(--pink);color:#2a0d1a;
      border-radius:7px;padding:8px 16px;cursor:pointer;font-size:12px;font-weight:650;height:36px}
    .search-btn:hover:not(:disabled){background:#ff85bb}
    button:disabled{opacity:.48;cursor:default}
    .status{min-height:40px;display:flex;align-items:center;gap:9px;padding:9px 20px;
      border-bottom:1px solid #292944;color:#aaaac1;font-size:11px;line-height:1.45}
    .status.validation{color:#efc48f}.status.empty{color:#c2c2d2}
    .status.access,.status.schema,.status.transient,.status.indeterminate{color:#ef9b9b}
    .status.success{color:#8fe0cf}
    .spinner{width:12px;height:12px;border-radius:50%;border:2px solid #45456b;flex:none;
      border-top-color:var(--teal);animation:spin .7s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){.spinner{animation:none}}
    .body{flex:1;overflow:auto;padding:6px 0}
    .empty{padding:46px 20px;text-align:center;color:var(--muted);font-size:13px;line-height:1.5}
    .empty small{display:block;margin-top:7px;color:#74748d}
    .row{position:relative;padding:12px 20px;border-bottom:1px solid #282841;outline:none}
    .row:hover{background:#282842}
    .row:focus-visible{outline:2px solid var(--teal);outline-offset:-2px;background:#282842}
    .row-top{display:flex;align-items:baseline;gap:10px;margin-bottom:6px;flex-wrap:wrap}
    .title{color:#f0f0fa;font-size:13px;font-weight:650;min-width:0;overflow-wrap:anywhere}
    .user-id{color:#9c9cba;font:11px ui-monospace,SFMono-Regular,Consolas,monospace}
    .badge{margin-left:auto;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:650;
      border:1px solid #4d5079;color:#c8c8e0;background:#2a2b47}
    .badge.direct{border-color:#31d4c4;color:#9ff0e5}
    .values{display:flex;flex-wrap:wrap;gap:5px 12px;color:#aaaac1;font-size:11px;line-height:1.5}
    .value-label{color:#75758e}
    .row-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
    .row-action{border:1px solid #5b5b86;background:#30314f;color:#e6e6f5;border-radius:7px;
      padding:4px 9px;cursor:pointer;font-size:10px}
    .row-action:hover:not(:disabled){background:#45466e;color:#fff}
    .row-action.primary{background:var(--pink);border-color:var(--pink);color:#2a0d1a;font-weight:650}
    .row-action.primary:hover:not(:disabled){background:#ff85bb}
    .confirm{padding:26px 24px;max-width:620px;margin:0 auto}
    .confirm h3{margin:0 0 10px;font-size:15px;color:#f5f5ff}
    .confirm-warn{margin:0 0 16px;font-size:12px;line-height:1.55;color:#efc48f}
    .confirm-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 14px;
      font-size:12px;line-height:1.5;margin:0 0 18px}
    .confirm-facts dt{color:#8f8fa9}
    .confirm-facts dd{margin:0;color:#ececf7;overflow-wrap:anywhere}
    .confirm-actions{display:flex;gap:10px;flex-wrap:wrap}
    .confirm-actions button{border-radius:7px;padding:9px 16px;cursor:pointer;font-size:12px;
      border:1px solid #5b5b86;background:#3f4067;color:#e6e6f5}
    .confirm-actions .go{background:var(--pink);border-color:var(--pink);color:#2a0d1a;font-weight:650}
    .confirm-actions .go:hover:not(:disabled){background:#ff85bb}
    .confirm-state{margin-top:16px;font-size:12px;line-height:1.55;color:#c2c2d2;
      display:flex;align-items:center;gap:9px}
    .confirm-state.indeterminate,.confirm-state.error{color:#ef9b9b}
    .confirm-state.success{color:#8fe0cf}
    .toolbar{display:flex;align-items:center;gap:8px;padding:11px 16px;border-top:1px solid #2e2e4e;
      background:#20203a}
    .toolbar-note{flex:1;color:#85859d;font-size:11px;line-height:1.45}
    .toolbar button{border:1px solid #5b5b86;background:#3f4067;color:#e6e6f5;border-radius:7px;
      padding:8px 13px;cursor:pointer;font-size:12px}
    .toolbar button:hover:not(:disabled){background:#4a4b78;color:#fff}
    .stop-btn{border:1px solid #ff6fae;background:#3a2338;color:#ffc9e1;border-radius:7px;
      padding:7px 13px;cursor:pointer;font-size:12px;font-weight:650;flex:none}
    .stop-btn:hover:not(:disabled){background:#4d2c48;color:#fff}
    @media(max-width:680px){.overlay{padding:8px}.panel{width:100%;height:calc(100vh - 16px)}
      .form-main{grid-template-columns:1fr}.filters{grid-template-columns:1fr}
      .search-btn{width:100%}.header{padding:14px}.user-id{display:block}}
  `;

  /* ------------------------------------------------------------------ *
   * Element helpers. No markup path exists, so there is nothing for a
   * value to escape from.
   * ------------------------------------------------------------------ */

  function el(tag, className, textContent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent != null) node.textContent = String(textContent);
    return node;
  }

  function clear(node) {
    if (node) node.textContent = "";
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

  function errorKind(error) {
    const code = String((error && error.code) || "");
    return ["validation", "access", "schema", "empty", "transient", "indeterminate"].includes(code)
      ? code : "transient";
  }

  function errorMessage(error) {
    return String((error && error.message) ? error.message : error);
  }

  /* ------------------------------------------------------------------ *
   * Combobox
   * ------------------------------------------------------------------ */

  /*
   * One implementation for all four pickers. The role and group pickers query
   * the instance, the attribute field picker filters a list already discovered,
   * and the attribute value picker filters a loaded list or queries when that
   * list was capped -- a `load` function is the only difference between them.
   */
  function createCombo(config) {
    const state = {
      options: [],
      /* Held separately from menu.children, because a trailing "more exist"
       * note is a child too and must never be reachable as an option. */
      optionNodes: [],
      activeIndex: -1,
      selected: null,
      open: false,
      sequence: 0,
      timer: null,
      disabled: false,
      /* Some controls have a precondition of their own -- the value picker is
       * meaningless before a field is chosen -- and a busy search unlocking
       * must not override it. */
      blocked: false,
      blockedReason: "",
    };
    const wrap = el("label", null);
    wrap.appendChild(el("span", null, config.label));
    const combo = el("span", "combo");
    const input = el("input");
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
    combo.appendChild(input);
    combo.appendChild(menu);
    wrap.appendChild(combo);

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
      });
      input.setAttribute("aria-activedescendant", optionId(state.activeIndex));
    }

    function renderOptions(message) {
      clear(menu);
      state.optionNodes = [];
      if (message || !state.options.length) {
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

    function select(option) {
      state.selected = option || null;
      input.value = option ? option.label : "";
      setOpen(false);
      if (config.onSelect) config.onSelect(option || null);
    }

    function clearSelection(silent) {
      state.selected = null;
      state.options = [];
      state.optionNodes = [];
      state.activeIndex = -1;
      input.value = "";
      clear(menu);
      setOpen(false);
      /* A clear driven by another control must not re-enter that control's
       * own onSelect and clear it back again. */
      if (!silent && config.onSelect) config.onSelect(null);
    }

    async function lookup() {
      if (state.disabled || !config.load) return;
      const sequence = ++state.sequence;
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
        state.options = [];
        renderOptions(errorMessage(error));
      }
    }

    function scheduleLookup() {
      clearTimeout(state.timer);
      state.timer = setTimeout(lookup, 180);
    }

    input.addEventListener("input", () => {
      /* A typed character invalidates the selection: the text no longer
       * names what is bound, and a stale sys_id must not survive into a
       * query built from what the input now reads. */
      if (state.selected && input.value !== state.selected.label) {
        state.selected = null;
        if (config.onSelect) config.onSelect(null);
      }
      scheduleLookup();
    });
    input.addEventListener("focus", () => {
      if (state.disabled) return;
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
      } else if (key === "Enter" && state.open && state.activeIndex >= 0 && state.options.length) {
        event.preventDefault();
        select(state.options[state.activeIndex]);
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
      input.setAttribute(
        "placeholder",
        state.blocked ? (state.blockedReason || "") : (config.placeholder || "")
      );
    }

    const api = {
      node: wrap,
      input,
      menu,
      get selected() { return state.selected; },
      get isOpen() { return state.open; },
      get options() { return state.options.slice(); },
      closeMenu: () => setOpen(false),
      clearSelection,
      /* Busy is transient; blocked is a precondition. Releasing the first
       * never releases the second. */
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
    };
    combos[config.key] = api;
    return api;
  }

  function anyMenuOpen() {
    return Object.keys(combos).some((key) => combos[key] && combos[key].isOpen);
  }

  function closeAllMenus() {
    Object.keys(combos).forEach((key) => combos[key] && combos[key].closeMenu());
  }

  /* ------------------------------------------------------------------ *
   * Status and body
   * ------------------------------------------------------------------ */

  function setStatus(message, kind, loading) {
    if (!els) return;
    clear(els.status);
    els.status.className = "status" + (kind ? " " + kind : "");
    if (loading) {
      const spinner = el("span", "spinner");
      spinner.setAttribute("aria-label", "Loading");
      els.status.appendChild(spinner);
    }
    els.status.appendChild(el("span", null, String(message || "")));
  }

  function renderEmpty(message, hint) {
    if (!els) return;
    clear(els.body);
    const empty = el("div", "empty", message);
    if (hint) empty.appendChild(el("small", null, hint));
    els.body.appendChild(empty);
  }

  /* ------------------------------------------------------------------ *
   * Current state and Stop
   * ------------------------------------------------------------------ */

  function showCurrentState(state) {
    if (!els) return;
    clear(els.current);
    const impersonating = Boolean(state && state.isImpersonating);
    /* Absent entirely when not impersonating: there is nothing to say and
     * nothing to stop. */
    setHidden(els.current, !impersonating);
    if (!impersonating) return;

    const textWrap = el("div", "current-text");
    if (state.currentUserName) {
      textWrap.appendChild(document.createTextNode("You are impersonating "));
      const displayName = String(state.displayName || "").trim();
      textWrap.appendChild(el("span", "current-name", displayName || state.currentUserName));
      /* The user ID is a second line of evidence, not a repetition. When the
       * page offers no friendly name — or offers the user ID as one, which is
       * what a live PDI did — showing it twice reads as a rendering fault. */
      if (displayName && displayName !== state.currentUserName) {
        textWrap.appendChild(document.createTextNode(" — "));
        textWrap.appendChild(el("span", "current-id", state.currentUserName));
      }
    } else {
      textWrap.appendChild(document.createTextNode("You are impersonating another user."));
      textWrap.appendChild(el(
        "small",
        "current-note",
        state.inconclusive
          ? "This page did not answer in time, so GlideLens cannot say who."
          : "This page does not expose the current user ID."
      ));
    }
    els.current.appendChild(textWrap);

    if (state.hasStopTarget) {
      const stop = el("button", "stop-btn", "Stop impersonating");
      stop.setAttribute("type", "button");
      setDisabled(stop, mutationInFlight || searchBusy);
      stop.addEventListener("click", () => requestStop());
      els.current.appendChild(stop);
    } else {
      /* Never a guess. When no original is recoverable the block says so and
       * points at the platform's own way back. */
      els.current.appendChild(el(
        "small",
        "current-note",
        "GlideLens does not know which account to return to. Use the ServiceNow user menu to end impersonation."
      ));
    }
  }

  /* ------------------------------------------------------------------ *
   * Results
   * ------------------------------------------------------------------ */

  function rowNodes() {
    if (!els) return [];
    return Array.from(els.body.children).filter((node) => node.className === "row");
  }

  function moveRowFocus(current, direction) {
    const rows = rowNodes();
    const index = rows.indexOf(current);
    if (!rows.length || index < 0) return;
    const next = direction === "home" ? 0
      : direction === "end" ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, index + direction));
    rows[next].focus();
  }

  function resultSummary(result) {
    const shown = (result.results || []).length;
    const parts = [];
    if ((result.order === "role-first" || result.order === "group-first") &&
      result.membershipCapped) {
      /* A capped membership read claims no total, eligible or otherwise. */
      parts.push("Showing " + shown + " of the first " +
        (globalThis.SNImpersonate ? globalThis.SNImpersonate.MEMBERSHIP_LIMIT : 100) +
        " found — add a name to narrow");
    } else if (typeof result.eligibleTotal === "number") {
      parts.push(result.eligibleTotal + (result.eligibleTotal === 1
        ? " eligible user" : " eligible users"));
      if (result.eligibleTotal > shown) parts.push("showing " + shown);
    } else {
      parts.push(shown + (shown === 1 ? " eligible user" : " eligible users"));
    }
    if (result.truncated && !result.membershipCapped &&
      typeof result.eligibleTotal !== "number") {
      parts.push("more may exist — narrow the search");
    }
    return parts.join(" · ");
  }

  function showResults(result) {
    if (!els || !result) return;
    results = Array.isArray(result.results) ? result.results : [];
    /* Recorded here rather than where a search happens to call it, so
     * cancelling a confirmation can always put back exactly what was on
     * screen before it. */
    lastResultForRedraw = result;
    confirming = null;
    clear(els.body);

    const unavailable = [
      { filter: result.roleFilter, name: "Role" },
      { filter: result.groupFilter, name: "Group" },
    ].find((item) => item.filter && item.filter.status === "unavailable");
    if (unavailable) {
      /* Unavailable, never no-match: a candidate the cap cut off is
       * indistinguishable from one that genuinely lacks the membership. */
      setStatus(unavailable.name + " filtering is unavailable for this search.", "schema", false);
      renderEmpty(
        unavailable.name + " filtering could not be applied.",
        unavailable.filter.reason ||
          "Too many memberships came back to filter these candidates reliably."
      );
      return;
    }

    setStatus(resultSummary(result), results.length ? "" : "empty", false);
    if (!results.length) {
      renderEmpty(
        "No eligible users matched.",
        "Inactive, locked-out and web-service-only accounts are never listed, because impersonating one can end your own session."
      );
      return;
    }

    results.forEach((user, index) => {
      const row = el("div", "row");
      row.tabIndex = 0;
      row.setAttribute("role", "group");
      /* Action names disambiguate when the same display name repeats. */
      row.setAttribute("aria-label", (user.name || user.userName) + ", " + user.userName);
      row.setAttribute("data-index", String(index));

      const top = el("div", "row-top");
      top.appendChild(el("span", "title", user.name || user.userName));
      top.appendChild(el("span", "user-id", user.userName));
      if (user.membership) {
        /* The badge speaks only about the selected role, and never claims a
         * provenance: granted_by and included_in_role are empty on every
         * sampled row, so "via group X" cannot be said honestly. */
        const badge = el(
          "span",
          "badge" + (user.membership.inherited ? "" : " direct"),
          user.membership.inherited ? "Inherited role" : "Direct role"
        );
        top.appendChild(badge);
      }
      row.appendChild(top);

      const values = el("div", "values");
      const addValue = (label, value) => {
        if (!value) return;
        const item = el("span");
        item.appendChild(el("span", "value-label", label + ": "));
        item.appendChild(document.createTextNode(value));
        values.appendChild(item);
      };
      addValue("Email", user.email);
      addValue("Title", user.title);
      (user.details || []).forEach((detail) => addValue(detail.label, detail.value));
      if (values.children.length) row.appendChild(values);

      const actions = el("div", "row-actions");
      const open = el("button", "row-action", "Open user");
      open.setAttribute("type", "button");
      open.addEventListener("click", (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        if (callbacks.onOpenUser) callbacks.onOpenUser(user);
      });
      const go = el("button", "row-action primary", "Impersonate");
      go.setAttribute("type", "button");
      setDisabled(go, mutationInFlight);
      go.addEventListener("click", (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        showConfirmation(user, go);
      });
      actions.appendChild(open);
      actions.appendChild(go);
      row.appendChild(actions);

      /*
       * A row click, and Enter on the row, do NOTHING. Only the labelled
       * button enters confirmation -- a session change must never be one
       * stray keystroke away.
       */
      row.addEventListener("keydown", (event) => {
        const key = event.key;
        if (key === "ArrowDown" || key === "ArrowUp") {
          event.preventDefault();
          moveRowFocus(row, key === "ArrowDown" ? 1 : -1);
        } else if (key === "Home" || key === "End") {
          event.preventDefault();
          moveRowFocus(row, key.toLowerCase());
        }
      });
      els.body.appendChild(row);
    });
  }

  function showError(error) {
    if (!els) return;
    confirming = null;
    results = [];
    const message = errorMessage(error);
    setStatus(message, errorKind(error), false);
    renderEmpty("The search could not run.", message);
  }

  function stopButton() {
    if (!els) return null;
    return Array.from(els.current.children || [])
      .find((node) => node.className === "stop-btn") || null;
  }

  function refreshControlLocks() {
    if (!els) return;
    const busy = searchBusy || mutationInFlight;
    setDisabled(els.term, busy);
    setDisabled(els.searchButton, busy);
    Object.keys(combos).forEach((key) => {
      if (combos[key]) combos[key].setBusy(busy);
    });
    /* Stop waits for a running search like every other control: its outcome
     * is reported in the status line, which a search landing afterwards would
     * repaint. Close waits only for a request -- a search can be abandoned. */
    setDisabled(stopButton(), busy);
    (els.closeButtons || []).forEach((button) => setDisabled(button, mutationInFlight));
  }

  function showSearchBusy(busy) {
    searchBusy = Boolean(busy);
    if (!els) return;
    refreshControlLocks();
    if (searchBusy) {
      setStatus("Reading a bounded set of users and verifying every returned row…", "", true);
      if (!confirming) renderEmpty("Searching…", "Nothing is stored; results stay in this panel.");
    }
  }

  /* ------------------------------------------------------------------ *
   * Confirmation
   * ------------------------------------------------------------------ */

  function addFact(list, label, value) {
    if (!value) return;
    list.appendChild(el("dt", null, label));
    list.appendChild(el("dd", null, value));
  }

  function showConfirmation(user, opener) {
    if (!els || !user || mutationInFlight) return;
    /*
     * Entering confirmation supersedes every read already out. Without this a
     * search that was in flight when the button was pressed would land a
     * moment later and repaint the list straight over the confirmation the
     * user is reading -- and the next click would be on whatever replaced it.
     */
    searchSequence += 1;
    confirming = user;
    confirmOpener = opener || null;
    clear(els.body);

    const wrap = el("div", "confirm");
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Confirm impersonation");
    wrap.appendChild(el("h3", null, "Start impersonating this user?"));
    wrap.appendChild(el(
      "p",
      "confirm-warn",
      "This changes your ServiceNow session on the instance, not just this tab, and the platform records it. " +
        "The tab reloads once it succeeds."
    ));

    const facts = el("dl", "confirm-facts");
    addFact(facts, "Name", user.name || user.userName);
    addFact(facts, "User ID", user.userName);
    addFact(facts, "Email", user.email);
    addFact(facts, "Title", user.title);
    (user.details || []).forEach((detail) => addFact(facts, detail.label, detail.value));
    if (user.membership) {
      addFact(facts, "Selected role", user.membership.inherited
        ? "Held through inheritance" : "Granted directly");
    }
    wrap.appendChild(facts);

    const actions = el("div", "confirm-actions");
    const go = el("button", "go", "Start impersonation");
    go.setAttribute("type", "button");
    const cancel = el("button", null, "Cancel");
    cancel.setAttribute("type", "button");
    actions.appendChild(go);
    actions.appendChild(cancel);
    wrap.appendChild(actions);

    /* Assertive: the confirmation is the one place where a screen reader user
     * has to hear the outcome without going looking for it. */
    const state = el("div", "confirm-state");
    state.setAttribute("role", "alert");
    state.setAttribute("aria-live", "assertive");
    setHidden(state, true);
    wrap.appendChild(state);
    els.confirmState = state;
    els.confirmGo = go;
    els.confirmCancel = cancel;

    go.addEventListener("click", () => startMutation(user));
    cancel.addEventListener("click", () => cancelConfirmation());

    els.body.appendChild(wrap);
    setStatus("Confirm the identity before the session changes.", "validation", false);
    go.focus();
  }

  function cancelConfirmation() {
    /* Never while a request is out: cancelling would suggest it had been
     * called off, and nothing can call it off. */
    if (!els || mutationInFlight) return;
    const opener = confirmOpener;
    confirming = null;
    confirmOpener = null;
    els.confirmState = null;
    els.confirmGo = null;
    els.confirmCancel = null;
    if (lastResultForRedraw) showResults(lastResultForRedraw);
    else renderEmpty("Search for a user to impersonate.", null);
    if (opener && opener.focus) opener.focus();
  }

  function setMutationLock(locked) {
    mutationInFlight = Boolean(locked);
    if (!els) return;
    refreshControlLocks();
    setDisabled(els.confirmGo, mutationInFlight);
    setDisabled(els.confirmCancel, mutationInFlight);
    Array.from(els.body.children || []).forEach((row) => {
      Array.from(row.children || []).forEach((child) => {
        if (child.className === "row-actions") {
          Array.from(child.children || []).forEach((button) => setDisabled(button, mutationInFlight));
        }
      });
    });
  }

  function showMutationState(state) {
    if (!els) return;
    const status = String((state && state.status) || "");
    const message = String((state && state.message) || "");
    const kind = status === "success" ? "success"
      : status === "indeterminate" ? "indeterminate"
        : status === "pending" ? "" : errorKind(state && state.error);
    if (els.confirmState) {
      setHidden(els.confirmState, false);
      clear(els.confirmState);
      els.confirmState.className = "confirm-state" + (kind ? " " + kind : "");
      if (status === "pending") {
        const spinner = el("span", "spinner");
        spinner.setAttribute("aria-label", "Working");
        els.confirmState.appendChild(spinner);
      }
      els.confirmState.appendChild(el("span", null, message));
    }
    setStatus(message, kind, status === "pending");
  }

  /*
   * One confirmation causes at most one request. The lock is taken before the
   * callback is awaited and is released only for a definite, recoverable
   * failure; a success or an indeterminate outcome leaves it held, so a second
   * click, Enter, rerender or late callback cannot send another.
   */
  async function startMutation(user) {
    if (mutationInFlight || !callbacks.onImpersonate) return;
    const sequence = ++mutationSequence;
    setMutationLock(true);
    showMutationState({
      status: "pending",
      message: "Asking ServiceNow to change the session. This is not retried.",
    });
    try {
      const outcome = await callbacks.onImpersonate(user);
      if (sequence !== mutationSequence || !shadow) return;
      if (outcome && outcome.ok) {
        showMutationState({
          status: "success",
          message: "Impersonation started. Reloading this tab…",
        });
        return;
      }
      if (outcome && outcome.code === "indeterminate") {
        showMutationState({
          status: "indeterminate",
          message: outcome.message ||
            "The request may or may not have reached ServiceNow. Check the user menu; nothing was retried.",
        });
        return;
      }
      showMutationState({
        status: "error",
        error: outcome,
        message: (outcome && outcome.message) || "ServiceNow refused the session change.",
      });
      setMutationLock(false);
    } catch (error) {
      if (sequence !== mutationSequence || !shadow) return;
      /* A thrown error from the worker route is indeterminate by contract:
       * the request may already be in flight, so it is never retried and the
       * lock is never released. */
      showMutationState({
        status: "indeterminate",
        message: "The request may or may not have reached ServiceNow. Check the ServiceNow user menu; nothing was retried.",
      });
    }
  }

  async function requestStop() {
    if (mutationInFlight || !callbacks.onStop) return;
    /* Supersedes any read still out, exactly as entering a confirmation does:
     * Stop reports only in the status line, and a search landing after it
     * would replace an indeterminate warning with a result count while the
     * panel stays locked. */
    searchSequence += 1;
    const sequence = ++mutationSequence;
    setMutationLock(true);
    setStatus("Returning to your original account. This is not retried.", "", true);
    try {
      const outcome = await callbacks.onStop();
      if (sequence !== mutationSequence || !shadow) return;
      if (outcome && outcome.ok) {
        setStatus("Impersonation ended. Reloading this tab…", "success", false);
        return;
      }
      if (outcome && outcome.code === "indeterminate") {
        setStatus(
          "The request may or may not have reached ServiceNow. Check the user menu; nothing was retried.",
          "indeterminate",
          false
        );
        return;
      }
      setStatus((outcome && outcome.message) || "ServiceNow refused to end impersonation.",
        errorKind(outcome), false);
      setMutationLock(false);
    } catch (error) {
      if (sequence !== mutationSequence || !shadow) return;
      setStatus(
        "The request may or may not have reached ServiceNow. Check the ServiceNow user menu; nothing was retried.",
        "indeterminate",
        false
      );
    }
  }

  /* ------------------------------------------------------------------ *
   * Search
   * ------------------------------------------------------------------ */

  function currentAttribute() {
    const field = combos.attrField && combos.attrField.selected;
    const value = combos.attrValue && combos.attrValue.selected;
    if (!field || !value) return null;
    return { field: field.value, value: value.value, type: field.type };
  }

  async function submit() {
    if (!els || !callbacks.onSearch || mutationInFlight) return;
    const role = combos.role && combos.role.selected;
    const group = combos.group && combos.group.selected;
    const request = {
      term: els.term.value,
      roleSysId: role ? role.value : "",
      groupSysId: group ? group.value : "",
      attribute: currentAttribute(),
    };
    const sequence = ++searchSequence;
    /* Entering a search cancels a confirmation: the row it was built from is
     * about to be replaced. */
    confirming = null;
    closeAllMenus();
    /*
     * Counted rather than tied to the winning sequence. A read can be
     * superseded by a newer search OR by a confirmation, and in both cases its
     * sequence check fails -- so releasing the controls on "I am still the
     * current search" would leave them disabled for good whenever it was not.
     */
    searchesInFlight += 1;
    showSearchBusy(true);
    try {
      const result = await callbacks.onSearch(request);
      if (sequence !== searchSequence || !shadow) return;
      if (!result || result.stale) return;
      showResults(result);
    } catch (error) {
      if (sequence !== searchSequence || !shadow) return;
      showError(error);
    } finally {
      searchesInFlight = Math.max(0, searchesInFlight - 1);
      if (shadow && !searchesInFlight) showSearchBusy(false);
    }
  }

  /* ------------------------------------------------------------------ *
   * Shell
   * ------------------------------------------------------------------ */

  function buildShell() {
    const style = document.createElement("style");
    style.textContent = UI_CSS;
    shadow.appendChild(style);

    const overlay = el("div", "overlay");
    const panel = el("section", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Impersonate a user");

    const header = el("header", "header");
    const heading = el("div", "heading");
    heading.appendChild(el("h2", null, "Impersonate"));
    heading.appendChild(el(
      "p",
      "subtitle",
      "Find a user by identity, attribute, role or group. Only eligible accounts are listed, and nothing changes until you confirm."
    ));
    const closeBtn = el("button", "close", "✕ Esc");
    closeBtn.setAttribute("type", "button");
    closeBtn.setAttribute("aria-label", "Close");
    /* Inert while a request is out, as Escape and the overlay are: closing
     * would discard the only place its outcome is reported. */
    closeBtn.addEventListener("click", () => { if (!mutationInFlight) close(); });
    header.appendChild(heading);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const current = el("div", "current");
    current.setAttribute("role", "status");
    current.setAttribute("aria-live", "polite");
    setHidden(current, true);
    panel.appendChild(current);

    const form = el("form", "form");
    const main = el("div", "form-main");
    const termLabel = el("label", null);
    termLabel.appendChild(el("span", null, "Name, user ID, email, title, or sys_id"));
    const term = el("input");
    term.setAttribute("type", "text");
    term.setAttribute("placeholder", "name, user ID, email, title, or exact sys_id");
    term.setAttribute("autocomplete", "off");
    term.setAttribute("spellcheck", "false");
    termLabel.appendChild(term);
    const searchButton = el("button", "search-btn", "Search");
    searchButton.setAttribute("type", "submit");
    main.appendChild(termLabel);
    main.appendChild(searchButton);
    form.appendChild(main);

    const filters = el("div", "filters");
    const attrField = createCombo({
      key: "attrField",
      id: "snh-imp-attr-field",
      label: "Filter by field (optional)",
      placeholder: "any discovered field",
      emptyMessage: "No filterable fields are readable here.",
      loadOnFocus: true,
      load: (input) => (callbacks.onFindAttributeFields
        ? callbacks.onFindAttributeFields(input) : []),
      onSelect: (option) => {
        /*
         * Two controls, not one. Changing the FIELD discards the selected
         * value: a value from the previous field is meaningless against the
         * new one, and would otherwise reach a query as a valid-looking
         * condition on the wrong column.
         */
        combos.attrValue.cancelPending();
        combos.attrValue.clearSelection(true);
        combos.attrValue.setBlocked(!option, "choose a field first");
        /* And it discards any result built from the old pair, so a stale
         * list cannot sit under a filter that no longer produced it. */
        lastResultForRedraw = null;
        if (callbacks.onAttributeFieldChanged) callbacks.onAttributeFieldChanged(option);
      },
    });
    const attrValue = createCombo({
      key: "attrValue",
      id: "snh-imp-attr-value",
      label: "Value",
      placeholder: "choose a value",
      emptyMessage: "No values are available for that field.",
      loadOnFocus: true,
      load: (input) => (callbacks.onFindAttributeValues
        ? callbacks.onFindAttributeValues(combos.attrField.selected, input) : []),
    });
    attrValue.setBlocked(true, "choose a field first");
    const role = createCombo({
      key: "role",
      id: "snh-imp-role",
      label: "Role (optional)",
      placeholder: "role name or description",
      emptyMessage: "No matching roles.",
      load: (input) => (callbacks.onFindRoles ? callbacks.onFindRoles(input) : []),
      onSelect: (option) => {
        /* Choosing or clearing the role supersedes anything already read: the
         * list on screen was produced by a different question. */
        lastResultForRedraw = null;
        if (callbacks.onRoleChanged) callbacks.onRoleChanged(option);
      },
    });
    const group = createCombo({
      key: "group",
      id: "snh-imp-group",
      label: "Group (optional)",
      placeholder: "group name",
      emptyMessage: "No matching groups.",
      load: (input) => (callbacks.onFindGroups ? callbacks.onFindGroups(input) : []),
      onSelect: (option) => {
        /* The same rule as the role: the list on screen answered a different
         * question once the group changes. */
        lastResultForRedraw = null;
        if (callbacks.onGroupChanged) callbacks.onGroupChanged(option);
      },
    });
    /* Two pairs: the attribute's field and value belong together, and so do
     * the two memberships. */
    filters.appendChild(attrField.node);
    filters.appendChild(attrValue.node);
    filters.appendChild(role.node);
    filters.appendChild(group.node);
    form.appendChild(filters);

    form.addEventListener("submit", (event) => {
      if (event && event.preventDefault) event.preventDefault();
      submit();
    });
    panel.appendChild(form);

    const status = el("div", "status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.appendChild(el("span", null, "Enter a name, choose a role or group, or pick an attribute to begin."));
    panel.appendChild(status);

    const body = el("div", "body");
    panel.appendChild(body);

    const toolbar = el("footer", "toolbar");
    toolbar.appendChild(el(
      "span",
      "toolbar-note",
      "No search term, result, role, group or impersonation history is stored. " +
        "ServiceNow records impersonation in its own audit log."
    ));
    const closeFooter = el("button", null, "Close");
    closeFooter.setAttribute("type", "button");
    closeFooter.addEventListener("click", () => { if (!mutationInFlight) close(); });
    toolbar.appendChild(closeFooter);
    panel.appendChild(toolbar);

    overlay.appendChild(panel);
    overlay.addEventListener("click", (event) => {
      if (event && event.target === overlay && !mutationInFlight) close();
    });
    shadow.appendChild(overlay);

    els = {
      overlay, panel, current, form, term, searchButton, status, body, toolbar,
      closeButtons: [closeBtn, closeFooter],
      confirmState: null, confirmGo: null, confirmCancel: null,
    };
  }

  function close() {
    /* Everything in flight is superseded, so no late callback can repaint a
     * panel that is gone or a state that has moved on. */
    searchSequence += 1;
    mutationSequence += 1;
    Object.keys(combos).forEach((key) => {
      if (combos[key]) combos[key].cancelPending();
      delete combos[key];
    });
    if (callbacks.onCancel) {
      try { callbacks.onCancel(); } catch (error) { /* closing must not throw */ }
    }
    if (keydownHandler) window.removeEventListener("keydown", keydownHandler, true);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    else if (host && host.remove) host.remove();
    const opener = callbacks.opener;
    host = null;
    shadow = null;
    els = null;
    keydownHandler = null;
    callbacks = {};
    results = [];
    confirming = null;
    confirmOpener = null;
    lastResultForRedraw = null;
    mutationInFlight = false;
    searchBusy = false;
    searchesInFlight = 0;
    if (opener && opener.focus) {
      try { opener.focus(); } catch (error) { /* the opener may be gone */ }
    }
  }

  function open(options) {
    close();
    const opts = options || {};
    callbacks = {
      onSearch: opts.onSearch || null,
      onFindRoles: opts.onFindRoles || null,
      onFindGroups: opts.onFindGroups || null,
      onFindAttributeFields: opts.onFindAttributeFields || null,
      onFindAttributeValues: opts.onFindAttributeValues || null,
      onAttributeFieldChanged: opts.onAttributeFieldChanged || null,
      onRoleChanged: opts.onRoleChanged || null,
      onGroupChanged: opts.onGroupChanged || null,
      onImpersonate: opts.onImpersonate || null,
      onStop: opts.onStop || null,
      onOpenUser: opts.onOpenUser || null,
      onCancel: opts.onCancel || null,
      opener: opts.opener || (typeof document !== "undefined" ? document.activeElement : null),
    };
    host = document.createElement("div");
    host.id = HOST_ID;
    /* Closed, like every other GlideLens panel: an open root would let page
     * script read and rewrite a list of real people. */
    shadow = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);
    buildShell();
    renderEmpty(
      "Find a user to impersonate.",
      "Search by identity, filter by a discovered field, pick a role to see who holds it, or a group to see who is in it."
    );

    keydownHandler = (event) => {
      if (!host || event.key !== "Escape") return;
      /* Layered, each layer consuming the key: an open menu closes first, then
       * a confirmation is cancelled, and only then does the panel close. */
      if (anyMenuOpen()) {
        event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        closeAllMenus();
        return;
      }
      if (mutationInFlight) {
        /* A request is out and cannot be recalled. Closing here would hide
         * the only place its outcome is reported. */
        event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        return;
      }
      if (confirming) {
        event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        cancelConfirmation();
        return;
      }
      event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", keydownHandler, true);
    if (opts.currentState) showCurrentState(opts.currentState);
    if (els && els.term && els.term.focus) els.term.focus();
  }

  globalThis.SNImpersonateUI = {
    open,
    close,
    showSearchBusy,
    showResults,
    showError,
    showConfirmation,
    showMutationState,
    showCurrentState,
    isOpen: () => Boolean(host),
  };
})();

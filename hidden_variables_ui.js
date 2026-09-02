/*
 * Isolated-world UI for the "Variable Values" command.
 * Loaded before content.js so the command-palette action can call the
 * public API. Read-only inspector — never modifies the live form.
 * Lists every catalog variable with its value; visibility (hidden/visible)
 * is a filterable tag so nothing is ever silently dropped from the list.
 */

(() => {
  if (globalThis.SNHiddenVariablesUI) return;

  let resultsHost = null;
  let resultsShadow = null;
  let resultsKeydownHandler = null;
  let lastResult = null;
  let activeFilter = "all";
  let searchQuery = "";
  let hideEmpty = false;
  let previousFocus = null;

  const BUCKET_LABELS = {
    "hidden-type": "Hidden type",
    invisible: "Hidden by policy/script",
    absent: "Not rendered",
    "live-unavailable": "Live availability unknown",
    visible: "Visible",
    mrvs: "Multi-row set",
  };

  const resultCapabilities = (result) => {
    const safe = result || {};
    if (safe.capabilities) {
      return {
        comparison: Boolean(safe.capabilities.comparison),
        liveValues: Boolean(safe.capabilities.liveValues),
        differing: Boolean(safe.capabilities.differing),
        liveVisibility: Boolean(safe.capabilities.liveVisibility),
      };
    }
    const nativeMode = safe.mode === "native";
    return {
      comparison: nativeMode,
      liveValues: nativeMode,
      differing: nativeMode,
      liveVisibility: true,
    };
  };

  const UI_CSS = `
    *{box-sizing:border-box}
    :host{
      all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      /* Teal = selection/focus; pink = primary action. */
      --teal:#31d4c4;--pink:#ff6fae;
    }
    button,input{font:inherit}
    .overlay{
      position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.52);
      display:flex;align-items:center;justify-content:center;padding:24px;
    }
    .panel{
      width:min(1180px,calc(100vw - 32px));height:min(760px,calc(100vh - 40px));
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
    .best-effort{
      display:inline-flex;margin-left:7px;padding:3px 7px;border-radius:999px;
      color:#c7b9ff;background:#302b50;border:1px solid #4a4271;
      font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
      vertical-align:2px;
    }
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
    .warning{margin-left:auto;color:#d2b779}
    .status-banner{
      padding:9px 20px;border-bottom:1px solid #443d2d;background:#302b20;
      color:#e2c98c;font-size:11px;line-height:1.45;
    }
    .status-banner.error{background:#3a252d;border-color:#613746;color:#ffb5c5}
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
    .row{
      display:grid;grid-template-columns:1fr 130px 140px 1fr;gap:12px;
      align-items:center;padding:10px 18px;border-bottom:1px solid #292941;
      font-size:12px;color:#d7d7e8;
    }
    .row.native{grid-template-columns:minmax(180px,1fr) 110px 125px 135px minmax(240px,1.35fr)}
    .row.native.stored-side{grid-template-columns:minmax(220px,1fr) 130px minmax(280px,1.4fr)}
    .row-name{min-width:0}
    .row-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#f0f0fa}
    .row-var{
      font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#85859f;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .row-type{color:#9898b2;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .badge{
      justify-self:start;padding:3px 7px;border-radius:4px;font-size:10px;
      color:#aeb0d4;background:#2c2d4a;border:1px solid #3c3e62;white-space:nowrap;
    }
    .badge.hidden-type{color:#ffb1b1;background:#432a36;border-color:#684050}
    .badge.invisible{color:#a9d5ff;background:#24364a;border-color:#365573}
    .badge.absent{color:#b5e4c2;background:#263b35;border-color:#39594d}
    .badge.visible{color:#8f9bb3;background:#252539;border-color:#34344f}
    .badge.mrvs{color:#e6c78f;background:#3a3320;border-color:#5c5031}
    .badge.match{color:#9de0c0;background:#203a32;border-color:#315b4d}
    .badge.differs{color:#ffb5c5;background:#432936;border-color:#734156}
    .badge.not-comparable{color:#d7c896;background:#393422;border-color:#5d5330}
    .row-set{
      font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:#6f6f88;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;
    }
    .row-value{
      min-width:0;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#c1c1d6;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .row-value.expandable{cursor:pointer}
    .row-value.expandable:hover{color:#eaeaf6}
    .row-value.expanded{white-space:normal;overflow:visible;text-overflow:clip;word-break:break-word}
    .row-value.redacted{color:#ff9d9d;font-style:italic}
    .value-tag{color:#75758c;font-style:italic;margin-left:6px}
    .comparison{min-width:0}
    .comparison-reason{margin-top:4px;color:#85859f;font-size:10px;line-height:1.35}
    .native-values{min-width:0;display:grid;gap:5px}
    .native-value{display:grid;grid-template-columns:48px minmax(0,1fr);gap:7px;align-items:baseline}
    .native-value-label{color:#77778f;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
    .native-value-text{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#c1c1d6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .native-value-text.expandable{cursor:pointer}
    .native-value-text.expanded{white-space:normal;overflow:visible;text-overflow:clip;word-break:break-word}
    .empty{padding:48px 20px;text-align:center;color:#74748b;font-size:13px}
    .toolbar{
      display:flex;align-items:center;gap:8px;padding:11px 14px;
      border-top:1px solid #2e2e4e;background:#1b1b2b;
    }
    .toolbar-note{font-size:11px;color:#67677e;flex:1}
    .toolbar button{
      border:1px solid #3a3a5c;background:#292941;color:#d8d8ea;
      border-radius:6px;padding:6px 9px;cursor:pointer;font-size:12px;
    }
    .toolbar button:hover{background:#343453;color:#fff}
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
      .row,.row.native{grid-template-columns:1fr;gap:4px;padding:10px 14px}
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
    if (previousFocus && typeof previousFocus.focus === "function") {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch (e) {
        try { previousFocus.focus(); } catch (ignored) {}
      }
    }
    previousFocus = null;
  };

  const rowSearchText = (row) =>
    [
      row.name,
      row.label,
      row.type,
      row.setName,
      BUCKET_LABELS[row.bucket] || row.bucket,
      row.comparison,
      row.reason,
    ]
      .join(" ")
      .toLowerCase();

  // A row "has a value" when we resolved something real: a live/default value
  // string, or a redacted secret (there IS a value, we just can't show it).
  const rowHasValue = (row) => {
    if (row.mode === "native") {
      if (row.secret) return false;
      const stored = row.storedValue == null ? "" : String(row.storedValue).trim();
      const live = row.liveValue == null ? "" : String(row.liveValue).trim();
      // An empty multi-row set serialises as "[]", not "", on either side.
      if (row.isMrvs) {
        return (stored !== "" && stored !== "[]") || (live !== "" && live !== "[]");
      }
      return stored !== "" || live !== "";
    }
    if (row.valueSource === "redacted") return true;
    if (row.valueSource === "none") return false;
    const value = String(row.value == null ? "" : row.value).trim();
    if (row.isMrvs) return value !== "" && value !== "[]";
    return value !== "";
  };

  const filteredRows = () => {
    const rows = (lastResult && lastResult.rows) || [];
    return rows.filter((row) => {
      const visibilityState = row.visibilityState ||
        (row.hidden ? "hidden" : "visible");
      if (activeFilter === "hidden" && visibilityState !== "hidden") return false;
      if (activeFilter === "visible" && visibilityState !== "visible") return false;
      if (activeFilter === "unknown" && visibilityState !== "unknown") return false;
      if (activeFilter === "differs" && row.comparison !== "differs") return false;
      if (hideEmpty && !rowHasValue(row)) return false;
      return !searchQuery || rowSearchText(row).includes(searchQuery);
    });
  };

  const mrvsRowCount = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.length;
    } catch (e) {}
    return null;
  };

  const valueCellText = (row) => {
    if (row.valueSource === "redacted") return "[REDACTED]";
    if (row.isMrvs) {
      const raw = row.valueSource === "live" ? row.value : "";
      if (!raw || raw === "[]") return "(no rows)";
      const count = mrvsRowCount(raw);
      const prefix = count == null ? "" : count + (count === 1 ? " row: " : " rows: ");
      return prefix + raw;
    }
    if (row.valueSource === "default") return (row.value || "") + " (default, not live)";
    if (row.valueSource === "live") return row.value || "(empty)";
    return "(no value)";
  };

  const comparisonLabel = (comparison) => ({
    match: "Match",
    differs: "Differs",
    "not-comparable": "Not comparable",
  }[comparison] || "Not comparable");

  const nativeMrvsText = (raw, count) => {
    const text = String(raw == null ? "" : raw);
    if (!text || text === "[]") return "(no rows)";
    const rows = count == null ? mrvsRowCount(text) : count;
    const prefix = rows == null ? "" : rows + (rows === 1 ? " row: " : " rows: ");
    return prefix + text;
  };

  // "(not stored)" is a claim about the record, so it is reserved for a lookup
  // that actually ran and found nothing. Anything we declined or failed to read
  // says so instead.
  const nativeSideText = (row, side) => {
    if (row.secret) return "Not read (secret)";
    if (side === "stored") {
      if (row.storedLookup === "absent") return "(not stored)";
      if (row.storedLookup !== "found" || row.storedValue == null) return "(not read)";
      if (row.isMrvs) return nativeMrvsText(row.storedValue, row.storedRowCount);
      return String(row.storedValue) || "(empty)";
    }
    if (!row.liveValueAvailable) return "(not available)";
    if (row.isMrvs) return nativeMrvsText(row.liveValue, row.liveRowCount);
    return String(row.liveValue == null ? "" : row.liveValue) || "(empty)";
  };

  const renderRows = () => {
    if (!resultsShadow) return;
    const list = resultsShadow.querySelector(".rows");
    if (!list) return;
    list.textContent = "";

    const rows = filteredRows();
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No variables match these filters.";
      list.appendChild(empty);
      return;
    }

    const capabilities = resultCapabilities(lastResult);
    rows.forEach((row) => {
      const el = document.createElement("div");
      el.className = "row" + (row.mode === "native" ? " native" : "") +
        (row.mode === "native" && !capabilities.comparison ? " stored-side" : "");
      el.setAttribute("role", "listitem");

      const nameCell = document.createElement("div");
      nameCell.className = "row-name";
      const labelEl = document.createElement("div");
      labelEl.className = "row-label";
      labelEl.textContent = row.label || row.name;
      labelEl.title = row.label || row.name;
      const varEl = document.createElement("div");
      varEl.className = "row-var";
      varEl.textContent = row.name;
      nameCell.append(labelEl, varEl);
      if (row.setName) {
        const setEl = document.createElement("div");
        setEl.className = "row-set";
        setEl.textContent = "Set: " + row.setName;
        setEl.title = "Variable set: " + row.setName;
        nameCell.append(setEl);
      }

      const typeCell = document.createElement("div");
      typeCell.className = "row-type";
      typeCell.textContent = row.type || "";
      typeCell.title = row.type || "";

      const bucketCell = document.createElement("span");
      bucketCell.className = "badge " + row.bucket;
      bucketCell.textContent = BUCKET_LABELS[row.bucket] || row.bucket;

      if (row.mode === "native") {
        const valuesCell = document.createElement("div");
        valuesCell.className = "native-values";
        (capabilities.liveValues ? ["stored", "live"] : ["stored"]).forEach((side) => {
          const line = document.createElement("div");
          line.className = "native-value";
          const sideLabel = document.createElement("span");
          sideLabel.className = "native-value-label";
          sideLabel.textContent = side;
          const sideValue = document.createElement("span");
          sideValue.className = "native-value-text";
          sideValue.textContent = nativeSideText(row, side);
          if (!row.secret && sideValue.textContent.length > 28) {
            sideValue.classList.add("expandable");
            sideValue.tabIndex = 0;
            sideValue.setAttribute("role", "button");
            sideValue.setAttribute("aria-label", "Expand " + side + " value for " + (row.label || row.name));
            const toggleExpanded = () => sideValue.classList.toggle("expanded");
            sideValue.addEventListener("click", toggleExpanded);
            sideValue.addEventListener("keydown", (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleExpanded();
              }
            });
          } else {
            sideValue.title = sideValue.textContent;
          }
          line.append(sideLabel, sideValue);
          valuesCell.appendChild(line);
        });
        const nativeCells = [nameCell, typeCell];
        if (capabilities.liveVisibility) nativeCells.push(bucketCell);
        if (capabilities.comparison) {
          const comparisonCell = document.createElement("div");
          comparisonCell.className = "comparison";
          const comparisonBadge = document.createElement("span");
          comparisonBadge.className = "badge " + (row.comparison || "not-comparable");
          comparisonBadge.textContent = comparisonLabel(row.comparison);
          const reason = document.createElement("div");
          reason.className = "comparison-reason";
          reason.textContent = row.reason || "";
          comparisonCell.append(comparisonBadge, reason);
          nativeCells.push(comparisonCell);
        }
        nativeCells.push(valuesCell);
        el.append(...nativeCells);
      } else {
        const valueCell = document.createElement("div");
        valueCell.className = "row-value" + (row.valueSource === "redacted" ? " redacted" : "");
        valueCell.textContent = valueCellText(row);
        if (valueCell.textContent.length > 28) {
          valueCell.classList.add("expandable");
          valueCell.tabIndex = 0;
          valueCell.setAttribute("role", "button");
          valueCell.setAttribute("aria-label", "Expand value for " + (row.label || row.name));
          const toggleExpanded = () => valueCell.classList.toggle("expanded");
          valueCell.addEventListener("click", toggleExpanded);
          valueCell.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggleExpanded();
            }
          });
        } else {
          valueCell.title = valueCell.textContent;
        }
        el.append(nameCell, typeCell, bucketCell, valueCell);
      }
      list.appendChild(el);
    });
  };

  const formatResultsAsText = (result, rows) => {
    const safeResult = result || { rows: [] };
    const safeRows = Array.isArray(rows) ? rows : [];
    const capabilities = resultCapabilities(safeResult);
    const workspaceStoredOnly =
      safeResult.recordKind === "workspace" &&
      ["stored-only", "no-editor-empty", "no-candidate"].includes(safeResult.panelState);
    const workspaceUnavailable =
      safeResult.recordKind === "workspace" &&
      safeResult.panelState === "stored-unavailable";
    const lines = [
      workspaceStoredOnly ? "GlideLens — Stored Variables" : "GlideLens — Variable Values",
      "Read-only inspector; does not modify the live form.",
      ...(workspaceStoredOnly
        ? ["Workspace live values were not compared. These are stored values only."]
        : []),
      ...(workspaceUnavailable
        ? ["Stored values were unavailable, and no live Workspace comparison was run."]
        : []),
      "Rows: " + String(safeRows.length) + " of " + String((safeResult.rows || []).length),
      "",
    ];
    safeRows.forEach((row) => {
      if (row.mode === "native") {
        const details = [
          (row.label || row.name || "Unnamed variable") + " (" + (row.name || "unnamed") + ")",
          capabilities.liveVisibility ? (BUCKET_LABELS[row.bucket] || row.bucket) : "",
          row.setName ? "[" + row.setName + "]" : "",
          row.type || "",
          capabilities.comparison
            ? comparisonLabel(row.comparison) + (row.reason ? ": " + row.reason : "")
            : "",
        ].filter(Boolean).join(" — ");
        lines.push(details);
        if (row.secret) {
          lines.push("  Values not read (secret)");
        } else {
          lines.push("  Stored: " + nativeSideText(row, "stored"));
          if (capabilities.liveValues) {
            lines.push("  Live: " + nativeSideText(row, "live"));
          }
        }
        return;
      }
      lines.push(
        (row.label || row.name) +
          " (" + row.name + ") — " +
          (BUCKET_LABELS[row.bucket] || row.bucket) +
          (row.setName ? " [" + row.setName + "]" : "") +
          " — " + (row.type || "") +
          " — " + valueCellText(row)
      );
    });
    return lines.join("\n");
  };

  const resultsAsText = () => formatResultsAsText(
    lastResult || { rows: [] },
    filteredRows()
  );

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
    hideEmpty = false;

    const rows = result.rows || [];
    const nativeMode = result.mode === "native";
    const workspaceMode = result.recordKind === "workspace";
    const capabilities = resultCapabilities(result);

    resultsHost = document.createElement("div");
    resultsHost.id = "snh-hidden-variables-results";
    document.documentElement.appendChild(resultsHost);
    resultsShadow = resultsHost.attachShadow({ mode: "closed" });
    const visibilityState = (row) => row.visibilityState ||
      (row.hidden ? "hidden" : "visible");
    const hiddenTotal = rows.filter((row) => visibilityState(row) === "hidden").length;
    const visibleTotal = rows.filter((row) => visibilityState(row) === "visible").length;
    const unknownTotal = rows.filter((row) => visibilityState(row) === "unknown").length;
    const differsTotal = rows.filter((row) => row.comparison === "differs").length;
    const setsNote = result.setCount
      ? result.setCount + (result.setCount === 1 ? " variable set" : " variable sets")
      : "";
    let statusMessage = "";
    let statusClass = "";
    if (result.fatalError) {
      statusMessage = result.fatalError;
      statusClass = " error";
    } else if (workspaceMode && result.panelState === "stored-unavailable") {
      statusMessage = result.storedReadError ||
        "Stored values were unavailable, and this Workspace view exposes no live values to compare.";
      statusClass = " error";
    } else if (workspaceMode && result.panelState === "stored-only") {
      statusMessage = "The Workspace form on screen does not expose live variable values, so nothing was compared. These are stored values only.";
    } else if (workspaceMode && result.panelState === "no-editor-empty") {
      statusMessage = "No stored catalog-variable rows were found, and this Workspace view exposes no Variable Editor.";
    } else if (workspaceMode && result.panelState === "no-candidate") {
      statusMessage = "No variables on this record are eligible for Workspace comparison. Nothing was compared.";
    } else if (workspaceMode && result.panelState === "partial") {
      statusMessage = String(result.checkedCount || 0) + " of " +
        String(result.candidateCount || 0) +
        " Workspace-comparable variables were checked; " +
        String(result.uncheckedCount || 0) + " were not checked.";
    } else if (nativeMode && result.storedReadStatus === "failed") {
      statusMessage = result.storedReadError || "Stored values were unavailable. No comparison was run.";
      statusClass = " error";
    } else if (nativeMode && result.storedReadStatus === "truncated") {
      statusMessage = result.storedReadError || "The read reached its row limit. Partial rows are shown without comparisons.";
    } else if (nativeMode && result.storedReadStatus === "empty") {
      statusMessage = "The stored read succeeded and returned no variable rows. Definitions are shown without comparisons.";
    }
    const nativeTarget = result.recordKind === "producer"
      ? "record producer target"
      : result.recordKind === "ritm" ? "RITM" : "record";
    let subtitle = "Every variable on this catalog item with its best-effort current value. Hidden = explicitly Hidden-type, switched off by a UI Policy/client script, or not rendered.";
    if (nativeMode && !workspaceMode) {
      subtitle = "Stored Table API values compared with raw live g_form values on this " + nativeTarget + ". Values are read-only; reference and choice labels are not compared.";
    } else if (workspaceMode && result.panelState === "complete") {
      subtitle = "All " + String(result.checkedCount || 0) +
        " Workspace-comparable variables were checked against stored Table API values.";
    } else if (workspaceMode && result.panelState === "partial") {
      subtitle = String(result.checkedCount || 0) + " of " +
        String(result.candidateCount || 0) +
        " Workspace-comparable variables were checked against stored Table API values.";
    } else if (workspaceMode && result.panelState === "stored-unavailable") {
      subtitle = "Stored values were unavailable, and no live Workspace comparison was run.";
    } else if (workspaceMode) {
      subtitle = "Stored Table API values only. Nothing was compared with live Workspace values.";
    }
    const panelTitle = workspaceMode &&
      ["stored-only", "no-editor-empty", "no-candidate"].includes(result.panelState)
      ? "Stored Variables"
      : "Variable Values";
    resultsShadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="overlay">
        <section class="panel" role="dialog" aria-modal="true" aria-labelledby="snh-hidden-title">
          <header class="header">
            <div class="heading">
              <h2 id="snh-hidden-title">${panelTitle} <span class="best-effort">Best effort</span></h2>
              <div class="subtitle">${subtitle}</div>
            </div>
            <button class="close" type="button">Close</button>
          </header>
          <div class="summary">
            <span><strong data-count="total">0</strong>variables</span>
            ${capabilities.liveVisibility ? '<span><strong data-count="hidden">0</strong>hidden</span>' : ""}
            ${capabilities.liveVisibility ? '<span><strong data-count="visible">0</strong>visible</span>' : ""}
            ${capabilities.liveVisibility && workspaceMode ? '<span><strong data-count="unknown">0</strong>live unknown</span>' : ""}
            ${capabilities.differing ? '<span><strong data-count="differs">0</strong>differing</span>' : ""}
            ${setsNote ? '<span>' + setsNote + "</span>" : ""}
            ${result.foundForm || nativeMode ? "" : '<span class="warning">Could not find the catalog form on this page.</span>'}
          </div>
          ${statusMessage ? '<div class="status-banner' + statusClass + '" role="status" data-status></div>' : ""}
          <div class="controls">
            <div class="filters" aria-label="Visibility filters">
              <button class="filter active" type="button" data-filter="all" aria-pressed="true">All</button>
              ${capabilities.liveVisibility ? '<button class="filter" type="button" data-filter="hidden" aria-pressed="false">Hidden</button>' : ""}
              ${capabilities.liveVisibility ? '<button class="filter" type="button" data-filter="visible" aria-pressed="false">Visible</button>' : ""}
              ${capabilities.liveVisibility && workspaceMode ? '<button class="filter" type="button" data-filter="unknown" aria-pressed="false">Live unknown</button>' : ""}
              ${capabilities.differing ? '<button class="filter" type="button" data-filter="differs" aria-pressed="false">Differing</button>' : ""}
            </div>
            <button class="toggle" type="button" data-toggle="nonempty" aria-pressed="false">
              <span class="dot"></span>Non-empty
            </button>
            <input class="search" type="search" placeholder="Search name, label or set…" aria-label="Search variables" />
          </div>
          <div class="rows" role="list" aria-label="Catalog variables"></div>
          <footer class="toolbar">
            <span class="toolbar-note">Read-only inspector — does not modify the live form.</span>
            <button type="button" data-action="close">Close</button>
            <button class="primary" type="button" data-action="copy">Copy list</button>
          </footer>
        </section>
      </div>
    `;

    const statusElement = resultsShadow.querySelector("[data-status]");
    if (statusElement) statusElement.textContent = statusMessage;

    const writeCount = (key, value) => {
      const el = resultsShadow.querySelector("[data-count='" + key + "']");
      if (el) el.textContent = String(value);
    };
    writeCount("total", rows.length);
    writeCount("hidden", hiddenTotal);
    writeCount("visible", visibleTotal);
    writeCount("unknown", unknownTotal);
    writeCount("differs", differsTotal);

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

    const emptyToggle = resultsShadow.querySelector("[data-toggle='nonempty']");
    if (emptyToggle) {
      emptyToggle.addEventListener("click", () => {
        hideEmpty = !hideEmpty;
        emptyToggle.classList.toggle("active", hideEmpty);
        emptyToggle.setAttribute("aria-pressed", hideEmpty ? "true" : "false");
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

    const closeButton = resultsShadow.querySelector(".close");
    const footerClose = resultsShadow.querySelector("[data-action='close']");
    const copyButton = resultsShadow.querySelector("[data-action='copy']");
    if (closeButton) closeButton.addEventListener("click", closeResults);
    if (footerClose) footerClose.addEventListener("click", closeResults);
    if (copyButton) copyButton.addEventListener("click", () => copyList().catch(() => {}));

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
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        resultsShadow.querySelectorAll("button,input,[tabindex='0']")
      ).filter((element) => !element.disabled);
      if (!focusable.length) return;
      const current = resultsShadow.activeElement;
      const index = focusable.indexOf(current);
      const nextIndex = event.shiftKey
        ? (index <= 0 ? focusable.length - 1 : index - 1)
        : (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusable[nextIndex].focus();
    };
    window.addEventListener("keydown", resultsKeydownHandler, true);
    renderRows();
    if (closeButton) closeButton.focus();
  };

  globalThis.SNHiddenVariablesUI = { showResults, formatResultsAsText };
})();

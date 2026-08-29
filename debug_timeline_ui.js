/*
 * Isolated-world UI for Debug Timeline.
 * Loaded before content.js so command-palette actions can call the public API.
 */

(() => {
  if (globalThis.SNDebugTimelineUI) return;

  let recording = false;
  let indicatorHost = null;
  let resultsHost = null;
  let resultsShadow = null;
  let resultsKeydownHandler = null;
  let lastResult = null;
  let activeFilter = "all";
  let searchQuery = "";
  let showLowSignal = false;
  let lowSignalReasons = new WeakMap();
  let lowSignalCount = 0;

  const CATEGORY_LABELS = {
    system: "System",
    g_form: "g_form",
    field: "Field",
    glideajax: "GlideAjax",
    error: "Error",
  };

  const UI_CSS = `
    *{box-sizing:border-box}
    :host{
      all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      /* Teal = selection/focus; pink = primary action. Recording dot stays red. */
      --teal:#31d4c4;--pink:#ff6fae;
    }
    button,input{font:inherit}
    .recording{
      position:fixed;top:18px;right:18px;z-index:2147483646;
      display:flex;align-items:center;gap:9px;padding:8px 9px 8px 12px;
      color:#f3f3ff;background:#1e1e2e;border:1px solid #4a3a54;
      border-radius:999px;box-shadow:0 12px 34px rgba(0,0,0,.38);
      font-size:12px;
    }
    .recording-dot{
      width:8px;height:8px;border-radius:50%;background:#ff5f6d;
      box-shadow:0 0 0 4px rgba(255,95,109,.13);
      animation:snh-pulse 1.7s ease-in-out infinite;
    }
    @keyframes snh-pulse{50%{opacity:.5;transform:scale(.82)}}
    .recording button,.toolbar button,.filter{
      border:1px solid #3a3a5c;background:#292941;color:#d8d8ea;
      border-radius:6px;padding:6px 9px;cursor:pointer;
    }
    .recording button:hover,.toolbar button:hover,.filter:hover{background:#343453;color:#fff}
    .overlay{
      position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.52);
      display:flex;align-items:center;justify-content:center;padding:24px;
    }
    .panel{
      width:min(920px,calc(100vw - 32px));height:min(720px,calc(100vh - 40px));
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
    .controls{
      display:flex;align-items:center;gap:8px;padding:10px 14px;
      border-bottom:1px solid #292944;
    }
    .filters{display:flex;gap:6px;flex-wrap:wrap}
    .filter{padding:5px 9px;font-size:11px;color:#e6e6f5;background:#3f4067;border-color:#68689a}
    .filter:hover{background:#4a4b78;color:#fff}
    .filter.active{
      background:color-mix(in srgb, var(--teal) 30%, #23303a);
      border-color:var(--teal);color:#eafffb;
      box-shadow:0 0 0 1px color-mix(in srgb, var(--teal) 40%, transparent);
    }
    .filter.low-signal-toggle{color:#b0b0c6;border-color:#43435e;background:#2c2c42}
    .filter.low-signal-toggle.active{color:#d4d4e6;border-color:#5b5b7a;background:#38384f}
    .search{
      margin-left:auto;width:230px;max-width:38vw;background:#313150;
      border:1px solid #575780;border-radius:6px;color:#f0f0fa;
      outline:none;padding:7px 9px;font-size:12px;
    }
    .search:focus{border-color:var(--teal);background:#37375a}
    .search::placeholder{color:#a4a4be}
    .events{flex:1;overflow:auto;padding:6px 0}
    .event{border-bottom:1px solid #292941}
    .event-main{
      width:100%;display:grid;grid-template-columns:76px 82px 1fr auto;
      align-items:center;gap:10px;padding:10px 18px;background:transparent;
      color:#d7d7e8;border:0;text-align:left;cursor:pointer;
    }
    .event-main:hover{background:#25253d}
    .time{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#76768f}
    .category{
      justify-self:start;padding:3px 6px;border-radius:4px;font-size:10px;font-weight:600;
      color:#cdd0f2;background:#33345a;border:1px solid #4a4d78;
    }
    .category.g_form{
      color:#7cf1e4;
      background:color-mix(in srgb, var(--teal) 20%, #1c2a30);
      border-color:color-mix(in srgb, var(--teal) 52%, #33345a);
    }
    .category.system{
      color:#ffb3d5;
      background:color-mix(in srgb, var(--pink) 20%, #2f2130);
      border-color:color-mix(in srgb, var(--pink) 48%, #33345a);
    }
    .category.error{color:#ffc0c0;background:#4a2c39;border-color:#744a5a}
    .category.glideajax{color:#bfe1ff;background:#26374d;border-color:#3d6488}
    .category.field{color:#c4efce;background:#284037;border-color:#3f6555}
    .event-summary{min-width:0;display:flex;align-items:center;gap:8px;font-size:12px}
    .event-summary-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .glideajax-status{
      flex:0 0 auto;padding:2px 6px;border-radius:4px;font-size:9px;
      font-weight:700;letter-spacing:.03em;text-transform:uppercase;
    }
    .glideajax-status.started{
      color:#bfe1ff;background:#26374d;border:1px solid #3d6488;
    }
    .glideajax-status.completed{
      color:#c4efce;background:#284037;border:1px solid #3f6555;
    }
    .event.low-signal .event-main{color:#9999ad}
    .event.low-signal .category{opacity:.62}
    .low-signal-badge{
      flex:0 0 auto;padding:2px 6px;border-radius:999px;font-size:9px;
      color:#85859a;background:#242437;border:1px solid #38384d;
      letter-spacing:.02em;
    }
    .expand{color:#6f6f86;font-size:11px}
    .event-details{
      display:none;margin:0 18px 12px 186px;padding:10px 12px;
      background:#171725;border:1px solid #2d2d47;border-radius:6px;
      color:#a9a9bf;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;
      white-space:pre-wrap;overflow-wrap:anywhere;
    }
    .event.open .event-details{display:block}
    .empty{padding:48px 20px;text-align:center;color:#74748b;font-size:13px}
    .toolbar{
      display:flex;align-items:center;gap:8px;padding:11px 14px;
      border-top:1px solid #2e2e4e;background:#1b1b2b;
    }
    .toolbar-note{font-size:11px;color:#67677e;flex:1}
    .toolbar-note.caution{color:#e8b4c8}
    .toolbar .primary.armed{
      background:color-mix(in srgb, var(--pink) 96%, #3a2740);
      border-color:#e8b4c8;
    }
    .toolbar button{font-size:12px}
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
      .event-main{grid-template-columns:62px 70px 1fr;padding:10px 12px}
      .expand{display:none}.event-details{margin:0 12px 10px}
    }
  `;

  const removeIndicator = () => {
    if (indicatorHost) indicatorHost.remove();
    indicatorHost = null;
  };

  const showIndicator = () => {
    if (window !== window.top || indicatorHost) return;
    indicatorHost = document.createElement("div");
    indicatorHost.id = "snh-debug-timeline-indicator";
    document.documentElement.appendChild(indicatorHost);
    const shadow = indicatorHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="recording" role="status" aria-live="polite">
        <span class="recording-dot"></span>
        <span>Debug Timeline recording</span>
        <button type="button">Stop</button>
      </div>
    `;
    const stopButton = shadow.querySelector("button");
    if (stopButton) {
      stopButton.addEventListener("click", () => {
        stopAndView().catch(() => {});
      });
    }
  };

  const closeResults = () => {
    if (resultsKeydownHandler) {
      window.removeEventListener("keydown", resultsKeydownHandler, true);
      resultsKeydownHandler = null;
    }
    if (resultsHost) resultsHost.remove();
    resultsHost = null;
    resultsShadow = null;
  };

  const formatElapsed = (milliseconds) => {
    const value = Math.max(0, Number(milliseconds) || 0);
    return "+" + (value / 1000).toFixed(3) + "s";
  };

  const eventSearchText = (event) =>
    [
      event.category,
      event.action,
      event.summary,
      event.frameLabel,
      JSON.stringify(event.details || {}),
      event.stack,
    ]
      .join(" ")
      .toLowerCase();

  const classifyLowSignalEvents = (events) => {
    const repeatableMethods = new Set([
      "hideFieldMsg",
      "setMandatory",
      "setVisible",
      "setDisplay",
      "setReadOnly",
      "setDisabled",
    ]);
    const latestCalls = new Map();
    lowSignalReasons = new WeakMap();
    lowSignalCount = 0;

    events.forEach((event) => {
      const details = event.details || {};
      let reason = details.noValueChange ? "No value change" : "";

      if (event.category === "g_form" && repeatableMethods.has(event.action)) {
        const key = [
          event.frameId,
          event.action,
          details.field || "",
        ].join("|");
        const signature = JSON.stringify(details.arguments || []);
        const previous = latestCalls.get(key);
        if (
          !reason &&
          previous &&
          previous.signature === signature &&
          event.time - previous.time <= 5000
        ) {
          reason = "Repeated call";
        }
        latestCalls.set(key, { signature, time: event.time });
      }

      if (reason) {
        lowSignalReasons.set(event, reason);
        lowSignalCount += 1;
      }
    });
  };

  const filteredEvents = () => {
    const events = (lastResult && lastResult.events) || [];
    return events.filter((event) => {
      if (!showLowSignal && lowSignalReasons.has(event)) return false;
      if (activeFilter !== "all" && event.category !== activeFilter) return false;
      return !searchQuery || eventSearchText(event).includes(searchQuery);
    });
  };

  const detailText = (event) => {
    const parts = [];
    if (event.frameLabel) parts.push("Frame: " + event.frameLabel);
    if (event.frameUrl) parts.push("URL: " + event.frameUrl);
    const details = event.details || {};
    if (Object.keys(details).length) parts.push(JSON.stringify(details, null, 2));
    if (event.stack) parts.push("Stack (best effort):\n" + event.stack);
    return parts.join("\n\n") || "No additional details.";
  };

  const renderEvents = () => {
    if (!resultsShadow) return;
    const list = resultsShadow.querySelector(".events");
    if (!list) return;
    list.textContent = "";

    const events = filteredEvents();
    if (!events.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No timeline events match these filters.";
      list.appendChild(empty);
      return;
    }

    events.forEach((event) => {
      const row = document.createElement("div");
      row.className = "event";
      const lowSignalReason = lowSignalReasons.get(event) || "";
      if (lowSignalReason) row.classList.add("low-signal");

      const main = document.createElement("button");
      main.type = "button";
      main.className = "event-main";

      const time = document.createElement("span");
      time.className = "time";
      time.textContent = formatElapsed(event.elapsedMs);

      const category = document.createElement("span");
      category.className = "category " + String(event.category || "");
      category.textContent = CATEGORY_LABELS[event.category] || event.category || "Event";

      const summary = document.createElement("span");
      summary.className = "event-summary";
      if (
        event.category === "glideajax" &&
        (event.action === "start" || event.action === "complete")
      ) {
        const status = document.createElement("span");
        status.className =
          "glideajax-status " +
          (event.action === "start" ? "started" : "completed");
        status.textContent = event.action === "start" ? "Started" : "Completed";
        summary.appendChild(status);
      }
      const summaryText = document.createElement("span");
      summaryText.className = "event-summary-text";
      summaryText.textContent = event.summary || event.action || "Timeline event";
      summary.title = summaryText.textContent;
      summary.appendChild(summaryText);
      if (lowSignalReason) {
        const badge = document.createElement("span");
        badge.className = "low-signal-badge";
        badge.textContent = lowSignalReason;
        summary.appendChild(badge);
      }

      const expand = document.createElement("span");
      expand.className = "expand";
      expand.textContent = "Details";

      main.append(time, category, summary, expand);

      const details = document.createElement("pre");
      details.className = "event-details";
      details.textContent = detailText(event);

      main.addEventListener("click", () => {
        row.classList.toggle("open");
        expand.textContent = row.classList.contains("open") ? "Hide" : "Details";
      });

      row.append(main, details);
      list.appendChild(row);
    });
  };

  const traceAsText = () => {
    const result = lastResult || { events: [] };
    const lines = [
      "GlideLens — Debug Timeline",
      "Best-effort trace; script and UI Policy attribution is not guaranteed.",
      "Started: " + (result.startedAt ? new Date(result.startedAt).toISOString() : "unknown"),
      "Stopped: " + (result.stoppedAt ? new Date(result.stoppedAt).toISOString() : "unknown"),
      "Frames: " + String(result.frameCount || 0),
      "Events: " + String((result.events || []).length),
      "",
    ];

    (result.events || []).forEach((event) => {
      lines.push(
        formatElapsed(event.elapsedMs) +
          " [" +
          (CATEGORY_LABELS[event.category] || event.category || "Event") +
          "] " +
          (event.summary || event.action || "")
      );
      if (event.frameLabel) lines.push("  Frame: " + event.frameLabel);
      if (lowSignalReasons.has(event)) {
        lines.push("  Signal: " + lowSignalReasons.get(event));
      }
      if (event.details && Object.keys(event.details).length) {
        lines.push("  Details: " + JSON.stringify(event.details));
      }
      if (event.stack) {
        lines.push(
          event.stack
            .split("\n")
            .map((line) => "  " + line)
            .join("\n")
        );
      }
      lines.push("");
    });
    return lines.join("\n");
  };

  const copyTrace = async () => {
    const text = traceAsText();
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
    showLowSignal = false;
    classifyLowSignalEvents(result.events || []);

    resultsHost = document.createElement("div");
    resultsHost.id = "snh-debug-timeline-results";
    document.documentElement.appendChild(resultsHost);
    resultsShadow = resultsHost.attachShadow({ mode: "closed" });
    resultsShadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="overlay">
        <section class="panel" role="dialog" aria-modal="true" aria-labelledby="snh-debug-title">
          <header class="header">
            <div class="heading">
              <h2 id="snh-debug-title">Debug Timeline <span class="best-effort">Best effort</span></h2>
              <div class="subtitle">ServiceNow form activity correlated across the frames that were available during this interaction.</div>
            </div>
            <button class="close" type="button">Close</button>
          </header>
          <div class="summary">
            <span><strong data-count="events">0</strong>events</span>
            <span><strong data-count="frames">0</strong>frames</span>
            <span><strong data-count="duration">0.0s</strong>duration</span>
            <span class="warning">Some internal ServiceNow changes may not be captured.</span>
          </div>
          <div class="controls">
            <div class="filters" aria-label="Timeline filters">
              <button class="filter active" type="button" data-filter="all">All</button>
              <button class="filter" type="button" data-filter="g_form">g_form</button>
              <button class="filter" type="button" data-filter="field">Fields</button>
              <button class="filter" type="button" data-filter="glideajax">GlideAjax</button>
              <button class="filter" type="button" data-filter="error">Errors</button>
              <button class="filter low-signal-toggle" type="button" data-action="toggle-low-signal" aria-pressed="false">Show low-signal (${lowSignalCount})</button>
            </div>
            <input class="search" type="search" placeholder="Search events, fields, stacks…" aria-label="Search timeline" />
          </div>
          <div class="events"></div>
          <footer class="toolbar">
            <span class="toolbar-note">Stacks identify runtime calls, not guaranteed Client Script or UI Policy names.</span>
            <button type="button" data-action="close">Close</button>
            <button class="primary" type="button" data-action="copy">Copy trace</button>
          </footer>
        </section>
      </div>
    `;

    const eventsCount = resultsShadow.querySelector("[data-count='events']");
    const framesCount = resultsShadow.querySelector("[data-count='frames']");
    const durationCount = resultsShadow.querySelector("[data-count='duration']");
    if (eventsCount) eventsCount.textContent = String((result.events || []).length);
    if (framesCount) framesCount.textContent = String(result.frameCount || 0);
    if (durationCount) {
      durationCount.textContent =
        (((result.stoppedAt || 0) - (result.startedAt || result.stoppedAt || 0)) / 1000).toFixed(1) +
        "s";
    }

    resultsShadow.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        activeFilter = button.dataset.filter || "all";
        resultsShadow.querySelectorAll("[data-filter]").forEach((candidate) => {
          candidate.classList.toggle("active", candidate === button);
        });
        renderEvents();
      });
    });

    const lowSignalToggle = resultsShadow.querySelector("[data-action='toggle-low-signal']");
    if (lowSignalToggle) {
      lowSignalToggle.hidden = lowSignalCount === 0;
      lowSignalToggle.addEventListener("click", () => {
        showLowSignal = !showLowSignal;
        lowSignalToggle.classList.toggle("active", showLowSignal);
        lowSignalToggle.setAttribute("aria-pressed", String(showLowSignal));
        lowSignalToggle.textContent =
          (showLowSignal ? "Hide" : "Show") + " low-signal (" + lowSignalCount + ")";
        renderEvents();
      });
    }

    const search = resultsShadow.querySelector(".search");
    if (search) {
      search.addEventListener("input", () => {
        searchQuery = search.value.trim().toLowerCase();
        renderEvents();
      });
    }

    const closeButton = resultsShadow.querySelector(".close");
    const footerClose = resultsShadow.querySelector("[data-action='close']");
    const copyButton = resultsShadow.querySelector("[data-action='copy']");
    if (closeButton) closeButton.addEventListener("click", closeResults);
    if (footerClose) footerClose.addEventListener("click", closeResults);
    /* Copying is the moment a trace stops being local. It holds field values,
     * GlideAjax parameters and frame URLs from a real instance -- masked where
     * they look like secrets, but not anonymised -- and it usually ends up in a
     * ticket or a chat. So the first click arms and explains, the second
     * copies. The note reverts on its own if the user thinks better of it. */
    if (copyButton) {
      const note = resultsShadow.querySelector(".toolbar-note");
      const noteText = note ? note.textContent : "";
      const defaultLabel = copyButton.textContent;
      let armed = false;
      let armedTimer = 0;

      const disarm = () => {
        armed = false;
        if (armedTimer) clearTimeout(armedTimer);
        armedTimer = 0;
        copyButton.textContent = defaultLabel;
        copyButton.classList.remove("armed");
        if (note) {
          note.textContent = noteText;
          note.classList.remove("caution");
        }
      };

      copyButton.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          copyButton.textContent = "Copy anyway";
          copyButton.classList.add("armed");
          if (note) {
            note.textContent =
              "This trace holds field values, GlideAjax parameters and page URLs from this instance. Review it before pasting anywhere shared.";
            note.classList.add("caution");
          }
          armedTimer = setTimeout(disarm, 12000);
          return;
        }
        disarm();
        copyTrace().catch(() => {});
      });
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
    renderEvents();
  };

  const start = async () => {
    if (recording) return { ok: true, alreadyActive: true };
    const response = await chrome.runtime.sendMessage({ type: "START_DEBUG_TIMELINE" });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Couldn't start Debug Timeline.");
    }
    recording = true;
    showIndicator();
    return response;
  };

  async function stopAndView() {
    const response = await chrome.runtime.sendMessage({ type: "STOP_DEBUG_TIMELINE" });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Couldn't stop Debug Timeline.");
    }
    recording = false;
    removeIndicator();
    showResults(response);
    return response;
  }

  globalThis.SNDebugTimelineUI = {
    start,
    stopAndView,
    isRecording: () => recording,
    showResults,
  };
})();

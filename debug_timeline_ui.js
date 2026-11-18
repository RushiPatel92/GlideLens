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
  /* The events the panel draws and copies: the trace minus the rows that
   * would only add noise (see dropNoise). */
  let shownEvents = [];
  /* Rows the user opened, and stacks they showed, keyed on the event object
   * itself, so a filter or search redraw keeps them as they were. */
  let openEvents = new WeakSet();
  let shownStacks = new WeakSet();
  /* A finished GlideAjax call and the start it answers, both ways round. */
  let startOf = new WeakMap();
  let answerOf = new WeakMap();

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
    .best-effort{
      display:inline-flex;margin-left:7px;padding:3px 7px;border-radius:999px;
      color:#c7b9ff;background:#302b50;border:1px solid #4a4271;
      font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
      vertical-align:2px;
    }
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
    .search{
      margin-left:auto;width:230px;max-width:38vw;background:#313150;
      border:1px solid #575780;border-radius:6px;color:#f0f0fa;
      outline:none;padding:7px 9px;font-size:12px;
    }
    .search:focus{border-color:var(--teal);background:#37375a}
    .search::placeholder{color:#a4a4be}
    .events{flex:1;overflow:auto;padding:6px 0;container:events / inline-size}
    .event{border-bottom:1px solid #292941}
    /* Time | category | what happened | duration | caret. */
    .event-main{
      width:100%;display:grid;grid-template-columns:76px 82px minmax(0,1fr) 72px 16px;
      align-items:center;gap:10px;padding:10px 18px;background:transparent;
      color:#d7d7e8;border:0;text-align:left;cursor:pointer;
    }
    .event-main:hover{background:#25253d}
    .event-main:focus-visible{outline:2px solid var(--teal);outline-offset:-2px}
    .time{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#9a9ab3}
    .duration{text-align:right;font-size:12px;color:#dedeee;font-variant-numeric:tabular-nums;white-space:nowrap}
    /* 13px: at 11px the glyph reads as a dot and the state is lost. */
    .caret{color:#9a9ab3;font-size:13px;line-height:1;text-align:center}
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
    .event.open .event-summary-text{font-weight:650;color:#f0f0fa}
    /* An opened row: facts first; a finished GlideAjax call as a Request card
       and a Response card, in the Update Set Lens card form. */
    .event-details{margin:0 18px 12px 196px;font-size:12px;line-height:1.45;color:#dedeee}
    .event-details[hidden]{display:none}
    .facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 10px;margin:6px 0 0;
      font-size:12px;line-height:1.45}
    .facts:first-child{margin-top:0}
    .facts dt{color:#9a9ab3;font-size:11px;padding-top:1px}
    .facts dd{margin:0;color:#dedeee;overflow-wrap:anywhere;min-width:0}
    .mono,.facts dd.mono,.facts dt.mono{font:11.5px ui-monospace,SFMono-Regular,Consolas,monospace}
    .facts dt.mono{color:#b9b9cf}
    .none{color:#9a9ab3}
    .redacted{color:#e2c48a;font-style:italic}
    .sides{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px;margin-top:10px}
    .side{background:#24243c;border:1px solid #33334f;border-left:3px solid #5b5b86;border-radius:8px;
      padding:8px 11px 9px;min-width:0}
    .side.t-amber{border-left-color:#e0b25a}
    .side-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:7px;margin:0 0 6px;padding-bottom:5px;
      border-bottom:1px solid #33334f;font-size:13px;font-weight:400;color:#f5f5ff}
    .side-head b{font-weight:650}
    .role{font-size:10.5px;color:#9a9ab3;letter-spacing:.05em;text-transform:uppercase}
    .why{margin:0 0 6px;color:#f0d9a6}
    .sub-head{margin:9px 0 3px;color:#9a9ab3;font-size:11px}
    .json{margin:4px 0 0;padding:8px 10px;background:#171725;border:1px solid #2d2d47;border-radius:6px;
      color:#c9c9dc;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;
      white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto}
    .facts dd .json{margin-top:0}
    .link{border:0;background:transparent;padding:0;margin:8px 0 0;cursor:pointer;color:#8fd6cf;
      font-size:11.5px;text-decoration:underline;text-underline-offset:2px}
    .link:hover{color:#d9fbf7}
    .link:focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-radius:3px}
    .stack[hidden]{display:none}
    /* Narrow: the cards stack by themselves; the duration column goes, since
       the Response card and the fact list say it. */
    @container events (max-width:699px){
      .event-main{grid-template-columns:62px 70px minmax(0,1fr) 16px;padding:10px 12px}
      .duration{display:none}
      .event-details{margin:0 12px 10px}
    }
    .empty{padding:48px 20px;text-align:center;color:#9a9ab3;font-size:13px;max-width:90ch;margin:0 auto}
    .toolbar{
      display:flex;align-items:center;gap:8px;padding:11px 14px;
      border-top:1px solid #2e2e4e;background:#1b1b2b;
    }
    .toolbar-note{font-size:11px;color:#9a9ab3;flex:1;max-width:90ch;margin-right:auto}
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

  /* A finished call shows its start's call stack, so a search for the script
   * that sent it finds the finished call too. */
  const eventSearchText = (event) =>
    [
      event.category,
      event.action,
      event.summary,
      event.frameLabel,
      JSON.stringify(event.details || {}),
      event.stack,
      startOf.has(event) ? startOf.get(event).stack : "",
    ]
      .join(" ")
      .toLowerCase();

  const isGlideAjaxStart = (event) =>
    event.category === "glideajax" && event.action === "start";
  const isGlideAjaxComplete = (event) =>
    event.category === "glideajax" && event.action === "complete";

  /* One row per GlideAjax call. A finished call names the start it answers
   * (details.startId: the recorder's event id, unique within one frame's
   * recording), so the pair is exact even when several calls to one Script
   * Include are in flight and answer out of order — matching by name could
   * not tell them apart. A trace from a recorder without the link pairs
   * nothing, and every start keeps its own row as before. */
  const pairGlideAjaxCalls = (events) => {
    startOf = new WeakMap();
    answerOf = new WeakMap();
    const starts = new Map();
    events.forEach((event) => {
      if (isGlideAjaxStart(event)) starts.set(event.frameId + "|" + event.id, event);
    });
    events.forEach((event) => {
      const startId = isGlideAjaxComplete(event) && event.details ? event.details.startId : undefined;
      if (typeof startId !== "number") return;
      const start = starts.get(event.frameId + "|" + startId);
      if (!start || answerOf.has(start)) return;
      startOf.set(event, start);
      answerOf.set(start, event);
    });
  };

  /* Rows that tell someone debugging the form nothing are left out of the
   * panel and the copied trace altogether, with no toggle to bring them back
   * (owner's call: a "show hidden rows" switch only confused). Three kinds:
   *  - a setValue that set the value the field already had;
   *  - the same show/hide/mandatory/read-only call, with the same arguments,
   *    again within 5 seconds of the last one (UI policies re-fire these);
   *    the first one stays;
   *  - the start of a GlideAjax call whose finished row is in the trace: that
   *    row says when it was sent and carries the start's call stack.
   * A start with no answer stays: it is the call worth looking at. */
  const REPEATABLE_METHODS = new Set([
    "hideFieldMsg",
    "setMandatory",
    "setVisible",
    "setDisplay",
    "setReadOnly",
    "setDisabled",
  ]);

  const dropNoise = (events) => {
    const latestCalls = new Map();
    return events.filter((event) => {
      const details = event.details || {};
      let noise = Boolean(details.noValueChange) || answerOf.has(event);

      if (event.category === "g_form" && REPEATABLE_METHODS.has(event.action)) {
        const key = [event.frameId, event.action, details.field || ""].join("|");
        const signature = JSON.stringify(details.arguments || []);
        const previous = latestCalls.get(key);
        if (previous && previous.signature === signature && event.time - previous.time <= 5000) {
          noise = true;
        }
        latestCalls.set(key, { signature, time: event.time });
      }
      return !noise;
    });
  };

  const filteredEvents = () =>
    shownEvents.filter((event) => {
      if (activeFilter !== "all" && event.category !== activeFilter) return false;
      return !searchQuery || eventSearchText(event).includes(searchQuery);
    });

  /* ------------------------------------------------------------------ *
   * The opened row
   *
   * Instance data goes in through textContent only. Keys and their shapes
   * are the recorder's (debug_timeline_main.js) and the worker's merge
   * (background.js, the Debug Timeline stop handler); a key not listed here
   * is never dropped: it is shown under its own name, or in "Other details".
   * ------------------------------------------------------------------ */

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  };

  /* The recorder's own marker. It writes it when the field, parameter or
   * answer key NAME matches its secret pattern (safeValue,
   * sanitizeGlideAjaxResponseValue), and for a password-type input (fieldValue),
   * so "the name suggests a secret" is said only where the name is the reason. */
  const REDACTED = "[REDACTED]";

  /* Friendly labels for keys the recorder writes, by where it writes them. */
  const KEY_LABELS = {
    // g_form calls and their errors: patchGForm.
    field: "Field",
    arguments: "Arguments",
    oldValue: "Value before",
    noValueChange: "No value change",
    // Native field events: recordNativeFieldEvent.
    value: "Value",
    tag: "Element",
    type: "Input type",
    trusted: "Trusted event",
    // Page errors: onError.
    file: "File",
    line: "Line",
    column: "Column",
    // GlideAjax: glideAjaxInfo, and durationMs on completes and errors.
    className: "Script Include",
    method: "Method",
    params: "Parameters",
    durationMs: "Took",
    // Recording start and stop: the worker's merge.
    frameCount: "Frames",
  };

  const MONO_KEYS = new Set(["field", "arguments", "oldValue", "value", "file", "params"]);

  const isPlainObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);

  const redactedNode = (byName) =>
    make("span", "redacted", byName ? "redacted — the name suggests a secret" : "redacted");

  const jsonBlock = (value) => make("pre", "json", JSON.stringify(value, null, 2));

  /* One value, as words. A primitive array reads as a list; anything nested
   * is a small JSON block. */
  const fillValue = (dd, value, options) => {
    const opts = options || {};
    if (value === REDACTED) {
      dd.appendChild(redactedNode(opts.byName));
      return;
    }
    if (value === undefined || value === null || value === "") {
      dd.appendChild(make("span", "none", value === null ? "null" : "empty"));
      return;
    }
    if (typeof value === "boolean") {
      dd.textContent = value ? "Yes" : "No";
      return;
    }
    if (typeof value === "number" || typeof value === "string") {
      dd.textContent = opts.suffix ? value + opts.suffix : String(value);
      return;
    }
    if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")) {
      if (!value.length) {
        dd.appendChild(make("span", "none", "none"));
        return;
      }
      value.forEach((item, index) => {
        if (index) dd.appendChild(document.createTextNode(", "));
        if (item === REDACTED) dd.appendChild(redactedNode(opts.byName));
        else dd.appendChild(document.createTextNode(JSON.stringify(item)));
      });
      return;
    }
    dd.appendChild(jsonBlock(value));
  };

  const addFact = (list, label, value, options) => {
    const opts = options || {};
    list.appendChild(make("dt", opts.monoLabel ? "mono" : null, label));
    const dd = make("dd", opts.mono ? "mono" : null);
    fillValue(dd, value, opts);
    list.appendChild(dd);
    return dd;
  };

  /* Parameters: each name is the label, each value the value, both
   * monospace. The recorder redacts a parameter by its name. */
  const paramFacts = (params) => {
    const list = make("dl", "facts");
    Object.keys(params).forEach((name) => {
      addFact(list, name, params[name], { mono: true, monoLabel: true, byName: true });
    });
    return list;
  };

  const frameFacts = (event) => {
    const list = make("dl", "facts");
    if (event.frameLabel) addFact(list, "Frame", event.frameLabel);
    if (event.frameUrl) addFact(list, "Page", event.frameUrl, { mono: true });
    return list;
  };

  /* A field event's value is redacted for a secret-looking name OR a
   * password input, so its reason is not given; everything else the
   * recorder redacts by name. */
  const redactedByName = (event, key) => !(event.category === "field" && key === "value");

  const otherDetails = (container, leftover) => {
    if (!Object.keys(leftover).length) return;
    container.appendChild(make("div", "sub-head", "Other details"));
    container.appendChild(jsonBlock(leftover));
  };

  /* Any other event, and a GlideAjax start: one fact list. */
  const buildFactList = (event, container) => {
    const details = event.details || {};
    const list = frameFacts(event);
    let nested = null;
    Object.keys(details).forEach((key) => {
      const value = details[key];
      if (key === "params" && isPlainObject(value)) {
        nested = value;
        return;
      }
      addFact(list, KEY_LABELS[key] || key, value, {
        mono: MONO_KEYS.has(key),
        monoLabel: !KEY_LABELS[key],
        byName: redactedByName(event, key),
        suffix: key === "durationMs" && typeof value === "number" ? " ms" : "",
      });
    });
    if (list.children.length) container.appendChild(list);
    if (nested) {
      container.appendChild(make("div", "sub-head", "Parameters"));
      container.appendChild(Object.keys(nested).length
        ? paramFacts(nested)
        : make("div", "none", "No parameters were added."));
    }
  };

  const ANSWER_FORMATS = { json: "JSON", text: "Text", oversized: "Too large to read" };

  const answerWords = (response) => {
    if (typeof response.answerLength !== "number") return "None recorded";
    const parts = [];
    if (response.format && ANSWER_FORMATS[response.format]) parts.push(ANSWER_FORMATS[response.format]);
    else if (response.format) parts.push(String(response.format));
    parts.push(response.answerLength.toLocaleString("en-US") +
      (response.answerLength === 1 ? " character" : " characters"));
    let words = parts.join(", ");
    if (response.truncated) words += "; long values were shortened in the record";
    return words;
  };

  /* Why a body was not kept, from the recorder's own reasons
   * (glideAjaxResponseInfo). Empty when it was. */
  const notKeptReason = (response) => {
    if (response.format === "oversized") {
      return "The answer was over 200,000 characters, so it was not read or kept. DevTools' Network tab has it in full.";
    }
    if (response.bodyRetained === false && response.format === "text") {
      return "The answer is not JSON, so it was not kept: there are no keys to redact it by safely. DevTools' Network tab has it in full.";
    }
    if (response.bodyRetained === false) {
      return "The answer was not kept. DevTools' Network tab has it in full.";
    }
    return "";
  };

  const sideCard = (name, role) => {
    const card = make("section", "side");
    const head = make("h3", "side-head");
    head.append(make("b", null, name), make("span", "role", role));
    card.appendChild(head);
    return card;
  };

  /* startId is the recorder's link to the start, not a fact about the call:
   * it becomes "Sent" and the call stack, or nothing when that start is not
   * in the trace (the per-frame event cap drops the oldest). */
  const PLACED_DETAILS = new Set(["className", "method", "params", "durationMs", "response", "startId"]);
  const PLACED_RESPONSE = new Set(["status", "answerLength", "truncated", "answer", "format", "bodyRetained"]);

  /* A finished GlideAjax call: what the form asked, and what came back. */
  const buildGlideAjaxCards = (event, container) => {
    const details = event.details || {};
    const frame = frameFacts(event);
    if (frame.children.length) container.appendChild(frame);

    const sides = make("div", "sides");
    const request = sideCard("Request", "what the form asked");
    const asked = make("dl", "facts");
    addFact(asked, "Script Include", details.className, { mono: true });
    addFact(asked, "Method", details.method, { mono: true });
    const start = startOf.get(event);
    if (start) addFact(asked, "Sent", formatElapsed(start.elapsedMs));
    request.appendChild(asked);
    request.appendChild(make("div", "sub-head", "Parameters"));
    const params = isPlainObject(details.params) ? details.params : {};
    request.appendChild(Object.keys(params).length
      ? paramFacts(params)
      : make("div", "none", "No parameters were added."));

    const response = isPlainObject(details.response) ? details.response : {};
    const answer = sideCard("Response", "what came back");
    const why = notKeptReason(response);
    if (why) {
      answer.classList.add("t-amber");
      answer.appendChild(make("p", "why", why));
    }
    const came = make("dl", "facts");
    if (response.status !== undefined) {
      addFact(came, "Status", response.status);
    } else {
      // getXMLAnswer hands the callback a string, which carries no status.
      came.append(make("dt", null, "Status"), make("dd", "none", "Not reported"));
    }
    if (typeof details.durationMs === "number") addFact(came, "Took", details.durationMs, { suffix: " ms" });
    else if (details.durationMs !== undefined) addFact(came, "Took", details.durationMs);
    addFact(came, "Answer", answerWords(response));
    answer.appendChild(came);
    if (Object.prototype.hasOwnProperty.call(response, "answer")) {
      answer.appendChild(make("div", "sub-head", "Decoded answer"));
      answer.appendChild(response.format === "json" || typeof response.answer !== "string"
        ? jsonBlock(response.answer)
        : make("pre", "json", response.answer));
    }
    sides.append(request, answer);
    container.appendChild(sides);

    /* Nothing is dropped: whatever the cards do not place is shown as it is. */
    const leftover = {};
    Object.keys(details).forEach((key) => {
      if (!PLACED_DETAILS.has(key)) leftover[key] = details[key];
    });
    if (details.params !== undefined && !isPlainObject(details.params)) leftover.params = details.params;
    const extraResponse = {};
    if (details.response !== undefined && !isPlainObject(details.response)) {
      leftover.response = details.response;
    } else {
      Object.keys(response).forEach((key) => {
        if (!PLACED_RESPONSE.has(key)) extraResponse[key] = response[key];
      });
      if (Object.keys(extraResponse).length) leftover.response = extraResponse;
    }
    otherDetails(container, leftover);
  };

  /* The call stack, behind its own toggle. A finished asynchronous call was
   * answered in a callback, whose stack says nothing, so it shows the stack
   * its start captured: where the call was sent from. */
  const buildStack = (event, container, id) => {
    const start = startOf.get(event);
    const text = event.stack || (start && start.stack) || "";
    if (!text) return;
    const toggle = make("button", "link");
    toggle.type = "button";
    const stack = make("pre", "json stack", text);
    stack.id = id;
    toggle.setAttribute("aria-controls", id);
    const paint = () => {
      const shown = shownStacks.has(event);
      toggle.textContent = shown ? "Hide the call stack" : "Show the call stack (best effort)";
      toggle.setAttribute("aria-expanded", shown ? "true" : "false");
      stack.hidden = !shown;
    };
    toggle.addEventListener("click", () => {
      if (shownStacks.has(event)) shownStacks.delete(event);
      else shownStacks.add(event);
      paint();
    });
    paint();
    container.append(toggle, stack);
  };

  const buildDetails = (event, container, index) => {
    const details = event.details || {};
    if (isGlideAjaxComplete(event)) buildGlideAjaxCards(event, container);
    else buildFactList(event, container);
    buildStack(event, container, "snh-dt-stack-" + index);
    if (!container.children.length && !Object.keys(details).length) {
      container.appendChild(make("div", "none", "No additional details."));
    }
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

    /* Each event's place in the whole result: stable across filters, so the
     * ids a control points at do not change under it. One map per redraw
     * rather than a linear search per row. */
    const positions = new Map();
    ((lastResult && lastResult.events) || []).forEach((event, position) => {
      positions.set(event, position);
    });
    events.forEach((event) => {
      const index = positions.get(event);
      const row = document.createElement("div");
      row.className = "event";

      const main = document.createElement("button");
      main.type = "button";
      main.className = "event-main";
      const detailId = "snh-dt-details-" + index;
      main.setAttribute("aria-controls", detailId);

      const time = document.createElement("span");
      time.className = "time";
      time.textContent = formatElapsed(event.elapsedMs);

      const category = document.createElement("span");
      category.className = "category " + String(event.category || "");
      category.textContent = CATEGORY_LABELS[event.category] || event.category || "Event";

      const summary = document.createElement("span");
      summary.className = "event-summary";
      const summaryText = document.createElement("span");
      summaryText.className = "event-summary-text";
      summaryText.textContent = event.summary || event.action || "Timeline event";
      summary.title = summaryText.textContent;
      summary.appendChild(summaryText);

      /* From the recorder's own number, never parsed out of the sentence. */
      const durationMs = event.details && event.details.durationMs;
      const duration = make("span", "duration",
        typeof durationMs === "number" ? durationMs + " ms" : "");

      const caret = make("span", "caret");
      caret.setAttribute("aria-hidden", "true");

      main.append(time, category, summary, duration, caret);

      /* Built the first time the row is painted open, not for every event on
       * every redraw: a trace holds up to 1,000 events per frame and the list
       * is redrawn on each keystroke in the search box. The empty container
       * keeps its id, so aria-controls always has a target. A row closed again
       * keeps what it built. */
      const details = make("div", "event-details");
      details.id = detailId;
      let built = false;

      const paint = () => {
        const open = openEvents.has(event);
        if (open && !built) {
          buildDetails(event, details, index);
          built = true;
        }
        row.classList.toggle("open", open);
        main.setAttribute("aria-expanded", open ? "true" : "false");
        caret.textContent = open ? "▾" : "▸";
        details.hidden = !open;
      };
      main.addEventListener("click", () => {
        if (openEvents.has(event)) openEvents.delete(event);
        else openEvents.add(event);
        paint();
      });
      paint();

      row.append(main, details);
      list.appendChild(row);
    });
  };

  /* The copy holds what the panel shows, in the same words: a finished call
   * gets its start's "Sent" time and call stack, since its start is left out.
   * startId is the recorder's link, not a fact, so it is not printed. */
  const traceAsText = () => {
    const result = lastResult || { events: [] };
    const lines = [
      "GlideLens — Debug Timeline",
      "Best-effort trace; script and UI Policy attribution is not guaranteed.",
      "Started: " + (result.startedAt ? new Date(result.startedAt).toISOString() : "unknown"),
      "Stopped: " + (result.stoppedAt ? new Date(result.stoppedAt).toISOString() : "unknown"),
      "Frames: " + String(result.frameCount || 0),
      "Events: " + String(shownEvents.length),
      "",
    ];

    shownEvents.forEach((event) => {
      const start = startOf.get(event);
      lines.push(
        formatElapsed(event.elapsedMs) +
          " [" +
          (CATEGORY_LABELS[event.category] || event.category || "Event") +
          "] " +
          (event.summary || event.action || "")
      );
      if (event.frameLabel) lines.push("  Frame: " + event.frameLabel);
      if (start) lines.push("  Sent: " + formatElapsed(start.elapsedMs));
      const details = Object.assign({}, event.details || {});
      delete details.startId;
      if (Object.keys(details).length) {
        lines.push("  Details: " + JSON.stringify(details));
      }
      const stack = event.stack || (start && start.stack) || "";
      if (stack) {
        lines.push(
          stack
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
    openEvents = new WeakSet();
    shownStacks = new WeakSet();
    pairGlideAjaxCalls(result.events || []);
    shownEvents = dropNoise(result.events || []);

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
              <button class="filter active" type="button" data-filter="all" aria-pressed="true">All</button>
              <button class="filter" type="button" data-filter="g_form" aria-pressed="false">g_form</button>
              <button class="filter" type="button" data-filter="field" aria-pressed="false">Fields</button>
              <button class="filter" type="button" data-filter="glideajax" aria-pressed="false">GlideAjax</button>
              <button class="filter" type="button" data-filter="error" aria-pressed="false">Errors</button>
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
    if (eventsCount) eventsCount.textContent = String(shownEvents.length);
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
          candidate.setAttribute("aria-pressed", candidate === button ? "true" : "false");
        });
        renderEvents();
      });
    });

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

/*
 * Isolated-world results panel for Code Search. Lazily injected alongside
 * code_search.js on first use of the palette command, so neither file costs
 * anything on pages where the feature is never used.
 *
 * Read-only throughout: rows link to the platform record, nothing here runs or
 * edits what it finds.
 *
 * RENDERING RULE — instance source code reaches this panel as text and must
 * never reach it as markup. The static shell is built with innerHTML; every
 * value that came from the instance (names, subtitles, snippets) is written
 * with textContent through createElement. A snippet is a script body by
 * definition, so innerHTML here would be running instance code inside our own
 * UI. There is no case where that is acceptable, however convenient.
 *
 * The panel is deliberately in-page rather than a separate tab (sn-utils opens
 * one). Our transport reads g_ck from the page's MAIN world; an extension tab
 * has no SN session context and would have to proxy every request back through
 * an instance tab, breaking if that tab is closed or navigated. Clicking a hit
 * opens a new tab via OPEN_URL, so results survive being acted on anyway.
 */

(() => {
  if (globalThis.SNCodeSearchUI) return;

  let host = null;
  let shadow = null;
  let keydownHandler = null;
  let onCancel = null;
  let filterText = "";
  let finished = false;
  let truncated = false;
  /* sourceId -> { summary, hits } in arrival order, so a fast source paints
   * before a slow one finishes. */
  const sources = new Map();
  const collapsed = new Set();

  const STATUS_TEXT = {
    complete: "",
    "no-matches": "no matches",
    denied: "access denied",
    absent: "not on this instance",
    "timed-out": "timed out",
    capped: "limit reached",
    error: "error",
    skipped: "skipped",
  };

  /* Statuses the user needs to see even though they produced no rows. A source
   * that was never allowed to look must not read as a source that found
   * nothing — that is the difference between "there is no such code" and "you
   * cannot see the code there is". */
  const NEEDS_ATTENTION = ["denied", "absent", "timed-out", "error"];

  const UI_CSS = `
    *{box-sizing:border-box}
    :host{
      all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      --teal:#31d4c4;--pink:#ff6fae;--band:#2a2a46;
    }
    button,input{font:inherit}
    .overlay{
      position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.52);
      display:flex;align-items:center;justify-content:center;padding:24px;
    }
    .panel{
      width:min(940px,calc(100vw - 32px));height:min(700px,calc(100vh - 40px));
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
    h2 .term{
      font:14px ui-monospace,SFMono-Regular,Consolas,monospace;
      color:color-mix(in srgb, var(--teal) 70%, #cfeee9);
    }
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
    .summary .chip-warn{
      color:#e0c187;background:#332c1b;border:1px solid #574a2c;
      border-radius:5px;padding:2px 8px;
    }
    .summary .chip-warn strong{color:#f0d79b}
    .summary .chip-scope{
      color:#bcece7;background:#183b3b;border:1px solid #2e6864;
      border-radius:5px;padding:3px 8px;
      font:11px ui-monospace,SFMono-Regular,Consolas,monospace;
    }
    .spinner{
      width:11px;height:11px;border-radius:50%;border:2px solid #45456b;
      border-top-color:var(--teal);animation:spin .7s linear infinite;
    }
    @keyframes spin{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){.spinner{animation:none}}
    .controls{
      display:flex;align-items:center;gap:8px;padding:10px 14px;
      border-bottom:1px solid #292944;
    }
    .search{
      margin-left:auto;width:250px;max-width:40vw;background:#313150;
      border:1px solid #575780;border-radius:6px;color:#f0f0fa;
      outline:none;padding:7px 9px;font-size:12px;
    }
    .search:focus{border-color:var(--teal);background:#37375a}
    .search::placeholder{color:#a4a4be}
    .rows{flex:1;overflow:auto;padding:6px 0}
    .group{border-bottom:1px solid #23233a}
    .group-head{
      display:flex;align-items:center;gap:9px;width:100%;text-align:left;
      padding:9px 20px;background:var(--band);border:0;cursor:pointer;
      color:#cfcfe4;font-size:12px;font-weight:600;
    }
    .group-head:hover{background:#32325a}
    .group-head .caret{color:#7d7d9c;font-size:9px;width:9px}
    .group-head .count{
      color:#9d9dba;font-weight:500;background:#3a3a5e;border-radius:9px;
      padding:1px 8px;font-size:11px;
    }
    .group-head .status{
      margin-left:auto;font-weight:500;font-size:11px;color:#9d9dba;
    }
    .group-head .status.warn{color:#e0c187}
    .group-head .open-list{
      border:1px solid #5b5b86;background:#3f4067;color:#e6e6f5;border-radius:6px;
      padding:3px 8px;font-size:11px;cursor:pointer;
    }
    .group-head .open-list:hover{background:#4a4b78;color:#fff}
    .row{
      display:block;width:100%;text-align:left;border:0;background:transparent;
      color:inherit;padding:10px 20px;cursor:pointer;
      border-bottom:1px solid #23233a;
    }
    .row:last-child{border-bottom:0}
    .row:hover{background:#26264080}
    .row:focus-visible{outline:2px solid var(--teal);outline-offset:-2px}
    .row-top{display:flex;align-items:baseline;gap:9px;margin-bottom:5px}
    .row-name{color:#f0f0fa;font-size:13px;font-weight:600}
    .row-sub{color:#85859f;font-size:11px;min-width:0;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap}
    .row-field{
      margin-left:auto;flex:none;font:10px ui-monospace,SFMono-Regular,Consolas,monospace;
      color:#a9a9c8;background:#2f2f4e;border-radius:4px;padding:2px 6px;
    }
    .snippet{
      font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;
      color:#b9b9d4;white-space:pre-wrap;word-break:break-word;
      display:flex;gap:10px;
    }
    .snippet + .snippet{margin-top:2px}
    .snippet .line{color:#63637f;flex:none;user-select:none;min-width:32px;text-align:right}
    .snippet mark{background:color-mix(in srgb, var(--teal) 34%, transparent);
      color:#eafffb;border-radius:2px;padding:0 1px}
    .redacted{color:#d2b779;font-style:italic}
    .empty{padding:34px 20px;text-align:center;color:#85859f;font-size:13px}
    .empty .hint{display:block;margin-top:8px;font-size:11px;color:#6e6e88}
    .drawer{border-top:1px solid #2e2e4e;background:#1a1a2a;max-height:180px;overflow:auto}
    .drawer-head{
      display:flex;align-items:center;gap:8px;width:100%;text-align:left;
      padding:8px 20px;background:transparent;border:0;cursor:pointer;
      color:#9d9dba;font-size:11px;
    }
    .drawer-head:hover{color:#dedeee}
    .drawer-head .caret{font-size:9px}
    .drawer-list{padding:2px 20px 10px;display:none}
    .drawer-list.open{display:block}
    .drawer-row{
      display:flex;gap:10px;align-items:baseline;padding:3px 0;font-size:11px;
      color:#9d9dba;
    }
    .drawer-row .name{color:#c6c6d8;min-width:170px}
    .drawer-row .tbl{font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:#6e6e88}
    .drawer-row .state{margin-left:auto}
    .drawer-row.warn .state{color:#e0c187}
    .toolbar{
      display:flex;align-items:center;gap:8px;padding:11px 16px;
      border-top:1px solid #2e2e4e;background:#20203a;
    }
    .toolbar-note{flex:1;color:#7d7d95;font-size:11px}
    .toolbar button{
      border:1px solid #5b5b86;background:#3f4067;color:#e6e6f5;border-radius:7px;
      padding:6px 12px;cursor:pointer;font-size:12px;
    }
    .toolbar button:hover{background:#4a4b78;color:#fff}
    .toolbar button:disabled{opacity:.45;cursor:default}
    .toolbar button.primary{
      background:var(--pink);border-color:var(--pink);color:#2a0d1a;font-weight:600;
    }
    .toolbar button.primary:hover{background:#ff85bb}
    @media(max-width:640px){
      .overlay{padding:8px}.panel{width:100%;height:calc(100vh - 16px)}
      .header{padding:14px}.summary{padding:9px 14px;gap:10px;flex-wrap:wrap}
      .controls{align-items:stretch;flex-direction:column}
      .search{width:100%;max-width:none;margin-left:0}
      .row-top{flex-wrap:wrap}.row-field{margin-left:0}
    }
  `;

  const close = () => {
    if (keydownHandler) {
      window.removeEventListener("keydown", keydownHandler, true);
      keydownHandler = null;
    }
    if (host) host.remove();
    host = null;
    shadow = null;
    onCancel = null;
    sources.clear();
    collapsed.clear();
    filterText = "";
    finished = false;
    truncated = false;
  };

  const openUrl = (url) => {
    try {
      chrome.runtime.sendMessage({ type: "OPEN_URL", url });
    } catch (e) {
      window.open(url, "_blank", "noopener");
    }
  };

  const openRecord = (hit) => {
    if (!hit.table || !hit.sysId) return;
    openUrl(
      location.origin + "/" + hit.table + ".do?sys_id=" + encodeURIComponent(hit.sysId)
    );
  };

  /* The whole group as a platform list, so a result set can be worked through
   * with the tools the user already has. */
  const openAsList = (entry) => {
    const ids = [];
    entry.hits.forEach((hit) => {
      if (hit.sysId && ids.indexOf(hit.sysId) === -1) ids.push(hit.sysId);
    });
    if (!ids.length) return;
    openUrl(
      location.origin +
        "/" +
        entry.summary.table +
        "_list.do?sysparm_query=" +
        encodeURIComponent("sys_idIN" + ids.join(","))
    );
  };

  const hitSearchText = (hit) =>
    [hit.name, hit.subtitle, hit.field, hit.sourceLabel]
      .concat((hit.snippets || []).map((s) => s.text))
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  const visibleHits = (entry) =>
    entry.hits.filter((hit) => !filterText || hitSearchText(hit).includes(filterText));

  const totalHits = () => {
    let total = 0;
    sources.forEach((entry) => {
      total += visibleHits(entry).length;
    });
    return total;
  };

  /*
   * One snippet line: number, then the text split around the match so the term
   * can be highlighted without building any markup from instance content.
   */
  const renderSnippet = (snippet, redacted) => {
    const line = document.createElement("div");
    line.className = "snippet";

    const number = document.createElement("span");
    number.className = "line";
    number.textContent = snippet.line ? String(snippet.line) : "";
    line.appendChild(number);

    const body = document.createElement("span");
    if (redacted) {
      body.className = "redacted";
      body.textContent = snippet.text + "  (redacted — the name suggests a secret)";
      line.appendChild(body);
      return line;
    }

    const text = String(snippet.text || "");
    const start = Math.max(0, snippet.matchStart || 0);
    const end = Math.max(start, snippet.matchEnd || 0);

    const before = document.createTextNode(text.slice(0, start));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(start, end);
    const after = document.createTextNode(text.slice(end));

    body.appendChild(before);
    if (mark.textContent) body.appendChild(mark);
    body.appendChild(after);
    line.appendChild(body);
    return line;
  };

  const renderRow = (hit) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row";
    row.title = "Open " + hit.table + " record";

    const top = document.createElement("div");
    top.className = "row-top";

    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = hit.name || "(unnamed)";
    top.appendChild(name);

    if (hit.subtitle) {
      const sub = document.createElement("span");
      sub.className = "row-sub";
      sub.textContent = hit.subtitle;
      top.appendChild(sub);
    }

    const field = document.createElement("span");
    field.className = "row-field";
    field.textContent = hit.field;
    top.appendChild(field);

    row.appendChild(top);
    (hit.snippets || []).forEach((snippet) =>
      row.appendChild(renderSnippet(snippet, hit.redacted))
    );

    row.addEventListener("click", () => openRecord(hit));
    return row;
  };

  const renderGroup = (entry) => {
    const hits = visibleHits(entry);
    const isCollapsed = collapsed.has(entry.summary.id);

    const group = document.createElement("div");
    group.className = "group";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "group-head";

    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = isCollapsed ? "▶" : "▼";
    head.appendChild(caret);

    const label = document.createElement("span");
    label.textContent = entry.summary.label;
    head.appendChild(label);

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(hits.length);
    head.appendChild(count);

    const statusText = STATUS_TEXT[entry.summary.status] || "";
    if (statusText) {
      const status = document.createElement("span");
      status.className =
        "status" + (NEEDS_ATTENTION.indexOf(entry.summary.status) !== -1 ? " warn" : "");
      status.textContent = statusText;
      head.appendChild(status);
    }

    head.addEventListener("click", () => {
      if (isCollapsed) collapsed.delete(entry.summary.id);
      else collapsed.add(entry.summary.id);
      renderRows();
    });
    group.appendChild(head);

    if (!isCollapsed) {
      if (hits.length) {
        const list = document.createElement("div");
        hits.forEach((hit) => list.appendChild(renderRow(hit)));
        group.appendChild(list);

        const listButton = document.createElement("button");
        listButton.type = "button";
        listButton.className = "open-list";
        listButton.textContent = "Open these in a list ↗";
        listButton.style.margin = "6px 20px 10px";
        listButton.addEventListener("click", (event) => {
          event.stopPropagation();
          openAsList(entry);
        });
        group.appendChild(listButton);
      }
    }
    return group;
  };

  const renderRows = () => {
    if (!shadow) return;
    const container = shadow.querySelector(".rows");
    if (!container) return;
    container.textContent = "";

    const entries = [];
    sources.forEach((entry) => entries.push(entry));

    /* Sources with hits first; then anything the user needs to know about
     * even though it produced none. A silent nothing is never shown as a
     * group — it lives in the status drawer. */
    const withHits = entries.filter((entry) => visibleHits(entry).length > 0);
    const attention = entries.filter(
      (entry) =>
        visibleHits(entry).length === 0 &&
        NEEDS_ATTENTION.indexOf(entry.summary.status) !== -1
    );

    withHits.concat(attention).forEach((entry) =>
      container.appendChild(renderGroup(entry))
    );

    if (!withHits.length && !attention.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = finished
        ? filterText
          ? "Nothing in the results matches that filter."
          : "No matches."
        : "Searching…";
      if (finished && !filterText) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent =
          "Every source reported in — see the source status below for what was searched.";
        empty.appendChild(hint);
      }
      container.appendChild(empty);
    }

    updateSummary();
    renderDrawer();
  };

  const updateSummary = () => {
    if (!shadow) return;
    const total = shadow.querySelector("[data-count='total']");
    if (total) total.textContent = String(totalHits());
    const done = shadow.querySelector("[data-count='sources']");
    if (done) done.textContent = String(sources.size);
    const spinner = shadow.querySelector(".spinner");
    if (spinner) spinner.style.display = finished ? "none" : "";
    const cap = shadow.querySelector("[data-cap]");
    if (cap) cap.style.display = truncated ? "" : "none";
    const cancel = shadow.querySelector("[data-action='cancel']");
    if (cancel) cancel.disabled = finished;
  };

  /* Every source, including the quiet ones. This drawer is the honest answer
   * to "did it really look everywhere?" */
  const renderDrawer = () => {
    if (!shadow) return;
    const list = shadow.querySelector(".drawer-list");
    if (!list) return;
    list.textContent = "";
    sources.forEach((entry) => {
      const summary = entry.summary;
      const row = document.createElement("div");
      row.className =
        "drawer-row" + (NEEDS_ATTENTION.indexOf(summary.status) !== -1 ? " warn" : "");

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = summary.label;
      row.appendChild(name);

      const table = document.createElement("span");
      table.className = "tbl";
      table.textContent = summary.table;
      row.appendChild(table);

      const state = document.createElement("span");
      state.className = "state";
      const parts = [];
      if (summary.status === "complete" || summary.status === "capped") {
        parts.push(summary.count + (summary.count === 1 ? " match" : " matches"));
      }
      if (STATUS_TEXT[summary.status]) parts.push(STATUS_TEXT[summary.status]);
      if (summary.missingFields && summary.missingFields.length) {
        parts.push("not on this instance: " + summary.missingFields.join(", "));
      }
      if (summary.unverified) parts.push("fields unverified");
      state.textContent = parts.join(" · ") || "searched";
      row.appendChild(state);

      list.appendChild(row);
    });
  };

  const mount = (term, tableFilters) => {
    close();
    host = document.createElement("div");
    host.id = "sn-dev-helper-code-search";
    shadow = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);

    shadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="overlay">
        <section class="panel" role="dialog" aria-label="Code search results">
          <header class="header">
            <div class="heading">
              <h2>Code search <span class="term"></span></h2>
              <p class="subtitle">
                Configuration source the platform's own code search does not
                reach — reference qualifiers, catalog variables, transform maps
                — alongside everyday scripts.
              </p>
            </div>
            <button class="close" type="button" aria-label="Close">✕ Esc</button>
          </header>
          <div class="summary">
            <span class="chip-scope" data-scope style="display:none"></span>
            <span><strong data-count="total">0</strong>matches</span>
            <span><strong data-count="sources">0</strong>sources reported</span>
            <span class="spinner" aria-label="Searching"></span>
            <span class="chip-warn" data-cap style="display:none">
              <strong>Capped</strong> — refine the term to see the rest
            </span>
          </div>
          <div class="controls">
            <input class="search" type="search" placeholder="Filter these results…"
                   aria-label="Filter loaded results">
          </div>
          <div class="rows"></div>
          <div class="drawer">
            <button class="drawer-head" type="button">
              <span class="caret">▶</span><span>Source status — what was searched</span>
            </button>
            <div class="drawer-list"></div>
          </div>
          <footer class="toolbar">
            <span class="toolbar-note">Read-only — nothing here runs or edits what it finds.</span>
            <button type="button" data-action="cancel">Cancel</button>
            <button class="primary" type="button" data-action="close">Close</button>
          </footer>
        </section>
      </div>
    `;

    const termEl = shadow.querySelector(".term");
    if (termEl) termEl.textContent = term ? "“" + term + "”" : "";

    const tables = (Array.isArray(tableFilters) ? tableFilters : []).filter(Boolean);
    const scopeEl = shadow.querySelector("[data-scope]");
    if (scopeEl && tables.length) {
      scopeEl.style.display = "";
      scopeEl.textContent =
        (tables.length === 1 ? "Scoped to table: " : "Scoped to tables: ") +
        tables.join(", ");
      scopeEl.title = "Only the named table source" +
        (tables.length === 1 ? " was" : "s were") + " searched";
    }

    shadow.querySelector(".close").addEventListener("click", close);
    shadow
      .querySelector("[data-action='close']")
      .addEventListener("click", close);

    const cancelButton = shadow.querySelector("[data-action='cancel']");
    cancelButton.addEventListener("click", () => {
      if (onCancel) onCancel();
      finished = true;
      updateSummary();
    });

    const search = shadow.querySelector(".search");
    search.addEventListener("input", () => {
      filterText = search.value.trim().toLowerCase();
      renderRows();
    });

    const drawerHead = shadow.querySelector(".drawer-head");
    drawerHead.addEventListener("click", () => {
      const list = shadow.querySelector(".drawer-list");
      const open = list.classList.toggle("open");
      drawerHead.querySelector(".caret").textContent = open ? "▼" : "▶";
    });

    const overlay = shadow.querySelector(".overlay");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });

    keydownHandler = (event) => {
      if (event.key !== "Escape" || !host) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", keydownHandler, true);

    renderRows();
  };

  /* ---------------------------------------------------------------------
   * Public API — the search itself lives in code_search.js; this only shows
   * what it reports.
   * ------------------------------------------------------------------- */

  const open = (options) => {
    const opts = options || {};
    mount(opts.term, opts.tables);
    onCancel = opts.onCancel || null;
  };

  const addSource = (summary, hits) => {
    if (!shadow || !summary) return;
    sources.set(summary.id, { summary, hits: hits || [] });
    renderRows();
  };

  const complete = (result) => {
    if (!shadow) return;
    finished = true;
    truncated = Boolean(result && result.truncated);
    renderRows();
  };

  const showError = (message) => {
    if (!shadow) return;
    finished = true;
    const container = shadow.querySelector(".rows");
    container.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = String(message || "The search could not run.");
    container.appendChild(empty);
    updateSummary();
  };

  const isOpen = () => Boolean(host);

  globalThis.SNCodeSearchUI = { open, addSource, complete, showError, close, isOpen };
})();

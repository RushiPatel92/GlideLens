/*
 * Isolated-world Record Search panel. Instance values are always assigned with
 * textContent; only this file's static shell uses innerHTML.
 */
(() => {
  if (globalThis.SNRecordSearchUI) return;

  let host = null;
  let shadow = null;
  let keydownHandler = null;
  let onSearch = null;
  let onCancel = null;
  let requestSequence = 0;

  const UI_CSS = `
    *{box-sizing:border-box}
    :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      --teal:#31d4c4;--pink:#ff6fae}
    button,input{font:inherit}
    .overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.52);
      display:flex;align-items:center;justify-content:center;padding:12px}
    .panel{width:min(880px,calc(100vw - 24px));height:min(720px,calc(100vh - 24px));
      display:flex;flex-direction:column;overflow:hidden;background:#1e1e2e;
      border:1px solid #3a3a5c;border-radius:12px;box-shadow:0 28px 80px rgba(0,0,0,.65);
      color:#dedeee}
    .header{display:flex;align-items:flex-start;gap:14px;padding:18px 20px 14px;
      border-bottom:1px solid #2e2e4e}
    .heading{flex:1;min-width:0}h2{font-size:17px;line-height:1.2;margin:0 0 5px;
      color:#f5f5ff;font-weight:650}.subtitle{font-size:12px;color:#9292aa;line-height:1.45;margin:0}
    .close{border:0;background:transparent;color:#9292aa;padding:3px 5px;font-size:12px;
      cursor:pointer;border-radius:5px}.close:hover{color:#fff;background:#2d2d48}
    .form{display:grid;grid-template-columns:minmax(180px,.7fr) minmax(260px,1.5fr) auto;
      gap:10px;align-items:end;padding:14px 20px;border-bottom:1px solid #292944;background:#202038}
    label{display:flex;flex-direction:column;gap:5px;color:#bdbdd0;font-size:11px;font-weight:600}
    input{width:100%;background:#151522;border:1px solid #555578;border-radius:7px;color:#f0f0fa;
      outline:none;padding:9px 10px;font-size:13px;font-weight:400}
    input:focus{border-color:var(--teal);background:#191929}
    input::placeholder{color:#797993}.search-btn,.toolbar button{border:1px solid #5b5b86;
      background:#3f4067;color:#e6e6f5;border-radius:7px;padding:8px 13px;cursor:pointer;font-size:12px}
    .search-btn{background:var(--pink);border-color:var(--pink);color:#2a0d1a;font-weight:650;height:36px}
    .search-btn:hover{background:#ff85bb}.search-btn:disabled{opacity:.5;cursor:default}
    .status{min-height:40px;display:flex;align-items:center;gap:9px;padding:9px 20px;
      border-bottom:1px solid #292944;color:#aaaac1;font-size:11px}
    .status.error{color:#ef9b9b}.status strong{color:#f0f0fa}
    .spinner{width:12px;height:12px;border-radius:50%;border:2px solid #45456b;
      border-top-color:var(--teal);animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){.spinner{animation:none}}
    .rows{flex:1;overflow:auto;padding:6px 0}.empty{padding:46px 20px;text-align:center;
      color:#9292aa;font-size:13px;line-height:1.5}.empty small{display:block;margin-top:7px;color:#74748d}
    .row{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;
      padding:12px 20px;cursor:pointer;border-bottom:1px solid #282841}
    .row:hover{background:#282842}.row:focus-visible{outline:2px solid var(--teal);outline-offset:-2px}
    .row-top{display:flex;align-items:baseline;gap:10px;margin-bottom:6px}.title{color:#f0f0fa;
      font-size:13px;font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sys-id{margin-left:auto;color:#767690;font:10px ui-monospace,SFMono-Regular,Consolas,monospace}
    .values{display:flex;flex-wrap:wrap;gap:5px 12px;color:#aaaac1;font-size:11px;line-height:1.5}
    .value-label{color:#75758e}.toolbar{display:flex;align-items:center;gap:8px;padding:11px 16px;
      border-top:1px solid #2e2e4e;background:#20203a}.toolbar-note{flex:1;color:#85859d;font-size:11px}
    .toolbar button:hover{background:#4a4b78;color:#fff}
    @media(max-width:640px){.overlay{padding:8px}.panel{width:100%;height:calc(100vh - 16px)}
      .form{grid-template-columns:1fr}.search-btn{width:100%}.header{padding:14px}.sys-id{display:none}}
  `;

  function setStatus(message, kind, loading) {
    if (!shadow) return;
    const status = shadow.querySelector(".status");
    status.textContent = "";
    status.className = "status" + (kind === "error" ? " error" : "");
    if (loading) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      spinner.setAttribute("aria-label", "Searching");
      status.appendChild(spinner);
    }
    const text = document.createElement("span");
    text.textContent = String(message || "");
    status.appendChild(text);
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

  function openRecord(result) {
    if (!result || !result.table || !result.sysId) return;
    const url =
      location.origin + "/" + result.table + ".do?sys_id=" +
      encodeURIComponent(result.sysId);
    chrome.runtime.sendMessage({ type: "OPEN_URL", url });
  }

  function renderResults(result) {
    if (!shadow || !result) return;
    const rows = shadow.querySelector(".rows");
    rows.textContent = "";
    const results = Array.isArray(result.results) ? result.results : [];
    const suffix = result.truncated ? " · showing the first 20 verified matches" : "";
    setStatus(
      results.length + (results.length === 1 ? " record" : " records") +
        " in " + (result.tableLabel || result.table) + suffix,
      "",
      false
    );

    if (!results.length) {
      renderEmpty(
        "No verified matches.",
        "Try a record number, name, email, short description, or exact sys_id."
      );
      return;
    }

    results.forEach((resultRow) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "row";
      row.addEventListener("click", () => openRecord(resultRow));

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
      (resultRow.values || []).forEach((item, index) => {
        if (!item.value || (index === 0 && item.value === resultRow.title)) return;
        const value = document.createElement("span");
        const label = document.createElement("span");
        label.className = "value-label";
        label.textContent = (item.label || item.field) + ": ";
        value.appendChild(label);
        value.appendChild(document.createTextNode(item.value));
        values.appendChild(value);
      });
      if (values.childNodes.length) row.appendChild(values);
      rows.appendChild(row);
    });
  }

  async function submit() {
    if (!shadow || !onSearch) return;
    const tableInput = shadow.querySelector("[data-input='table']");
    const termInput = shadow.querySelector("[data-input='term']");
    const button = shadow.querySelector(".search-btn");
    const sequence = ++requestSequence;
    button.disabled = true;
    setStatus("Checking the table and searching verified summary fields…", "", true);
    renderEmpty("Searching…", "Results are read-only and stay in this panel.");
    try {
      const result = await onSearch({ table: tableInput.value, term: termInput.value });
      if (sequence !== requestSequence || !result || result.stale) return;
      renderResults(result);
    } catch (error) {
      if (sequence !== requestSequence) return;
      const message = String(error && error.message ? error.message : error);
      setStatus(message, "error", false);
      renderEmpty("The search could not run.", message);
    } finally {
      if (sequence === requestSequence && shadow) button.disabled = false;
    }
  }

  function close() {
    requestSequence += 1;
    if (onCancel) onCancel();
    if (keydownHandler) window.removeEventListener("keydown", keydownHandler, true);
    if (host) host.remove();
    host = null;
    shadow = null;
    keydownHandler = null;
    onSearch = null;
    onCancel = null;
  }

  function open(options) {
    close();
    const opts = options || {};
    onSearch = opts.onSearch || null;
    onCancel = opts.onCancel || null;
    host = document.createElement("div");
    host.id = "sn-dev-helper-record-search";
    shadow = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);
    shadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="overlay">
        <section class="panel" role="dialog" aria-modal="true" aria-label="Record search">
          <header class="header">
            <div class="heading">
              <h2>Search records</h2>
              <p class="subtitle">Choose one table. GlideLens searches only schema-confirmed summary fields and opens results in ServiceNow.</p>
            </div>
            <button class="close" type="button" aria-label="Close">✕ Esc</button>
          </header>
          <form class="form">
            <label>Table
              <input data-input="table" placeholder="incident" autocomplete="off" spellcheck="false">
            </label>
            <label>Text or sys_id
              <input data-input="term" placeholder="number, name, email, or 32-character sys_id" autocomplete="off" spellcheck="false">
            </label>
            <button class="search-btn" type="submit">Search</button>
          </form>
          <div class="status">Enter a technical table name and something to find.</div>
          <div class="rows"></div>
          <footer class="toolbar">
            <span class="toolbar-note">Read-only · at most 20 verified results · record contents are not stored</span>
            <button type="button" data-action="close">Close</button>
          </footer>
        </section>
      </div>`;

    renderEmpty(
      "Find a record without navigating through list pages.",
      "Text search uses verified display and common summary fields; sys_id lookup is exact."
    );
    shadow.querySelector(".form").addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });
    shadow.querySelector(".close").addEventListener("click", close);
    shadow.querySelector("[data-action='close']").addEventListener("click", close);
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
    shadow.querySelector("[data-input='table']").focus();
  }

  globalThis.SNRecordSearchUI = {
    open,
    close,
    isOpen: () => Boolean(host),
  };
})();

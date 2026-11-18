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
 * an instance tab, breaking if that tab is closed or navigated. Clicking a
 * record's name opens a new tab via OPEN_URL, so results survive being acted
 * on anyway.
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
  /* What had focus before the panel opened, given back when it closes. */
  let previousFocus = null;
  /* The final count is announced once, whichever of complete, cancel or an
   * error comes first. */
  let announcedFinal = false;
  /* sourceId -> { summary, hits } in arrival order, so a fast source paints
   * before a slow one finishes. */
  const sources = new Map();
  const collapsed = new Set();
  /* Group key -> the id of that group's list, kept for the panel's life so a
   * head's aria-controls names the same element across every rebuild. */
  const groupIds = new Map();
  /* Focus key -> the control drawn for it by the latest rebuild. */
  let focusables = new Map();

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
    h2 .term{
      font:14px ui-monospace,SFMono-Regular,Consolas,monospace;
      color:color-mix(in srgb, var(--teal) 70%, #cfeee9);
    }
    .subtitle{font-size:12px;color:#9a9ab3;line-height:1.45;max-width:90ch}
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
      margin-left:auto;width:320px;max-width:48vw;background:#313150;
      border:1px solid #575780;border-radius:6px;color:#f0f0fa;
      outline:none;padding:7px 9px;font-size:12px;
    }
    .search:focus{border-color:var(--teal);background:#37375a}
    .search::placeholder{color:#a4a4be}
    .rows{flex:1;overflow:auto;padding:6px 0;container:rows / inline-size}
    .group{border-bottom:1px solid #23233a}
    .group-head{
      display:flex;align-items:center;gap:9px;width:100%;text-align:left;
      padding:9px 20px;background:var(--band);border:0;cursor:pointer;
      color:#cfcfe4;font-size:12px;font-weight:600;
    }
    .group-head:hover{background:#32325a}
    .group-head .caret{color:#9a9ab3;font-size:9px;width:9px}
    .group-head .count{
      color:#9d9dba;font-weight:500;background:#3a3a5e;border-radius:9px;
      padding:1px 8px;font-size:11px;
    }
    .group-head .status{
      margin-left:auto;font-weight:500;font-size:11px;color:#9d9dba;
    }
    .group-head .status.warn{color:#e0c187}
    /* The list button follows the group's rows; it is a child of .group, not of
     * .group-head (a button cannot hold a button). */
    .group > .open-list{
      margin:6px 20px 10px;
      border:1px solid #5b5b86;background:#3f4067;color:#e6e6f5;border-radius:6px;
      padding:3px 8px;font-size:11px;cursor:pointer;
    }
    .group > .open-list:hover{background:#4a4b78;color:#fff}
    .group > .open-list:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
    /* One block per record: its name is the one control, and each field it
       matched in is said once, in a column beside that field's lines. */
    .rec{padding:10px 20px 11px;border-bottom:1px solid #23233a}
    .rec:last-child{border-bottom:0}
    .rec-head{display:flex;align-items:baseline;gap:9px;margin-bottom:6px;min-width:0}
    .rec-name{
      flex:0 1 auto;min-width:0;border:0;background:transparent;padding:0;margin:0;cursor:pointer;
      text-align:left;color:#f0f0fa;font-size:13px;font-weight:600;line-height:1.35;
      text-decoration:underline;text-decoration-color:#6c6c90;text-underline-offset:2px;
      overflow-wrap:anywhere;
    }
    .rec-name:hover{color:#fff;text-decoration-color:var(--teal)}
    .rec-name:focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-radius:3px}
    .row-sub{color:#9a9ab3;font-size:11px;min-width:0;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap}
    .fields{display:grid;grid-template-columns:124px minmax(0,1fr);gap:7px 8px;margin:0}
    .fields dt{
      font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#9a9ab3;
      overflow-wrap:anywhere;
    }
    .fields dd{margin:0;min-width:0}
    /* Narrow: the field name moves above its lines. */
    @container rows (max-width:639px){
      .fields{grid-template-columns:minmax(0,1fr);gap:2px 0}
      .fields dd{margin-bottom:6px}
      .fields dd:last-child{margin-bottom:0}
    }
    .snippet{
      font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;
      color:#b9b9d4;white-space:pre-wrap;word-break:break-word;
      display:flex;gap:10px;
    }
    .snippet + .snippet{margin-top:2px}
    .snippet .line{color:#9a9ab3;flex:none;user-select:none;min-width:32px;text-align:right}
    .snippet mark{background:color-mix(in srgb, var(--teal) 34%, transparent);
      color:#eafffb;border-radius:2px;padding:0 1px}
    .redacted{color:#d2b779;font-style:italic}
    .empty{padding:34px 20px;text-align:center;color:#9a9ab3;font-size:13px;max-width:90ch;margin:0 auto}
    .empty .hint{display:block;margin-top:8px;font-size:11px;color:#9a9ab3}
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
    .drawer-row .tbl{font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:#9a9ab3}
    .drawer-row .state{margin-left:auto}
    .drawer-row.warn .state{color:#e0c187}
    .sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
      clip:rect(0 0 0 0);white-space:nowrap;border:0}
    .toolbar{
      display:flex;align-items:center;gap:8px;padding:11px 16px;
      border-top:1px solid #2e2e4e;background:#20203a;
    }
    .toolbar-note{flex:1;color:#9a9ab3;font-size:11px;max-width:90ch;margin-right:auto}
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
    groupIds.clear();
    focusables = new Map();
    filterText = "";
    finished = false;
    truncated = false;
    announcedFinal = false;
    const restore = previousFocus;
    previousFocus = null;
    if (restore && typeof restore.focus === "function") {
      try {
        restore.focus({ preventScroll: true });
      } catch (e) {
        try { restore.focus(); } catch (ignored) { /* the opener is gone */ }
      }
    }
  };

  /* A control in the result list, remembered by what it stands for (a group
   * key, a record key) so a rebuild can give focus back to its replacement.
   * Never by text or position: both change as sources report. */
  const remember = (node, key) => {
    node.snhFocusKey = key;
    focusables.set(key, node);
    return node;
  };

  const within = (node, ancestor) => {
    for (let current = node; current; current = current.parentNode) {
      if (current === ancestor) return true;
    }
    return false;
  };

  const groupListId = (key) => {
    if (!groupIds.has(key)) groupIds.set(key, "snh-cs-group-" + (groupIds.size + 1));
    return groupIds.get(key);
  };

  /* Every control Tab can reach, in document order, skipping hidden parts. */
  const focusableElements = () => {
    const out = [];
    const walk = (node) => {
      Array.from((node && node.children) || []).forEach((child) => {
        if (child.hidden || (child.style && child.style.display === "none")) return;
        const tag = String(child.tagName || "").toLowerCase();
        if ((tag === "button" || tag === "input") && !child.disabled) out.push(child);
        walk(child);
      });
    };
    walk(shadow);
    return out;
  };

  const announce = (text) => {
    const live = shadow && shadow.querySelector("[data-live]");
    if (live) live.textContent = text;
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
        entry.table +
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

  /*
   * Results are grouped by TABLE, not by source. Two tiers can report the same
   * table — the instance's own index and our adapter for the fields it does not
   * cover — and which pipe found a record is our plumbing, not something a
   * person searching for code should have to reconcile into one mental list.
   *
   * The status drawer stays per-source, because "did it really look everywhere"
   * is a question about sources and answering it needs them kept apart.
   */
  const GROUP_STATUS_ORDER = [
    "capped",
    "denied",
    "timed-out",
    "error",
    "absent",
    "complete",
    "no-matches",
    "skipped",
  ];

  const groupStatus = (statuses) => {
    for (let i = 0; i < GROUP_STATUS_ORDER.length; i++) {
      if (statuses.indexOf(GROUP_STATUS_ORDER[i]) !== -1) return GROUP_STATUS_ORDER[i];
    }
    return statuses[0] || "complete";
  };

  const displayGroups = () => {
    const groups = new Map();
    sources.forEach((entry) => {
      const summary = entry.summary;
      const key = summary.groupKey || summary.table || summary.id;
      const group =
        groups.get(key) ||
        groups.set(key, {
          key,
          label: summary.groupLabel || summary.label,
          table: summary.table,
          hits: [],
          statuses: [],
        }).get(key);
      group.hits = group.hits.concat(visibleHits(entry));
      group.statuses.push(summary.status);
    });
    const list = [];
    groups.forEach((group) => {
      group.status = groupStatus(group.statuses);
      group.hits = clusterByRecord(group.hits);
      group.records = countRecords(group.hits);
      list.push(group);
    });
    return list;
  };

  const totalHits = () => {
    let total = 0;
    sources.forEach((entry) => {
      total += visibleHits(entry).length;
    });
    return total;
  };

  /*
   * Matches and records are different numbers and the panel says both.
   * Hit identity is table+sysId+FIELD, so one UI Action matching in `name`,
   * `condition` and `script` is three findings with three snippets — correct,
   * and worth seeing. But "6" beside a button that then opens two records is a
   * number contradicting itself one click later, so neither count is left to be
   * inferred from the other.
   */
  const recordKey = (hit) => String(hit.table || "") + "|" + String(hit.sysId || "");

  const countRecords = (hits) => {
    const seen = Object.create(null);
    let count = 0;
    (hits || []).forEach((hit) => {
      const key = recordKey(hit);
      if (seen[key]) return;
      seen[key] = true;
      count += 1;
    });
    return count;
  };

  const totalRecords = () => {
    const all = [];
    sources.forEach((entry) => {
      visibleHits(entry).forEach((hit) => all.push(hit));
    });
    return countRecords(all);
  };

  /*
   * Keeps every field-match for one record together, in the order the records
   * first appeared. Without this a record's hits can be split across the group:
   * Tier 1 streams before the adapters, so a UI Action's `script` hit (instance
   * index) and its `condition` hit (our adapter) arrive at opposite ends. The
   * record count is only believable if the rows visibly cluster.
   */
  const clusterByRecord = (hits) => {
    const order = [];
    const byRecord = Object.create(null);
    (hits || []).forEach((hit) => {
      const key = recordKey(hit);
      if (!byRecord[key]) {
        byRecord[key] = [];
        order.push(key);
      }
      byRecord[key].push(hit);
    });
    let out = [];
    order.forEach((key) => {
      out = out.concat(byRecord[key]);
    });
    return out;
  };

  /*
   * One entry per record, in the order records first appeared, each holding
   * its fields in the order they first appeared and each field's snippets in
   * arrival order. Every hit lands in exactly one record and one field.
   *
   * Two hits for one record and one field (two sources reporting the same
   * place) merge under one field label and keep every snippet. The caller
   * dedupes table+sysId+field on the way in, so this should not happen, but
   * the panel's own API does not promise it, and a dropped snippet is a hole.
   * Redaction stays with the hit each snippet came from.
   *
   * The head describes the RECORD, and hits for one record can disagree about
   * it. An instance-index hit (kind "instance") carries the matched field's
   * label as its subtitle -- a fact about the field, which the field column
   * already states -- so the head's subtitle is the first subtitle from any
   * other kind of hit, and with none the head has no subtitle. The name is
   * the first hit's, unless that is only the record's sys_id (both tiers fall
   * back to it) and a later hit has a real name.
   */
  const recordHead = (records) => {
    records.forEach((record) => {
      const recordHit = record.hits.find((hit) => hit.kind !== "instance");
      record.subtitle = recordHit ? recordHit.subtitle : "";
      const sysId = String(record.sysId || "");
      const named = (hit) => Boolean(hit.name) && String(hit.name) !== sysId;
      const first = record.hits[0];
      const real = named(first) ? first : record.hits.find(named);
      record.name = (real || first).name;
    });
    return records;
  };

  const groupHitsByRecord = (hits) => {
    const records = [];
    const byKey = Object.create(null);
    (hits || []).forEach((hit) => {
      const key = recordKey(hit);
      let record = byKey[key];
      if (!record) {
        record = byKey[key] = {
          key,
          table: hit.table,
          sysId: hit.sysId,
          name: "",
          subtitle: "",
          first: hit,
          hits: [],
          fields: [],
        };
        records.push(record);
      }
      record.hits.push(hit);
      const fieldName = String(hit.field || "");
      let field = record.fields.find((candidate) => candidate.field === fieldName);
      if (!field) {
        field = { field: fieldName, hits: [], snippets: [] };
        record.fields.push(field);
      }
      field.hits.push(hit);
      (hit.snippets || []).forEach((snippet) =>
        field.snippets.push({ snippet, redacted: Boolean(hit.redacted) })
      );
    });
    return recordHead(records);
  };

  const plural = (count, one, many) => count + " " + (count === 1 ? one : many);

  /* A source that was denied, absent, timed out or errored and found nothing
   * has no count to give: "0 matches in 0 records" beside "access denied" reads
   * as a search that looked and found nothing. Its status says it alone. */
  const groupCountText = (entry) => {
    const hits = (entry && entry.hits) || [];
    if (!hits.length && NEEDS_ATTENTION.indexOf(entry && entry.status) !== -1) return "";
    return (
      plural(hits.length, "match", "matches") +
      " in " +
      plural((entry && entry.records) || 0, "record", "records")
    );
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

  /* The name is the record's one control; the code under it is plain text that
   * can be selected and copied, and a click on it does nothing. */
  const renderRecord = (record, groupKey) => {
    const block = document.createElement("div");
    block.className = "rec";

    const head = document.createElement("div");
    head.className = "rec-head";

    const name = document.createElement("button");
    name.type = "button";
    name.className = "rec-name";
    name.title = "Open " + record.table + " record";
    name.textContent = record.name || "(unnamed)";
    name.addEventListener("click", () => openRecord(record.first));
    remember(name, "record:" + groupKey + ":" + record.key);
    head.appendChild(name);

    if (record.subtitle) {
      const sub = document.createElement("span");
      sub.className = "row-sub";
      sub.textContent = record.subtitle;
      head.appendChild(sub);
    }
    block.appendChild(head);

    const fields = document.createElement("dl");
    fields.className = "fields";
    record.fields.forEach((field) => {
      const term = document.createElement("dt");
      term.textContent = field.field;
      const lines = document.createElement("dd");
      field.snippets.forEach((entry) =>
        lines.appendChild(renderSnippet(entry.snippet, entry.redacted))
      );
      fields.append(term, lines);
    });
    block.appendChild(fields);
    return block;
  };

  const renderGroup = (entry) => {
    const hits = entry.hits;
    const isCollapsed = collapsed.has(entry.key);

    const group = document.createElement("div");
    group.className = "group";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "group-head";
    const listId = groupListId(entry.key);
    head.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    head.setAttribute("aria-controls", listId);
    remember(head, "head:" + entry.key);

    const caret = document.createElement("span");
    caret.className = "caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = isCollapsed ? "▶" : "▼";
    head.appendChild(caret);

    const label = document.createElement("span");
    label.textContent = entry.label;
    head.appendChild(label);

    const countText = groupCountText(entry);
    if (countText) {
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = countText;
      head.appendChild(count);
    }

    const statusText = STATUS_TEXT[entry.status] || "";
    if (statusText) {
      const status = document.createElement("span");
      status.className =
        "status" + (NEEDS_ATTENTION.indexOf(entry.status) !== -1 ? " warn" : "");
      status.textContent = statusText;
      head.appendChild(status);
    }

    head.addEventListener("click", () => {
      if (isCollapsed) collapsed.delete(entry.key);
      else collapsed.add(entry.key);
      renderRows();
    });
    group.appendChild(head);

    /* The list the head controls is always drawn, so aria-controls always has
     * a target: a collapsed group's is empty and hidden, as Debug Timeline
     * does for a closed row. */
    const list = document.createElement("div");
    list.id = listId;
    if (isCollapsed) {
      list.hidden = true;
      group.appendChild(list);
    } else {
      group.appendChild(list);
      if (hits.length) {
        groupHitsByRecord(hits).forEach((record) =>
          list.appendChild(renderRecord(record, entry.key))
        );

        const listButton = document.createElement("button");
        listButton.type = "button";
        listButton.className = "open-list";
        /* Names the number the list will actually contain, at the point where
         * the expectation is set rather than after the click. */
        listButton.textContent =
          entry.records === 1
            ? "Open this record in a list ↗"
            : "Open these " + entry.records + " records in a list ↗";
        listButton.addEventListener("click", (event) => {
          event.stopPropagation();
          openAsList(entry);
        });
        remember(listButton, "list:" + entry.key);
        group.appendChild(listButton);
      }
    }
    return group;
  };

  const renderRows = () => {
    if (!shadow) return;
    const container = shadow.querySelector(".rows");
    if (!container) return;

    /* The whole list is rebuilt each time a source reports, a group is
     * collapsed or the filter changes. If a control in it had focus, the same
     * record, head or list button gets it back by key. Focus anywhere else
     * (the filter box, the footer) is not this rebuild's to move. */
    const focused = shadow.activeElement;
    const focusKey =
      focused && within(focused, container) ? String(focused.snhFocusKey || "") : "";
    container.textContent = "";
    focusables = new Map();

    const entries = displayGroups();

    /* Groups with hits first; then anything the user needs to know about
     * even though it produced none. A silent nothing is never shown as a
     * group — it lives in the status drawer. */
    const withHits = entries.filter((entry) => entry.hits.length > 0);
    const attention = entries.filter(
      (entry) =>
        entry.hits.length === 0 && NEEDS_ATTENTION.indexOf(entry.status) !== -1
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
    if (focusKey) restoreFocus(focusKey);
  };

  /* Its replacement if it was drawn again; if not (its group went), the Close
   * button, so focus stays in the panel rather than falling to the page. */
  const restoreFocus = (key) => {
    const target = focusables.get(key) || (shadow && shadow.querySelector(".close"));
    if (target && typeof target.focus === "function") target.focus();
  };

  const finalCountText = () =>
    plural(totalHits(), "match", "matches") +
    " in " +
    plural(totalRecords(), "record", "records") +
    ", " +
    plural(sources.size, "source", "sources") +
    " reported." +
    (truncated ? " Capped — refine the term to see the rest." : "");

  /* The status line speaks twice in a search: once when it starts, and once
   * when it ends, however it ends. A source reporting is not announced. */
  const announceFinal = (lead) => {
    if (announcedFinal) return;
    announcedFinal = true;
    announce((lead ? lead + " " : "") + finalCountText());
  };

  const updateSummary = () => {
    if (!shadow) return;
    const total = shadow.querySelector("[data-count='total']");
    if (total) total.textContent = String(totalHits());
    const records = shadow.querySelector("[data-count='records']");
    if (records) records.textContent = String(totalRecords());
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
      /* A status alone can be worse than silence: "skipped" without a reason
       * reads as "we gave up". The note says who covered it instead, and the
       * error says why a source could not answer. */
      if (summary.note) parts.push(summary.note);
      if (summary.error) parts.push(String(summary.error));
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
    previousFocus = document.activeElement;
    host = document.createElement("div");
    host.id = "sn-dev-helper-code-search";
    /* Closed, like every other GlideLens panel: an open root lets page
     * script read and rewrite results that came from the Table API. */
    shadow = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);

    shadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="overlay">
        <section class="panel" role="dialog" aria-modal="true" aria-label="Code search results">
          <header class="header">
            <div class="heading">
              <h2>Code Search <span class="term"></span></h2>
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
            <span><strong data-count="total">0</strong>matches in
              <strong data-count="records">0</strong>records</span>
            <span><strong data-count="sources">0</strong>sources reported</span>
            <span class="spinner" aria-hidden="true"></span>
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
            <button class="drawer-head" type="button" aria-expanded="false" aria-controls="snh-cs-sources">
              <span class="caret" aria-hidden="true">▶</span><span>Source status — what was searched</span>
            </button>
            <div class="drawer-list" id="snh-cs-sources"></div>
          </div>
          <footer class="toolbar">
            <span class="toolbar-note">Read-only — nothing here runs or edits what it finds.</span>
            <button type="button" data-action="cancel">Cancel</button>
            <button class="primary" type="button" data-action="close">Close</button>
          </footer>
          <div class="sr-only" role="status" aria-live="polite" data-live></div>
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
      announceFinal("");
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
      drawerHead.setAttribute("aria-expanded", open ? "true" : "false");
    });

    const overlay = shadow.querySelector(".overlay");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });

    /* Escape closes; Tab and Shift+Tab stay inside the panel, as in every
     * other GlideLens panel. */
    keydownHandler = (event) => {
      if (!host || !shadow) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (!focusable.length) return;
      const index = focusable.indexOf(shadow.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? focusable.length - 1 : index - 1)
        : (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusable[next].focus();
    };
    window.addEventListener("keydown", keydownHandler, true);

    renderRows();
    const closeButton = shadow.querySelector(".close");
    if (closeButton) closeButton.focus();
    /* Said once as the search starts; the next thing said is the final count. */
    announce("Searching…");
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
    announceFinal("");
  };

  const showError = (message) => {
    if (!shadow) return;
    finished = true;
    const container = shadow.querySelector(".rows");
    const focused = shadow.activeElement;
    const hadFocus = Boolean(focused && within(focused, container));
    container.textContent = "";
    focusables = new Map();
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = String(message || "The search could not run.");
    container.appendChild(empty);
    updateSummary();
    /* Nothing in the list survives an error; focus that was there stays in
     * the panel. */
    if (hadFocus) restoreFocus("");
    announceFinal(empty.textContent);
  };

  const isOpen = () => Boolean(host);

  globalThis.SNCodeSearchUI = {
    open,
    addSource,
    complete,
    showError,
    close,
    isOpen,
    /* Counting and clustering are logic, not presentation, and they are what
     * keeps "6 matches in 2 records" true. Exposed so tests can hold them to
     * that without a DOM. */
    countRecords,
    clusterByRecord,
    groupHitsByRecord,
    groupCountText,
  };
})();

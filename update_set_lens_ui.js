/*
 * Isolated-world Update Set Lens panel. Closed shadow root, the shared
 * GlideLens palette, a focus trap, Escape to close and focus restored to
 * whatever opened it.
 *
 * Like Impersonate, this panel has NO markup path: every set name, update
 * name, user name and date is read from an instance and is set with
 * textContent. Links are buttons that hand a same-origin URL, built by the
 * engine from allowlisted fields, to content.js's OPEN_URL; an update's name
 * to content.js, which looks its record up on click; or, for the instance
 * checked, an origin and ids, from which only the worker builds a URL.
 *
 * The panel draws snapshots. It never reads anything itself: content.js runs
 * the engine's session and passes each new snapshot to update(). What the
 * panel owns is how the rows are looked at: the filter, how many are drawn,
 * which are open, and the Check on choice.
 *
 * Settled by the owner on the mockup (U1-U7): opens on Needs attention when
 * there is any, rows drawn 100 at a time, coloured badges with their word,
 * Check on right under the summary, details shown for Stale and Can't tell,
 * and the other instance's answer on a row only where it differs. That
 * answer is amber, with its own badge and a Differs on chip, except Same
 * content there, which is grey because the content matches.
 */
(() => {
  if (globalThis.SNUpdateSetLensUI) return;

  const HOST_ID = "sn-dev-helper-update-set-lens";
  const TITLE_ID = "snh-usl-title";
  const PAGE_SIZE = 100;
  const COPY_RESET_MS = 2000;
  const LINK_NOTE_MS = 6000;
  const CHECK_HINT = "To check another instance, open it in a tab and sign in, then reopen Update Set Lens.";
  const VERDICT_ORDER = { stale: 0, cant: 1, batch: 2, same: 3, current: 4 };
  const BADGE_WORDS = {
    stale: "STALE",
    cant: "CAN'T TELL",
    batch: "IN THIS BATCH",
    same: "SAME CONTENT",
    current: "CURRENT",
  };
  /* The checked instance's answer as a row's second badge. Same content
   * there is grey: the content matches. */
  const THERE_WORDS = {
    other: "OTHER VERSION THERE",
    none: "NO CURRENT VERSION THERE",
    cant: "CAN'T TELL THERE",
    same: "SAME CONTENT THERE",
  };
  const SUMMARY_WORDS = {
    stale: "stale",
    cant: "can't tell",
    batch: "in this batch",
    same: "same content",
    current: "current",
  };

  let host = null;
  let shadow = null;
  let els = null;
  let keydownHandler = null;
  let callbacks = {};
  let opener = null;
  let panel = null;
  let copyTimer = null;
  let noteTimer = null;

  const UI_CSS = `
    [hidden]{display:none!important}
    *{box-sizing:border-box}
    :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      --teal:#31d4c4;--pink:#ff6fae;--panel:#1e1e2e;--raised:#202038;
      --border:#3a3a5c;--text:#dedeee;--muted:#9292aa;--amber:#e2b864;--amber-line:#6d5b34}
    button,input,select{font:inherit}
    .overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.52);
      display:flex;align-items:center;justify-content:center;padding:24px}
    .panel{width:min(1800px,calc(100vw - 48px));height:calc(100vh - 48px);
      display:flex;flex-direction:column;overflow:hidden;background:var(--panel);
      border:1px solid var(--border);border-radius:12px;box-shadow:0 28px 80px rgba(0,0,0,.65);
      color:var(--text)}
    .header{display:flex;align-items:flex-start;gap:14px;padding:16px 20px 12px;
      border-bottom:1px solid #2e2e4e}.heading{flex:1;min-width:0}
    h2{font-size:17px;line-height:1.2;margin:0 0 4px;color:#f5f5ff;font-weight:650}
    .subtitle{font-size:12px;color:var(--muted);line-height:1.45;margin:0;overflow-wrap:anywhere;max-width:90ch}
    .subtitle strong{color:#e8e8f6;font-weight:600}
    .close{border:0;background:transparent;color:var(--muted);padding:3px 6px;font-size:13px;
      cursor:pointer;border-radius:5px}.close:hover{color:#fff;background:#2d2d48}
    .banners{display:flex;flex-direction:column;gap:6px;padding:0 20px}
    .banners:not(:empty){padding-top:10px}
    /* A banner keeps its full width; its right padding holds the text to
       about 90 characters on a wide screen. */
    .banner{padding:8px max(11px,calc(100% - 90ch)) 8px 11px;border-radius:7px;font-size:12px;line-height:1.45;
      border:1px solid #4d5079;background:#24253c;color:#d6d6ea;overflow-wrap:anywhere}
    .banner.warn{border-color:var(--amber-line);background:#2c2619;color:#f0d9a6}
    .batch-line{display:flex;align-items:center;gap:8px;margin:10px 20px 0;font-size:12px;color:#d6d6ea}
    .batch-line input{accent-color:var(--teal);width:auto}
    .summary{padding:12px 20px 10px;border-bottom:1px solid #292944;background:var(--raised);
      display:flex;flex-direction:column;gap:6px;margin-top:10px}
    .sum-main{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13.5px;color:#f0f0fa}
    .sum-label{margin-right:4px}
    .sum-newer{font-size:11.5px;color:#aaaac1;line-height:1.5;overflow-wrap:anywhere;max-width:90ch}
    .sum-newer b{color:#e4e4f1;font-weight:600}
    .progress{display:flex;align-items:center;gap:8px;font-size:11px;color:#aaaac1;min-height:16px}
    .spinner{width:12px;height:12px;border-radius:50%;border:2px solid #45456b;flex:none;
      border-top-color:var(--teal);animation:spin .7s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){.spinner{animation:none}}
    .check{padding:10px 20px;border-bottom:1px solid #292944;display:flex;flex-direction:column;gap:7px}
    .check-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;color:#bdbdd0}
    .check-row select{background:#151522;color:#f0f0fa;border:1px solid #555578;border-radius:7px;
      padding:6px 8px;color-scheme:dark;max-width:100%}
    .check-row select:focus{border-color:var(--teal);outline:none;box-shadow:0 0 0 3px rgba(49,212,196,.14)}
    .check-hint{font-size:11.5px;color:#9a9ab3;line-height:1.45;max-width:90ch}
    .check-out{display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:1.5;color:#d6d6ea;
      max-width:90ch}
    .check-out .state{font-weight:650;color:#f5f5ff}
    .check-out .warn{color:#f0d9a6}
    .check-out .note{color:#9a9ab3}
    .ok{color:#8fe0d6;font-weight:600}
    .check-out .differs{color:var(--amber);font-weight:600}
    .mark{margin-right:5px}
    .progress .ok{font-size:12px}
    .btn{border:1px solid #5b5b86;background:#3f4067;color:#e6e6f5;border-radius:7px;padding:6px 12px;
      cursor:pointer;font-size:12px}
    .btn:hover:not(:disabled){background:#4a4b78;color:#fff}
    .btn.pink{background:var(--pink);border-color:var(--pink);color:#2a0d1a;font-weight:650}
    .btn.pink:hover:not(:disabled){background:#ff85bb}
    button:disabled{opacity:.48;cursor:default}
    .chips{display:flex;flex-wrap:wrap;gap:6px;padding:10px 20px 8px}
    .chip{border:1px solid #4a4a6e;background:transparent;color:#cfcfe6;border-radius:999px;
      padding:4px 10px;font-size:11.5px;cursor:pointer;font-variant-numeric:tabular-nums}
    .chip:hover{background:#2d2d48}
    .chip.there{border-color:var(--amber-line);color:var(--amber)}
    .chip[aria-pressed="true"]{background:#173d3a;border-color:var(--teal);color:#d9fbf7}
    .rows{flex:1;overflow:auto;min-height:0}
    .row{padding:9px 20px;border-bottom:1px solid #282841;outline:none}
    .row.click{cursor:pointer}
    .row.click:hover{background:#262640}
    .row:focus-visible{outline:2px solid var(--teal);outline-offset:-2px}
    .row-top{display:grid;grid-template-columns:minmax(0,150px) minmax(0,1fr) auto auto;gap:10px;align-items:baseline}
    .r-type{color:#9a9ab3;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-name{color:#f0f0fa;font-size:13px;font-weight:600;min-width:0;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap}
    .r-sub{color:#8f8fa9;font-weight:400;font-size:11px;margin-left:6px}
    .r-action{color:#9a9ab3;font-size:11px}
    .badge{font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:1px 7px;border-radius:5px;
      border:1px solid transparent;white-space:nowrap}
    .b-stale{background:#4a2338;border-color:var(--pink);color:#ffd6e8}
    .b-cant{background:#2c2619;border-color:var(--amber-line);color:var(--amber)}
    .b-same,.b-batch{background:#26263b;border-color:#4a4a6e;color:#c3c3d8}
    .b-current{background:transparent;border-color:#33334f;color:#8d8da6}
    .badges{display:inline-flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
    .b-there{background:#2c2619;border-color:var(--amber-line);color:var(--amber)}
    .b-there.same{background:transparent;border-color:#4a4a6e;color:#b9b3e8}
    .sum-badge{font-size:12px;font-weight:650;letter-spacing:0;padding:3px 9px;cursor:pointer;
      font-variant-numeric:tabular-nums}
    .sum-badge:hover{filter:brightness(1.18)}
    .sum-badge.zero{opacity:.45}
    .r-detail{margin:6px 0 2px;padding-left:160px;font-size:12px;line-height:1.5;color:#c8c8dc;overflow-wrap:anywhere;
      max-width:calc(160px + 90ch)}
    .flags{display:inline-flex;flex-wrap:wrap;gap:4px;margin-left:4px}
    .flag{font-size:10.5px;padding:0 6px;border-radius:4px;border:1px solid #4a4a6e;color:#c9c9de}
    .flag.progress{border-color:#2f6f68;color:#8fe0d6}
    .flag.default{border-color:var(--amber-line);color:var(--amber)}
    .who,.notes{color:#9a9ab3}
    .links{display:flex;flex-wrap:wrap;gap:12px;margin-top:3px}
    .link{border:0;background:transparent;color:#8fd6cf;padding:0;cursor:pointer;font-size:11.5px;
      text-decoration:underline;text-underline-offset:2px}
    .remote-tag{display:block;margin-top:2px;color:#b9b3e8;font-size:11.5px}
    .remote-tag.warn{color:var(--amber)}
    .links-on{color:var(--muted);font-size:11.5px}
    .link-note{margin-top:3px;color:var(--amber);font-size:11.5px}
    .more{display:flex;justify-content:center;padding:12px}
    .empty{padding:40px 24px;text-align:center;color:var(--muted);font-size:13px;line-height:1.6;
      max-width:90ch;margin:0 auto}
    .empty .links{justify-content:center;margin-top:12px}
    .footer{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 20px;
      border-top:1px solid #2e2e4e;font-size:11.5px;color:#9a9ab3;background:#20203a}
    .footer .grow{flex:1;min-width:160px;max-width:90ch;margin-right:auto}
    button:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
    @media(max-width:680px){.overlay{padding:8px}.panel{width:100%;height:calc(100vh - 16px)}
      .row-top{grid-template-columns:minmax(0,1fr) auto}.r-type,.r-action{display:none}
      .r-detail{padding-left:0}}
  `;

  /* ------------------------------------------------------------------ *
   * Element helpers. No markup path exists, so there is nothing for a
   * value to escape from.
   * ------------------------------------------------------------------ */

  const str = (value) => (value == null ? "" : String(value));
  const isFn = (value) => typeof value === "function";

  function el(tag, className, textContent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent != null) node.textContent = String(textContent);
    return node;
  }

  function button(className, label, onClick) {
    const node = el("button", className, label);
    node.type = "button";
    node.setAttribute("type", "button");
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }

  /* A result line: a mark that screen readers skip, then the words. */
  function markedLine(tag, className, mark, text) {
    const node = el(tag, className);
    const sign = el("span", "mark", mark);
    sign.setAttribute("aria-hidden", "true");
    node.appendChild(sign);
    node.appendChild(document.createTextNode(text));
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

  function clear(node) {
    if (node) node.textContent = "";
  }

  function plural(count, one, many) {
    return Number(count).toLocaleString() + " " + (count === 1 ? one : many);
  }

  /* A focusable control remembered by a key, so a repaint can put focus back
   * on its replacement instead of dropping it to the page. */
  function remember(node, key) {
    node.snhFocusKey = key;
    panel.focusables.set(key, node);
    return node;
  }

  function sameOrigin(url) {
    try {
      const origin = typeof location === "object" && location ? location.origin : "";
      const parsed = new URL(str(url));
      return Boolean(origin) && parsed.origin === origin && parsed.protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  /* A check answers for the rows it was sent. Another instance, the batch
   * switched, or the next 2,000 rows each start over, and the token drops a
   * late answer to the old one. */
  function forgetRemote() {
    if (!panel) return;
    panel.remoteToken += 1;
    panel.remote = { state: "idle" };
    if (panel.filter === "there") panel.filter = null;
  }

  /* A row's link that could not open says why beside its links, for a few
   * seconds, and never in place of the link. */
  function showLinkNote(key, text) {
    if (!panel) return;
    const owner = panel;
    owner.linkNote = { key, text: str(text) };
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      if (panel !== owner || !owner.linkNote || owner.linkNote.key !== key) return;
      owner.linkNote = null;
      paint();
    }, LINK_NOTE_MS);
    paint();
  }

  /* `noteKey` is the row a refusal is said on; a link without one opens
   * a URL and has nothing to report. */
  function linkButton(link, noteKey) {
    return button("link", link.label, (event) => {
      if (event && isFn(event.stopPropagation)) event.stopPropagation();
      if (link.url) {
        if (sameOrigin(link.url) && isFn(callbacks.onOpenUrl)) callbacks.onOpenUrl(link.url);
        return;
      }
      let outcome = null;
      if (link.record && isFn(callbacks.onOpenRecord)) outcome = callbacks.onOpenRecord(str(link.record));
      else if (link.versionLens && isFn(callbacks.onOpenVersionLens)) outcome = callbacks.onOpenVersionLens(str(link.versionLens));
      else if (link.remote && isFn(callbacks.onOpenRemote)) outcome = callbacks.onOpenRemote(Object.assign({}, link.remote));
      if (!outcome || noteKey == null) return;
      Promise.resolve(outcome).then((result) => {
        if (result && result.ok === false) showLinkNote(noteKey, result.message || "Couldn't open that.");
      }, () => showLinkNote(noteKey, "Couldn't open that."));
    });
  }

  /* ------------------------------------------------------------------ *
   * Counting, filtering, ordering
   * ------------------------------------------------------------------ */

  function counts(rows) {
    const out = { stale: 0, cant: 0, batch: 0, same: 0, current: 0 };
    rows.forEach((row) => { if (out[row.verdict] != null) out[row.verdict] += 1; });
    return out;
  }

  function needsAttention(row) {
    return row.verdict === "stale" || row.verdict === "cant";
  }

  /* Every update checked, none Stale or Can't tell, and no warning that the
   * list may be partial or the set isn't one to move: said as a success. */
  function allClear(view, rows) {
    const totals = view.totals || {};
    return view.phase === "done" && Boolean(totals.exact) && rows.length > 0 && !rows.some(needsAttention) &&
      !(view.banners || []).some((banner) => banner.kind === "warn");
  }

  /* The checked instance's answer for a row: there is one only where it
   * differs, once a check has finished. */
  function remoteAnswer(row) {
    const remote = panel.remote;
    if (remote.state !== "done" || !remote.perRow) return null;
    return remote.perRow[row.key] || null;
  }

  const differsThere = (row) => Boolean(remoteAnswer(row));

  /* U2: Needs attention while there is any and nothing has been picked. A
   * pick of Differs there lapses with the check that answered it. */
  function activeFilter(rows) {
    if (panel.filter && (panel.filter !== "there" || rows.some(differsThere))) return panel.filter;
    return rows.some(needsAttention) ? "attention" : "all";
  }

  function matchesFilter(row, filter) {
    if (filter === "all") return true;
    if (filter === "attention") return needsAttention(row);
    if (filter === "there") return differsThere(row);
    return row.verdict === filter;
  }

  function compareText(left, right) {
    const a = str(left).toLowerCase();
    const b = str(right).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /* Stale first, then Can't tell; within a verdict by type, then target. */
  function ordered(rows) {
    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) =>
        (VERDICT_ORDER[left.row.verdict] - VERDICT_ORDER[right.row.verdict]) ||
        compareText(left.row.type, right.row.type) ||
        compareText(left.row.target || left.row.name, right.row.target || right.row.name) ||
        left.index - right.index)
      .map((entry) => entry.row);
  }

  /* ------------------------------------------------------------------ *
   * The counts-only copy summary (Sol, idea 8). No set, record or person
   * name, no id, origin or URL: those stay on screen.
   * ------------------------------------------------------------------ */

  function copySummary(view, remoteCounts) {
    const rows = (view && view.rows) || [];
    const c = counts(rows);
    const totals = (view && view.totals) || {};
    const batch = view && view.batch && view.batch.included;
    const lines = [
      "Update Set Lens: " + (batch ? "a batch of " + ((view.batch.setCount || 0) + 1) + " update sets" : "one update set") + ".",
      "Checked " + (totals.checked || 0) +
        (totals.total != null ? (totals.exact ? " of " : " of up to ") + totals.total : "") + " updates.",
      "Stale " + c.stale + ", can't tell " + c.cant + (batch ? ", in this batch " + c.batch : "") +
        ", same content " + c.same + ", current " + c.current + ".",
    ];
    if (remoteCounts) {
      lines.push(
        "On the other instance: runs this set's version " + remoteCounts.runs +
        ", same content " + remoteCounts.same + ", another version " + remoteCounts.other +
        ", no readable current version " + remoteCounts.none + ", can't tell " + remoteCounts.cant + "."
      );
    }
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ *
   * Painting
   * ------------------------------------------------------------------ */

  function subtitleParts(view) {
    const subject = view.subject;
    const parts = [];
    if (subject.stateLabel) parts.push(subject.stateLabel);
    if (subject.scope) parts.push(subject.scope);
    if (subject.createdBy) parts.push("created by " + subject.createdBy + (subject.createdOn ? " on " + subject.createdOn : ""));
    if (subject.parentName) parts.push("child of “" + subject.parentName + "”");
    const totals = view.totals || {};
    if (totals.total != null) {
      parts.push((totals.exact ? "" : "up to ") + plural(totals.total, "update", "updates"));
    }
    return parts;
  }

  function paintHeader(view) {
    const subtitle = els.subtitle;
    clear(subtitle);
    if (view.retrieved) {
      const retrieved = view.retrieved;
      subtitle.appendChild(el("strong", null, retrieved.name || "Retrieved set"));
      const bits = ["retrieved set", retrieved.stateLabel];
      if (retrieved.loadedOn) bits.push("loaded " + retrieved.loadedOn + (retrieved.source ? " from " + retrieved.source : ""));
      subtitle.appendChild(document.createTextNode(" · " + bits.filter(Boolean).join(" · ")));
      return;
    }
    if (!view.subject) {
      subtitle.textContent = view.error ? "" : "Reading the update set…";
      return;
    }
    subtitle.appendChild(el("strong", null, view.subject.name || "Unnamed update set"));
    const parts = subtitleParts(view);
    if (parts.length) subtitle.appendChild(document.createTextNode(" · " + parts.join(" · ")));
  }

  function paintBanners(view) {
    clear(els.banners);
    (view.banners || []).forEach((banner) => {
      const node = el("div", "banner" + (banner.kind === "warn" ? " warn" : ""));
      node.appendChild(document.createTextNode(banner.text));
      if (banner.links && banner.links.length) {
        const links = el("span", "links");
        links.style.display = "inline-flex";
        links.style.margin = "0 0 0 8px";
        banner.links.forEach((link, index) => links.appendChild(remember(linkButton(link), "banner-link:" + banner.text + ":" + index)));
        node.appendChild(links);
      }
      els.banners.appendChild(node);
    });
  }

  function paintBatch(view) {
    const batch = view.batch;
    clear(els.batch);
    setHidden(els.batch, !batch);
    if (!batch) return;
    const label = el("label", "batch-line");
    const box = el("input");
    box.type = "checkbox";
    box.setAttribute("type", "checkbox");
    box.checked = Boolean(batch.included);
    setDisabled(box, Boolean(view.busy));
    box.addEventListener("change", () => {
      panel.filter = null;
      panel.shown = PAGE_SIZE;
      panel.expanded.clear();
      forgetRemote();
      /* No paint here: the session's next snapshot draws the new choice. */
      if (isFn(callbacks.onToggleBatch)) callbacks.onToggleBatch(Boolean(box.checked));
    });
    remember(box, "batch-toggle");
    label.appendChild(box);
    let text = " Include its " + plural(batch.children, "direct child set", "direct child sets");
    if (batch.included && batch.setCount != null) {
      text += " · + " + plural(batch.setCount, "set", "sets") + " in this batch";
    }
    label.appendChild(document.createTextNode(text));
    els.batch.appendChild(label);
  }

  function newerWork(rows) {
    const bySet = new Map();
    rows.forEach((row) => {
      if (row.verdict !== "stale" || !row.newerSetName) return;
      const key = row.newerSetId || row.newerSetName;
      const entry = bySet.get(key) || { name: row.newerSetName, state: row.newerSetState, count: 0 };
      entry.count += 1;
      bySet.set(key, entry);
    });
    return Array.from(bySet.values()).sort((a, b) => b.count - a.count || compareText(a.name, b.name));
  }

  function paintSummary(view, rows) {
    const c = counts(rows);
    clear(els.sumMain);
    els.sumMain.appendChild(el("span", "sum-label", "Before promoting:"));
    const keys = ["stale", "cant", "same"].concat(view.batch && view.batch.included ? ["batch"] : []).concat(["current"]);
    keys.forEach((key) => {
      const badge = button(
        "badge sum-badge b-" + key + (c[key] ? "" : " zero"),
        c[key].toLocaleString() + " " + SUMMARY_WORDS[key],
        () => setFilter(key)
      );
      badge.setAttribute("aria-label", "Show only the " + SUMMARY_WORDS[key] + " rows: " + c[key]);
      els.sumMain.appendChild(remember(badge, "sum:" + key));
    });

    clear(els.sumNewer);
    const newer = newerWork(rows);
    setHidden(els.sumNewer, !newer.length);
    if (newer.length) {
      els.sumNewer.appendChild(document.createTextNode("Newer work in: "));
      newer.slice(0, 5).forEach((entry, index) => {
        if (index) els.sumNewer.appendChild(document.createTextNode(" · "));
        els.sumNewer.appendChild(el("b", null, entry.name));
        els.sumNewer.appendChild(document.createTextNode(" (" + (entry.state ? entry.state.toLowerCase() + ", " : "") + entry.count + ")"));
      });
      if (newer.length > 5) els.sumNewer.appendChild(document.createTextNode(" · and " + (newer.length - 5) + " more"));
    }

    clear(els.progress);
    if (view.busy) {
      const spinner = el("span", "spinner");
      spinner.setAttribute("aria-hidden", "true");
      els.progress.appendChild(spinner);
      els.progress.appendChild(el("span", null, view.progress || "Checking versions…"));
    } else if (view.error) {
      els.progress.appendChild(el("span", null, "Couldn't finish: " + view.error));
    } else {
      const totals = view.totals || {};
      let text = "Checked " + Number(totals.checked || 0).toLocaleString();
      if (totals.total != null) {
        text += (totals.exact ? " of " : " of up to ") + Number(totals.total).toLocaleString();
      }
      els.progress.appendChild(allClear(view, rows)
        ? markedLine("span", "ok", "✓", text + ". Nothing needs attention before promoting.")
        : el("span", null, text + "."));
    }
  }

  function paintCheck(view) {
    const origins = panel.origins || [];
    const select = els.select;
    const chosen = select.value;
    clear(select);
    origins.forEach((entry) => {
      const option = el("option", null, entry.label || entry.origin);
      option.value = entry.origin;
      option.setAttribute("value", entry.origin);
      try { option.title = new URL(entry.origin).hostname; } catch (error) { /* label only */ }
      select.appendChild(option);
    });
    if (chosen && origins.some((entry) => entry.origin === chosen)) select.value = chosen;
    else if (origins.length) select.value = origins[0].origin;
    const none = !origins.length;
    setHidden(els.checkRow, none);
    setHidden(els.checkHint, !none);
    /* The rows checked here are what is compared there, so the check waits
     * for them. */
    setDisabled(els.checkButton, view.busy || panel.remote.state === "busy" || view.phase !== "done");

    clear(els.checkOut);
    const remote = panel.remote;
    if (remote.state === "busy") {
      const line = el("div", "progress");
      const spinner = el("span", "spinner");
      spinner.setAttribute("aria-hidden", "true");
      line.appendChild(spinner);
      line.appendChild(el("span", null, remote.message || "Reading on " + remote.instance + "…"));
      els.checkOut.appendChild(line);
    } else if (remote.state === "error") {
      els.checkOut.appendChild(el("div", "warn", remote.message));
    } else if (remote.state === "done") {
      (remote.lines || []).forEach((line) => {
        if (line.kind === "ok" || line.kind === "differs") {
          els.checkOut.appendChild(line.kind === "ok"
            ? markedLine("div", "ok", "✓", line.text)
            : markedLine("div", "differs", "≠", line.text));
          return;
        }
        els.checkOut.appendChild(el("div", line.kind === "state" ? "state" : line.kind === "warn" ? "warn" : line.kind === "note" ? "note" : "", line.text));
      });
    }
  }

  const CHIPS = [
    { id: "attention", label: "Needs attention" },
    { id: "stale", label: "Stale" },
    { id: "cant", label: "Can't tell" },
    { id: "batch", label: "In this batch", batchOnly: true },
    { id: "same", label: "Same content" },
    { id: "current", label: "Current" },
    { id: "all", label: "All" },
  ];

  function paintChips(view, rows, filter) {
    clear(els.chips);
    const c = counts(rows);
    const tally = {
      attention: c.stale + c.cant, stale: c.stale, cant: c.cant, batch: c.batch,
      same: c.same, current: c.current, all: rows.length, there: rows.filter(differsThere).length,
    };
    const chips = CHIPS.filter((chip) => !chip.batchOnly || (view.batch && view.batch.included));
    /* After a check, the rows it differs on, just before All. */
    if (tally.there) {
      chips.splice(chips.length - 1, 0, {
        id: "there", label: "Differs on " + (panel.remote.instance || "the other instance"), className: "there",
      });
    }
    chips.forEach((chip) => {
      const node = button("chip" + (chip.className ? " " + chip.className : ""),
        chip.label + " " + tally[chip.id].toLocaleString(), () => setFilter(chip.id));
      node.setAttribute("aria-pressed", filter === chip.id ? "true" : "false");
      els.chips.appendChild(remember(node, "chip:" + chip.id));
    });
  }

  function remoteTag(row) {
    const answer = remoteAnswer(row);
    return answer ? el("span", "remote-tag" + (answer.kind === "same" ? "" : " warn"), answer.text) : null;
  }

  function thereBadge(answer) {
    const kind = THERE_WORDS[answer.kind] ? answer.kind : "cant";
    const badge = el("span", "badge b-there" + (kind === "same" ? " same" : ""), THERE_WORDS[kind]);
    badge.title = str(answer.text);
    return badge;
  }

  /* The checked instance's links for a row, after its check finished. */
  function remoteLinksFor(row) {
    const remote = panel.remote;
    if (remote.state !== "done" || !remote.links) return [];
    const links = remote.links[row.key];
    return Array.isArray(links) ? links : [];
  }

  function rowSub(row) {
    const bits = [];
    if (row.childSet) bits.push("in " + row.childSet);
    if (row.asRetrieved) bits.push("as retrieved");
    return bits.join(" · ");
  }

  function buildRow(row) {
    const attention = needsAttention(row);
    const open = attention || panel.expanded.has(row.key);
    const node = el("div", "row" + (attention ? "" : " click"));
    const top = el("div", "row-top");
    top.appendChild(el("span", "r-type", row.type || ""));
    const name = el("span", "r-name", row.target || row.name);
    name.title = row.name;
    const sub = rowSub(row);
    if (sub) name.appendChild(el("span", "r-sub", sub));
    top.appendChild(name);
    top.appendChild(el("span", "r-action", row.action || ""));
    const badges = el("span", "badges");
    badges.appendChild(el("span", "badge b-" + row.verdict, BADGE_WORDS[row.verdict] || row.verdict));
    const answer = remoteAnswer(row);
    if (answer) badges.appendChild(thereBadge(answer));
    top.appendChild(badges);
    node.appendChild(top);

    const tag = remoteTag(row);
    if (open) {
      const detail = el("div", "r-detail");
      detail.appendChild(document.createTextNode(row.text));
      if (row.flags && row.flags.length) {
        const flags = el("span", "flags");
        row.flags.forEach((flag) => flags.appendChild(el("span", "flag" + (flag.kind ? " " + flag.kind : ""), flag.label)));
        detail.appendChild(flags);
      }
      if (row.notes && row.notes.length) detail.appendChild(el("div", "notes", row.notes.join(" · ")));
      if (row.who) detail.appendChild(el("div", "who", row.who));
      /* Version Lens on this update's record: every set that captured it. */
      const rowLinks = (row.links || []).concat(row.name && isFn(callbacks.onOpenVersionLens)
        ? [{ label: "Other sets holding it", versionLens: row.name }] : []);
      if (rowLinks.length) {
        const links = el("div", "links");
        rowLinks.forEach((link, index) => links.appendChild(remember(linkButton(link, row.key), "link:" + row.key + ":" + index)));
        detail.appendChild(links);
      }
      if (tag) detail.appendChild(tag);
      const elsewhere = remoteLinksFor(row);
      if (elsewhere.length) {
        const links = el("div", "links");
        links.appendChild(el("span", "links-on", (panel.remote.instance || "There") + ":"));
        elsewhere.forEach((link, index) =>
          links.appendChild(remember(linkButton(link, row.key), "remote-link:" + row.key + ":" + index)));
        detail.appendChild(links);
      }
      if (panel.linkNote && panel.linkNote.key === row.key) {
        const note = el("div", "link-note", panel.linkNote.text);
        note.setAttribute("role", "status");
        detail.appendChild(note);
      }
      node.appendChild(detail);
    } else if (tag) {
      const detail = el("div", "r-detail");
      detail.appendChild(tag);
      node.appendChild(detail);
    }

    if (!attention) {
      node.setAttribute("tabindex", "0");
      node.setAttribute("role", "button");
      node.setAttribute("aria-expanded", open ? "true" : "false");
      const toggle = () => {
        if (panel.expanded.has(row.key)) panel.expanded.delete(row.key);
        else panel.expanded.add(row.key);
        paint();
      };
      node.addEventListener("click", toggle);
      node.addEventListener("keydown", (event) => {
        /* A key pressed on a link inside the row is the link's: taking it
         * here would cancel the link's click and fold the row away. */
        if (event.target && event.target !== node) return;
        if (event.key === "Enter" || event.key === " ") {
          if (isFn(event.preventDefault)) event.preventDefault();
          toggle();
        }
      });
      remember(node, "row:" + row.key);
    }
    return node;
  }

  function paintRows(view, rows, filter) {
    clear(els.rows);
    if (view.retrieved) {
      const empty = el("div", "empty");
      empty.appendChild(el("div", null, view.retrieved.message));
      if (view.retrieved.note) empty.appendChild(el("div", null, view.retrieved.note));
      if (view.retrieved.links && view.retrieved.links.length) {
        const links = el("div", "links");
        view.retrieved.links.forEach((link, index) => links.appendChild(remember(linkButton(link), "retrieved-link:" + index)));
        empty.appendChild(links);
      }
      els.rows.appendChild(empty);
      return;
    }
    if (view.error && !rows.length) {
      els.rows.appendChild(el("div", "empty", "Update Set Lens couldn't finish: " + view.error));
      return;
    }
    if (!rows.length) {
      if (view.busy) {
        els.rows.appendChild(el("div", "empty", "Checking…"));
      } else if (view.batch && !view.batch.included) {
        els.rows.appendChild(el("div", "empty", "This set holds no updates itself. Include its child sets to check the batch."));
      } else {
        els.rows.appendChild(el("div", "empty", "This set holds no updates."));
      }
      return;
    }
    const visible = ordered(rows.filter((row) => matchesFilter(row, filter)));
    if (!visible.length) {
      els.rows.appendChild(el("div", "empty", "No rows match this filter."));
      return;
    }
    visible.slice(0, panel.shown).forEach((row) => els.rows.appendChild(buildRow(row)));
    const left = visible.length - panel.shown;
    if (left > 0) {
      const more = el("div", "more");
      more.appendChild(remember(button(
        "btn",
        "Show " + Math.min(PAGE_SIZE, left) + " more (" + left.toLocaleString() + " left)",
        () => {
          panel.shown += PAGE_SIZE;
          paint();
        }
      ), "show-more"));
      els.rows.appendChild(more);
    }
  }

  function paintFooter(view) {
    setHidden(els.continueButton, !view.canContinue);
    setDisabled(els.continueButton, Boolean(view.busy));
    setHidden(els.copyButton, Boolean(view.retrieved));
    setDisabled(els.copyButton, Boolean(view.busy) || !view.subject);
  }

  function paint() {
    if (!panel || !els) return;
    const view = panel.view || {};
    const focused = shadow && shadow.activeElement;
    const focusKey = focused && focused.snhFocusKey;
    panel.focusables = new Map([
      ["close", els.closeButton],
      ["select", els.select],
      ["check", els.checkButton],
      ["copy", els.copyButton],
      ["continue", els.continueButton],
      ["footer-close", els.footerClose],
    ]);
    const rows = view.rows || [];
    const filter = activeFilter(rows);
    const local = !view.retrieved && Boolean(view.subject);
    paintHeader(view);
    paintBanners(view);
    paintBatch(local ? view : {});
    setHidden(els.summary, !local);
    setHidden(els.check, !local);
    setHidden(els.chips, !local || !rows.length);
    if (local) {
      paintSummary(view, rows);
      paintCheck(view);
      paintChips(view, rows, filter);
    }
    paintRows(view, rows, filter);
    paintFooter(view);
    if (focusKey && panel.focusables.has(focusKey)) {
      const target = panel.focusables.get(focusKey);
      if (target !== focused && !target.hidden && !target.disabled && isFn(target.focus)) target.focus();
    } else if (focusKey && focused && !focused.isConnected && els.rows && isFn(els.closeButton.focus)) {
      /* The focused control is gone (a filter emptied, a row closed): keep
       * focus inside the panel rather than letting it fall to the page. */
      els.closeButton.focus();
    }
  }

  function setFilter(id) {
    panel.filter = id;
    panel.shown = PAGE_SIZE;
    paint();
  }

  /* ------------------------------------------------------------------ *
   * Mount / unmount
   * ------------------------------------------------------------------ */

  function focusableElements() {
    const out = [];
    const walk = (node) => {
      const children = node && node.children ? Array.from(node.children) : [];
      children.forEach((child) => {
        if (child.hidden) return;
        const tag = str(child.tagName).toLowerCase();
        const tabindex = isFn(child.getAttribute) ? child.getAttribute("tabindex") : null;
        const focusable = tag === "button" || tag === "input" || tag === "select";
        if (!child.disabled && (focusable || tabindex === "0")) out.push(child);
        walk(child);
      });
    };
    walk(shadow);
    return out;
  }

  function buildShell() {
    const style = document.createElement("style");
    style.textContent = UI_CSS;
    shadow.appendChild(style);

    const overlay = el("div", "overlay");
    overlay.addEventListener("click", (event) => {
      if (event && event.target === overlay) userClose();
    });
    const section = el("section", "panel");
    section.setAttribute("role", "dialog");
    section.setAttribute("aria-modal", "true");
    section.setAttribute("aria-labelledby", TITLE_ID);

    const header = el("header", "header");
    const heading = el("div", "heading");
    const title = el("h2", "", "Update Set Lens");
    title.id = TITLE_ID;
    heading.appendChild(title);
    const subtitle = el("p", "subtitle");
    heading.appendChild(subtitle);
    const closeButton = button("close", "✕ Esc", () => userClose());
    closeButton.setAttribute("aria-label", "Close");
    closeButton.snhFocusKey = "close";
    header.appendChild(heading);
    header.appendChild(closeButton);
    section.appendChild(header);

    const banners = el("div", "banners");
    section.appendChild(banners);
    const batch = el("div", null);
    section.appendChild(batch);

    const summary = el("div", "summary");
    const sumMain = el("div", "sum-main");
    const sumNewer = el("div", "sum-newer");
    const progress = el("div", "progress");
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-live", "polite");
    summary.appendChild(sumMain);
    summary.appendChild(sumNewer);
    summary.appendChild(progress);
    section.appendChild(summary);

    /* U5: right under the summary. */
    const check = el("div", "check");
    const checkRow = el("div", "check-row");
    const selectLabel = el("label", null, "Check on");
    selectLabel.htmlFor = "snh-usl-origin";
    const select = el("select");
    select.id = "snh-usl-origin";
    select.snhFocusKey = "select";
    select.addEventListener("change", () => {
      /* Another instance: whatever the last one said no longer applies. */
      forgetRemote();
      paint();
    });
    const checkButton = button("btn", "Check", () => startCheck());
    checkButton.snhFocusKey = "check";
    checkRow.appendChild(selectLabel);
    checkRow.appendChild(select);
    checkRow.appendChild(checkButton);
    const checkHint = el("div", "check-hint", CHECK_HINT);
    const checkOut = el("div", "check-out");
    checkOut.setAttribute("aria-live", "polite");
    check.appendChild(checkRow);
    check.appendChild(checkHint);
    check.appendChild(checkOut);
    section.appendChild(check);

    const chips = el("div", "chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Filter rows");
    section.appendChild(chips);

    const rows = el("div", "rows");
    section.appendChild(rows);

    const footer = el("footer", "footer");
    footer.appendChild(el("span", "grow", "Only captured changes are compared. Read-only: Update Set Lens never changes a set."));
    const copyButton = button("btn", "Copy summary", () => copyCounts());
    copyButton.snhFocusKey = "copy";
    const continueButton = button("btn pink", "Check the next 2,000", () => {
      forgetRemote();
      if (isFn(callbacks.onContinue)) callbacks.onContinue();
      paint();
    });
    continueButton.snhFocusKey = "continue";
    const footerClose = button("btn", "Close", () => userClose());
    footerClose.snhFocusKey = "footer-close";
    footer.appendChild(copyButton);
    footer.appendChild(continueButton);
    footer.appendChild(footerClose);
    section.appendChild(footer);

    overlay.appendChild(section);
    shadow.appendChild(overlay);

    els = {
      overlay, section, subtitle, banners, batch, summary, sumMain, sumNewer, progress,
      check, checkRow, select, checkButton, checkHint, checkOut, chips, rows, footer,
      copyButton, continueButton, footerClose, closeButton,
    };
  }

  function copyCounts() {
    if (!panel || !isFn(callbacks.onCopy)) return;
    const text = copySummary(panel.view, panel.remote.state === "done" ? panel.remote.counts : null);
    const target = els.copyButton;
    Promise.resolve(callbacks.onCopy(text))
      .then((ok) => ok !== false, () => false)
      .then((ok) => {
        if (!els || els.copyButton !== target) return;
        target.textContent = ok ? "✓ Copied" : "Copy failed";
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => {
          if (els && els.copyButton === target) target.textContent = "Copy summary";
        }, COPY_RESET_MS);
      });
  }

  function startCheck() {
    if (!panel || !isFn(callbacks.onCheckRemote)) return;
    const origin = els.select.value;
    const entry = (panel.origins || []).find((candidate) => candidate.origin === origin);
    if (!entry) return;
    panel.remoteToken += 1;
    panel.remote = { state: "busy", instance: entry.label || origin, message: "" };
    if (panel.filter === "there") panel.filter = null;
    paint();
    callbacks.onCheckRemote(origin, panel.remoteToken);
  }

  function userClose() {
    const onClose = callbacks.onClose;
    close();
    if (isFn(onClose)) {
      try { onClose(); } catch (error) { /* closing must not throw */ }
    }
  }

  function close() {
    if (keydownHandler && typeof window === "object" && window && isFn(window.removeEventListener)) {
      window.removeEventListener("keydown", keydownHandler, true);
    }
    keydownHandler = null;
    clearTimeout(copyTimer);
    copyTimer = null;
    clearTimeout(noteTimer);
    noteTimer = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    else if (host && isFn(host.remove)) host.remove();
    const restore = opener;
    host = null;
    shadow = null;
    els = null;
    panel = null;
    callbacks = {};
    opener = null;
    if (restore && isFn(restore.focus)) {
      try { restore.focus({ preventScroll: true }); } catch (error) {
        try { restore.focus(); } catch (ignored) { /* the opener is gone */ }
      }
    }
  }

  /*
   * open({ view, origins, callbacks, opener })
   *   callbacks: onToggleBatch(on), onContinue(), onCheckRemote(origin, token),
   *   onOpenUrl(url), onOpenRecord(updateName), onOpenVersionLens(updateName)
   *   and onOpenRemote({ origin, table, sysId } | { origin, name }), the last
   *   three -> Promise<{ ok, message }>, onCopy(text) -> Promise<boolean>,
   *   onClose()
   */
  function open(options) {
    close();
    const opts = options || {};
    callbacks = Object.assign({}, opts.callbacks || {});
    opener = opts.opener || (typeof document === "object" && document ? document.activeElement : null);
    panel = {
      view: opts.view || {},
      origins: Array.isArray(opts.origins) ? opts.origins.slice() : [],
      filter: null,
      shown: PAGE_SIZE,
      expanded: new Set(),
      focusables: new Map(),
      remote: { state: "idle" },
      remoteToken: 0,
      linkNote: null,
    };
    host = document.createElement("div");
    host.id = HOST_ID;
    /* Closed, like every other GlideLens panel. */
    shadow = host.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(host);
    buildShell();
    paint();

    keydownHandler = (event) => {
      if (!host || !shadow || !event) return;
      if (event.key === "Escape") {
        if (isFn(event.preventDefault)) event.preventDefault();
        if (isFn(event.stopPropagation)) event.stopPropagation();
        userClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (!focusable.length) return;
      const index = focusable.indexOf(shadow.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? focusable.length - 1 : index - 1)
        : (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
      if (isFn(event.preventDefault)) event.preventDefault();
      focusable[next].focus();
    };
    if (typeof window === "object" && window && isFn(window.addEventListener)) {
      window.addEventListener("keydown", keydownHandler, true);
    }
    if (isFn(els.closeButton.focus)) els.closeButton.focus();
  }

  /* A new snapshot from the session. A late one for a closed panel is
   * dropped here as well as by content.js. */
  function update(view) {
    if (!panel || !view) return;
    panel.view = view;
    paint();
  }

  function setOrigins(origins) {
    if (!panel) return;
    panel.origins = Array.isArray(origins) ? origins.filter((entry) => entry && typeof entry.origin === "string") : [];
    paint();
  }

  /* The other instance's answer for the check numbered `token`. One for an
   * earlier press, or for an instance no longer chosen, is dropped. */
  function showRemote(remote, token) {
    if (!panel || token !== panel.remoteToken || !remote) return;
    /* Progress is relayed separately from the answer and can arrive after
     * it; it never replaces a finished check. */
    if (remote.state === "busy" && panel.remote.state !== "busy") return;
    panel.remote = Object.assign({ instance: panel.remote.instance }, remote);
    paint();
  }

  globalThis.SNUpdateSetLensUI = {
    open,
    update,
    setOrigins,
    showRemote,
    close,
    isOpen: () => Boolean(host),
    copySummary,
  };
})();

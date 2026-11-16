/*
 * Isolated-world Version Lens panel. Closed shadow root, the shared GlideLens
 * palette, a focus trap, Escape to close and focus restored to whatever
 * opened it.
 *
 * Like Update Set Lens, this panel has NO markup path: every record, set,
 * update and user name and every date is read from an instance and is set
 * with textContent. Links are buttons that hand a same-origin URL, built by
 * the engine from allowlisted fields, to content.js's OPEN_URL; a set already
 * read to content.js, which opens Update Set Lens on it; or, for the instance
 * checked, an origin and ids, from which only the worker builds a URL.
 *
 * The panel draws snapshots. It never reads anything itself: content.js runs
 * the engine's session and passes each new snapshot to update(). What the
 * panel owns is how the rows are looked at: the group filter, which rows are
 * open, and the Check on choice.
 *
 * An opened row is a card per instance, as in Update Set Lens: this
 * instance's, and after a check the checked instance's, each headed by its
 * name in bold and edged in its colour, side by side where both fit. Only
 * the row's head opens and folds it; the cards are its sibling. The engine
 * hands over the pieces (a row's explain, newerSave and facts, the check's
 * parts), so no sentence is taken apart here.
 */
(() => {
  if (globalThis.SNVersionLensUI) return;

  const HOST_ID = "sn-dev-helper-version-lens";
  const TITLE_ID = "snh-vl-title";
  const COPY_RESET_MS = 2000;
  const LINK_NOTE_MS = 6000;
  const CHECK_HINT = "To check another instance, open it in a tab and sign in, then reopen Version Lens.";
  /* The engine's row order: Default sets after the history, since they are
   * never promoted. The count badges keep the same order. */
  const GROUPS = [
    { id: "open", header: "Open sets", badge: "Open" },
    { id: "complete", header: "Complete", badge: "Complete" },
    { id: "default", header: "Default sets", badge: "Default" },
    { id: "ignore", header: "Ignore", badge: "Ignored" },
    { id: "merged", header: "Merged", badge: "Merged", onlyWhenAny: true },
    { id: "unreadable", header: "Can't read", badge: "Can't read", onlyWhenAny: true },
  ];
  /* Update Set Lens's words and colours, against the version that runs here. */
  const VERDICT_WORDS = {
    current: "CURRENT",
    same: "SAME CONTENT",
    stale: "STALE",
    cant: "CAN'T TELL",
    batch: "IN THIS BATCH",
  };
  /* An opened row's card for this instance: the verdict in words, and the
   * colour of its edge. */
  const VERDICT_SAY = {
    current: "Current",
    same: "Same content",
    stale: "Stale",
    cant: "Can't tell",
    batch: "In this batch",
  };
  const VERDICT_TONE = { stale: "pink", cant: "amber" };
  /* The card for the instance checked: teal where it runs this set's version
   * or promoting replaces nothing made there, grey where the content matches,
   * amber for every difference and every Can't tell (and for any kind not
   * listed). A card that has only the set's state there is grey, unless the
   * set was backed out there or couldn't be told; that state is amber
   * wherever it is said. */
  const THERE_TONE = {
    runs: "teal", built: "teal", earlier: "teal", same: "grey",
    behind: "amber", diverged: "amber", moved: "amber", other: "amber", cant: "amber", none: "amber",
  };
  const SET_AMBER = new Set(["backed-out", "failed"]);
  const MARKS = { ok: "✓", differs: "≠", warn: "⚠" };
  const EMPTY = {
    H1: "Nothing was read: the record couldn't be identified.",
    H2: "Nothing to list: no update names this record.",
    H3: "Nothing to list: its updates couldn't be read.",
    H4: "Nothing to list: no update set here holds a capture of it.",
    H8: "Nothing to list: no capture could be read in full.",
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
    .tracked{font-size:11.5px;color:var(--muted);margin:3px 0 0;overflow-wrap:anywhere;max-width:90ch}
    .tracked code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#c9c9de}
    .close{border:0;background:transparent;color:var(--muted);padding:3px 6px;font-size:13px;
      cursor:pointer;border-radius:5px}.close:hover{color:#fff;background:#2d2d48}
    .banners{display:flex;flex-direction:column;gap:6px;padding:0 20px}
    .banners:not(:empty){padding-top:10px}
    /* A banner keeps its full width; its right padding holds the text to
       about 90 characters on a wide screen. */
    .banner{padding:8px max(11px,calc(100% - 90ch)) 8px 11px;border-radius:7px;font-size:12px;line-height:1.45;
      border:1px solid #4d5079;background:#24253c;color:#d6d6ea;overflow-wrap:anywhere}
    .banner.warn{border-color:var(--amber-line);background:#2c2619;color:#f0d9a6}
    .verdict{padding:12px 20px 10px;border-bottom:1px solid #292944;background:var(--raised);
      display:flex;flex-direction:column;gap:6px;margin-top:10px}
    .headline{font-size:14px;line-height:1.45;color:#f0f0fa;max-width:90ch;overflow-wrap:anywhere}
    .headline strong{font-weight:650}
    .headline.ok{color:#8fe0d6}
    .headline.differs,.headline.warn{color:var(--amber)}
    .sub,.runs,.loaded{font-size:12px;line-height:1.5;color:#c8c8dc;max-width:90ch;overflow-wrap:anywhere}
    .loaded{color:var(--muted)}
    .attn{font-size:12px;line-height:1.5;color:#f0d9a6;max-width:90ch;overflow-wrap:anywhere}
    .attn .links{display:inline-flex;margin:0 0 0 8px}
    .mark{margin-right:5px}
    .counts{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:2px}
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
    .check-out .note,.check-out .content{color:#9a9ab3}
    .ok{color:#8fe0d6;font-weight:600}
    .check-out .differs{color:var(--amber);font-weight:600}
    .btn{border:1px solid #5b5b86;background:#3f4067;color:#e6e6f5;border-radius:7px;padding:6px 12px;
      cursor:pointer;font-size:12px}
    .btn:hover:not(:disabled){background:#4a4b78;color:#fff}
    .btn.pink{background:var(--pink);border-color:var(--pink);color:#2a0d1a;font-weight:650}
    .btn.pink:hover:not(:disabled){background:#ff85bb}
    button:disabled{opacity:.48;cursor:default}
    .rows{flex:1;overflow:auto;min-height:0}
    .group{padding:12px 20px 4px;font-size:11px;font-weight:700;letter-spacing:.06em;color:#9a9ab3;
      text-transform:uppercase;border-bottom:1px solid #282841}
    .row{padding:9px 20px;border-bottom:1px solid #282841}
    .row.click .row-head{cursor:pointer}
    .row.click:has(> .row-head:hover){background:#262640}
    .row-head{outline:none;border-radius:4px}
    .row-head:focus-visible{outline:2px solid var(--teal);outline-offset:3px}
    /* The column header and every row share one template, so each column
       lines up down the list; a finished check adds the instance's column. */
    .cols,.row-top{display:grid;grid-template-columns:minmax(0,1fr) 150px 96px 120px 10px;gap:10px;align-items:center}
    .rows.there .cols,.rows.there .row-top{grid-template-columns:minmax(0,1fr) 150px 96px 120px 210px 10px}
    .cols{position:sticky;top:0;z-index:1;padding:7px 20px;background:var(--panel);
      border-bottom:1px solid #2e2e4e;font-size:11px;color:#9a9ab3}
    .cols span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .row-top .badge{justify-self:start}
    .r-name{color:#f0f0fa;font-size:13px;font-weight:600;min-width:0;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap}
    .r-saved{display:flex;flex-direction:column;min-width:0;font-size:11.5px;line-height:1.3;color:#c8c8dc;
      font-variant-numeric:tabular-nums}
    .r-saved span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .r-who{font-size:11px;color:var(--muted)}
    .r-there{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
    .r-none{font-size:11.5px;color:#77778f}
    .b-there{background:transparent;border-color:#4a4a6e;color:#c9c9de}
    .b-there.missing,.b-there.cloned{border-color:#33334f;color:#8d8da6}
    .b-there.backed-out,.b-there.failed{border-color:var(--amber-line);color:var(--amber)}
    .b-runs{background:#173d3a;border-color:var(--teal);color:#d9fbf7}
    .sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
      clip:rect(0 0 0 0);white-space:nowrap;border:0}
    .tally{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:2px}
    .tally-label{font-weight:650;color:#f5f5ff}
    .t-badge{font-size:12px;font-weight:650;letter-spacing:0;padding:3px 9px;font-variant-numeric:tabular-nums;
      background:#26263b;border-color:#4a4a6e;color:#d6d6ea}
    .t-badge.missing{opacity:.7}
    .caret{color:var(--muted);font-size:11px;width:10px}
    .badge{font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:1px 7px;border-radius:5px;
      border:1px solid transparent;white-space:nowrap}
    .b-stale{background:#4a2338;border-color:var(--pink);color:#ffd6e8}
    .b-cant{background:#2c2619;border-color:var(--amber-line);color:var(--amber)}
    .b-same,.b-batch{background:#26263b;border-color:#4a4a6e;color:#c3c3d8}
    .b-current{background:transparent;border-color:#33334f;color:#8d8da6}
    .b-state{background:transparent;border-color:#4a4a6e;color:#c9c9de}
    .b-state.open{border-color:#2f6f68;color:#8fe0d6}
    .b-state.default{border-color:var(--amber-line);color:var(--amber)}
    .sum-badge{font-size:12px;font-weight:650;letter-spacing:0;padding:3px 9px;cursor:pointer;
      font-variant-numeric:tabular-nums;background:#26263b;border-color:#4a4a6e;color:#d6d6ea}
    .sum-badge:hover{filter:brightness(1.18)}
    .sum-badge.zero{opacity:.45}
    .sum-badge[aria-pressed="true"]{background:#173d3a;border-color:var(--teal);color:#d9fbf7}
    .notes{color:#9a9ab3}
    .links{display:flex;flex-wrap:wrap;gap:12px;margin-top:3px}
    .link{border:0;background:transparent;color:#8fd6cf;padding:0;cursor:pointer;font-size:11.5px;
      text-decoration:underline;text-underline-offset:2px}
    .link:hover{color:#d9fbf7}
    .link-note{margin-top:6px;color:var(--amber);font-size:11.5px}
    /* An opened row: a card for this instance and one for the instance
       checked, side by side where they fit, each edged in its verdict's
       colour and headed by its instance's name. */
    .row.open .r-name{white-space:normal;overflow-wrap:anywhere}
    .r-detail{margin:8px 0 2px;font-size:12px;line-height:1.5;color:#c8c8dc;overflow-wrap:anywhere}
    .sides{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px;max-width:1240px}
    .sides.single{grid-template-columns:minmax(0,640px)}
    .side{background:#24243c;border:1px solid #33334f;border-left:3px solid #5b5b86;border-radius:8px;
      padding:8px 11px 9px;min-width:0}
    .side.t-amber{border-left-color:var(--amber)}
    .side.t-pink{border-left-color:var(--pink)}
    .side.t-teal{border-left-color:var(--teal)}
    .side-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:7px;font-size:13px;color:#f5f5ff;
      padding-bottom:5px;margin-bottom:6px;border-bottom:1px solid #33334f}
    .side-head b{font-weight:650}
    .role{font-size:10.5px;color:#9a9ab3;letter-spacing:.05em;text-transform:uppercase}
    .say{margin:0;font-size:12.5px;line-height:1.45;color:var(--text);overflow-wrap:anywhere}
    .say .v{font-weight:650}
    .v.amber{color:var(--amber)}.v.pink{color:#ffb3d3}.v.teal{color:#8fe0d6}.v.grey{color:#c3c3d8}
    .say .aside{color:#9a9ab3}
    .flags{display:inline-flex;flex-wrap:wrap;gap:4px;margin-left:4px}
    .flag{font-size:10.5px;padding:0 6px;border-radius:4px;border:1px solid #4a4a6e;color:#c9c9de}
    .flag.f-progress{border-color:#2f6f68;color:#8fe0d6}
    .flag.f-default{border-color:var(--amber-line);color:var(--amber)}
    .facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 10px;margin:6px 0 0;
      font-size:12px;line-height:1.45}
    .facts dt{color:#9a9ab3;font-size:11px;padding-top:1px}
    .facts dd{margin:0;color:var(--text);overflow-wrap:anywhere}
    .facts dd.time{font-variant-numeric:tabular-nums}
    .facts dd.del{color:#ffd6e8;font-weight:650}
    .facts dd.warn{color:var(--amber)}
    .then{margin:6px 0 0;font-size:12px;line-height:1.45;color:#f0d9a6}
    .then.teal{color:#8fe0d6}
    .side .notes{margin-top:5px;font-size:12px}
    .side .links{gap:4px 14px;margin-top:8px}
    .empty{padding:40px 24px;text-align:center;color:var(--muted);font-size:13px;line-height:1.6;
      max-width:90ch;margin:0 auto}
    .footer{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 20px;
      border-top:1px solid #2e2e4e;font-size:11.5px;color:#9a9ab3;background:#20203a}
    .footer .grow{flex:1;min-width:160px;max-width:90ch;margin-right:auto}
    button:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
    /* Narrower, the State column goes first (the group heading says it),
       then Last saved and the instance's column, which an opened row still
       spells out. */
    @media(max-width:1000px){.c-state,.b-state{display:none}
      .cols,.row-top{grid-template-columns:minmax(0,1fr) 150px 120px 10px}
      .rows.there .cols,.rows.there .row-top{grid-template-columns:minmax(0,1fr) 150px 120px 210px 10px}}
    @media(max-width:760px){.c-saved,.r-saved,.c-there,.r-there{display:none}
      .cols,.row-top,.rows.there .cols,.rows.there .row-top{grid-template-columns:minmax(0,1fr) 120px 10px}}
    @media(max-width:680px){.overlay{padding:8px}.panel{width:100%;height:calc(100vh - 16px)}}
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

  /* Another instance chosen: whatever the last one said no longer applies,
   * and the token drops a late answer to it. */
  function forgetRemote() {
    if (!panel) return;
    panel.remoteToken += 1;
    panel.remote = { state: "idle" };
  }

  /* A link that could not open says why beside it, for a few seconds, and
   * never in place of the link. The words beside it are redrawn with every
   * paint, and a live region created already filled is often not announced,
   * so the panel's one live region, never redrawn, reads them out once. The
   * check's own links are the exception: their note is drawn inside the
   * check's answer, which is a live region already, so it is read out there
   * and not twice. */
  const ANNOUNCED_IN_PLACE = "remote";

  function showLinkNote(key, text) {
    if (!panel) return;
    const owner = panel;
    owner.linkNote = { key, text: str(text) };
    const live = els && els.live && key !== ANNOUNCED_IN_PLACE ? els.live : null;
    if (live) live.textContent = str(text);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      if (panel !== owner || !owner.linkNote || owner.linkNote.key !== key) return;
      owner.linkNote = null;
      if (live) live.textContent = "";
      paint();
    }, LINK_NOTE_MS);
    paint();
  }

  /* As with a link: a middle-click (auxclick, button 1), or a click with
   * Ctrl or Cmd held, opens the page in a tab behind this one. "Check this
   * set" replaces this panel rather than opening a page, so a middle-click
   * leaves it alone. A middle press is held from starting the browser's
   * autoscroll. */
  function linkButton(link, noteKey) {
    const open = (event, background) => {
      if (event && isFn(event.stopPropagation)) event.stopPropagation();
      const opts = { background };
      if (link.url) {
        if (sameOrigin(link.url) && isFn(callbacks.onOpenUrl)) callbacks.onOpenUrl(link.url, opts);
        return;
      }
      let outcome = null;
      if (link.set) {
        if ((!background || !event || event.button !== 1) && isFn(callbacks.onOpenSetLens)) outcome = callbacks.onOpenSetLens(link.set);
      } else if (link.remote && isFn(callbacks.onOpenRemote)) outcome = callbacks.onOpenRemote(Object.assign({}, link.remote), opts);
      if (!outcome || noteKey == null) return;
      Promise.resolve(outcome).then((result) => {
        if (result && result.ok === false) showLinkNote(noteKey, result.message || "Couldn't open that.");
      }, () => showLinkNote(noteKey, "Couldn't open that."));
    };
    const node = button("link", link.label, (event) => open(event, Boolean(event && (event.ctrlKey || event.metaKey))));
    node.addEventListener("auxclick", (event) => {
      if (!event || event.button !== 1) return;
      if (isFn(event.preventDefault)) event.preventDefault();
      open(event, true);
    });
    node.addEventListener("mousedown", (event) => {
      if (event && event.button === 1 && isFn(event.preventDefault)) event.preventDefault();
    });
    return node;
  }

  function linkRow(links, keyPrefix, noteKey) {
    const row = el("div", "links");
    links.forEach((link, index) => row.appendChild(remember(linkButton(link, noteKey), keyPrefix + ":" + index)));
    return row;
  }

  /* Shown beside the link; read out once by the panel's live region. */
  function noteFor(key) {
    if (!panel.linkNote || panel.linkNote.key !== key) return null;
    return el("div", "link-note", panel.linkNote.text);
  }

  /* ------------------------------------------------------------------ *
   * The counts-only copy summary: the engine's lines, then the check's.
   * No record, set or person name, no id, origin or URL.
   * ------------------------------------------------------------------ */

  function copySummary(view, remote) {
    const lines = ((view && view.copyLines) || []).slice();
    if (remote && remote.state === "done" && remote.copyLine) lines.push(remote.copyLine);
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ *
   * Painting
   * ------------------------------------------------------------------ */

  function paintHeader(view) {
    clear(els.subtitle);
    clear(els.tracked);
    const target = view.target;
    const record = target || view.record || null;
    if (!record) {
      setHidden(els.tracked, true);
      return;
    }
    const display = record.display || (target ? target.name : "") || "This record";
    els.subtitle.appendChild(el("strong", null, display));
    const parts = [record.clsLabel || record.cls, record.scope].concat(target ? target.howWords || [] : []);
    const rest = parts.filter(Boolean);
    if (rest.length) els.subtitle.appendChild(document.createTextNode(" · " + rest.join(" · ")));
    setHidden(els.tracked, !target);
    if (target) {
      els.tracked.appendChild(document.createTextNode("tracked as "));
      els.tracked.appendChild(el("code", null, target.name));
    }
  }

  function paintBanners(view) {
    clear(els.banners);
    (view.banners || []).forEach((banner) => {
      els.banners.appendChild(el("div", "banner" + (banner.kind === "warn" ? " warn" : ""), banner.text));
    });
  }

  function groupCount(view, id) {
    return (view.counts && view.counts[id]) || 0;
  }

  function paintVerdict(view) {
    clear(els.headline);
    clear(els.lines);
    clear(els.counts);
    clear(els.progress);
    const headline = view.headline;
    if (headline) {
      const mark = headline.mark === "ok" && !view.clear ? "" : headline.mark;
      const node = el("div", "headline" + (mark ? " " + mark : ""));
      if (MARKS[mark]) {
        const sign = el("span", "mark", MARKS[mark]);
        sign.setAttribute("aria-hidden", "true");
        node.appendChild(sign);
      }
      node.appendChild(el("strong", null, headline.lead));
      if (headline.rest) node.appendChild(document.createTextNode(" " + headline.rest));
      els.headline.appendChild(node);
    }
    (view.sublines || []).forEach((line) => els.lines.appendChild(el("div", "sub", line)));
    (view.attention || []).forEach((line, index) => {
      const node = markedLine("div", "attn", MARKS.warn, line.text);
      if (line.links && line.links.length) {
        const links = el("span", "links");
        line.links.forEach((link, at) => links.appendChild(remember(linkButton(link, "attn:" + index), "attn-link:" + index + ":" + at)));
        node.appendChild(links);
      }
      const note = noteFor("attn:" + index);
      if (note) node.appendChild(note);
      els.lines.appendChild(node);
    });
    if (view.runsHere) els.lines.appendChild(el("div", "runs", view.runsHere));
    if (view.loadedLine) els.lines.appendChild(el("div", "loaded", view.loadedLine));

    /* Count badges filter the rows, as Update Set Lens's summary badges do. */
    const rows = view.rows || [];
    setHidden(els.counts, !rows.length);
    if (rows.length) {
      GROUPS.forEach((group) => {
        const count = groupCount(view, group.id);
        if (group.onlyWhenAny && !count) return;
        const badge = button("badge sum-badge" + (count ? "" : " zero"), count.toLocaleString() + " " + group.badge,
          () => setFilter(panel.filter === group.id ? null : group.id));
        badge.setAttribute("aria-pressed", panel.filter === group.id ? "true" : "false");
        badge.setAttribute("aria-label", "Show only the " + group.header.toLowerCase() + ": " + count);
        els.counts.appendChild(remember(badge, "count:" + group.id));
      });
    }

    if (view.busy) {
      const spinner = el("span", "spinner");
      spinner.setAttribute("aria-hidden", "true");
      els.progress.appendChild(spinner);
      els.progress.appendChild(el("span", null, view.progress || "Checking…"));
    }
  }

  function paintCheck(view) {
    const check = view.check || {};
    setHidden(els.check, !check.shown);
    if (!check.shown) return;
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
    /* The captures read here are what is compared there, so the check
     * waits for the run. */
    setDisabled(els.checkButton, !check.ready || panel.remote.state === "busy");

    clear(els.checkOut);
    const remote = panel.remote;
    if (!none && check.blocked && remote.state === "idle") {
      els.checkOut.appendChild(el("div", "note", check.blocked));
    }
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
        if (line.kind === "ok") els.checkOut.appendChild(markedLine("div", "ok", MARKS.ok, line.text));
        else if (line.kind === "differs") els.checkOut.appendChild(markedLine("div", "differs", MARKS.differs, line.text));
        else els.checkOut.appendChild(el("div", ["state", "warn", "note", "content"].includes(line.kind) ? line.kind : "", line.text));
      });
      /* The sets' states there, counted; each row carries its own. */
      if (remote.tally && remote.tally.length) {
        const tally = el("div", "tally");
        tally.appendChild(el("span", "tally-label", "Sets on " + str(remote.instance) + ":"));
        remote.tally.forEach((entry) => {
          tally.appendChild(el("span", "badge t-badge " + str(entry.there), Number(entry.count).toLocaleString() + " " + entry.word));
        });
        els.checkOut.appendChild(tally);
      }
      if (remote.links && remote.links.length) {
        els.checkOut.appendChild(linkRow(remote.links, "remote-link", ANNOUNCED_IN_PLACE));
        const note = noteFor(ANNOUNCED_IN_PLACE);
        if (note) els.checkOut.appendChild(note);
      }
    }
  }

  /* The checked instance's answer for a row, once a check has finished. */
  function remoteAnswer(row) {
    const remote = panel.remote;
    if (remote.state !== "done" || !remote.perRow) return null;
    return remote.perRow[row.key] || null;
  }

  /* The same answer in pieces, for the row's card. */
  function remoteParts(row) {
    const remote = panel.remote;
    if (remote.state !== "done" || !remote.parts) return null;
    const parts = remote.parts[row.key];
    return parts && typeof parts === "object" ? parts : null;
  }

  const checked = () => panel.remote.state === "done";

  /* Why a row has nothing from the instance checked: a Default set is never
   * looked for there, and the rest weren't part of the check. */
  function notCheckedWhy(row) {
    return row.group === "default"
      ? "Default sets are never promoted, so the check doesn't look for them."
      : "This set wasn't part of the check.";
  }

  /* "<on> by <person>", or whichever of the two is known. */
  function onBy(on, by) {
    const when = str(on);
    const who = str(by);
    return when && who ? when + " by " + who : when || (who ? "by " + who : "");
  }

  /* A card's labelled facts; a fact with no value is left out. */
  function factList(facts) {
    const shown = facts.filter((fact) => str(fact[1]));
    if (!shown.length) return null;
    const list = el("dl", "facts");
    shown.forEach(([label, value, className]) => {
      list.appendChild(el("dt", null, label));
      list.appendChild(el("dd", className || null, value));
    });
    return list;
  }

  /* A card: an instance's name in bold and its role, then what it says. */
  function sideCard(tone, name, role) {
    const card = el("div", "side" + (tone && tone !== "grey" ? " t-" + tone : ""));
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", (name ? name + ", " : "") + role);
    const head = el("div", "side-head");
    if (name) head.appendChild(el("b", null, name));
    head.appendChild(el("span", "role", role));
    card.appendChild(head);
    return card;
  }

  /* The card's first line: its answer in its colour, then why. */
  function sayLine(tone, word, rest) {
    const say = el("p", "say");
    say.appendChild(el("span", "v " + tone, word));
    if (str(rest)) say.appendChild(document.createTextNode(" " + str(rest)));
    return say;
  }

  /* This instance's card: the verdict and why, the capture's facts, and the
   * row's own links. */
  function hereCard(row) {
    const tone = VERDICT_TONE[row.verdict] || "grey";
    const card = sideCard(tone, panel.here, "this instance");
    const say = sayLine(tone, (VERDICT_SAY[row.verdict] || row.verdict) + ".", row.explain != null ? row.explain : row.text);
    if (row.flags && row.flags.length) {
      const flags = el("span", "flags");
      row.flags.forEach((flag) => flags.appendChild(el("span", "flag" + (flag && flag.kind ? " f-" + flag.kind : ""), flag && flag.label)));
      say.appendChild(flags);
    }
    card.appendChild(say);
    const first = row.firstCaptured && typeof row.firstCaptured === "object" ? row.firstCaptured : null;
    const newer = row.newerSave && typeof row.newerSave === "object" ? row.newerSave : null;
    const newerSet = row.newerSet && typeof row.newerSet === "object" ? row.newerSet : null;
    const facts = factList([
      ["Last saved", row.savedOn, "time"],
      ["By", row.savedBy],
      ["Action", row.action, row.action === "Delete" ? "del" : ""],
      ["First captured", first ? onBy(first.on, first.by) : "", "time"],
      ["Completed", row.completedOn, "time"],
      ["Batch", row.batchName],
      ["Merged into", row.mergedIntoName],
      ["Scope", row.captureScope],
      ["Source", row.committedHere ? "Committed here from another instance" : ""],
      [newer && newer.committedHere ? "Newer committed here" : "Newer saved", newer ? onBy(newer.on, newer.by) : "", "time"],
      /* The newer version's set, which is not this row's: a Default one is
       * a change made outside a named set. */
      ["Newer set", newerSet ? newerSet.state : "", newerSet && newerSet.isDefault ? "warn" : ""],
    ]);
    if (facts) card.appendChild(facts);
    if (row.notes && row.notes.length) card.appendChild(el("div", "notes", row.notes.join(" · ")));
    if (row.links && row.links.length) card.appendChild(linkRow(row.links, "link:" + row.key, row.key));
    return card;
  }

  /* The checked instance's card, once a check has finished: the set's state
   * there, what runs there where it is this capture or its content, and, on
   * the capture holding the version that runs here, what promoting its set
   * would do. "Not checked" for a row the check didn't look at. */
  function thereCard(row) {
    if (!checked()) return null;
    const instance = str(panel.remote.instance);
    const parts = remoteParts(row);
    const set = parts && parts.set && typeof parts.set === "object" ? parts.set : null;
    if (!parts || (!str(parts.kind) && !set)) {
      const card = sideCard("grey", instance, "checked instance");
      card.appendChild(sayLine("grey", "Not checked.", notCheckedWhy(row)));
      return card;
    }
    if (!str(parts.kind)) {
      const tone = SET_AMBER.has(str(set.there)) ? "amber" : "grey";
      const card = sideCard(tone, instance, "checked instance");
      card.appendChild(sayLine(tone, str(set.text) + "."));
      return card;
    }
    const tone = THERE_TONE[parts.kind] || "amber";
    const card = sideCard(tone, instance, "checked instance");
    const say = sayLine(tone, str(parts.say) + ".");
    const notes = Array.isArray(parts.notes) ? parts.notes.map(str).filter(Boolean) : [];
    if (notes.length) say.appendChild(el("span", "aside", " (" + notes.join(", ") + ")"));
    card.appendChild(say);
    const saved = parts.saved && typeof parts.saved === "object" ? parts.saved : {};
    const facts = factList([
      ["This set", set ? set.text : "", set && SET_AMBER.has(str(set.there)) ? "warn" : ""],
      ["Saved", saved.on, "time"],
      [saved.set ? "Set" : "From", saved.set || saved.from],
    ]);
    if (facts) card.appendChild(facts);
    if (str(parts.then)) card.appendChild(el("p", "then" + (tone === "teal" ? " teal" : ""), str(parts.then) + "."));
    return card;
  }

  /* Visual only: each row's cells say what they are to a screen reader. */
  function columnHeader() {
    const head = el("div", "cols");
    head.setAttribute("aria-hidden", "true");
    head.appendChild(el("span", "c-name", "Update set"));
    head.appendChild(el("span", "c-saved", "Last saved"));
    head.appendChild(el("span", "c-state", "Set state"));
    head.appendChild(el("span", "c-verdict", "Version here"));
    if (checked()) head.appendChild(el("span", "c-there", "On " + str(panel.remote.instance)));
    head.appendChild(el("span", "c-caret"));
    return head;
  }

  /* When this set last saved the record, and who: the order the rows are
   * sorted in within a group, made visible across groups too. */
  function savedCell(row) {
    const cell = el("span", "r-saved");
    cell.appendChild(el("span", "sr", "Last saved "));
    cell.appendChild(el("span", "r-when", row.savedOn || "—"));
    if (row.savedBy) cell.appendChild(el("span", "r-who", row.savedBy));
    return cell;
  }

  /* The checked instance's column: the set's state there, and whether what
   * runs there is this set's version or the same content. */
  function thereCell(row) {
    const instance = str(panel.remote.instance);
    const cell = el("span", "r-there");
    cell.appendChild(el("span", "sr", "On " + instance + ": "));
    const answer = remoteAnswer(row) || {};
    if (answer.there) {
      const badge = el("span", "badge b-there " + answer.there, str(answer.thereWord).toUpperCase());
      if (answer.presence) badge.title = answer.presence;
      cell.appendChild(badge);
    } else {
      const none = el("span", "r-none", "Not checked");
      none.title = notCheckedWhy(row);
      cell.appendChild(none);
    }
    if (answer.content === "runs") {
      const runs = el("span", "badge b-runs", "RUNS THERE");
      runs.title = "The version that runs on " + instance + " is this set's.";
      cell.appendChild(runs);
    } else if (answer.content === "same") {
      const same = el("span", "badge b-same", "RUNS SAME CONTENT");
      same.title = instance + " runs the same content as this set, saved under another update.";
      cell.appendChild(same);
    }
    return cell;
  }

  function buildRow(row) {
    const open = Boolean(row.pinned) || panel.expanded.has(row.key);
    const node = el("div", "row" + (row.pinned ? "" : " click") + (open ? " open" : ""));
    /* The head (the row's line) is what opens and folds it. The cards are its
     * sibling: inside a button, their links and labelled facts would be
     * flattened for a screen reader, and selecting a set name to copy it
     * would fold the row. */
    const head = el("div", "row-head");
    const top = el("div", "row-top");
    const name = el("span", "r-name", row.setName);
    name.title = row.setName;
    top.appendChild(name);
    top.appendChild(savedCell(row));
    top.appendChild(el("span", "badge b-state " + row.group, row.stateBadge));
    top.appendChild(el("span", "badge b-" + row.verdict, VERDICT_WORDS[row.verdict] || row.verdict));
    if (checked()) top.appendChild(thereCell(row));
    const caret = el("span", "caret", row.pinned ? "" : open ? "▾" : "▸");
    caret.setAttribute("aria-hidden", "true");
    top.appendChild(caret);
    head.appendChild(top);
    node.appendChild(head);

    let detailId = "";
    if (open) {
      const detail = el("div", "r-detail");
      detailId = "snh-vl-detail-" + (panel.detailSeq += 1);
      detail.id = detailId;
      const there = thereCard(row);
      const sides = el("div", "sides" + (there ? "" : " single"));
      sides.appendChild(hereCard(row));
      if (there) sides.appendChild(there);
      detail.appendChild(sides);
      const note = noteFor(row.key);
      if (note) detail.appendChild(note);
      node.appendChild(detail);
    }

    if (!row.pinned) {
      head.setAttribute("tabindex", "0");
      head.setAttribute("role", "button");
      head.setAttribute("aria-expanded", open ? "true" : "false");
      if (detailId) head.setAttribute("aria-controls", detailId);
      const toggle = () => {
        if (panel.expanded.has(row.key)) panel.expanded.delete(row.key);
        else panel.expanded.add(row.key);
        paint();
      };
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (event) => {
        /* Only a key pressed on the head itself folds the row. */
        if (event.target && event.target !== head) return;
        if (event.key === "Enter" || event.key === " ") {
          if (isFn(event.preventDefault)) event.preventDefault();
          toggle();
        }
      });
      remember(head, "row:" + row.key);
    }
    return node;
  }

  function paintRows(view) {
    clear(els.rows);
    els.rows.className = "rows" + (checked() ? " there" : "");
    const rows = view.rows || [];
    if (!rows.length) {
      if (view.busy) els.rows.appendChild(el("div", "empty", "Checking…"));
      else if (view.headline) els.rows.appendChild(el("div", "empty", EMPTY[view.headline.id] || "Nothing to list."));
      return;
    }
    els.rows.appendChild(columnHeader());
    const filter = panel.filter && groupCount(view, panel.filter) ? panel.filter : null;
    GROUPS.forEach((group) => {
      if (filter && filter !== group.id) return;
      const members = rows.filter((row) => row.group === group.id);
      if (!members.length) return;
      els.rows.appendChild(el("div", "group", group.header + " (" + groupCount(view, group.id) + ")"));
      members.forEach((row) => els.rows.appendChild(buildRow(row)));
    });
  }

  function paintFooter(view) {
    clear(els.footerLinks);
    (view.links || []).forEach((link, index) => {
      els.footerLinks.appendChild(remember(button("btn", link.label, () => {
        if (sameOrigin(link.url) && isFn(callbacks.onOpenUrl)) callbacks.onOpenUrl(link.url);
      }), "footer-link:" + index));
    });
    setDisabled(els.copyButton, Boolean(view.busy) || !(view.copyLines || []).length);
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
      ["footer-close", els.footerClose],
    ]);
    paintHeader(view);
    paintBanners(view);
    paintVerdict(view);
    paintCheck(view);
    paintRows(view);
    paintFooter(view);
    if (focusKey && panel.focusables.has(focusKey)) {
      const target = panel.focusables.get(focusKey);
      if (target !== focused && !target.hidden && !target.disabled && isFn(target.focus)) target.focus();
    } else if (focusKey && focused && !focused.isConnected && isFn(els.closeButton.focus)) {
      /* The focused control is gone (a filter emptied, a row closed): keep
       * focus inside the panel rather than letting it fall to the page. */
      els.closeButton.focus();
    }
  }

  function setFilter(id) {
    panel.filter = id;
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
    const title = el("h2", "", "Version Lens");
    title.id = TITLE_ID;
    heading.appendChild(title);
    const subtitle = el("p", "subtitle");
    heading.appendChild(subtitle);
    const tracked = el("p", "tracked");
    heading.appendChild(tracked);
    const closeButton = button("close", "✕ Esc", () => userClose());
    closeButton.setAttribute("aria-label", "Close");
    closeButton.snhFocusKey = "close";
    header.appendChild(heading);
    header.appendChild(closeButton);
    section.appendChild(header);

    const banners = el("div", "banners");
    section.appendChild(banners);

    const verdict = el("div", "verdict");
    const headlineBox = el("div", null);
    const lines = el("div", null);
    const counts = el("div", "counts");
    counts.setAttribute("role", "group");
    counts.setAttribute("aria-label", "Filter rows by set state");
    const progress = el("div", "progress");
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-live", "polite");
    verdict.appendChild(headlineBox);
    verdict.appendChild(lines);
    verdict.appendChild(counts);
    verdict.appendChild(progress);
    section.appendChild(verdict);

    /* Right under the verdict, as in Update Set Lens. */
    const check = el("div", "check");
    const checkRow = el("div", "check-row");
    const selectLabel = el("label", null, "Check on");
    selectLabel.htmlFor = "snh-vl-origin";
    const select = el("select");
    select.id = "snh-vl-origin";
    select.snhFocusKey = "select";
    select.addEventListener("change", () => {
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

    const rows = el("div", "rows");
    section.appendChild(rows);

    const footer = el("footer", "footer");
    footer.appendChild(el("span", "grow",
      "Read-only: Version Lens never changes a set. Only this instance's own captures are listed."));
    const footerLinks = el("span", "links");
    footer.appendChild(footerLinks);
    const copyButton = button("btn", "Copy summary", () => copyCounts());
    copyButton.snhFocusKey = "copy";
    const footerClose = button("btn", "Close", () => userClose());
    footerClose.snhFocusKey = "footer-close";
    footer.appendChild(copyButton);
    footer.appendChild(footerClose);
    section.appendChild(footer);

    /* One live region for the whole panel, never redrawn: a note created
     * already filled, as a link's note is on every paint, is often not read. */
    const live = el("div", "sr");
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    section.appendChild(live);

    overlay.appendChild(section);
    shadow.appendChild(overlay);

    els = {
      overlay, section, subtitle, tracked, banners, headline: headlineBox, lines, counts, progress,
      check, checkRow, select, checkButton, checkHint, checkOut, rows, footer, footerLinks,
      copyButton, footerClose, closeButton, live,
    };
  }

  function copyCounts() {
    if (!panel || !isFn(callbacks.onCopy)) return;
    const text = copySummary(panel.view, panel.remote);
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
   * open({ view, origins, here, callbacks, opener })
   *   here: this instance's name, for the heading of its card
   *   callbacks: onCheckRemote(origin, token), onOpenUrl(url),
   *   onOpenSetLens(set) and onOpenRemote({ origin, table, sysId } |
   *   { origin, name }), the last two -> Promise<{ ok, message }>,
   *   onCopy(text) -> Promise<boolean>, onClose()
   */
  function open(options) {
    close();
    const opts = options || {};
    callbacks = Object.assign({}, opts.callbacks || {});
    opener = opts.opener || (typeof document === "object" && document ? document.activeElement : null);
    panel = {
      view: opts.view || {},
      origins: Array.isArray(opts.origins) ? opts.origins.slice() : [],
      /* This instance's name, for the heading of its card. */
      here: str(opts.here),
      filter: null,
      expanded: new Set(),
      focusables: new Map(),
      remote: { state: "idle" },
      remoteToken: 0,
      linkNote: null,
      detailSeq: 0,
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

  globalThis.SNVersionLensUI = {
    open,
    update,
    setOrigins,
    showRemote,
    close,
    isOpen: () => Boolean(host),
    copySummary,
  };
})();

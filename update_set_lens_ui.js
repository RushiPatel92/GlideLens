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
 * content there, which is grey because the content matches, and a version
 * this set was built on (or an earlier save of it), which is teal because
 * promoting it replaces nothing made there. A row whose own version was
 * there and has since been changed is amber, whatever its history says. A
 * row a newer update of its batch replaces, where that instance runs
 * another update of the same batch, is grey too: promoting leaves the
 * batch's newest update, not this one.
 *
 * An opened row is a card per instance (owner's pick, 2026-11-12, of an
 * independent design): this instance's, and after a check the checked
 * instance's, each headed by its name in bold and edged in its colour, side
 * by side where both fit. The engine hands over the pieces (a row's explain
 * and newerSave, the check's parts), so no sentence is taken apart here.
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
   * there is grey: the content matches. A version this set was built on is
   * teal: promoting moves it forward and replaces nothing made there. */
  const THERE_WORDS = {
    built: "PREVIOUS VERSION THERE",
    earlier: "EARLIER SAVE THERE",
    behind: "OLDER VERSION THERE",
    diverged: "DIVERGED THERE",
    moved: "CHANGED THERE SINCE",
    other: "OTHER VERSION THERE",
    none: "NO CURRENT VERSION THERE",
    cant: "CAN'T TELL THERE",
    same: "SAME CONTENT THERE",
    inbatch: "BATCH VERSION THERE",
    unsent: "NOT COMPARED THERE",
  };
  const THERE_OK = new Set(["built", "earlier"]);
  /* Grey: the content matches, what runs there is this batch's own, or the
   * row was past what a check compares. */
  const THERE_GREY = new Set(["same", "inbatch", "unsent"]);
  const thereTone = (kind) => (THERE_GREY.has(kind) ? " same" : THERE_OK.has(kind) ? " ok" : "");
  /* An opened row's card for this instance: the verdict in words, and the
   * colour of its edge. */
  const VERDICT_SAY = {
    stale: "Stale",
    cant: "Can't tell",
    batch: "In this batch",
    same: "Same content",
    current: "Current",
  };
  const VERDICT_TONE = { stale: "pink", cant: "amber" };
  /* The card for the instance checked: teal where promoting replaces
   * nothing made there, grey where the content matches, amber otherwise. */
  const thereCardTone = (kind) => (kind === "runs" || THERE_OK.has(kind) ? "teal" : THERE_GREY.has(kind) ? "grey" : "amber");
  const SUMMARY_WORDS = {
    stale: "stale",
    cant: "can't tell",
    batch: "in this batch",
    same: "same content",
    current: "current",
  };
  /* Sets checked together say "these sets" where a batch says "this batch":
   * the same verdict, a newer version in a set checked with this one. */
  const GROUP_WORDS = {
    badge: "IN THESE SETS",
    say: "In these sets",
    summary: "in these sets",
    there: "OTHER SET'S VERSION THERE",
  };
  const grouped = (view) => Boolean(view && view.unit === "group");
  const badgeWord = (verdict) => (verdict === "batch" && grouped(panel && panel.view) ? GROUP_WORDS.badge : BADGE_WORDS[verdict]);
  const sayWord = (verdict) => (verdict === "batch" && grouped(panel && panel.view) ? GROUP_WORDS.say : VERDICT_SAY[verdict]);
  const summaryWord = (key, view) => (key === "batch" && grouped(view) ? GROUP_WORDS.summary : SUMMARY_WORDS[key]);
  const thereWord = (kind) => (kind === "inbatch" && grouped(panel && panel.view) ? GROUP_WORDS.there : THERE_WORDS[kind]);
  /* Several sets checked as one: a batch with its children, or sets
   * checked together. Its own verdict, "batch", then shows. */
  const checkedAsOne = (view) => Boolean(view && (view.unit === "batch" || view.unit === "group" ||
    (view.batch && view.batch.included)));
  const groupOn = (view) => Boolean(view && view.group && view.group.included);

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
    /* Sets checked together: the order to commit them in, oldest first
       unless a record needs otherwise. */
    .order{margin:10px 20px 0;font-size:12px;line-height:1.45;color:#d6d6ea;max-width:90ch}
    .order-head{color:#9a9ab3;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;margin-bottom:3px}
    .order-status{margin:0 0 4px}
    .order-status.ok{color:#8fe0d6;font-weight:600}
    .order-status.warn{color:var(--amber);font-weight:600}
    .order-list{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:2px}
    .order-list .o-name{color:#f0f0fa;font-weight:600;overflow-wrap:anywhere}
    .order-list .o-meta{color:#9a9ab3;font-size:11.5px;margin-left:6px}
    .order-list .o-after{display:block;color:#bdbdd0;font-size:11.5px}
    .order-list .o-after.warn{color:var(--amber)}
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
    .row{padding:9px 20px;border-bottom:1px solid #282841}
    .row.click .row-head{cursor:pointer}
    .row.click:has(> .row-head:hover){background:#262640}
    .row-head{outline:none;border-radius:4px}
    .row-head:focus-visible{outline:2px solid var(--teal);outline-offset:3px}
    .sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
      clip:rect(0 0 0 0);white-space:nowrap;border:0}
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
    .b-there.ok{background:#173d3a;border-color:#2f6f68;color:#8fe0d6}
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
    .link:hover{color:#d9fbf7}
    .remote-tag{display:block;margin-top:2px;color:#b9b3e8;font-size:11.5px}
    .remote-tag.warn{color:var(--amber)}
    .remote-tag.ok{color:#8fe0d6}
    .remote-tag b{font-weight:650;color:#f5f5ff}
    .link-note{margin-top:6px;color:var(--amber);font-size:11.5px}
    /* An opened row: a card for this instance and one for the instance
       checked, side by side where they fit, each edged in its verdict's
       colour and headed by its instance's name. */
    .row.open .r-name{white-space:normal;overflow-wrap:anywhere}
    .r-detail.open{max-width:none}
    .r-meta{display:none;color:#9a9ab3;font-size:11px;margin-bottom:6px}
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
    .facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 10px;margin:6px 0 0;
      font-size:12px;line-height:1.45}
    .facts dt{color:#9a9ab3;font-size:11px;padding-top:1px}
    .facts dd{margin:0;color:var(--text);overflow-wrap:anywhere}
    .facts dd.time{font-variant-numeric:tabular-nums}
    .then{margin:6px 0 0;font-size:12px;line-height:1.45;color:#f0d9a6}
    .side .notes,.side .who{margin-top:5px;font-size:12px}
    .side .links{gap:4px 14px;margin-top:8px}
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
      .r-detail{padding-left:0}.r-meta{display:block}}
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
    if (els && els.live) els.live.textContent = str(text);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      if (panel !== owner || !owner.linkNote || owner.linkNote.key !== key) return;
      owner.linkNote = null;
      if (els && els.live) els.live.textContent = "";
      paint();
    }, LINK_NOTE_MS);
    paint();
  }

  /* `noteKey` is the row a refusal is said on; a link without one opens
   * a URL and has nothing to report.
   *
   * As with a link: a middle-click (auxclick, button 1), or a click with
   * Ctrl or Cmd held, opens the page in a tab behind this one. "Other sets
   * holding it" replaces this panel rather than opening a page, so a
   * middle-click leaves it alone. A middle press is held from starting the
   * browser's autoscroll. */
  function linkButton(link, noteKey) {
    const open = (event, background) => {
      if (event && isFn(event.stopPropagation)) event.stopPropagation();
      const opts = { background };
      if (link.url) {
        if (sameOrigin(link.url) && isFn(callbacks.onOpenUrl)) callbacks.onOpenUrl(link.url, opts);
        return;
      }
      let outcome = null;
      if (link.record && isFn(callbacks.onOpenRecord)) outcome = callbacks.onOpenRecord(str(link.record), opts);
      else if (link.versionLens) {
        if (!background || !event || event.button !== 1) {
          if (isFn(callbacks.onOpenVersionLens)) outcome = callbacks.onOpenVersionLens(str(link.versionLens));
        }
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
    /* A commit order to change, sets no order can place, or records whose
     * order can't be told are all something to look at. */
    const order = view.group && view.group.included ? view.group.order : null;
    const stuck = Boolean(order && (order.cycle || (order.against && order.against.length) || order.unplaced));
    return view.phase === "done" && Boolean(totals.exact) && rows.length > 0 && !rows.some(needsAttention) &&
      !(view.banners || []).some((banner) => banner.kind === "warn") && !stuck;
  }

  /* The checked instance's answer for a row: there is one only where it
   * differs, once a check has finished. */
  function remoteAnswer(row) {
    const remote = panel.remote;
    if (remote.state !== "done" || !remote.perRow) return null;
    return remote.perRow[row.key] || null;
  }

  const differsThere = (row) => Boolean(remoteAnswer(row));

  /* The same answer in pieces, for the card, and for a row that runs this
   * set's version there too. */
  function remoteParts(row) {
    const remote = panel.remote;
    if (remote.state !== "done" || !remote.parts) return null;
    const parts = remote.parts[row.key];
    return parts && typeof parts === "object" ? parts : null;
  }

  /* U2: Needs attention while there is any and nothing has been picked. A
   * pick of Differs there lapses with the check that answered it. */
  function activeFilter(rows) {
    if (panel.filter && (panel.filter !== "there" || rows.some(differsThere)) &&
      (panel.filter !== "unplaced" || rows.some((row) => row.orderUnknown))) return panel.filter;
    return rows.some(needsAttention) ? "attention" : "all";
  }

  function matchesFilter(row, filter) {
    if (filter === "all") return true;
    if (filter === "attention") return needsAttention(row);
    if (filter === "there") return differsThere(row);
    if (filter === "unplaced") return Boolean(row.orderUnknown);
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
    const together = groupOn(view);
    const batch = !together && view && view.batch && view.batch.included;
    const what = together ? "a group of " + view.group.sets.length + " update sets checked together"
      : batch ? "a batch of " + ((view.batch.setCount || 0) + 1) + " update sets" : "one update set";
    const lines = [
      "Update Set Lens: " + what + ".",
      "Checked " + (totals.checked || 0) +
        (totals.total != null ? (totals.exact ? " of " : " of up to ") + totals.total : "") + " updates.",
      "Stale " + c.stale + ", can't tell " + c.cant +
        (together ? ", in these sets " + c.batch : batch ? ", in this batch " + c.batch : "") +
        ", same content " + c.same + ", current " + c.current + ".",
    ];
    /* The order in counts only: no set's name leaves the screen. */
    const order = together ? view.group.order : null;
    if (order) {
      const unplaced = Number(order.unplaced) || 0;
      const main = order.cycle ? "no order works for " + order.cycle.length + " sets"
        : order.against.length ? "differs from creation order for " + order.against.length +
          (order.against.length === 1 ? " pair" : " pairs") + " of sets"
          : order.rules ? "creation order works"
            : unplaced ? "" : "doesn't matter, no record is changed by two of these sets";
      const unknown = unplaced ? unplaced + (unplaced === 1 ? " record" : " records") + " can't be placed" : "";
      lines.push("Commit order: " + [main, unknown].filter(Boolean).join("; ") + (order.soFar ? " (so far)" : "") + ".");
    }
    if (remoteCounts) {
      /* What the update's own history placed, only when it placed any, so a
       * check that placed nothing reads as it always did. */
      const placed = [
        ["the version it was built on", remoteCounts.built],
        ["an earlier save of it", remoteCounts.earlier],
        ["an older version", remoteCounts.behind],
        ["a version not in its history", remoteCounts.diverged],
        ["had this set's version, since changed", remoteCounts.moved],
      ].filter((part) => part[1]).map((part) => ", " + part[0] + " " + part[1]).join("");
      lines.push(
        "On the other instance: runs this set's version " + remoteCounts.runs +
        ", same content " + remoteCounts.same +
        (remoteCounts.inBatch ? (together ? ", another update from these sets " : ", another update of this batch ") +
          remoteCounts.inBatch : "") +
        placed + ", another version " + remoteCounts.other +
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
    if (groupOn(view)) {
      /* Sets checked together: the story they share, then how many. */
      const count = view.group.sets.length;
      const story = str(view.group.story);
      subtitle.appendChild(el("strong", null, story || plural(count, "update set", "update sets")));
      const bits = [story ? plural(count, "update set", "update sets") + " checked together" : "checked together"];
      const totals = view.totals || {};
      if (totals.total != null) bits.push((totals.exact ? "" : "up to ") + plural(totals.total, "update", "updates"));
      subtitle.appendChild(document.createTextNode(" · " + bits.join(" · ")));
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

  /* The other sets named for this set's story, behind a tick box like the
   * batch's; and, while sets are checked together, the order to commit
   * them in. */
  function paintGroup(view) {
    const group = view.group;
    clear(els.group);
    setHidden(els.group, !group);
    if (!group) return;
    if (!group.fixed) {
      const label = el("label", "batch-line");
      const box = el("input");
      box.type = "checkbox";
      box.setAttribute("type", "checkbox");
      box.checked = Boolean(group.included);
      setDisabled(box, Boolean(view.busy));
      box.addEventListener("change", () => {
        panel.filter = null;
        panel.shown = PAGE_SIZE;
        panel.expanded.clear();
        forgetRemote();
        if (isFn(callbacks.onToggleStory)) callbacks.onToggleStory(Boolean(box.checked));
      });
      remember(box, "story-toggle");
      label.appendChild(box);
      const others = Number(group.others) || 0;
      label.appendChild(document.createTextNode(" Also check the " +
        (others === 1 ? "other set" : others.toLocaleString() + " other sets") + " for " + str(group.story) +
        (group.more ? " (the first " + (others + 1) + " found)" : "")));
      els.group.appendChild(label);
    }
    if (!group.included) return;
    els.group.appendChild(orderBlock(view));
  }

  function numbersList(numbers) {
    const sorted = numbers.filter(Boolean).sort((a, b) => a - b).map(String);
    if (sorted.length <= 1) return sorted.join("");
    return sorted.slice(0, -1).join(", ") + " and " + sorted[sorted.length - 1];
  }

  /* The sets, numbered, in the order to commit them, with a line saying
   * whether that is the order they were created in. Everything refers to
   * sets by their number in the list: set names run past 60 characters,
   * and repeated in every line they pushed the rows off a live panel. */
  function orderBlock(view) {
    const group = view.group;
    const order = group.order;
    const block = el("div", "order");
    block.setAttribute("role", "group");
    const sets = order ? order.sets : group.sets;
    const ruled = Boolean(order && order.rules);
    /* No order to commit in when none works: the heading must not offer one. */
    const head = el("div", "order-head", ruled && !order.cycle ? "Commit in this order" : "Sets checked together");
    head.id = "snh-usl-order-head";
    block.setAttribute("aria-labelledby", head.id);
    block.appendChild(head);
    const position = new Map(sets.map((set, index) => [set.sysId, index + 1]));
    const moved = Boolean(order && (order.cycle || order.against.length));
    if (order) {
      const soFar = order.soFar ? "So far: " : "";
      const unplaced = Number(order.unplaced) || 0;
      if (order.cycle) {
        const ids = Array.isArray(order.cycleIds) ? order.cycleIds : [];
        block.appendChild(markedLine("div", "order-status warn", "≠",
          soFar + "No order works for sets " + numbersList(ids.map((id) => position.get(id))) +
          ": each holds the newest version of a record " + (ids.length === 2 ? "the other" : "another of them") +
          " also changed. Make them one batch: ServiceNow then commits only the newest version of each record."));
      } else if (order.against.length) {
        const said = order.against.slice(0, 3).map((rule) => "commit " + position.get(rule.thenId) + " after " + position.get(rule.firstId));
        const more = order.against.length - said.length;
        block.appendChild(markedLine("div", "order-status warn", "≠",
          soFar + "Not the order they were created in: " + said.join("; ") + (more ? "; and " + more + " more" : "") + "."));
      } else if (ruled && !unplaced) {
        block.appendChild(markedLine("div", "order-status ok", "✓", soFar + "Commit them in the order they were created."));
      } else if (ruled) {
        block.appendChild(el("div", "order-status", soFar + "Where the order is known, commit them in the order they were created."));
      } else if (!unplaced) {
        block.appendChild(el("div", "order-status",
          soFar + "No record is changed by two of these sets with different content, so the order doesn't matter."));
      }
      /* Never "the order doesn't matter" or a tick while two sets changed a
       * record and which goes last can't be told. Each such row says why;
       * "Show them" filters to them, as a summary badge does. */
      if (unplaced) {
        const line = markedLine("div", "order-status warn", "≠",
          (order.cycle || order.against.length || ruled ? "" : soFar) +
          (unplaced === 1
            ? "1 record was changed differently by two of these sets, and which set should go last for it can't be told here. "
            : plural(unplaced, "record", "records") +
              " were changed differently by two of these sets, and which set should go last for them can't be told here. "));
        line.appendChild(remember(button("link", unplaced === 1 ? "Show it" : "Show them", () => setFilter("unplaced")), "order-unplaced"));
        block.appendChild(line);
      }
      if (sets.some((set) => set.arrived)) {
        block.appendChild(el("div", "order-status",
          "Some of these sets were committed here from another instance, so this is the order they ran in here. " +
          "Read the order on the instance where the work was done."));
      }
    }
    const against = new Set(order ? order.against.map((rule) => rule.firstId + "\u0000" + rule.thenId) : []);
    const list = el("ol", "order-list");
    sets.forEach((set) => {
      const item = el("li");
      item.appendChild(el("span", "o-name", str(set.name) || "Unnamed update set"));
      /* Dates only where the order departs from creation: there they are
       * the evidence; otherwise the numbering already says it. */
      const meta = [set.stateLabel, set.isDefault ? "Default set" : "", moved && set.createdOn ? "created " + set.createdOn : ""]
        .filter(Boolean).join(" · ");
      if (meta) item.appendChild(el("span", "o-meta", meta));
      const after = Array.isArray(set.after) ? set.after : [];
      if (after.length) {
        const late = after.some((rule) => against.has(rule.sysId + "\u0000" + set.sysId));
        const numbers = after.map((rule) => position.get(rule.sysId));
        const held = Number(set.held) || after.reduce((sum, rule) => sum + (Number(rule.records) || 0), 0);
        item.appendChild(el("span", "o-after" + (late ? " warn" : ""),
          "After " + numbersList(numbers) + ": it holds the newer version of " + plural(held, "record", "records") + " " +
          (numbers.length === 1 ? "that set" : "those sets") + " also changed."));
      }
      list.appendChild(item);
    });
    block.appendChild(list);
    return block;
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
    const keys = ["stale", "cant", "same"].concat(checkedAsOne(view) ? ["batch"] : []).concat(["current"]);
    keys.forEach((key) => {
      const word = summaryWord(key, view);
      const badge = button(
        "badge sum-badge b-" + key + (c[key] ? "" : " zero"),
        c[key].toLocaleString() + " " + word,
        () => setFilter(key)
      );
      badge.setAttribute("aria-label", "Show only the " + word + " rows: " + c[key]);
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
      unplaced: rows.filter((row) => row.orderUnknown).length,
    };
    const chips = CHIPS.filter((chip) => !chip.batchOnly || checkedAsOne(view))
      .map((chip) => (chip.id === "batch" && grouped(view) ? Object.assign({}, chip, { label: GROUP_WORDS.say }) : chip));
    /* Sets checked together: the rows whose commit order can't be told,
     * shown only while there are any, like Differs on. */
    if (tally.unplaced) {
      chips.splice(chips.length - 1, 0, { id: "unplaced", label: "Order unknown", className: "there" });
    }
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

  /* A closed row's one-line note where the instance checked differs: its
   * name in bold, then what it runs. */
  function remoteTag(row) {
    const answer = remoteAnswer(row);
    if (!answer) return null;
    const tone = THERE_GREY.has(answer.kind) ? "" : THERE_OK.has(answer.kind) ? " ok" : " warn";
    const parts = remoteParts(row);
    if (!parts || !str(parts.say)) return el("span", "remote-tag" + tone, answer.text);
    const tag = el("span", "remote-tag" + tone);
    tag.appendChild(el("b", null, panel.remote.instance || "There"));
    const notes = Array.isArray(parts.notes) ? parts.notes.map(str).filter(Boolean) : [];
    tag.appendChild(document.createTextNode(" " + lowerFirst(parts.say) + (notes.length ? " (" + notes.join(", ") + ")" : "")));
    return tag;
  }

  function lowerFirst(text) {
    const value = str(text);
    return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
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

  function linkRow(links, row, prefix) {
    const node = el("div", "links");
    links.forEach((link, index) => node.appendChild(remember(linkButton(link, row.key), prefix + row.key + ":" + index)));
    return node;
  }

  /* This instance's card: the verdict, why, the facts behind it, and the
   * row's own links. */
  function hereCard(row) {
    const card = sideCard(VERDICT_TONE[row.verdict] || "grey", panel.here, "this instance");
    const say = el("p", "say");
    if (row.explain != null) {
      say.appendChild(el("span", "v " + (VERDICT_TONE[row.verdict] || "grey"), (sayWord(row.verdict) || row.verdict) + "."));
      say.appendChild(document.createTextNode(" " + str(row.explain)));
    } else {
      say.appendChild(document.createTextNode(str(row.text)));
    }
    if (row.flags && row.flags.length) {
      const flags = el("span", "flags");
      row.flags.forEach((flag) => flags.appendChild(el("span", "flag" + (flag.kind ? " " + flag.kind : ""), flag.label)));
      say.appendChild(flags);
    }
    card.appendChild(say);
    const save = row.newerSave && typeof row.newerSave === "object" ? row.newerSave : null;
    const facts = factList([
      ["Set", row.childSet],
      ["Read from", row.asRetrieved ? "the retrieved copy" : ""],
      [save && save.committedHere ? "Committed here" : "Saved", save ? save.on : "", "time"],
      ["By", save ? save.by : ""],
    ]);
    if (facts) card.appendChild(facts);
    if (row.notes && row.notes.length) card.appendChild(el("div", "notes", row.notes.join(" · ")));
    if (row.who && !save) card.appendChild(el("div", "who", row.who));
    /* Version Lens on this update's record: every set that captured it. */
    const links = (row.links || []).concat(row.name && isFn(callbacks.onOpenVersionLens)
      ? [{ label: "Other sets holding it", versionLens: row.name }] : []);
    if (links.length) card.appendChild(linkRow(links, row, "link:"));
    return card;
  }

  /* The checked instance's card, once a check has finished: what it runs,
   * when and where that was saved, what promoting would do, and its links.
   * None for a row the check didn't compare. */
  function thereCard(row) {
    const parts = remoteParts(row);
    const answer = remoteAnswer(row);
    const links = remoteLinksFor(row);
    if (!parts && !answer && !links.length) return null;
    const kind = parts ? str(parts.kind) : answer ? answer.kind : "runs";
    const tone = thereCardTone(kind);
    const card = sideCard(tone, panel.remote.instance || "", "checked instance");
    const say = el("p", "say");
    if (parts && str(parts.say)) {
      say.appendChild(el("span", "v " + tone, str(parts.say) + "."));
      const notes = Array.isArray(parts.notes) ? parts.notes.map(str).filter(Boolean) : [];
      if (notes.length) say.appendChild(el("span", "aside", " (" + notes.join(", ") + ")"));
    } else {
      say.appendChild(el("span", "v " + tone, answer ? answer.text : "Runs this set's version."));
    }
    card.appendChild(say);
    const saved = parts && parts.saved && typeof parts.saved === "object" ? parts.saved : {};
    const facts = factList([
      ["Saved", saved.on, "time"],
      [saved.set ? "Set" : "From", saved.set || saved.from],
    ]);
    if (facts) card.appendChild(facts);
    if (parts && str(parts.then)) card.appendChild(el("p", "then", str(parts.then) + "."));
    if (links.length) card.appendChild(linkRow(links, row, "remote-link:"));
    return card;
  }

  function thereBadge(answer) {
    const kind = THERE_WORDS[answer.kind] ? answer.kind : "cant";
    const badge = el("span", "badge b-there" + thereTone(kind), thereWord(kind));
    badge.title = str(answer.text);
    return badge;
  }

  /* A row past what the check compared: without a mark it would look like
   * one that matches there. */
  function notCompared(row) {
    const parts = remoteParts(row);
    return Boolean(parts && parts.kind === "unsent");
  }

  function notComparedBadge(row) {
    return thereBadge({ kind: "unsent", text: str(remoteParts(row).then) });
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
    const node = el("div", "row" + (attention ? "" : " click") + (open ? " open" : ""));
    /* The head (the row's line, and a closed row's note) is what opens and
     * folds it. The cards are its sibling: inside a button, their links and
     * labelled facts would be flattened for a screen reader, and selecting a
     * set name to copy it would fold the row. */
    const head = el("div", "row-head");
    const top = el("div", "row-top");
    top.appendChild(el("span", "r-type", row.type || ""));
    const name = el("span", "r-name", row.target || row.name);
    name.title = row.name;
    /* Opened, the set and copy move into this instance's card. */
    const sub = open ? "" : rowSub(row);
    if (sub) name.appendChild(el("span", "r-sub", sub));
    top.appendChild(name);
    top.appendChild(el("span", "r-action", row.action || ""));
    const badges = el("span", "badges");
    badges.appendChild(el("span", "badge b-" + row.verdict, badgeWord(row.verdict) || row.verdict));
    const answer = remoteAnswer(row);
    if (answer) badges.appendChild(thereBadge(answer));
    else if (notCompared(row)) badges.appendChild(notComparedBadge(row));
    top.appendChild(badges);
    head.appendChild(top);
    node.appendChild(head);

    let detailId = "";
    if (open) {
      const detail = el("div", "r-detail open");
      detailId = "snh-usl-detail-" + (panel.detailSeq += 1);
      detail.id = detailId;
      /* The type and action columns hide in a narrow panel; said here then. */
      const meta = [row.type, row.action].map(str).filter(Boolean).join(" · ");
      if (meta) detail.appendChild(el("div", "r-meta", meta));
      const there = thereCard(row);
      const sides = el("div", "sides" + (there ? "" : " single"));
      sides.appendChild(hereCard(row));
      if (there) sides.appendChild(there);
      detail.appendChild(sides);
      /* Shown here; read out once by the panel's live region. */
      if (panel.linkNote && panel.linkNote.key === row.key) detail.appendChild(el("div", "link-note", panel.linkNote.text));
      node.appendChild(detail);
    } else {
      const tag = remoteTag(row);
      if (tag) {
        const note = el("div", "r-detail");
        note.appendChild(tag);
        head.appendChild(note);
      }
    }

    if (!attention) {
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
      } else if (groupOn(view)) {
        els.rows.appendChild(el("div", "empty", "These sets hold no updates."));
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
    setDisabled(els.copyButton, Boolean(view.busy) || !(view.subject || groupOn(view)));
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
    const local = !view.retrieved && (Boolean(view.subject) || groupOn(view));
    paintHeader(view);
    paintBanners(view);
    paintBatch(local ? view : {});
    paintGroup(local ? view : {});
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
    const group = el("div", null);
    section.appendChild(group);

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
    /* One live region for the whole panel, never redrawn: a note created
     * already filled, as a row's is on every paint, is often not read out. */
    const live = el("div", "sr-only");
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    section.appendChild(live);

    overlay.appendChild(section);
    shadow.appendChild(overlay);

    els = {
      overlay, section, subtitle, banners, batch, group, summary, sumMain, sumNewer, progress,
      check, checkRow, select, checkButton, checkHint, checkOut, chips, rows, footer,
      copyButton, continueButton, footerClose, closeButton, live,
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
   * open({ view, origins, here, callbacks, opener })
   *   here: this instance's name, for the heading of its card
   *   callbacks: onToggleBatch(on), onToggleStory(on), onContinue(), onCheckRemote(origin, token),
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
      /* This instance's name, for the heading of its card. */
      here: str(opts.here),
      /* Ids for an opened row's detail, which its head controls. */
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

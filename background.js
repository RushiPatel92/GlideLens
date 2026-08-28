/*
 * background.js — MV3 service worker.
 * Owns token-bearing Table API reads, lazy Code/Record Search injection, and
 * OPEN_URL. Good place to later add: context menus, cross-tab state, alarms.
 *
 * There is no `chrome.commands.onCommand` listener any more: the only
 * registered command is `_execute_action`, which Chrome handles itself.
 * `toggle-field-names` (Alt+Shift+F) was unregistered in 0.10.0 along with its
 * palette command — the toggle itself still lives in content.js behind the
 * TOGGLE_FIELD_NAMES message, so restoring it means re-adding the manifest
 * command and a listener that posts that message.
 */

importScripts("debug_timeline_main.js");

function sendToTab(tabId, msg, options) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, msg, options).catch(() => {});
}

function togglePaletteInTopFrame(tabId) {
  if (!tabId) return;
  sendToTab(tabId, { type: "TOGGLE_PALETTE" }, { frameId: 0 });
  chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => {
      window.postMessage(
        { source: "SN_DEV_HELPER_FRAME_COMMAND", type: "TOGGLE_PALETTE" },
        location.origin
      );
    },
  }).catch(() => {});
}

/* Nothing awaits this, so a hung frame cannot strand a caller here — but an
 * all-frames injection that never settles still leaks a pending promise on
 * every toggle, so it goes through the same per-frame path. */
function postWindowMessageInFrames(tabId, type) {
  if (!tabId) return;
  injectInDiscoveredFrames(
    tabId,
    {
      func: (messageType) => {
        window.postMessage(
          { source: "SN_DEV_HELPER_FRAME_COMMAND", type: messageType },
          location.origin
        );
      },
      args: [type],
    },
    "toggle broadcast"
  ).catch(() => {});
}

function extractSysId() {
  const fromText = (text) => {
    if (!text) return null;
    let value = String(text);
    for (let i = 0; i < 3; i++) {
      const workspaceMatch = value.match(
        /\/now\/(?:[^/?#]+\/)*record\/[^/?#]+\/([0-9a-f]{32})(?:[/?#]|$)/i
      );
      if (workspaceMatch) return workspaceMatch[1];

      const match = value.match(/(?:[?&]sys_?id=|sys_?id=)([0-9a-f]{32})/i);
      if (match) return match[1];
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch (e) {
        break;
      }
    }
    return null;
  };

  try {
    if (typeof g_form !== "undefined" && g_form) {
      const id = g_form.getUniqueValue && g_form.getUniqueValue();
      if (id && /^[0-9a-f]{32}$/i.test(id)) return id;
    }
  } catch (e) {}

  return fromText(location.href);
}

async function tableApiGetInPage(request) {
  const params = new URLSearchParams();
  params.set("sysparm_query", request.query || "");
  if (request.fields) params.set("sysparm_fields", request.fields);
  params.set("sysparm_limit", String(request.limit || 200));
  if (request.options && request.options.displayAll) {
    params.set("sysparm_display_value", "all");
  }
  if (request.options && request.options.excludeRefLinks) {
    params.set("sysparm_exclude_reference_link", "true");
  }

  const url =
    location.origin +
    "/api/now/table/" +
    encodeURIComponent(request.table) +
    "?" +
    params.toString();
  const headers = { Accept: "application/json" };
  try {
    if (typeof g_ck !== "undefined" && g_ck) headers["X-UserToken"] = g_ck;
  } catch (e) {}

  const res = await fetch(url, {
    credentials: "same-origin",
    headers,
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: "HTTP " + res.status + " reading " + request.table,
    };
  }
  const data = await res.json();
  return { ok: true, result: (data && data.result) || [] };
}

/*
 * MAIN-world reader for /api/sn_codesearch/code_search/search.
 *
 * The parameter is `term` — `search_term` and `sysparm_search` return an empty
 * array rather than an error (verified 2026-07-27). Nothing else is sent:
 * `limit`, `sysparm_limit`, `max` and `sysparm_max` were all measured as having
 * no effect on the endpoint's hard 500-hit cap.
 */
async function codeSearchApiGetInPage(request) {
  const params = new URLSearchParams();
  params.set("term", request.term || "");
  if (request.table) params.set("table", request.table);

  const url =
    location.origin +
    "/api/sn_codesearch/code_search/search?" +
    params.toString();
  const headers = { Accept: "application/json" };
  try {
    if (typeof g_ck !== "undefined" && g_ck) headers["X-UserToken"] = g_ck;
  } catch (e) {}

  const res = await fetch(url, { credentials: "same-origin", headers });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: "HTTP " + res.status + " from instance code search",
    };
  }
  const data = await res.json();
  return { ok: true, status: res.status, result: (data && data.result) || [] };
}

/* =====================================================================
 * FRAME DISCOVERY AND TARGETED INJECTION
 *
 * `executeScript({ allFrames: true })` does not merely fail on a frame it
 * cannot inject into — it HANGS, resolving and rejecting never. Measured on a
 * bare `/incident.do` form, which carries two frames ServiceNow creates for
 * itself: `templateIframe` at about:blank, and one with an empty URL. Targeting
 * a known frame id on the same page settles immediately; `allFrames: true` was
 * still pending after 20 seconds.
 *
 * A `.catch()` is therefore not a timeout. Any all-frames caller that answers a
 * content script through `sendResponse` can strand that caller for good, with
 * no error to show — the whole of the "Stop does nothing" Debug Timeline bug,
 * and the same trap sat under every Table API and portal-prefill read.
 *
 * The extension's own content scripts already run in every eligible frame, so
 * they are the frame register. Broadcast a discovery request, collect the
 * `sender.frameId` of each responder, then target those frames one at a time
 * with a per-frame timeout. A helper frame that cannot host a content script is
 * never targeted, and a frame that hangs anyway costs only its own result.
 * ===================================================================== */

const FRAME_DISCOVERY_WAIT_MS = 150;
const FRAME_INJECT_TIMEOUT_MS = 5000;
/* Discovery costs a fixed wait, and a single user action can issue a dozen
 * reads. Cache the frame list briefly so a burst pays that wait once. Kept
 * short because the alternative to noticing a new frame late is a
 * webNavigation permission this manifest does not ask for. */
const FRAME_LIST_TTL_MS = 3000;
const frameDiscoveries = new Map();
const frameListByTab = new Map();
const frameDiscoveryInFlight = new Map();
let frameDiscoverySequence = 0;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(label + " timed out after " + ms + "ms")),
        ms
      );
    }),
  ]);
}

/* Rejects an announcement naming another tab or a non-integer frame id, so a
 * page cannot enrol frames the discovery did not ask about. */
function registerContentFrame(requestId, sender) {
  const discovery = frameDiscoveries.get(requestId);
  if (
    !discovery ||
    !sender ||
    !sender.tab ||
    sender.tab.id !== discovery.tabId ||
    !Number.isInteger(sender.frameId)
  ) {
    return false;
  }
  discovery.frameIds.add(sender.frameId);
  return true;
}

/*
 * tabs.sendMessage without a frameId broadcasts to every content-script frame.
 * Each receiver answers with FRAME_AVAILABLE so the worker collects every
 * sender.frameId, rather than only the single response Chrome picks to return
 * for the broadcast. `purpose` labels the request id for debugging only.
 */
function discoverContentFrames(tabId, purpose) {
  const cached = frameListByTab.get(tabId);
  if (cached && Date.now() - cached.at < FRAME_LIST_TTL_MS) {
    return Promise.resolve(cached.frameIds.slice());
  }
  // Parallel reads on a cold tab would otherwise each broadcast and each pay
  // the discovery wait; they share the first one instead.
  const inFlight = frameDiscoveryInFlight.get(tabId);
  if (inFlight) return inFlight.then((frameIds) => frameIds.slice());
  const discovery = runFrameDiscovery(tabId, purpose);
  frameDiscoveryInFlight.set(tabId, discovery);
  return discovery
    .finally(() => frameDiscoveryInFlight.delete(tabId))
    .then((frameIds) => frameIds.slice());
}

function runFrameDiscovery(tabId, purpose) {
  const requestId =
    (purpose || "frames") +
    ":" +
    tabId +
    ":" +
    Date.now() +
    ":" +
    (++frameDiscoverySequence);
  const discovery = { tabId, frameIds: new Set() };
  frameDiscoveries.set(requestId, discovery);
  return chrome.tabs
    .sendMessage(tabId, { type: "DISCOVER_FRAME", requestId })
    .catch(() => {})
    .then(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, FRAME_DISCOVERY_WAIT_MS);
        })
    )
    .then(() => {
      frameDiscoveries.delete(requestId);
      const frameIds = Array.from(discovery.frameIds).sort((a, b) => a - b);
      // Frame 0 should normally have answered. Keep it as a safe fallback for
      // a page where content-script delivery was briefly unavailable.
      if (!frameIds.length) frameIds.push(0);
      frameListByTab.set(tabId, { frameIds: frameIds.slice(), at: Date.now() });
      return frameIds;
    });
}

function injectInFrame(tabId, frameId, injection, label) {
  return withTimeout(
    chrome.scripting.executeScript(
      Object.assign({ target: { tabId, frameIds: [frameId] } }, injection)
    ),
    FRAME_INJECT_TIMEOUT_MS,
    label + " (frame " + frameId + ")"
  );
}

/*
 * Runs one injection in every discovered frame, independently. A frame that
 * times out, rejects, or returns nothing contributes no results instead of
 * taking the whole operation down with it.
 */
function injectInDiscoveredFrames(tabId, injection, label) {
  return discoverContentFrames(tabId, label).then((frameIds) =>
    Promise.all(
      frameIds.map((frameId) =>
        injectInFrame(tabId, frameId, injection, label).catch(() => [])
      )
    ).then((perFrame) => [].concat.apply([], perFrame))
  );
}

/*
 * The MAIN-world fan-out that replaced `allFrames: true` for the page readers.
 * Returns the per-frame `result` values with empty frames dropped, which is the
 * shape every caller already reduced raw `executeScript` results to.
 */
function readFromPageFrames(tabId, func, args, label) {
  return injectInDiscoveredFrames(
    tabId,
    { world: "MAIN", func, args: args || [] },
    label
  ).then((results) =>
    results.map((item) => item && item.result).filter(Boolean)
  );
}

/* =====================================================================
 * CODE SEARCH TRANSPORT
 *
 * SN_TABLE_GET fans every read out to all frames and keeps whichever answers
 * first. That is fine for the one-off reads it was built for, and wrong for
 * search: a query across a dozen sources would become a dozen requests PER
 * FRAME, several times over on a classic UI page.
 *
 * So code search resolves the token-bearing frame once per tab and sends every
 * request to that frame alone. The MAIN-world function is the same one
 * SN_TABLE_GET uses — the token problem it solves is identical, and there is
 * no reason for two copies of it to drift apart.
 * ===================================================================== */

const codeSearchFrameByTab = new Map();
const searchFrameResolutionByTab = new Map();
const SEARCH_FRAME_PROBE_TIMEOUT_MS = 2000;

function hasUserTokenInPage() {
  try {
    return typeof g_ck !== "undefined" && Boolean(g_ck);
  } catch (e) {
    return false;
  }
}

function probeTokenFrame(tabId, frameId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), SEARCH_FRAME_PROBE_TIMEOUT_MS);
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: hasUserTokenInPage,
    }).then(
      (results) => finish({
        frameId,
        hasToken: results.some((item) => item && item.result),
      }),
      () => finish(null)
    );
  });
}

/* Content scripts announce only concrete eligible frames. Probe those frames
 * individually so an about:blank/helper frame cannot hang token discovery. */
async function discoverTokenFrame(tabId) {
  const frameIds = await discoverContentFrames(tabId, "search");
  const probes = await Promise.all(
    frameIds.map((frameId) => probeTokenFrame(tabId, frameId))
  );
  const withToken = probes.find((item) => item && item.hasToken);
  return withToken ? withToken.frameId : 0;
}

async function resolveTokenFrame(tabId) {
  if (codeSearchFrameByTab.has(tabId)) return codeSearchFrameByTab.get(tabId);
  if (!searchFrameResolutionByTab.has(tabId)) {
    searchFrameResolutionByTab.set(tabId, discoverTokenFrame(tabId));
  }
  try {
    const frameId = await searchFrameResolutionByTab.get(tabId);
    codeSearchFrameByTab.set(tabId, frameId);
    return frameId;
  } finally {
    searchFrameResolutionByTab.delete(tabId);
  }
}

/*
 * Runs one read in the tab's token-bearing frame, with the frame-cache
 * recovery both callers need. `func` is the MAIN-world reader; `what` names the
 * thing being read for error messages only.
 */
async function codeSearchFrameGet(tabId, func, request, what, isRetry) {
  const frameId = await resolveTokenFrame(tabId);
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func,
      args: [request],
    });
  } catch (error) {
    /* The cached frame can go away under navigation. Re-resolve once before
     * treating it as a real failure. */
    codeSearchFrameByTab.delete(tabId);
    if (!isRetry) return codeSearchFrameGet(tabId, func, request, what, true);
    return { ok: false, status: 0, error: String(error) };
  }
  const response = results.map((item) => item && item.result).filter(Boolean)[0];
  if (!response) {
    return { ok: false, status: 0, error: "No response reading " + what };
  }
  /*
   * A cached frame that still exists but has lost its token answers 401 rather
   * than throwing, so the executeScript catch above never sees it. Treat the
   * first 401 as a stale cache and re-resolve — no webNavigation permission
   * needed to notice, which keeps the manifest as small as it is today.
   */
  if (response.status === 401 && !isRetry) {
    codeSearchFrameByTab.delete(tabId);
    return codeSearchFrameGet(tabId, func, request, what, true);
  }
  return response;
}

function codeSearchTableGet(tabId, request) {
  return codeSearchFrameGet(tabId, tableApiGetInPage, request, request.table);
}

/* Record Search has the same bounded, repeated-read shape as Code Search, so
 * it shares the resolved token-bearing frame instead of fanning metadata and
 * result requests out across every ServiceNow frame. */
function recordSearchTableGet(tabId, request) {
  return codeSearchFrameGet(tabId, tableApiGetInPage, request, request.table);
}

/*
 * Tier 1: the instance's own Code Search endpoint. A different URL shape from
 * the Table API, so it gets its own MAIN-world reader — but the same single
 * resolved frame, because the token problem and the fan-out problem are
 * identical.
 *
 * `table` is passed through ONLY when the caller has established the table is
 * configured in a search group. Verified on a real instance 2026-07-29: an
 * unconfigured or nonsense table name is not rejected, it is silently IGNORED,
 * and the endpoint answers with a full unscoped search that is indistinguishable
 * from a scoped one. The engine re-checks the record types that come back.
 */
function codeSearchApiGet(tabId, request) {
  return codeSearchFrameGet(
    tabId,
    codeSearchApiGetInPage,
    request,
    "instance code search"
  );
}

chrome.tabs.onRemoved.addListener((tabId) => {
  codeSearchFrameByTab.delete(tabId);
  searchFrameResolutionByTab.delete(tabId);
  frameListByTab.delete(tabId);
  frameDiscoveryInFlight.delete(tabId);
});

async function fillPortalVariables(variables) {
  const result = {
    foundForm: false,
    filled: 0,
    alreadySet: 0,
    skipped: 0,
    unmatched: 0,
    total: Array.isArray(variables) ? variables.length : 0,
    fillLog: [],
  };
  const values = Array.isArray(variables) ? variables : [];
  let fillAttempt = 0;
  const simpleFillDelayMs = 25;
  const choiceFillDelayMs = 150;
  const referenceFillDelayMs = 400;
  const nativeVerificationDelayMs = 150;
  const nativeVerificationAttempts = 3;
  const retryDelayMs = 250;
  const maxFillPasses = 3;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ---------------------------------------------------------------------
     GLIDEAJAX SETTLE
     Prefill's whole timing problem is that setting a variable can start a
     catalog client script whose GlideAjax response lands later and overwrites
     whatever was written after it. This used to be handled by naming the
     variables known to do that, which could only ever work on the instance the
     names were collected from.

     Watch the requests instead. Count what GlideAjax has in flight, and treat
     "nothing in flight, and nothing started or finished for a moment" as
     settled. A form that fires no GlideAjax leaves lastActivityAt untouched, so
     the wait returns on its first check and costs nothing.

     Two rules this must not break. The patch is reversible and is removed in a
     finally block, because it lives on the page's own GlideAjax prototype. And
     nothing here may take the page down: if GlideAjax is absent or patching
     throws, restoreGlideAjax stays null and every wait degrades to the fixed
     per-type delay that was there before.
     --------------------------------------------------------------------- */
  const ajaxSettleQuietMs = 150;
  const ajaxSettleCeilingMs = 2000;
  const ajaxPollMs = 25;

  let ajaxInFlight = 0;
  let ajaxLastActivityAt = 0;
  let restoreGlideAjax = null;

  const noteAjaxStart = () => {
    ajaxInFlight++;
    ajaxLastActivityAt = Date.now();
  };

  const noteAjaxEnd = () => {
    if (ajaxInFlight > 0) ajaxInFlight--;
    ajaxLastActivityAt = Date.now();
  };

  const installGlideAjaxCounter = () => {
    let prototype;
    try {
      prototype = window.GlideAjax && window.GlideAjax.prototype;
    } catch (e) {
      return null;
    }
    if (!prototype) return null;

    const originals = {};

    /* getXML and getXMLAnswer both take the callback first. On builds where
       getXMLAnswer delegates to getXML the same request is counted twice --
       harmless, because both halves also decrement, so the counter still
       reaches zero. Debug Timeline needs to care about that double-count
       because it records events; this only asks "is anything outstanding". */
    const wrapCallbackMethod = (methodName) => {
      const original = prototype[methodName];
      if (typeof original !== "function") return;
      originals[methodName] = original;
      prototype[methodName] = function (callback) {
        /* No callback means no completion to observe. Counting it would pin
           the counter open until the ceiling and slow every later variable,
           so leave those calls exactly as they were. */
        if (typeof callback !== "function") return original.apply(this, arguments);

        const rest = Array.prototype.slice.call(arguments, 1);
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          noteAjaxEnd();
        };

        noteAjaxStart();
        /* A response that never arrives must not pin the counter forever. */
        const timer = setTimeout(done, ajaxSettleCeilingMs);
        const wrapped = function () {
          clearTimeout(timer);
          done();
          return callback.apply(this, arguments);
        };

        try {
          return original.apply(this, [wrapped].concat(rest));
        } catch (e) {
          clearTimeout(timer);
          done();
          throw e;
        }
      };
    };

    try {
      wrapCallbackMethod("getXML");
      wrapCallbackMethod("getXMLAnswer");

      /* getXMLWait blocks until the response is in, so it has already finished
         by the time it returns. Counted only so the two halves stay symmetric. */
      const originalWait = prototype.getXMLWait;
      if (typeof originalWait === "function") {
        originals.getXMLWait = originalWait;
        prototype.getXMLWait = function () {
          noteAjaxStart();
          try {
            return originalWait.apply(this, arguments);
          } finally {
            noteAjaxEnd();
          }
        };
      }
    } catch (e) {
      /* Fall through and hand back a restore for whatever did get patched. */
    }

    const patched = Object.keys(originals);
    if (!patched.length) return null;

    return () => {
      for (const methodName of patched) {
        try {
          prototype[methodName] = originals[methodName];
        } catch (e) {}
      }
    };
  };

  const waitForAjaxQuiet = async () => {
    if (!restoreGlideAjax) return;
    const deadline = Date.now() + ajaxSettleCeilingMs;
    for (;;) {
      if (!ajaxInFlight && Date.now() - ajaxLastActivityAt >= ajaxSettleQuietMs) return;
      if (Date.now() >= deadline) return;
      await sleep(ajaxPollMs);
    }
  };

  const emitProgress = (message) => {
    try {
      window.postMessage(
        { source: "SN_DEV_HELPER_PREFILL_PROGRESS", message },
        location.origin
      );
    } catch (e) {}
  };

  const unsupportedTypes = new Set([
    "11",
    "14",
    "15",
    "17",
    "19",
    "20",
    "24",
    "25",
    "31",
    "container",
    "container_end",
    "container_start",
    "encrypted",
    "label",
    "macro",
    "password",
    "rich_text_label",
  ]);

  const normalizeVariableType = (type) =>
    String(type || "").trim().toLowerCase().replace(/\s+/g, "_");

  const isEmpty = (value) =>
    value == null ||
    String(value).trim() === "" ||
    (Array.isArray(value) && value.length === 0);

  const isUnsupported = (variable) => {
    const type = normalizeVariableType((variable && variable.type) || "");
    return Boolean(type && unsupportedTypes.has(type));
  };

  const isGForm = (candidate) =>
    candidate &&
    typeof candidate.getValue === "function" &&
    typeof candidate.setValue === "function";

  const currentCatalogItemSysId = () => {
    try {
      const url = new URL(location.href);
      const sysId = url.searchParams.get("sys_id");
      if (sysId && /^[0-9a-f]{32}$/i.test(sysId)) return sysId;
    } catch (e) {}

    try {
      const el = document.querySelector("[cat-item-sys-id],[data-item-sys-id],[data-sys-id]");
      const sysId =
        (el && (el.getAttribute("cat-item-sys-id") || el.getAttribute("data-item-sys-id") || el.getAttribute("data-sys-id"))) ||
        "";
      if (/^[0-9a-f]{32}$/i.test(sysId)) return sysId;
    } catch (e) {}

    return "";
  };

  const gFormSysId = (gForm) => {
    try {
      return typeof gForm.getSysId === "function" ? String(gForm.getSysId() || "") : "";
    } catch (e) {
      return "";
    }
  };

  const scoreGForm = (gForm, scope, el, itemSysId, source) => {
    if (!isGForm(gForm)) return -1;
    let score = 0;
    const sysId = gFormSysId(gForm);
    if (source && source.indexOf("getGlideForm()") >= 0) score += 300;
    if (source === "scope.page.g_form" || source === "scope.page.gForm") score += 250;
    if (source === "scope.g_form" || source === "scope.gForm") score += 150;
    if (itemSysId && sysId === itemSysId) score += 100;
    if (sysId === "-1") score += 80;
    if (!sysId) score += 10;

    try {
      if (scope && scope.c && typeof scope.c.getItemId === "function" && scope.c.getItemId() === itemSysId) {
        score += 100;
      }
    } catch (e) {}
    try {
      if (scope && scope.data && scope.data.sc_cat_item && scope.data.sc_cat_item.sys_id === itemSysId) {
        score += 80;
      }
    } catch (e) {}
    try {
      if (scope && scope.data && scope.data.sys_id === itemSysId) score += 40;
    } catch (e) {}
    try {
      if (el && el.id === "sc_cat_item") score += 150;
    } catch (e) {}
    try {
      if (el && el.matches && el.matches("sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model]")) {
        score += 25;
      }
    } catch (e) {}

    return score;
  };

  const findGFormsInObject = (obj, depth, seen, found) => {
    if (!obj || typeof obj !== "object" || depth > 3) return;
    if (seen.indexOf(obj) >= 0) return null;
    seen.push(obj);
    if (isGForm(obj) && found.indexOf(obj) < 0) found.push(obj);

    const directKeys = ["g_form", "gForm", "page", "c", "data", "$parent"];
    for (const key of directKeys) {
      try {
        findGFormsInObject(obj[key], depth + 1, seen, found);
      } catch (e) {}
    }
  };

  const getAngular = () => {
    try {
      return window.angular || null;
    } catch (e) {
      return null;
    }
  };

  const findPortalGForm = () => {
    const itemSysId = currentCatalogItemSysId();
    const candidates = [];
    const addCandidate = (gForm, scope, el, source) => {
      if (!isGForm(gForm)) return;
      if (candidates.some((candidate) => candidate.gForm === gForm)) return;
      candidates.push({
        gForm,
        score: scoreGForm(gForm, scope, el, itemSysId, source),
        source,
      });
    };
    const addScopeCandidates = (scope, el, sourcePrefix) => {
      if (!scope) return;
      try {
        if (scope.page) {
          addCandidate(scope.page.g_form, scope, el, sourcePrefix + ".page.g_form");
          addCandidate(scope.page.gForm, scope, el, sourcePrefix + ".page.gForm");
        }
      } catch (e) {}
      try {
        addCandidate(scope.g_form, scope, el, sourcePrefix + ".g_form");
        addCandidate(scope.gForm, scope, el, sourcePrefix + ".gForm");
      } catch (e) {}
      try {
        if (typeof scope.getGlideForm === "function") {
          addCandidate(scope.getGlideForm(), scope, el, sourcePrefix + ".getGlideForm()");
        }
      } catch (e) {}
      try {
        if (scope.$parent && typeof scope.$parent.getGlideForm === "function") {
          addCandidate(scope.$parent.getGlideForm(), scope.$parent, el, sourcePrefix + ".$parent.getGlideForm()");
        }
      } catch (e) {}
    };

    try {
      if (typeof g_form !== "undefined") addCandidate(g_form, null, document.body, "global");
    } catch (e) {}

    const angular = getAngular();
    if (!angular || !angular.element) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates.length ? candidates[0].gForm : null;
    }

    const selectors = [
      "#sc_cat_item",
      "#sc_cat_item sp-variable-layout",
      "sp-variable-layout#sc_cat_item\\.do",
      "sp-variable-layout",
      "sp-cat-item",
      "sp-sc-cat-item",
      ".sc-form",
      ".catalog-form",
      "[sp-model]",
      "[ng-controller]",
      "body",
    ];
    const elements = [];
    selectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el) => elements.push(el));
      } catch (e) {}
    });

    for (const el of elements) {
      try {
        const wrapped = angular.element(el);
        const scopes = [];
        if (wrapped.scope) scopes.push(wrapped.scope());
        if (wrapped.isolateScope) scopes.push(wrapped.isolateScope());
        for (let i = 0; i < scopes.length; i++) {
          const scope = scopes[i];
          addScopeCandidates(scope, el, "scope" + i);
          const found = [];
          findGFormsInObject(scope, 0, [], found);
          found.forEach((gForm) => addCandidate(gForm, scope, el, "scope"));
        }
      } catch (e) {}
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].gForm : null;
  };

  const hasPortalFormContainer = () => {
    try {
      return Boolean(
        document.querySelector(
          "#sc_cat_item,sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model]"
        )
      );
    } catch (e) {
      return false;
    }
  };

  const getElementValue = (el) => {
    if (!el) return "";
    if (el.type === "checkbox") return el.checked ? "true" : "";
    if (el.type === "radio") {
      const checked = document.querySelector(
        'input[type="radio"][name="' + el.name.replace(/"/g, '\\"') + '"]:checked'
      );
      return checked ? checked.value : "";
    }
    return el.value != null ? el.value : el.textContent;
  };

  const normalizeComparable = (value) =>
    String(value == null ? "" : value)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  const sameValue = (left, right) => {
    const a = normalizeComparable(left);
    const b = normalizeComparable(right);
    return Boolean(a && b && a === b);
  };

  const isSameFilledValue = (current, value, displayValue) => {
    if (isEmpty(current)) return false;
    return sameValue(current, value) || sameValue(current, displayValue);
  };

  const choiceLabel = (choice) =>
    choice && (choice.display_value || choice.label || choice.text || choice.displayValue || choice.name || "");

  const findChoiceMatch = (choices, value, displayValue) => {
    if (!Array.isArray(choices)) return null;
    return choices.find((choice) => sameValue(choice.value, value)) ||
      choices.find((choice) => sameValue(choiceLabel(choice), displayValue)) ||
      choices.find((choice) => sameValue(choiceLabel(choice), value));
  };

  /* A choice value is matched against the form's OWN choice list and nothing
     else. There used to be an alias table here rewriting one variable's value
     to a different internal choice value, keyed by variable name — a
     tenant-specific rule that would silently pick the WRONG choice on anybody
     else's form of the same name. (Names not repeated: this repo is public.) It
     also carried the only caller that let commitChoiceSuggestion fall back to
     "whatever the first non-empty option is", a guess this should never make.
     Both are gone; a choice that does not match is reported unfilled rather
     than approximated. */

  const isReferenceVariable = (variable) => {
    const type = String((variable && variable.type) || "").trim().toLowerCase();
    return type === "8" || type === "reference";
  };

  const isGlideListVariable = (variable) => {
    const type = normalizeVariableType((variable && variable.type) || "");
    return type === "21" || type === "glide_list" || type === "glide-list" || type === "list_collector";
  };

  const isGlideListField = (field) => {
    const type = normalizeVariableType((field && (field.type || field.display_type || field.fieldType)) || "");
    return type === "glide_list" || type === "glide-list";
  };

  const select2ContainerForElement = (el) => {
    if (!el) return null;
    try {
      if (el.id) {
        const byId = document.getElementById("s2id_" + el.id);
        if (byId) return byId;
      }
    } catch (e) {}
    try {
      return (el.closest && el.closest(".select2-container")) || null;
    } catch (e) {
      return null;
    }
  };

  const isSelect2MultiElement = (el) => {
    const container = select2ContainerForElement(el);
    return Boolean(container && container.classList && container.classList.contains("select2-container-multi"));
  };

  const select2InputForElement = (el) => {
    const container = select2ContainerForElement(el);
    if (!container || !container.querySelector) return el;
    return container.querySelector("input.select2-input") || el;
  };

  const isAttachmentVariable = (variable) => {
    const type = normalizeVariableType((variable && variable.type) || "");
    return type === "33" || type === "attachment";
  };

  const isMultiRowVariableSet = (variable) => {
    const type = normalizeVariableType((variable && variable.type) || "");
    return (
      type === "34" ||
      type === "multi_row" ||
      type === "multi_row_variable_set" ||
      type === "multi-row_variable_set"
    );
  };

  const splitFillBatches = () => ({
    normal: values.filter((variable) => !isMultiRowVariableSet(variable)),
    mrvs: values.filter(isMultiRowVariableSet),
  });

  const logFill = (stage, variable, pass, batchIndex, batchTotal, outcome, details) => {
    fillAttempt++;
    if (result.fillLog.length >= 600) return;
    result.fillLog.push(Object.assign({
      attempt: fillAttempt,
      sourceFillOrder: variable && variable.fillOrder,
      pass,
      batchIndex,
      batchTotal,
      stage,
      outcome,
      name: variable && variable.name,
      label: variable && variable.label,
      type: variable && variable.type,
      isMrvs: Boolean(isMultiRowVariableSet(variable)),
      questionOrder: variable && variable.order,
      orderKnown: Boolean(variable && variable.orderKnown),
      effectiveOrder: variable && variable.effectiveOrder,
      effectiveOrderKnown: Boolean(variable && variable.effectiveOrderKnown),
      variableSetOrder: variable && variable.variableSetOrder,
      variableSetOrderKnown: Boolean(variable && variable.variableSetOrderKnown),
      rowCount: variable && variable.rowCount,
      valueLength: variable && variable.value != null ? String(variable.value).length : 0,
      displayValueLength: variable && variable.displayValue != null ? String(variable.displayValue).length : 0,
    }, details || {}));
  };

  const isChoiceLikeVariable = (variable) => {
    const type = String((variable && variable.type) || "").trim().toLowerCase();
    return ["3", "5", "18", "choice", "multiple_choice", "select_box"].indexOf(type) >= 0;
  };

  /* A variable that drives dependent logic is worth re-poking even when its
     value already matches, so the dependents recalculate. Which variables those
     are is a question about type, not about name: choice, reference and glide
     list variables are what catalog client scripts watch. This used to be a
     list of variable names from one instance's catalog, which told us nothing
     about anybody else's. */
  const drivesDependentLogic = (variable) =>
    isReferenceVariable(variable) ||
    isGlideListVariable(variable) ||
    isChoiceLikeVariable(variable);

  const findAngularFieldScopes = (el, variable) => {
    const angular = getAngular();
    if (!angular || !angular.element) return [];
    const scopes = [];
    const addScope = (scope) => {
      if (!scope || scopes.indexOf(scope) >= 0) return;
      if (scope.field && !fieldMatchesVariable(scope.field, variable)) return;
      scopes.push(scope);
    };

    let node = el;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      try {
        const wrapped = angular.element(node);
        if (wrapped.scope) addScope(wrapped.scope());
        if (wrapped.isolateScope) addScope(wrapped.isolateScope());
      } catch (e) {}
    }
    return scopes;
  };

  const splitListValue = (value) =>
    String(value == null ? "" : value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  const select2ListItems = (value, displayValue) => {
    const values = splitListValue(value);
    const displays = splitListValue(displayValue);
    return values.map((id, index) => ({
      id,
      text: displays[index] || id,
    }));
  };

  const parseMultiRowValue = (value) => {
    try {
      const parsed = JSON.parse(String(value || "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  };

  const updateSelect2Display = (el, value, displayValue) => {
    const label = displayValue || value;
    if (!label) return;

    const candidates = [];
    if (el.id) {
      candidates.push(document.getElementById("s2id_" + el.id));
    }
    try {
      const closest = el.closest && el.closest(".select2-container");
      if (closest) candidates.push(closest);
    } catch (e) {}
    try {
      if (
        el.previousElementSibling &&
        el.previousElementSibling.classList &&
        el.previousElementSibling.classList.contains("select2-container")
      ) {
        candidates.push(el.previousElementSibling);
      }
      if (
        el.nextElementSibling &&
        el.nextElementSibling.classList &&
        el.nextElementSibling.classList.contains("select2-container")
      ) {
        candidates.push(el.nextElementSibling);
      }
    } catch (e) {}
    try {
      if (el.parentElement) {
        Array.from(el.parentElement.children || []).forEach((child) => {
          if (child.classList && child.classList.contains("select2-container")) {
            candidates.push(child);
          }
        });
      }
    } catch (e) {}

    const uniqueCandidates = [];
    candidates.filter(Boolean).forEach((container) => {
      if (uniqueCandidates.indexOf(container) < 0) uniqueCandidates.push(container);
    });

    const belongsToField = (container) => {
      if (!container) return false;
      if (el.id && container.id === "s2id_" + el.id) return true;
      try {
        if (container.contains && container.contains(el)) return true;
      } catch (e) {}
      try {
        const parent = el.parentElement;
        if (parent && container.parentElement === parent) return true;
      } catch (e) {}
      return false;
    };

    for (const container of uniqueCandidates) {
      if (!belongsToField(container)) continue;
      try {
        const choices = container.querySelector && container.querySelector(".select2-choices");
        if (choices) {
          const inputItem = choices.querySelector(".select2-search-field");
          Array.from(choices.querySelectorAll(".select2-search-choice")).forEach((choice) => choice.remove());
          select2ListItems(value, displayValue).forEach((item) => {
            const choice = document.createElement("li");
            choice.className = "select2-search-choice";
            const div = document.createElement("div");
            div.textContent = item.text;
            choice.appendChild(div);
            choices.insertBefore(choice, inputItem || null);
          });
        }
        const chosen = container.querySelector && container.querySelector(".select2-chosen");
        if (chosen) chosen.textContent = label;
        container.classList && container.classList.remove("select2-default");
        container.classList && container.classList.remove("select2-dropdown-open");
        container.setAttribute && container.setAttribute("aria-expanded", "false");
      } catch (e) {}
    }
    try {
      document.querySelectorAll(".select2-drop-active,.select2-drop,.select2-drop-mask").forEach((drop) => {
        drop.style.display = "none";
      });
    } catch (e) {}
  };

  const closeSelect2Dropdown = (el) => {
    const container = select2ContainerForElement(el);
    try {
      if (container && container.classList) {
        container.classList.remove("select2-dropdown-open");
        container.classList.remove("select2-container-active");
        container.setAttribute("aria-expanded", "false");
      }
    } catch (e) {}
    try {
      if (el && typeof el.blur === "function") el.blur();
    } catch (e) {}
    try {
      document.querySelectorAll(".select2-drop-active,.select2-drop,.select2-drop-mask").forEach((drop) => {
        drop.classList && drop.classList.remove("select2-drop-active");
        drop.style.display = "none";
      });
    } catch (e) {}
    try {
      document.body && document.body.click && document.body.click();
    } catch (e) {}
  };

  const findRadioByChoiceScope = (radios, value, displayValue) => {
    const angular = getAngular();
    if (!angular || !angular.element) return null;

    for (const radio of radios) {
      try {
        const wrapped = angular.element(radio);
        const scopes = [];
        if (wrapped.scope) scopes.push(wrapped.scope());
        if (wrapped.isolateScope) scopes.push(wrapped.isolateScope());

        for (const scope of scopes) {
          const choice = scope && (scope.c || scope.choice || scope.option);
          if (choice && findChoiceMatch([choice], value, displayValue)) return radio;
        }
      } catch (e) {}
    }
    return null;
  };

  const findRadioOption = (el, value, displayValue) => {
    const radios = Array.from(
      document.querySelectorAll(
        'input[type="radio"][name="' + el.name.replace(/"/g, '\\"') + '"]'
      )
    );

    return radios.find((radio) => sameValue(radio.value, value)) ||
      radios.find((radio) => sameValue(radio.value, displayValue)) ||
      radios.find((radio) => sameValue(radio.getAttribute("aria-label"), displayValue)) ||
      radios.find((radio) => sameValue(radio.getAttribute("aria-label"), value)) ||
      radios.find((radio) => sameValue(radio.closest("label") && radio.closest("label").textContent, displayValue)) ||
      radios.find((radio) => sameValue(radio.closest("label") && radio.closest("label").textContent, value)) ||
      findRadioByChoiceScope(radios, value, displayValue);
  };

  const selectRadioOption = (option) => {
    if (!option) return false;
    option.checked = true;
    option.setAttribute("aria-checked", "true");
    try {
      option.click();
    } catch (e) {}
    ["input", "change", "blur"].forEach((eventName) => {
      try {
        option.dispatchEvent(new Event(eventName, { bubbles: true }));
      } catch (e) {}
    });
    return true;
  };

  const visibleText = (el) =>
    el && String(el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();

  const clickOption = (option) => {
    if (!option) return false;
    ["mousedown", "mouseup", "click"].forEach((eventName) => {
      try {
        option.dispatchEvent(new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }));
      } catch (e) {}
    });
    try {
      option.click();
    } catch (e) {}
    return true;
  };

  const dispatchKeyboardCommit = (el) => {
    if (!el) return;
    ["ArrowDown", "Enter", "Tab"].forEach((key) => {
      try {
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code: key,
            bubbles: true,
            cancelable: true,
            view: window,
          })
        );
      } catch (e) {}
    });
  };

  const findReferenceSuggestion = (el, value, displayValue) => {
    const selectors = [
      "[role='option']",
      ".select2-result-selectable",
      ".select2-result",
      ".angucomplete-row",
      ".typeahead li",
      ".typeahead-result",
      ".dropdown-menu li",
      "ul[role='listbox'] li",
      "li",
    ];
    const candidates = [];
    const addCandidates = (root) => {
      if (!root || !root.querySelectorAll) return;
      selectors.forEach((selector) => {
        try {
          root.querySelectorAll(selector).forEach((option) => {
            if (option.offsetParent !== null && candidates.indexOf(option) < 0) candidates.push(option);
          });
        } catch (e) {}
      });
    };

    try {
      const owns = el && el.getAttribute && el.getAttribute("aria-owns");
      if (owns) addCandidates(document.getElementById(owns));
    } catch (e) {}
    try {
      document.querySelectorAll(".select2-drop-active,.select2-drop").forEach((drop) => {
        if (drop.offsetParent !== null) addCandidates(drop);
      });
    } catch (e) {}
    if (!candidates.length) addCandidates(document);

    return candidates.find((option) => sameValue(visibleText(option), displayValue)) ||
      candidates.find((option) => sameValue(visibleText(option), value)) ||
      candidates.find((option) => {
        const text = normalizeComparable(visibleText(option));
        const display = normalizeComparable(displayValue);
        const raw = normalizeComparable(value);
        return Boolean(text && ((display && text.indexOf(display) >= 0) || (raw && text.indexOf(raw) >= 0)));
      }) ||
      (/^[0-9a-f]{32}$/i.test(String(value || "")) && sameValue(value, displayValue) ? candidates[0] : null);
  };

  const findChoiceSuggestion = (el, value, displayValue) => {
    const options = [];
    const addOptions = (root) => {
      if (!root || !root.querySelectorAll) return;
      [
        "[role='option']",
        ".select2-result-selectable",
        ".select2-result",
        "ul[role='listbox'] li",
        "li",
      ].forEach((selector) => {
        try {
          root.querySelectorAll(selector).forEach((option) => {
            if (option.offsetParent !== null && options.indexOf(option) < 0) options.push(option);
          });
        } catch (e) {}
      });
    };

    try {
      const owns = el && el.getAttribute && el.getAttribute("aria-owns");
      if (owns) addOptions(document.getElementById(owns));
    } catch (e) {}
    try {
      document.querySelectorAll(".select2-drop-active,.select2-drop").forEach(addOptions);
    } catch (e) {}

    const isNone = (option) => /^--\s*none\s*--$/i.test(visibleText(option));
    const textMatches = (option, target) => {
      const text = normalizeComparable(visibleText(option));
      const normalized = normalizeComparable(target);
      return Boolean(text && normalized && (text === normalized || text.indexOf(normalized) >= 0));
    };

    return options.find((option) => !isNone(option) && textMatches(option, displayValue)) ||
      options.find((option) => !isNone(option) && textMatches(option, value)) ||
      null;
  };

  const commitChoiceSuggestion = async (el, value, displayValue) => {
    const container = select2ContainerForElement(el);
    if (!container) return false;
    try {
      container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      container.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      container.click();
    } catch (e) {}
    await sleep(125);
    const option = findChoiceSuggestion(el, value, displayValue);
    if (!clickOption(option)) {
      closeSelect2Dropdown(el);
      return false;
    }
    const selectedText = visibleText(option);
    await sleep(125);
    closeSelect2Dropdown(el);
    return selectedText || true;
  };

  const commitReferenceSuggestion = async (el, value, displayValue) => {
    if (!displayValue && !value) return false;

    closeSelect2Dropdown(el);
    const container = select2ContainerForElement(el);
    try {
      if (container) {
        container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        container.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        container.click();
        await sleep(125);
      }
    } catch (e) {}

    const query = displayValue || value;
    let input = el;
    try {
      input =
        document.querySelector(".select2-drop-active input.select2-input") ||
        document.querySelector(".select2-drop input.select2-input") ||
        select2InputForElement(el) ||
        el;
    } catch (e) {}

    if (input && "value" in input) {
      input.value = query;
      ["focus", "input", "keyup"].forEach((eventName) => {
        try {
          input.dispatchEvent(new Event(eventName, { bubbles: true }));
        } catch (e) {}
      });
      dispatchKeyboardCommit(input);
    }

    for (let i = 0; i < 8; i++) {
      await sleep(125);
      const option = findReferenceSuggestion(input || el, value, displayValue);
      if (clickOption(option)) {
        await sleep(125);
        closeSelect2Dropdown(el);
        return true;
      }
    }
    closeSelect2Dropdown(el);
    return false;
  };

  const invokeAngularChangeHandlers = (el, variable, value, displayValue) => {
    const angular = getAngular();
    if (!angular || !angular.element) return;

    const scopes = findAngularFieldScopes(el, variable);
    scopes.forEach((scope) => {
      try {
        if (scope.field) {
          scope.field.value = value;
          scope.field.display_value = displayValue;
          scope.field.displayValue = displayValue;
          scope.field.stagedValue = value;
        }
        ["onChange", "change", "fieldChange", "fieldChanged", "onFieldChange"].forEach((name) => {
          try {
            if (typeof scope[name] === "function") scope[name](scope.field, value, displayValue);
          } catch (e) {}
          try {
            if (scope.field && typeof scope.field[name] === "function") {
              scope.field[name](value, displayValue);
            }
          } catch (e) {}
        });
        if (typeof scope.$emit === "function") {
          scope.$emit("field.change", scope.field || variable, value, displayValue);
          scope.$emit("spModel.field.change", scope.field || variable, value, displayValue);
        }
        if (typeof scope.$broadcast === "function") {
          scope.$broadcast("field.change", scope.field || variable, value, displayValue);
        }
        if (typeof scope.$applyAsync === "function") scope.$applyAsync();
      } catch (e) {}
    });
  };

  const variableKeys = (variable) => {
    const keys = [];
    const add = (value) => {
      if (value && keys.indexOf(value) < 0) keys.push(value);
    };
    add(variable && variable.name);
    if (variable && variable.name) add("variables." + variable.name);
    if (variable && variable.questionId) {
      add(variable.questionId);
      add("IO:" + variable.questionId);
      add("ni.IO:" + variable.questionId);
      add("sys_original.IO:" + variable.questionId);
    }
    return keys;
  };

  const fieldMatchesVariable = (field, variable) => {
    if (!field || !variable) return false;
    const keys = variableKeys(variable);
    const names = [
      field.name,
      field.variable_name,
      field.fieldName,
      field.id,
      field.sys_id,
      field.question_id,
      field.questionId,
    ].filter(Boolean);
    if (names.some((name) => keys.indexOf(String(name)) >= 0)) return true;
    if (variable.label) {
      const labels = [
        field.label,
        field.question_text,
        field.questionText,
        field.display_label,
      ].filter(Boolean);
      if (labels.some((label) => sameValue(label, variable.label))) return true;
    }
    return false;
  };

  const findAngularFieldModels = (variable) => {
    const angular = getAngular();
    if (!angular || !angular.element) return [];
    const models = [];
    const seen = [];
    const addModel = (field) => {
      if (!field || typeof field !== "object" || models.indexOf(field) >= 0) return;
      if (fieldMatchesVariable(field, variable)) models.push(field);
    };
    const scan = (obj, depth) => {
      if (!obj || typeof obj !== "object" || depth > 4 || seen.indexOf(obj) >= 0) return;
      seen.push(obj);
      addModel(obj);
      let keys = [];
      try {
        keys = Object.keys(obj).slice(0, 80);
      } catch (e) {}
      keys.forEach((key) => {
        if (/password|token|secret|cookie|session/i.test(key)) return;
        try {
          const value = obj[key];
          if (value && typeof value === "object") scan(value, depth + 1);
        } catch (e) {}
      });
    };

    [
      "#sc_cat_item",
      "#sc_cat_item sp-variable-layout",
      "sp-variable-layout#sc_cat_item\\.do",
      "sp-variable-layout",
      "sp-cat-item",
      "sp-sc-cat-item",
      ".sc-form",
      ".catalog-form",
      "[sp-model]",
      "[ng-controller]",
      "body",
    ].forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el) => {
          const wrapped = angular.element(el);
          if (wrapped.scope) scan(wrapped.scope(), 0);
          if (wrapped.isolateScope) scan(wrapped.isolateScope(), 0);
        });
      } catch (e) {}
    });
    return models;
  };

  const applyValueToField = (field, value, displayValue, isGlideList) => {
    if (!field) return;
    field.value = value;
    field.stagedValue = value;
    field.display_value = displayValue;
    field.displayValue = displayValue;
    if (isGlideList) {
      field.display_value_list = splitListValue(displayValue);
      field.value_list = splitListValue(value);
    } else {
      field.display_value_list = displayValue;
      field.value_list = value;
    }
    field.selectedValue = value;
    field.selectedDisplayValue = displayValue;
  };

  const applyMultiRowValueToField = (field, value, displayValue) => {
    if (!field) return;
    const rows = parseMultiRowValue(value);
    const displayRows = parseMultiRowValue(displayValue);
    field.value = value;
    field.stagedValue = value;
    field.display_value = displayValue;
    field.displayValue = displayValue;
    field.rows = rows;
    field._rows = rows;
    field.data = rows;
    field.displayRows = displayRows;
  };

  const invokeGFormChangeHandlers = (gForm, key, variable, oldValue) => {
    if (!gForm || !key) return;
    const newValue = variable && variable.value != null ? String(variable.value) : "";
    const displayValue = variable && variable.displayValue != null ? String(variable.displayValue) : newValue;

    ["triggerOnChange", "_triggerOnChange", "fieldChanged", "onChange", "notifyChange", "change"].forEach((name) => {
      try {
        if (typeof gForm[name] === "function") gForm[name](key, oldValue || "", newValue, false);
      } catch (e) {}
      try {
        if (typeof gForm[name] === "function") gForm[name](key, newValue, displayValue);
      } catch (e) {}
      try {
        if (typeof gForm[name] === "function") gForm[name](key);
      } catch (e) {}
    });

    try {
      const events = gForm.$private && gForm.$private.events;
      if (events && typeof events.fire === "function") {
        events.fire("change", key, oldValue || "", newValue);
        events.fire("propertyChange", key, oldValue || "", newValue);
      }
    } catch (e) {}
  };

  const setGFormValue = (gForm, key, variable) => {
    if (!gForm || !key || !variable) return false;
    try {
      if (isMultiRowVariableSet(variable)) {
        gForm.setValue(key, variable.value || "[]");
        return true;
      }
      if (variable.displayValue && variable.displayValue !== variable.value) {
        gForm.setValue(key, variable.value, variable.displayValue);
      } else {
        gForm.setValue(key, variable.value);
      }
      return true;
    } catch (e) {
      return false;
    }
  };

  const setElementValue = async (el, variable) => {
    let value = variable.value == null ? "" : String(variable.value);
    let displayValue =
      variable.displayValue == null ? value : String(variable.displayValue);
    let fieldScopes = findAngularFieldScopes(el, variable);
    const isReference = isReferenceVariable(variable);
    const isChoice = isChoiceLikeVariable(variable);
    const isAttachment = isAttachmentVariable(variable);
    const isMultiRow = isMultiRowVariableSet(variable);
    const isGlideList =
      isGlideListVariable(variable) ||
      fieldScopes.some((candidate) => candidate && isGlideListField(candidate.field)) ||
      isSelect2MultiElement(el);

    fieldScopes.forEach((candidate) => {
      if (!candidate.field) return;
      const match = findChoiceMatch(candidate.field.choices, value, displayValue);
      if (match) {
        value = String(match.value);
        displayValue = String(match.display_value || match.label || match.text || displayValue);
      }
    });

    if (el.type === "checkbox") {
      const checked = ["true", "1", "yes", "y", "on"].includes(value.toLowerCase());
      if (el.checked !== checked) {
        try {
          el.click();
        } catch (e) {}
      }
      el.checked = checked;
      el.value = checked ? "true" : "false";
    } else if (el.type === "radio") {
      const option = findRadioOption(el, value, displayValue);
      if (!selectRadioOption(option)) return false;
      if (option !== el) {
        fieldScopes = fieldScopes.concat(
          findAngularFieldScopes(option, variable).filter((scope) => fieldScopes.indexOf(scope) < 0)
        );
        el = option;
      }
    } else if (el.type === "file") {
      /* Browsers block assigning a file input; keep the page model in sync below. */
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else if (el.tagName && el.tagName.toLowerCase() === "select") {
      const options = Array.from(el.options || []);
      const match = options.find((option) => sameValue(option.value, value)) ||
        options.find((option) => sameValue(option.text, displayValue) || sameValue(option.text, value));
      if (match) {
        el.value = match.value;
        value = match.value;
        displayValue = match.text || displayValue;
      } else {
        el.value = value;
      }
    } else if ((isReference || isGlideList) && el.classList && el.classList.contains("select2-focusser")) {
      el.value = "";
    } else if ((isReference || isGlideList) && el.classList && el.classList.contains("select2-input")) {
      el.value = "";
    } else if ((isReference || isGlideList) && el.classList && el.classList.contains("select2-offscreen")) {
      el.value = value;
    } else {
      el.value = isReference && !isGlideList ? displayValue : value;
    }

    try {
      const angular = getAngular();
      if (angular && angular.element) {
        const wrapped = angular.element(el);
        const scope = wrapped.scope && wrapped.scope();
        const isolateScope = wrapped.isolateScope && wrapped.isolateScope();
        fieldScopes.concat([scope, isolateScope]).forEach((candidate) => {
          if (!candidate || !candidate.field) return;
          if (!fieldMatchesVariable(candidate.field, variable)) {
            return;
          }
          if (isMultiRow) applyMultiRowValueToField(candidate.field, value, displayValue);
          else applyValueToField(candidate.field, value, displayValue, isGlideList);
        });

        findAngularFieldModels(variable).forEach((field) => {
          if (isMultiRow) applyMultiRowValueToField(field, value, displayValue);
          else applyValueToField(field, value, displayValue, isGlideList || isGlideListField(field));
        });

        if (scope && Object.prototype.hasOwnProperty.call(scope, "fieldValue")) {
          scope.fieldValue = value;
        }
        if (isolateScope && Object.prototype.hasOwnProperty.call(isolateScope, "fieldValue")) {
          isolateScope.fieldValue = value;
        }

        const ngModel = wrapped.controller("ngModel");
        if (ngModel && typeof ngModel.$setViewValue === "function") {
          ngModel.$setViewValue(value);
          if (typeof ngModel.$render === "function") ngModel.$render();
        }
        if (scope && typeof scope.$applyAsync === "function") scope.$applyAsync();
        if (isolateScope && typeof isolateScope.$applyAsync === "function") {
          isolateScope.$applyAsync();
        }
      }
    } catch (e) {}

    updateSelect2Display(el, value, displayValue);

    if (isChoice && select2ContainerForElement(el)) {
      const selectedChoiceText = await commitChoiceSuggestion(el, value, displayValue);
      if (typeof selectedChoiceText === "string" && selectedChoiceText) displayValue = selectedChoiceText;
      updateSelect2Display(el, value, displayValue);
    }

    if (isReference && !isGlideList) {
      await commitReferenceSuggestion(select2InputForElement(el), value, displayValue);
      updateSelect2Display(el, value, displayValue);
    }
    invokeAngularChangeHandlers(el, variable, value, displayValue);

    try {
      const jq = window.jQuery || window.$;
      if (jq) {
        const wrapped = jq(el);
        if (isGlideList) {
          if (wrapped.data && wrapped.data("select2")) {
            try {
              wrapped.select2("data", select2ListItems(value, displayValue));
            } catch (e) {}
          }
          wrapped.val(value);
          wrapped.trigger("change");
          wrapped.trigger("blur");
        } else if (isReference && wrapped.data && wrapped.data("select2")) {
          try {
            wrapped.select2("close");
          } catch (e) {}
        } else if (isReference) {
          wrapped.trigger("change");
          wrapped.trigger("blur");
        } else if (isAttachment || isMultiRow) {
          wrapped.trigger("change");
          wrapped.trigger("blur");
        } else {
          wrapped.val(el.value || value);
          wrapped.trigger("input");
          wrapped.trigger("change");
        }
      }
    } catch (e) {}

    const events = isReference && !isGlideList ? ["blur"] : ["input", "change", "blur"];
    events.forEach((eventName) => {
      try {
        el.dispatchEvent(new Event(eventName, { bubbles: true }));
      } catch (e) {}
    });

    if (select2ContainerForElement(el)) closeSelect2Dropdown(el);

    return true;
  };

  const findDomField = (variable) => {
    const label = variable && variable.label;
    const keys = variableKeys(variable);
    const attrMatchesVariable = (attr) => {
      if (!attr) return false;
      const variants = [attr];
      if (attr.indexOf("s2id_") === 0) variants.push(attr.replace(/^s2id_/, ""));
      variants.slice().forEach((variant) => {
        if (variant.indexOf("sp_formfield_") === 0) {
          variants.push(variant.replace(/^sp_formfield_/, ""));
        }
      });
      return variants.some((variant) => keys.indexOf(variant) >= 0 || (label && sameValue(variant, label)));
    };
    const labelMatchesText = (el) => {
      if (!label || !el) return false;
      const expected = normalizeComparable(label);
      const actual = normalizeComparable(visibleText(el));
      return Boolean(expected && actual && (actual === expected || actual.indexOf(expected) >= 0));
    };
    const candidates = Array.from(
      document.querySelectorAll("input,textarea,select,[contenteditable='true']")
    ).filter((el) => el.type !== "hidden");

    const direct = candidates.find((el) => {
      const attrs = [
        el.getAttribute("name"),
        el.getAttribute("id"),
        el.getAttribute("data-name"),
        el.getAttribute("data-variable-name"),
        el.getAttribute("data-field"),
        el.getAttribute("data-field-name"),
        el.getAttribute("aria-label"),
      ].filter(Boolean);
      return attrs.some(attrMatchesVariable) ||
        labelMatchesText(el.closest("label"));
    });

    if (direct) return direct;

    const fieldContainers = Array.from(
      document.querySelectorAll(
        "fieldset,.form-group,.question,sp-variable,.select2-container,[id^='sp_formfield_'],[id^='s2id_sp_formfield_'],[data-variable-name],[data-field-name],[data-name]"
      )
    );
    candidates.forEach((candidate) => {
      let node = candidate.parentElement;
      for (let i = 0; node && i < 5; i++, node = node.parentElement) {
        if (fieldContainers.indexOf(node) < 0) fieldContainers.push(node);
      }
    });

    const matchesContainer = (el) => {
      const attrs = [
        el.getAttribute("id"),
        el.getAttribute("name"),
        el.getAttribute("data-name"),
        el.getAttribute("data-variable-name"),
        el.getAttribute("data-field"),
        el.getAttribute("data-field-name"),
        el.getAttribute("aria-label"),
      ].filter(Boolean);

      const matchedByAttr = attrs.some(attrMatchesVariable);
      if (matchedByAttr) return true;
      return labelMatchesText(el);
    };

    const container = fieldContainers.find(matchesContainer);
    if (!container) return null;
    if (container.classList && container.classList.contains("select2-container")) {
      const originalId = container.id && container.id.indexOf("s2id_") === 0
        ? container.id.replace(/^s2id_/, "")
        : "";
      const original = originalId ? document.getElementById(originalId) : null;
      if (original) return original;
      return container.querySelector("input.select2-input,input:not([type='hidden']),textarea,select,[contenteditable='true']");
    }
    if (
      container.matches &&
      container.matches("input:not([type='hidden']),textarea,select,[contenteditable='true']")
    ) {
      return container;
    }
    return container.querySelector("input:not([type='hidden']),textarea,select,[contenteditable='true']");
  };

  const findGFormTarget = (gForm, variable) => {
    if (!gForm || !variable) return null;
    const keys = variableKeys(variable);
    for (const key of keys) {
      let field = null;
      try {
        if (typeof gForm.getField === "function") field = gForm.getField(key);
      } catch (e) {}
      try {
        if (!field && typeof gForm.getGlideUIElement === "function") {
          field = gForm.getGlideUIElement(key);
        }
      } catch (e) {}
      if (field) return { key, field };
    }

    for (const key of keys) {
      try {
        const current = gForm.getValue(key);
        if (current !== undefined && current !== null) return { key, field: null };
      } catch (e) {}
    }
    return null;
  };

  const targetFieldType = (target, variable) =>
    normalizeVariableType(
      (target && target.field &&
        (target.field.type || target.field.display_type || target.field.fieldType)) ||
      (variable && variable.type) ||
      ""
    );

  const isReferenceLikeTarget = (target, variable) => {
    const type = targetFieldType(target, variable);
    return (
      type === "8" ||
      type === "21" ||
      type === "reference" ||
      type === "glide_list" ||
      type === "glide-list" ||
      type === "list_collector"
    );
  };

  const isListTarget = (target, variable) => {
    const type = targetFieldType(target, variable);
    return (
      type === "21" ||
      type === "glide_list" ||
      type === "glide-list" ||
      type === "list_collector"
    );
  };

  const sameStoredRecordValue = (current, expected, isList) => {
    if (!isList) return sameValue(current, expected);
    const currentValues = splitListValue(current).map(normalizeComparable).sort();
    const expectedValues = splitListValue(expected).map(normalizeComparable).sort();
    return (
      currentValues.length === expectedValues.length &&
      currentValues.every((value, index) => value === expectedValues[index])
    );
  };

  const nativeDisplayState = (gForm, target, variable, isList) => {
    const expected = String(
      variable && variable.displayValue != null ? variable.displayValue : ""
    ).trim();
    const rawValue = String(variable && variable.value != null ? variable.value : "").trim();
    if (!expected || sameValue(expected, rawValue)) return "unknown";

    const candidates = [];
    const addCandidate = (value) => {
      const text = String(value == null ? "" : value).trim();
      if (text && candidates.indexOf(text) < 0) candidates.push(text);
    };

    try {
      if (gForm && typeof gForm.getDisplayValue === "function") {
        addCandidate(gForm.getDisplayValue(target.key));
      }
    } catch (e) {}
    if (target.field) {
      addCandidate(target.field.display_value);
      addCandidate(target.field.displayValue);
      addCandidate(target.field.display_value_list);
    }

    const el = findDomField(variable);
    const container = select2ContainerForElement(el);
    try {
      if (container) {
        const chosen = container.querySelector(".select2-chosen");
        if (chosen) addCandidate(visibleText(chosen));
        const choiceLabels = Array.from(
          container.querySelectorAll(".select2-search-choice")
        ).map(visibleText).filter(Boolean);
        if (choiceLabels.length) addCandidate(choiceLabels.join(","));
      }
    } catch (e) {}

    if (!candidates.length) return "unknown";
    if (!isList) {
      return candidates.some((candidate) =>
        sameValue(candidate, expected) ||
        normalizeComparable(candidate).indexOf(normalizeComparable(expected)) >= 0
      ) ? "match" : "mismatch";
    }

    const expectedLabels = splitListValue(expected).map(normalizeComparable);
    const visibleLabels = normalizeComparable(candidates.join(" | "));
    return expectedLabels.every((label) => label && visibleLabels.indexOf(label) >= 0)
      ? "match"
      : "mismatch";
  };

  const setNativeReferenceValue = async (gForm, target, variable) => {
    if (!gForm || !target || !target.key) return false;
    const expected = String(variable && variable.value != null ? variable.value : "");
    const listTarget = isListTarget(target, variable);
    try {
      // Let the portal's own GlideForm/widget pipeline resolve and render
      // reference labels before falling back to direct Select2/DOM handling.
      gForm.setValue(target.key, expected);
    } catch (e) {
      return false;
    }

    for (let attempt = 0; attempt < nativeVerificationAttempts; attempt++) {
      await sleep(nativeVerificationDelayMs);
      let current = "";
      try {
        current = gForm.getValue(target.key);
      } catch (e) {}
      const valueMatches = sameStoredRecordValue(current, expected, listTarget);
      const displayState = nativeDisplayState(gForm, target, variable, listTarget);
      if (valueMatches && displayState !== "mismatch") return true;
    }
    return false;
  };

  const isChoiceTarget = (target, variable) => {
    const type = targetFieldType(target, variable);
    return (
      type === "3" ||
      type === "5" ||
      type === "18" ||
      type === "choice" ||
      type === "multiple_choice" ||
      type === "select_box"
    );
  };

  const isBooleanTarget = (target, variable) => {
    const type = targetFieldType(target, variable);
    return (
      type === "7" ||
      type === "boolean" ||
      type === "checkbox" ||
      type === "checkbox_container"
    );
  };

  const isDateTarget = (target, variable) => {
    const type = targetFieldType(target, variable);
    return type.indexOf("date") >= 0;
  };

  const normalizedBooleanValue = (value) =>
    ["true", "1", "yes", "y", "on"].indexOf(
      String(value == null ? "" : value).trim().toLowerCase()
    ) >= 0
      ? "true"
      : "false";

  const nativeVariableForTarget = (target, variable) => {
    const nativeVariable = Object.assign({}, variable);
    if (isBooleanTarget(target, variable)) {
      nativeVariable.value = normalizedBooleanValue(variable.value);
      nativeVariable.displayValue = nativeVariable.value;
      return nativeVariable;
    }
    if (!isChoiceTarget(target, variable)) return nativeVariable;

    const choices =
      (target && target.field && Array.isArray(target.field.choices)
        ? target.field.choices
        : []);
    const match = findChoiceMatch(choices, variable.value, variable.displayValue);
    if (match) {
      nativeVariable.value = String(match.value);
      nativeVariable.displayValue = String(
        match.display_value ||
        match.label ||
        match.text ||
        variable.displayValue ||
        match.value
      );
    }
    return nativeVariable;
  };

  const nativeBooleanDomState = (variable, expected) => {
    const el = findDomField(variable);
    if (!el || el.type !== "checkbox") return "unknown";
    return el.checked === (normalizedBooleanValue(expected) === "true")
      ? "match"
      : "mismatch";
  };

  const nativeStandardValueMatches = (current, target, variable) => {
    if (isBooleanTarget(target, variable)) {
      if (isEmpty(current)) return false;
      return normalizedBooleanValue(current) === normalizedBooleanValue(variable.value);
    }
    return sameValue(current, variable.value);
  };

  const setNativeStandardValue = async (gForm, target, variable) => {
    if (!gForm || !target || !target.key) return false;
    const verifyDelay = isChoiceTarget(target, variable)
      ? choiceFillDelayMs
      : isBooleanTarget(target, variable)
        ? 100
        : Math.max(simpleFillDelayMs, 50);

    const setAndVerify = async (clearFirst) => {
      try {
        if (clearFirst) {
          gForm.setValue(target.key, "");
          await sleep(simpleFillDelayMs);
        }
        gForm.setValue(target.key, variable.value);
      } catch (e) {
        return false;
      }

      for (let attempt = 0; attempt < nativeVerificationAttempts; attempt++) {
        await sleep(verifyDelay);
        let current = "";
        try {
          current = gForm.getValue(target.key);
        } catch (e) {}
        if (!nativeStandardValueMatches(current, target, variable)) continue;
        if (
          isBooleanTarget(target, variable) &&
          nativeBooleanDomState(variable, variable.value) === "mismatch"
        ) {
          continue;
        }
        return true;
      }
      return false;
    };

    if (await setAndVerify(false)) return true;
    return isDateTarget(target, variable) ? setAndVerify(true) : false;
  };

  const variableNeedsRefill = (gForm, variable) => {
    const expected = String(variable && variable.value != null ? variable.value : "");
    if (!expected) return false;
    const target = findGFormTarget(gForm, variable);
    if (!target) return false;
    let current = "";
    try {
      current = gForm.getValue(target.key);
    } catch (e) {
      return false;
    }
    if (isReferenceLikeTarget(target, variable)) {
      return !sameStoredRecordValue(current, expected, isListTarget(target, variable));
    }
    return isEmpty(current);
  };

  const fillDomVariable = async (variable) => {
    const el = findDomField(variable);
    if (!el) return "missing";
    result.foundForm = true;
    const current = getElementValue(el);
    const value = variable && variable.value != null ? String(variable.value) : "";
    const displayValue = variable && variable.displayValue != null ? String(variable.displayValue) : value;
    if (!isMultiRowVariableSet(variable) && isSameFilledValue(current, value, displayValue)) {
      if (isReferenceVariable(variable) && select2ContainerForElement(el)) {
        if (!(await setElementValue(el, variable))) return "missing";
        return "filled";
      }
      return "already";
    }
    if (!(await setElementValue(el, variable))) return "missing";
    return "filled";
  };

  const triggerDomChangeForVariable = async (variable) => {
    const el = findDomField(variable);
    if (!el) return false;
    result.foundForm = true;
    return Boolean(await setElementValue(el, variable));
  };

  /* The per-type delay is the floor, and it doubles as the window in which an
     onChange handler gets to start its request: a handler that fires a
     GlideAjax a tick after setValue has 150ms (choice) or 400ms (reference) to
     do it before the wait below looks. Plain text variables keep their 25ms
     because they are not what catalog client scripts watch, and widening the
     window for all of them would cost a second across a large form for nothing.
     Past the floor, the wait lasts exactly as long as the instance takes. */
  const delayAfterVariableChange = async (variable) => {
    let delay = simpleFillDelayMs;
    if (isChoiceLikeVariable(variable)) delay = choiceFillDelayMs;
    if (isReferenceVariable(variable) || isGlideListVariable(variable)) delay = referenceFillDelayMs;
    if (delay > 0) await sleep(delay);
    await waitForAjaxQuiet();
  };

  const fillWithDom = async () => {
    result.foundForm = hasPortalFormContainer();
    if (!result.foundForm) return result;

    const fillDomBatch = async (batch, pass) => {
      const missing = [];
      let index = 0;
      for (const variable of batch) {
        index++;
        if (!variable || !variable.name || isUnsupported(variable)) {
          if (pass === 1) result.skipped++;
          logFill("dom", variable, pass, index, batch.length, "skipped", { reason: "unsupported_or_missing_name" });
          continue;
        }
        try {
          const prefix = pass > 1 ? "Retrying" : "Filling";
          emitProgress(prefix + " " + index + " of " + batch.length + ": " + (variable.label || variable.name));
          const domResult = await fillDomVariable(variable);
          logFill("dom", variable, pass, index, batch.length, domResult);
          if (domResult === "filled") {
            result.filled++;
            await delayAfterVariableChange(variable);
          } else if (domResult === "already") {
            result.alreadySet++;
          } else {
            missing.push(variable);
          }
        } catch (e) {
          logFill("dom", variable, pass, index, batch.length, "error", {
            error: String(e && e.message ? e.message : e),
          });
          if (pass === maxFillPasses) result.skipped++;
          else missing.push(variable);
        }
      }
      return missing;
    };

    const batches = splitFillBatches();
    let pending = await fillDomBatch(batches.normal, 1);
    for (let pass = 2; pass <= maxFillPasses && pending.length; pass++) {
      emitProgress("Waiting for dependent fields...");
      await sleep(retryDelayMs);
      pending = await fillDomBatch(pending, pass);
    }
    result.unmatched += pending.length;

    if (batches.mrvs.length) {
      emitProgress("Filling multi-row variable sets...");
      await sleep(retryDelayMs);
      let pendingMrvs = await fillDomBatch(batches.mrvs, 1);
      for (let pass = 2; pass <= maxFillPasses && pendingMrvs.length; pass++) {
        emitProgress("Retrying multi-row variable sets...");
        await sleep(retryDelayMs);
        pendingMrvs = await fillDomBatch(pendingMrvs, pass);
      }
      result.unmatched += pendingMrvs.length;
    }
    return result;
  };

  const fillWithGForm = async (gForm) => {
    result.foundForm = true;

    const fillBatch = async (batch, pass) => {
      const missing = [];
      let index = 0;
      for (const variable of batch) {
        index++;
        if (!variable || !variable.name || isUnsupported(variable)) {
          if (pass === 1) result.skipped++;
          logFill("g_form", variable, pass, index, batch.length, "skipped", { reason: "unsupported_or_missing_name" });
          continue;
        }

        const target = findGFormTarget(gForm, variable);
        const nativeReferenceLike = isReferenceLikeTarget(target, variable);
        if (nativeReferenceLike) {
          const prefix = pass > 1 ? "Retrying" : "Filling";
          emitProgress(prefix + " " + index + " of " + batch.length + ": " + (variable.label || variable.name));
          try {
            let current = "";
            try {
              current = target ? gForm.getValue(target.key) : "";
            } catch (e) {}
            const listTarget = isListTarget(target, variable);
            const alreadyStored =
              target &&
              sameStoredRecordValue(current, variable.value, listTarget);
            const displayState = target
              ? nativeDisplayState(gForm, target, variable, listTarget)
              : "unknown";

            if (alreadyStored && displayState !== "mismatch") {
              logFill("native-g_form", variable, pass, index, batch.length, "already", {
                key: target.key,
                displayState,
              });
              result.alreadySet++;
              continue;
            }

            if (await setNativeReferenceValue(gForm, target, variable)) {
              logFill("native-g_form", variable, pass, index, batch.length, "filled", {
                key: target && target.key,
                displayState: target
                  ? nativeDisplayState(gForm, target, variable, listTarget)
                  : "unknown",
                overwriteExisting: !isEmpty(current),
              });
              result.filled++;
              await delayAfterVariableChange(variable);
              continue;
            }

            logFill("native-g_form", variable, pass, index, batch.length, "fallback", {
              key: target && target.key,
              reason: target ? "native_value_or_display_not_settled" : "target_field_not_found",
            });
            const domResult = await fillDomVariable(variable);
            logFill("dom-fallback", variable, pass, index, batch.length, domResult, {
              reason: "native_reference_fallback",
            });
            if (domResult === "filled" || domResult === "already") {
              if (domResult === "filled") {
                result.filled++;
                await delayAfterVariableChange(variable);
              } else {
                result.alreadySet++;
              }
            } else {
              missing.push(variable);
            }
          } catch (e) {
            logFill("native-g_form", variable, pass, index, batch.length, "error", {
              error: String(e && e.message ? e.message : e),
            });
            if (pass === maxFillPasses) result.skipped++;
            else missing.push(variable);
          }
          continue;
        }

        const isComplexVariable =
          isAttachmentVariable(variable) || isMultiRowVariableSet(variable);
        if (!isComplexVariable) {
          const prefix = pass > 1 ? "Retrying" : "Filling";
          emitProgress(prefix + " " + index + " of " + batch.length + ": " + (variable.label || variable.name));
          const nativeVariable = nativeVariableForTarget(target, variable);
          try {
            let current = "";
            try {
              current = target ? gForm.getValue(target.key) : "";
            } catch (e) {}
            const alreadyStored =
              target &&
              nativeStandardValueMatches(current, target, nativeVariable);
            const booleanDomState = isBooleanTarget(target, nativeVariable)
              ? nativeBooleanDomState(variable, nativeVariable.value)
              : "unknown";

            if (alreadyStored && booleanDomState !== "mismatch") {
              logFill("native-g_form", variable, pass, index, batch.length, "already", {
                key: target.key,
                targetType: targetFieldType(target, nativeVariable),
                resolvedValue: nativeVariable.value,
                booleanDomState,
              });
              result.alreadySet++;
              continue;
            }

            if (await setNativeStandardValue(gForm, target, nativeVariable)) {
              logFill("native-g_form", variable, pass, index, batch.length, "filled", {
                key: target && target.key,
                targetType: targetFieldType(target, nativeVariable),
                resolvedValue: nativeVariable.value,
                overwriteExisting: !isEmpty(current),
              });
              result.filled++;
              await delayAfterVariableChange(variable);
              continue;
            }

            logFill("native-g_form", variable, pass, index, batch.length, "fallback", {
              key: target && target.key,
              targetType: targetFieldType(target, nativeVariable),
              reason: target ? "native_value_or_widget_not_settled" : "target_field_not_found",
            });
            const domResult = await fillDomVariable(nativeVariable);
            logFill("dom-fallback", variable, pass, index, batch.length, domResult, {
              reason: "native_standard_fallback",
              resolvedValue: nativeVariable.value,
            });
            if (domResult === "filled") {
              result.filled++;
              await delayAfterVariableChange(variable);
            } else if (domResult === "already") {
              result.alreadySet++;
            } else {
              missing.push(variable);
            }
          } catch (e) {
            logFill("native-g_form", variable, pass, index, batch.length, "error", {
              error: String(e && e.message ? e.message : e),
            });
            if (pass === maxFillPasses) result.skipped++;
            else missing.push(variable);
          }
          continue;
        }

        let handled = false;
        for (const key of variableKeys(variable)) {
          try {
            const prefix = pass > 1 ? "Retrying" : "Filling";
            emitProgress(prefix + " " + index + " of " + batch.length + ": " + (variable.label || variable.name));
            const current = gForm.getValue(key);
            if (!isMultiRowVariableSet(variable) && isSameFilledValue(current, variable.value, variable.displayValue)) {
              if (drivesDependentLogic(variable)) {
                await triggerDomChangeForVariable(variable);
                setGFormValue(gForm, key, variable);
                invokeGFormChangeHandlers(gForm, key, variable, current);
                await delayAfterVariableChange(variable);
              }
              logFill("g_form", variable, pass, index, batch.length, "already", {
                key,
                currentLength: current != null ? String(current).length : 0,
              });
              result.alreadySet++;
              handled = true;
              break;
            }
            if (!setGFormValue(gForm, key, variable)) continue;
            await triggerDomChangeForVariable(variable);
            setGFormValue(gForm, key, variable);
            invokeGFormChangeHandlers(gForm, key, variable, current);
            logFill("g_form", variable, pass, index, batch.length, "filled", {
              key,
              currentLength: current != null ? String(current).length : 0,
              overwriteExisting: !isEmpty(current),
            });
            result.filled++;
            handled = true;
            await delayAfterVariableChange(variable);
            break;
          } catch (e) {}
        }

        if (handled) continue;
        try {
          const prefix = pass > 1 ? "Retrying" : "Filling";
          emitProgress(prefix + " " + index + " of " + batch.length + ": " + (variable.label || variable.name));
          const domResult = await fillDomVariable(variable);
          logFill("dom-fallback", variable, pass, index, batch.length, domResult);
          if (domResult === "filled") {
            result.filled++;
            await delayAfterVariableChange(variable);
          } else if (domResult === "already") {
            result.alreadySet++;
          } else {
            missing.push(variable);
          }
        } catch (e) {
          logFill("dom-fallback", variable, pass, index, batch.length, "error", {
            error: String(e && e.message ? e.message : e),
          });
          if (pass === maxFillPasses) result.skipped++;
          else missing.push(variable);
        }
      }
      return missing;
    };

    const mergeVariables = (...groups) => {
      const merged = [];
      groups.forEach((group) => {
        (group || []).forEach((variable) => {
          if (variable && merged.indexOf(variable) < 0) merged.push(variable);
        });
      });
      return merged.sort((a, b) => {
        const orderA = Number.isFinite(a && a.fillOrder) ? a.fillOrder : 999999;
        const orderB = Number.isFinite(b && b.fillOrder) ? b.fillOrder : 999999;
        return orderA - orderB;
      });
    };

    const batches = splitFillBatches();
    let pending = await fillBatch(batches.normal, 1);

    pending = mergeVariables(
      pending,
      batches.normal.filter((variable) => variableNeedsRefill(gForm, variable))
    );
    for (let pass = 2; pass <= maxFillPasses && pending.length; pass++) {
      emitProgress("Re-validating fields changed by onChange scripts...");
      await sleep(retryDelayMs);
      const retryFailures = await fillBatch(pending, pass);
      pending = mergeVariables(
        retryFailures,
        batches.normal.filter((variable) => variableNeedsRefill(gForm, variable))
      );
    }
    result.unmatched += pending.length;

    if (batches.mrvs.length) {
      emitProgress("Filling multi-row variable sets...");
      await sleep(retryDelayMs);
      let pendingMrvs = await fillBatch(batches.mrvs, 1);
      for (let pass = 2; pass <= maxFillPasses && pendingMrvs.length; pass++) {
        emitProgress("Retrying multi-row variable sets...");
        await sleep(retryDelayMs);
        pendingMrvs = await fillBatch(pendingMrvs, pass);
      }
      result.unmatched += pendingMrvs.length;
    }
    return result;
  };

  const gForm = findPortalGForm();
  restoreGlideAjax = installGlideAjaxCounter();
  try {
    return gForm ? await fillWithGForm(gForm) : await fillWithDom();
  } finally {
    /* The patch is on the page's own GlideAjax prototype, so it comes off
       however this exits. Leaving it installed would mean every later
       GlideAjax on the page ran through a counter nobody reads. */
    const restore = restoreGlideAjax;
    restoreGlideAjax = null;
    if (restore) {
      try {
        restore();
      } catch (e) {}
    }
  }
}

function inspectPortalVariableDebug() {
  const report = {
    href: location.href,
    title: document.title,
    hasAngular: false,
    hasGlobalGForm: false,
    portalContainers: 0,
    gForm: null,
    gFormCandidates: [],
    angularFields: [],
    domFields: [],
  };

  const safeValue = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return value.slice(0, 120);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return Object.prototype.toString.call(value);
  };

  const addUnique = (list, item, key) => {
    if (!item || !item[key]) return;
    if (!list.some((existing) => existing[key] === item[key])) list.push(item);
  };

  try {
    report.portalContainers = document.querySelectorAll(
      "#sc_cat_item,sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model]"
    ).length;
  } catch (e) {}

  try {
    report.hasGlobalGForm =
      typeof g_form !== "undefined" &&
      g_form &&
      typeof g_form.getValue === "function" &&
      typeof g_form.setValue === "function";
  } catch (e) {}

  const summarizeGForm = (gForm, source) => {
    if (!gForm) return;
    if (report.gFormCandidates.some((candidate) => candidate.source === source)) return;
    const summary = { source, keys: [], fieldNames: [] };
    try {
      summary.sysId = typeof gForm.getSysId === "function" ? safeValue(gForm.getSysId()) : "";
    } catch (e) {}
    try {
      summary.keys = Object.keys(gForm).slice(0, 80);
    } catch (e) {}
    const fieldContainers = [
      "_fields",
      "fields",
      "fieldMap",
      "nameMap",
      "catalogFields",
      "variables",
    ];
    fieldContainers.forEach((key) => {
      try {
        const value = gForm[key];
        if (value && typeof value === "object") {
          Object.keys(value).slice(0, 120).forEach((name) => {
            if (summary.fieldNames.indexOf(name) < 0) summary.fieldNames.push(name);
          });
        }
      } catch (e) {}
    });
    report.gFormCandidates.push(summary);
    if (!report.gForm) report.gForm = summary;
  };

  const summarizeScopeGForms = (scope, source) => {
    if (!scope) return;
    try {
      if (scope.page) {
        summarizeGForm(scope.page.g_form, source + ".page.g_form");
        summarizeGForm(scope.page.gForm, source + ".page.gForm");
      }
    } catch (e) {}
    try {
      summarizeGForm(scope.g_form, source + ".g_form");
      summarizeGForm(scope.gForm, source + ".gForm");
    } catch (e) {}
    try {
      if (typeof scope.getGlideForm === "function") {
        summarizeGForm(scope.getGlideForm(), source + ".getGlideForm()");
      }
    } catch (e) {}
    try {
      if (scope.$parent && typeof scope.$parent.getGlideForm === "function") {
        summarizeGForm(scope.$parent.getGlideForm(), source + ".$parent.getGlideForm()");
      }
    } catch (e) {}
  };

  try {
    if (report.hasGlobalGForm) summarizeGForm(g_form, "global");
  } catch (e) {}

  const angular = (() => {
    try {
      return window.angular || null;
    } catch (e) {
      return null;
    }
  })();
  report.hasAngular = Boolean(angular && angular.element);

  const scanObjectForFields = (obj, path, depth, seen) => {
    if (!obj || typeof obj !== "object" || depth > 4 || seen.indexOf(obj) >= 0) return;
    seen.push(obj);

    try {
      if (
        typeof obj.getValue === "function" &&
        typeof obj.setValue === "function"
      ) {
        summarizeGForm(obj, path);
      }
    } catch (e) {}

    try {
      const maybeName = obj.name || obj.variable_name || obj.fieldName || obj.id;
      const maybeLabel =
        obj.label || obj.question_text || obj.questionText || obj.displayValue || obj.display_value;
      if (maybeName) {
        addUnique(
          report.angularFields,
          {
            path,
            name: safeValue(maybeName),
            label: safeValue(maybeLabel),
            type: safeValue(obj.type || obj.display_type || obj.fieldType),
            value: safeValue(obj.value),
          },
          "name"
        );
      }
    } catch (e) {}

    let keys = [];
    try {
      keys = Object.keys(obj).slice(0, 80);
    } catch (e) {}
    keys.forEach((key) => {
      if (/password|token|secret|cookie|session/i.test(key)) return;
      try {
        const value = obj[key];
        if (value && typeof value === "object") {
          scanObjectForFields(value, path + "." + key, depth + 1, seen);
        }
      } catch (e) {}
    });
  };

  if (angular && angular.element) {
    const elements = [];
    [
      "#sc_cat_item",
      "#sc_cat_item sp-variable-layout",
      "sp-variable-layout#sc_cat_item\\.do",
      "sp-variable-layout",
      "sp-cat-item",
      "sp-sc-cat-item",
      ".sc-form",
      ".catalog-form",
      "[sp-model]",
      "[ng-controller]",
      "body",
    ].forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el) => elements.push(el));
      } catch (e) {}
    });

    elements.slice(0, 80).forEach((el, index) => {
      try {
        const wrapped = angular.element(el);
        if (wrapped.scope) {
          const scope = wrapped.scope();
          summarizeScopeGForms(scope, "scope[" + index + "]");
          scanObjectForFields(scope, "scope[" + index + "]", 0, []);
        }
        if (wrapped.isolateScope) {
          const isolateScope = wrapped.isolateScope();
          summarizeScopeGForms(isolateScope, "isolateScope[" + index + "]");
          scanObjectForFields(isolateScope, "isolateScope[" + index + "]", 0, []);
        }
      } catch (e) {}
    });
  }

  try {
    Array.from(document.querySelectorAll("input,textarea,select,[contenteditable='true']"))
      .filter((el) => el.type !== "hidden")
      .slice(0, 160)
      .forEach((el) => {
        report.domFields.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || "",
          name: el.getAttribute("name") || "",
          id: el.getAttribute("id") || "",
          dataName: el.getAttribute("data-name") || "",
          dataVariableName: el.getAttribute("data-variable-name") || "",
          dataField: el.getAttribute("data-field") || "",
          dataFieldName: el.getAttribute("data-field-name") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          ngModel: el.getAttribute("ng-model") || "",
          classes: String(el.className || "").slice(0, 120),
          valueLength: el.value ? String(el.value).length : 0,
        });
      });
  } catch (e) {}

  return report;
}

// Self-contained MAIN-world inspector for hidden/switched-off catalog
// variables. Duplicates helpers from fillPortalVariables/inspectPortalVariableDebug
// rather than sharing them, since executeScript({func}) only serializes the
// one function passed to it. Never touches DOM/gForm for secret variables so
// their values can't cross the runtime.sendMessage boundary.
function inspectHiddenPortalVariables(variables) {
  const list = Array.isArray(variables) ? variables : [];
  const result = { foundForm: false, matchedCount: 0, results: [] };

  const isGForm = (candidate) =>
    candidate &&
    typeof candidate.getValue === "function" &&
    typeof candidate.setValue === "function";

  const currentCatalogItemSysId = () => {
    try {
      const url = new URL(location.href);
      const sysId = url.searchParams.get("sys_id");
      if (sysId && /^[0-9a-f]{32}$/i.test(sysId)) return sysId;
    } catch (e) {}

    try {
      const el = document.querySelector("[cat-item-sys-id],[data-item-sys-id],[data-sys-id]");
      const sysId =
        (el && (el.getAttribute("cat-item-sys-id") || el.getAttribute("data-item-sys-id") || el.getAttribute("data-sys-id"))) ||
        "";
      if (/^[0-9a-f]{32}$/i.test(sysId)) return sysId;
    } catch (e) {}

    return "";
  };

  const gFormSysId = (gForm) => {
    try {
      return typeof gForm.getSysId === "function" ? String(gForm.getSysId() || "") : "";
    } catch (e) {
      return "";
    }
  };

  const scoreGForm = (gForm, scope, el, itemSysId, source) => {
    if (!isGForm(gForm)) return -1;
    let score = 0;
    const sysId = gFormSysId(gForm);
    if (source && source.indexOf("getGlideForm()") >= 0) score += 300;
    if (source === "scope.page.g_form" || source === "scope.page.gForm") score += 250;
    if (source === "scope.g_form" || source === "scope.gForm") score += 150;
    if (itemSysId && sysId === itemSysId) score += 100;
    if (sysId === "-1") score += 80;
    if (!sysId) score += 10;

    try {
      if (scope && scope.c && typeof scope.c.getItemId === "function" && scope.c.getItemId() === itemSysId) {
        score += 100;
      }
    } catch (e) {}
    try {
      if (scope && scope.data && scope.data.sc_cat_item && scope.data.sc_cat_item.sys_id === itemSysId) {
        score += 80;
      }
    } catch (e) {}
    try {
      if (scope && scope.data && scope.data.sys_id === itemSysId) score += 40;
    } catch (e) {}
    try {
      if (el && el.id === "sc_cat_item") score += 150;
    } catch (e) {}
    try {
      if (el && el.matches && el.matches("sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model]")) {
        score += 25;
      }
    } catch (e) {}

    return score;
  };

  const findGFormsInObject = (obj, depth, seen, found) => {
    if (!obj || typeof obj !== "object" || depth > 3) return;
    if (seen.indexOf(obj) >= 0) return null;
    seen.push(obj);
    if (isGForm(obj) && found.indexOf(obj) < 0) found.push(obj);

    const directKeys = ["g_form", "gForm", "page", "c", "data", "$parent"];
    for (const key of directKeys) {
      try {
        findGFormsInObject(obj[key], depth + 1, seen, found);
      } catch (e) {}
    }
  };

  const getAngular = () => {
    try {
      return window.angular || null;
    } catch (e) {
      return null;
    }
  };

  const findPortalGForm = () => {
    const itemSysId = currentCatalogItemSysId();
    const candidates = [];
    const addCandidate = (gForm, scope, el, source) => {
      if (!isGForm(gForm)) return;
      if (candidates.some((candidate) => candidate.gForm === gForm)) return;
      candidates.push({
        gForm,
        score: scoreGForm(gForm, scope, el, itemSysId, source),
        source,
      });
    };
    const addScopeCandidates = (scope, el, sourcePrefix) => {
      if (!scope) return;
      try {
        if (scope.page) {
          addCandidate(scope.page.g_form, scope, el, sourcePrefix + ".page.g_form");
          addCandidate(scope.page.gForm, scope, el, sourcePrefix + ".page.gForm");
        }
      } catch (e) {}
      try {
        addCandidate(scope.g_form, scope, el, sourcePrefix + ".g_form");
        addCandidate(scope.gForm, scope, el, sourcePrefix + ".gForm");
      } catch (e) {}
      try {
        if (typeof scope.getGlideForm === "function") {
          addCandidate(scope.getGlideForm(), scope, el, sourcePrefix + ".getGlideForm()");
        }
      } catch (e) {}
      try {
        if (scope.$parent && typeof scope.$parent.getGlideForm === "function") {
          addCandidate(scope.$parent.getGlideForm(), scope.$parent, el, sourcePrefix + ".$parent.getGlideForm()");
        }
      } catch (e) {}
    };

    try {
      if (typeof g_form !== "undefined") addCandidate(g_form, null, document.body, "global");
    } catch (e) {}

    const angular = getAngular();
    if (!angular || !angular.element) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates.length ? candidates[0].gForm : null;
    }

    const selectors = [
      "#sc_cat_item",
      "#sc_cat_item sp-variable-layout",
      "sp-variable-layout#sc_cat_item\\.do",
      "sp-variable-layout",
      "sp-cat-item",
      "sp-sc-cat-item",
      ".sc-form",
      ".catalog-form",
      "[sp-model]",
      "[ng-controller]",
      "body",
    ];
    const elements = [];
    selectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el) => elements.push(el));
      } catch (e) {}
    });

    for (const el of elements) {
      try {
        const wrapped = angular.element(el);
        const scopes = [];
        if (wrapped.scope) scopes.push(wrapped.scope());
        if (wrapped.isolateScope) scopes.push(wrapped.isolateScope());
        for (let i = 0; i < scopes.length; i++) {
          const scope = scopes[i];
          addScopeCandidates(scope, el, "scope" + i);
          const found = [];
          findGFormsInObject(scope, 0, [], found);
          found.forEach((gForm) => addCandidate(gForm, scope, el, "scope"));
        }
      } catch (e) {}
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].gForm : null;
  };

  const hasPortalFormContainer = () => {
    try {
      return Boolean(
        document.querySelector(
          "#sc_cat_item,sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model]"
        )
      );
    } catch (e) {
      return false;
    }
  };

  const getElementValue = (el) => {
    if (!el) return "";
    if (el.type === "checkbox") return el.checked ? "true" : "";
    if (el.type === "radio") {
      const checked = document.querySelector(
        'input[type="radio"][name="' + el.name.replace(/"/g, '\\"') + '"]:checked'
      );
      return checked ? checked.value : "";
    }
    return el.value != null ? el.value : el.textContent;
  };

  const normalizeComparable = (value) =>
    String(value == null ? "" : value)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  const sameValue = (left, right) => {
    const a = normalizeComparable(left);
    const b = normalizeComparable(right);
    return Boolean(a && b && a === b);
  };

  const visibleText = (el) =>
    el && String(el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();

  const variableKeys = (variable) => {
    const keys = [];
    const add = (value) => {
      if (value && keys.indexOf(value) < 0) keys.push(value);
    };
    add(variable && variable.name);
    if (variable && variable.name) add("variables." + variable.name);
    if (variable && variable.questionId) {
      add(variable.questionId);
      add("IO:" + variable.questionId);
      add("ni.IO:" + variable.questionId);
      add("sys_original.IO:" + variable.questionId);
    }
    return keys;
  };

  const findDomField = (variable) => {
    const label = variable && variable.label;
    const keys = variableKeys(variable);
    const attrMatchesVariable = (attr) => {
      if (!attr) return false;
      const variants = [attr];
      if (attr.indexOf("s2id_") === 0) variants.push(attr.replace(/^s2id_/, ""));
      variants.slice().forEach((variant) => {
        if (variant.indexOf("sp_formfield_") === 0) {
          variants.push(variant.replace(/^sp_formfield_/, ""));
        }
      });
      return variants.some((variant) => keys.indexOf(variant) >= 0 || (label && sameValue(variant, label)));
    };
    const labelMatchesText = (el) => {
      if (!label || !el) return false;
      const expected = normalizeComparable(label);
      const actual = normalizeComparable(visibleText(el));
      return Boolean(expected && actual && (actual === expected || actual.indexOf(expected) >= 0));
    };
    const candidates = Array.from(
      document.querySelectorAll("input,textarea,select,[contenteditable='true']")
    ).filter((el) => el.type !== "hidden");

    const direct = candidates.find((el) => {
      const attrs = [
        el.getAttribute("name"),
        el.getAttribute("id"),
        el.getAttribute("data-name"),
        el.getAttribute("data-variable-name"),
        el.getAttribute("data-field"),
        el.getAttribute("data-field-name"),
        el.getAttribute("aria-label"),
      ].filter(Boolean);
      return attrs.some(attrMatchesVariable) ||
        labelMatchesText(el.closest("label"));
    });

    if (direct) return direct;

    const fieldContainers = Array.from(
      document.querySelectorAll(
        "fieldset,.form-group,.question,sp-variable,.select2-container,[id^='sp_formfield_'],[id^='s2id_sp_formfield_'],[data-variable-name],[data-field-name],[data-name]"
      )
    );
    candidates.forEach((candidate) => {
      let node = candidate.parentElement;
      for (let i = 0; node && i < 5; i++, node = node.parentElement) {
        if (fieldContainers.indexOf(node) < 0) fieldContainers.push(node);
      }
    });

    const matchesContainer = (el) => {
      const attrs = [
        el.getAttribute("id"),
        el.getAttribute("name"),
        el.getAttribute("data-name"),
        el.getAttribute("data-variable-name"),
        el.getAttribute("data-field"),
        el.getAttribute("data-field-name"),
        el.getAttribute("aria-label"),
      ].filter(Boolean);

      const matchedByAttr = attrs.some(attrMatchesVariable);
      if (matchedByAttr) return true;
      return labelMatchesText(el);
    };

    const container = fieldContainers.find(matchesContainer);
    if (!container) return null;
    if (container.classList && container.classList.contains("select2-container")) {
      const originalId = container.id && container.id.indexOf("s2id_") === 0
        ? container.id.replace(/^s2id_/, "")
        : "";
      const original = originalId ? document.getElementById(originalId) : null;
      if (original) return original;
      return container.querySelector("input.select2-input,input:not([type='hidden']),textarea,select,[contenteditable='true']");
    }
    if (
      container.matches &&
      container.matches("input:not([type='hidden']),textarea,select,[contenteditable='true']")
    ) {
      return container;
    }
    return container.querySelector("input:not([type='hidden']),textarea,select,[contenteditable='true']");
  };

  const findGFormTarget = (gForm, variable) => {
    if (!gForm || !variable) return null;
    const keys = variableKeys(variable);
    for (const key of keys) {
      let field = null;
      try {
        if (typeof gForm.getField === "function") field = gForm.getField(key);
      } catch (e) {}
      try {
        if (!field && typeof gForm.getGlideUIElement === "function") {
          field = gForm.getGlideUIElement(key);
        }
      } catch (e) {}
      if (field) return { key, field };
    }
    return null;
  };

  const gFormGetValue = (gForm, variable) => {
    if (!gForm || typeof gForm.getValue !== "function") {
      return { available: false, value: undefined };
    }
    const keys = variableKeys(variable);
    for (const key of keys) {
      try {
        let current = gForm.getValue(key);
        if (current !== undefined && current !== null) {
          // Multi-row variable sets return an array/object; serialize it so it
          // survives chrome.runtime messaging and renders as readable JSON.
          if (typeof current === "object") {
            try {
              current = JSON.stringify(current);
            } catch (e) {
              current = String(current);
            }
          }
          return { available: true, value: current };
        }
      } catch (e) {}
    }
    return { available: false, value: undefined };
  };

  const gFormReportedVisible = (gForm, variable) => {
    try {
      const target = findGFormTarget(gForm, variable);
      if (target && target.field && typeof target.field.visible === "boolean") {
        return target.field.visible;
      }
      if (gForm && typeof gForm.isVisible === "function") {
        const keys = variableKeys(variable);
        for (const key of keys) {
          try {
            const value = gForm.isVisible(key);
            if (typeof value === "boolean") return value;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return null;
  };

  const isElementVisible = (el) => Boolean(el && el.offsetParent !== null);

  result.foundForm = hasPortalFormContainer();
  const gForm = findPortalGForm();

  list.forEach((variable) => {
    const entry = {
      name: variable && variable.name,
      foundEl: false,
      visible: false,
      liveValue: "",
      liveValueAvailable: false,
      gFormReportedVisible: null,
    };

    if (!variable || !variable.name || variable.secret) {
      result.results.push(entry);
      return;
    }

    const el = findDomField(variable);
    entry.foundEl = Boolean(el);
    entry.visible = isElementVisible(el);
    if (entry.foundEl) result.matchedCount++;

    if (gForm) {
      const gFormValue = gFormGetValue(gForm, variable);
      if (gFormValue.available) {
        entry.liveValue = gFormValue.value;
        entry.liveValueAvailable = true;
      }
      entry.gFormReportedVisible = gFormReportedVisible(gForm, variable);
    }

    if (!entry.liveValueAvailable && el) {
      const elValue = getElementValue(el);
      if (elValue !== "" && elValue != null) {
        entry.liveValue = elValue;
        entry.liveValueAvailable = true;
      }
    }

    result.results.push(entry);
  });

  return result;
}

// MAIN-world bridge for the variable-insight icons. A Service Portal catalog
// variable's internal name and definition sys_id only live in the Angular
// `field` model, which the isolated content script can't read. Running here in
// the MAIN world we read each `field` off its scope, stamp the identity onto the
// shared DOM as data-* attributes, and return the list. The content script then
// anchors an icon next to each stamped element. Read-only: no field is mutated,
// only decorated with data attributes it can clean up.
function mapPortalVariableAnchors() {
  const ng = window.angular;
  if (!ng || !ng.element) return { foundForm: false, variables: [] };

  const actuals = document.querySelectorAll("span.field-actual[ng-switch]");
  if (!actuals.length) return { foundForm: false, variables: [] };

  const variables = [];
  const seen = new Set();
  actuals.forEach((el) => {
    let field = null;
    try {
      const scope = ng.element(el).scope();
      field = scope && scope.field;
    } catch (e) {
      field = null;
    }
    if (!field || !field.name) return;

    const name = String(field.name);
    const sysId = field.sys_id ? String(field.sys_id) : "";
    const type = field.type ? String(field.type) : "";
    el.setAttribute("data-snh-var", name);
    if (sysId) el.setAttribute("data-snh-var-sysid", sysId);
    if (type) el.setAttribute("data-snh-var-type", type);

    if (seen.has(name)) return;
    seen.add(name);
    variables.push({ name, sysId, type });
  });

  return { foundForm: variables.length > 0, variables };
}

/* ---------------------------------------------------------------------------
   Debug Timeline frame targeting.

   Recording spans frames, so this is the one caller that must reach all of
   them rather than resolving a single frame. It uses the shared discovery
   above: Start injects into each announced frame individually, and Stop
   targets exactly the frames that reported starting.

   Falling back to frame 0 is not enough: in the Next Experience classic shell,
   frame 0 owns the palette while `gsft_main` owns `g_form` and the form DOM.
   Recording only frame 0 therefore produces a plausible-looking trace with
   just the synthetic Start and Stop entries.
   --------------------------------------------------------------------------- */

// storage.session, not a module variable: the MV3 worker can be torn down
// between starting and stopping a recording, which would lose the frame list
// exactly when Stop needs it.
const timelineFramesKey = (tabId) => "debugTimelineFrames:" + tabId;

function rememberRecordingFrames(tabId, frameIds) {
  const item = {};
  item[timelineFramesKey(tabId)] = frameIds;
  return chrome.storage.session.set(item).catch(() => {});
}

function readRecordingFrames(tabId) {
  const key = timelineFramesKey(tabId);
  return chrome.storage.session
    .get(key)
    .then((bag) => (bag && Array.isArray(bag[key]) ? bag[key] : null))
    .catch(() => null);
}

function forgetRecordingFrames(tabId) {
  return chrome.storage.session.remove(timelineFramesKey(tabId)).catch(() => {});
}

function injectTimelineInFrames(tabId, frameIds, func, action) {
  return Promise.all(
    frameIds.map((frameId) =>
      injectInFrame(tabId, frameId, { world: "MAIN", func }, action).catch(
        () => []
      )
    )
  ).then((perFrame) => [].concat.apply([], perFrame));
}

function startTimelineInFrames(tabId) {
  return discoverContentFrames(tabId, "timeline").then((frameIds) =>
    injectTimelineInFrames(tabId, frameIds, startDebugTimelineInPage, "start")
  );
}

// Stop only the frames that started, one injection each, so a single bad frame
// cannot hang or reject the whole stop.
function stopTimelineInFrames(tabId) {
  return readRecordingFrames(tabId).then((frameIds) => {
    if (!frameIds || !frameIds.length) {
      return discoverContentFrames(tabId, "timeline").then((discoveredFrameIds) =>
        injectTimelineInFrames(
          tabId,
          discoveredFrameIds,
          stopDebugTimelineInPage,
          "stop"
        )
      );
    }
    return injectTimelineInFrames(
      tabId,
      frameIds,
      stopDebugTimelineInPage,
      "stop"
    ).then((results) => {
      // Cleared only now: clearing before the read would send the next stop
      // through discovery without knowing which frames originally started.
      forgetRecordingFrames(tabId);
      return results;
    });
  });
}

function openUrlTabOptions(url, sender) {
  const options = { url, active: true };
  const sourceTab = sender && sender.tab;
  if (!sourceTab) return options;

  if (Number.isInteger(sourceTab.windowId)) {
    options.windowId = sourceTab.windowId;
  }
  if (Number.isInteger(sourceTab.index) && sourceTab.index >= 0) {
    options.index = sourceTab.index + 1;
  }
  if (Number.isInteger(sourceTab.id)) {
    options.openerTabId = sourceTab.id;
  }
  return options;
}

// Content scripts can't call chrome.tabs.create; they ask us via OPEN_URL.
// Keep the destination beside the ServiceNow tab that initiated the command,
// rather than appending it to the end of whichever window is currently active.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "FRAME_AVAILABLE" && msg.requestId) {
    registerContentFrame(msg.requestId, sender);
  }
  if (msg && msg.type === "OPEN_URL" && msg.url) {
    chrome.tabs.create(openUrlTabOptions(msg.url, sender));
  }
  /* The popup is not a content script, so it cannot announce frames or be
   * announced to. It asks the worker for the same discovered list instead,
   * rather than reaching for allFrames and hanging on a helper frame. */
  if (msg && msg.type === "GET_TAB_FRAMES" && Number.isInteger(msg.tabId)) {
    discoverContentFrames(msg.tabId, "popup")
      .then((frameIds) => sendResponse({ ok: true, frameIds }))
      .catch(() => sendResponse({ ok: false, frameIds: [0] }));
    return true;
  }
  if (msg && msg.type === "START_DEBUG_TIMELINE" && sender.tab) {
    startTimelineInFrames(sender.tab.id).then((results) => {
      const frames = results
        .map((item) => ({
          frameId: item.frameId,
          result: item && item.result,
        }))
        .filter((item) => item.result && item.result.ok);
      // Stop injects into exactly these, rather than asking for allFrames again
      // and hanging on a frame ServiceNow added in the meantime.
      return rememberRecordingFrames(
        sender.tab.id,
        frames.map((item) => item.frameId)
      ).then(() => {
        sendResponse({
          ok: frames.length > 0,
          frameCount: frames.length,
          alreadyActive: frames.length > 0 && frames.every((item) => item.result.alreadyActive),
          startedAt: frames.reduce(
            (earliest, item) =>
              !earliest || item.result.startedAt < earliest ? item.result.startedAt : earliest,
            0
          ),
        });
      });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (msg && msg.type === "STOP_DEBUG_TIMELINE" && sender.tab) {
    stopTimelineInFrames(sender.tab.id).then((results) => {
      const frames = results
        .map((item) => ({
          frameId: item.frameId,
          result: item && item.result,
        }))
        .filter((item) => item.result && item.result.ok && !item.result.notRunning);
      const startedAt = frames.reduce(
        (earliest, item) =>
          !earliest || item.result.startedAt < earliest ? item.result.startedAt : earliest,
        0
      );
      const stoppedAt = frames.reduce(
        (latest, item) => Math.max(latest, item.result.stoppedAt || 0),
        Date.now()
      );
      const events = [];
      frames.forEach((frame) => {
        const frameLabel = frame.frameId === 0 ? "Top frame" : "Frame " + frame.frameId;
        (frame.result.events || []).forEach((event) => {
          events.push(Object.assign({}, event, {
            frameId: frame.frameId,
            frameLabel,
            elapsedMs: startedAt ? Math.max(0, event.time - startedAt) : event.elapsedMs,
          }));
        });
      });
      if (frames.length && startedAt) {
        events.push(
          {
            id: 0,
            time: startedAt,
            elapsedMs: 0,
            category: "system",
            action: "start",
            summary: "Recording started",
            details: { frameCount: frames.length },
            stack: "",
            sessionEventOrder: -1,
          },
          {
            id: 0,
            time: stoppedAt,
            elapsedMs: Math.max(0, stoppedAt - startedAt),
            category: "system",
            action: "stop",
            summary: "Recording stopped",
            details: { frameCount: frames.length },
            stack: "",
            sessionEventOrder: 1,
          }
        );
      }
      events.sort((a, b) => {
        if (a.time !== b.time) return a.time - b.time;
        if (a.sessionEventOrder !== b.sessionEventOrder) {
          return (a.sessionEventOrder || 0) - (b.sessionEventOrder || 0);
        }
        if (a.frameId !== b.frameId) return a.frameId - b.frameId;
        return a.id - b.id;
      });
      events.forEach((event) => delete event.sessionEventOrder);
      sendResponse({
        ok: true,
        frameCount: frames.length,
        startedAt,
        stoppedAt,
        events,
        truncated: frames.some((frame) => frame.result.truncated),
      });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (
    msg &&
    sender.tab &&
    (msg.type === "TOGGLE_FIELD_NAMES" ||
      msg.type === "TOGGLE_TRANSLATIONS" ||
      msg.type === "TOGGLE_VARIABLE_INSIGHT")
  ) {
    postWindowMessageInFrames(sender.tab.id, msg.type);
  }
  if (msg && msg.type === "SN_TABLE_GET" && sender.tab) {
    const request = {
      table: msg.table,
      query: msg.query,
      fields: msg.fields,
      limit: msg.limit,
      options: msg.options || {},
    };
    readFromPageFrames(
      sender.tab.id,
      tableApiGetInPage,
      [request],
      "read " + request.table
    ).then((responses) => {
      const ok = responses.find((item) => item.ok);
      if (ok) {
        sendResponse({ ok: true, result: ok.result || [] });
        return;
      }
      const error = responses.find((item) => !item.ok);
      sendResponse({
        ok: false,
        error: (error && error.error) || "Couldn't read " + request.table,
      });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (msg && msg.type === "INJECT_CODE_SEARCH" && sender.tab) {
    /*
     * Lazy injection. code_search.js and code_search_ui.js are the two largest
     * scripts in the extension for a feature used occasionally, so they are
     * kept out of manifest.json's content_scripts and injected on first use of
     * the palette command instead — nothing loads at document_idle.
     *
     * Isolated world (the default for files:), into the frame that asked, so
     * content.js can call SNCodeSearch directly. Both files no-op if already
     * present, which makes repeat invocations free. No web_accessible_resources
     * entry is needed: executeScript with files: does not require one.
     */
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
        files: ["code_search.js", "code_search_ui.js"],
      })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (msg && msg.type === "INJECT_RECORD_SEARCH" && sender.tab) {
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
        files: ["record_search.js", "record_search_ui.js"],
      })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (msg && msg.type === "SN_RECORD_SEARCH_GET" && sender.tab) {
    recordSearchTableGet(sender.tab.id, {
      table: msg.table,
      query: msg.query,
      fields: msg.fields,
      limit: msg.limit,
      options: msg.options || {},
    })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, status: 0, error: String(error) }));
    return true;
  }
  if (msg && msg.type === "SN_CODE_SEARCH_GET" && sender.tab) {
    codeSearchTableGet(sender.tab.id, {
      table: msg.table,
      query: msg.query,
      fields: msg.fields,
      limit: msg.limit,
      options: {},
    })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, status: 0, error: String(error) }));
    return true;
  }
  if (msg && msg.type === "SN_CODE_SEARCH_API_GET" && sender.tab) {
    codeSearchApiGet(sender.tab.id, { term: msg.term, table: msg.table })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, status: 0, error: String(error) }));
    return true;
  }
  if (msg && msg.type === "GET_SYS_ID" && sender.tab) {
    readFromPageFrames(sender.tab.id, extractSysId, [], "read sys_id").then((results) => {
      const found = results.find((id) => /^[0-9a-f]{32}$/i.test(id));
      sendResponse({ ok: Boolean(found), sysId: found || null });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (msg && msg.type === "FILL_PORTAL_VARIABLES" && sender.tab) {
    const variables = Array.isArray(msg.variables) ? msg.variables : [];
    readFromPageFrames(
      sender.tab.id,
      fillPortalVariables,
      [variables],
      "fill portal variables"
    ).then((frameResults) => {
      const found = frameResults
        .filter((item) => item.foundForm)
        .sort((a, b) => {
          const scoreA = (a.filled || 0) + (a.alreadySet || 0) + (a.skipped || 0);
          const scoreB = (b.filled || 0) + (b.alreadySet || 0) + (b.skipped || 0);
          return scoreB - scoreA;
        })[0];
      sendResponse({
        ok: true,
        foundForm: Boolean(found),
        filled: found ? found.filled || 0 : 0,
        alreadySet: found ? found.alreadySet || 0 : 0,
        skipped: found ? found.skipped || 0 : 0,
        unmatched: found ? found.unmatched || 0 : 0,
        fillLog: found && Array.isArray(found.fillLog) ? found.fillLog : [],
        total: variables.length,
      });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (msg && msg.type === "GET_PORTAL_VARIABLE_DEBUG" && sender.tab) {
    readFromPageFrames(
      sender.tab.id,
      inspectPortalVariableDebug,
      [],
      "inspect portal variables"
    ).then((frames) => {
      sendResponse({ ok: true, frames });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (msg && msg.type === "MAP_PORTAL_VARIABLES" && sender.tab) {
    readFromPageFrames(
      sender.tab.id,
      mapPortalVariableAnchors,
      [],
      "map portal variables"
    ).then((frameResults) => {
      const found = frameResults
        .filter((item) => item.foundForm)
        .sort((a, b) => (b.variables.length || 0) - (a.variables.length || 0))[0];
      sendResponse({
        ok: true,
        foundForm: Boolean(found),
        variables: found ? found.variables || [] : [],
      });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (msg && msg.type === "GET_HIDDEN_PORTAL_VARIABLES" && sender.tab) {
    const variables = Array.isArray(msg.variables) ? msg.variables : [];
    readFromPageFrames(
      sender.tab.id,
      inspectHiddenPortalVariables,
      [variables],
      "inspect hidden variables"
    ).then((frameResults) => {
      const found = frameResults
        .filter((item) => item.foundForm)
        .sort((a, b) => (b.matchedCount || 0) - (a.matchedCount || 0))[0];
      sendResponse({
        ok: true,
        foundForm: Boolean(found),
        perVariable: found ? found.results || [] : [],
      });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (msg && msg.type === "PREFILL_PROGRESS" && sender.tab) {
    sendToTab(
      sender.tab.id,
      { type: "PREFILL_PROGRESS", message: msg.message || "Filling portal form..." },
      { frameId: 0 }
    );
  }
  // A sub-frame (e.g. gsft_main) pressed the shortcut; relay to the whole
  // tab so the top frame's content script can toggle the palette.
  if (msg && msg.type === "TOGGLE_PALETTE" && sender.tab) {
    togglePaletteInTopFrame(sender.tab.id);
  }
});

/*
 * popup.js — instance info only.
 * All actions moved to the backslash command palette (content.js).
 */

const $ = (id) => document.getElementById(id);
let ORIGIN = null;

function setStatus(text, cls) {
  const s = $("status");
  s.textContent = text;
  s.className = "status" + (cls ? " " + cls : "");
}

function renderInfo(data) {
  const el = $("info");
  if (!data) {
    el.innerHTML = '<div class="muted">No ServiceNow context found on this tab.</div>';
    return;
  }
  const rows = [];
  const add = (k, v, mono) => {
    if (!v) return;
    rows.push(
      `<div class="k">${k}</div><div class="v${mono ? " mono" : ""}">${v}</div>`
    );
  };
  add("Instance", ORIGIN ? ORIGIN.replace(/^https?:\/\//, "") : "");
  add("User", data.fullName ? `${data.fullName} (${data.userName})` : data.userName);
  add("Node",    data.node);
  add("Version", data.version);
  add("Table",   data.table,  true);
  add("sys_id",  data.sysId,  true);
  el.innerHTML = rows.length
    ? `<div class="kv">${rows.join("")}</div>`
    : '<div class="muted">Connected — open a form for more context.</div>';
}

/*
 * Runs in the SN page MAIN world; must be self-contained.
 *
 * Return only what renderInfo() actually displays. This used to also hand back
 * g_user.userID and the g_ck CSRF token, neither of which had a consumer —
 * carrying a session token across the world boundary into the popup for nothing
 * is a liability, not a convenience. The token-bearing reads live in
 * background.js, where the token never leaves the page's own world.
 */
function probe() {
  const out = { found: false, href: location.href };
  try {
    if (typeof g_user !== "undefined" && g_user) {
      out.found = true;
      out.userName = g_user.userName;
      out.fullName = [g_user.firstName, g_user.lastName].filter(Boolean).join(" ");
    }
    if (typeof window.NOW !== "undefined" && window.NOW) {
      out.found   = true;
      out.node    = window.NOW.node || window.NOW.nodeName || null;
      out.version = (window.NOW.glide && window.NOW.glide.version) || window.NOW.glideVersion || null;
    }
    if (typeof g_form !== "undefined" && g_form) {
      out.found = true;
      try { out.table = g_form.getTableName(); } catch (e) {}
      try { out.sysId = g_form.getUniqueValue(); } catch (e) {}
    }
  } catch (e) { out.error = String(e); }
  return out;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function runInPage(func, args, options) {
  const tab = (options && options.tab) || await getActiveTab();
  if (!tab) return { tab: null, results: [] };
  const timeoutMs = (options && options.timeoutMs) || 2500;
  const injection = chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    world: "MAIN",
    func,
    args: args || [],
  }).catch(() => []);
  const results = await withTimeout(injection, timeoutMs, []);
  return { tab, results };
}

function pickFrame(results) {
  const found = results.map((r) => r.result).filter((r) => r && r.found);
  return found.find((r) => r.sysId) || found[0] || null;
}

async function fetchStats(data) {
  if (!ORIGIN) return;
  try {
    const res = await fetch(ORIGIN + "/stats.do", { credentials: "include" });
    if (!res.ok) return;
    const txt = await res.text();
    const m = (re) => { const x = txt.match(re); return x ? x[1].trim() : null; };
    data.version = data.version || m(/Build name:\s*([^\n<]+)/i);
    data.node    = data.node    || m(/Instance name:\s*([^\n<]+)/i) || m(/node:\s*([^\n<]+)/i);
    renderInfo(data);
  } catch (e) { /* ignore */ }
}

async function init() {
  const tab = await getActiveTab();
  if (tab && tab.url) {
    try { ORIGIN = new URL(tab.url).origin; } catch (e) {}
  }

  const isSN = ORIGIN && /\.service-now\.com$/.test(new URL(ORIGIN).hostname);
  if (!isSN) {
    setStatus("not SN", "bad");
    renderInfo(null);
    return;
  }

  setStatus("connected", "ok");
  renderInfo({ found: true });

  const { results } = await runInPage(probe, [], { tab, timeoutMs: 2500 });
  const data = pickFrame(results) || { found: true };
  renderInfo(data);
  if (!data.version || !data.node) fetchStats(data);
}

document.addEventListener("DOMContentLoaded", init);

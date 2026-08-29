/* Tests for placing GlideLens-opened tabs beside their originating tab. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadOpenUrlTabOptions() {
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const start = source.indexOf("function openUrlTabOptions");
  const end = source.indexOf("// Content scripts can't call chrome.tabs.create", start);
  assert.ok(start >= 0 && end > start, "OPEN_URL helper not found");
  return new Function(source.slice(start, end) + "\nreturn openUrlTabOptions;")();
}

const openUrlTabOptions = loadOpenUrlTabOptions();

test("a destination opens immediately after the originating tab", () => {
  assert.deepStrictEqual(
    openUrlTabOptions("https://example.service-now.com/incident.do", {
      tab: { id: 41, windowId: 7, index: 3 },
    }),
    {
      url: "https://example.service-now.com/incident.do",
      active: true,
      windowId: 7,
      index: 4,
      openerTabId: 41,
    }
  );
});

test("a message without tab context keeps Chrome's normal placement fallback", () => {
  assert.deepStrictEqual(
    openUrlTabOptions("https://example.service-now.com/sys_script_list.do", {}),
    {
      url: "https://example.service-now.com/sys_script_list.do",
      active: true,
    }
  );
});

test("invalid tab positions are never forwarded to Chrome", () => {
  assert.deepStrictEqual(
    openUrlTabOptions("https://example.service-now.com/", {
      tab: { id: "41", windowId: null, index: -1 },
    }),
    {
      url: "https://example.service-now.com/",
      active: true,
    }
  );
});

/* ---------------------------------------------------------------------------
 * OPEN_URL is the one route where a content script asks the privileged worker
 * to open a tab. Every real caller builds `location.origin + path`, so the
 * destination is held to the sender's own ServiceNow origin.
 * ------------------------------------------------------------------------ */

function loadResolveOpenUrl() {
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const start = source.indexOf("const SN_TAB_HOST");
  const end = source.indexOf("function openUrlTabOptions", start);
  assert.ok(start >= 0 && end > start, "OPEN_URL validator not found");
  return new Function(source.slice(start, end) + "\nreturn resolveOpenUrl;")();
}

const resolveOpenUrl = loadResolveOpenUrl();
const senderOn = (origin) => ({ origin, tab: { id: 4, url: origin + "/incident.do" } });

test("a same-origin ServiceNow destination is allowed and rebuilt", () => {
  assert.strictEqual(
    resolveOpenUrl(
      "https://example.service-now.com/incident_list.do?sysparm_query=active%3Dtrue",
      senderOn("https://example.service-now.com")
    ),
    "https://example.service-now.com/incident_list.do?sysparm_query=active%3Dtrue"
  );
});

test("non-https schemes are refused", () => {
  const sender = senderOn("https://example.service-now.com");
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<h1>hi</h1>",
    "file:///C:/Windows/win.ini",
    "http://example.service-now.com/incident.do",
    "chrome://settings",
  ]) {
    assert.strictEqual(resolveOpenUrl(url, sender), null, url);
  }
});

test("a lookalike host is not a ServiceNow host", () => {
  const sender = senderOn("https://example.service-now.com");
  for (const url of [
    "https://evil-service-now.com/incident.do",
    "https://service-now.com.evil.io/incident.do",
    "https://example.service-now.com.evil.io/incident.do",
  ]) {
    assert.strictEqual(resolveOpenUrl(url, sender), null, url);
  }
});

test("another instance is refused even though it is a real ServiceNow host", () => {
  assert.strictEqual(
    resolveOpenUrl(
      "https://other.service-now.com/sys_user_list.do",
      senderOn("https://example.service-now.com")
    ),
    null
  );
});

test("a message with no recognisable sender opens nothing", () => {
  /* Fails closed. Every real caller is a content script in a ServiceNow tab,
   * so an absent sender is not a caller we know -- it used to fall through to
   * "any ServiceNow host will do", a weaker rule than all real callers meet. */
  assert.strictEqual(resolveOpenUrl("https://example.service-now.com/incident.do", {}), null);
  assert.strictEqual(resolveOpenUrl("https://elsewhere.example/incident.do", {}), null);
  assert.strictEqual(
    resolveOpenUrl("https://example.service-now.com/incident.do", {
      origin: "https://not-servicenow.example",
    }),
    null
  );
});

test("embedded credentials are refused, origin equality notwithstanding", () => {
  /* URL.origin drops credentials, so an origin check alone passes -- while
   * toString() keeps them, carrying them into the opened tab. */
  const sender = senderOn("https://example.service-now.com");
  for (const url of [
    "https://user:pass@example.service-now.com/incident.do",
    "https://user@example.service-now.com/incident.do",
    "https://:pass@example.service-now.com/incident.do",
  ]) {
    assert.strictEqual(resolveOpenUrl(url, sender), null, url);
  }
});

test("a sender origin is used even when only the tab URL carries it", () => {
  const sender = { tab: { id: 9, url: "https://example.service-now.com/incident.do" } };
  assert.strictEqual(
    resolveOpenUrl("https://other.service-now.com/incident.do", sender),
    null
  );
});

test("junk input opens nothing", () => {
  const sender = senderOn("https://example.service-now.com");
  for (const url of ["", "not a url", "//example.service-now.com/x", null, undefined, 42, {}]) {
    assert.strictEqual(resolveOpenUrl(url, sender), null, String(url));
  }
});

test("an absurdly long URL is refused before parsing", () => {
  const sender = senderOn("https://example.service-now.com");
  const long = "https://example.service-now.com/incident.do?q=" + "a".repeat(5000);
  assert.strictEqual(resolveOpenUrl(long, sender), null);
});

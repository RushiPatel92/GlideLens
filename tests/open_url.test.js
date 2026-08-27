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

/*
 * Tests for the shared frame discovery and targeted injection in background.js.
 *
 * executeScript({ allFrames: true }) hangs — never resolving, never rejecting —
 * on the about:blank helper frames ServiceNow puts on a classic form. Every
 * reader that answered a content script through sendResponse could therefore
 * strand its caller with no error to show. These tests pin the replacement:
 * discover concrete frames from content-script announcements, then inject into
 * each one with its own timeout.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadSharedFrameHelpers(options) {
  const file = path.join(__dirname, "..", "background.js");
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("const FRAME_DISCOVERY_WAIT_MS");
  const marker = source.indexOf("* CODE SEARCH TRANSPORT", start);
  assert.ok(start >= 0 && marker > start, "shared frame helper block not found");
  const end = source.lastIndexOf("/*", marker);

  const calls = [];
  let api;
  const opts = options || {};
  const chrome = {
    tabs: {
      sendMessage: async (tabId, message) => {
        calls.push({ kind: "broadcast", tabId, message });
        if (message.type !== "DISCOVER_FRAME") return;
        (opts.frameIds || [0, 7]).forEach((frameId) => {
          api.registerContentFrame(message.requestId, {
            tab: { id: tabId },
            frameId,
          });
        });
      },
    },
    scripting: {
      executeScript: async (injection) => {
        calls.push({ kind: "inject", target: injection.target });
        const frameId = injection.target.frameIds[0];
        if (opts.hungFrame === frameId) return new Promise(() => {});
        if (opts.rejectingFrame === frameId) throw new Error("frame gone");
        return [{ frameId, result: { frameId, ok: true } }];
      },
    },
  };

  const block = source
    .slice(start, end)
    .replace("const FRAME_DISCOVERY_WAIT_MS = 150;", "const FRAME_DISCOVERY_WAIT_MS = 1;")
    .replace("const FRAME_INJECT_TIMEOUT_MS = 5000;", "const FRAME_INJECT_TIMEOUT_MS = 20;")
    .replace(
      "const FRAME_LIST_TTL_MS = 3000;",
      "const FRAME_LIST_TTL_MS = " + (opts.ttlMs === undefined ? 3000 : opts.ttlMs) + ";"
    );

  const factory = new Function(
    "chrome",
    block +
      "\nreturn { registerContentFrame, discoverContentFrames, injectInFrame, " +
      "injectInDiscoveredFrames, readFromPageFrames };"
  );
  api = factory(chrome);
  return { api, calls };
}

test("discovery collects every content-script frame that answers", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [7, 0] });

  const frameIds = await api.discoverContentFrames(41, "test");

  assert.deepStrictEqual(frameIds, [0, 7]);
  const broadcasts = calls.filter((call) => call.kind === "broadcast");
  assert.strictEqual(broadcasts.length, 1);
  assert.strictEqual(broadcasts[0].message.type, "DISCOVER_FRAME");
});

test("a page that announces nothing still gets frame 0", async () => {
  const { api } = loadSharedFrameHelpers({ frameIds: [] });

  assert.deepStrictEqual(await api.discoverContentFrames(41, "test"), [0]);
});

test("an announcement cannot cross tabs or invent a frame id", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [] });

  const discovery = api.discoverContentFrames(41, "test");
  const { requestId } = calls.find((call) => call.kind === "broadcast").message;
  const accepted = [
    api.registerContentFrame(requestId, { tab: { id: 99 }, frameId: 3 }),
    api.registerContentFrame(requestId, { tab: { id: 41 }, frameId: "3" }),
    api.registerContentFrame("unknown-request", { tab: { id: 41 }, frameId: 3 }),
    api.registerContentFrame(requestId, { tab: { id: 41 }, frameId: 3 }),
  ];

  assert.deepStrictEqual(accepted, [false, false, false, true]);
  assert.deepStrictEqual(await discovery, [3]);
});

test("readers target frames one at a time and never use allFrames", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  await api.readFromPageFrames(41, function reader() {}, [], "read");

  const targets = calls.filter((call) => call.kind === "inject").map((c) => c.target);
  assert.deepStrictEqual(targets, [
    { tabId: 41, frameIds: [0] },
    { tabId: 41, frameIds: [7] },
  ]);
  assert.ok(targets.every((target) => target.allFrames === undefined));
});

/*
 * The regression that matters: before this, one never-settling frame meant the
 * whole read never settled, sendResponse was never called, and the content
 * script awaited it forever.
 */
test("a frame that never settles cannot block the frames that do", async () => {
  const { api } = loadSharedFrameHelpers({ frameIds: [0, 7], hungFrame: 7 });

  const results = await api.readFromPageFrames(41, function reader() {}, [], "read");

  assert.deepStrictEqual(results, [{ frameId: 0, ok: true }]);
});

test("a frame that rejects contributes nothing and is not fatal", async () => {
  const { api } = loadSharedFrameHelpers({ frameIds: [0, 7], rejectingFrame: 0 });

  const results = await api.readFromPageFrames(41, function reader() {}, [], "read");

  assert.deepStrictEqual(results, [{ frameId: 7, ok: true }]);
});

test("every frame hanging yields an empty read rather than a hang", async () => {
  const { api } = loadSharedFrameHelpers({ frameIds: [7], hungFrame: 7 });

  assert.deepStrictEqual(
    await api.readFromPageFrames(41, function reader() {}, [], "read"),
    []
  );
});

test("a burst of reads discovers once and reuses the cached frame list", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  await api.readFromPageFrames(41, function reader() {}, [], "one");
  await api.readFromPageFrames(41, function reader() {}, [], "two");
  await api.readFromPageFrames(41, function reader() {}, [], "three");

  assert.strictEqual(calls.filter((call) => call.kind === "broadcast").length, 1);
});

test("parallel reads on a cold tab share one discovery", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  await Promise.all([
    api.readFromPageFrames(41, function reader() {}, [], "one"),
    api.readFromPageFrames(41, function reader() {}, [], "two"),
    api.readFromPageFrames(41, function reader() {}, [], "three"),
  ]);

  assert.strictEqual(calls.filter((call) => call.kind === "broadcast").length, 1);
});

test("a caller cannot mutate the cached frame list", async () => {
  const { api } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  const first = await api.discoverContentFrames(41, "test");
  first.push(99);

  assert.deepStrictEqual(await api.discoverContentFrames(41, "test"), [0, 7]);
});

test("the cached frame list expires so a new frame is not missed for long", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [0, 7], ttlMs: 0 });

  await api.readFromPageFrames(41, function reader() {}, [], "one");
  await api.readFromPageFrames(41, function reader() {}, [], "two");

  assert.strictEqual(calls.filter((call) => call.kind === "broadcast").length, 2);
});

test("the frame list is cached per tab, not globally", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  await api.readFromPageFrames(41, function reader() {}, [], "one");
  await api.readFromPageFrames(42, function reader() {}, [], "two");

  const broadcasts = calls.filter((call) => call.kind === "broadcast");
  assert.deepStrictEqual(broadcasts.map((call) => call.tabId), [41, 42]);
});

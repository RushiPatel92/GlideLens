/*
 * Tests for Debug Timeline frame discovery in background.js.
 *
 * ServiceNow can carry about:blank helper frames that make
 * executeScript({ allFrames: true }) hang forever. The worker therefore asks
 * the extension's content scripts to announce their concrete frame ids and
 * injects into those frames one at a time.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadFrameHelpers() {
  const file = path.join(__dirname, "..", "background.js");
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("const TIMELINE_INJECT_TIMEOUT_MS");
  const end = source.indexOf("// Content scripts can't call", start);
  assert.ok(start >= 0 && end > start, "timeline helper block not found");

  const calls = [];
  let api;
  const stored = new Map();
  const chrome = {
    tabs: {
      sendMessage: async (tabId, message) => {
        calls.push({ kind: "broadcast", tabId, message });
        if (message.type === "DISCOVER_DEBUG_TIMELINE_FRAME") {
          api.registerTimelineFrame(message.requestId, { tab: { id: tabId }, frameId: 7 });
          api.registerTimelineFrame(message.requestId, { tab: { id: tabId }, frameId: 0 });
        }
      },
    },
    scripting: {
      executeScript: async ({ target, func }) => {
        calls.push({ kind: "inject", target, func });
        const frameId = target.frameIds[0];
        return [{ frameId, result: { ok: true, startedAt: 1000 + frameId } }];
      },
    },
    storage: {
      session: {
        set: async (item) => {
          Object.entries(item).forEach(([key, value]) => stored.set(key, value));
        },
        get: async (key) => ({ [key]: stored.get(key) }),
        remove: async (key) => stored.delete(key),
      },
    },
  };

  const factory = new Function(
    "chrome",
    "startDebugTimelineInPage",
    "stopDebugTimelineInPage",
    source.slice(start, end) +
      "\nreturn { registerTimelineFrame, discoverTimelineFrames, " +
      "startTimelineInFrames, stopTimelineInFrames, rememberRecordingFrames };"
  );
  api = factory(chrome, function start() {}, function stop() {});
  return { api, calls, chrome };
}

test("discovery collects every responding content-script frame", async () => {
  const { api, calls } = loadFrameHelpers();

  const frameIds = await api.discoverTimelineFrames(41);

  assert.deepStrictEqual(frameIds, [0, 7]);
  assert.strictEqual(calls.filter((call) => call.kind === "broadcast").length, 1);
});

test("start targets discovered frames individually and never uses allFrames", async () => {
  const { api, calls } = loadFrameHelpers();

  const results = await api.startTimelineInFrames(41);
  const targets = calls
    .filter((call) => call.kind === "inject")
    .map((call) => call.target);

  assert.deepStrictEqual(targets, [
    { tabId: 41, frameIds: [0] },
    { tabId: 41, frameIds: [7] },
  ]);
  assert.ok(targets.every((target) => target.allFrames === undefined));
  assert.deepStrictEqual(results.map((item) => item.frameId), [0, 7]);
});

test("stop reuses only the frame ids that successfully started", async () => {
  const { api, calls } = loadFrameHelpers();
  await api.rememberRecordingFrames(41, [0, 7]);

  const results = await api.stopTimelineInFrames(41);
  const targets = calls
    .filter((call) => call.kind === "inject")
    .map((call) => call.target);

  assert.deepStrictEqual(targets, [
    { tabId: 41, frameIds: [0] },
    { tabId: 41, frameIds: [7] },
  ]);
  assert.deepStrictEqual(results.map((item) => item.frameId), [0, 7]);
});

test("a frame announcement cannot cross tabs or invent an invalid id", async () => {
  const { api, chrome } = loadFrameHelpers();
  let requestId;
  chrome.tabs.sendMessage = async (_tabId, message) => {
    requestId = message.requestId;
    assert.strictEqual(
      api.registerTimelineFrame(requestId, { tab: { id: 99 }, frameId: 3 }),
      false
    );
    assert.strictEqual(
      api.registerTimelineFrame(requestId, { tab: { id: 41 }, frameId: "3" }),
      false
    );
  };

  const frameIds = await api.discoverTimelineFrames(41);

  assert.ok(requestId);
  assert.deepStrictEqual(frameIds, [0]);
});

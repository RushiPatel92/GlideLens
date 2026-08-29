/*
 * Tests for Debug Timeline frame targeting in background.js.
 *
 * Recording spans frames, so this is the one caller that must reach all of
 * them. It does that through the shared discovery (see frame_discovery.test.js)
 * rather than executeScript({ allFrames: true }), which hangs forever on the
 * about:blank helper frames ServiceNow puts on a classic form — the whole of
 * the "Stop does nothing" bug.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function sliceBlock(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, label + " not found");
  return source.slice(start, end);
}

function loadFrameHelpers() {
  const file = path.join(__dirname, "..", "background.js");
  const source = fs.readFileSync(file, "utf8");

  const sharedStart = source.indexOf("const FRAME_DISCOVERY_WAIT_MS");
  const sharedMarker = source.indexOf("* CODE SEARCH TRANSPORT", sharedStart);
  assert.ok(sharedStart >= 0 && sharedMarker > sharedStart, "shared block not found");
  const shared = source
    .slice(sharedStart, source.lastIndexOf("/*", sharedMarker))
    .replace("const FRAME_DISCOVERY_WAIT_MS = 150;", "const FRAME_DISCOVERY_WAIT_MS = 1;")
    .replace("const FRAME_INJECT_TIMEOUT_MS = 5000;", "const FRAME_INJECT_TIMEOUT_MS = 20;");

  const timeline = sliceBlock(
    source,
    "const timelineFramesKey",
    "function openUrlTabOptions",
    "timeline helper block"
  );

  const calls = [];
  let api;
  const stored = new Map();
  const chrome = {
    tabs: {
      sendMessage: async (tabId, message) => {
        calls.push({ kind: "broadcast", tabId, message });
        if (message.type !== "DISCOVER_FRAME") return;
        [7, 0].forEach((frameId) => {
          api.registerContentFrame(message.requestId, {
            tab: { id: tabId },
            frameId,
          });
        });
      },
      onUpdated: { addListener: () => {} },
    },
    scripting: {
      executeScript: async (injection) => {
        calls.push({ kind: "inject", target: injection.target, func: injection.func });
        const frameId = injection.target.frameIds[0];
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
    shared +
      timeline +
      "\nreturn { registerContentFrame, discoverContentFrames, " +
      "startTimelineInFrames, stopTimelineInFrames, rememberRecordingFrames };"
  );
  api = factory(chrome, function start() {}, function stop() {});
  return { api, calls, chrome };
}

test("discovery collects every responding content-script frame", async () => {
  const { api, calls } = loadFrameHelpers();

  const frameIds = await api.discoverContentFrames(41, "timeline");

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
  // Stop must not have to rediscover when it already knows the frames.
  assert.strictEqual(calls.filter((call) => call.kind === "broadcast").length, 0);
});

/*
 * Start is one-shot and context-sensitive: a frame list taken seconds ago may
 * predate gsft_main. It must never come from the shared cache, or Start records
 * fewer frames than the page has and Stop inherits the omission.
 */
test("start always discovers fresh rather than reusing a cached list", async () => {
  const { api, calls } = loadFrameHelpers();

  await api.startTimelineInFrames(41);
  await api.startTimelineInFrames(41);

  assert.strictEqual(calls.filter((call) => call.kind === "broadcast").length, 2);
});

test("stop falls back to discovery when the frame list was lost", async () => {
  const { api, calls } = loadFrameHelpers();

  const results = await api.stopTimelineInFrames(41);

  assert.strictEqual(calls.filter((call) => call.kind === "broadcast").length, 1);
  assert.deepStrictEqual(results.map((item) => item.frameId), [0, 7]);
});

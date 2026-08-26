/*
 * Tests for the shared Code/Record Search token-frame resolver.
 * ServiceNow helper frames can leave executeScript({ allFrames: true }) pending,
 * so discovery must use content-script announcements and targeted probes.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadSearchFrameHelpers(options) {
  const file = path.join(__dirname, "..", "background.js");
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("const codeSearchFrameByTab");
  const end = source.indexOf("function codeSearchTableGet", start);
  assert.ok(start >= 0 && end > start, "search frame helper block not found");

  const calls = [];
  let api;
  const opts = options || {};
  const chrome = {
    tabs: {
      sendMessage: async (tabId, message) => {
        calls.push({ kind: "broadcast", tabId, message });
        (opts.frameIds || [0, 7]).forEach((frameId) => {
          api.registerSearchFrame(message.requestId, { tab: { id: tabId }, frameId });
        });
      },
    },
    scripting: {
      executeScript: async ({ target }) => {
        calls.push({ kind: "probe", target });
        const frameId = target.frameIds[0];
        if (opts.hungFrame === frameId) return new Promise(() => {});
        return [{ frameId, result: frameId === (opts.tokenFrame ?? 7) }];
      },
    },
  };
  const block = source.slice(start, end)
    .replace("const SEARCH_FRAME_PROBE_TIMEOUT_MS = 2000;", "const SEARCH_FRAME_PROBE_TIMEOUT_MS = 5;")
    .replace("const SEARCH_FRAME_DISCOVERY_WAIT_MS = 150;", "const SEARCH_FRAME_DISCOVERY_WAIT_MS = 1;");
  const factory = new Function(
    "chrome",
    "hasUserTokenInPage",
    block + "\nreturn { registerSearchFrame, discoverSearchFrames, " +
      "probeTokenFrame, resolveTokenFrame };"
  );
  api = factory(chrome, function hasToken() {});
  return { api, calls };
}

test("search frame discovery collects content-script responders", async () => {
  const { api, calls } = loadSearchFrameHelpers();
  const frames = await api.discoverSearchFrames(41);
  assert.deepStrictEqual(frames, [0, 7]);
  assert.strictEqual(calls.filter((call) => call.kind === "broadcast").length, 1);
});

test("token discovery probes concrete frames and never uses allFrames", async () => {
  const { api, calls } = loadSearchFrameHelpers({ tokenFrame: 7 });
  assert.strictEqual(await api.resolveTokenFrame(41), 7);
  const targets = calls
    .filter((call) => call.kind === "probe")
    .map((call) => call.target);
  assert.deepStrictEqual(targets, [
    { tabId: 41, frameIds: [0] },
    { tabId: 41, frameIds: [7] },
  ]);
  assert.ok(targets.every((target) => target.allFrames === undefined));
});

test("one hung frame cannot block a usable token frame", async () => {
  const { api } = loadSearchFrameHelpers({
    frameIds: [0, 7],
    tokenFrame: 0,
    hungFrame: 7,
  });
  assert.strictEqual(await api.resolveTokenFrame(41), 0);
});

test("the resolved token frame is cached per tab", async () => {
  const { api, calls } = loadSearchFrameHelpers({ tokenFrame: 7 });
  assert.strictEqual(await api.resolveTokenFrame(41), 7);
  assert.strictEqual(await api.resolveTokenFrame(41), 7);
  assert.strictEqual(calls.filter((call) => call.kind === "broadcast").length, 1);
});

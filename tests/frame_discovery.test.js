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
  const tabListeners = [];
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
      onUpdated: { addListener: (fn) => tabListeners.push(fn) },
    },
    scripting: {
      executeScript: async (injection) => {
        calls.push({ kind: "inject", target: injection.target });
        const frameId = injection.target.frameIds[0];
        if (opts.hungFrame === frameId) return new Promise(() => {});
        if (opts.rejectingFrame === frameId) throw new Error("frame gone");
        if (opts.slowFrame === frameId) {
          await new Promise((resolve) => setTimeout(resolve, opts.slowMs || 60));
        }
        return [{ frameId, result: { frameId, ok: true } }];
      },
    },
  };

  const block = source
    .slice(start, end)
    .replace("const FRAME_DISCOVERY_WAIT_MS = 150;", "const FRAME_DISCOVERY_WAIT_MS = 1;")
    .replace(
      "const FRAME_INJECT_TIMEOUT_MS = 5000;",
      "const FRAME_INJECT_TIMEOUT_MS = " + (opts.injectTimeoutMs || 20) + ";"
    )
    .replace(
      "const FRAME_LIST_TTL_MS = 3000;",
      "const FRAME_LIST_TTL_MS = " + (opts.ttlMs === undefined ? 3000 : opts.ttlMs) + ";"
    );

  const factory = new Function(
    "chrome",
    "fillPortalVariables",
    block +
      "\nreturn { registerContentFrame, discoverContentFrames, injectInFrame, " +
      "injectInDiscoveredFrames, readFromPageFrames, forgetFrameList };"
  );
  api = factory(chrome, function fill() {});
  return {
    api,
    calls,
    navigate: (tabId) => tabListeners.forEach((fn) => fn(tabId, { status: "loading" })),
  };
}

const broadcasts = (calls) => calls.filter((call) => call.kind === "broadcast");

test("discovery collects every content-script frame that answers", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [7, 0] });

  const frameIds = await api.discoverContentFrames(41, "test");

  assert.deepStrictEqual(frameIds, [0, 7]);
  assert.strictEqual(broadcasts(calls).length, 1);
  assert.strictEqual(broadcasts(calls)[0].message.type, "DISCOVER_FRAME");
});

test("a page that announces nothing still gets frame 0", async () => {
  const { api } = loadSharedFrameHelpers({ frameIds: [] });

  assert.deepStrictEqual(await api.discoverContentFrames(41, "test"), [0]);
});

test("an announcement cannot cross tabs or invent a frame id", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [] });

  const discovery = api.discoverContentFrames(41, "test");
  const { requestId } = broadcasts(calls)[0].message;
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

  const { results } = await api.readFromPageFrames(41, function reader() {}, [], "read");

  assert.deepStrictEqual(results, [{ frameId: 0, ok: true }]);
});

test("a frame that rejects is reported, not silently dropped", async () => {
  const { api } = loadSharedFrameHelpers({ frameIds: [0, 7], rejectingFrame: 0 });

  const { results, failures } = await api.readFromPageFrames(
    41,
    function reader() {},
    [],
    "read"
  );

  assert.deepStrictEqual(results, [{ frameId: 7, ok: true }]);
  assert.deepStrictEqual(failures.map((f) => f.frameId), [0]);
  assert.match(failures[0].error, /frame gone/);
});

/* "Nothing on this page" and "nobody answered" are different answers. */
test("every frame hanging yields an empty read with the failures recorded", async () => {
  const { api } = loadSharedFrameHelpers({ frameIds: [7], hungFrame: 7 });

  const { results, failures } = await api.readFromPageFrames(
    41,
    function reader() {},
    [],
    "read"
  );

  assert.deepStrictEqual(results, []);
  assert.strictEqual(failures.length, 1);
  assert.match(failures[0].error, /timed out/);
});

/*
 * Without an accept predicate, waiting for every frame makes a read cost the
 * slowest one: a hung sibling would hold a successful read for the whole
 * ceiling, which for a Table API read is 30 seconds.
 */
test("accept resolves a read without waiting for a hung sibling", async () => {
  const { api } = loadSharedFrameHelpers({
    frameIds: [0, 7],
    hungFrame: 7,
    injectTimeoutMs: 3000,
  });

  const started = Date.now();
  const { results } = await api.readFromPageFrames(41, function reader() {}, [], "read", {
    accept: (value) => Boolean(value && value.ok),
  });
  const elapsed = Date.now() - started;

  assert.deepStrictEqual(results, [{ frameId: 0, ok: true }]);
  assert.ok(elapsed < 1000, "expected an early resolve, took " + elapsed + "ms");
});

test("without accept the same read waits for the ceiling", async () => {
  const { api } = loadSharedFrameHelpers({
    frameIds: [0, 7],
    hungFrame: 7,
    injectTimeoutMs: 300,
  });

  const started = Date.now();
  await api.readFromPageFrames(41, function reader() {}, [], "read");

  assert.ok(Date.now() - started >= 250, "expected it to wait for the hung frame");
});

/*
 * A cached frame list is a stale frame list — a frame created after it was
 * taken is invisible until it expires. Only a caller that says its operation
 * tolerates that gets one.
 */
test("discovery is fresh unless the caller opts into the cache", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  await api.readFromPageFrames(41, function reader() {}, [], "one");
  await api.readFromPageFrames(41, function reader() {}, [], "two");

  assert.strictEqual(broadcasts(calls).length, 2);
});

test("a burst of cache-tolerant reads discovers once", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  const opts = { cache: true };
  await api.readFromPageFrames(41, function reader() {}, [], "one", opts);
  await api.readFromPageFrames(41, function reader() {}, [], "two", opts);
  await api.readFromPageFrames(41, function reader() {}, [], "three", opts);

  assert.strictEqual(broadcasts(calls).length, 1);
});

test("parallel cache-tolerant reads share one discovery", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  const opts = { cache: true };
  await Promise.all([
    api.readFromPageFrames(41, function reader() {}, [], "one", opts),
    api.readFromPageFrames(41, function reader() {}, [], "two", opts),
    api.readFromPageFrames(41, function reader() {}, [], "three", opts),
  ]);

  assert.strictEqual(broadcasts(calls).length, 1);
});

test("the cached frame list expires", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [0, 7], ttlMs: 0 });

  const opts = { cache: true };
  await api.readFromPageFrames(41, function reader() {}, [], "one", opts);
  await api.readFromPageFrames(41, function reader() {}, [], "two", opts);

  assert.strictEqual(broadcasts(calls).length, 2);
});

/* A load starting means the frame tree is about to change. */
test("a navigation drops the cached frame list", async () => {
  const { api, calls, navigate } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  const opts = { cache: true };
  await api.readFromPageFrames(41, function reader() {}, [], "one", opts);
  navigate(41);
  await api.readFromPageFrames(41, function reader() {}, [], "two", opts);

  assert.strictEqual(broadcasts(calls).length, 2);
});

test("a navigation in another tab leaves this tab's cache alone", async () => {
  const { api, calls, navigate } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  const opts = { cache: true };
  await api.readFromPageFrames(41, function reader() {}, [], "one", opts);
  navigate(99);
  await api.readFromPageFrames(41, function reader() {}, [], "two", opts);

  assert.strictEqual(broadcasts(calls).length, 1);
});

test("the frame list is cached per tab, not globally", async () => {
  const { api, calls } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  const opts = { cache: true };
  await api.readFromPageFrames(41, function reader() {}, [], "one", opts);
  await api.readFromPageFrames(42, function reader() {}, [], "two", opts);

  assert.deepStrictEqual(broadcasts(calls).map((call) => call.tabId), [41, 42]);
});

test("a caller cannot mutate the cached frame list", async () => {
  const { api } = loadSharedFrameHelpers({ frameIds: [0, 7] });

  const first = await api.discoverContentFrames(41, "test", { cache: true });
  first.push(99);

  assert.deepStrictEqual(
    await api.discoverContentFrames(41, "test", { cache: true }),
    [0, 7]
  );
});

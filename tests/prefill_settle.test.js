/*
 * Tests for the GlideAjax settle tracking in fillPortalVariables.
 *
 *   node --test tests/prefill_settle.test.js
 *
 * DEV-ONLY, like its siblings. Prefill used to decide how long to wait after
 * setting a variable by matching the variable's NAME against a list collected
 * from one instance's catalog. That could not work anywhere else, so it now
 * watches GlideAjax instead and waits for the requests to go quiet.
 *
 * Watching means patching the page's own GlideAjax prototype, which is why
 * these tests are mostly about taking the patch back off. A patch left behind
 * would sit in front of every GlideAjax call the page makes for the rest of its
 * life, feeding a counter nobody reads.
 *
 * fillPortalVariables is injected with chrome.scripting.executeScript, so it is
 * a plain top-level function in background.js with no exports. It loads here by
 * wrapping the whole file in a Function whose parameters are the globals a
 * service worker would have supplied.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const GLOBALS = [
  "window", "document", "location", "self",
  "setTimeout", "clearTimeout", "chrome", "importScripts",
];

function loadFill(win) {
  const file = path.join(__dirname, "..", "background.js");
  const src = fs.readFileSync(file, "utf8");

  const chromeStub = {
    tabs: { onRemoved: { addListener() {} }, sendMessage() {}, query: async () => [] },
    runtime: { onMessage: { addListener() {} }, getURL: (p) => p, lastError: null },
    scripting: { executeScript: async () => [] },
    commands: { onCommand: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };

  const factory = new Function(
    ...GLOBALS,
    src + "\nreturn fillPortalVariables;"
  );
  return factory(
    win, win.document, win.location, win,
    win.setTimeout, win.clearTimeout, chromeStub, () => {}
  );
}

/*
 * A page with no catalog form: the fill finds nothing and returns almost
 * immediately, which is all these tests need. The point is what happens to
 * GlideAjax on the way in and out, not what gets filled.
 */
function makeWindow() {
  const doc = {
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    readyState: "complete",
    body: null,
    documentElement: null,
  };
  const win = {
    document: doc,
    location: {
      href: "https://example.service-now.com/sp?id=sc_cat_item",
      origin: "https://example.service-now.com",
      search: "?id=sc_cat_item",
    },
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
  win.window = win;
  win.self = win;
  win.top = win;
  win.parent = win;
  return win;
}

/*
 * The prototype records every assignment, so a wrapper installed and then
 * removed during the fill is still inspectable afterwards.
 */
function spyGlideAjax(win, methodNames) {
  const originals = {};
  const installed = {};
  const calls = [];
  const proto = {};

  for (const name of methodNames) {
    const original = function (...args) {
      calls.push({ method: name, args });
      return "original:" + name;
    };
    originals[name] = original;
    let current = original;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value) => {
        if (value !== original) installed[name] = value;
        current = value;
      },
    });
  }

  function GlideAjax(name) {
    this.name = name;
  }
  GlideAjax.prototype = proto;
  win.GlideAjax = GlideAjax;

  return { proto, originals, installed, calls };
}

const ALL = ["getXML", "getXMLAnswer", "getXMLWait"];

test("all three GlideAjax entry points are patched during the fill", async () => {
  const win = makeWindow();
  const spy = spyGlideAjax(win, ALL);
  const fill = loadFill(win);

  await fill([]);

  for (const name of ALL) {
    assert.ok(spy.installed[name], name + " was never patched");
    assert.notStrictEqual(spy.installed[name], spy.originals[name]);
  }
});

test("the patch is removed once the fill finishes — the reversibility rule", async () => {
  const win = makeWindow();
  const spy = spyGlideAjax(win, ALL);
  const fill = loadFill(win);

  await fill([]);

  for (const name of ALL) {
    assert.strictEqual(
      spy.proto[name],
      spy.originals[name],
      name + " was left patched after the fill"
    );
  }
});

test("a prototype carrying only some of the methods is still restored", async () => {
  const win = makeWindow();
  const spy = spyGlideAjax(win, ["getXML"]);
  const fill = loadFill(win);

  await fill([]);

  assert.ok(spy.installed.getXML, "the one available method should be patched");
  assert.strictEqual(spy.proto.getXML, spy.originals.getXML);
});

test("a page with no GlideAjax at all still completes the fill", async () => {
  const win = makeWindow();
  const fill = loadFill(win);

  const result = await fill([]);

  assert.ok(result, "the fill should return its result object");
  assert.strictEqual(result.filled, 0);
});

test("a callback is wrapped, and the caller's own callback still runs", async () => {
  const win = makeWindow();
  const spy = spyGlideAjax(win, ALL);
  const fill = loadFill(win);
  await fill([]);

  const seen = [];
  const userCallback = (answer) => seen.push(answer);
  spy.installed.getXML.call({}, userCallback);

  const forwarded = spy.calls.find((c) => c.method === "getXML");
  assert.ok(forwarded, "the original getXML should still be called");
  assert.notStrictEqual(
    forwarded.args[0],
    userCallback,
    "the callback should be wrapped so completion can be counted"
  );

  forwarded.args[0]("the answer");
  assert.deepStrictEqual(seen, ["the answer"], "the caller's callback must still fire");
});

test("a getXML with no callback is passed through untouched", async () => {
  const win = makeWindow();
  const spy = spyGlideAjax(win, ALL);
  const fill = loadFill(win);
  await fill([]);

  /* Counting a call whose completion cannot be observed would pin the counter
     open until the ceiling and slow down every variable after it. */
  spy.installed.getXML.call({});

  const forwarded = spy.calls.find((c) => c.method === "getXML");
  assert.ok(forwarded, "the original getXML should still be called");
  assert.strictEqual(forwarded.args.length, 0, "no callback should be invented");
});

test("extra arguments survive the wrapper", async () => {
  const win = makeWindow();
  const spy = spyGlideAjax(win, ALL);
  const fill = loadFill(win);
  await fill([]);

  spy.installed.getXML.call({}, () => {}, "second", 3);

  const forwarded = spy.calls.find((c) => c.method === "getXML");
  assert.deepStrictEqual(forwarded.args.slice(1), ["second", 3]);
});

test("a throwing getXML still releases its slot and propagates", async () => {
  const win = makeWindow();
  const spy = spyGlideAjax(win, ALL);
  const fill = loadFill(win);
  await fill([]);

  const boom = new Error("network is down");
  spy.proto.getXML = () => {
    throw boom;
  };

  assert.throws(() => spy.installed.getXML.call({}, () => {}), /network is down/);
});

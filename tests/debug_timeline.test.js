/*
 * Tests for the GlideAjax recording in debug_timeline_main.js.
 *
 *   node --test tests/debug_timeline.test.js
 *
 * DEV-ONLY, like its siblings. These exist because of a bug found on a real
 * instance: getXMLAnswer calls were recorded as nothing at all. Only getXML
 * and getXMLWait were patched, and getXMLAnswer does not reliably route
 * through getXML.
 *
 * The awkward part is that it does route through getXML on some platform
 * builds. So the fix has to record the call when it does not delegate, and
 * must not record it twice when it does — and both halves are covered here,
 * because only one of them can be observed on any given instance.
 *
 * The recorder is injected with chrome.scripting.executeScript, so it is a
 * pair of plain top-level functions with no exports. It loads here by being
 * wrapped in a Function whose parameters are the browser globals it leans on.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const GLOBALS = [
  "window", "document", "location", "self", "parent",
  "setInterval", "clearInterval", "setTimeout", "clearTimeout",
  "XMLHttpRequest", "addEventListener", "removeEventListener",
];

function loadRecorder() {
  const file = path.join(__dirname, "..", "debug_timeline_main.js");
  const src = fs.readFileSync(file, "utf8");

  const doc = {
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [], querySelector: () => null,
    documentElement: null, readyState: "complete",
  };
  const win = {
    document: doc,
    location: { href: "https://example.service-now.com/nav_to.do" },
    addEventListener() {}, removeEventListener() {},
    setInterval: () => 0, clearInterval() {},
    setTimeout: () => 0, clearTimeout() {},
    XMLHttpRequest: function () {},
  };
  win.window = win;
  win.self = win;
  win.parent = win;
  win.top = win;

  const factory = new Function(
    ...GLOBALS,
    src + "\nreturn { start: startDebugTimelineInPage, stop: stopDebugTimelineInPage };"
  );
  const api = factory(
    win, doc, win.location, win, win,
    win.setInterval, win.clearInterval, win.setTimeout, win.clearTimeout,
    win.XMLHttpRequest, win.addEventListener, win.removeEventListener
  );
  return { api, win };
}

/*
 * `delegates` picks which platform shape to imitate: getXMLAnswer calling
 * getXML internally, or going its own way.
 */
function installGlideAjax(win, { delegates }) {
  function GlideAjax(name) {
    this.name = name;
    this.params = {};
  }
  GlideAjax.prototype.addParam = function (key, value) {
    this.params[key] = value;
  };
  GlideAjax.prototype.getProcessor = function () {
    return this.name;
  };
  GlideAjax.prototype.getXML = function (callback) {
    if (callback) callback({ responseXML: null });
  };
  GlideAjax.prototype.getXMLAnswer = delegates
    ? function (callback) {
        this.getXML(() => {
          if (callback) callback("2399.00");
        });
      }
    : function (callback) {
        if (callback) callback("2399.00");
      };
  GlideAjax.prototype.getXMLWait = function () {};
  win.GlideAjax = GlideAjax;
  return GlideAjax;
}

function record(win, api, run) {
  api.start();
  run();
  return api.stop().events;
}

const glideAjaxEvents = (events) =>
  events.filter((event) => event.category === "glideajax");

test("getXMLAnswer is recorded at all — the bug this fixes", () => {
  const { api, win } = loadRecorder();
  installGlideAjax(win, { delegates: false });

  const events = record(win, api, () => {
    const ajax = new win.GlideAjax("AssetAjax");
    ajax.addParam("sysparm_name", "getModelPrice");
    ajax.getXMLAnswer(() => {});
  });

  const calls = glideAjaxEvents(events);
  assert.equal(calls.length, 2, "expected one start and one complete");
  assert.equal(calls[0].action, "start");
  assert.equal(calls[1].action, "complete");
});

test("the Script Include and method reach the event", () => {
  const { api, win } = loadRecorder();
  installGlideAjax(win, { delegates: false });

  const events = record(win, api, () => {
    const ajax = new win.GlideAjax("AssetAjax");
    ajax.addParam("sysparm_name", "getModelPrice");
    ajax.getXMLAnswer(() => {});
  });

  const start = glideAjaxEvents(events)[0];
  assert.equal(start.details.className, "AssetAjax");
  assert.equal(start.details.method, "getModelPrice");
  assert.match(start.summary, /AssetAjax\.getModelPrice/);
});

test("the answer string is captured — getXMLAnswer hands back a string, not an XHR", () => {
  const { api, win } = loadRecorder();
  installGlideAjax(win, { delegates: false });

  const events = record(win, api, () => {
    const ajax = new win.GlideAjax("AssetAjax");
    ajax.addParam("sysparm_name", "getModelPrice");
    ajax.getXMLAnswer(() => {});
  });

  const done = glideAjaxEvents(events)[1];
  assert.ok(done.details.response, "expected a response on the complete event");
  assert.equal(done.details.response.answerLength, "2399.00".length);
  assert.equal(typeof done.details.durationMs, "number");
});

test("params are captured and secret-looking ones are redacted", () => {
  const { api, win } = loadRecorder();
  installGlideAjax(win, { delegates: false });

  const events = record(win, api, () => {
    const ajax = new win.GlideAjax("AssetAjax");
    ajax.addParam("sysparm_name", "getModelPrice");
    ajax.addParam("sysparm_model", "macbook_pro_16");
    ajax.addParam("sysparm_user_token", "abc123secret");
    ajax.getXMLAnswer(() => {});
  });

  const params = glideAjaxEvents(events)[0].details.params;
  assert.equal(params.sysparm_model, "macbook_pro_16");
  assert.equal(params.sysparm_user_token, "[REDACTED]");
  assert.ok(
    !JSON.stringify(params).includes("abc123secret"),
    "the secret value must not survive anywhere in the params"
  );
});

test("the consumer's callback still runs and still receives the answer", () => {
  const { api, win } = loadRecorder();
  installGlideAjax(win, { delegates: false });

  let seen = null;
  record(win, api, () => {
    const ajax = new win.GlideAjax("AssetAjax");
    ajax.addParam("sysparm_name", "getModelPrice");
    ajax.getXMLAnswer((answer) => {
      seen = answer;
    });
  });

  assert.equal(seen, "2399.00", "recording must not swallow or alter the answer");
});

test("a getXMLAnswer that delegates to getXML is recorded once, not twice", () => {
  const { api, win } = loadRecorder();
  installGlideAjax(win, { delegates: true });

  const events = record(win, api, () => {
    const ajax = new win.GlideAjax("AssetAjax");
    ajax.addParam("sysparm_name", "getModelPrice");
    ajax.getXMLAnswer(() => {});
  });

  const calls = glideAjaxEvents(events);
  assert.equal(calls.length, 2, "one logical request must not produce two pairs");
  assert.equal(calls.filter((e) => e.action === "start").length, 1);
  assert.equal(calls.filter((e) => e.action === "complete").length, 1);
});

test("a direct getXML on the same instance is still recorded afterwards", () => {
  const { api, win } = loadRecorder();
  installGlideAjax(win, { delegates: true });

  const events = record(win, api, () => {
    const ajax = new win.GlideAjax("AssetAjax");
    ajax.addParam("sysparm_name", "getModelPrice");
    ajax.getXMLAnswer(() => {});
    /* The suppression flag is per-instance; if it leaked past the delegating
     * call, this second request would go missing. */
    ajax.getXML(() => {});
  });

  assert.equal(glideAjaxEvents(events).length, 4, "expected two full pairs");
});

test("plain getXML keeps working — the guard must not silence it", () => {
  const { api, win } = loadRecorder();
  installGlideAjax(win, { delegates: false });

  const events = record(win, api, () => {
    const ajax = new win.GlideAjax("AssetAjax");
    ajax.addParam("sysparm_name", "getModelPrice");
    ajax.getXML(() => {});
  });

  assert.equal(glideAjaxEvents(events).length, 2);
});

test("the getXMLAnswer patch is reversible", () => {
  const { api, win } = loadRecorder();
  const GlideAjax = installGlideAjax(win, { delegates: false });
  const before = GlideAjax.prototype.getXMLAnswer;

  api.start();
  assert.notEqual(
    GlideAjax.prototype.getXMLAnswer,
    before,
    "expected the method to be wrapped while recording"
  );
  api.stop();

  assert.equal(
    GlideAjax.prototype.getXMLAnswer,
    before,
    "stopping must put the original method back"
  );
});

test("a throwing getXMLAnswer is reported and the error still propagates", () => {
  const { api, win } = loadRecorder();
  const GlideAjax = installGlideAjax(win, { delegates: false });
  GlideAjax.prototype.getXMLAnswer = function () {
    throw new Error("processor unavailable");
  };

  api.start();
  const ajax = new win.GlideAjax("AssetAjax");
  ajax.addParam("sysparm_name", "getModelPrice");
  assert.throws(() => ajax.getXMLAnswer(() => {}), /processor unavailable/);
  const events = api.stop().events;

  const errors = events.filter((event) => event.category === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].summary, /threw: processor unavailable/);
});

/* ---------------------------------------------------------------------------
 * Frame URLs. A trace records which frame an event came from; it must not
 * carry the record along with it. ServiceNow hides record context in three
 * places, and only one of them is the query string.
 * ------------------------------------------------------------------------ */

function loadSafeFrameUrl() {
  const src = fs
    .readFileSync(path.join(__dirname, "..", "debug_timeline_main.js"), "utf8")
    .replace(/\r\n/g, "\n");
  const start = src.indexOf("  const safeFrameUrl");
  const end = src.indexOf("\n  };\n", start) + "\n  };\n".length;
  assert.ok(start >= 0 && end > start, "safeFrameUrl not found");
  const body = src.slice(start, end);
  return (href) =>
    new Function("location", body + "\nreturn safeFrameUrl;")({ href })();
}

const safeFrameUrl = loadSafeFrameUrl();
const SYS_ID = "1a2b3c4d5e6f70819a2b3c4d5e6f7081";

test("a classic form keeps the page and drops the record and the filter", () => {
  const out = safeFrameUrl(
    "https://x.service-now.com/incident.do?sys_id=" +
      SYS_ID +
      "&sysparm_query=assigned_to%3Djoe"
  );
  assert.ok(out.indexOf(SYS_ID) === -1, out);
  assert.ok(out.indexOf("assigned_to") === -1, out);
  assert.ok(out.indexOf("/incident.do") >= 0, out);
  assert.ok(/2 parameters removed/.test(out), out);
});

test("a Workspace route carries its record in the path, and loses it", () => {
  const out = safeFrameUrl(
    "https://x.service-now.com/now/workspace/agent/record/incident/" + SYS_ID
  );
  assert.ok(out.indexOf(SYS_ID) === -1, out);
  assert.ok(out.indexOf("/record/incident/<id>") >= 0, out);
});

test("an encoded Polaris target hides a whole URL in one segment", () => {
  const out = safeFrameUrl(
    "https://x.service-now.com/now/nav/ui/classic/params/target/incident.do%3Fsys_id%3D" +
      SYS_ID +
      "%26sysparm_query%3Dactive%3Dtrue"
  );
  assert.ok(out.indexOf(SYS_ID) === -1, out);
  assert.ok(out.indexOf("sysparm_query") === -1, out);
  assert.ok(out.indexOf("<target>") >= 0, out);
});

test("a portal page keeps which page it is and drops which record", () => {
  const out = safeFrameUrl(
    "https://x.service-now.com/sp?id=sc_cat_item&sys_id=" + SYS_ID
  );
  assert.ok(out.indexOf("id=sc_cat_item") >= 0, out);
  assert.ok(out.indexOf(SYS_ID) === -1, out);
});

test("an id-shaped value is dropped even under an allowlisted key", () => {
  const out = safeFrameUrl("https://x.service-now.com/sp?id=" + SYS_ID);
  assert.ok(out.indexOf(SYS_ID) === -1, out);
});

test("every dimension is bounded, because this string lands in 1000 events", () => {
  const long = safeFrameUrl(
    "https://x.service-now.com/" + Array(40).fill("segment").join("/")
  );
  assert.ok(long.length <= 320, "length " + long.length);
  const segments = long.split("/").slice(3);
  assert.strictEqual(segments.filter((part) => part === "segment").length, 8, long);
  assert.strictEqual(segments[segments.length - 1], "…", long);

  const wide = safeFrameUrl(
    "https://x.service-now.com/x?" +
      Array(50)
        .fill(0)
        .map((_, i) => "id=v" + i)
        .join("&")
  );
  assert.ok(wide.length <= 320, "length " + wide.length);

  const deep = safeFrameUrl(
    "https://x.service-now.com/" + "a".repeat(5000) + "?id=" + "b".repeat(5000)
  );
  assert.ok(deep.length <= 320, "length " + deep.length);
});

test("an unparseable location never throws into the recorder", () => {
  assert.strictEqual(safeFrameUrl("not a url"), "");
});

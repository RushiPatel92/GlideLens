/*
 * MAIN-world Debug Timeline recorder.
 *
 * These functions are injected with chrome.scripting.executeScript, so each
 * entry point must remain self-contained and must return plain serializable
 * data to the service worker.
 */

function startDebugTimelineInPage() {
  const stateKey = "__SN_DEV_HELPER_DEBUG_TIMELINE__";
  /* A frame URL is recorded so a developer can tell which frame an event came
   * from -- not to carry record data into a trace that gets pasted into an
   * issue. ServiceNow keeps the interesting things in the query string:
   * sysparm_query holds filter values, and sys_id names a record. Keep the
   * origin, the path, and only the parameters that say which page is open;
   * count the rest and drop them, so a reader can see that something was
   * removed rather than wondering.
   *
   * Deliberately duplicated in the other entry point below: every function in
   * this file is injected standalone by executeScript and cannot share a
   * helper. If you change one copy, change the other. */
  const safeFrameUrl = () => {
    const KEEP = ["id", "table", "sysparm_view"];
    try {
      const url = new URL(location.href);
      const kept = [];
      let dropped = 0;
      url.searchParams.forEach((value, key) => {
        if (KEEP.indexOf(key) >= 0 && String(value).length <= 80) {
          kept.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
        } else {
          dropped += 1;
        }
      });
      return (
        url.origin +
        url.pathname +
        (kept.length ? "?" + kept.join("&") : "") +
        (dropped ? " (" + dropped + " parameter" + (dropped === 1 ? "" : "s") + " removed)" : "")
      );
    } catch (e) {
      return "";
    }
  };

  const existing = window[stateKey];
  if (existing && existing.active) {
    return {
      ok: true,
      alreadyActive: true,
      frameUrl: safeFrameUrl(),
      startedAt: existing.startedAt,
      capabilities: existing.capabilities,
    };
  }
  if (existing && typeof existing.restore === "function") {
    try {
      existing.restore();
    } catch (e) {}
  }

  const state = {
    active: true,
    startedAt: Date.now(),
    events: [],
    sequence: 0,
    maxEvents: 1000,
    patches: [],
    cleanups: [],
    inputTimers: new Map(),
    capabilities: {
      gFormInstances: 0,
      nativeFields: true,
      glideAjax: false,
      errors: true,
    },
  };
  window[stateKey] = state;

  /* `sysparm_ck` and `g_ck` are ServiceNow's own session token under a name
   * that matches none of the generic words, so they are named explicitly. */
  const sensitivePattern =
    /(password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|authorization|sysparm_ck|g_ck)/i;

  const truncate = (value, maxLength) => {
    const text = String(value == null ? "" : value);
    return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
  };

  const safeValue = (value, fieldName) => {
    if (sensitivePattern.test(String(fieldName || ""))) return "[REDACTED]";
    if (value == null) return value;
    if (typeof value === "string") return truncate(value, 500);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => safeValue(item, fieldName));
    }
    try {
      return truncate(JSON.stringify(value), 1000);
    } catch (e) {
      return truncate(value, 500);
    }
  };

  const formValuesMatch = (currentValue, requestedValue) => {
    const normalize = (value) => {
      if (value == null) return "";
      if (Array.isArray(value)) return value.map((item) => String(item)).join(",");
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return String(value);
      }
      return null;
    };
    const current = normalize(currentValue);
    const requested = normalize(requestedValue);
    return current !== null && requested !== null && current === requested;
  };

  const captureStack = () => {
    try {
      return String(new Error().stack || "")
        .split("\n")
        .slice(2, 14)
        .join("\n")
        .slice(0, 4000);
    } catch (e) {
      return "";
    }
  };

  const addEvent = (category, action, summary, details, stack) => {
    if (!state.active) return null;
    const now = Date.now();
    const event = {
      id: ++state.sequence,
      time: now,
      elapsedMs: now - state.startedAt,
      category,
      action,
      summary: truncate(summary, 300),
      details: details || {},
      stack: stack || "",
      frameUrl: safeFrameUrl(),
    };
    state.events.push(event);
    if (state.events.length > state.maxEvents) state.events.shift();
    return event;
  };

  const installPatch = (target, methodName, makeWrapper) => {
    if (!target) return false;
    let original;
    let hadOwnProperty = false;
    let originalDescriptor = null;
    try {
      original = target[methodName];
      hadOwnProperty = Object.prototype.hasOwnProperty.call(target, methodName);
      originalDescriptor = hadOwnProperty
        ? Object.getOwnPropertyDescriptor(target, methodName)
        : null;
    } catch (e) {
      return false;
    }
    if (typeof original !== "function") return false;
    if (state.patches.some((patch) => patch.target === target && patch.methodName === methodName)) {
      return true;
    }

    let wrapper;
    try {
      wrapper = makeWrapper(original);
      target[methodName] = wrapper;
      if (target[methodName] !== wrapper) return false;
      state.patches.push({
        target,
        methodName,
        original,
        originalDescriptor,
        hadOwnProperty,
        wrapper,
      });
      return true;
    } catch (e) {
      try {
        if (wrapper && target[methodName] === wrapper) {
          if (hadOwnProperty && originalDescriptor) {
            Object.defineProperty(target, methodName, originalDescriptor);
          } else {
            delete target[methodName];
          }
        }
      } catch (restoreError) {}
      return false;
    }
  };

  const isGForm = (candidate) =>
    candidate &&
    typeof candidate.getValue === "function" &&
    typeof candidate.setValue === "function";

  const patchedGForms = new WeakSet();
  const gFormMethods = [
    "setValue",
    "clearValue",
    "setMandatory",
    "setVisible",
    "setDisplay",
    "setReadOnly",
    "setDisabled",
    "showFieldMsg",
    "hideFieldMsg",
    "addOption",
    "removeOption",
    "clearOptions",
  ];

  const patchGForm = (gForm) => {
    if (!isGForm(gForm) || patchedGForms.has(gForm)) return;
    let patchedAny = false;

    gFormMethods.forEach((methodName) => {
      const patched = installPatch(gForm, methodName, (original) => {
        return function (...args) {
          const fieldName = String(args[0] == null ? "" : args[0]);
          const stack = captureStack();
          let comparableOldValue;
          let oldValue;
          if (fieldName && typeof this.getValue === "function") {
            try {
              comparableOldValue = this.getValue(fieldName);
              oldValue = safeValue(comparableOldValue, fieldName);
            } catch (e) {}
          }

          try {
            const returnValue = original.apply(this, args);
            const details = {
              field: fieldName,
              arguments: args.slice(1, 6).map((arg) => safeValue(arg, fieldName)),
            };
            if (oldValue !== undefined) details.oldValue = oldValue;
            if (
              methodName === "setValue" &&
              oldValue !== undefined &&
              formValuesMatch(comparableOldValue, args[1])
            ) {
              details.noValueChange = true;
            }
            addEvent(
              "g_form",
              methodName,
              methodName + (fieldName ? '("' + fieldName + '")' : "()"),
              details,
              stack
            );
            return returnValue;
          } catch (error) {
            addEvent(
              "error",
              methodName,
              methodName + " threw: " + truncate(error && error.message ? error.message : error, 220),
              {
                field: fieldName,
                arguments: args.slice(1, 6).map((arg) => safeValue(arg, fieldName)),
              },
              stack
            );
            throw error;
          }
        };
      });
      patchedAny = patchedAny || patched;
    });

    if (patchedAny) {
      patchedGForms.add(gForm);
      state.capabilities.gFormInstances++;
    }
  };

  const discoverGForms = () => {
    const candidates = [];
    const add = (candidate) => {
      if (isGForm(candidate) && candidates.indexOf(candidate) < 0) candidates.push(candidate);
    };
    const scan = (obj, depth, seen) => {
      if (!obj || typeof obj !== "object" || depth > 3 || seen.indexOf(obj) >= 0) return;
      seen.push(obj);
      add(obj);
      ["g_form", "gForm", "page", "c", "data", "$parent"].forEach((key) => {
        try {
          scan(obj[key], depth + 1, seen);
        } catch (e) {}
      });
      try {
        if (typeof obj.getGlideForm === "function") add(obj.getGlideForm());
      } catch (e) {}
    };

    try {
      if (typeof g_form !== "undefined") add(g_form);
    } catch (e) {}

    try {
      const angular = window.angular;
      if (angular && angular.element) {
        const elements = Array.from(
          document.querySelectorAll(
            "#sc_cat_item,sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model],[ng-controller]"
          )
        ).slice(0, 80);
        elements.forEach((element) => {
          try {
            const wrapped = angular.element(element);
            if (wrapped.scope) scan(wrapped.scope(), 0, []);
            if (wrapped.isolateScope) scan(wrapped.isolateScope(), 0, []);
          } catch (e) {}
        });
      }
    } catch (e) {}

    candidates.forEach(patchGForm);
  };

  const fieldIdentity = (element) => {
    if (!element || !element.getAttribute) return "";
    return String(
      element.getAttribute("data-field-name") ||
        element.getAttribute("data-variable-name") ||
        element.getAttribute("data-name") ||
        element.getAttribute("name") ||
        element.id ||
        element.getAttribute("aria-label") ||
        ""
    ).trim();
  };

  const fieldValue = (element, fieldName) => {
    if (!element) return "";
    if (sensitivePattern.test(fieldName) || String(element.type || "").toLowerCase() === "password") {
      return "[REDACTED]";
    }
    if (String(element.type || "").toLowerCase() === "checkbox") {
      return Boolean(element.checked);
    }
    if (String(element.type || "").toLowerCase() === "radio") {
      return element.checked ? safeValue(element.value, fieldName) : "[not selected]";
    }
    if (element.isContentEditable) return truncate(element.textContent || "", 500);
    return safeValue(element.value, fieldName);
  };

  const recordNativeFieldEvent = (event) => {
    const element = event && event.target;
    if (
      !element ||
      !element.matches ||
      !element.matches("input,textarea,select,[contenteditable='true']")
    ) {
      return;
    }
    const fieldName = fieldIdentity(element);
    addEvent(
      "field",
      event.type,
      event.type + (fieldName ? ': "' + fieldName + '"' : " event"),
      {
        field: fieldName,
        value: fieldValue(element, fieldName),
        tag: String(element.tagName || "").toLowerCase(),
        type: String(element.type || "").toLowerCase(),
        trusted: Boolean(event.isTrusted),
      },
      captureStack()
    );
  };

  const onInput = (event) => {
    const element = event && event.target;
    if (!element) return;
    const previous = state.inputTimers.get(element);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      state.inputTimers.delete(element);
      recordNativeFieldEvent(event);
    }, 250);
    state.inputTimers.set(element, timer);
  };
  const onChange = (event) => {
    const element = event && event.target;
    const pending = element && state.inputTimers.get(element);
    if (pending) {
      clearTimeout(pending);
      state.inputTimers.delete(element);
    }
    recordNativeFieldEvent(event);
  };
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onChange, true);
  state.cleanups.push(() => document.removeEventListener("input", onInput, true));
  state.cleanups.push(() => document.removeEventListener("change", onChange, true));

  const onError = (event) => {
    addEvent(
      "error",
      "error",
      truncate((event && event.message) || "JavaScript error", 300),
      {
        file: truncate((event && event.filename) || "", 500),
        line: (event && event.lineno) || 0,
        column: (event && event.colno) || 0,
      },
      truncate((event && event.error && event.error.stack) || "", 4000)
    );
  };
  const onUnhandledRejection = (event) => {
    const reason = event && event.reason;
    addEvent(
      "error",
      "unhandledrejection",
      "Unhandled promise rejection: " +
        truncate(reason && reason.message ? reason.message : reason, 240),
      {},
      truncate((reason && reason.stack) || "", 4000)
    );
  };
  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onUnhandledRejection, true);
  state.cleanups.push(() => window.removeEventListener("error", onError, true));
  state.cleanups.push(() =>
    window.removeEventListener("unhandledrejection", onUnhandledRejection, true)
  );

  const glideAjaxMetadata = new WeakMap();
  const patchedGlideAjaxPrototypes = new WeakSet();
  /* Instances whose request is already being recorded by an outer wrapper. */
  const glideAjaxOwnedElsewhere = new WeakSet();

  const glideAjaxInfo = (instance) => {
    const metadata = glideAjaxMetadata.get(instance) || { params: {} };
    let className = "";
    try {
      className =
        (typeof instance.getProcessor === "function" && instance.getProcessor()) ||
        instance.processor ||
        instance.className ||
        instance.name ||
        "";
    } catch (e) {}
    return {
      className: String(className || "GlideAjax"),
      method: String(metadata.params.sysparm_name || ""),
      params: Object.assign({}, metadata.params),
    };
  };

  const sanitizeGlideAjaxResponseValue = (value, key, depth) => {
    if (sensitivePattern.test(String(key || ""))) return "[REDACTED]";
    if (depth > 6) return "[MAX DEPTH]";
    if (value == null || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") return truncate(value, 4000);
    if (Array.isArray(value)) {
      return value
        .slice(0, 50)
        .map((item) => sanitizeGlideAjaxResponseValue(item, "", depth + 1));
    }
    if (typeof value === "object") {
      const sanitized = {};
      Object.keys(value)
        .slice(0, 50)
        .forEach((property) => {
          sanitized[property] = sanitizeGlideAjaxResponseValue(
            value[property],
            property,
            depth + 1
          );
        });
      return sanitized;
    }
    return truncate(value, 4000);
  };

  /* Mask the value in `key=value`, `key: value`, `"key": "value"` and
   * `<key>value</key>` shapes when the key looks sensitive. Deliberately
   * conservative: it never tries to understand the payload, it only refuses to
   * carry the obvious secrets through verbatim. A missed shape is still
   * truncated, and still only leaves the page when the user copies the trace. */
  const SENSITIVE_KEY_SOURCE =
    "[A-Za-z0-9_-]*(?:password|passwd|secret|token|credential|api[_-]?key|" +
    "private[_-]?key|authorization|sysparm_ck|g_ck)[A-Za-z0-9_-]*";

  const redactSensitiveText = (text) => {
    const source = String(text == null ? "" : text);
    if (!sensitivePattern.test(source)) return source;
    const key = SENSITIVE_KEY_SOURCE;
    return source
      /* <token>value</token>, including <token attr="x">value</token> */
      .replace(
        new RegExp("(<(?:" + key + ")\\b[^>]*>)[^<]{1,4000}", "gi"),
        "$1[REDACTED]"
      )
      /* "token": "value", 'token': value, token : value */
      .replace(
        new RegExp(
          "([\"']?)(" + key + ")\\1(\\s*:\\s*)([\"']?)[^,;&\\r\\n\"']{1,4000}\\4",
          "gi"
        ),
        "$1$2$1$3$4[REDACTED]$4"
      )
      /* token=value in a query-ish or form-ish body */
      .replace(
        new RegExp("(^|[^A-Za-z0-9_-])(" + key + ")=[^&;\\s]{1,4000}", "gi"),
        "$1$2=[REDACTED]"
      );
  };

  const glideAjaxResponseInfo = (response) => {
    let answer;
    let status;
    try {
      if (typeof response === "string") {
        answer = response;
      } else if (response) {
        if (typeof response.status === "number") status = response.status;
        const responseXml =
          response.responseXML ||
          (response.documentElement ? response : null);
        const root = responseXml && responseXml.documentElement;
        if (root && typeof root.getAttribute === "function") {
          answer = root.getAttribute("answer");
        }
      }
    } catch (e) {}

    const result = {};
    if (status !== undefined) result.status = status;
    if (answer !== undefined && answer !== null) {
      const answerText = String(answer);
      result.answerLength = answerText.length;
      result.truncated = answerText.length > 4000;
      try {
        result.answer = sanitizeGlideAjaxResponseValue(
          JSON.parse(answerText),
          "",
          0
        );
        result.format = "json";
      } catch (e) {
        /* Not JSON, so there are no keys to walk -- and until now that meant no
         * redaction at all. A processor answering with XML, HTML or a plain
         * `name=value` body could put a token or a password straight into a
         * trace the user then pastes into an issue. Mask the value half of any
         * sensitive-looking pair before truncating. */
        result.answer = truncate(redactSensitiveText(answerText), 4000);
        result.format = "text";
        result.redacted = result.answer.indexOf("[REDACTED]") >= 0;
      }
    }
    return Object.keys(result).length ? result : null;
  };

  const patchGlideAjax = () => {
    let prototype;
    try {
      prototype = window.GlideAjax && window.GlideAjax.prototype;
    } catch (e) {
      return;
    }
    if (!prototype || patchedGlideAjaxPrototypes.has(prototype)) return;

    installPatch(prototype, "addParam", (original) => {
      return function (name, value) {
        const result = original.apply(this, arguments);
        const metadata = glideAjaxMetadata.get(this) || { params: {} };
        metadata.params[String(name || "")] = safeValue(value, name);
        glideAjaxMetadata.set(this, metadata);
        return result;
      };
    });

    installPatch(prototype, "getXML", (original) => {
      return function (...args) {
        /* getXMLAnswer records the call itself. On platform versions where it
         * delegates here, this would otherwise emit a second start/complete
         * pair for one logical request. The flag is set synchronously around
         * the delegating call, which is when this wrapper decides both whether
         * to announce a start and whether to wrap the callback — so checking it
         * here is enough to stay silent for the whole request. */
        if (glideAjaxOwnedElsewhere.has(this)) return original.apply(this, args);

        const info = glideAjaxInfo(this);
        const started = Date.now();
        const stack = captureStack();
        const label =
          info.className + (info.method ? "." + info.method : "") + " started";
        addEvent("glideajax", "start", label, info, stack);

        if (typeof args[0] === "function") {
          const callback = args[0];
          args[0] = function (...callbackArgs) {
            const durationMs = Date.now() - started;
            const response = glideAjaxResponseInfo(callbackArgs[0]);
            addEvent(
              "glideajax",
              "complete",
              info.className +
                (info.method ? "." + info.method : "") +
                " completed in " +
                durationMs +
                " ms",
              Object.assign(
                {},
                info,
                { durationMs },
                response ? { response } : {}
              ),
              ""
            );
            return callback.apply(this, callbackArgs);
          };
        }

        try {
          return original.apply(this, args);
        } catch (error) {
          addEvent(
            "error",
            "glideajax",
            info.className +
              (info.method ? "." + info.method : "") +
              " threw: " +
              truncate(error && error.message ? error.message : error, 200),
            Object.assign({}, info, { durationMs: Date.now() - started }),
            stack
          );
          throw error;
        }
      };
    });

    /*
     * getXMLAnswer is the common convenience form, and it is NOT reliably
     * routed through the patched getXML — on a real instance these calls were
     * recorded as nothing at all. It differs in one way that matters: the
     * callback receives the answer STRING directly rather than an
     * XMLHttpRequest, which glideAjaxResponseInfo already handles.
     */
    installPatch(prototype, "getXMLAnswer", (original) => {
      return function (...args) {
        const info = glideAjaxInfo(this);
        const started = Date.now();
        const stack = captureStack();
        addEvent(
          "glideajax",
          "start",
          info.className + (info.method ? "." + info.method : "") + " started",
          info,
          stack
        );

        if (typeof args[0] === "function") {
          const callback = args[0];
          args[0] = function (...callbackArgs) {
            const durationMs = Date.now() - started;
            const response = glideAjaxResponseInfo(callbackArgs[0]);
            addEvent(
              "glideajax",
              "complete",
              info.className +
                (info.method ? "." + info.method : "") +
                " completed in " +
                durationMs +
                " ms",
              Object.assign(
                {},
                info,
                { durationMs },
                response ? { response } : {}
              ),
              ""
            );
            return callback.apply(this, callbackArgs);
          };
        }

        glideAjaxOwnedElsewhere.add(this);
        try {
          return original.apply(this, args);
        } catch (error) {
          addEvent(
            "error",
            "glideajax",
            info.className +
              (info.method ? "." + info.method : "") +
              " threw: " +
              truncate(error && error.message ? error.message : error, 200),
            Object.assign({}, info, { durationMs: Date.now() - started }),
            stack
          );
          throw error;
        } finally {
          /* Cleared synchronously: any inner getXML has already run and made
           * its decision by now, and a later retry on this instance should be
           * recorded normally. */
          glideAjaxOwnedElsewhere.delete(this);
        }
      };
    });

    installPatch(prototype, "getXMLWait", (original) => {
      return function (...args) {
        const info = glideAjaxInfo(this);
        const started = Date.now();
        const stack = captureStack();
        try {
          const result = original.apply(this, args);
          const durationMs = Date.now() - started;
          let response = glideAjaxResponseInfo(result);
          if (!response && typeof this.getAnswer === "function") {
            try {
              response = glideAjaxResponseInfo(this.getAnswer());
            } catch (e) {}
          }
          addEvent(
            "glideajax",
            "complete",
              info.className +
                (info.method ? "." + info.method : "") +
                " completed synchronously in " +
                durationMs +
                " ms",
            Object.assign(
              {},
              info,
              { durationMs },
              response ? { response } : {}
            ),
            stack
          );
          return result;
        } catch (error) {
          addEvent(
            "error",
            "glideajax",
            info.className +
              (info.method ? "." + info.method : "") +
              " threw: " +
              truncate(error && error.message ? error.message : error, 200),
            Object.assign({}, info, { durationMs: Date.now() - started }),
            stack
          );
          throw error;
        }
      };
    });

    patchedGlideAjaxPrototypes.add(prototype);
    state.capabilities.glideAjax = true;
  };

  discoverGForms();
  patchGlideAjax();
  const discoveryTimer = setInterval(() => {
    discoverGForms();
    patchGlideAjax();
  }, 1000);
  state.cleanups.push(() => clearInterval(discoveryTimer));

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    state.active = false;

    state.inputTimers.forEach((timer) => clearTimeout(timer));
    state.inputTimers.clear();
    state.cleanups.splice(0).reverse().forEach((cleanup) => {
      try {
        cleanup();
      } catch (e) {}
    });
    state.patches.splice(0).reverse().forEach((patch) => {
      try {
        if (patch.target[patch.methodName] === patch.wrapper) {
          if (patch.hadOwnProperty && patch.originalDescriptor) {
            Object.defineProperty(
              patch.target,
              patch.methodName,
              patch.originalDescriptor
            );
          } else {
            delete patch.target[patch.methodName];
          }
        }
      } catch (e) {}
    });
  };

  const onPageHide = () => restore();
  window.addEventListener("pagehide", onPageHide, { once: true });
  state.cleanups.push(() => window.removeEventListener("pagehide", onPageHide));

  state.restore = restore;
  state.stop = () => {
    const result = {
      ok: true,
      active: false,
      frameUrl: safeFrameUrl(),
      startedAt: state.startedAt,
      stoppedAt: Date.now(),
      events: state.events.slice(),
      capabilities: Object.assign({}, state.capabilities),
      truncated: state.sequence > state.maxEvents,
    };
    restore();
    return result;
  };

  return {
    ok: true,
    alreadyActive: false,
    frameUrl: safeFrameUrl(),
    startedAt: state.startedAt,
    capabilities: Object.assign({}, state.capabilities),
  };
}

function stopDebugTimelineInPage() {
  const stateKey = "__SN_DEV_HELPER_DEBUG_TIMELINE__";
  /* A frame URL is recorded so a developer can tell which frame an event came
   * from -- not to carry record data into a trace that gets pasted into an
   * issue. ServiceNow keeps the interesting things in the query string:
   * sysparm_query holds filter values, and sys_id names a record. Keep the
   * origin, the path, and only the parameters that say which page is open;
   * count the rest and drop them, so a reader can see that something was
   * removed rather than wondering.
   *
   * Deliberately duplicated from the entry point above: every function in
   * this file is injected standalone by executeScript and cannot share a
   * helper. If you change one copy, change the other. */
  const safeFrameUrl = () => {
    const KEEP = ["id", "table", "sysparm_view"];
    try {
      const url = new URL(location.href);
      const kept = [];
      let dropped = 0;
      url.searchParams.forEach((value, key) => {
        if (KEEP.indexOf(key) >= 0 && String(value).length <= 80) {
          kept.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
        } else {
          dropped += 1;
        }
      });
      return (
        url.origin +
        url.pathname +
        (kept.length ? "?" + kept.join("&") : "") +
        (dropped ? " (" + dropped + " parameter" + (dropped === 1 ? "" : "s") + " removed)" : "")
      );
    } catch (e) {
      return "";
    }
  };

  const state = window[stateKey];
  if (!state || typeof state.stop !== "function") {
    return {
      ok: true,
      active: false,
      frameUrl: safeFrameUrl(),
      events: [],
      notRunning: true,
    };
  }
  const result = state.stop();
  try {
    delete window[stateKey];
  } catch (e) {
    window[stateKey] = null;
  }
  return result;
}

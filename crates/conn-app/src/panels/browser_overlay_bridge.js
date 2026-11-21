// Page-side bridge connecting Conn's `@t3tools/annotation-overlay` (`inject.js`) to `conn-gpui`
// over CEF's suppressed `__CONN_OVERLAY_RPC__:` console message channel.
//
// Mirrors `apps/desktop/src/preview/{ConnAnnotationsPreload,AnnotatorHostPreload}.ts` and
// `packages/shared/src/annotationBridge.ts`.
(() => {
  const PREFIX = "__CONN_OVERLAY_RPC__:";
  const TIMEOUT_MS = 135_000;

  if (window.__CONN_GPUI_OVERLAY_BRIDGE__) return;

  const pending = new Map();
  const listeners = new Set();
  let nextReq = 0;

  const plain = (value) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  };

  function emit(obj) {
    try {
      console.debug(PREFIX + JSON.stringify(obj));
    } catch {}
  }

  function call(op, payload, timeoutMs = TIMEOUT_MS) {
    const requestId = String(++nextReq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Conn did not answer."));
      }, timeoutMs);
      pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      emit({ type: "rpc", requestId, op, payload });
    });
  }

  window.__CONN_OVERLAY_REPLY__ = (requestId, ok, valueOrError) => {
    const entry = pending.get(String(requestId));
    if (!entry) return;
    pending.delete(String(requestId));
    if (ok) entry.resolve(valueOrError);
    else entry.reject(new Error(typeof valueOrError === "string" ? valueOrError : "Request failed."));
  };

  window.__connAnnotationsChanged = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  };

  Object.defineProperty(window, "__CONN_ANNOTATIONS__", {
    configurable: true,
    enumerable: false,
    value: Object.freeze({
      list: () => call("list", null, 15_000),
      submit: (capture) => call("submit", plain(capture), 20_000),
      remove: (ids) => call("remove", { ids: Array.isArray(ids) ? [...ids] : [] }, 15_000).then(() => undefined),
      subscribe: (onChange) => {
        if (typeof onChange === "function") listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
    }),
  });

  function untilAborted(promise, fallback, signal) {
    if (!signal) return promise.catch(() => fallback);
    if (signal.aborted) return Promise.resolve(fallback);
    return new Promise((resolve) => {
      const abort = () => resolve(fallback);
      signal.addEventListener("abort", abort, { once: true });
      const settle = (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      promise.then(settle, () => settle(fallback));
    });
  }

  window.__ANNOTATOR_HOST__ = Object.freeze({
    dictation(action, options) {
      const signal = options && options.signal;
      if ((action !== "start" && action !== "stop") || (signal && signal.aborted)) {
        return Promise.resolve(false);
      }
      return untilAborted(
        call("dictation", { action }, 15_000).then((res) => res === true),
        false,
        signal,
      );
    },
    dictationSession(action, session, options) {
      const signal = options && options.signal;
      if (
        (action !== "start" && action !== "stop" && action !== "cancel" && action !== "wait") ||
        typeof session !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(session) ||
        (signal && signal.aborted)
      ) {
        return Promise.resolve(false);
      }
      const timeout = action === "stop" || action === "wait" ? 135_000 : 15_000;
      return untilAborted(call("dictationSession", { action, session }, timeout), false, signal);
    },
  });

  window.__CONN_CAPTURE_HOOK__ = (rect) =>
    call("capture", plain(rect), 15_000);

  let modeSubscribed = false;
  window.__CONN_GPUI_OVERLAY_BRIDGE__ = {
    attachModeSync() {
      if (modeSubscribed || !window.ConnAnnotationOverlay || typeof window.ConnAnnotationOverlay.subscribe !== "function") {
        return;
      }
      modeSubscribed = true;
      window.ConnAnnotationOverlay.subscribe((state) => {
        if (state && typeof state.active === "boolean") {
          emit({ type: "mode", active: state.active });
        }
      });
    },
    configure(options) {
      const merged = Object.assign({}, options || {}, { capture: window.__CONN_CAPTURE_HOOK__ });
      window.__CONN_ANNOTATION_OPTIONS__ = merged;
      if (window.ConnAnnotationOverlay && typeof window.ConnAnnotationOverlay.mount === "function") {
        window.ConnAnnotationOverlay.mount(merged);
        this.attachModeSync();
        return true;
      }
      return false;
    },
    setMode(active) {
      this.attachModeSync();
      if (window.ConnAnnotationOverlay && typeof window.ConnAnnotationOverlay.setMode === "function") {
        const next = window.ConnAnnotationOverlay.setMode(Boolean(active));
        emit({ type: "mode", active: Boolean(next) });
        return next;
      }
      return null;
    },
  };
})();

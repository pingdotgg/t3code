// Page-side bridge connecting Conn's `@t3tools/annotation-overlay` (`inject.js`),
// Laravel Toolbar relay (`LaravelToolbarPreload.ts`), Vault credential autofill, and
// `preview_*` DOM automation helpers to `conn-gpui` over CEF's suppressed
// `__CONN_OVERLAY_RPC__:` console message channel.
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

  // ── Laravel Toolbar host bridge (matches Conn's LaravelToolbarPreload.ts) ──
  try {
    window.__LARAVEL_TOOLBAR_HOST__ = "Conn";
  } catch {}

  const reportLaravelToolbarPage = () => {
    const data = window.__LARAVEL_TOOLBAR_DATA__;
    if (data && typeof data === "object") {
      emit({ type: "laravelToolbar", kind: "page", data: plain(data) });
    }
  };
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", reportLaravelToolbarPage, { once: true });
  } else {
    reportLaravelToolbarPage();
  }
  window.addEventListener("laravel-toolbar:update", (event) => {
    const data = event && event.detail && event.detail.data;
    if (data && typeof data === "object") {
      emit({ type: "laravelToolbar", kind: "update", data: plain(data) });
    }
  });

  if (typeof window.fetch === "function" && !window.__CONN_FETCH_TOOLBAR_WRAPPED__) {
    window.__CONN_FETCH_TOOLBAR_WRAPPED__ = true;
    const origFetch = window.fetch.bind(window);
    window.fetch = (...args) =>
      origFetch(...args).then((resp) => {
        try {
          const full = resp.headers && resp.headers.get("x-toolbar");
          const summary = resp.headers && resp.headers.get("x-toolbar-summary");
          if (full || summary) {
            const req = args[0];
            const init = args[1];
            const method = (init && init.method) || (req && req.method) || "GET";
            const url = resp.url || (typeof req === "string" ? req : req && req.url) || location.href;
            emit({
              type: "laravelToolbarHeaders",
              full: full || null,
              summary: summary || null,
              method: String(method).toUpperCase(),
              url: String(url),
            });
          }
        } catch {}
        return resp;
      });
  }

  if (typeof XMLHttpRequest !== "undefined" && !XMLHttpRequest.prototype.__CONN_TOOLBAR_WRAPPED__) {
    XMLHttpRequest.prototype.__CONN_TOOLBAR_WRAPPED__ = true;
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__connMethod = method;
      this.__connUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", () => {
        try {
          const full = this.getResponseHeader("x-toolbar");
          const summary = this.getResponseHeader("x-toolbar-summary");
          if (full || summary) {
            emit({
              type: "laravelToolbarHeaders",
              full: full || null,
              summary: summary || null,
              method: String(this.__connMethod || "GET").toUpperCase(),
              url: String(this.responseURL || this.__connUrl || location.href),
            });
          }
        } catch {}
      });
      return origSend.apply(this, args);
    };
  }

  // ── Vault credential autofill (origin-checked in-page as defense in depth) ─
  function setNativeValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") {
      desc.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isVisibleInput(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
    if (el.disabled || el.readOnly) return false;
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function pickCredentialInput(field) {
    const active = document.activeElement;
    if (field === "password") {
      if (isVisibleInput(active) && active.type === "password") return active;
      const pw = [...document.querySelectorAll('input[type="password"]')].find(isVisibleInput);
      if (pw) return pw;
    } else if (field === "otp") {
      if (isVisibleInput(active) && active.type !== "password") return active;
      const otp = [...document.querySelectorAll('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="otp" i], input[name*="code" i], input[name*="totp" i]')].find(isVisibleInput);
      if (otp) return otp;
    } else {
      if (isVisibleInput(active) && active.type !== "password") return active;
      const user = [...document.querySelectorAll('input[autocomplete*="username"], input[type="email"], input[name*="email" i], input[name*="user" i], input[name*="login" i], input[type="text"]')].find(isVisibleInput);
      if (user) return user;
    }
    return [...document.querySelectorAll("input")].find(isVisibleInput) || null;
  }

  function fillCredential(field, expectedOrigin, value) {
    if (window.location.origin !== expectedOrigin) {
      return { ok: false, status: "origin_mismatch" };
    }
    const input = pickCredentialInput(field);
    if (!input) {
      return { ok: false, status: "field_not_found" };
    }
    input.focus();
    setNativeValue(input, value);
    return { ok: true, status: "filled" };
  }

  // ── Agent `preview_*` DOM snapshot / act / eval helpers ────────────────────
  function previewSnapshot() {
    const selector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="textbox"], [role="checkbox"], [role="combobox"], [tabindex]:not([tabindex="-1"])';
    const nodes = [...document.querySelectorAll(selector)];
    const elements = [];
    let refCounter = 0;
    for (const el of nodes) {
      if (elements.length >= 200) break;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const ref = `e${++refCounter}`;
      el.setAttribute("data-conn-ref", ref);
      const label = (
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.innerText ||
        el.textContent ||
        ""
      ).trim().replace(/\s+/g, " ").slice(0, 120);
      elements.push({
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || null,
        type: el.getAttribute("type") || null,
        label,
        href: el.getAttribute("href") || null,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    }
    return {
      url: window.location.href,
      title: document.title || "",
      readyState: document.readyState,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      elements,
      text: (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 16_000),
    };
  }

  function resolveTarget(params) {
    if (params.locator && typeof params.locator === "string") {
      const m = params.locator.match(/^aria-ref=(.+)$/);
      if (m) {
        const byRef = document.querySelector(`[data-conn-ref="${CSS.escape(m[1])}"]`);
        if (byRef) return byRef;
      }
      try {
        return document.querySelector(params.locator);
      } catch {
        return null;
      }
    }
    if (params.selector && typeof params.selector === "string") {
      try {
        return document.querySelector(params.selector);
      } catch {
        return null;
      }
    }
    return document.activeElement;
  }

  function previewAct(params) {
    const action = params && params.action;
    if (action === "scroll") {
      const target = (params.locator || params.selector) ? resolveTarget(params) : null;
      const dx = Number(params.deltaX || 0);
      const dy = Number(params.deltaY || 0);
      if (target && typeof target.scrollBy === "function") target.scrollBy(dx, dy);
      else window.scrollBy(dx, dy);
      return { ok: true, action };
    }
    const target = resolveTarget(params || {});
    if (!target) {
      throw new Error("Target element not found.");
    }
    if (action === "click") {
      target.scrollIntoView({ block: "center", inline: "center" });
      if (typeof target.focus === "function") target.focus();
      target.click();
      return { ok: true, action };
    }
    if (action === "type") {
      target.scrollIntoView({ block: "center", inline: "center" });
      if (typeof target.focus === "function") target.focus();
      const text = String(params.text ?? "");
      const next = params.clear ? text : `${target.value || ""}${text}`;
      setNativeValue(target, next);
      return { ok: true, action };
    }
    if (action === "press") {
      const key = String(params.key || "Enter");
      if (typeof target.focus === "function") target.focus();
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      if (key === "Enter" && target.form && typeof target.form.requestSubmit === "function") {
        target.form.requestSubmit();
      }
      return { ok: true, action, key };
    }
    throw new Error(`Unsupported preview action: ${action}`);
  }

  function previewEval(requestId, expr) {
    Promise.resolve()
      .then(() => (0, eval)(expr))
      .then((value) => {
        emit({ type: "previewResult", requestId, ok: true, value: plain(value) });
      })
      .catch((err) => {
        emit({
          type: "previewResult",
          requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  function previewCall(requestId, op, params) {
    Promise.resolve()
      .then(() => {
        if (op === "snapshot") return previewSnapshot();
        if (op === "act") return previewAct(params);
        throw new Error(`Unknown preview op: ${op}`);
      })
      .then((value) => {
        emit({ type: "previewResult", requestId, ok: true, value: plain(value) });
      })
      .catch((err) => {
        emit({
          type: "previewResult",
          requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

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
    fillCredential,
    previewEval,
    previewCall,
  };
})();

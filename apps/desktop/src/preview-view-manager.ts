// @effect-diagnostics globalDate:off
/**
 * PreviewViewManager — desktop side of the in-app browser preview.
 *
 * Hosts per-tab Chromium WebContents references (the actual <webview>
 * elements live in the renderer; we only attach listeners and forward state
 * here). Single layer-scoped browser session partition.
 */
import type {
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { type BrowserWindow, type Session, session, webContents } from "electron";
import { setTimeout as sleep } from "node:timers/promises";

import { isPreviewAnnotationPayload } from "./picked-element-payload.ts";

const PREVIEW_PARTITION = "persist:t3code-preview";
const START_PICK_CHANNEL = "preview:start-pick";
const CANCEL_PICK_CHANNEL = "preview:cancel-pick";
const ELEMENT_PICKED_CHANNEL = "preview:element-picked";
const ANNOTATION_CAPTURED_CHANNEL = "preview:annotation-captured";

// Re-export the guest webview security posture from its dedicated module so
// the constant is unit-testable in isolation. See
// `preview-webview-preferences.ts` for the full security rationale.
export { PREVIEW_WEBVIEW_PREFERENCES } from "./preview-webview-preferences.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "./preview-webview-preferences.ts";

export type PreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | {
      kind: "LoadFailed";
      url: string;
      title: string;
      code: number;
      description: string;
    };

export interface PreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  updatedAt: string;
}

/** Discrete zoom levels mirroring Chrome's preset list. */
const ZOOM_LEVELS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

const DEFAULT_ZOOM_FACTOR = 1.0;
const ZOOM_EPSILON = 0.001;
const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_SCREENSHOT_WIDTH = 1280;

interface CdpEvaluationResult {
  readonly result?: {
    readonly value?: unknown;
    readonly description?: string;
  };
  readonly exceptionDetails?: {
    readonly text?: string;
    readonly exception?: { readonly description?: string };
  };
}

const automationError = (
  tag:
    | "PreviewAutomationExecutionError"
    | "PreviewAutomationInvalidSelectorError"
    | "PreviewAutomationResultTooLargeError"
    | "PreviewAutomationTimeoutError",
  message: string,
  detail?: unknown,
): Error & { detail?: unknown } => {
  const error = new Error(message) as Error & { detail?: unknown };
  error.name = tag;
  if (detail !== undefined) error.detail = detail;
  return error;
};

const normalizeCaptureRect = (value: unknown): PreviewAnnotationRect | null => {
  if (typeof value !== "object" || value === null) return null;
  const rect = value as Record<string, unknown>;
  const x = rect["x"];
  const y = rect["y"];
  const width = rect["width"];
  const height = rect["height"];
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
  };
};

const captureAnnotationScreenshot = async (
  wc: Electron.WebContents,
  cropRect: PreviewAnnotationRect | null,
) => {
  const image = await wc.capturePage(
    cropRect
      ? {
          x: cropRect.x,
          y: cropRect.y,
          width: cropRect.width,
          height: cropRect.height,
        }
      : undefined,
  );
  const size = image.getSize();
  return {
    dataUrl: image.toDataURL(),
    width: size.width,
    height: size.height,
    cropRect: cropRect ?? { x: 0, y: 0, width: size.width, height: size.height },
  };
};

const findZoomStep = (current: number): number => {
  for (let index = 0; index < ZOOM_LEVELS.length; index += 1) {
    if (Math.abs(ZOOM_LEVELS[index]! - current) < ZOOM_EPSILON) return index;
    if (ZOOM_LEVELS[index]! > current) return index - 1;
  }
  return ZOOM_LEVELS.length - 1;
};

const nextZoomLevel = (current: number, direction: "in" | "out"): number => {
  const step = findZoomStep(current);
  if (direction === "in") {
    return ZOOM_LEVELS[Math.min(step + 1, ZOOM_LEVELS.length - 1)] ?? current;
  }
  return ZOOM_LEVELS[Math.max(step - 1, 0)] ?? current;
};

type Listener = (tabId: string, state: PreviewTabState) => void;

interface ManagedListeners {
  navigate: () => void;
  failed: (event: Event, code: number, description: string) => void;
}

interface PickSession {
  readonly resolve: (payload: PreviewAnnotationPayload | null) => void;
  readonly cleanup: () => void;
}

const APP_FORWARDED_SHORTCUTS: ReadonlyArray<{
  key: string;
  meta: boolean;
  shift: boolean;
  control: boolean;
}> = Object.freeze([
  // mod+shift+J → preview.toggle
  { key: "j", meta: true, shift: true, control: false },
  // mod+K → command palette
  { key: "k", meta: true, shift: false, control: false },
  // mod+, → settings (macOS convention)
  { key: ",", meta: true, shift: false, control: false },
  // mod+W → close tab/panel
  { key: "w", meta: true, shift: false, control: false },
]);

export class PreviewViewManager {
  private mainWindow: BrowserWindow | null = null;
  private readonly tabs = new Map<string, PreviewTabState>();
  private readonly attached = new Map<number, ManagedListeners>();
  private browserSession: Session | null = null;
  private readonly listeners = new Set<Listener>();
  /** In-flight preview annotation sessions, keyed by tabId. */
  private readonly pickSessions = new Map<string, PickSession>();

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  getBrowserPartition(): string {
    return PREVIEW_PARTITION;
  }

  /**
   * Returns the canonical `<webview webpreferences="...">` string. Renderer
   * fetches this via the desktop bridge so the security posture for guest
   * surfaces lives in exactly one place (here) and any future guest webview
   * (docs panel, OAuth popup, etc.) can opt in by calling the same getter.
   */
  getWebviewPreferences(): string {
    return PREVIEW_WEBVIEW_PREFERENCES;
  }

  getBrowserSession(): Session {
    if (this.browserSession) return this.browserSession;
    const sess = session.fromPartition(PREVIEW_PARTITION);
    const ua = sess
      .getUserAgent()
      .replace(/Electron\/[\d.]+ /, "")
      .replace(/\s*t3code\/[\d.]+/, "");
    sess.setUserAgent(ua);
    sess.setPermissionRequestHandler((_wc, perm, callback) => {
      const allow = ["clipboard-read", "clipboard-write", "notifications", "geolocation"];
      callback(allow.includes(perm));
    });
    this.browserSession = sess;
    return sess;
  }

  createTab(tabId: string): PreviewTabState {
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    const initial: PreviewTabState = {
      tabId,
      webContentsId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
      updatedAt: new Date().toISOString(),
    };
    this.tabs.set(tabId, initial);
    this.emit(tabId, initial);
    return initial;
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.cancelPickElement(tabId);
    if (tab.webContentsId != null) {
      this.detachListeners(tab.webContentsId);
    }
    const closed: PreviewTabState = {
      ...tab,
      webContentsId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
      updatedAt: new Date().toISOString(),
    };
    this.tabs.delete(tabId);
    this.emit(tabId, closed);
  }

  registerWebview(tabId: string, webContentsId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new PreviewTabNotFoundError(tabId);
    }
    const wc = webContents.fromId(webContentsId);
    if (!wc) {
      throw new PreviewWebContentsNotFoundError(tabId, webContentsId);
    }
    // Defence in depth: a malicious renderer could otherwise trick us into
    // attaching listeners to the main window's WebContents (or any other
    // process) by passing an arbitrary id.
    if (wc.getType() !== "webview") {
      throw new PreviewWebContentsNotFoundError(tabId, webContentsId);
    }
    if (this.mainWindow && wc.hostWebContents !== this.mainWindow.webContents) {
      throw new PreviewWebContentsNotFoundError(tabId, webContentsId);
    }
    if (tab.webContentsId === webContentsId && this.attached.has(webContentsId)) {
      return;
    }
    if (tab.webContentsId != null && tab.webContentsId !== webContentsId) {
      this.detachListeners(tab.webContentsId);
      // Any in-flight pick is bound to the OLD WebContents via `wc.ipc.on`.
      // Cancel it so the toggle button doesn't get stuck pressed waiting
      // forever for a click on a webview that no longer hosts the listener.
      this.cancelPickElement(tabId);
    }
    this.attachListeners(tabId, wc);
    // Restore the persisted zoom factor onto the freshly-attached WebContents
    // so a thread-switch + remount lands the user back where they were.
    if (Math.abs(tab.zoomFactor - DEFAULT_ZOOM_FACTOR) > ZOOM_EPSILON) {
      try {
        wc.setZoomFactor(tab.zoomFactor);
      } catch {
        // wc may have been torn down between resolution and call.
      }
    }
    this.update(tabId, {
      webContentsId,
      navStatus: this.computeNavStatus(wc),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      zoomFactor: tab.zoomFactor,
    });
  }

  async navigate(tabId: string, rawUrl: string): Promise<void> {
    const wc = this.requireWebContents(tabId);
    const url = this.normalizeUrl(rawUrl);
    if (wc.getURL() === url) {
      wc.reload();
      return;
    }
    await wc.loadURL(url);
  }

  goBack(tabId: string): void {
    const wc = this.requireWebContents(tabId);
    if (wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack();
    }
  }

  goForward(tabId: string): void {
    const wc = this.requireWebContents(tabId);
    if (wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward();
    }
  }

  refresh(tabId: string): void {
    const wc = this.requireWebContents(tabId);
    wc.reload();
  }

  /** Bypass HTTP cache on the next load — equivalent to Cmd+Shift+R. */
  hardReload(tabId: string): void {
    const wc = this.requireWebContents(tabId);
    wc.reloadIgnoringCache();
  }

  /**
   * Open the guest webview's DevTools, detached so it doesn't steal panel
   * area. Idempotent — re-invoking focuses the existing window.
   */
  openDevTools(tabId: string): void {
    const wc = this.requireWebContents(tabId);
    if (wc.isDevToolsOpened()) {
      wc.devToolsWebContents?.focus();
      return;
    }
    wc.openDevTools({ mode: "detach" });
  }

  /**
   * Drop cookies/localStorage/etc. for the preview partition. Affects every
   * preview tab since they all share `persist:t3code-preview`.
   */
  async clearCookies(): Promise<void> {
    const sess = this.getBrowserSession();
    await sess.clearStorageData({
      storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers"],
    });
  }

  /** Drop the HTTP cache for the preview partition. */
  async clearCache(): Promise<void> {
    const sess = this.getBrowserSession();
    await sess.clearCache();
  }

  /**
   * Activate annotation mode for `tabId`. Resolves after the guest submits a
   * multi-target annotation and the desktop process captures its screenshot,
   * or with `null` when the user cancels.
   *
   * Exactly one pick session may be active per tab — re-invoking while a
   * pick is in flight cleanly resolves the old session with `null` first.
   */
  async pickElement(tabId: string): Promise<PreviewAnnotationPayload | null> {
    const wc = this.requireWebContents(tabId);
    this.cancelPickElement(tabId);
    return new Promise<PreviewAnnotationPayload | null>((resolve) => {
      // `wc.ipc` is the per-WebContents IpcMain that receives messages the
      // webview's preload sends with `ipcRenderer.send(...)`. We use that
      // (not the global `wc.on("ipc-message", ...)`, which is for
      // `sendToHost` and only fires on the host renderer's <webview>
      // element) so the main process actually observes the picked payload.
      const cleanup = () => {
        wc.ipc.removeListener(ELEMENT_PICKED_CHANNEL, onMessage);
        wc.off("destroyed", onDestroyed);
        wc.off("did-start-navigation", onNavigated);
        this.pickSessions.delete(tabId);
      };
      const session: PickSession = { resolve, cleanup };
      const settle = (payload: PreviewAnnotationPayload | null) => {
        if (this.pickSessions.get(tabId) !== session) return;
        cleanup();
        resolve(payload);
      };
      const onMessage = (_event: Electron.IpcMainEvent, ...args: unknown[]): void => {
        const payload = args[0];
        if (payload == null) {
          settle(null);
          return;
        }
        if (!isPreviewAnnotationPayload(payload)) {
          settle(null);
          return;
        }
        const cropRect = normalizeCaptureRect(args[1]);
        void captureAnnotationScreenshot(wc, cropRect)
          .then((screenshot) => settle({ ...payload, screenshot }))
          .catch(() => settle(payload))
          .finally(() => {
            if (wc.isDestroyed()) return;
            try {
              wc.send(ANNOTATION_CAPTURED_CHANNEL);
            } catch {
              // The guest may have navigated while capture was in flight.
            }
          });
      };
      const onDestroyed = () => settle(null);
      const onNavigated = () => settle(null);
      wc.ipc.on(ELEMENT_PICKED_CHANNEL, onMessage);
      wc.once("destroyed", onDestroyed);
      // A page navigation (incl. SPA → same-document) tears down the
      // preload's listeners, so we cancel proactively to avoid hanging.
      wc.once("did-start-navigation", onNavigated);
      this.pickSessions.set(tabId, session);
      // Force-focus the guest webContents BEFORE sending start-pick. Without
      // this, Electron's input router will deliver the user's first
      // mousemove/click to the host renderer (where the pick button lives)
      // instead of to the guest's window listeners — manifest as "the
      // picker overlay never appears on remote pages I haven't clicked
      // into yet". The renderer-side handler in `PreviewView` is responsible
      // for restoring focus to the previously-active host element when the
      // pick promise resolves so the user's textarea cursor isn't lost.
      try {
        if (!wc.isFocused()) wc.focus();
      } catch {
        // wc may be torn down; the next try/catch settles.
      }
      try {
        wc.send(START_PICK_CHANNEL);
      } catch {
        settle(null);
      }
    });
  }

  cancelPickElement(tabId: string): void {
    const session = this.pickSessions.get(tabId);
    if (!session) return;
    session.cleanup();
    // Best-effort: tell the page to dismiss the overlay even if it's still
    // alive — keeps the next invoke fresh.
    const tab = this.tabs.get(tabId);
    if (tab?.webContentsId != null) {
      const wc = webContents.fromId(tab.webContentsId);
      if (wc && !wc.isDestroyed()) {
        try {
          wc.send(CANCEL_PICK_CHANNEL);
        } catch {
          // wc may have been torn down; nothing to clean up.
        }
      }
    }
    session.resolve(null);
  }

  zoomIn(tabId: string): void {
    this.applyZoom(tabId, (current) => nextZoomLevel(current, "in"));
  }

  zoomOut(tabId: string): void {
    this.applyZoom(tabId, (current) => nextZoomLevel(current, "out"));
  }

  resetZoom(tabId: string): void {
    this.applyZoom(tabId, () => DEFAULT_ZOOM_FACTOR);
  }

  automationStatus(tabId: string): PreviewAutomationStatus {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.webContentsId == null) {
      const navStatus = tab?.navStatus;
      return {
        available: false,
        visible: true,
        tabId,
        url: !navStatus || navStatus.kind === "Idle" ? null : navStatus.url,
        title: !navStatus || navStatus.kind === "Idle" ? null : navStatus.title,
        loading: navStatus?.kind === "Loading",
      };
    }
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc || wc.isDestroyed()) {
      return {
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      };
    }
    return {
      available: true,
      visible: true,
      tabId,
      url: wc.getURL() || null,
      title: wc.getTitle() || null,
      loading: wc.isLoading(),
    };
  }

  async automationSnapshot(tabId: string): Promise<PreviewAutomationSnapshot> {
    const wc = this.requireWebContents(tabId);
    return this.withDebugger(wc, async (send) => {
      await Promise.all([send("Runtime.enable"), send("Accessibility.enable")]);
      const page = await this.evaluateWithDebugger<{
        url: string;
        title: string;
        loading: boolean;
        visibleText: string;
        interactiveElements: PreviewAutomationSnapshot["interactiveElements"];
      }>(
        send,
        `(() => {
          const selectorFor = (element) => {
            if (element.id) return "#" + CSS.escape(element.id);
            for (const attribute of ["data-testid", "name"]) {
              const value = element.getAttribute(attribute);
              if (value) return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
            }
            const parts = [];
            let current = element;
            while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
              let part = current.tagName.toLowerCase();
              const parent = current.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
                if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
              }
              parts.unshift(part);
              current = parent;
            }
            return parts.join(" > ");
          };
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          };
          const elements = Array.from(document.querySelectorAll(
            "a[href],button,input,textarea,select,[role],[tabindex]"
          )).filter(visible).slice(0, ${MAX_INTERACTIVE_ELEMENTS}).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              name: element.getAttribute("aria-label") || element.innerText || element.getAttribute("name") || "",
              selector: selectorFor(element),
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            };
          });
          return {
            url: location.href,
            title: document.title,
            loading: document.readyState !== "complete",
            visibleText: (document.body?.innerText || "").slice(0, ${MAX_VISIBLE_TEXT_LENGTH}),
            interactiveElements: elements
          };
        })()`,
        true,
      );
      const accessibility = await send("Accessibility.getFullAXTree");
      let image = await wc.capturePage();
      let size = image.getSize();
      if (size.width > MAX_SCREENSHOT_WIDTH) {
        image = image.resize({ width: MAX_SCREENSHOT_WIDTH });
        size = image.getSize();
      }
      return {
        ...page,
        accessibilityTree: accessibility,
        screenshot: {
          mimeType: "image/png",
          data: image.toPNG().toString("base64"),
          width: size.width,
          height: size.height,
        },
      };
    });
  }

  async automationClick(tabId: string, input: PreviewAutomationClickInput): Promise<void> {
    const wc = this.requireWebContents(tabId);
    await this.withDebugger(wc, async (send) => {
      await Promise.all([
        send("Runtime.enable"),
        send("Input.setIgnoreInputEvents", { ignore: false }),
      ]);
      let x: number;
      let y: number;
      if ("selector" in input) {
        const point = await this.evaluateWithDebugger<
          { x: number; y: number } | { invalidSelector: true; message: string } | { notFound: true }
        >(
          send,
          `(() => {
            try {
              const element = document.querySelector(${JSON.stringify(input.selector)});
              if (!element) return { notFound: true };
              element.scrollIntoView({ block: "center", inline: "center" });
              const rect = element.getBoundingClientRect();
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            } catch (error) {
              return { invalidSelector: true, message: String(error) };
            }
          })()`,
          true,
        );
        if ("invalidSelector" in point) {
          throw automationError("PreviewAutomationInvalidSelectorError", point.message, {
            selector: input.selector,
          });
        }
        if ("notFound" in point) {
          throw automationError(
            "PreviewAutomationExecutionError",
            `No element matches selector ${input.selector}.`,
          );
        }
        x = point.x;
        y = point.y;
      } else {
        x = input.x;
        y = input.y;
      }
      const viewport = await this.evaluateWithDebugger<{ width: number; height: number }>(
        send,
        "({ width: window.innerWidth, height: window.innerHeight })",
        true,
      );
      if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
        throw automationError(
          "PreviewAutomationExecutionError",
          `Click coordinates (${x}, ${y}) are outside the preview viewport.`,
        );
      }
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    });
  }

  async automationType(tabId: string, input: PreviewAutomationTypeInput): Promise<void> {
    const wc = this.requireWebContents(tabId);
    await this.withDebugger(wc, async (send) => {
      await send("Runtime.enable");
      const focusResult = await this.evaluateWithDebugger<
        { ok: true } | { invalidSelector: true; message: string } | { notFound: true }
      >(
        send,
        `(() => {
          try {
            const element = ${
              input.selector
                ? `document.querySelector(${JSON.stringify(input.selector)})`
                : "document.activeElement"
            };
            if (!element) return { notFound: true };
            element.focus();
            if (${input.clear ?? false}) {
              if ("value" in element) element.value = "";
              else if (element.isContentEditable) element.textContent = "";
              element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
            }
            return { ok: true };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
        true,
      );
      if ("invalidSelector" in focusResult) {
        throw automationError("PreviewAutomationInvalidSelectorError", focusResult.message, {
          selector: input.selector ?? "",
        });
      }
      if ("notFound" in focusResult) {
        throw automationError(
          "PreviewAutomationExecutionError",
          input.selector
            ? `No element matches selector ${input.selector}.`
            : "No element is focused in the preview.",
        );
      }
      await send("Input.insertText", { text: input.text });
      await this.evaluateWithDebugger(
        send,
        `(() => {
          const element = document.activeElement;
          element?.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(input.text)} }));
          element?.dispatchEvent(new Event("change", { bubbles: true }));
        })()`,
        false,
      );
    });
  }

  async automationPress(tabId: string, input: PreviewAutomationPressInput): Promise<void> {
    const wc = this.requireWebContents(tabId);
    await this.withDebugger(wc, async (send) => {
      const modifiers = (input.modifiers ?? []).reduce((value, modifier) => {
        switch (modifier) {
          case "Alt":
            return value | 1;
          case "Control":
            return value | 2;
          case "Meta":
            return value | 4;
          case "Shift":
            return value | 8;
        }
      }, 0);
      const key = input.key;
      const text = key.length === 1 ? key : undefined;
      const params = {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        modifiers,
        ...(text ? { text, unmodifiedText: text } : {}),
      };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    });
  }

  async automationScroll(tabId: string, input: PreviewAutomationScrollInput): Promise<void> {
    const wc = this.requireWebContents(tabId);
    await this.withDebugger(wc, async (send) => {
      await send("Runtime.enable");
      const result = await this.evaluateWithDebugger<
        { ok: true } | { invalidSelector: true; message: string } | { notFound: true }
      >(
        send,
        `(() => {
          try {
            const target = ${
              input.selector
                ? `document.querySelector(${JSON.stringify(input.selector)})`
                : "window"
            };
            if (!target) return { notFound: true };
            target.scrollBy({ left: ${input.deltaX ?? 0}, top: ${input.deltaY ?? 0}, behavior: "instant" });
            return { ok: true };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
        true,
      );
      if ("invalidSelector" in result) {
        throw automationError("PreviewAutomationInvalidSelectorError", result.message, {
          selector: input.selector ?? "",
        });
      }
      if ("notFound" in result) {
        throw automationError(
          "PreviewAutomationExecutionError",
          `No element matches selector ${input.selector}.`,
        );
      }
    });
  }

  async automationEvaluate(tabId: string, input: PreviewAutomationEvaluateInput): Promise<unknown> {
    const wc = this.requireWebContents(tabId);
    return this.withDebugger(wc, async (send) => {
      await send("Runtime.enable");
      const value = await this.evaluateWithDebugger(
        send,
        input.expression,
        input.returnByValue ?? true,
        input.awaitPromise ?? true,
      );
      const serialized = JSON.stringify(value);
      if (
        serialized !== undefined &&
        Buffer.byteLength(serialized, "utf8") > MAX_EVALUATION_BYTES
      ) {
        throw automationError(
          "PreviewAutomationResultTooLargeError",
          `Evaluation result exceeds ${MAX_EVALUATION_BYTES} bytes.`,
          { maximumBytes: MAX_EVALUATION_BYTES },
        );
      }
      return value;
    });
  }

  async automationWaitFor(tabId: string, input: PreviewAutomationWaitForInput): Promise<void> {
    const wc = this.requireWebContents(tabId);
    const timeoutMs = input.timeoutMs ?? 15_000;
    await this.withDebugger(wc, async (send) => {
      await send("Runtime.enable");
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        const result = await this.evaluateWithDebugger<
          { matched: boolean } | { invalidSelector: true; message: string }
        >(
          send,
          `(() => {
            try {
              const selectorMatched = ${
                input.selector
                  ? `document.querySelector(${JSON.stringify(input.selector)}) !== null`
                  : "true"
              };
              const textMatched = ${
                input.text
                  ? `(document.body?.innerText || "").includes(${JSON.stringify(input.text)})`
                  : "true"
              };
              const urlMatched = ${
                input.urlIncludes
                  ? `location.href.includes(${JSON.stringify(input.urlIncludes)})`
                  : "true"
              };
              return { matched: selectorMatched && textMatched && urlMatched };
            } catch (error) {
              return { invalidSelector: true, message: String(error) };
            }
          })()`,
          true,
        );
        if ("invalidSelector" in result) {
          throw automationError("PreviewAutomationInvalidSelectorError", result.message, {
            selector: input.selector ?? "",
          });
        }
        if (result.matched) return;
        await sleep(100);
      }
      throw automationError(
        "PreviewAutomationTimeoutError",
        `Preview condition did not match within ${timeoutMs}ms.`,
      );
    });
  }

  private applyZoom(tabId: string, transform: (current: number) => number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const next = transform(tab.zoomFactor);
    if (Math.abs(next - tab.zoomFactor) < ZOOM_EPSILON) return;
    if (tab.webContentsId != null) {
      const wc = webContents.fromId(tab.webContentsId);
      if (wc && !wc.isDestroyed()) {
        wc.setZoomFactor(next);
      }
    }
    this.update(tabId, { zoomFactor: next });
  }

  private async withDebugger<A>(
    wc: Electron.WebContents,
    use: (
      send: (method: string, commandParams?: Record<string, unknown>) => Promise<unknown>,
    ) => Promise<A>,
  ): Promise<A> {
    if (wc.debugger.isAttached()) {
      throw automationError(
        "PreviewAutomationExecutionError",
        "Preview automation is unavailable while another debugger is attached.",
      );
    }
    wc.debugger.attach("1.3");
    try {
      return await use((method, commandParams) => wc.debugger.sendCommand(method, commandParams));
    } catch (cause) {
      if (cause instanceof Error && cause.name.startsWith("PreviewAutomation")) throw cause;
      throw automationError(
        "PreviewAutomationExecutionError",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );
    } finally {
      if (wc.debugger.isAttached()) {
        try {
          wc.debugger.detach();
        } catch {
          // The target can disappear while an operation is completing.
        }
      }
    }
  }

  private async evaluateWithDebugger<A = unknown>(
    send: (method: string, commandParams?: Record<string, unknown>) => Promise<unknown>,
    expression: string,
    returnByValue: boolean,
    awaitPromise = true,
  ): Promise<A> {
    const response = (await send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    })) as CdpEvaluationResult;
    if (response.exceptionDetails) {
      throw automationError(
        "PreviewAutomationExecutionError",
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "JavaScript evaluation failed.",
      );
    }
    return response.result?.value as A;
  }

  onStateChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    for (const tabId of Array.from(this.tabs.keys())) {
      this.closeTab(tabId);
    }
    this.listeners.clear();
  }

  private attachListeners(tabId: string, wc: Electron.WebContents): void {
    const sync = () => {
      if (wc.isDestroyed()) return;
      this.update(tabId, {
        navStatus: this.computeNavStatus(wc),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    };
    const failed = (_event: Event, code: number, description: string): void => {
      // -3 = ABORTED (user navigated away mid-load); ignore.
      if (code === -3) return;
      this.update(tabId, {
        navStatus: {
          kind: "LoadFailed",
          url: wc.getURL(),
          title: wc.getTitle(),
          code,
          description,
        },
      });
    };

    wc.on("did-navigate", sync);
    wc.on("did-navigate-in-page", sync);
    wc.on("page-title-updated", sync);
    wc.on("did-start-loading", sync);
    wc.on("did-stop-loading", sync);
    wc.on("did-fail-load", failed as never);

    // Keep external links inside the same view (matches ami's policy).
    wc.setWindowOpenHandler(({ url }) => {
      void wc.loadURL(url);
      return { action: "deny" };
    });

    // Forward app-level shortcuts to the main window so mod+shift+J etc.
    // still toggles the preview panel even when the webview has focus.
    wc.on("before-input-event", (event, input) => {
      if (this.isAppShortcut(input) && this.mainWindow && !this.mainWindow.isDestroyed()) {
        event.preventDefault();
        this.mainWindow.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: input.key,
          modifiers: [
            ...(input.meta ? (["meta"] as const) : []),
            ...(input.shift ? (["shift"] as const) : []),
            ...(input.control ? (["control"] as const) : []),
            ...(input.alt ? (["alt"] as const) : []),
          ],
        });
      }
    });

    this.attached.set(wc.id, { navigate: sync, failed });
  }

  private detachListeners(webContentsId: number): void {
    const handlers = this.attached.get(webContentsId);
    if (!handlers) return;
    this.attached.delete(webContentsId);
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    wc.off("did-navigate", handlers.navigate);
    wc.off("did-navigate-in-page", handlers.navigate);
    wc.off("page-title-updated", handlers.navigate);
    wc.off("did-start-loading", handlers.navigate);
    wc.off("did-stop-loading", handlers.navigate);
    wc.off("did-fail-load", handlers.failed as never);
  }

  private isAppShortcut(input: Electron.Input): boolean {
    if (input.type !== "keyDown") return false;
    return APP_FORWARDED_SHORTCUTS.some(
      (shortcut) =>
        shortcut.key.toLowerCase() === input.key.toLowerCase() &&
        shortcut.meta === input.meta &&
        shortcut.shift === input.shift &&
        shortcut.control === input.control,
    );
  }

  private computeNavStatus(wc: Electron.WebContents): PreviewNavStatus {
    const url = wc.getURL();
    const title = wc.getTitle();
    if (url === "" || url === "about:blank") return { kind: "Idle" };
    if (wc.isLoading()) return { kind: "Loading", url, title };
    return { kind: "Success", url, title };
  }

  private requireWebContents(tabId: string): Electron.WebContents {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new PreviewTabNotFoundError(tabId);
    if (tab.webContentsId == null) throw new PreviewWebviewNotInitializedError(tabId);
    const wc = webContents.fromId(tab.webContentsId);
    if (!wc) throw new PreviewWebContentsNotFoundError(tabId, tab.webContentsId);
    return wc;
  }

  private update(tabId: string, patch: Partial<PreviewTabState>): void {
    const current = this.tabs.get(tabId);
    if (!current) return;
    const next: PreviewTabState = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.tabs.set(tabId, next);
    this.emit(tabId, next);
  }

  private emit(tabId: string, state: PreviewTabState): void {
    for (const listener of this.listeners) {
      try {
        listener(tabId, state);
      } catch {
        // listener errors must not crash the manager
      }
    }
  }

  private normalizeUrl(input: string): string {
    // Surface the shared error directly so the IPC caller (and any future
    // desktop-side telemetry) gets the `detail` field for free. Defining a
    // bespoke desktop class would just lose information.
    return normalizePreviewUrl(input);
  }
}

export class PreviewTabNotFoundError extends Error {
  readonly tabId: string;
  constructor(tabId: string) {
    super(`Preview tab not found: ${tabId}`);
    this.name = "PreviewTabNotFoundError";
    this.tabId = tabId;
  }
}

export class PreviewWebContentsNotFoundError extends Error {
  readonly tabId: string;
  readonly webContentsId: number;
  constructor(tabId: string, webContentsId: number) {
    super(`WebContents ${webContentsId} not found for preview tab ${tabId}`);
    this.name = "PreviewWebContentsNotFoundError";
    this.tabId = tabId;
    this.webContentsId = webContentsId;
  }
}

export class PreviewWebviewNotInitializedError extends Error {
  readonly tabId: string;
  constructor(tabId: string) {
    super(`Preview tab "${tabId}" has no webview registered`);
    this.name = "PreviewWebviewNotInitializedError";
    this.tabId = tabId;
  }
}

export const previewViewManager = new PreviewViewManager();

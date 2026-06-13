// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
/**
 * PreviewViewManager — desktop side of the in-app browser preview.
 *
 * Hosts per-tab Chromium WebContents references (the actual <webview>
 * elements live in the renderer; we only attach listeners and forward state
 * here). Single layer-scoped browser session partition.
 */
import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewPointerEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingFrame,
  DesktopPreviewScreenshotArtifact,
  PreviewAutomationClickInput,
  PreviewAutomationActionEvent,
  PreviewAutomationConsoleEntry,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationNetworkEntry,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import {
  type BrowserWindow,
  type Session,
  clipboard,
  nativeImage,
  shell,
  webContents,
} from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as BrowserSession from "./BrowserSession.ts";
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";
import { isPreviewAnnotationPayload } from "./PickedElementPayload.ts";
import { playwrightInjectedRuntimeInstallExpression } from "./PlaywrightInjectedRuntime.ts";

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
  controller: "human" | "agent" | "none";
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
const DIAGNOSTIC_BUFFER_LIMIT = 200;
const MAX_ARTIFACT_SITE_SLUG_LENGTH = 80;
const AGENT_CURSOR_MOVE_MS = 160;
const AGENT_CURSOR_CLICK_LEAD_MS = 40;
const DEFAULT_ANNOTATION_THEME: DesktopPreviewAnnotationTheme = {
  colorScheme: "light",
  radius: "0.625rem",
  background: "white",
  foreground: "oklch(0.269 0 0)",
  popover: "white",
  popoverForeground: "oklch(0.269 0 0)",
  primary: "oklch(0.488 0.217 264)",
  primaryForeground: "white",
  muted: "rgb(0 0 0 / 4%)",
  mutedForeground: "oklch(0.556 0 0)",
  accent: "rgb(0 0 0 / 4%)",
  accentForeground: "oklch(0.269 0 0)",
  border: "rgb(0 0 0 / 8%)",
  input: "rgb(0 0 0 / 10%)",
  ring: "oklch(0.488 0.217 264)",
  fontSans: "system-ui, sans-serif",
  fontMono: "ui-monospace, monospace",
};

const artifactSiteSlug = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    const slug = url.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_ARTIFACT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

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
    | "PreviewAutomationTimeoutError"
    | "PreviewAutomationControlInterruptedError",
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
type RecordingFrameListener = (frame: DesktopPreviewRecordingFrame) => void;

type PreviewInputSignal =
  | { readonly kind: "pointer"; readonly x: number; readonly y: number; readonly button: number }
  | { readonly kind: "key"; readonly key: string; readonly code: string };

interface ManagedListeners {
  navigate: () => void;
  failed: (event: Event, code: number, description: string) => void;
  humanInput: (_event: unknown, signal?: unknown) => void;
  beforeInput: (event: Electron.Event, input: Electron.Input) => void;
}

interface PickSession {
  readonly resolve: (payload: PreviewAnnotationPayload | null) => void;
  readonly cleanup: () => void;
}

interface BrowserControlSession {
  readonly webContentsId: number;
  tail: Promise<void>;
  initialized: Promise<void>;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => void;
}

interface BrowserDiagnostics {
  readonly consoleEntries: PreviewAutomationConsoleEntry[];
  readonly networkEntries: PreviewAutomationNetworkEntry[];
  readonly requests: Map<string, { url: string; method: string }>;
}

type PointerEventListener = (event: DesktopPreviewPointerEvent) => void;

interface ExpectedAgentInput {
  readonly signal: PreviewInputSignal;
  readonly expiresAt: number;
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

const isPreviewInputSignal = (value: unknown): value is PreviewInputSignal => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "pointer") {
    return (
      "x" in value &&
      typeof value.x === "number" &&
      "y" in value &&
      typeof value.y === "number" &&
      "button" in value &&
      typeof value.button === "number"
    );
  }
  return (
    value.kind === "key" &&
    "key" in value &&
    typeof value.key === "string" &&
    "code" in value &&
    typeof value.code === "string"
  );
};

const inputSignalsMatch = (left: PreviewInputSignal, right: PreviewInputSignal): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "pointer" && right.kind === "pointer") {
    return (
      Math.abs(left.x - right.x) <= 1 &&
      Math.abs(left.y - right.y) <= 1 &&
      left.button === right.button
    );
  }
  return (
    left.kind === "key" &&
    right.kind === "key" &&
    left.key === right.key &&
    left.code === right.code
  );
};

class PreviewViewManager {
  private annotationTheme = DEFAULT_ANNOTATION_THEME;
  private artifactDirectory: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private readonly tabs = new Map<string, PreviewTabState>();
  private readonly attached = new Map<number, ManagedListeners>();
  private readonly listeners = new Set<Listener>();
  private readonly pointerEventListeners = new Set<PointerEventListener>();
  private readonly recordingFrameListeners = new Set<RecordingFrameListener>();
  /** In-flight preview annotation sessions, keyed by tabId. */
  private readonly pickSessions = new Map<string, PickSession>();
  /** One long-lived CDP attachment and serialized command queue per guest. */
  private readonly controlSessions = new Map<number, BrowserControlSession>();
  private readonly diagnostics = new Map<number, BrowserDiagnostics>();
  private readonly expectedAgentInputs = new Map<string, ExpectedAgentInput[]>();
  private readonly controlEpoch = new Map<string, number>();
  private readonly actionTimeline = new Map<string, PreviewAutomationActionEvent[]>();
  private actionSequence = 0;
  private pointerSequence = 0;
  private recordingTabId: string | null = null;

  configureArtifactDirectory(directory: string): void {
    this.artifactDirectory = resolve(directory);
  }

  private requireArtifactDirectory(): string {
    if (!this.artifactDirectory) {
      throw new Error("Preview artifact directory is not configured.");
    }
    return this.artifactDirectory;
  }

  private resolveArtifactPath(path: string): string {
    const directory = this.requireArtifactDirectory();
    const resolvedPath = resolve(path);
    const relativePath = relative(directory, resolvedPath);
    if (
      relativePath.length === 0 ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error("Preview artifact path is outside the configured artifact directory.");
    }
    return resolvedPath;
  }

  revealArtifact(path: string): void {
    const resolvedPath = this.resolveArtifactPath(path);
    shell.showItemInFolder(resolvedPath);
  }

  copyArtifactToClipboard(path: string): void {
    const resolvedPath = this.resolveArtifactPath(path);
    const image = nativeImage.createFromPath(resolvedPath);
    if (image.isEmpty()) {
      throw new Error("Preview artifact could not be loaded as an image.");
    }
    clipboard.writeImage(image);
  }

  setAnnotationTheme(theme: DesktopPreviewAnnotationTheme): void {
    this.annotationTheme = theme;
    for (const tab of this.tabs.values()) {
      if (tab.webContentsId == null) continue;
      const wc = webContents.fromId(tab.webContentsId);
      if (!wc || wc.isDestroyed()) continue;
      wc.send(ANNOTATION_THEME_CHANNEL, theme);
    }
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
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
      controller: "none",
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
      this.detachControlSession(tab.webContentsId);
      this.detachListeners(tab.webContentsId);
    }
    const closed: PreviewTabState = {
      ...tab,
      webContentsId: null,
      navStatus: { kind: "Idle" },
      canGoBack: false,
      canGoForward: false,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
      controller: "none",
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
      wc.send(ANNOTATION_THEME_CHANNEL, this.annotationTheme);
      return;
    }
    if (tab.webContentsId != null && tab.webContentsId !== webContentsId) {
      this.detachControlSession(tab.webContentsId);
      this.detachListeners(tab.webContentsId);
      // Any in-flight pick is bound to the OLD WebContents via `wc.ipc.on`.
      // Cancel it so the toggle button doesn't get stuck pressed waiting
      // forever for a click on a webview that no longer hosts the listener.
      this.cancelPickElement(tabId);
    }
    this.attachListeners(tabId, wc);
    void this.ensureControlSession(wc).catch(() => undefined);
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
    wc.send(ANNOTATION_THEME_CHANNEL, this.annotationTheme);
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
    this.detachControlSession(wc.id);
    wc.once("devtools-closed", () => {
      if (!wc.isDestroyed()) void this.ensureControlSession(wc).catch(() => undefined);
    });
    wc.openDevTools({ mode: "detach" });
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
        wc.send(START_PICK_CHANNEL, this.annotationTheme);
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

  async startRecording(tabId: string): Promise<void> {
    if (this.recordingTabId && this.recordingTabId !== tabId) {
      throw new Error("Only one browser recording can be active per window.");
    }
    const wc = this.requireWebContents(tabId);
    await this.withControlSession(tabId, wc, "recording.start", async (send) => {
      await send("Page.enable");
      await send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        maxWidth: 1600,
        maxHeight: 1200,
        everyNthFrame: 1,
      });
    });
    this.recordingTabId = tabId;
  }

  async captureScreenshot(tabId: string): Promise<DesktopPreviewScreenshotArtifact> {
    const wc = this.requireWebContents(tabId);
    const createdAt = new Date().toISOString();
    const id = `browser-screenshot-${artifactSiteSlug(wc.getURL())}-${Date.now().toString(36)}`;
    const directory = this.requireArtifactDirectory();
    const path = join(directory, `${id}.png`);
    const data = (await wc.capturePage()).toPNG();
    await mkdir(directory, { recursive: true });
    await writeFile(path, data);
    return { id, tabId, path, mimeType: "image/png", sizeBytes: data.byteLength, createdAt };
  }

  async stopRecording(tabId: string): Promise<void> {
    if (this.recordingTabId !== tabId) return;
    const wc = this.requireWebContents(tabId);
    await this.withControlSession(tabId, wc, "recording.stop", async (send) => {
      await send("Page.stopScreencast");
    });
    this.recordingTabId = null;
  }

  async saveRecording(
    tabId: string,
    mimeType: string,
    data: Uint8Array,
  ): Promise<DesktopPreviewRecordingArtifact> {
    const createdAt = new Date().toISOString();
    const id = `browser-recording-${Date.now().toString(36)}`;
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    const directory = this.requireArtifactDirectory();
    const path = join(directory, `${id}.${extension}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, data);
    return { id, tabId, path, mimeType, sizeBytes: data.byteLength, createdAt };
  }

  onRecordingFrame(listener: RecordingFrameListener): () => void {
    this.recordingFrameListeners.add(listener);
    return () => this.recordingFrameListeners.delete(listener);
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
    return this.withControlSession(tabId, wc, "snapshot", async (send) => {
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
        consoleEntries: [...(this.diagnostics.get(wc.id)?.consoleEntries ?? [])],
        networkEntries: [...(this.diagnostics.get(wc.id)?.networkEntries ?? [])],
        actionTimeline: [...(this.actionTimeline.get(tabId) ?? [])],
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
    await this.withControlSession(tabId, wc, "click", async (send) => {
      await Promise.all([
        send("Runtime.enable"),
        send("Input.setIgnoreInputEvents", { ignore: false }),
      ]);
      let x: number;
      let y: number;
      if ("selector" in input || "locator" in input) {
        await this.ensurePlaywrightInjected(send);
        const locator = this.automationLocator(input);
        const point = await this.evaluateWithDebugger<
          { x: number; y: number } | { invalidSelector: true; message: string } | { notFound: true }
        >(
          send,
          `(() => {
            try {
              const injected = globalThis.__t3PlaywrightInjected;
              const parsed = injected.parseSelector(${JSON.stringify(locator)});
              const element = injected.querySelector(parsed, document, true);
              if (!element) return { notFound: true };
              const visible = injected.elementState(element, "visible");
              const enabled = injected.elementState(element, "enabled");
              if (!visible.matches || !enabled.matches) return { notFound: true };
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
            selector: locator,
          });
        }
        if ("notFound" in point) {
          throw automationError(
            "PreviewAutomationExecutionError",
            `No element matches locator ${locator}.`,
          );
        }
        x = point.x;
        y = point.y;
      } else {
        x = input.x!;
        y = input.y!;
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
      this.emitPointerEvent({
        tabId,
        phase: "move",
        x,
        y,
        sequence: this.pointerSequence++,
        createdAt: new Date().toISOString(),
      });
      await sleep(AGENT_CURSOR_MOVE_MS);
      this.emitPointerEvent({
        tabId,
        phase: "click",
        x,
        y,
        sequence: this.pointerSequence++,
        createdAt: new Date().toISOString(),
      });
      await sleep(AGENT_CURSOR_CLICK_LEAD_MS);
      this.expectAgentInput(tabId, { kind: "pointer", x, y, button: 0 });
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
    await this.withControlSession(tabId, wc, "type", async (send) => {
      await send("Runtime.enable");
      const locator = this.automationLocator(input);
      if (locator) await this.ensurePlaywrightInjected(send);
      const focusResult = await this.evaluateWithDebugger<
        { ok: true } | { invalidSelector: true; message: string } | { notFound: true }
      >(
        send,
        `(() => {
          try {
            const element = ${locator ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${JSON.stringify(locator)}), document, true); })()` : "document.activeElement"};
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
          locator
            ? `No element matches locator ${locator}.`
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
    await this.withControlSession(tabId, wc, "press", async (send) => {
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
      this.expectAgentInput(tabId, { kind: "key", key, code: params.code });
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    });
  }

  async automationScroll(tabId: string, input: PreviewAutomationScrollInput): Promise<void> {
    const wc = this.requireWebContents(tabId);
    await this.withControlSession(tabId, wc, "scroll", async (send) => {
      await send("Runtime.enable");
      const locator = this.automationLocator(input);
      if (locator) await this.ensurePlaywrightInjected(send);
      const result = await this.evaluateWithDebugger<
        { ok: true } | { invalidSelector: true; message: string } | { notFound: true }
      >(
        send,
        `(() => {
          try {
            const target = ${locator ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${JSON.stringify(locator)}), document, true); })()` : "window"};
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
          `No element matches locator ${locator}.`,
        );
      }
    });
  }

  async automationEvaluate(tabId: string, input: PreviewAutomationEvaluateInput): Promise<unknown> {
    const wc = this.requireWebContents(tabId);
    return this.withControlSession(tabId, wc, "evaluate", async (send) => {
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
    await this.withControlSession(tabId, wc, "waitFor", async (send) => {
      await send("Runtime.enable");
      const locator = this.automationLocator(input);
      if (locator) await this.ensurePlaywrightInjected(send);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        const result = await this.evaluateWithDebugger<
          { matched: boolean } | { invalidSelector: true; message: string }
        >(
          send,
          `(() => {
            try {
              const selectorMatched = ${locator ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${JSON.stringify(locator)}), document, false) !== null; })()` : "true"};
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

  private async withControlSession<A>(
    tabId: string,
    wc: Electron.WebContents,
    action: string,
    use: (
      send: (method: string, commandParams?: Record<string, unknown>) => Promise<unknown>,
    ) => Promise<A>,
  ): Promise<A> {
    const actionEvent: PreviewAutomationActionEvent = {
      id: `browser-action-${Date.now().toString(36)}-${(this.actionSequence++).toString(36)}`,
      action,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.pushAction(tabId, actionEvent);
    const epoch = this.controlEpoch.get(tabId) ?? 0;
    const control = await this.ensureControlSession(wc);
    let resolveTail: () => void = () => undefined;
    const previous = control.tail;
    control.tail = new Promise<void>((resolve) => {
      resolveTail = resolve;
    });
    await previous;
    this.update(tabId, { controller: "agent" });
    try {
      const send = async (method: string, commandParams?: Record<string, unknown>) => {
        if ((this.controlEpoch.get(tabId) ?? 0) !== epoch) {
          throw automationError(
            "PreviewAutomationControlInterruptedError",
            "Browser control was interrupted by human input.",
          );
        }
        const result = await wc.debugger.sendCommand(method, commandParams);
        if ((this.controlEpoch.get(tabId) ?? 0) !== epoch) {
          throw automationError(
            "PreviewAutomationControlInterruptedError",
            "Browser control was interrupted by human input.",
          );
        }
        return result;
      };
      const result = await use(send);
      this.replaceAction(tabId, {
        ...actionEvent,
        status: "succeeded",
        completedAt: new Date().toISOString(),
      });
      return result;
    } catch (cause) {
      const interrupted =
        cause instanceof Error && cause.name === "PreviewAutomationControlInterruptedError";
      this.replaceAction(tabId, {
        ...actionEvent,
        status: interrupted ? "interrupted" : "failed",
        completedAt: new Date().toISOString(),
        error: cause instanceof Error ? cause.message : String(cause),
      });
      if (cause instanceof Error && cause.name.startsWith("PreviewAutomation")) throw cause;
      throw automationError(
        "PreviewAutomationExecutionError",
        cause instanceof Error ? cause.message : String(cause),
        { tabId, cause },
      );
    } finally {
      if (this.tabs.has(tabId)) this.update(tabId, { controller: "none" });
      resolveTail();
    }
  }

  private pushAction(tabId: string, event: PreviewAutomationActionEvent): void {
    const timeline = this.actionTimeline.get(tabId) ?? [];
    timeline.push(event);
    if (timeline.length > 200) timeline.splice(0, timeline.length - 200);
    this.actionTimeline.set(tabId, timeline);
  }

  private replaceAction(tabId: string, event: PreviewAutomationActionEvent): void {
    const timeline = this.actionTimeline.get(tabId);
    if (!timeline) return;
    const index = timeline.findIndex((candidate) => candidate.id === event.id);
    if (index >= 0) timeline[index] = event;
  }

  private async ensureControlSession(wc: Electron.WebContents): Promise<BrowserControlSession> {
    const existing = this.controlSessions.get(wc.id);
    if (existing) {
      await existing.initialized;
      return existing;
    }
    if (wc.isDevToolsOpened()) {
      throw automationError(
        "PreviewAutomationExecutionError",
        "Close preview DevTools before using agent browser control.",
      );
    }
    if (wc.debugger.isAttached()) {
      throw automationError(
        "PreviewAutomationExecutionError",
        "Preview control cannot attach because another debugger owns this page.",
      );
    }
    const diagnostics: BrowserDiagnostics = {
      consoleEntries: [],
      networkEntries: [],
      requests: new Map(),
    };
    this.diagnostics.set(wc.id, diagnostics);
    const onMessage: BrowserControlSession["onMessage"] = (_event, method, params) => {
      if (method === "Page.screencastFrame") {
        const frame = params;
        const sessionId = frame["sessionId"];
        if (typeof sessionId === "number") {
          void wc.debugger
            .sendCommand("Page.screencastFrameAck", { sessionId })
            .catch(() => undefined);
        }
        const tabId = this.tabIdForWebContents(wc.id);
        const metadata =
          typeof frame["metadata"] === "object" && frame["metadata"] !== null
            ? (frame["metadata"] as Record<string, unknown>)
            : {};
        if (tabId && typeof frame["data"] === "string") {
          const payload: DesktopPreviewRecordingFrame = {
            tabId,
            data: frame["data"],
            width: typeof metadata["deviceWidth"] === "number" ? metadata["deviceWidth"] : 0,
            height: typeof metadata["deviceHeight"] === "number" ? metadata["deviceHeight"] : 0,
            receivedAt: new Date().toISOString(),
          };
          for (const listener of this.recordingFrameListeners) listener(payload);
        }
      }
      this.captureDiagnosticMessage(diagnostics, method, params);
    };
    const control: BrowserControlSession = {
      webContentsId: wc.id,
      tail: Promise.resolve(),
      initialized: Promise.resolve(),
      onMessage,
    };
    wc.debugger.on("message", onMessage);
    control.initialized = (async () => {
      wc.debugger.attach("1.3");
      await Promise.all([
        wc.debugger.sendCommand("Runtime.enable"),
        wc.debugger.sendCommand("Accessibility.enable"),
        wc.debugger.sendCommand("Network.enable"),
        wc.debugger.sendCommand("Log.enable"),
      ]);
    })();
    this.controlSessions.set(wc.id, control);
    try {
      await control.initialized;
      return control;
    } catch (cause) {
      this.controlSessions.delete(wc.id);
      throw cause;
    }
  }

  private detachControlSession(webContentsId: number): void {
    const control = this.controlSessions.get(webContentsId);
    this.controlSessions.delete(webContentsId);
    this.diagnostics.delete(webContentsId);
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;
    if (control) {
      wc.debugger.off("message", control.onMessage);
    }
    if (!wc.debugger.isAttached()) return;
    try {
      wc.debugger.detach();
    } catch {
      // Target teardown can race detachment.
    }
  }

  private tabIdForWebContents(webContentsId: number): string | null {
    for (const [tabId, tab] of this.tabs) {
      if (tab.webContentsId === webContentsId) return tabId;
    }
    return null;
  }

  private captureDiagnosticMessage(
    diagnostics: BrowserDiagnostics,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const timestamp = new Date().toISOString();
    if (method === "Runtime.consoleAPICalled") {
      const args = Array.isArray(params["args"]) ? params["args"] : [];
      const text = args
        .map((arg) => {
          if (typeof arg !== "object" || arg === null) return String(arg);
          const value = arg as Record<string, unknown>;
          return String(value["value"] ?? value["description"] ?? "");
        })
        .join(" ");
      this.pushBounded(diagnostics.consoleEntries, {
        level: typeof params["type"] === "string" ? params["type"] : "log",
        text,
        timestamp,
        source: "console",
      });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const details =
        typeof params["exceptionDetails"] === "object" && params["exceptionDetails"] !== null
          ? (params["exceptionDetails"] as Record<string, unknown>)
          : {};
      this.pushBounded(diagnostics.consoleEntries, {
        level: "error",
        text: String(details["text"] ?? "Uncaught exception"),
        timestamp,
        source: "exception",
      });
      return;
    }
    if (method === "Log.entryAdded") {
      const entry =
        typeof params["entry"] === "object" && params["entry"] !== null
          ? (params["entry"] as Record<string, unknown>)
          : {};
      this.pushBounded(diagnostics.consoleEntries, {
        level: typeof entry["level"] === "string" ? entry["level"] : "info",
        text: String(entry["text"] ?? ""),
        timestamp,
        source: typeof entry["source"] === "string" ? entry["source"] : "log",
      });
      return;
    }
    const requestId = typeof params["requestId"] === "string" ? params["requestId"] : null;
    if (method === "Network.requestWillBeSent" && requestId) {
      const request =
        typeof params["request"] === "object" && params["request"] !== null
          ? (params["request"] as Record<string, unknown>)
          : {};
      diagnostics.requests.set(requestId, {
        url: String(request["url"] ?? ""),
        method: String(request["method"] ?? "GET"),
      });
      return;
    }
    if (method === "Network.responseReceived" && requestId) {
      const request = diagnostics.requests.get(requestId);
      const response =
        typeof params["response"] === "object" && params["response"] !== null
          ? (params["response"] as Record<string, unknown>)
          : {};
      const status = typeof response["status"] === "number" ? response["status"] : null;
      if (request && status !== null && status >= 400) {
        this.pushBounded(diagnostics.networkEntries, {
          ...request,
          status,
          failed: true,
          timestamp,
        });
      }
      return;
    }
    if (method === "Network.loadingFailed" && requestId) {
      const request = diagnostics.requests.get(requestId);
      if (request) {
        this.pushBounded(diagnostics.networkEntries, {
          ...request,
          status: null,
          failed: true,
          errorText: String(params["errorText"] ?? "Network request failed"),
          timestamp,
        });
      }
      diagnostics.requests.delete(requestId);
      return;
    }
    if (method === "Network.loadingFinished" && requestId) diagnostics.requests.delete(requestId);
  }

  private pushBounded<A>(buffer: A[], entry: A): void {
    buffer.push(entry);
    if (buffer.length > DIAGNOSTIC_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - DIAGNOSTIC_BUFFER_LIMIT);
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

  private automationLocator(input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
  }): string | null {
    if (input.locator) return input.locator;
    if (input.selector) return `css=${input.selector}`;
    return null;
  }

  private async ensurePlaywrightInjected(
    send: (method: string, commandParams?: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    const installed = await this.evaluateWithDebugger<boolean>(
      send,
      "Boolean(globalThis.__t3PlaywrightInjected)",
      true,
    );
    if (installed) return;
    const expression = await playwrightInjectedRuntimeInstallExpression();
    await this.evaluateWithDebugger(send, expression, true);
  }

  onStateChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onPointerEvent(listener: PointerEventListener): () => void {
    this.pointerEventListeners.add(listener);
    return () => {
      this.pointerEventListeners.delete(listener);
    };
  }

  private emitPointerEvent(event: DesktopPreviewPointerEvent): void {
    for (const listener of this.pointerEventListeners) listener(event);
  }

  private expectAgentInput(tabId: string, signal: PreviewInputSignal): void {
    const now = Date.now();
    const pending = (this.expectedAgentInputs.get(tabId) ?? []).filter(
      (expected) => expected.expiresAt > now,
    );
    pending.push({ signal, expiresAt: now + 1_000 });
    this.expectedAgentInputs.set(tabId, pending);
  }

  private consumeExpectedAgentInput(tabId: string, signal: PreviewInputSignal): boolean {
    const now = Date.now();
    const pending = (this.expectedAgentInputs.get(tabId) ?? []).filter(
      (expected) => expected.expiresAt > now,
    );
    const index = pending.findIndex((expected) => inputSignalsMatch(expected.signal, signal));
    if (index < 0) {
      if (pending.length === 0) this.expectedAgentInputs.delete(tabId);
      else this.expectedAgentInputs.set(tabId, pending);
      return false;
    }
    pending.splice(index, 1);
    if (pending.length === 0) this.expectedAgentInputs.delete(tabId);
    else this.expectedAgentInputs.set(tabId, pending);
    return true;
  }

  destroy(): void {
    for (const tabId of Array.from(this.tabs.keys())) {
      this.closeTab(tabId);
    }
    this.listeners.clear();
    this.expectedAgentInputs.clear();
    this.pointerEventListeners.clear();
    this.recordingFrameListeners.clear();
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
    const humanInput = (_event: unknown, rawSignal?: unknown): void => {
      if (isPreviewInputSignal(rawSignal) && this.consumeExpectedAgentInput(tabId, rawSignal)) {
        return;
      }
      this.controlEpoch.set(tabId, (this.controlEpoch.get(tabId) ?? 0) + 1);
      this.update(tabId, { controller: "human" });
      void sleep(750).then(() => {
        if (this.tabs.get(tabId)?.controller === "human") {
          this.update(tabId, { controller: "none" });
        }
      });
    };

    wc.on("did-navigate", sync);
    wc.on("did-navigate-in-page", sync);
    wc.on("page-title-updated", sync);
    wc.on("did-start-loading", sync);
    wc.on("did-stop-loading", sync);
    wc.on("did-fail-load", failed as never);
    wc.ipc.on(HUMAN_INPUT_CHANNEL, humanInput);

    // Keep external links inside the same view (matches ami's policy).
    wc.setWindowOpenHandler(({ url }) => {
      void wc.loadURL(url);
      return { action: "deny" };
    });

    // Forward app-level shortcuts to the main window so mod+shift+J etc.
    // still toggles the preview panel even when the webview has focus.
    const beforeInput = (event: Electron.Event, input: Electron.Input): void => {
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
    };
    wc.on("before-input-event", beforeInput);

    this.attached.set(wc.id, { navigate: sync, failed, humanInput, beforeInput });
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
    wc.off("before-input-event", handlers.beforeInput);
    wc.ipc.off(HUMAN_INPUT_CHANNEL, handlers.humanInput);
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

export class PreviewManagerError extends Data.TaggedError("PreviewManagerError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Desktop preview operation failed: ${this.operation}`;
  }
}

export interface PreviewManagerShape {
  readonly setMainWindow: (window: BrowserWindow) => Effect.Effect<void, PreviewManagerError>;
  readonly getBrowserSession: (scope?: string) => Effect.Effect<Session, PreviewManagerError>;
  readonly isBrowserPartition: (partition: string) => boolean;
  readonly createTab: (tabId: string) => Effect.Effect<PreviewTabState, PreviewManagerError>;
  readonly closeTab: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly registerWebview: (
    tabId: string,
    webContentsId: number,
  ) => Effect.Effect<void, PreviewManagerError>;
  readonly navigate: (tabId: string, url: string) => Effect.Effect<void, PreviewManagerError>;
  readonly goBack: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly goForward: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly refresh: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly zoomIn: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly zoomOut: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly resetZoom: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly hardReload: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly openDevTools: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly clearCookies: () => Effect.Effect<void, PreviewManagerError>;
  readonly clearCache: () => Effect.Effect<void, PreviewManagerError>;
  readonly getBrowserPartition: (scope?: string) => string;
  readonly setAnnotationTheme: (
    theme: DesktopPreviewAnnotationTheme,
  ) => Effect.Effect<void, PreviewManagerError>;
  readonly pickElement: (
    tabId: string,
  ) => Effect.Effect<PreviewAnnotationPayload | null, PreviewManagerError>;
  readonly cancelPickElement: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly captureScreenshot: (
    tabId: string,
  ) => Effect.Effect<DesktopPreviewScreenshotArtifact, PreviewManagerError>;
  readonly revealArtifact: (path: string) => Effect.Effect<void, PreviewManagerError>;
  readonly copyArtifactToClipboard: (path: string) => Effect.Effect<void, PreviewManagerError>;
  readonly startRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly stopRecording: (tabId: string) => Effect.Effect<void, PreviewManagerError>;
  readonly saveRecording: (
    tabId: string,
    mimeType: string,
    data: Uint8Array,
  ) => Effect.Effect<DesktopPreviewRecordingArtifact, PreviewManagerError>;
  readonly automationStatus: (
    tabId: string,
  ) => Effect.Effect<PreviewAutomationStatus, PreviewManagerError>;
  readonly automationSnapshot: (
    tabId: string,
  ) => Effect.Effect<PreviewAutomationSnapshot, PreviewManagerError>;
  readonly automationClick: (
    tabId: string,
    input: PreviewAutomationClickInput,
  ) => Effect.Effect<void, PreviewManagerError>;
  readonly automationType: (
    tabId: string,
    input: PreviewAutomationTypeInput,
  ) => Effect.Effect<void, PreviewManagerError>;
  readonly automationPress: (
    tabId: string,
    input: PreviewAutomationPressInput,
  ) => Effect.Effect<void, PreviewManagerError>;
  readonly automationScroll: (
    tabId: string,
    input: PreviewAutomationScrollInput,
  ) => Effect.Effect<void, PreviewManagerError>;
  readonly automationEvaluate: (
    tabId: string,
    input: PreviewAutomationEvaluateInput,
  ) => Effect.Effect<unknown, PreviewManagerError>;
  readonly automationWaitFor: (
    tabId: string,
    input: PreviewAutomationWaitForInput,
  ) => Effect.Effect<void, PreviewManagerError>;
  readonly subscribeStateChanges: (listener: Listener) => Effect.Effect<void, never, Scope.Scope>;
  readonly subscribePointerEvents: (
    listener: PointerEventListener,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly subscribeRecordingFrames: (
    listener: RecordingFrameListener,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export class PreviewManager extends Context.Service<PreviewManager, PreviewManagerShape>()(
  "@t3tools/desktop/preview/Manager/PreviewManager",
) {}

const make = Effect.fn("PreviewManager.make")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const browserSession = yield* BrowserSession.BrowserSession;
  const manager = new PreviewViewManager();
  manager.configureArtifactDirectory(environment.browserArtifactsDir);
  yield* Effect.addFinalizer(() => Effect.sync(() => manager.destroy()));

  const attempt = <A>(
    operation: string,
    evaluate: () => A,
  ): Effect.Effect<A, PreviewManagerError> =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new PreviewManagerError({ operation, cause }),
    });
  const attemptPromise = <A>(
    operation: string,
    evaluate: () => Promise<A>,
  ): Effect.Effect<A, PreviewManagerError> =>
    Effect.tryPromise({
      try: evaluate,
      catch: (cause) => new PreviewManagerError({ operation, cause }),
    });
  const browserSessionEffect = <A>(
    operation: string,
    effect: Effect.Effect<A, BrowserSession.BrowserSessionError>,
  ): Effect.Effect<A, PreviewManagerError> =>
    effect.pipe(Effect.mapError((cause) => new PreviewManagerError({ operation, cause })));

  return PreviewManager.of({
    setMainWindow: Effect.fn("PreviewManager.setMainWindow")(function* (window) {
      yield* attempt("setMainWindow", () => manager.setMainWindow(window));
    }),
    getBrowserSession: Effect.fn("PreviewManager.getBrowserSession")(function* (scope) {
      return yield* browserSessionEffect("getBrowserSession", browserSession.getSession(scope));
    }),
    isBrowserPartition: browserSession.isPartition,
    createTab: Effect.fn("PreviewManager.createTab")(function* (tabId) {
      return yield* attempt("createTab", () => manager.createTab(tabId));
    }),
    closeTab: Effect.fn("PreviewManager.closeTab")(function* (tabId) {
      yield* attempt("closeTab", () => manager.closeTab(tabId));
    }),
    registerWebview: Effect.fn("PreviewManager.registerWebview")(function* (tabId, webContentsId) {
      yield* attempt("registerWebview", () => manager.registerWebview(tabId, webContentsId));
    }),
    navigate: Effect.fn("PreviewManager.navigate")(function* (tabId, url) {
      yield* attemptPromise("navigate", () => manager.navigate(tabId, url));
    }),
    goBack: Effect.fn("PreviewManager.goBack")(function* (tabId) {
      yield* attempt("goBack", () => manager.goBack(tabId));
    }),
    goForward: Effect.fn("PreviewManager.goForward")(function* (tabId) {
      yield* attempt("goForward", () => manager.goForward(tabId));
    }),
    refresh: Effect.fn("PreviewManager.refresh")(function* (tabId) {
      yield* attempt("refresh", () => manager.refresh(tabId));
    }),
    zoomIn: Effect.fn("PreviewManager.zoomIn")(function* (tabId) {
      yield* attempt("zoomIn", () => manager.zoomIn(tabId));
    }),
    zoomOut: Effect.fn("PreviewManager.zoomOut")(function* (tabId) {
      yield* attempt("zoomOut", () => manager.zoomOut(tabId));
    }),
    resetZoom: Effect.fn("PreviewManager.resetZoom")(function* (tabId) {
      yield* attempt("resetZoom", () => manager.resetZoom(tabId));
    }),
    hardReload: Effect.fn("PreviewManager.hardReload")(function* (tabId) {
      yield* attempt("hardReload", () => manager.hardReload(tabId));
    }),
    openDevTools: Effect.fn("PreviewManager.openDevTools")(function* (tabId) {
      yield* attempt("openDevTools", () => manager.openDevTools(tabId));
    }),
    clearCookies: Effect.fn("PreviewManager.clearCookies")(function* () {
      yield* browserSessionEffect("clearCookies", browserSession.clearCookies());
    }),
    clearCache: Effect.fn("PreviewManager.clearCache")(function* () {
      yield* browserSessionEffect("clearCache", browserSession.clearCache());
    }),
    getBrowserPartition: browserSession.getPartition,
    setAnnotationTheme: Effect.fn("PreviewManager.setAnnotationTheme")(function* (theme) {
      yield* attempt("setAnnotationTheme", () => manager.setAnnotationTheme(theme));
    }),
    pickElement: Effect.fn("PreviewManager.pickElement")(function* (tabId) {
      return yield* attemptPromise("pickElement", () => manager.pickElement(tabId));
    }),
    cancelPickElement: Effect.fn("PreviewManager.cancelPickElement")(function* (tabId) {
      yield* attempt("cancelPickElement", () => manager.cancelPickElement(tabId));
    }),
    captureScreenshot: Effect.fn("PreviewManager.captureScreenshot")(function* (tabId) {
      return yield* attemptPromise("captureScreenshot", () => manager.captureScreenshot(tabId));
    }),
    revealArtifact: Effect.fn("PreviewManager.revealArtifact")(function* (path) {
      yield* attempt("revealArtifact", () => manager.revealArtifact(path));
    }),
    copyArtifactToClipboard: Effect.fn("PreviewManager.copyArtifactToClipboard")(function* (path) {
      yield* attempt("copyArtifactToClipboard", () => manager.copyArtifactToClipboard(path));
    }),
    startRecording: Effect.fn("PreviewManager.startRecording")(function* (tabId) {
      yield* attemptPromise("startRecording", () => manager.startRecording(tabId));
    }),
    stopRecording: Effect.fn("PreviewManager.stopRecording")(function* (tabId) {
      yield* attemptPromise("stopRecording", () => manager.stopRecording(tabId));
    }),
    saveRecording: Effect.fn("PreviewManager.saveRecording")(function* (tabId, mimeType, data) {
      return yield* attemptPromise("saveRecording", () =>
        manager.saveRecording(tabId, mimeType, data),
      );
    }),
    automationStatus: Effect.fn("PreviewManager.automationStatus")(function* (tabId) {
      return yield* attempt("automationStatus", () => manager.automationStatus(tabId));
    }),
    automationSnapshot: Effect.fn("PreviewManager.automationSnapshot")(function* (tabId) {
      return yield* attemptPromise("automationSnapshot", () => manager.automationSnapshot(tabId));
    }),
    automationClick: Effect.fn("PreviewManager.automationClick")(function* (tabId, input) {
      yield* attemptPromise("automationClick", () => manager.automationClick(tabId, input));
    }),
    automationType: Effect.fn("PreviewManager.automationType")(function* (tabId, input) {
      yield* attemptPromise("automationType", () => manager.automationType(tabId, input));
    }),
    automationPress: Effect.fn("PreviewManager.automationPress")(function* (tabId, input) {
      yield* attemptPromise("automationPress", () => manager.automationPress(tabId, input));
    }),
    automationScroll: Effect.fn("PreviewManager.automationScroll")(function* (tabId, input) {
      yield* attemptPromise("automationScroll", () => manager.automationScroll(tabId, input));
    }),
    automationEvaluate: Effect.fn("PreviewManager.automationEvaluate")(function* (tabId, input) {
      return yield* attemptPromise("automationEvaluate", () =>
        manager.automationEvaluate(tabId, input),
      );
    }),
    automationWaitFor: Effect.fn("PreviewManager.automationWaitFor")(function* (tabId, input) {
      yield* attemptPromise("automationWaitFor", () => manager.automationWaitFor(tabId, input));
    }),
    subscribeStateChanges: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => manager.onStateChange(listener)),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
    subscribePointerEvents: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => manager.onPointerEvent(listener)),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
    subscribeRecordingFrames: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => manager.onRecordingFrame(listener)),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(PreviewManager, make());

/** Exposed for tests. */
export const __testing = {
  PreviewViewManager,
};

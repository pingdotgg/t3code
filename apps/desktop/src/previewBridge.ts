import type {
  DesktopPreviewAutomationCommand,
  DesktopPreviewNavStatus,
  DesktopPreviewRecordingFrame,
  DesktopPreviewStateChange,
  DesktopPreviewTabState,
} from "@t3tools/contracts";
import { BrowserWindow, ipcMain, webContents, type WebContents } from "electron";

import { isPreviewPartition } from "@t3tools/shared/preview";

const PREVIEW_CREATE_TAB_CHANNEL = "desktop:preview-create-tab";
const PREVIEW_REGISTER_WEBVIEW_CHANNEL = "desktop:preview-register-webview";
const PREVIEW_NAVIGATE_CHANNEL = "desktop:preview-navigate";
const PREVIEW_GO_BACK_CHANNEL = "desktop:preview-go-back";
const PREVIEW_GO_FORWARD_CHANNEL = "desktop:preview-go-forward";
const PREVIEW_REFRESH_CHANNEL = "desktop:preview-refresh";
const PREVIEW_HARD_RELOAD_CHANNEL = "desktop:preview-hard-reload";
const PREVIEW_ZOOM_IN_CHANNEL = "desktop:preview-zoom-in";
const PREVIEW_ZOOM_OUT_CHANNEL = "desktop:preview-zoom-out";
const PREVIEW_RESET_ZOOM_CHANNEL = "desktop:preview-reset-zoom";
const PREVIEW_OPEN_DEVTOOLS_CHANNEL = "desktop:preview-open-devtools";
const PREVIEW_CLEAR_COOKIES_CHANNEL = "desktop:preview-clear-cookies";
const PREVIEW_CLEAR_CACHE_CHANNEL = "desktop:preview-clear-cache";
const PREVIEW_CAPTURE_SCREENSHOT_CHANNEL = "desktop:preview-capture-screenshot";
const PREVIEW_START_RECORDING_CHANNEL = "desktop:preview-start-recording";
const PREVIEW_STOP_RECORDING_CHANNEL = "desktop:preview-stop-recording";
const PREVIEW_ANNOTATE_ELEMENT_CHANNEL = "desktop:preview-annotate-element";
const PREVIEW_CLEAR_ANNOTATIONS_CHANNEL = "desktop:preview-clear-annotations";
const PREVIEW_RUN_AUTOMATION_CHANNEL = "desktop:preview-run-automation";
const PREVIEW_CLOSE_TAB_CHANNEL = "desktop:preview-close-tab";
const PREVIEW_STATE_CHANNEL = "desktop:preview-state";

const previewTabs = new Map<string, DesktopPreviewTabRecord>();
const previewRecordings = new Map<string, DesktopPreviewRecordingRecord>();
const PREVIEW_MIN_ZOOM_FACTOR = 0.25;
const PREVIEW_MAX_ZOOM_FACTOR = 5;
const PREVIEW_ZOOM_STEP = 0.1;
const PREVIEW_RECORDING_FRAME_INTERVAL_MS = 1_000;

interface DesktopPreviewTabRecord {
  tabId: string;
  url: string | null;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  zoomFactor: number;
  navStatus: DesktopPreviewNavStatus;
  webContentsId: number | null;
  partition: string | null;
  updatedAt: string;
  cleanup: Array<() => void>;
}

interface DesktopPreviewRecordingRecord {
  readonly startedAt: string;
  readonly timer: ReturnType<typeof setInterval>;
  readonly frames: DesktopPreviewRecordingFrame[];
}

type PreviewNavigationAdapter = {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  navigationHistory?: {
    canGoBack?: () => boolean;
    canGoForward?: () => boolean;
    goBack?: () => void;
    goForward?: () => void;
  };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringProperty(
  input: Record<string, unknown>,
  property: string,
  label: string,
): string {
  const value = input[property];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid desktop preview ${label}.`);
  }
  return value;
}

function readPreviewTabId(rawInput: unknown): string {
  if (!isPlainObject(rawInput)) {
    throw new Error("Invalid desktop preview input.");
  }
  return readStringProperty(rawInput, "tabId", "tab id");
}

function readPreviewUrl(rawInput: unknown): string {
  if (!isPlainObject(rawInput)) {
    throw new Error("Invalid desktop preview input.");
  }
  const url = readStringProperty(rawInput, "url", "url");
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported desktop preview protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function readPreviewPartition(rawInput: unknown): string | null {
  if (!isPlainObject(rawInput)) {
    return null;
  }
  const partition = rawInput.partition;
  if (typeof partition !== "string" || partition.trim().length === 0) {
    return null;
  }
  const trimmedPartition = partition.trim();
  if (!isPreviewPartition(trimmedPartition)) {
    throw new Error("Invalid desktop preview partition.");
  }
  return trimmedPartition;
}

function readPreviewWebContentsId(rawInput: unknown): number {
  if (!isPlainObject(rawInput)) {
    throw new Error("Invalid desktop preview input.");
  }
  const webContentsId = rawInput.webContentsId;
  if (typeof webContentsId !== "number" || !Number.isInteger(webContentsId) || webContentsId <= 0) {
    throw new Error("Invalid desktop preview webContents id.");
  }
  return webContentsId;
}

function readOptionalStringProperty(
  input: Record<string, unknown>,
  property: string,
): string | undefined {
  const value = input[property];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readPreviewAutomationCommand(rawInput: unknown): DesktopPreviewAutomationCommand {
  if (!isPlainObject(rawInput)) {
    throw new Error("Invalid desktop preview automation input.");
  }
  const type = readStringProperty(rawInput, "type", "automation type");
  const tabId = readStringProperty(rawInput, "tabId", "tab id");
  switch (type) {
    case "click":
      return {
        type,
        tabId,
        selector: readStringProperty(rawInput, "selector", "selector"),
      };
    case "type":
      return {
        type,
        tabId,
        selector: readStringProperty(rawInput, "selector", "selector"),
        text: readStringProperty(rawInput, "text", "text"),
      };
    case "key":
      return {
        type,
        tabId,
        key: readStringProperty(rawInput, "key", "key"),
      };
    default:
      throw new Error(`Unsupported desktop preview automation command: ${type}`);
  }
}

function createPreviewTabRecord(tabId: string): DesktopPreviewTabRecord {
  return {
    tabId,
    url: null,
    title: null,
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    zoomFactor: 1,
    navStatus: { kind: "idle" },
    webContentsId: null,
    partition: null,
    updatedAt: new Date().toISOString(),
    cleanup: [],
  };
}

function getOrCreatePreviewTabRecord(tabId: string): DesktopPreviewTabRecord {
  const existing = previewTabs.get(tabId);
  if (existing) {
    return existing;
  }

  const record = createPreviewTabRecord(tabId);
  previewTabs.set(tabId, record);
  return record;
}

function readPreviewTabRecord(rawInput: unknown): DesktopPreviewTabRecord | null {
  const tabId = readPreviewTabId(rawInput);
  return previewTabs.get(tabId) ?? null;
}

function toDesktopPreviewTabState(record: DesktopPreviewTabRecord): DesktopPreviewTabState {
  return {
    tabId: record.tabId,
    url: record.url,
    title: record.title,
    canGoBack: record.canGoBack,
    canGoForward: record.canGoForward,
    isLoading: record.isLoading,
    zoomFactor: record.zoomFactor,
    navStatus: record.navStatus,
    updatedAt: record.updatedAt,
  };
}

function emitPreviewStateChange(change: DesktopPreviewStateChange): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(PREVIEW_STATE_CHANNEL, change);
    }
  }
}

function emitPreviewTabUpdated(record: DesktopPreviewTabRecord): void {
  emitPreviewStateChange({ type: "updated", state: toDesktopPreviewTabState(record) });
}

function touchPreviewTabRecord(record: DesktopPreviewTabRecord): void {
  record.updatedAt = new Date().toISOString();
}

function hasMeaningfulPreviewUrl(url: string | null): url is string {
  return Boolean(url && url !== "about:blank");
}

function resolvePreviewWebContents(record: DesktopPreviewTabRecord): WebContents | null {
  if (record.webContentsId === null) {
    return null;
  }
  const contents = webContents.fromId(record.webContentsId);
  if (!contents || contents.isDestroyed() || !isPreviewWebContents(contents, record)) {
    record.webContentsId = null;
    return null;
  }
  return contents;
}

function isPreviewWebContents(contents: WebContents, record: DesktopPreviewTabRecord): boolean {
  const hostWebContentsType = (contents as WebContents & { getType?: () => string }).getType?.();
  return hostWebContentsType === "webview" && isPreviewPartition(record.partition ?? "");
}

function requirePreviewWebContents(rawInput: unknown): WebContents {
  const record = readPreviewTabRecord(rawInput);
  const contents = record ? resolvePreviewWebContents(record) : null;
  if (!contents) {
    throw new Error("Desktop preview tab is not attached.");
  }
  return contents;
}

async function capturePreviewFrame(input: {
  readonly tabId: string;
}): Promise<DesktopPreviewRecordingFrame> {
  const contents = requirePreviewWebContents(input);
  const image = await contents.capturePage();
  return {
    dataUrl: image.toDataURL(),
    capturedAt: new Date().toISOString(),
  };
}

function stopPreviewRecording(tabId: string): DesktopPreviewRecordingRecord | null {
  const recording = previewRecordings.get(tabId) ?? null;
  if (!recording) {
    return null;
  }
  clearInterval(recording.timer);
  previewRecordings.delete(tabId);
  return recording;
}

async function injectPreviewAnnotation(input: {
  readonly tabId: string;
  readonly selector: string;
  readonly label?: string;
}): Promise<void> {
  const contents = requirePreviewWebContents({ tabId: input.tabId });
  const selector = JSON.stringify(input.selector);
  const label = JSON.stringify(input.label ?? input.selector);
  await contents.executeJavaScript(`
    (() => {
      const selector = ${selector};
      const label = ${label};
      const target = document.querySelector(selector);
      if (!target) throw new Error("No element matched selector: " + selector);
      window.__t3PreviewAnnotations?.forEach((node) => node.remove());
      window.__t3PreviewAnnotations = [];
      const rect = target.getBoundingClientRect();
      const outline = document.createElement("div");
      outline.style.cssText = [
        "position:fixed",
        "left:" + rect.left + "px",
        "top:" + rect.top + "px",
        "width:" + rect.width + "px",
        "height:" + rect.height + "px",
        "z-index:2147483647",
        "pointer-events:none",
        "border:2px solid #3b82f6",
        "box-shadow:0 0 0 9999px rgba(15,23,42,.18)",
        "border-radius:4px"
      ].join(";");
      const badge = document.createElement("div");
      badge.textContent = label;
      badge.style.cssText = [
        "position:fixed",
        "left:" + rect.left + "px",
        "top:" + Math.max(0, rect.top - 24) + "px",
        "z-index:2147483647",
        "pointer-events:none",
        "background:#2563eb",
        "color:white",
        "font:12px system-ui,sans-serif",
        "padding:2px 6px",
        "border-radius:999px",
        "max-width:280px",
        "overflow:hidden",
        "text-overflow:ellipsis",
        "white-space:nowrap"
      ].join(";");
      document.documentElement.append(outline, badge);
      window.__t3PreviewAnnotations.push(outline, badge);
    })();
  `);
}

async function clearPreviewAnnotations(rawInput: unknown): Promise<void> {
  const contents = requirePreviewWebContents(rawInput);
  await contents.executeJavaScript(`
    (() => {
      window.__t3PreviewAnnotations?.forEach((node) => node.remove());
      window.__t3PreviewAnnotations = [];
    })();
  `);
}

function readNavigationCapabilities(contents: WebContents): {
  canGoBack: boolean;
  canGoForward: boolean;
} {
  const navigation = contents as WebContents & PreviewNavigationAdapter;
  return {
    canGoBack: navigation.canGoBack?.() ?? navigation.navigationHistory?.canGoBack?.() ?? false,
    canGoForward:
      navigation.canGoForward?.() ?? navigation.navigationHistory?.canGoForward?.() ?? false,
  };
}

function updatePreviewTabFromWebContents(
  record: DesktopPreviewTabRecord,
  contents: WebContents,
  navStatus?: DesktopPreviewNavStatus,
): void {
  const currentUrl = contents.getURL();
  const currentTitle = contents.getTitle();
  const capabilities = readNavigationCapabilities(contents);

  record.url = hasMeaningfulPreviewUrl(currentUrl) ? currentUrl : record.url;
  record.title = currentTitle || record.title || record.url;
  record.canGoBack = capabilities.canGoBack;
  record.canGoForward = capabilities.canGoForward;
  record.isLoading = contents.isLoading();
  record.navStatus =
    navStatus ??
    (record.isLoading && record.url
      ? { kind: "loading", url: record.url, title: record.title }
      : record.url
        ? { kind: "success", url: record.url, title: record.title }
        : { kind: "idle" });
  touchPreviewTabRecord(record);
}

function removePreviewTabListeners(record: DesktopPreviewTabRecord): void {
  for (const cleanup of record.cleanup.splice(0)) {
    cleanup();
  }
}

function bindPreviewWebContents(record: DesktopPreviewTabRecord, contents: WebContents): void {
  removePreviewTabListeners(record);
  record.webContentsId = contents.id;
  contents.setZoomFactor(record.zoomFactor);

  const update = (navStatus?: DesktopPreviewNavStatus) => {
    if (contents.isDestroyed()) {
      return;
    }
    updatePreviewTabFromWebContents(record, contents, navStatus);
    emitPreviewTabUpdated(record);
  };

  const handleStartLoading = () => {
    const currentUrl = contents.getURL();
    const url = hasMeaningfulPreviewUrl(currentUrl) ? currentUrl : (record.url ?? "");
    update({ kind: "loading", url, title: contents.getTitle() || record.title });
  };
  const handleStopLoading = () => {
    const currentUrl = contents.getURL();
    const url = hasMeaningfulPreviewUrl(currentUrl) ? currentUrl : (record.url ?? "");
    update(url ? { kind: "success", url, title: contents.getTitle() || record.title } : undefined);
  };
  const handleNavigate = (_event: unknown, url: string) => {
    record.url = url;
    update({ kind: "success", url, title: contents.getTitle() || record.title });
  };
  const handleFailLoad = (
    _event: unknown,
    errorCode: number,
    errorText: string,
    validatedUrl: string,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame) {
      return;
    }
    const currentUrl = contents.getURL();
    const url =
      validatedUrl || (hasMeaningfulPreviewUrl(currentUrl) ? currentUrl : null) || record.url || "";
    update({
      kind: "failed",
      url,
      title: contents.getTitle() || record.title,
      errorCode,
      errorText,
    });
  };
  const handleDestroyed = () => {
    record.webContentsId = null;
    removePreviewTabListeners(record);
    emitPreviewTabUpdated(record);
  };

  contents.on("did-start-loading", handleStartLoading);
  record.cleanup.push(() => contents.removeListener("did-start-loading", handleStartLoading));
  contents.on("did-stop-loading", handleStopLoading);
  record.cleanup.push(() => contents.removeListener("did-stop-loading", handleStopLoading));
  contents.on("did-navigate", handleNavigate);
  record.cleanup.push(() => contents.removeListener("did-navigate", handleNavigate));
  contents.on("did-navigate-in-page", handleNavigate);
  record.cleanup.push(() => contents.removeListener("did-navigate-in-page", handleNavigate));
  contents.on("did-fail-load", handleFailLoad);
  record.cleanup.push(() => contents.removeListener("did-fail-load", handleFailLoad));
  contents.on("destroyed", handleDestroyed);
  record.cleanup.push(() => contents.removeListener("destroyed", handleDestroyed));

  updatePreviewTabFromWebContents(record, contents);
  emitPreviewTabUpdated(record);
}

function isAbortedNavigationError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return code === "ERR_ABORTED" || error.message.includes("ERR_ABORTED");
  }
  return false;
}

async function loadPreviewUrl(
  record: DesktopPreviewTabRecord,
  contents: WebContents,
  url: string,
): Promise<void> {
  record.url = url;
  record.navStatus = { kind: "loading", url, title: record.title };
  record.isLoading = true;
  touchPreviewTabRecord(record);
  emitPreviewTabUpdated(record);

  try {
    await contents.loadURL(url);
  } catch (error) {
    // A concurrent navigation (typically the renderer's `<webview src>`
    // attribute loading the same URL) aborts this load with ERR_ABORTED.
    // That is expected, not a failure — leave the resulting status to the
    // did-stop-loading / did-fail-load listeners bound to this WebContents.
    if (isAbortedNavigationError(error)) {
      return;
    }
    record.isLoading = false;
    record.navStatus = {
      kind: "failed",
      url,
      title: record.title,
      errorCode: -1,
      errorText: error instanceof Error ? error.message : "Failed to load preview URL.",
    };
    touchPreviewTabRecord(record);
    emitPreviewTabUpdated(record);
    throw error;
  }
}

function navigatePreviewHistory(
  record: DesktopPreviewTabRecord,
  direction: "back" | "forward",
): void {
  const contents = resolvePreviewWebContents(record);
  if (!contents) {
    return;
  }
  const navigation = contents as WebContents & PreviewNavigationAdapter;
  if (direction === "back") {
    if (navigation.canGoBack?.() ?? navigation.navigationHistory?.canGoBack?.() ?? false) {
      if (navigation.goBack) {
        navigation.goBack();
      } else {
        navigation.navigationHistory?.goBack?.();
      }
    }
    return;
  }

  if (navigation.canGoForward?.() ?? navigation.navigationHistory?.canGoForward?.() ?? false) {
    if (navigation.goForward) {
      navigation.goForward();
    } else {
      navigation.navigationHistory?.goForward?.();
    }
  }
}

function setPreviewZoomFactor(
  record: DesktopPreviewTabRecord,
  zoomFactor: number,
): DesktopPreviewTabState {
  const boundedZoomFactor = Math.min(
    PREVIEW_MAX_ZOOM_FACTOR,
    Math.max(PREVIEW_MIN_ZOOM_FACTOR, zoomFactor),
  );
  record.zoomFactor = Number(boundedZoomFactor.toFixed(2));
  const contents = resolvePreviewWebContents(record);
  contents?.setZoomFactor(record.zoomFactor);
  touchPreviewTabRecord(record);
  emitPreviewTabUpdated(record);
  return toDesktopPreviewTabState(record);
}

async function runPreviewAutomationCommand(
  rawInput: unknown,
): Promise<{ ok: boolean; value?: unknown }> {
  const command = readPreviewAutomationCommand(rawInput);
  const contents = requirePreviewWebContents({ tabId: command.tabId });

  switch (command.type) {
    case "click": {
      const selector = JSON.stringify(command.selector);
      await contents.executeJavaScript(`
        (() => {
          const selector = ${selector};
          const target = document.querySelector(selector);
          if (!target) throw new Error("No element matched selector: " + selector);
          target.click();
        })();
      `);
      return { ok: true };
    }
    case "type": {
      const selector = JSON.stringify(command.selector);
      const text = JSON.stringify(command.text);
      await contents.executeJavaScript(`
        (() => {
          const selector = ${selector};
          const text = ${text};
          const target = document.querySelector(selector);
          if (!target) throw new Error("No element matched selector: " + selector);
          target.focus();
          if ("value" in target) {
            target.value = text;
            target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            target.textContent = text;
            target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          }
        })();
      `);
      return { ok: true };
    }
    case "key":
      contents.sendInputEvent({ type: "keyDown", keyCode: command.key });
      contents.sendInputEvent({ type: "keyUp", keyCode: command.key });
      return { ok: true };
  }
  const _exhaustive: never = command;
  throw new Error(`Unsupported desktop preview automation command: ${String(_exhaustive)}`);
}

function closePreviewTabRecord(rawInput: unknown): void {
  const tabId = readPreviewTabId(rawInput);
  const record = previewTabs.get(tabId);
  if (record) {
    removePreviewTabListeners(record);
    stopPreviewRecording(tabId);
    previewTabs.delete(tabId);
  }
  emitPreviewStateChange({ type: "closed", tabId });
}

export function registerPreviewIpcHandlers(): void {
  ipcMain.removeHandler(PREVIEW_CREATE_TAB_CHANNEL);
  ipcMain.handle(PREVIEW_CREATE_TAB_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    const url = readPreviewUrl(rawInput);
    const record = getOrCreatePreviewTabRecord(tabId);
    record.partition = readPreviewPartition(rawInput);
    const contents = resolvePreviewWebContents(record);

    // The renderer's `<webview src>` element performs the actual navigation.
    // The main process only mirrors state — issuing our own loadURL here would
    // race with the element's in-flight load and abort it (ERR_ABORTED),
    // leaving the preview stuck in a "loading" state.
    record.url = url;
    record.navStatus =
      contents && !contents.isLoading() && contents.getURL() === url
        ? { kind: "success", url, title: record.title }
        : { kind: "loading", url, title: record.title };
    touchPreviewTabRecord(record);
    emitPreviewTabUpdated(record);

    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_REGISTER_WEBVIEW_CHANNEL);
  ipcMain.handle(PREVIEW_REGISTER_WEBVIEW_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    const webContentsId = readPreviewWebContentsId(rawInput);
    const partition = readPreviewPartition(rawInput);
    const contents = webContents.fromId(webContentsId);
    const record = getOrCreatePreviewTabRecord(tabId);
    if (partition) {
      record.partition = partition;
    }
    if (!contents || contents.isDestroyed() || !isPreviewWebContents(contents, record)) {
      throw new Error("Unknown desktop preview webContents.");
    }
    bindPreviewWebContents(record, contents);
    // Navigation is driven by the renderer's `<webview src>` attribute; binding
    // listeners is enough to mirror its state. Do not call loadURL here — it
    // would abort the element's own in-flight load (ERR_ABORTED).
    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_NAVIGATE_CHANNEL);
  ipcMain.handle(PREVIEW_NAVIGATE_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    const url = readPreviewUrl(rawInput);
    const record = getOrCreatePreviewTabRecord(tabId);
    const contents = resolvePreviewWebContents(record);

    if (contents) {
      await loadPreviewUrl(record, contents, url);
    } else {
      record.url = url;
      record.navStatus = { kind: "loading", url, title: record.title };
      record.isLoading = false;
      touchPreviewTabRecord(record);
      emitPreviewTabUpdated(record);
    }

    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_GO_BACK_CHANNEL);
  ipcMain.handle(PREVIEW_GO_BACK_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    navigatePreviewHistory(record, "back");
    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_GO_FORWARD_CHANNEL);
  ipcMain.handle(PREVIEW_GO_FORWARD_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    navigatePreviewHistory(record, "forward");
    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_REFRESH_CHANNEL);
  ipcMain.handle(PREVIEW_REFRESH_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    resolvePreviewWebContents(record)?.reload();
    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_HARD_RELOAD_CHANNEL);
  ipcMain.handle(PREVIEW_HARD_RELOAD_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    resolvePreviewWebContents(record)?.reloadIgnoringCache();
    return toDesktopPreviewTabState(record);
  });

  ipcMain.removeHandler(PREVIEW_ZOOM_IN_CHANNEL);
  ipcMain.handle(PREVIEW_ZOOM_IN_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    return setPreviewZoomFactor(record, record.zoomFactor + PREVIEW_ZOOM_STEP);
  });

  ipcMain.removeHandler(PREVIEW_ZOOM_OUT_CHANNEL);
  ipcMain.handle(PREVIEW_ZOOM_OUT_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    return setPreviewZoomFactor(record, record.zoomFactor - PREVIEW_ZOOM_STEP);
  });

  ipcMain.removeHandler(PREVIEW_RESET_ZOOM_CHANNEL);
  ipcMain.handle(PREVIEW_RESET_ZOOM_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return null;
    return setPreviewZoomFactor(record, 1);
  });

  ipcMain.removeHandler(PREVIEW_OPEN_DEVTOOLS_CHANNEL);
  ipcMain.handle(PREVIEW_OPEN_DEVTOOLS_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    if (!record) return;
    resolvePreviewWebContents(record)?.openDevTools({ mode: "detach" });
  });

  ipcMain.removeHandler(PREVIEW_CLEAR_COOKIES_CHANNEL);
  ipcMain.handle(PREVIEW_CLEAR_COOKIES_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    const contents = record ? resolvePreviewWebContents(record) : null;
    await contents?.session.clearStorageData({ storages: ["cookies"] });
  });

  ipcMain.removeHandler(PREVIEW_CLEAR_CACHE_CHANNEL);
  ipcMain.handle(PREVIEW_CLEAR_CACHE_CHANNEL, async (_event, rawInput: unknown) => {
    const record = readPreviewTabRecord(rawInput);
    const contents = record ? resolvePreviewWebContents(record) : null;
    await contents?.session.clearCache();
  });

  ipcMain.removeHandler(PREVIEW_CAPTURE_SCREENSHOT_CHANNEL);
  ipcMain.handle(PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    const frame = await capturePreviewFrame({ tabId });
    return {
      tabId,
      dataUrl: frame.dataUrl,
      capturedAt: frame.capturedAt,
    };
  });

  ipcMain.removeHandler(PREVIEW_START_RECORDING_CHANNEL);
  ipcMain.handle(PREVIEW_START_RECORDING_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    stopPreviewRecording(tabId);
    const frames: DesktopPreviewRecordingFrame[] = [];
    const capture = () => {
      void capturePreviewFrame({ tabId })
        .then((frame) => {
          frames.push(frame);
        })
        .catch(() => undefined);
    };
    capture();
    const timer = setInterval(capture, PREVIEW_RECORDING_FRAME_INTERVAL_MS);
    previewRecordings.set(tabId, {
      startedAt: new Date().toISOString(),
      timer,
      frames,
    });
  });

  ipcMain.removeHandler(PREVIEW_STOP_RECORDING_CHANNEL);
  ipcMain.handle(PREVIEW_STOP_RECORDING_CHANNEL, async (_event, rawInput: unknown) => {
    const tabId = readPreviewTabId(rawInput);
    const recording = stopPreviewRecording(tabId);
    if (!recording) {
      throw new Error("Desktop preview recording is not active.");
    }
    return {
      tabId,
      startedAt: recording.startedAt,
      stoppedAt: new Date().toISOString(),
      frames: recording.frames,
    };
  });

  ipcMain.removeHandler(PREVIEW_ANNOTATE_ELEMENT_CHANNEL);
  ipcMain.handle(PREVIEW_ANNOTATE_ELEMENT_CHANNEL, async (_event, rawInput: unknown) => {
    if (!isPlainObject(rawInput)) {
      throw new Error("Invalid desktop preview annotation input.");
    }
    const label = readOptionalStringProperty(rawInput, "label");
    await injectPreviewAnnotation({
      tabId: readStringProperty(rawInput, "tabId", "tab id"),
      selector: readStringProperty(rawInput, "selector", "selector"),
      ...(label ? { label } : {}),
    });
  });

  ipcMain.removeHandler(PREVIEW_CLEAR_ANNOTATIONS_CHANNEL);
  ipcMain.handle(PREVIEW_CLEAR_ANNOTATIONS_CHANNEL, async (_event, rawInput: unknown) => {
    await clearPreviewAnnotations(rawInput);
  });

  ipcMain.removeHandler(PREVIEW_RUN_AUTOMATION_CHANNEL);
  ipcMain.handle(PREVIEW_RUN_AUTOMATION_CHANNEL, async (_event, rawInput: unknown) =>
    runPreviewAutomationCommand(rawInput),
  );

  ipcMain.removeHandler(PREVIEW_CLOSE_TAB_CHANNEL);
  ipcMain.handle(PREVIEW_CLOSE_TAB_CHANNEL, async (_event, rawInput: unknown) => {
    closePreviewTabRecord(rawInput);
  });
}

import * as FS from "node:fs";
import * as Path from "node:path";

import { screen } from "electron";
import type { BrowserWindow, Rectangle } from "electron";

const WINDOW_STATE_FILE_NAME = "window-state.json";
const WINDOW_STATE_VERSION = 1;
const WINDOW_VISIBILITY_THRESHOLD = 0.2;
const WINDOW_STATE_PERSIST_DEBOUNCE_MS = 250;

type PersistedWindowRestoreMode = "normal" | "maximized" | "fullscreen-origin";

interface PersistedWindowState {
  readonly version: 1;
  readonly normalBounds: Rectangle;
  readonly restoreMode: PersistedWindowRestoreMode;
  readonly fullscreenOriginBounds?: Rectangle;
}

export interface ResolvedWindowState {
  readonly bounds: Rectangle;
  readonly restoreMode: PersistedWindowRestoreMode;
}

interface LoadWindowStateParams {
  readonly userDataPath: string;
  readonly defaultBounds: Rectangle;
  readonly minWidth: number;
  readonly minHeight: number;
}

interface AttachWindowStatePersistenceParams {
  readonly window: BrowserWindow;
  readonly userDataPath: string;
}

function getWindowStateFilePath(userDataPath: string): string {
  return Path.join(userDataPath, WINDOW_STATE_FILE_NAME);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPersistedWindowRestoreMode(value: unknown): value is PersistedWindowRestoreMode {
  return value === "normal" || value === "maximized" || value === "fullscreen-origin";
}

function parseRectangle(value: unknown): Rectangle | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { x, y, width, height } = value as Record<string, unknown>;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  return {
    x,
    y,
    width,
    height,
  };
}

function parsePersistedWindowState(raw: string): PersistedWindowState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const { version, normalBounds, restoreMode, fullscreenOriginBounds } = parsed as {
    version?: unknown;
    normalBounds?: Record<string, unknown>;
    restoreMode?: unknown;
    fullscreenOriginBounds?: Record<string, unknown>;
  };

  if (version !== WINDOW_STATE_VERSION || !isPersistedWindowRestoreMode(restoreMode)) {
    return null;
  }

  const parsedNormalBounds = parseRectangle(normalBounds);
  if (!parsedNormalBounds) {
    return null;
  }

  let parsedFullscreenOriginBounds: Rectangle | undefined;
  if (fullscreenOriginBounds !== undefined) {
    const parsedBounds = parseRectangle(fullscreenOriginBounds);
    if (!parsedBounds) {
      return null;
    }
    parsedFullscreenOriginBounds = parsedBounds;
  }

  if (restoreMode === "fullscreen-origin" && parsedFullscreenOriginBounds === undefined) {
    return null;
  }

  return {
    version: WINDOW_STATE_VERSION,
    normalBounds: parsedNormalBounds,
    restoreMode,
    ...(parsedFullscreenOriginBounds
      ? { fullscreenOriginBounds: parsedFullscreenOriginBounds }
      : {}),
  };
}

function sanitizeBounds(bounds: Rectangle, minWidth: number, minHeight: number): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(minWidth, Math.round(bounds.width)),
    height: Math.max(minHeight, Math.round(bounds.height)),
  };
}

function intersectionArea(a: Rectangle, b: Rectangle): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= left || bottom <= top) {
    return 0;
  }

  return (right - left) * (bottom - top);
}

function isWindowVisibleEnough(bounds: Rectangle): boolean {
  const display = screen.getDisplayMatching(bounds);
  const visibleArea = intersectionArea(bounds, display.workArea);
  const totalArea = bounds.width * bounds.height;

  if (totalArea <= 0) {
    return false;
  }

  return visibleArea / totalArea >= WINDOW_VISIBILITY_THRESHOLD;
}

function centerBoundsInDisplay(displayBounds: Rectangle, width: number, height: number): Rectangle {
  return {
    x: Math.round(displayBounds.x + (displayBounds.width - width) / 2),
    y: Math.round(displayBounds.y + (displayBounds.height - height) / 2),
    width,
    height,
  };
}

function buildDefaultWindowState(
  defaultBounds: Rectangle,
  minWidth: number,
  minHeight: number,
): ResolvedWindowState {
  const primaryDisplay = screen.getPrimaryDisplay();
  const width = Math.max(minWidth, Math.round(defaultBounds.width));
  const height = Math.max(minHeight, Math.round(defaultBounds.height));

  return {
    bounds: centerBoundsInDisplay(primaryDisplay.workArea, width, height),
    restoreMode: "normal",
  };
}

function readRestorableWindowState(window: BrowserWindow): PersistedWindowState {
  return {
    version: WINDOW_STATE_VERSION,
    normalBounds: window.getNormalBounds(),
    restoreMode: window.isMaximized() ? "maximized" : "normal",
  };
}

function persistWindowState(state: PersistedWindowState, userDataPath: string): void {
  try {
    const filePath = getWindowStateFilePath(userDataPath);
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn("[desktop] failed to persist window state", error);
  }
}

export function loadWindowState({
  userDataPath,
  defaultBounds,
  minWidth,
  minHeight,
}: LoadWindowStateParams): ResolvedWindowState {
  const fallback = buildDefaultWindowState(defaultBounds, minWidth, minHeight);
  const filePath = getWindowStateFilePath(userDataPath);

  if (!FS.existsSync(filePath)) {
    return fallback;
  }

  let raw: string;
  try {
    raw = FS.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }

  const parsed = parsePersistedWindowState(raw);
  if (!parsed) {
    return fallback;
  }

  const normalBounds = sanitizeBounds(parsed.normalBounds, minWidth, minHeight);
  if (!isWindowVisibleEnough(normalBounds)) {
    return fallback;
  }

  if (parsed.restoreMode === "fullscreen-origin") {
    const fullscreenOriginBoundsRaw = parsed.fullscreenOriginBounds;
    if (!fullscreenOriginBoundsRaw) {
      return fallback;
    }

    const fullscreenOriginBounds = sanitizeBounds(fullscreenOriginBoundsRaw, minWidth, minHeight);
    if (!isWindowVisibleEnough(fullscreenOriginBounds)) {
      return fallback;
    }

    return {
      bounds: fullscreenOriginBounds,
      restoreMode: "fullscreen-origin",
    };
  }

  return {
    bounds: normalBounds,
    restoreMode: parsed.restoreMode,
  };
}

export function attachWindowStatePersistence({
  window,
  userDataPath,
}: AttachWindowStatePersistenceParams): void {
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRestorableState = readRestorableWindowState(window);
  let lastVisibleBounds = window.getBounds();

  const resolvePersistedWindowState = (): PersistedWindowState => {
    if (window.isFullScreen()) {
      return {
        ...lastRestorableState,
        restoreMode: "fullscreen-origin",
        fullscreenOriginBounds: lastVisibleBounds,
      };
    }

    lastRestorableState = readRestorableWindowState(window);
    lastVisibleBounds = window.getBounds();
    return lastRestorableState;
  };

  const clearPersistTimer = () => {
    if (persistTimer === null) return;
    clearTimeout(persistTimer);
    persistTimer = null;
  };

  const persistNow = () => {
    clearPersistTimer();
    persistWindowState(resolvePersistedWindowState(), userDataPath);
  };

  const schedulePersist = () => {
    clearPersistTimer();
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistWindowState(resolvePersistedWindowState(), userDataPath);
    }, WINDOW_STATE_PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  };

  window.on("resize", schedulePersist);
  window.on("move", schedulePersist);
  window.on("maximize", persistNow);
  window.on("unmaximize", persistNow);
  window.on("enter-full-screen", persistNow);
  window.on("leave-full-screen", persistNow);
  window.on("close", persistNow);
}

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { type ClientSettings, type DesktopZoomState } from "@t3tools/contracts";
import { ClientSettingsSchema } from "@t3tools/contracts/settings";
import {
  clampWindowZoomLevel,
  zoomLevelToPercent,
  zoomLevelToZoomFactor,
} from "@t3tools/shared/zoom";
import { useSettings, useUpdateSettings, CLIENT_SETTINGS_STORAGE_KEY } from "./useSettings";
import { getLocalStorageItem } from "./useLocalStorage";

const INDICATOR_DURATION_MS = 750;

type WindowZoomSnapshot = {
  zoomLevel: number;
  zoomFactor: number;
  zoomPercent: number;
  indicatorVisible: boolean;
  indicatorMessage: string;
  announcementToken: number;
};

let snapshot: WindowZoomSnapshot = {
  zoomLevel: 0,
  zoomFactor: zoomLevelToZoomFactor(0),
  zoomPercent: zoomLevelToPercent(0),
  indicatorVisible: false,
  indicatorMessage: "",
  announcementToken: 0,
};

let indicatorTimer: number | null = null;
let lastAppliedZoomLevel: number | null = null;
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function getWindowZoomSnapshot(): WindowZoomSnapshot {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setSnapshot(nextSnapshot: WindowZoomSnapshot) {
  snapshot = nextSnapshot;
  emitChange();
}

function replaceSnapshot(next: Partial<WindowZoomSnapshot>) {
  setSnapshot({ ...snapshot, ...next });
}

function applySnapshotFromLevel(level: number) {
  const clampedLevel = clampWindowZoomLevel(level);
  replaceSnapshot({
    zoomLevel: clampedLevel,
    zoomFactor: zoomLevelToZoomFactor(clampedLevel),
    zoomPercent: zoomLevelToPercent(clampedLevel),
  });
}

function applySnapshotFromDesktopState(state: DesktopZoomState) {
  replaceSnapshot({
    zoomLevel: clampWindowZoomLevel(state.level),
    zoomFactor: state.factor,
    zoomPercent: state.percent,
  });
}

function showIndicator(zoomPercent: number) {
  if (typeof window !== "undefined" && indicatorTimer !== null) {
    window.clearTimeout(indicatorTimer);
  }

  replaceSnapshot({
    indicatorVisible: true,
    indicatorMessage: `UI scale ${zoomPercent}%`,
    announcementToken: snapshot.announcementToken + 1,
  });

  if (typeof window === "undefined") {
    return;
  }

  indicatorTimer = window.setTimeout(() => {
    indicatorTimer = null;
    replaceSnapshot({ indicatorVisible: false });
  }, INDICATOR_DURATION_MS);
}

function applyBrowserZoom(level: number) {
  if (typeof document === "undefined" || !document.body) {
    return;
  }

  document.body.style.zoom = String(zoomLevelToZoomFactor(level));
}

function readPersistedWindowZoomLevel() {
  if (typeof window === "undefined") {
    return 0;
  }

  try {
    const settings = getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
    return clampWindowZoomLevel(settings?.windowZoomLevel ?? 0);
  } catch {
    return 0;
  }
}

export function applyInitialWindowZoom() {
  const zoomLevel = readPersistedWindowZoomLevel();
  applySnapshotFromLevel(zoomLevel);
  lastAppliedZoomLevel = zoomLevel;

  if (window.desktopBridge?.setZoomLevel) {
    void window.desktopBridge
      .setZoomLevel(zoomLevel)
      .then((state) => applySnapshotFromDesktopState(state))
      .catch(() => undefined);
    return;
  }

  applyBrowserZoom(zoomLevel);
}

async function applyWindowZoomLevel(level: number, showZoomIndicator: boolean) {
  const clampedLevel = clampWindowZoomLevel(level);

  if (window.desktopBridge?.setZoomLevel) {
    const state = await window.desktopBridge.setZoomLevel(clampedLevel);
    applySnapshotFromDesktopState(state);
    lastAppliedZoomLevel = clampWindowZoomLevel(state.level);
    if (showZoomIndicator) {
      showIndicator(state.percent);
    }
    return clampWindowZoomLevel(state.level);
  }

  applyBrowserZoom(clampedLevel);
  applySnapshotFromLevel(clampedLevel);
  lastAppliedZoomLevel = clampedLevel;
  if (showZoomIndicator) {
    showIndicator(zoomLevelToPercent(clampedLevel));
  }
  return clampedLevel;
}

type SetZoomLevelOptions = {
  showIndicator?: boolean;
};

export function useWindowZoom() {
  const storedZoomLevel = useSettings((settings) => settings.windowZoomLevel);
  const { updateSettings } = useUpdateSettings();
  const currentSnapshot = useSyncExternalStore(
    subscribe,
    getWindowZoomSnapshot,
    getWindowZoomSnapshot,
  );

  useEffect(() => {
    const clampedStoredZoomLevel = clampWindowZoomLevel(storedZoomLevel);
    if (lastAppliedZoomLevel === clampedStoredZoomLevel) {
      return;
    }
    void applyWindowZoomLevel(clampedStoredZoomLevel, false);
  }, [storedZoomLevel]);

  const setZoomLevel = useCallback(
    async (level: number, options?: SetZoomLevelOptions) => {
      const nextLevel = await applyWindowZoomLevel(level, options?.showIndicator ?? true);
      if (nextLevel !== clampWindowZoomLevel(storedZoomLevel)) {
        updateSettings({ windowZoomLevel: nextLevel });
      }
      return nextLevel;
    },
    [storedZoomLevel, updateSettings],
  );

  const zoomIn = useCallback(() => {
    return setZoomLevel(getWindowZoomSnapshot().zoomLevel + 1);
  }, [setZoomLevel]);

  const zoomOut = useCallback(() => {
    return setZoomLevel(getWindowZoomSnapshot().zoomLevel - 1);
  }, [setZoomLevel]);

  const resetZoom = useCallback(() => {
    return setZoomLevel(0);
  }, [setZoomLevel]);

  return useMemo(
    () => ({
      ...currentSnapshot,
      setZoomLevel,
      zoomIn,
      zoomOut,
      resetZoom,
    }),
    [currentSnapshot, resetZoom, setZoomLevel, zoomIn, zoomOut],
  );
}

export function readPersistedClientZoomSettings(): ClientSettings | null {
  try {
    return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
  } catch {
    return null;
  }
}

export async function __applyWindowZoomLevelForTests(level: number, showIndicator = true) {
  return applyWindowZoomLevel(level, showIndicator);
}

export function __getWindowZoomSnapshotForTests() {
  return getWindowZoomSnapshot();
}

export function __resetWindowZoomForTests() {
  if (typeof window !== "undefined" && indicatorTimer !== null) {
    window.clearTimeout(indicatorTimer);
  }
  indicatorTimer = null;
  snapshot = {
    zoomLevel: 0,
    zoomFactor: zoomLevelToZoomFactor(0),
    zoomPercent: zoomLevelToPercent(0),
    indicatorVisible: false,
    indicatorMessage: "",
    announcementToken: 0,
  };
  lastAppliedZoomLevel = null;
  listeners.clear();
}

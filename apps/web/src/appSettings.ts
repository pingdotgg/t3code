import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";

const appSettingsSchema = z.object({
  codexBinaryPath: z.string().trim().max(4096).default(""),
  codexHomePath: z.string().trim().max(4096).default(""),
  confirmThreadDelete: z.boolean().default(true),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const DEFAULT_APP_SETTINGS: AppSettings = appSettingsSchema.parse({});

let listeners: Array<() => void> = [];
let cachedRawSettings: string | null | undefined;
let cachedSnapshot: AppSettings = DEFAULT_APP_SETTINGS;

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parsePersistedSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return appSettingsSchema.parse(parsed);
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function getAppSettingsSnapshot(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  if (raw === cachedRawSettings) {
    return cachedSnapshot;
  }

  cachedRawSettings = raw;
  cachedSnapshot = parsePersistedSettings(raw);
  return cachedSnapshot;
}

function persistSettings(next: AppSettings): void {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(next);
  try {
    if (raw !== cachedRawSettings) {
      window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, raw);
    }
  } catch {
    // Best-effort persistence only.
  }

  cachedRawSettings = raw;
  cachedSnapshot = next;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_SETTINGS_STORAGE_KEY) {
      emitChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppSettings() {
  const settings = useSyncExternalStore(subscribe, getAppSettingsSnapshot, () => DEFAULT_APP_SETTINGS);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = appSettingsSchema.parse({
      ...getAppSettingsSnapshot(),
      ...patch,
    });
    persistSettings(next);
    emitChange();
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(DEFAULT_APP_SETTINGS);
    emitChange();
  }, []);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}

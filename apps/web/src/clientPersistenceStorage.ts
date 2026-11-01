import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";

import {
  getLocalStorageItem,
  setLocalStorageItem,
  subscribeLocalStorageKey,
} from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}

/** Fires when another tab saves client settings. */
export function subscribeBrowserClientSettings(onChange: () => void): () => void {
  if (!hasWindow()) {
    return () => undefined;
  }

  return subscribeLocalStorageKey(CLIENT_SETTINGS_STORAGE_KEY, onChange);
}

import { useSyncExternalStore } from "react";

export const ICON_MODES = ["original", "outline", "solid24", "solid20", "solid16", "auto"] as const;
export type IconMode = (typeof ICON_MODES)[number];

// v3: desktop stays on solid16 (Nick, 2026-11-20); a new key drops older remembered picks.
const STORAGE_KEY = "conn-lab:icons:v3";
const PARAM = "icons";

const isMode = (value: string | null | undefined): value is IconMode =>
  ICON_MODES.includes(value as IconMode);

function readInitial(): IconMode {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(PARAM);
    if (isMode(fromUrl)) return fromUrl;
  } catch {
    /* Fall through to storage. */
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isMode(stored)) return stored;
  } catch {
    /* No storage: the default applies. */
  }
  return "solid16";
}

let mode: IconMode = readInitial();
const listeners = new Set<() => void>();

export function getIconMode(): IconMode {
  return mode;
}

/** Sets the mode, remembers it, and mirrors it into `?icons=` (the hash route stays put). */
export function setIconMode(next: IconMode) {
  if (next === mode) return;
  mode = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* Remembering is a convenience. */
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set(PARAM, next);
    window.history.replaceState(window.history.state, "", url);
  } catch {
    /* The mode still applies without the URL. */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useIconMode(): IconMode {
  return useSyncExternalStore(subscribe, getIconMode);
}

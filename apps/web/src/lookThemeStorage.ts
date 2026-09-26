import type { LookTheme } from "@t3tools/contracts/settings";

let override: LookTheme | null = null;
let save: ((theme: LookTheme) => void) | null = null;
let refresh = () => {};

export function onLookThemeChange(callback: () => void) {
  refresh = callback;
}

export function setLookTheme(theme: LookTheme | null, persist: (theme: LookTheme) => void) {
  save = persist;
  if (override === theme) return;
  override = theme;
  refresh();
}

export function readLookThemeStorage(key: string): string | null {
  if (override && key in override) return override[key as keyof LookTheme];
  return window.localStorage.getItem(key);
}

export function writeLookThemeStorage(key: string, value: string | null) {
  if (override && key in override) {
    override = { ...override, [key]: value };
    save?.(override);
  } else if (value === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
}

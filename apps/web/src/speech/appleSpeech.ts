import { useSyncExternalStore } from "react";

const emptyLocales: readonly string[] = [];
let locales = emptyLocales;
let probe: Promise<void> | undefined;
const listeners = new Set<() => void>();

export function readAppleSpeechLocales() {
  return locales;
}

export function supportsAppleSpeechLocale(available: readonly string[], locale: string) {
  const language = locale.toLowerCase().split("-")[0];
  return available.some((candidate) => candidate.toLowerCase().split("-")[0] === language);
}

export function resolveAppleSpeechLocale(
  available: readonly string[],
  preference: string,
  system: readonly string[],
) {
  if (supportsAppleSpeechLocale(available, preference)) return preference;
  return system.find((locale) => supportsAppleSpeechLocale(available, locale)) ?? system[0];
}

function probeLocales() {
  if (locales.length === 0 && !probe && window.desktopBridge?.appleSpeech) {
    probe = window.desktopBridge.appleSpeech
      .supportedLocales()
      .then((value) => {
        if (value.length === 0) return;
        locales = value;
        listeners.forEach((notify) => notify());
      })
      .catch(() => {})
      .finally(() => {
        probe = undefined;
      });
  }
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("focus", probeLocales);
  listeners.add(listener);
  probeLocales();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("focus", probeLocales);
  };
}

/** Apple Speech runs only in the desktop app on macOS 26 or later. */
export function useAppleSpeechLocales() {
  return useSyncExternalStore(subscribe, readAppleSpeechLocales, () => emptyLocales);
}

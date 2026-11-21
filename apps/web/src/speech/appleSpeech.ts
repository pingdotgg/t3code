import { useSyncExternalStore } from "react";

const emptyLocales: readonly string[] = [];
let locales = emptyLocales;

export function readAppleSpeechLocales() {
  return locales;
}
let probe: Promise<void> | undefined;
const listeners = new Set<() => void>();

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

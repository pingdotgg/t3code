import { useSyncExternalStore } from "react";

let available = false;
let probe: Promise<void> | undefined;
let retries = 0;
const listeners = new Set<() => void>();
// The main process keeps only a definite answer, so a "no" may be a slow first probe.
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 15_000;

function startProbe() {
  const bridge = window.desktopBridge?.appleSpeech;
  probe = (bridge?.isAvailable() ?? Promise.resolve(false))
    .catch(() => false)
    .then((value) => {
      available = value;
      listeners.forEach((notify) => notify());
      if (value || !bridge || retries >= MAX_RETRIES) return;
      retries++;
      setTimeout(() => {
        probe = undefined;
        if (listeners.size > 0) startProbe();
      }, RETRY_DELAY_MS);
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!probe) startProbe();
  return () => listeners.delete(listener);
}

/** Apple Speech runs only in the macOS 26 desktop app; the main process caches the answer. */
export function useAppleSpeechAvailable() {
  return useSyncExternalStore(
    subscribe,
    () => available,
    () => false,
  );
}

/** The packaged app pins `navigator.language` to en-US, so "auto" asks the OS. */
export function appleSpeechLocale(speechLanguage: string) {
  if (speechLanguage !== "auto") return speechLanguage;
  const bridge = window.desktopBridge;
  return (
    bridge?.getPreferredSystemLanguages?.()[0] ?? bridge?.getSystemLocale?.() ?? navigator.language
  );
}

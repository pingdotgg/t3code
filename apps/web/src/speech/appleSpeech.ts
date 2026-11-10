import { useSyncExternalStore } from "react";

let available = false;
let probe: Promise<void> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  probe ??= (window.desktopBridge?.appleSpeech?.isAvailable() ?? Promise.resolve(false))
    .catch(() => false)
    .then((value) => {
      available = value;
      listeners.forEach((notify) => notify());
    });
  return () => listeners.delete(listener);
}

/** Apple Speech runs only in the macOS 26 desktop app; the main process probes it once. */
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

import { useSyncExternalStore } from "react";

const KEY = "t3code:voice-fast-commands:v1";
const EVENT = "t3code:voice-preferences";
let fallback = true;
let storageUnavailable = false;
function read() {
  if (storageUnavailable) return fallback;
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return fallback;
  }
}
function subscribe(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", listener);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(EVENT, listener);
  };
}
export function useVoiceFastCommands() {
  const enabled = useSyncExternalStore(subscribe, read, () => true);
  return [
    enabled,
    (value: boolean) => {
      fallback = value;
      try {
        localStorage.setItem(KEY, String(value));
        storageUnavailable = false;
      } catch {
        storageUnavailable = true;
        // Keep the preference usable for this page when storage is unavailable.
      }
      window.dispatchEvent(new Event(EVENT));
    },
  ] as const;
}

import { useSyncExternalStore } from "react";

const KEY = "t3code:voice-fast-commands:v1";
const EVENT = "t3code:voice-preferences";
function read() {
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return true;
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
      localStorage.setItem(KEY, String(value));
      window.dispatchEvent(new Event(EVENT));
    },
  ] as const;
}

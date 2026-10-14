import { useSyncExternalStore } from "react";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { useClientSettings } from "./useSettings";

export function resolveAccessibilitySupport(
  mode: ClientSettings["accessibilitySupport"],
  detected: boolean,
): boolean {
  // Same precedence as VS Code's AccessibilityService: manual choice wins over detection.
  return mode === "on" || (mode === "auto" && detected);
}

let detected = false;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    let changed = false;
    let disposed = false;
    const publish = (value: boolean) => {
      detected = value;
      for (const notify of listeners) notify();
    };
    const stop = window.desktopBridge?.onAccessibilitySupportChanged?.((value) => {
      changed = true;
      publish(value);
    });
    void window.desktopBridge
      ?.getAccessibilitySupport?.()
      .then((value) => {
        if (!disposed && !changed) publish(value);
      })
      .catch(() => undefined);
    unsubscribe = () => {
      disposed = true;
      stop?.();
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) unsubscribe?.();
  };
}

/** Web browsers have no reliable detection API; manual On remains available. */
export function useAccessibilitySupport() {
  const mode = useClientSettings((settings) => settings.accessibilitySupport);
  const nativeSupport = useSyncExternalStore(
    subscribe,
    () => detected,
    () => false,
  );
  return resolveAccessibilitySupport(mode, nativeSupport);
}

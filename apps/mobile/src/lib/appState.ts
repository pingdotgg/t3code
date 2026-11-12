import { useSyncExternalStore } from "react";
import { AccessibilityInfo, AppState } from "react-native";

type Listener = () => void;

export function subscribeAppState(onChange: Listener): () => void {
  const subscription = AppState.addEventListener("change", () => onChange());
  return () => subscription.remove();
}

export function isAppActive(): boolean {
  return AppState.currentState === "active";
}

/** Runs `onActive` each time the app returns to the foreground. */
export function subscribeAppActive(onActive: Listener): () => void {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") onActive();
  });
  return () => subscription.remove();
}

export function useAppActive(): boolean {
  return useSyncExternalStore(subscribeAppState, isAppActive);
}

function isAppForeground(): boolean {
  return AppState.currentState !== "background";
}

/**
 * True unless the app is backgrounded. Unlike useAppActive, the transient
 * "inactive" state (Control Center, the app switcher, a system prompt) still
 * counts as foreground, so live streams do not reconnect around it.
 */
export function useAppForeground(): boolean {
  return useSyncExternalStore(subscribeAppState, isAppForeground);
}

// Null until the native seed resolves; read as reduced so animated consumers
// never start motion a reduce-motion user has turned off.
let reduceMotionEnabled: boolean | null = null;
const reduceMotionListeners = new Set<Listener>();
let reduceMotionSubscription: { remove: () => void } | null = null;

function setReduceMotionEnabled(next: boolean) {
  if (next === reduceMotionEnabled) return;
  reduceMotionEnabled = next;
  for (const listener of reduceMotionListeners) listener();
}

export function subscribeReduceMotion(onChange: Listener): () => void {
  reduceMotionListeners.add(onChange);
  if (reduceMotionSubscription === null) {
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotionEnabled,
    );
    reduceMotionSubscription = subscription;
    // The native event only reports changes; seed the current value once per
    // observation, and drop a seed that resolves after observation stopped.
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (enabled) => {
        if (reduceMotionSubscription === subscription) setReduceMotionEnabled(enabled);
      },
      () => undefined,
    );
  }
  return () => {
    reduceMotionListeners.delete(onChange);
    if (reduceMotionListeners.size === 0) {
      reduceMotionSubscription?.remove();
      reduceMotionSubscription = null;
      // Changes made while nobody observed were never reported, so the cached
      // value can be stale; the next subscriber reseeds from native.
      reduceMotionEnabled = null;
    }
  };
}

export function readReduceMotionEnabled(): boolean {
  return reduceMotionEnabled ?? true;
}

export function useReduceMotionEnabled(): boolean {
  return useSyncExternalStore(subscribeReduceMotion, readReduceMotionEnabled);
}

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

type AccessibilityFlagEvent = "reduceMotionChanged" | "screenReaderChanged";

function createAccessibilityFlagStore(
  event: AccessibilityFlagEvent,
  readNative: () => Promise<boolean>,
  valueWhileUnknown: boolean,
) {
  let enabled: boolean | null = null;
  const listeners = new Set<Listener>();
  let nativeSubscription: { remove: () => void } | null = null;

  function setEnabled(next: boolean) {
    if (next === enabled) return;
    enabled = next;
    for (const listener of listeners) listener();
  }

  function subscribe(onChange: Listener): () => void {
    listeners.add(onChange);
    if (nativeSubscription === null) {
      const subscription = AccessibilityInfo.addEventListener(event, setEnabled);
      nativeSubscription = subscription;
      // The native event only reports changes; seed the current value once per
      // observation, and drop a seed that resolves after observation stopped.
      void readNative().then(
        (value) => {
          if (nativeSubscription === subscription) setEnabled(value);
        },
        () => undefined,
      );
    }
    return () => {
      listeners.delete(onChange);
      if (listeners.size === 0) {
        nativeSubscription?.remove();
        nativeSubscription = null;
        // Changes made while nobody observed were never reported, so the cached
        // value can be stale; the next subscriber reseeds from native.
        enabled = null;
      }
    };
  }

  return { subscribe, read: () => enabled ?? valueWhileUnknown };
}

// Unknown reads as reduced so animated consumers never start motion a
// reduce-motion user has turned off.
const reduceMotionStore = createAccessibilityFlagStore(
  "reduceMotionChanged",
  () => AccessibilityInfo.isReduceMotionEnabled(),
  true,
);

export const subscribeReduceMotion = reduceMotionStore.subscribe;
export const readReduceMotionEnabled = reduceMotionStore.read;

export function useReduceMotionEnabled(): boolean {
  return useSyncExternalStore(subscribeReduceMotion, readReduceMotionEnabled);
}

const screenReaderStore = createAccessibilityFlagStore(
  "screenReaderChanged",
  () => AccessibilityInfo.isScreenReaderEnabled(),
  false,
);

export function useScreenReaderEnabled(): boolean {
  return useSyncExternalStore(screenReaderStore.subscribe, screenReaderStore.read);
}

import * as Battery from "expo-battery";
import { useSyncExternalStore } from "react";

import { subscribeAppActive } from "./appState";

type Listener = () => void;

// Android Battery Saver or iOS Low Power Mode. Null until the native seed resolves; read as on,
// like reduce motion, so decorative motion never starts on a device saving power.
let lowPowerModeEnabled: boolean | null = null;
const lowPowerModeListeners = new Set<Listener>();
let lowPowerModeSubscription: { remove: () => void } | null = null;

function setLowPowerModeEnabled(next: boolean) {
  if (next === lowPowerModeEnabled) return;
  lowPowerModeEnabled = next;
  for (const listener of lowPowerModeListeners) listener();
}

export function subscribeLowPowerMode(onChange: Listener): () => void {
  lowPowerModeListeners.add(onChange);
  if (lowPowerModeSubscription === null) {
    const powerMode = Battery.addLowPowerModeListener(({ lowPowerMode }) =>
      setLowPowerModeEnabled(lowPowerMode),
    );
    // Android's power-saver receiver is unregistered while the app is in the background and
    // reports nothing on return, so a change made meanwhile is read again on activation.
    const activation = subscribeAppActive(() => seed(subscription));
    const subscription = {
      remove: () => {
        powerMode.remove();
        activation();
      },
    };
    lowPowerModeSubscription = subscription;
    seed(subscription);
  }
  return () => {
    lowPowerModeListeners.delete(onChange);
    if (lowPowerModeListeners.size === 0) {
      lowPowerModeSubscription?.remove();
      lowPowerModeSubscription = null;
      lowPowerModeEnabled = null;
    }
  };
}

function seed(subscription: { remove: () => void }) {
  void Battery.isLowPowerModeEnabledAsync().then(
    (enabled) => {
      if (lowPowerModeSubscription === subscription) setLowPowerModeEnabled(enabled);
    },
    () => {
      if (lowPowerModeSubscription === subscription) setLowPowerModeEnabled(false);
    },
  );
}

export function readLowPowerModeEnabled(): boolean {
  return lowPowerModeEnabled ?? true;
}

export function useLowPowerModeEnabled(): boolean {
  return useSyncExternalStore(subscribeLowPowerMode, readLowPowerModeEnabled);
}

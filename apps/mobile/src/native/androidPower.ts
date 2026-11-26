import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface AndroidPowerEvents {
  readonly onBackgroundIdle: Record<string, never>;
  readonly onPowerSaveModeChange: { readonly enabled: boolean };
}

interface AndroidPowerModule {
  isPowerSaveMode(): boolean;
  addListener<K extends keyof AndroidPowerEvents>(
    event: K,
    listener: (event: AndroidPowerEvents[K]) => void,
  ): { remove(): void };
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidPowerModule>("T3AndroidPower")
    : null;

/** Fires once the app has stayed in the background for 30 seconds; JS timers are stopped there. */
export function subscribeAndroidBackgroundIdle(listener: () => void): () => void {
  const subscription = native?.addListener("onBackgroundIdle", listener);
  return () => subscription?.remove();
}

/** Android Battery Saver, or null where the native module is missing (iOS, an older dev client). */
export function readAndroidPowerSaveMode(): boolean | null {
  if (native === null) return null;
  try {
    return native.isPowerSaveMode();
  } catch {
    return null;
  }
}

export function subscribeAndroidPowerSaveMode(listener: (enabled: boolean) => void): () => void {
  const subscription = native?.addListener("onPowerSaveModeChange", ({ enabled }) =>
    listener(enabled),
  );
  return () => subscription?.remove();
}

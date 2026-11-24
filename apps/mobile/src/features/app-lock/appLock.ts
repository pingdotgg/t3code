import { requireOptionalNativeModule } from "expo";

import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";

export type AppLockBiometry = "faceID" | "touchID" | "opticID" | "biometric" | "none";

export interface AppLockStatus {
  readonly enabled: boolean;
  readonly timeoutSeconds: number;
  /** False until the device has a passcode or screen lock. */
  readonly available: boolean;
  readonly biometry: AppLockBiometry;
}

/** The lock itself runs natively (T3AppLock in t3-native-controls); JS only configures it. */
interface AppLockNativeModule {
  getStatus(): Promise<AppLockStatus>;
  /** Resolves false when the user cancels the confirmation prompt. */
  configure(enabled: boolean, timeoutSeconds: number): Promise<boolean>;
  setStrings(unlockLabel: string, reason: string): Promise<void>;
}

const NativeAppLock = requireOptionalNativeModule<AppLockNativeModule>("T3AppLock");

export const APP_LOCK_UNAVAILABLE_CODE = "ERR_APP_LOCK_UNAVAILABLE";
export const APP_LOCK_TIMEOUTS_SECONDS = [0, 60, 300, 900, 3600] as const;

export function appLockSupported(): boolean {
  return NativeAppLock !== null;
}

// The user can remove the device passcode in system Settings, so status is reread on foreground.
export const appLockStatusAtom = makePermissionStatusAtom<AppLockStatus | null>({
  label: "mobile:app-lock:status",
  initial: null,
  read: async () => (NativeAppLock ? NativeAppLock.getStatus() : null),
});

export async function configureAppLock(enabled: boolean, timeoutSeconds: number) {
  if (!NativeAppLock) return false;
  return NativeAppLock.configure(enabled, timeoutSeconds);
}

export async function readAppLockStatus(): Promise<AppLockStatus | null> {
  return NativeAppLock ? NativeAppLock.getStatus() : null;
}

/** The lock screen draws before JS loads, so native keeps the last copy it was given. */
export function publishAppLockStrings(strings: { unlockLabel: string; reason: string }) {
  void NativeAppLock?.setStrings(strings.unlockLabel, strings.reason).catch(() => undefined);
}

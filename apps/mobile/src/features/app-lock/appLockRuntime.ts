import * as LocalAuthentication from "expo-local-authentication";
import { AsyncResult, Atom } from "effect/reactivity";
import { AppState, Keyboard } from "react-native";

import { appLockExpired, DEFAULT_APP_LOCK_GRACE_PERIOD_MS } from "../../lib/appLock";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, mobilePreferencesLoadFailedAtom } from "../../state/preferences";

/** Unreadable preferences count as locked: an unknown setting must not open the app. */
export const appLockEnabledAtom = Atom.make((get) => {
  if (get(mobilePreferencesLoadFailedAtom)) return true;
  const preferences = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) && preferences.value.appLockEnabled === true;
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:app-lock:enabled"));

interface AppLockSession {
  /** Every launch starts locked; only a successful unlock in this process sets it. */
  readonly unlocked: boolean;
  readonly active: boolean;
  /** Whether the lock screen should open the system prompt without a tap. */
  readonly autoPrompt: boolean;
  readonly prompting: boolean;
}

export const appLockSessionAtom = Atom.make<AppLockSession>({
  unlocked: false,
  active: AppState.currentState === "active",
  autoPrompt: true,
  prompting: false,
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:app-lock:session"));

function updateSession(patch: Partial<AppLockSession>): void {
  appAtomRegistry.set(appLockSessionAtom, { ...appAtomRegistry.get(appLockSessionAtom), ...patch });
}

let authenticating = false;

export type AppLockAuthenticationResult = "success" | "failed" | "no-screen-lock";

/** Accepts biometrics or the device passcode, so a phone without enrolled biometrics still works. */
export async function authenticateAppLock(
  promptMessage: string,
): Promise<AppLockAuthenticationResult> {
  if (authenticating) return "failed";
  authenticating = true;
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) return "no-screen-lock";
    const result = await LocalAuthentication.authenticateAsync({ promptMessage });
    if (!result.success) return "failed";
    updateSession({ unlocked: true });
    return "success";
  } catch {
    return "failed";
  } finally {
    authenticating = false;
  }
}

export async function unlockApp(promptMessage: string): Promise<void> {
  updateSession({ autoPrompt: false, prompting: true });
  const result = await authenticateAppLock(promptMessage);
  // Without a screen lock nothing can prove the owner, and nobody could ever unlock.
  updateSession({ prompting: false, ...(result === "no-screen-lock" ? { unlocked: true } : {}) });
}

function lockExpiredSince(awaySince: number): boolean {
  if (!appAtomRegistry.get(appLockEnabledAtom)) return false;
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return appLockExpired({
    awaySince,
    now: Date.now(),
    gracePeriodMs:
      (AsyncResult.isSuccess(preferences) ? preferences.value.appLockGracePeriodMs : undefined) ??
      DEFAULT_APP_LOCK_GRACE_PERIOD_MS,
  });
}

export function installAppLockRuntime(): () => void {
  let awaySince: number | null = null;
  const subscription = AppState.addEventListener("change", (state) => {
    // Android's passcode fallback opens a system screen that backgrounds the app.
    if (state === "background" && !authenticating) awaySince ??= Date.now();
    if (state !== "active") {
      updateSession({ active: false });
      return;
    }
    const since = awaySince;
    awaySince = null;
    const session = appAtomRegistry.get(appLockSessionAtom);
    const relock = session.unlocked && since !== null && lockExpiredSince(since);
    if (relock) Keyboard.dismiss();
    const unlocked = session.unlocked && !relock;
    updateSession({
      active: true,
      unlocked,
      autoPrompt: session.autoPrompt || (!unlocked && since !== null),
    });
  });
  return () => subscription.remove();
}

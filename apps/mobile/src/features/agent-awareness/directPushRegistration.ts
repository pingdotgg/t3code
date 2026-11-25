import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { subscribeAppActive } from "../../lib/appState";
import {
  loadOrCreateAgentAwarenessDeviceId,
  loadPreferences,
  savePreferencesPatch,
} from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { directPush } from "../../state/directPush";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { environmentServerConfigsAtom } from "../../state/server";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { supportsAgentAwarenessPush } from "./capabilities";
import { planDirectPushRegistration } from "./directPushPlan";
import { requestAgentNotificationPermission } from "./notificationPermissions";
import { resolveApsEnvironment } from "./registrationPayload";

// Builds without T3 Connect register their APNs token with each connected environment that
// sends pushes itself (ServerConfig.directPush). Environments keep registrations across restarts,
// so this only has to reach each one again after a token change or a reconnect.

const FOREGROUND_REFRESH_MS = 5 * 60_000;

/** True when this build has no relay and can receive pushes (not a Personal Team build). */
export function directPushAvailable(): boolean {
  return Platform.OS === "ios" && !hasCloudPublicConfig() && supportsAgentAwarenessPush();
}

export interface DirectPushState {
  /** Null until the stored preference loads. */
  readonly enabled: boolean | null;
  readonly registeredEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

let storedPreference: boolean | undefined;
let enabled: boolean | null = null;
let token: string | null = null;
let deviceId: string | null = null;
const registered = new Map<EnvironmentId, string>();
const unregisteredThisLaunch = new Set<EnvironmentId>();
let lastFullRefreshAt = Date.now();
let syncing = false;
let syncAgain = false;

let state: DirectPushState = { enabled: null, registeredEnvironmentIds: [] };
const listeners = new Set<() => void>();

function publish(): void {
  state = { enabled, registeredEnvironmentIds: [...registered.keys()] };
  for (const listener of listeners) listener();
}

export function subscribeDirectPushState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDirectPushState(): DirectPushState {
  return state;
}

function logDirectPushError(context: string, error: unknown): void {
  if (!__DEV__) return;
  console.warn(`[direct-push] ${context}`, {
    message: error instanceof Error ? error.message : String(error),
    error,
  });
}

function environmentSupportsDirectPush(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.directPush === true;
}

function connectedDirectPushEnvironments(): ReadonlyArray<EnvironmentId> {
  return appAtomRegistry.get(connectedEnvironmentIdsAtom).filter(environmentSupportsDirectPush);
}

async function readPushToken(): Promise<string | null> {
  const next = await Notifications.getDevicePushTokenAsync();
  return next.type === "ios" && typeof next.data === "string" && next.data.trim().length > 0
    ? next.data.trim()
    : null;
}

async function registrationPayload(pushToken: string) {
  deviceId ??= await loadOrCreateAgentAwarenessDeviceId();
  const bundleId =
    Application.applicationId?.trim() || Constants.expoConfig?.ios?.bundleIdentifier?.trim();
  if (!bundleId) return null;
  return {
    deviceId,
    label: Constants.deviceName?.trim() || "iOS device",
    token: pushToken,
    bundleId,
    // The environment retries the other APNs host when a locally signed build guesses wrong.
    apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
  };
}

async function unregisterFrom(environmentIds: ReadonlyArray<EnvironmentId>): Promise<void> {
  if (environmentIds.length === 0) return;
  deviceId ??= await loadOrCreateAgentAwarenessDeviceId();
  const id = deviceId;
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        directPush.unregisterDevice,
        { environmentId, input: { deviceId: id } },
        { reportFailure: false },
      );
      if (result._tag === "Success") unregisteredThisLaunch.add(environmentId);
      else logDirectPushError(`unregister from ${environmentId} failed`, result.cause);
    }),
  );
}

async function syncOnce(): Promise<void> {
  if (enabled === null) return;
  if (!enabled) {
    // Only after an explicit opt-out, and once per launch: an environment that was offline when
    // the user turned this off would otherwise keep pushing.
    if (storedPreference !== false) return;
    await unregisterFrom(
      connectedDirectPushEnvironments().filter((id) => !unregisteredThisLaunch.has(id)),
    );
    return;
  }
  const forgotten = planDirectPushRegistration({
    token,
    connected: appAtomRegistry.get(connectedEnvironmentIdsAtom),
    supportsDirectPush: environmentSupportsDirectPush,
    registered,
  }).forget;
  for (const id of forgotten) registered.delete(id);
  if (forgotten.length > 0) publish();
  if (connectedDirectPushEnvironments().length === 0) return;

  const permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted) return;
  token ??= await readPushToken();
  if (token === null) return;
  const pushToken = token;

  const { register } = planDirectPushRegistration({
    token: pushToken,
    connected: appAtomRegistry.get(connectedEnvironmentIdsAtom),
    supportsDirectPush: environmentSupportsDirectPush,
    registered,
  });
  if (register.length === 0) return;
  const payload = await registrationPayload(pushToken);
  if (payload === null) return;
  await Promise.all(
    register.map(async (environmentId) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        directPush.registerDevice,
        { environmentId, input: payload },
        { reportFailure: false },
      );
      // A toggle or token change while this was in flight starts another pass.
      if (result._tag === "Success" && enabled === true && token === pushToken) {
        registered.set(environmentId, pushToken);
      } else if (result._tag === "Failure") {
        logDirectPushError(`register with ${environmentId} failed`, result.cause);
      }
    }),
  );
  publish();
}

function requestSync(): void {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  void syncOnce()
    .catch((error: unknown) => logDirectPushError("sync failed", error))
    .finally(() => {
      syncing = false;
      if (syncAgain) {
        syncAgain = false;
        requestSync();
      }
    });
}

export type DirectPushToggleResult = "enabled" | "disabled" | "denied" | "blocked" | "failed";

/** Turns direct push on (asking for notification permission) or off for this device. */
export async function setDirectPushEnabled(next: boolean): Promise<DirectPushToggleResult> {
  if (next) {
    const permission = await Effect.runPromise(
      Effect.result(requestAgentNotificationPermission),
    ).catch(() => null);
    if (permission === null || permission._tag === "Failure") return "failed";
    if (permission.success.type !== "granted") {
      return permission.success.type === "denied" && !permission.success.canAskAgain
        ? "blocked"
        : "denied";
    }
  }
  await savePreferencesPatch({ directPushEnabled: next });
  storedPreference = next;
  enabled = next;
  unregisteredThisLaunch.clear();
  if (!next) {
    const environments = [...registered.keys()];
    registered.clear();
    publish();
    await unregisterFrom([...new Set([...environments, ...connectedDirectPushEnvironments()])]);
    return "disabled";
  }
  publish();
  requestSync();
  return "enabled";
}

/** App-lifetime worker; a no-op in builds that use T3 Connect or cannot receive pushes. */
export function installDirectPushRegistration(): () => void {
  if (!directPushAvailable()) return () => {};
  let disposed = false;
  const unsubscribeConnected = appAtomRegistry.subscribe(connectedEnvironmentIdsAtom, requestSync);
  const unsubscribeConfigs = appAtomRegistry.subscribe(environmentServerConfigsAtom, requestSync);
  const tokenSubscription = Notifications.addPushTokenListener((next) => {
    if (typeof next.data !== "string" || next.data.trim().length === 0) return;
    token = next.data.trim();
    requestSync();
  });
  const unsubscribeActive = subscribeAppActive(() => {
    if (Date.now() - lastFullRefreshAt < FOREGROUND_REFRESH_MS) return;
    lastFullRefreshAt = Date.now();
    registered.clear();
    requestSync();
  });
  void loadPreferences().then(
    (preferences) => {
      if (disposed) return;
      storedPreference = preferences.directPushEnabled;
      enabled = preferences.directPushEnabled === true;
      publish();
      requestSync();
    },
    (error: unknown) => logDirectPushError("load preference failed", error),
  );
  return () => {
    disposed = true;
    unsubscribeConnected();
    unsubscribeConfigs();
    tokenSubscription.remove();
    unsubscribeActive();
  };
}

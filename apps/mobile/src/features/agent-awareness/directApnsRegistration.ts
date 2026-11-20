import type {
  EnvironmentId,
  PushDeviceRegistration,
  PushLiveActivityRegistration,
} from "@t3tools/contracts";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";

// Forks whose bundle ID the official relay's APNs key cannot reach run their own
// push sender on each T3 server. That server needs this device's token, which
// the relay registration never gives it.
export function toPushDeviceRegistration(
  request: RelayDeviceRegistrationRequest,
): PushDeviceRegistration | null {
  if (
    request.platform !== "ios" ||
    !request.pushToken ||
    !request.bundleId ||
    !request.apsEnvironment
  ) {
    return null;
  }
  return {
    deviceId: request.deviceId,
    apnsToken: request.pushToken,
    apsEnvironment: request.apsEnvironment,
    bundleId: request.bundleId,
    platform: "ios",
    notificationsEnabled: request.preferences.notificationsEnabled,
    notifyOnApproval: request.preferences.notifyOnApproval,
    notifyOnInput: request.preferences.notifyOnInput,
    notifyOnCompletion: request.preferences.notifyOnCompletion,
    notifyOnFailure: request.preferences.notifyOnFailure,
  };
}

// Only successes are remembered, so an environment that was unreachable is
// retried on the next registration trigger (foreground, token rotation, or a
// change to the connected environments).
const registeredSignatures = new Map<EnvironmentId, string>();
let lastRequest: RelayDeviceRegistrationRequest | null = null;
let watchingCatalog = false;
const registeredListeners = new Set<() => void>();

// True once at least one connected T3 server holds this device's token. The
// notification settings read it, since a signed-out device never reaches the relay.
export function isDirectApnsRegistered(): boolean {
  return registeredSignatures.size > 0;
}

export function subscribeDirectApnsRegistered(listener: () => void): () => void {
  registeredListeners.add(listener);
  return () => {
    registeredListeners.delete(listener);
  };
}

function setRegisteredSignature(environmentId: EnvironmentId, signature: string): void {
  const wasRegistered = isDirectApnsRegistered();
  registeredSignatures.set(environmentId, signature);
  if (!wasRegistered) for (const listener of registeredListeners) listener();
}

async function registerWithConnectedEnvironments(
  request: RelayDeviceRegistrationRequest,
): Promise<void> {
  const registration = toPushDeviceRegistration(request);
  if (registration === null) return;
  const signature = JSON.stringify(registration);
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  await Promise.all(
    [...enabledEnvironmentIds(catalog)].map(async (environmentId) => {
      if (registeredSignatures.get(environmentId) === signature) return;
      const result = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.registerPushDevice,
        { environmentId, input: registration },
        { reportFailure: false, reportDefect: false },
      );
      if (result._tag === "Success") setRegisteredSignature(environmentId, signature);
    }),
  );
}

// Live Activity tokens belong to the activity, not the device, and arrive on
// their own schedule: remember the latest of each and sync them with every
// connected server whenever either side changes.
const liveActivityTokens: { activityPushToken?: string; pushToStartToken?: string } = {};
const liveActivitySignatures = new Map<EnvironmentId, string>();

export function setDirectLiveActivityTokens(tokens: typeof liveActivityTokens): void {
  Object.assign(liveActivityTokens, tokens);
  if (lastRequest) void syncLiveActivities(lastRequest);
}

async function syncLiveActivities(request: RelayDeviceRegistrationRequest): Promise<void> {
  const base = toPushDeviceRegistration(request);
  if (base === null) return;
  const enabled = request.preferences.liveActivitiesEnabled !== false;
  const { activityPushToken, pushToStartToken } = liveActivityTokens;
  const registration: PushLiveActivityRegistration = {
    deviceId: base.deviceId,
    apsEnvironment: base.apsEnvironment,
    bundleId: base.bundleId,
    ...(activityPushToken ? { activityPushToken } : {}),
    ...(pushToStartToken ? { pushToStartToken } : {}),
  };
  // Turning the preference off must reach servers, or they keep updating a card the user dismissed.
  const signature = enabled ? JSON.stringify(registration) : "disabled";
  if (enabled && !activityPushToken && !pushToStartToken) return;
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  await Promise.all(
    [...enabledEnvironmentIds(catalog)].map(async (environmentId) => {
      const known = liveActivitySignatures.get(environmentId);
      if (known === signature || (!enabled && known === undefined)) return;
      const options = { reportFailure: false, reportDefect: false };
      const result = enabled
        ? await runAtomCommand(
            appAtomRegistry,
            serverEnvironment.registerPushLiveActivity,
            { environmentId, input: registration },
            options,
          )
        : await runAtomCommand(
            appAtomRegistry,
            serverEnvironment.unregisterPushLiveActivity,
            { environmentId, input: { deviceId: base.deviceId } },
            options,
          );
      if (result._tag === "Success") liveActivitySignatures.set(environmentId, signature);
    }),
  );
}

export async function registerDirectApnsDevice(
  request: RelayDeviceRegistrationRequest,
): Promise<void> {
  lastRequest = request;
  // Environments connect after the app registers its token, and nothing else
  // re-triggers registration for them.
  if (!watchingCatalog) {
    watchingCatalog = true;
    appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, () => {
      if (lastRequest) {
        void registerWithConnectedEnvironments(lastRequest);
        void syncLiveActivities(lastRequest);
      }
    });
  }
  await Promise.all([registerWithConnectedEnvironments(request), syncLiveActivities(request)]);
}

export function __resetDirectApnsRegistrationForTest(): void {
  registeredSignatures.clear();
  liveActivitySignatures.clear();
  delete liveActivityTokens.activityPushToken;
  delete liveActivityTokens.pushToStartToken;
  registeredListeners.clear();
  lastRequest = null;
  watchingCatalog = false;
}

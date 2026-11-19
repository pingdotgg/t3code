import type { EnvironmentId, PushDeviceRegistration } from "@t3tools/contracts";
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
      if (result._tag === "Success") registeredSignatures.set(environmentId, signature);
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
      if (lastRequest) void registerWithConnectedEnvironments(lastRequest);
    });
  }
  await registerWithConnectedEnvironments(request);
}

export function __resetDirectApnsRegistrationForTest(): void {
  registeredSignatures.clear();
  lastRequest = null;
  watchingCatalog = false;
}

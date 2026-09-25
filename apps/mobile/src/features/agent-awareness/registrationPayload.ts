import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";

import type { Preferences } from "../../persistence/mobile-preferences";
import { supportsAgentAwarenessPush } from "./capabilities";

// Development builds are Xcode-signed and receive sandbox APNs tokens;
// preview and production builds are distribution-signed and use production
// APNs. The relay routes each device's pushes accordingly.
export function resolveApsEnvironment(appVariant: unknown): "sandbox" | "production" {
  return appVariant === "development" ? "sandbox" : "production";
}

export function makeRelayDeviceRegistrationRequest(
  input: {
    readonly deviceId: string;
    readonly label: string;
    readonly appVersion?: string;
    readonly bundleId?: string;
    readonly apsEnvironment?: "sandbox" | "production";
    readonly pushToken?: string;
    readonly pushToStartToken?: string;
    readonly notificationsEnabled: boolean;
    readonly preferences: Preferences;
  } & (
    | { readonly platform?: "ios"; readonly iosMajorVersion: number }
    | { readonly platform: "android"; readonly androidApiLevel: number }
  ),
): RelayDeviceRegistrationRequest {
  const pushAvailable = supportsAgentAwarenessPush();
  const liveActivitiesEnabled = pushAvailable && input.preferences.liveActivitiesEnabled !== false;
  return {
    deviceId: input.deviceId,
    label: input.label,
    platform: input.platform ?? "ios",
    ...(input.platform === "android"
      ? { androidApiLevel: input.androidApiLevel }
      : { iosMajorVersion: input.iosMajorVersion }),
    appVersion: input.appVersion,
    ...(input.bundleId ? { bundleId: input.bundleId } : {}),
    ...(input.apsEnvironment ? { apsEnvironment: input.apsEnvironment } : {}),
    ...(input.pushToken ? { pushToken: input.pushToken } : {}),
    ...(input.pushToStartToken ? { pushToStartToken: input.pushToStartToken } : {}),
    preferences: {
      liveActivitiesEnabled,
      notificationsEnabled: pushAvailable && input.notificationsEnabled,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
  };
}

import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";

import type { Preferences } from "../../lib/storage";
import { supportsAgentAwarenessPush } from "./capabilities";

export function makeRelayDeviceRegistrationRequest(input: {
  readonly deviceId: string;
  readonly label: string;
  readonly iosMajorVersion: number;
  readonly appVersion?: string;
  readonly pushToken?: string;
  readonly pushToStartToken?: string;
  readonly notificationsEnabled: boolean;
  readonly preferences: Preferences;
}): RelayDeviceRegistrationRequest {
  const pushAvailable = supportsAgentAwarenessPush();
  const liveActivitiesEnabled = pushAvailable && input.preferences.liveActivitiesEnabled !== false;
  return {
    deviceId: input.deviceId,
    label: input.label,
    platform: "ios",
    iosMajorVersion: input.iosMajorVersion,
    appVersion: input.appVersion,
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

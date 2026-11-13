import { type LiveActivity } from "expo-widgets";
import {
  configureAndroidAgentNotifications,
  clearAndroidAgentNotifications,
} from "./androidNotifications";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AppState, Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  type RelayDeviceRegistrationRequest,
  type RelayAgentActivitySnapshotResponse,
  type RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import type { Preferences } from "../../persistence/mobile-preferences";
import {
  clearAgentAwarenessRegistrationRecord,
  loadAgentAwarenessDeviceId,
  loadAgentAwarenessRegistrationRecord,
  loadOrCreateAgentAwarenessDeviceId,
  loadPreferences,
  saveAgentAwarenessRegistrationRecord,
} from "../../persistence/imperative";
import type { AgentActivityProps } from "../../widgets/AgentActivity";
import {
  dismissEndedAgentLiveActivities,
  getAgentLiveActivities,
  startAgentLiveActivity,
} from "./agentLiveActivity";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { supportsAgentAwarenessPush } from "./capabilities";
import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";
import { refreshActiveLiveActivityRemoteRegistration } from "./remoteRegistrationParts";
import { registerDeviceWithRelay } from "./remoteRegistrationParts2";
import type { RegisterDeviceInput } from "./remoteRegistration";
import { AgentAwarenessOperationError, canRegisterPushNotifications, deviceRegistrationGeneration, iosMajorVersion, mergeAgentAwarenessRegistrationPreferences, nativePushTokenRegistration, relayTokenProvider, relayTokenProviderIdentity } from "./remoteRegistration";

export const registerDevice = Effect.fn("remoteRegistration.registerDevice")(function* (
  input: RegisterDeviceInput = {},
  expectedGeneration = deviceRegistrationGeneration,
): Effect.fn.Return<void, unknown, ManagedRelay.ManagedRelayClient> {
  if (!canRegisterPushNotifications()) {
    return;
  }

  const [deviceId, storedPreferences] = yield* Effect.all([
    Effect.tryPromise({
      try: () => loadOrCreateAgentAwarenessDeviceId(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-registration-identifier",
          cause,
        }),
    }),
    Effect.tryPromise({
      try: () => loadPreferences(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-registration-preferences",
          cause,
        }),
    }),
  ]);
  const preferences = mergeAgentAwarenessRegistrationPreferences(
    storedPreferences,
    input.preferencesOverride,
  );
  if (expectedGeneration !== deviceRegistrationGeneration) return;
  if (relayTokenProvider && relayTokenProviderIdentity) {
    configureAndroidAgentNotifications(
      deviceId,
      relayTokenProviderIdentity,
      preferences.liveActivitiesEnabled !== false,
    );
  }
  const pushTokenRegistration = yield* nativePushTokenRegistration(input?.observedPushToken);
  const bundleId =
    Platform.OS === "android"
      ? Constants.expoConfig?.android?.package?.trim()
      : Constants.expoConfig?.ios?.bundleIdentifier?.trim();
  yield* registerDeviceWithRelay(
    makeRelayDeviceRegistrationRequest({
      deviceId,
      label:
        Constants.deviceName?.trim() ||
        (Platform.OS === "android" ? "Android device" : "iOS device"),
      ...(Platform.OS === "android"
        ? { platform: "android" as const, androidApiLevel: Number(Platform.Version) }
        : { platform: "ios" as const, iosMajorVersion: iosMajorVersion() }),
      appVersion: Constants.expoConfig?.version,
      ...(bundleId ? { bundleId } : {}),
      ...(Platform.OS === "ios"
        ? { apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant) }
        : {}),
      ...(pushTokenRegistration.pushToken ? { pushToken: pushTokenRegistration.pushToken } : {}),
      notificationsEnabled: pushTokenRegistration.notificationsEnabled,
      preferences,
    }),
    expectedGeneration,
  );
});


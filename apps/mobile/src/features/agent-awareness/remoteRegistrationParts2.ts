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
import { ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS, readAndroidDeviceReplayedAt, markAndroidDeviceReplayedAt, deviceRegistrationGeneration, logRegistrationError, readRelayConfig, registrationSignature, relayToken, relayTokenProviderIdentity, setRegistrationStatus } from "./remoteRegistration";

export const registerDeviceWithRelay = Effect.fn("remoteRegistration.registerDeviceWithRelay")(function* (
  body: RelayDeviceRegistrationRequest,
  expectedGeneration: number,
): Effect.fn.Return<void, unknown, ManagedRelay.ManagedRelayClient> {
  if (expectedGeneration !== deviceRegistrationGeneration) {
    return;
  }
  const relayConfig = readRelayConfig();
  if (!relayConfig) {
    setRegistrationStatus("unknown");
    return;
  }
  const token = yield* relayToken("read-device-registration-relay-token");
  if (expectedGeneration !== deviceRegistrationGeneration) {
    return;
  }
  if (!token) {
    setRegistrationStatus("unknown");
    return;
  }

  const identity = relayTokenProviderIdentity ?? "";
  const persisted = yield* Effect.tryPromise({
    try: () => loadAgentAwarenessRegistrationRecord(),
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => null));
  if (expectedGeneration !== deviceRegistrationGeneration) {
    // Signed out while the record loaded — do not resurrect the cleared
    // record or report the previous account's registration as current.
    return;
  }
  const payload = body;
  const signature = `${relayConfig.url}|${registrationSignature(payload)}`;
  // Android registration also silently replays the current card. Collapse
  // foreground bursts, but repair missed pushes on cold start or a return
  // after time away, just like re-registering an iOS activity token.
  const needsAndroidReplay =
    body.platform === "android" &&
    (readAndroidDeviceReplayedAt() === null ||
      Date.now() - readAndroidDeviceReplayedAt()! >= ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS);
  if (
    persisted &&
    persisted.identity === identity &&
    persisted.signature === signature &&
    !needsAndroidReplay
  ) {
    setRegistrationStatus("registered");
    return;
  }

  const client = yield* ManagedRelay.ManagedRelayClient;
  yield* client.registerDevice({
    clerkToken: token,
    payload,
  });
  if (expectedGeneration !== deviceRegistrationGeneration) {
    // Signed out while the request was in flight: the sign-out path already
    // reset the status and cleared the record for the next account, so a
    // stale success must not overwrite either.
    return;
  }
  if (body.platform === "android") markAndroidDeviceReplayedAt(Date.now());
  setRegistrationStatus("registered");
  yield* Effect.promise(() =>
    saveAgentAwarenessRegistrationRecord({
      identity,
      signature,
    }).catch((error: unknown) => {
      logRegistrationError("persist registration record failed", error);
    }),
  );
});


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
import { AgentAwarenessOperationError, canRegisterRemoteLiveActivities, dismissEndedLocalLiveActivities, liveActivityStaleDate, logRegistrationError, readAgentActivitySnapshot, registerLiveActivityPushToken, relayTokenProvider, scheduleActiveLiveActivityRegistrationRetry } from "./remoteRegistration";

export const refreshActiveLiveActivityRemoteRegistration = Effect.fn(
  "remoteRegistration.refreshActiveLiveActivityRemoteRegistration",
)(function* (): Effect.fn.Return<void, never, ManagedRelay.ManagedRelayClient> {
  if (!canRegisterRemoteLiveActivities() || !relayTokenProvider) {
    return;
  }

  dismissEndedLocalLiveActivities();
  let activities = yield* Effect.try({
    try: () => getAgentLiveActivities(),
    catch: (cause) =>
      new AgentAwarenessOperationError({
        operation: "list-active-live-activities",
        cause,
      }),
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logRegistrationError("active live activity lookup failed", error);
        return [] as ReadonlyArray<LiveActivity<AgentActivityProps>>;
      }),
    ),
  );

  // The relay tracks exactly one card per device; if concurrent arming ever
  // produced extras, end them so only one keeps receiving updates.
  if (activities.length > 1) {
    for (const extra of activities.slice(1)) {
      extra.end("immediate").catch((error: unknown) => {
        logRegistrationError("duplicate live activity cleanup failed", error);
      });
    }
    activities = activities.slice(0, 1);
  }

  // Activities are only ever created here, in the foreground, where the
  // update token can be observed and registered immediately — the relay never
  // remote-starts one (background push-to-start wakes proved too unreliable
  // to hand the token over).
  if (activities.length === 0) {
    const preferences = yield* Effect.tryPromise({
      try: () => loadPreferences(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-live-activity-prime-preferences",
          cause,
        }),
    }).pipe(Effect.orElseSucceed(() => null));
    if (preferences?.liveActivitiesEnabled !== false) {
      const snapshot = yield* readAgentActivitySnapshot();
      // The snapshot request yields; an arm-on-send may have created the
      // card in the meantime. Re-check so two cards are never started.
      const armedMeanwhile = yield* Effect.try({
        try: () => getAgentLiveActivities(),
        catch: () => [] as ReadonlyArray<LiveActivity<AgentActivityProps>>,
      }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<LiveActivity<AgentActivityProps>>));
      if (armedMeanwhile.length > 0) {
        activities = [...armedMeanwhile];
      } else if (snapshot?.aggregate && snapshot.aggregate.activeCount > 0) {
        const aggregate = snapshot.aggregate;
        const primed = yield* Effect.try({
          try: () =>
            startAgentLiveActivity(
              {
                title: aggregate.title,
                subtitle: aggregate.subtitle,
                activeCount: aggregate.activeCount,
                updatedAt: aggregate.updatedAt,
                activities: aggregate.activities,
              },
              liveActivityStaleDate(),
            ),
          catch: (cause) =>
            new AgentAwarenessOperationError({
              operation: "prime-live-activity",
              cause,
            }),
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              logRegistrationError("live activity priming failed", error);
              return null;
            }),
          ),
        );
        if (primed) {
          activities = [primed];
        }
      }
    }
  }

  const registrationResults = yield* Effect.forEach(activities, (activity) =>
    registerLiveActivityPushToken({ activity }).pipe(
      Effect.map((registered) => !registered),
      Effect.catch((error) =>
        Effect.sync(() => {
          logRegistrationError("active live activity token registration failed", error);
          return true;
        }),
      ),
    ),
  );

  if (registrationResults.some(Boolean)) {
    scheduleActiveLiveActivityRegistrationRetry();
  }
});


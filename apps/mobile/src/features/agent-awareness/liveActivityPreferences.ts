import * as Effect from "effect/Effect";

import type { SavedRemoteConnection } from "../../lib/connection";
import { MobilePreferencesStore } from "../../persistence/mobile-preferences";
import { linkEnvironmentToCloudWithPreference } from "../cloud/linkEnvironment";
import { updateAgentAwarenessRegistrationPreferences } from "./remoteRegistration";

export const setLiveActivityUpdatesEnabled = Effect.fn("setLiveActivityUpdatesEnabled")(
  function* (input: {
    readonly enabled: boolean;
    readonly clerkToken: string | null;
    readonly connections: ReadonlyArray<SavedRemoteConnection>;
  }) {
    const preferences = yield* MobilePreferencesStore;
    const previousEnabled = (yield* preferences.load).liveActivitiesEnabled !== false;
    const linkedConnections = input.connections.filter(
      (connection) => connection.bearerToken !== null,
    );

    const updateRelayPreference = Effect.fn("updateRelayPreference")(function* (enabled: boolean) {
      yield* updateAgentAwarenessRegistrationPreferences({
        liveActivitiesEnabled: enabled,
      });

      const clerkToken = input.clerkToken;
      if (!clerkToken) return;

      yield* Effect.forEach(
        linkedConnections,
        (connection) =>
          linkEnvironmentToCloudWithPreference({
            clerkToken,
            connection,
            liveActivitiesEnabled: enabled,
          }),
        { concurrency: "unbounded" },
      );
    });

    const restoreRelayPreference = Effect.fn("restoreRelayPreference")(function* () {
      yield* updateAgentAwarenessRegistrationPreferences({
        liveActivitiesEnabled: previousEnabled,
      }).pipe(Effect.catchCause(() => Effect.void));

      const clerkToken = input.clerkToken;
      if (!clerkToken) return;

      yield* Effect.forEach(
        linkedConnections,
        (connection) =>
          linkEnvironmentToCloudWithPreference({
            clerkToken,
            connection,
            liveActivitiesEnabled: previousEnabled,
          }).pipe(Effect.catchCause(() => Effect.void)),
        { concurrency: "unbounded" },
      );
    });

    yield* updateRelayPreference(input.enabled).pipe(
      Effect.onError(() => restoreRelayPreference()),
    );
  },
);

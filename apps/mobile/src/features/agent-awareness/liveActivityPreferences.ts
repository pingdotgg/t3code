import * as Effect from "effect/Effect";
import type { EnvironmentId } from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";
import {
  linkEnvironmentToCloudWithPreference,
  updateLinkedEnvironmentLiveActivityPreference,
} from "../cloud/linkEnvironment";
import { updateAgentAwarenessRegistrationPreferences } from "./remoteRegistration";

export const setLiveActivityUpdatesEnabled = Effect.fn("setLiveActivityUpdatesEnabled")(
  function* (input: {
    readonly enabled: boolean;
    readonly previousEnabled: boolean;
    readonly clerkToken: string | null;
    readonly connections: ReadonlyArray<SavedRemoteConnection>;
    readonly canUpdateEnvironment: (environmentId: EnvironmentId) => boolean;
    readonly canConfigureEnvironment: (environmentId: EnvironmentId) => boolean;
  }) {
    const linkedConnections = input.connections.filter(
      (connection) => connection.bearerToken !== null,
    );

    const updateEnvironmentPreference = Effect.fn("updateEnvironmentPreference")(function* (
      connection: SavedRemoteConnection,
      enabled: boolean,
      clerkToken: string | null,
    ) {
      const result = input.canUpdateEnvironment(connection.environmentId)
        ? yield* updateLinkedEnvironmentLiveActivityPreference(connection, enabled)
        : "unlinked";
      if (result === "updated") return false;
      if (!enabled || !clerkToken || !input.canConfigureEnvironment(connection.environmentId)) {
        return result === "unsupported";
      }

      yield* linkEnvironmentToCloudWithPreference({
        clerkToken,
        connection,
        liveActivitiesEnabled: enabled,
      });
      return false;
    });

    const updateRelayPreference = Effect.fn("updateRelayPreference")(function* (enabled: boolean) {
      yield* updateAgentAwarenessRegistrationPreferences({
        liveActivitiesEnabled: enabled,
      });

      const clerkToken = input.clerkToken;
      if (!clerkToken) return false;

      const results = yield* Effect.forEach(
        linkedConnections,
        (connection) => updateEnvironmentPreference(connection, enabled, clerkToken),
        { concurrency: "unbounded" },
      );
      return results.some(Boolean);
    });

    const restoreRelayPreference = Effect.fn("restoreRelayPreference")(function* () {
      yield* updateAgentAwarenessRegistrationPreferences({
        liveActivitiesEnabled: input.previousEnabled,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not restore Live Activity device preference.", cause),
        ),
      );

      const clerkToken = input.clerkToken;
      if (!clerkToken) return;

      yield* Effect.forEach(
        linkedConnections,
        (connection) =>
          updateEnvironmentPreference(connection, input.previousEnabled, null).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Could not restore Live Activity preference for environment ${connection.environmentId}.`,
                cause,
              ),
            ),
          ),
        { concurrency: "unbounded" },
      );
    });

    return yield* updateRelayPreference(input.enabled).pipe(
      Effect.onError(() => restoreRelayPreference()),
    );
  },
);

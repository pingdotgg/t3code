import * as Effect from "effect/Effect";
import type { EnvironmentId } from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";
import {
  linkEnvironmentToCloudWithPreference,
  type CloudEnvironmentLinkError,
} from "../cloud/linkEnvironment";
import { updateAgentAwarenessRegistrationPreferences } from "./remoteRegistration";

export const setLiveActivityUpdatesEnabled = Effect.fn("setLiveActivityUpdatesEnabled")(
  function* (input: {
    readonly enabled: boolean;
    readonly previousEnabled: boolean;
    readonly clerkToken: string | null;
    readonly connections: ReadonlyArray<SavedRemoteConnection>;
    readonly updateEnvironment: (
      environmentId: EnvironmentId,
      enabled: boolean,
    ) => Effect.Effect<"updated" | "unlinked" | "unsupported", CloudEnvironmentLinkError>;
    readonly canUpdateEnvironment: (environmentId: EnvironmentId) => boolean;
    readonly canConfigureEnvironment: (environmentId: EnvironmentId) => boolean;
  }) {
    const updateEnvironmentPreference = Effect.fn("updateEnvironmentPreference")(function* (
      connection: SavedRemoteConnection,
      enabled: boolean,
      clerkToken: string | null,
    ) {
      const result = input.canUpdateEnvironment(connection.environmentId)
        ? yield* input.updateEnvironment(connection.environmentId, enabled)
        : "unlinked";
      if (result === "updated") return false;
      if (
        !enabled ||
        !clerkToken ||
        !connection.bearerToken ||
        !input.canConfigureEnvironment(connection.environmentId)
      ) {
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
        input.connections,
        (connection) => updateEnvironmentPreference(connection, enabled, clerkToken),
        { concurrency: "unbounded" },
      );
      return results.some(Boolean);
    });

    return yield* updateRelayPreference(input.enabled).pipe(
      Effect.onError(() =>
        updateAgentAwarenessRegistrationPreferences({
          liveActivitiesEnabled: input.previousEnabled,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not restore Live Activity device preference.", cause),
          ),
        ),
      ),
    );
  },
);

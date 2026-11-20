import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { EnvironmentId } from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";
import type { CloudEnvironmentLinkError } from "../cloud/linkEnvironment";
import { updateAgentAwarenessRegistrationPreferences } from "./remoteRegistration";

export class LiveActivityEnvironmentUpdateError extends Schema.TaggedError<LiveActivityEnvironmentUpdateError>()(
  "LiveActivityEnvironmentUpdateError",
  {
    updatedEnvironments: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export const setLiveActivityUpdatesEnabled = Effect.fn("setLiveActivityUpdatesEnabled")(function* <
  SaveError,
>(input: {
  readonly enabled: boolean;
  readonly previousEnabled: boolean;
  readonly clerkToken: string | null;
  readonly connections: ReadonlyArray<SavedRemoteConnection>;
  readonly updateEnvironment: (
    environmentId: EnvironmentId,
    enabled: boolean,
  ) => Effect.Effect<
    "updated" | "unlinked" | "unsupported" | "disconnected",
    CloudEnvironmentLinkError
  >;
  readonly linkEnvironment: (
    environmentId: EnvironmentId,
    input: { readonly clerkToken: string; readonly liveActivitiesEnabled: boolean },
  ) => Effect.Effect<void, CloudEnvironmentLinkError>;
  readonly canUpdateEnvironment: (environmentId: EnvironmentId) => boolean;
  readonly canConfigureEnvironment: (environmentId: EnvironmentId) => boolean;
  readonly saveLocalPreference: (enabled: boolean) => Effect.Effect<unknown, SaveError>;
}) {
  const updateEnvironmentPreference = Effect.fn("updateEnvironmentPreference")(function* (
    connection: SavedRemoteConnection,
    enabled: boolean,
    clerkToken: string | null,
  ) {
    const result = input.canUpdateEnvironment(connection.environmentId)
      ? yield* input.updateEnvironment(connection.environmentId, enabled)
      : "unlinked";
    if (result === "updated" || result === "disconnected") return result;
    if (!enabled || !clerkToken || !input.canConfigureEnvironment(connection.environmentId)) {
      return result;
    }

    yield* input.linkEnvironment(connection.environmentId, {
      clerkToken,
      liveActivitiesEnabled: enabled,
    });
    return "updated" as const;
  });

  const updateRelayPreference = Effect.fn("updateRelayPreference")(function* (enabled: boolean) {
    yield* updateAgentAwarenessRegistrationPreferences({
      liveActivitiesEnabled: enabled,
    });

    const clerkToken = input.clerkToken;
    if (!clerkToken) return false;

    const results = yield* Effect.forEach(
      input.connections,
      (connection) =>
        updateEnvironmentPreference(connection, enabled, clerkToken).pipe(
          Effect.result,
          Effect.map((result) => ({ connection, result })),
        ),
      { concurrency: "unbounded" },
    );
    const failure = results.find(({ result }) => Result.isFailure(result));
    if (failure && Result.isFailure(failure.result)) {
      const updatedEnvironments = results.flatMap(({ connection, result }) => {
        const changed = Result.isSuccess(result)
          ? result.success === "updated"
          : result.failure.relayLinkCommitted === true;
        return changed ? [connection.environmentLabel] : [];
      });
      if (updatedEnvironments.length === 0) return yield* failure.result.failure;
      return yield* new LiveActivityEnvironmentUpdateError({
        updatedEnvironments,
        cause: failure.result.failure,
      });
    }
    return results.some(
      ({ result }) => Result.isSuccess(result) && result.success === "unsupported",
    );
  });

  return yield* updateRelayPreference(input.enabled).pipe(
    // Saved here so a device that cannot keep the setting restores its registration too.
    Effect.tap(() => input.saveLocalPreference(input.enabled)),
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
});

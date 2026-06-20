import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ManagedRelay } from "@t3tools/client-runtime/relay";

import type { SavedRemoteConnection } from "../../lib/connection";
import { savePreferencesPatch } from "../../lib/storage";
import { linkEnvironmentToCloud } from "../cloud/linkEnvironment";
import { refreshAgentAwarenessRegistration } from "./remoteRegistration";

export class LiveActivityPreferenceSaveError extends Schema.TaggedErrorClass<LiveActivityPreferenceSaveError>()(
  "LiveActivityPreferenceSaveError",
  {
    enabled: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to save the Live Activity updates setting (enabled: ${this.enabled}).`;
  }
}

export function setLiveActivityUpdatesEnabled(input: {
  readonly enabled: boolean;
  readonly clerkToken: string | null;
  readonly connections: ReadonlyArray<SavedRemoteConnection>;
}): Effect.Effect<void, unknown, HttpClient.HttpClient | ManagedRelay.ManagedRelayClient> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => savePreferencesPatch({ liveActivitiesEnabled: input.enabled }),
      catch: (cause) => new LiveActivityPreferenceSaveError({ enabled: input.enabled, cause }),
    });

    yield* refreshAgentAwarenessRegistration();

    const clerkToken = input.clerkToken;
    if (!clerkToken) {
      return;
    }

    yield* Effect.forEach(
      input.connections.filter((connection) => connection.bearerToken !== null),
      (connection) => linkEnvironmentToCloud({ clerkToken, connection }),
      { concurrency: "unbounded" },
    );
  });
}

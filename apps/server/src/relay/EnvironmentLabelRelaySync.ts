import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { readRelayConnection } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeRelayEnvironmentClient } from "./relayEnvironmentClient.ts";

const pushEnvironmentLabel = Effect.fn("EnvironmentLabelRelaySync.push")(function* (
  environmentLabel: string,
) {
  const connection = yield* readRelayConnection;
  if (connection === null) return;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptorForSettings({ environmentLabel });
  const client = yield* makeRelayEnvironmentClient(connection);
  yield* client.server.updateEnvironmentLabel({
    params: { environmentId: descriptor.environmentId },
    payload: { label: descriptor.label },
  });
});

/**
 * Pushes the host name to T3 Connect when it changes, so Connect clients see
 * it before their next status check. That check still corrects a lost push.
 * Pushes run one at a time so an older name cannot land after a newer one.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const changes = yield* settings.subscribeChanges;
    const initial = yield* settings.getSettings.pipe(
      Effect.map((current): string | null => current.environmentLabel),
      Effect.orElseSucceed(() => null),
    );
    const push = (environmentLabel: string) =>
      pushEnvironmentLabel(environmentLabel).pipe(
        Effect.timeout("10 seconds"),
        Effect.retry({ schedule: Schedule.exponential("2 seconds"), times: 3 }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not send the host name to T3 Connect", { cause }),
        ),
      );
    yield* Stream.concat(
      Stream.make(initial),
      changes.pipe(Stream.map((next): string | null => next.environmentLabel)),
    ).pipe(
      Stream.changes,
      Stream.drop(1),
      Stream.runForEach((environmentLabel) => push(environmentLabel ?? "")),
      Effect.forkScoped,
    );
  }),
);

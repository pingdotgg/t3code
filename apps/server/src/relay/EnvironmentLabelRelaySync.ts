import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
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
  if (connection === null) return false;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptorForSettings({ environmentLabel });
  const client = yield* makeRelayEnvironmentClient(connection);
  yield* client.server.updateEnvironmentLabel({
    params: { environmentId: descriptor.environmentId },
    payload: { label: descriptor.label },
  });
  return true;
});

/**
 * Pushes the current host name to T3 Connect at startup and when it changes.
 * Managed tunnel status checks also correct lost pushes.
 * Pushes run one at a time so an older name cannot land after a newer one.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const changes = yield* settings.subscribeChanges;
    const initial = yield* settings.getEnvironmentLabel;
    const lastPushedLabel = yield* Ref.make<string | null>(null);
    const push = Effect.fn("EnvironmentLabelRelaySync.sync")(function* (environmentLabel: string) {
      if ((yield* Ref.get(lastPushedLabel)) === environmentLabel) return;
      yield* pushEnvironmentLabel(environmentLabel).pipe(
        Effect.timeout("10 seconds"),
        Effect.retry({ schedule: Schedule.exponential("2 seconds"), times: 3 }),
        Effect.tap((sent) => Ref.set(lastPushedLabel, sent ? environmentLabel : null)),
        Effect.catchCause((cause) =>
          Ref.set(lastPushedLabel, null).pipe(
            Effect.andThen(
              Effect.logWarning("Could not send the host name to T3 Connect", { cause }),
            ),
          ),
        ),
      );
    });
    yield* Stream.concat(
      Stream.make(initial),
      changes.pipe(Stream.map((next) => next.environmentLabel)),
    ).pipe(Stream.runForEach(push), Effect.forkScoped);
  }),
);

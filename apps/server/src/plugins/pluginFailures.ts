import type { PluginId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { errorText } from "./api/facade.ts";

// A plugin's failures outside a call reach clients at most this often, the latest one last, so a
// timer failing every few milliseconds with new text does not resend the list each time.
const FAILURE_PUBLISH_INTERVAL = Duration.seconds(5);

interface Failure {
  readonly revision: number | undefined;
  readonly message: string;
}

/**
 * Builds the host's record of the failures a plugin's row shows: server code failing outside a
 * call. Each belongs to the start, the revision, it happened in.
 */
export const makePluginFailures = Effect.gen(function* () {
  // By plugin id, for the start it happened in: a new start's revision hides the old one. A
  // stopped plugin's leftover timers fail with no revision.
  const serverFailures = yield* Ref.make<ReadonlyMap<PluginId, Failure>>(new Map());
  // When each plugin's failure was last published, and the plugins whose next one is waiting.
  const publishedAt = new Map<PluginId, number>();
  const waiting = new Set<PluginId>();

  return {
    current: Effect.gen(function* () {
      const server = yield* Ref.get(serverFailures);
      return (pluginId: PluginId, revision: number | undefined) => {
        const failure = server.get(pluginId);
        return failure !== undefined && failure.revision === revision ? failure.message : undefined;
      };
    }),
    /**
     * Records a failure of the start `revision` outside a call, then succeeds with whether to
     * publish: a timer that fails every second with the same text logs and publishes once.
     * Untraced: a plugin's timer can fail every few milliseconds.
     */
    recordServer: Effect.fnUntraced(function* (
      pluginId: PluginId,
      revision: number | undefined,
      error: unknown,
    ) {
      const message = errorText(error);
      const known = (yield* Ref.get(serverFailures)).get(pluginId);
      if (known?.revision === revision && known?.message === message) return false;
      yield* Ref.update(serverFailures, (all) => new Map(all).set(pluginId, { revision, message }));
      if (waiting.has(pluginId)) return false;
      const last = publishedAt.get(pluginId);
      const wait =
        last === undefined
          ? 0
          : last + Duration.toMillis(FAILURE_PUBLISH_INTERVAL) - (yield* Clock.currentTimeMillis);
      if (wait > 0) {
        waiting.add(pluginId);
        yield* Effect.sleep(Duration.millis(wait)).pipe(
          Effect.ensuring(Effect.sync(() => waiting.delete(pluginId))),
        );
      }
      publishedAt.set(pluginId, yield* Clock.currentTimeMillis);
      yield* Effect.logWarning("plugin code failed outside a call", {
        pluginId,
        reason: (yield* Ref.get(serverFailures)).get(pluginId)?.message ?? message,
      });
      return true;
    }),
    clearServer: (pluginId: PluginId) =>
      Ref.update(serverFailures, (all) => {
        const next = new Map(all);
        next.delete(pluginId);
        return next;
      }),
  };
});

export type PluginFailures = Effect.Success<typeof makePluginFailures>;

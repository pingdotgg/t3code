/**
 * ProviderUsageLimitsIngestionLive — folds `account.rate-limits.updated`
 * runtime events into the owning instance's published snapshot.
 *
 * Claude and Codex both push rate-limit updates over their session runtime
 * while a turn streams. Without this consumer those events had no subscriber,
 * so quota bars sat stale for a whole refresh interval after the turn that
 * moved them. The write path is `ServerProviderShape.applyUsageLimits`, which
 * patches only `usageLimits` and republishes on the instance's own PubSub —
 * the aggregation in `ProviderRegistry` is already subscribed to that stream,
 * so no extra fan-out wiring is needed here. The Usage page reads those
 * snapshots.
 *
 * @module provider/Layers/ProviderUsageLimitsIngestion
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { parseRuntimeUsageLimitsUpdate } from "../runtimeUsageLimits.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";

export const ProviderUsageLimitsIngestionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const instanceRegistry = yield* ProviderInstanceRegistry;

    yield* providerService.streamEvents.pipe(
      Stream.filter((event) => event.type === "account.rate-limits.updated"),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const instanceId = event.providerInstanceId;
          if (!instanceId) {
            return;
          }
          const instance = yield* instanceRegistry.getInstance(instanceId);
          if (!instance) {
            return;
          }

          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          const update = parseRuntimeUsageLimitsUpdate({
            driverKind: instance.driverKind,
            rateLimits: event.payload.rateLimits,
            checkedAt,
          });
          if (!update) {
            return;
          }

          yield* instance.snapshot.applyUsageLimits({
            source: update.source,
            checkedAt,
            windows: update.windows,
          });
          // Isolate failures to this event so a bad payload cannot complete
          // the subscriber and stop all later live usage updates.
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    );
  }),
);

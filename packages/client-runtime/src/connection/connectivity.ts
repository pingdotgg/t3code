import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { NetworkStatus } from "./model.ts";
import * as ConnectionWakeups from "./wakeups.ts";

export class Connectivity extends Context.Service<
  Connectivity,
  {
    readonly status: Effect.Effect<NetworkStatus>;
    readonly changes: Stream.Stream<NetworkStatus>;
  }
>()("@t3tools/client-runtime/connection/connectivity") {}

export const make = (service: Connectivity["Service"]) => Connectivity.of(service);

export const layer = (service: Connectivity["Service"]) =>
  Layer.succeed(Connectivity, make(service));

/**
 * Applies every reported connectivity change, plus a freshly read status each
 * time the application resumes.
 *
 * Platform listeners drop transitions while an app is suspended, so a consumer
 * that follows `changes` alone keeps a stale status until the next real
 * transition — which left mobile stranded on "offline" until it was restarted.
 * Reading the status is asynchronous, so a read that started before a newer
 * reported change is discarded instead of applied over it.
 */
export const followNetworkStatus = Effect.fnUntraced(function* (options: {
  readonly connectivity: Connectivity["Service"];
  readonly wakeups: ConnectionWakeups.ConnectionWakeups["Service"];
  readonly apply: (status: NetworkStatus) => Effect.Effect<void>;
}) {
  // `changeCount` counts applied status changes rather than received events, so
  // a listener that repeats the status already in effect carries no newer
  // information and cannot discard a resumed read.
  const applied = yield* Ref.make<{
    readonly status: Option.Option<NetworkStatus>;
    readonly changeCount: number;
  }>({ status: Option.none(), changeCount: 0 });
  // Counting a reported change and applying it has to be indivisible with
  // respect to the resume branch's guard. Otherwise a change landing between
  // that guard and its apply would be overwritten by the older read.
  const applyLock = yield* Semaphore.make(1);

  const applyStatus = Effect.fnUntraced(function* (status: NetworkStatus) {
    const changed = yield* Ref.modify(applied, (current) =>
      Option.isSome(current.status) && current.status.value === status
        ? ([false, current] as const)
        : ([true, { status: Option.some(status), changeCount: current.changeCount + 1 }] as const),
    );
    if (changed) {
      yield* options.apply(status);
    }
  });

  yield* options.connectivity.changes.pipe(
    Stream.runForEach((status) => applyLock.withPermits(1)(applyStatus(status))),
    // Subscribe before returning so a transition reported while this is still
    // being set up is not dropped.
    Effect.forkScoped({ startImmediately: true }),
  );

  yield* options.wakeups.changes.pipe(
    Stream.runForEach((reason) =>
      reason === "application-active"
        ? Effect.gen(function* () {
            // `runForEach` is sequential, so resume reads cannot overlap: a
            // second resume does not start a read until this one has applied.
            const startedAt = (yield* Ref.get(applied)).changeCount;
            const status = yield* options.connectivity.status;
            yield* applyLock.withPermits(1)(
              Effect.gen(function* () {
                // Re-read under the permit: a status change applied while the
                // read was in flight is newer, so this result is stale.
                if ((yield* Ref.get(applied)).changeCount === startedAt) {
                  yield* applyStatus(status);
                }
              }),
            );
          })
        : Effect.void,
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
});

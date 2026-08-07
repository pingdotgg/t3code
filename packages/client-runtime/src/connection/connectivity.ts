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
 * Follows reported connectivity changes and repairs status drift whenever the
 * application becomes active. Mobile platforms can suspend network listeners,
 * which is especially visible while a VPN tunnel is restoring in the
 * background. A report that arrives during the asynchronous status read always
 * wins over that older snapshot.
 */
export const followNetworkStatus = Effect.fnUntraced(function* (options: {
  readonly apply: (status: NetworkStatus) => Effect.Effect<void>;
  readonly onWakeup?: (reason: ConnectionWakeups.ConnectionWakeup) => Effect.Effect<void>;
}) {
  const connectivity = yield* Connectivity;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const revision = yield* Ref.make(0);
  const appliedStatus = yield* Ref.make<Option.Option<NetworkStatus>>(Option.none());
  const applyLock = yield* Semaphore.make(1);

  const applyStatus = Effect.fnUntraced(function* (status: NetworkStatus) {
    const changed = yield* Ref.modify(appliedStatus, (current) =>
      Option.isSome(current) && current.value === status
        ? ([false, current] as const)
        : ([true, Option.some(status)] as const),
    );
    if (changed) {
      yield* options.apply(status);
    }
    return changed;
  });

  const refreshCurrentStatus = Effect.gen(function* () {
    const startedAt = yield* Ref.updateAndGet(revision, (current) => current + 1);
    const status = yield* connectivity.status;
    yield* applyLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(revision)) === startedAt) {
          yield* applyStatus(status);
        }
      }),
    );
  });

  yield* connectivity.changes.pipe(
    Stream.runForEach((status) =>
      applyLock.withPermits(1)(
        applyStatus(status).pipe(
          Effect.flatMap((changed) =>
            changed ? Ref.update(revision, (current) => current + 1) : Effect.void,
          ),
        ),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) =>
      Effect.gen(function* () {
        if (options.onWakeup) {
          yield* options.onWakeup(reason);
        }
        if (ConnectionWakeups.isApplicationActiveWakeup(reason)) {
          yield* refreshCurrentStatus;
        }
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  yield* refreshCurrentStatus;
});

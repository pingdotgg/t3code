import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as Connectivity from "./connectivity.ts";
import type { NetworkStatus } from "./model.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const makeHarness = Effect.fn("TestConnectivityHarness.make")(function* (options?: {
  readonly status?: Effect.Effect<NetworkStatus>;
  readonly initialStatus?: NetworkStatus;
}) {
  const liveStatus = yield* Ref.make<NetworkStatus>(options?.initialStatus ?? "online");
  const reported = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly status: NetworkStatus;
  }>({ sequence: 0, status: options?.initialStatus ?? "online" });
  const wakeups = yield* SubscriptionRef.make(0);
  const applied = yield* Ref.make<ReadonlyArray<NetworkStatus>>([]);

  const connectivity = Connectivity.Connectivity.of({
    status: options?.status ?? Ref.get(liveStatus),
    changes: SubscriptionRef.changes(reported).pipe(
      Stream.drop(1),
      Stream.map((event) => event.status),
    ),
  });

  const wakeupService = ConnectionWakeups.ConnectionWakeups.of({
    changes: SubscriptionRef.changes(wakeups).pipe(
      Stream.drop(1),
      Stream.map(() => "application-active" as const),
    ),
  });

  return {
    connectivity,
    wakeups: wakeupService,
    applied,
    setLiveStatus: (status: NetworkStatus) => Ref.set(liveStatus, status),
    // Emits a listener event, as a platform connectivity listener would.
    report: (status: NetworkStatus) =>
      Ref.set(liveStatus, status).pipe(
        Effect.andThen(
          SubscriptionRef.update(reported, (event) => ({
            sequence: event.sequence + 1,
            status,
          })),
        ),
      ),
    resume: SubscriptionRef.update(wakeups, (count) => count + 1),
    apply: (status: NetworkStatus) => Ref.update(applied, (statuses) => [...statuses, status]),
  };
});

// The forked listeners subscribe after `followNetworkStatus` returns, so repeat
// the trigger until its effect is observed rather than racing the first one.
const untilApplied = Effect.fn("TestConnectivityHarness.untilApplied")(function* (
  trigger: Effect.Effect<unknown>,
  applied: Ref.Ref<ReadonlyArray<NetworkStatus>>,
  expected: number,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    yield* trigger;
    yield* Effect.yieldNow;
    if ((yield* Ref.get(applied)).length >= expected) {
      return yield* Ref.get(applied);
    }
  }
  return yield* Effect.die(new Error("The expected network status was never applied."));
});

describe("followNetworkStatus", () => {
  it.effect("applies statuses reported by the platform listener", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        const applied = yield* untilApplied(harness.report("offline"), harness.applied, 1);
        expect(applied).toEqual(["offline"]);
      }),
    ),
  );

  it.effect("applies a resumed read when the listener missed a transition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ initialStatus: "offline" });
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        // The device came back online while suspended and the listener never
        // reported the transition.
        yield* harness.setLiveStatus("online");
        const applied = yield* untilApplied(harness.resume, harness.applied, 1);
        expect(applied).toEqual(["online"]);
      }),
    ),
  );

  it.effect("discards a resumed read that a newer reported change superseded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const readStarted = yield* Deferred.make<void>();
        const releaseRead = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          initialStatus: "offline",
          status: Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRead)),
            Effect.as("online" as const),
          ),
        });
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        // Resume, and hold the status read open so the listener can report a
        // newer transition while that read is still in flight.
        yield* harness.resume.pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.repeat({ until: () => Deferred.isDone(readStarted) }),
        );
        yield* untilApplied(harness.report("offline"), harness.applied, 1);
        yield* Deferred.succeed(releaseRead, undefined);
        yield* Effect.yieldNow;

        // The stale "online" snapshot must not land on top of the newer event.
        expect(yield* Ref.get(harness.applied)).toEqual(["offline"]);
      }),
    ),
  );
});

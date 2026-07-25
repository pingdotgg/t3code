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

  it.effect("discards a resumed read that a repeated report raced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const readStarted = yield* Deferred.make<void>();
        const releaseRead = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          initialStatus: "online",
          // The resume samples a brief opposite state.
          status: Deferred.succeed(readStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRead)),
            Effect.as("offline" as const),
          ),
        });
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        // Apply "online" first so the listener's later repeat of it is genuinely
        // redundant rather than a new status.
        yield* untilApplied(harness.report("online"), harness.applied, 1);
        yield* harness.resume.pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.repeat({ until: () => Deferred.isDone(readStarted) }),
        );

        // The repeat carries no new status, but it proves the listener spoke
        // after this read began, so the read is stale even though the status it
        // returns differs. Applying it would strand consumers on "offline" while
        // the platform reports "online" — the very failure this helper exists to
        // prevent.
        yield* harness.report("online");
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseRead, undefined);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        expect(yield* Ref.get(harness.applied)).toEqual(["online"]);
      }),
    ),
  );

  it.effect("still deduplicates a repeated report before it reaches consumers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ initialStatus: "online" });
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        yield* untilApplied(harness.report("offline"), harness.applied, 1);
        // Counting the repeat for staleness must not turn it into a redundant
        // consumer update.
        yield* harness.report("offline");
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(yield* Ref.get(harness.applied)).toEqual(["offline"]);

        // A genuine transition after the repeat still lands.
        yield* untilApplied(harness.report("online"), harness.applied, 2);
        expect(yield* Ref.get(harness.applied)).toEqual(["offline", "online"]);
      }),
    ),
  );

  it.effect("does not start a second status read while one is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstRead = yield* Deferred.make<NetworkStatus>();
        const readCount = yield* Ref.make(0);
        const harness = yield* makeHarness({
          initialStatus: "unknown",
          status: Ref.updateAndGet(readCount, (count) => count + 1).pipe(
            Effect.andThen(Deferred.await(firstRead)),
          ),
        });
        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: harness.apply,
        });

        yield* harness.resume.pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.repeat({
            until: () => Ref.get(readCount).pipe(Effect.map((count) => count >= 1)),
          }),
        );

        // Resumes are consumed sequentially, so further resumes cannot start a
        // read that races the one already in flight. Overlapping snapshots
        // therefore cannot apply out of order.
        yield* harness.resume;
        yield* harness.resume;
        yield* Effect.yieldNow;
        expect(yield* Ref.get(readCount)).toBe(1);

        yield* Deferred.succeed(firstRead, "online");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(harness.applied)).toEqual(["online"]);
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

  it.effect("keeps a reported change from interleaving with a resumed apply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const applyStarted = yield* Deferred.make<void>();
        const releaseApply = yield* Deferred.make<void>();
        const harness = yield* makeHarness({ initialStatus: "offline" });
        // Holds the resumed apply open once it begins, so a reported change has
        // a window to interleave between the guard and its apply.
        const gatedApply = (status: NetworkStatus) =>
          status === "online"
            ? Deferred.succeed(applyStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseApply)),
                Effect.andThen(harness.apply(status)),
              )
            : harness.apply(status);

        yield* Connectivity.followNetworkStatus({
          connectivity: harness.connectivity,
          wakeups: harness.wakeups,
          apply: gatedApply,
        });

        yield* harness.setLiveStatus("online");
        yield* harness.resume.pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.repeat({ until: () => Deferred.isDone(applyStarted) }),
        );

        // The listener reports a newer transition mid-apply.
        yield* harness.report("offline");
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseApply, undefined);
        yield* Effect.yieldNow.pipe(
          Effect.repeat({
            until: () =>
              Ref.get(harness.applied).pipe(Effect.map((statuses) => statuses.length >= 2)),
          }),
        );

        // The reported change has to land last; applying it before the resumed
        // status finished would leave the stale "online" as the final word.
        expect(yield* Ref.get(harness.applied)).toEqual(["online", "offline"]);
      }),
    ),
  );
});

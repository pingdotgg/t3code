import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { awaitLauncherLoss, awaitLauncherStop } from "./launcherWatch.ts";
import { isShutdownIntentRecorded } from "./shutdownIntent.ts";

const launcherPid = 4100;
// Orphans are adopted by init or a subreaper, so the new parent is not always 1.
const subreaperPid = 1800;

const watch = (getParentPid: () => number, platform: NodeJS.Platform, startPid = launcherPid) =>
  awaitLauncherLoss({ launcherPid: startPid, getParentPid }).pipe(
    Effect.provideService(HostProcess.Platform, platform),
  );

it.effect("notices a launcher that was already gone when the watch began", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(watch(() => subreaperPid, "linux"));
    yield* Effect.yieldNow;
    yield* Fiber.join(fiber);
  }),
);

it.effect("keeps ingesting when the stop notice channel breaks", () =>
  Effect.gen(function* () {
    let acknowledged = false;
    const fiber = yield* Effect.forkChild(
      awaitLauncherStop({
        stopNotice: Stream.fail(new Error("EBADF")),
        acknowledge: Effect.sync(() => {
          acknowledged = true;
        }),
      }),
    );
    yield* TestClock.adjust("1 minute");
    assert.isFalse(acknowledged);
    assert.isUndefined(fiber.pollUnsafe());
  }),
);

it.effect("records shutdown intent before acknowledging the desktop's stop notice", () =>
  Effect.gen(function* () {
    const notice = yield* Deferred.make<void>();
    const intentAtAck = yield* Deferred.make<boolean>();
    yield* Effect.forkChild(
      awaitLauncherStop({
        stopNotice: Stream.fromEffectDrain(Deferred.await(notice)),
        acknowledge: Effect.suspend(() =>
          Deferred.succeed(intentAtAck, isShutdownIntentRecorded()),
        ),
      }),
    );
    yield* TestClock.adjust("1 minute");
    assert.isFalse(isShutdownIntentRecorded());

    yield* Deferred.succeed(notice, undefined);
    assert.isTrue(yield* Deferred.await(intentAtAck));
  }),
);

it.effect("shuts down when the desktop stops but never kills the backend", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      awaitLauncherStop({ stopNotice: Stream.empty, acknowledge: Effect.void }),
    );
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(fiber);
  }),
);

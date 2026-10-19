import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { awaitLauncherLoss } from "./launcherWatch.ts";

const launcherPid = 4100;
// Orphans are adopted by init or a subreaper, so the new parent is not always 1.
const subreaperPid = 1800;

const watch = (getParentPid: () => number, platform: NodeJS.Platform, startPid = launcherPid) =>
  awaitLauncherLoss({ launcherPid: startPid, getParentPid }).pipe(
    Effect.provideService(HostProcess.Platform, platform),
  );

it.effect("completes when the parent changes, including to a subreaper", () =>
  Effect.gen(function* () {
    let parentPid = launcherPid;
    const fiber = yield* Effect.forkChild(watch(() => parentPid, "linux"));
    yield* Effect.yieldNow;

    yield* TestClock.adjust("10 seconds");
    assert.isUndefined(fiber.pollUnsafe(), "still watching while the launcher is alive");

    parentPid = subreaperPid;
    yield* TestClock.adjust("2 seconds");
    yield* Fiber.join(fiber);
  }),
);

it.effect("notices a launcher that was already gone when the watch began", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(watch(() => subreaperPid, "linux"));
    yield* Effect.yieldNow;
    yield* Fiber.join(fiber);
  }),
);

it.effect("does not watch a backend that already starts under init", () =>
  Effect.gen(function* () {
    let parentPid = 1;
    const fiber = yield* Effect.forkChild(watch(() => parentPid, "linux", 1));
    yield* Effect.yieldNow;

    parentPid = subreaperPid;
    yield* TestClock.adjust("1 minute");
    assert.isUndefined(fiber.pollUnsafe());
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("does not watch on Windows, where the original parent id outlives the parent", () =>
  Effect.gen(function* () {
    let parentPid = launcherPid;
    const fiber = yield* Effect.forkChild(watch(() => parentPid, "win32"));
    yield* Effect.yieldNow;

    parentPid = subreaperPid;
    yield* TestClock.adjust("1 minute");
    assert.isUndefined(fiber.pollUnsafe());
    yield* Fiber.interrupt(fiber);
  }),
);

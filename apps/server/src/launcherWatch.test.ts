import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { awaitLauncherLoss } from "./launcherWatch.ts";

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

import { assert, describe, it } from "@effect/vitest";
import { DesktopUpdateActionResultSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "../../updates/updatesTestHarness.ts";
import { installUpdate } from "./updates.ts";

describe("update install IPC", () => {
  it.effect.each([
    { expectedVersion: "1.2.4", accepted: false },
    { expectedVersion: "1.2.5", accepted: true },
    { expectedVersion: undefined, accepted: true },
    {
      expectedVersion: { expectedVersion: "1.2.4", continueRunningThreads: true },
      accepted: false,
    },
    { expectedVersion: { expectedVersion: "1.2.5", continueRunningThreads: true }, accepted: true },
    { expectedVersion: { continueRunningThreads: true }, accepted: true },
    {
      expectedVersion: { expectedVersion: "1.2.5", continueRunningThreads: false },
      accepted: true,
    },
    {
      expectedVersion: { expectedVersion: "1.2.4", continueRunningThreads: false },
      accepted: false,
    },
    { expectedVersion: { continueRunningThreads: false }, accepted: true },
  ])("guards the selected version $expectedVersion", ({ expectedVersion, accepted }) => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.5" });
        yield* flushCallbacks;

        const result = yield* installUpdate
          .handler(expectedVersion)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(DesktopUpdateActionResultSchema)));
        assert.equal(result.accepted, accepted);
        assert.equal(harness.quitAndInstalls(), accepted ? 1 : 0);
        assert.equal(
          harness.restartPolicies.length,
          typeof expectedVersion === "object" &&
            expectedVersion.continueRunningThreads === false &&
            accepted
            ? 1
            : 0,
        );
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});

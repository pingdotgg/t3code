import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

function makeRuntimeLayer(input: {
  readonly events: string[];
  readonly shutdownFailure?: Error;
  readonly exitFailure?: Error;
}) {
  return Layer.mergeAll(
    DesktopState.layer,
    Layer.succeed(
      DesktopEnvironment.DesktopEnvironment,
      DesktopEnvironment.DesktopEnvironment.of({
        isDevelopment: false,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
    Layer.succeed(
      DesktopShutdown.DesktopShutdown,
      DesktopShutdown.DesktopShutdown.of({
        request: Effect.sync(() => {
          input.events.push("shutdown-requested");
        }),
        awaitComplete: input.shutdownFailure
          ? Effect.die(input.shutdownFailure)
          : Effect.sync(() => {
              input.events.push("shutdown-complete");
            }),
      } as unknown as DesktopShutdown.DesktopShutdown["Service"]),
    ),
    Layer.succeed(
      DesktopWindow.DesktopWindow,
      DesktopWindow.DesktopWindow.of({
        flushMainWindowBounds: Effect.void,
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
    Layer.succeed(
      ElectronApp.ElectronApp,
      ElectronApp.ElectronApp.of({
        relaunch: () =>
          Effect.sync(() => {
            input.events.push("relaunch-scheduled");
          }),
        exit: () =>
          input.exitFailure
            ? Effect.die(input.exitFailure)
            : Effect.sync(() => {
                input.events.push("exit");
              }),
      } as unknown as ElectronApp.ElectronApp["Service"]),
    ),
    Layer.succeed(
      ElectronTheme.ElectronTheme,
      ElectronTheme.ElectronTheme.of({} as ElectronTheme.ElectronTheme["Service"]),
    ),
  );
}

describe("DesktopLifecycle.relaunch", () => {
  it.effect("surfaces shutdown failures after scheduling the replacement process", () => {
    const shutdownFailure = new Error("shutdown failed");
    const events: string[] = [];

    return Effect.gen(function* () {
      const error = yield* DesktopLifecycle.make
        .relaunch("backendMode=client-only")
        .pipe(Effect.flip);

      assert.instanceOf(error, DesktopLifecycle.DesktopLifecycleRelaunchError);
      assert.strictEqual(Cause.squash(error.cause as Cause.Cause<unknown>), shutdownFailure);
      assert.deepEqual(events, ["relaunch-scheduled", "shutdown-requested"]);
    }).pipe(Effect.provide(makeRuntimeLayer({ events, shutdownFailure })));
  });

  it.effect("surfaces exit failures instead of completing the relaunch early", () => {
    const exitFailure = new Error("exit failed");
    const events: string[] = [];

    return Effect.gen(function* () {
      const error = yield* DesktopLifecycle.make
        .relaunch("backendMode=client-only")
        .pipe(Effect.flip);

      assert.instanceOf(error, DesktopLifecycle.DesktopLifecycleRelaunchError);
      assert.strictEqual(Cause.squash(error.cause as Cause.Cause<unknown>), exitFailure);
      assert.deepEqual(events, ["relaunch-scheduled", "shutdown-requested", "shutdown-complete"]);
    }).pipe(Effect.provide(makeRuntimeLayer({ events, exitFailure })));
  });
});

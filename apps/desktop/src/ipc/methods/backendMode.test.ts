import { DesktopBackendModeStateSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopBackendMode from "../../app/DesktopBackendMode.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import { setBackendMode } from "./backendMode.ts";

const decodeBackendModeState = Schema.decodeUnknownEffect(DesktopBackendModeStateSchema);

const unusedLifecycleRuntimeLayer =
  Layer.empty as Layer.Layer<DesktopLifecycle.DesktopLifecycleRuntimeServices>;

describe("backend mode IPC", () => {
  it.effect("reports the saved mode while a successful relaunch is pending", () => {
    const relaunchReasons: Array<string> = [];
    const layer = Layer.mergeAll(
      DesktopBackendMode.layerTest(),
      DesktopAppSettings.layerTest(),
      Layer.succeed(
        DesktopLifecycle.DesktopLifecycle,
        DesktopLifecycle.DesktopLifecycle.of({
          relaunch: (reason) => Effect.sync(() => relaunchReasons.push(reason)),
          register: Effect.void,
        }),
      ),
      unusedLifecycleRuntimeLayer,
    );

    return Effect.gen(function* () {
      const launchMode = yield* DesktopBackendMode.DesktopBackendMode;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      yield* launchMode.latch("managed");

      const state = yield* setBackendMode
        .handler("client-only")
        .pipe(Effect.flatMap(decodeBackendModeState));

      assert.deepEqual(state, {
        effectiveMode: "managed",
        configuredMode: "client-only",
        cliOverride: null,
      });
      assert.deepEqual(relaunchReasons, ["backendMode=client-only"]);
      assert.equal((yield* settings.get).backendMode, "client-only");
    }).pipe(Effect.provide(layer));
  });

  it.effect("restores the configured mode when a packaged relaunch cannot be scheduled", () => {
    const relaunchError = new DesktopLifecycle.DesktopLifecycleRelaunchError({
      reason: "backendMode=client-only",
      cause: Cause.die(new Error("relaunch failed")),
    });
    const layer = Layer.mergeAll(
      DesktopBackendMode.layerTest(),
      DesktopAppSettings.layerTest(),
      Layer.succeed(
        DesktopLifecycle.DesktopLifecycle,
        DesktopLifecycle.DesktopLifecycle.of({
          relaunch: () => Effect.fail(relaunchError),
          register: Effect.void,
        }),
      ),
      unusedLifecycleRuntimeLayer,
    );

    return Effect.gen(function* () {
      const launchMode = yield* DesktopBackendMode.DesktopBackendMode;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      yield* launchMode.latch("managed");
      const error = yield* setBackendMode
        .handler("client-only")
        .pipe(Effect.flatMap(decodeBackendModeState), Effect.flip);

      assert.strictEqual(error, relaunchError);
      assert.equal((yield* settings.get).backendMode, "managed");
    }).pipe(Effect.provide(layer));
  });
});

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

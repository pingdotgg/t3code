import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("external desktop installation", () => {
  it.effect("preserves the update workflow with an external macOS installer configured", () => {
    const harness = makeHarness({
      env: {
        T3CODE_DISABLE_AUTO_UPDATE: "false",
        T3CODE_DESKTOP_UPDATE_INSTALLER: "/opt/t3/install-macos-update.sh",
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.isTrue((yield* updates.getState).enabled);
        assert.isTrue((yield* updates.check("manual")).checked);
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* updates.download;
        harness.emit("download-progress", { percent: 50 });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).downloadPercent, 50);
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.isTrue((yield* updates.install).accepted);
        assert.equal(harness.downloadCount(), 1);
        assert.equal(harness.quitAndInstalls(), 1);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect.each(["darwin", "linux", "win32"] as const)(
    "honors the explicit disable flag on %s even with an external installer configured",
    (platform) => {
      const harness = makeHarness({
        platform,
        env: {
          T3CODE_DISABLE_AUTO_UPDATE: "true",
          T3CODE_DESKTOP_UPDATE_INSTALLER: "/opt/t3/install-macos-update.sh",
        },
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.isFalse((yield* updates.getState).enabled);
          assert.isFalse((yield* updates.check("manual")).checked);
          assert.equal(harness.checkCount(), 0);
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );
});

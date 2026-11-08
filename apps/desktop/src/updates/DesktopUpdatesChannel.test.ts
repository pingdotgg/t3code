import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates", () => {
  it.effect("rejects a prepared install when the downloaded version changed", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.5" });
        yield* flushCallbacks;

        const result = yield* updates.installPrepared("1.2.4");
        assert.isFalse(result.accepted);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("persists channel changes through the settings service", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("nightly");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "nightly");
        assert.equal(persistedSettings.updateChannel, "nightly");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, true);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("ignores a finished download from a track it no longer follows", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        // A backed-out switch's download keeps reporting progress until it finishes.
        harness.emit("download-progress", { percent: 40 });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4-nightly.20261027.1" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.downloadedVersion, null);
        assert.notEqual(state.status, "downloading");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("offers older releases only to checks that leave the running build's track", () => {
    const harness = makeHarness({ beforeSetUpdateChannel: Effect.void });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const before = harness.checkAllowedDowngrade.length;
        yield* updates.setChannel("nightly");
        yield* updates.setChannel("latest");
        yield* updates.check("remote-update", { allowDowngrade: true });

        // Back on its own Stable track the build never needs an older release.
        assert.deepEqual(harness.checkAllowedDowngrade.slice(before), [true, false, true]);
        assert.isFalse(harness.allowDowngrade());
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("re-checks a saved track that differs from the running build's track", () => {
    const harness = makeHarness({
      appVersion: "1.2.4-nightly.20261027.1",
      beforeSetUpdateChannel: Effect.void,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("latest");
        const checks = harness.checkCount();

        yield* updates.setChannel("latest");

        assert.equal(harness.checkCount(), checks + 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not persist an unchanged update channel as a user preference", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("latest");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "latest");
        assert.equal(persistedSettings.updateChannel, "latest");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, false);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("offers nothing below a track switch's checked release", () => {
    const harness = makeHarness({
      appVersion: "1.2.4-nightly.20261027.1",
      beforeSetUpdateChannel: Effect.void,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("latest", { minimumVersion: "1.2.3" });

        harness.emit("update-available", { version: "1.2.2" });
        yield* flushCallbacks;
        assert.isNull((yield* updates.getState).availableVersion);
        harness.emit("update-downloaded", { version: "1.2.2" });
        yield* flushCallbacks;
        assert.isNull((yield* updates.getState).downloadedVersion);

        harness.emit("update-available", { version: "1.2.3" });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).availableVersion, "1.2.3");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps a saved Stable track across a restart without offering an older release", () => {
    // A Nightly build whose switch to Stable did not finish before the app quit.
    const harness = makeHarness({ appVersion: "1.2.4-nightly.20261027.1", savedChannel: "latest" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("startup");

        assert.equal((yield* updates.getState).channel, "latest");
        assert.deepEqual(harness.checkAllowedDowngrade, [false]);
        // Semver ranks Stable 1.2.4 above this Nightly, but a Nightly built before the release's
        // version bump can hold migrations 1.2.4 lacks. Crossing needs a guarded switch.
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.isNull((yield* updates.getState).availableVersion);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps a saved Nightly track across a restart without crossing on its own", () => {
    // A Stable build whose switch to Nightly was refused before the app quit; its floor is gone.
    const harness = makeHarness({ savedChannel: "nightly" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("startup");
        harness.emit("update-available", { version: "1.2.4-nightly.20261027.1" });
        yield* flushCallbacks;

        assert.equal((yield* updates.getState).channel, "nightly");
        assert.isNull((yield* updates.getState).availableVersion);
        assert.deepEqual(harness.checkAllowedDowngrade, [false]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("never offers an older Nightly to a Nightly build's own checks", () => {
    const harness = makeHarness({ appVersion: "1.2.4-nightly.20261027.1" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("poll");

        assert.equal((yield* updates.getState).channel, "nightly");
        assert.deepEqual(harness.checkAllowedDowngrade, [false]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("waits out a background check instead of refusing a track change", () =>
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const harness = makeHarness({
        beforeSetUpdateChannel: Effect.void,
        checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheck)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.check("poll").pipe(Effect.forkScoped);
          yield* Deferred.await(checkStarted);

          const channelFiber = yield* updates.setChannel("nightly").pipe(Effect.forkScoped);
          yield* Deferred.succeed(releaseCheck, undefined);
          yield* TestClock.adjust(Duration.seconds(2));
          const state = yield* Fiber.join(channelFiber);

          assert.equal(state.channel, "nightly");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("rejects checks while an update channel change is being persisted", () =>
    Effect.gen(function* () {
      const channelChangeStarted = yield* Deferred.make<void>();
      const releaseChannelChange = yield* Deferred.make<void>();
      const harness = makeHarness({
        beforeSetUpdateChannel: Deferred.succeed(channelChangeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseChannelChange)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const channelFiber = yield* updates.setChannel("nightly").pipe(Effect.forkScoped);
          yield* Deferred.await(channelChangeStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseChannelChange, undefined);
          const state = yield* Fiber.join(channelFiber);

          assert.equal(state.channel, "nightly");
          assert.equal(harness.checkCount(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );
});

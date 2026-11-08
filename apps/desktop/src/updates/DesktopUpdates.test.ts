import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates", () => {
  it.effect("updates Linux .deb installs and leaves other non-AppImage installs off", () =>
    Effect.gen(function* () {
      const linuxState = (packageType: string | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            return yield* updates.getState;
          }),
        ).pipe(Effect.provide(makeHarness({ platform: "linux", packageType }).layer));

      const deb = yield* linuxState("deb\n");
      assert.equal(deb.status, "idle");

      const unmarked = yield* linuxState(undefined);
      assert.equal(unmarked.status, "disabled");
    }),
  );

  it.effect("keeps the disabled reason available after configuration and channel changes", () => {
    const harness = makeHarness({ env: { T3CODE_DISABLE_AUTO_UPDATE: "true" } });
    const reason = "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const configured = yield* updates.getState;
        assert.equal(configured.message, reason);

        const changed = yield* updates.setChannel("nightly");
        assert.equal(changed.channel, "nightly");
        assert.equal(changed.enabled, false);
        assert.equal(changed.status, "disabled");
        assert.equal(changed.message, reason);
        assert.equal(harness.sentStates.at(-1)?.message, reason);
        assert.equal(harness.checkCount(), 0);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("checks for newer releases after an update has been downloaded", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.check("poll");
        assert.isTrue(result.checked);

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const unchangedState = yield* updates.getState;
        assert.equal(unchangedState.status, "downloaded");
        assert.equal(unchangedState.downloadedVersion, "1.2.4");
        assert.deepEqual(unchangedState.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(unchangedState.omittedReleaseCount, 0);

        const nextResult = yield* updates.check("poll");
        assert.isTrue(nextResult.checked);

        harness.emit("update-available", { version: "1.2.5" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.5");
        assert.isNull(state.downloadedVersion);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("preserves a queued installer when the feed has no update", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.check("poll");
        harness.emit("update-not-available");
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.availableVersion, "1.2.4");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.deepEqual(state.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(state.omittedReleaseCount, 0);
        assert.equal(state.downloadPercent, 100);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect(
    "rejects install while a refresh check is in progress and releases the reservation",
    () =>
      Effect.gen(function* () {
        const checkStarted = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const harness = makeHarness({
          checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCheck)),
          ),
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* flushCallbacks;

            const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
            yield* Deferred.await(checkStarted);

            const installResult = yield* updates.install;
            assert.isFalse(installResult.accepted);

            yield* Deferred.succeed(releaseCheck, undefined);
            const checkResult = yield* Fiber.join(checkFiber);
            assert.isTrue(checkResult.checked);

            const followUpCheck = yield* updates.check("manual");
            assert.isTrue(followUpCheck.checked);
            assert.equal(harness.checkCount(), 2);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );

  it.effect("rejects refresh checks while install is in progress", () =>
    Effect.gen(function* () {
      const installStarted = yield* Deferred.make<void>();
      const releaseInstall = yield* Deferred.make<void>();
      const harness = makeHarness({
        stopBackend: Deferred.succeed(installStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInstall)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(installStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseInstall, undefined);
          const installResult = yield* Fiber.join(installFiber);
          assert.isTrue(installResult.accepted);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("preserves a queued installer after a background updater error", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        harness.emit("error", new Error("background updater failure"));
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "error");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.isNull(state.errorContext);

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("logs the redacted cause of a rejected update check", () => {
    const cause = Object.assign(
      new Error("request failed for https://user:secret@example.com/update?token=secret"),
      { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" },
    );
    const updaterError = new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
      channel: null,
      cause,
    });
    const harness = makeHarness({ checkForUpdates: Effect.fail(updaterError) });
    const loggedAnnotations: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      if (annotations.errorTag === "ElectronUpdaterCheckForUpdatesError") {
        loggedAnnotations.push(annotations);
      }
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.check("manual");

        const state = yield* updates.getState;
        const loggedAnnotation = loggedAnnotations.at(-1);
        assert.isDefined(loggedAnnotation);
        assert.equal(loggedAnnotation.errorTag, "ElectronUpdaterCheckForUpdatesError");
        assert.isNull(loggedAnnotation.channel);
        assert.equal(
          loggedAnnotation.cause,
          "Error [ERR_UPDATER_LATEST_VERSION_NOT_FOUND]: request failed for [redacted URL]",
        );
        assert.notProperty(loggedAnnotation, "error");
        assert.notInclude(Object.values(loggedAnnotation).map(String).join(" "), "secret");
        assert.equal(
          state.message,
          "Electron updater failed to check for updates on channel default.",
        );
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          harness.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("recovers download state after an unexpected setup failure", () => {
    let disableDifferentialCalls = 0;
    const harness = makeHarness({
      setDisableDifferentialDownload: Effect.suspend(() => {
        disableDifferentialCalls += 1;
        return disableDifferentialCalls === 1
          ? Effect.void
          : Effect.die(new Error("download setup failed"));
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "available");
        assert.equal(failedState.errorContext, "download");
        assert.equal(failedState.message, "Desktop update download action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores download state and permits retry after interruption", () =>
    Effect.gen(function* () {
      const actionStarted = yield* Deferred.make<void>();
      let disableDifferentialCalls = 0;
      const harness = makeHarness({
        setDisableDifferentialDownload: Effect.suspend(() => {
          disableDifferentialCalls += 1;
          if (disableDifferentialCalls === 1) {
            return Effect.void;
          }
          if (disableDifferentialCalls === 2) {
            return Deferred.succeed(actionStarted, undefined).pipe(Effect.andThen(Effect.never));
          }
          return Effect.void;
        }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;

          const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
          yield* Deferred.await(actionStarted);
          yield* Fiber.interrupt(downloadFiber);

          const interruptedState = yield* updates.getState;
          assert.equal(interruptedState.status, "available");
          assert.isNull(interruptedState.message);

          const retry = yield* updates.download;
          assert.isTrue(retry.accepted);
          assert.isTrue(retry.completed);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );
});

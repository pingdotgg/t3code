import { assert, describe, it } from "@effect/vitest";
import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
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

  it.effect("clears quitting state after an unexpected install setup failure", () => {
    const harness = makeHarness({
      stopBackend: Effect.die(new Error("backend stop failed")),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);
        assert.isFalse(yield* Ref.get(desktopState.quitting));

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "downloaded");
        assert.equal(failedState.errorContext, "install");
        assert.equal(failedState.message, "Desktop update install action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("marks the backend stop for an install as an update restart", () => {
    let markersAtStop: ReadonlyArray<string> = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        markersAtStop = [...harness.updateRestartMarkers];
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.isTrue((yield* updates.install).accepted);
        assert.deepEqual(markersAtStop, [
          environment.path.join(environment.baseDir, "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE),
        ]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("records the version an install hands to the installer", () => {
    let recordsAtStop: ReadonlyArray<string> = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        recordsAtStop = [...harness.installRecords.values()];
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.isTrue((yield* updates.install).accepted);
        assert.deepEqual(
          recordsAtStop.map((record) => JSON.parse(record)),
          [{ fromVersion: "1.2.3", targetVersion: "1.2.4" }],
        );
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("flags an install that did not apply and keeps the flag through checks", () => {
    const harness = makeHarness({
      installRecord: JSON.stringify({ fromVersion: "1.2.3", targetVersion: "1.2.4" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.getState).notAppliedVersion, "1.2.4");
        assert.isDefined(harness.previousInstallRecord());

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.notAppliedVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  // regression: #19291 an install that did apply was still flagged as not applied
  it.effect("does not flag an install that applied", () => {
    const harness = makeHarness({
      installRecord: JSON.stringify({ fromVersion: "1.2.2", targetVersion: "1.2.3" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.isUndefined((yield* updates.getState).notAppliedVersion);
        assert.isUndefined(harness.previousInstallRecord());
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("drops the update restart marker when an install is interrupted", () =>
    Effect.gen(function* () {
      const stopping = yield* Deferred.make<void>();
      const harness = makeHarness({
        stopBackend: Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Effect.never)),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(stopping);
          assert.equal(harness.updateRestartMarkers.size, 1);

          yield* Fiber.interrupt(installFiber);
          assert.equal(harness.updateRestartMarkers.size, 0);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect.each([true, undefined])("preserves update restart preferences for %s", (choice) => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.isTrue((yield* updates.installPrepared("1.2.4", choice)).accepted);
        assert.deepEqual(harness.restartPolicies, []);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("requires every backend to acknowledge OFF before any backend stops", () =>
    Effect.gen(function* () {
      const preparing = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<boolean>();
      const stopped: string[] = [];
      const instances = [
        DesktopBackendPool.PRIMARY_INSTANCE_ID,
        DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
      ].map((id, index) => ({
        id,
        label: Effect.succeed(id),
        start: Effect.void,
        stop: () =>
          Effect.sync(() => {
            stopped.push(id);
          }),
        currentConfig: Effect.succeedNone,
        snapshot: Effect.succeed({
          desiredRunning: true,
          ready: index === 0,
          activePid: Option.some(123 + index),
          restartAttempt: 0,
          restartScheduled: false,
        }),
        waitForReady: () => Effect.succeed(true),
      }));
      const harness = makeHarness({
        backendInstances: instances,
        requestUpdateRestartPolicy: () =>
          Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const installing = yield* updates.installPrepared("1.2.4", false).pipe(Effect.forkScoped);
          yield* Deferred.await(preparing);
          assert.deepEqual(stopped, []);
          assert.equal(harness.quitAndInstalls(), 0);
          assert.sameMembers(
            [...harness.restartPolicies[0]!.sourceIds],
            instances.map((instance) => instance.id),
          );
          yield* Deferred.succeed(accepted, true);
          assert.isTrue((yield* Fiber.join(installing)).accepted);
          assert.sameMembers(
            stopped,
            instances.map((instance) => instance.id),
          );
          assert.deepEqual(harness.clearedRestartPolicies, [
            harness.restartPolicies[0]!.policy.requestId,
          ]);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("disarms untouched backends when OFF preparation is refused", () => {
    const harness = makeHarness({
      requestUpdateRestartPolicy: (_sourceIds, policy) =>
        Effect.succeed(policy.continueRunningThreads),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const desktopState = yield* DesktopState.DesktopState;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        const result = yield* updates.installPrepared("1.2.4", false);
        assert.isTrue(result.failed);
        assert.equal(
          result.state.message,
          "Every running backend must accept the desktop update restart policy before installing.",
        );
        assert.equal(harness.quitAndInstalls(), 0);
        assert.deepEqual(
          harness.restartPolicies.map(({ policy }) => policy.continueRunningThreads),
          [false, true],
        );
        assert.equal(
          harness.restartPolicies[0]!.policy.requestId,
          harness.restartPolicies[1]!.policy.requestId,
        );
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installSteps, []);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect.each([true, false, undefined])(
    "retries a refused rollback before another install with continuation %s",
    (choice) =>
      Effect.gen(function* () {
        const retrying = yield* Deferred.make<void>();
        const accepted = yield* Deferred.make<boolean>();
        let acceptRetry = false;
        let stops = 0;
        const harness = makeHarness({
          stopBackend: Effect.sync(() => {
            stops += 1;
          }),
          requestUpdateRestartPolicy: (_sourceIds, policy) =>
            acceptRetry && policy.continueRunningThreads
              ? Deferred.succeed(retrying, undefined).pipe(Effect.andThen(Deferred.await(accepted)))
              : Effect.succeed(acceptRetry),
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            const desktopState = yield* DesktopState.DesktopState;
            yield* updates.configure;
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* flushCallbacks;

            assert.isTrue((yield* updates.installPrepared("1.2.4", false)).failed);
            const requestId = harness.restartPolicies[0]!.policy.requestId;
            assert.deepEqual(harness.clearedRestartPolicies, []);

            for (let attempt = 0; attempt < 2; attempt += 1) {
              const result = yield* updates.installPrepared("1.2.4", choice);
              assert.isTrue(result.failed);
              assert.equal(
                result.state.message,
                "Could not clear the previous desktop update restart policy. Try again.",
              );
              assert.isFalse(yield* Ref.get(desktopState.quitting));
              assert.equal(stops, 0);
              assert.equal(harness.quitAndInstalls(), 0);
              assert.deepEqual(harness.clearedRestartPolicies, []);
              assert.deepEqual(
                harness.restartPolicies.map(({ policy }) => policy.continueRunningThreads),
                [false, ...Array<boolean>(attempt + 2).fill(true)],
              );
              assert.isTrue(
                harness.restartPolicies.every(({ policy }) => policy.requestId === requestId),
              );
            }

            acceptRetry = true;
            const installing = yield* updates
              .installPrepared("1.2.4", choice)
              .pipe(Effect.forkScoped);
            yield* Deferred.await(retrying);
            assert.equal(stops, 0);
            assert.equal(harness.quitAndInstalls(), 0);
            assert.deepEqual(harness.clearedRestartPolicies, []);

            yield* Deferred.succeed(accepted, true);
            const result = yield* Fiber.join(installing);
            assert.isTrue(result.accepted);
            assert.isFalse(result.failed);
            assert.equal(stops, 1);
            assert.equal(harness.quitAndInstalls(), 1);
            assert.equal(harness.clearedRestartPolicies[0], requestId);
            assert.deepEqual(
              harness.restartPolicies.map(({ policy }) => policy.continueRunningThreads),
              choice === false
                ? [false, true, true, true, true, false]
                : [false, true, true, true, true],
            );
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );

  it.effect.each(["removed", "replaced", "remaining"] as const)(
    "reconciles a refused rollback with current backend instances: %s",
    (state) => {
      const stopped: string[] = [];
      let acceptRollback = false;
      const original: DesktopBackendPool.DesktopBackendInstance = {
        id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
        label: Effect.succeed("WSL (Ubuntu)"),
        start: Effect.void,
        stop: () =>
          Effect.sync(() => {
            stopped.push("original");
          }),
        currentConfig: Effect.succeedNone,
        snapshot: Effect.succeed({
          desiredRunning: true,
          ready: true,
          activePid: Option.some(123),
          restartAttempt: 0,
          restartScheduled: false,
        }),
        waitForReady: () => Effect.succeed(true),
      };
      const primary = {
        ...original,
        id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
        stop: () =>
          Effect.sync(() => {
            stopped.push("primary");
          }),
        snapshot: Effect.succeed({
          desiredRunning: state === "remaining",
          ready: state === "remaining",
          activePid: state === "remaining" ? Option.some(456) : Option.none<number>(),
          restartAttempt: 0,
          restartScheduled: false,
        }),
      };
      const replacement = {
        ...original,
        stop: () =>
          Effect.sync(() => {
            stopped.push("replacement");
          }),
      };
      let currentInstances = [primary, original];
      const harness = makeHarness({
        backendInstances: currentInstances,
        backendList: Effect.sync(() => currentInstances),
        requestUpdateRestartPolicy: () => Effect.sync(() => acceptRollback),
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          const desktopState = yield* DesktopState.DesktopState;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          assert.isTrue((yield* updates.installPrepared("1.2.4", false)).failed);
          const requestId = harness.restartPolicies[0]!.policy.requestId;
          assert.equal(harness.restartPolicies.length, 2);
          assert.deepEqual(harness.clearedRestartPolicies, []);
          assert.deepEqual(stopped, []);

          currentInstances = state === "replaced" ? [primary, replacement] : [primary];
          const result = yield* updates.installPrepared("1.2.4", true);
          if (state === "remaining") {
            assert.isTrue(result.failed);
            assert.equal(
              result.state.message,
              "Could not clear the previous desktop update restart policy. Try again.",
            );
            assert.isFalse(yield* Ref.get(desktopState.quitting));
            assert.deepEqual(stopped, []);
            assert.equal(harness.quitAndInstalls(), 0);
            assert.deepEqual(harness.clearedRestartPolicies, []);
            assert.deepEqual(harness.restartPolicies[2]!.sourceIds, [primary.id]);
            acceptRollback = true;
            assert.isFalse((yield* updates.installPrepared("1.2.4", true)).failed);
            assert.deepEqual(harness.restartPolicies[3]!.sourceIds, [primary.id]);
          } else {
            assert.isTrue(result.accepted);
            assert.isFalse(result.failed);
            assert.equal(harness.restartPolicies.length, 2);
          }
          assert.equal(harness.quitAndInstalls(), 1);
          assert.deepEqual(
            stopped,
            state === "replaced" ? ["primary", "replacement"] : ["primary"],
          );
          assert.deepEqual(harness.clearedRestartPolicies, [requestId]);
          assert.isTrue(
            harness.restartPolicies.every(({ policy }) => policy.requestId === requestId),
          );
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

  it.effect(
    "skips policy for an already stopped backend and refuses a stale selected version",
    () => {
      const harness = makeHarness({ backendDesiredRunning: false });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          assert.isFalse((yield* updates.installPrepared("1.2.3", false)).accepted);
          assert.isTrue((yield* updates.installPrepared("1.2.4", false)).accepted);
          assert.deepEqual(harness.restartPolicies, []);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

  it.effect.each(["changed", "missing", "membership"] as const)(
    "refuses OFF when backend state changes: %s",
    (state) => {
      let pid = state === "missing" ? Option.none<number>() : Option.some(123);
      let stops = 0;
      let prepared = false;
      const instance: DesktopBackendPool.DesktopBackendInstance = {
        id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
        label: Effect.succeed("Windows"),
        start: Effect.void,
        stop: () =>
          Effect.sync(() => {
            stops += 1;
          }),
        currentConfig: Effect.succeedNone,
        snapshot: Effect.sync(() => ({
          desiredRunning: true,
          ready: true,
          activePid: pid,
          restartAttempt: 0,
          restartScheduled: false,
        })),
        waitForReady: () => Effect.succeed(true),
      };
      const harness = makeHarness({
        backendInstances: [instance],
        backendList: Effect.sync(() =>
          state === "membership" && prepared
            ? [instance, { ...instance, id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu") }]
            : [instance],
        ),
        requestUpdateRestartPolicy: () =>
          Effect.sync(() => {
            prepared = true;
            if (state === "changed") pid = Option.some(456);
            return true;
          }),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const result = yield* updates.installPrepared("1.2.4", false);
          assert.isTrue(result.failed);
          assert.equal(
            result.state.message,
            state === "missing"
              ? "Wait for every desktop backend to start before disabling thread continuation."
              : state === "membership"
                ? "Desktop backends changed while preparing the update. Try again."
                : "A desktop backend restarted while preparing the update. Try again.",
          );
          assert.equal(stops, 0);
          assert.equal(harness.quitAndInstalls(), 0);
          assert.deepEqual(
            harness.restartPolicies.map(({ policy }) => policy.continueRunningThreads),
            state === "missing" ? [] : [false, true],
          );
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

  it.effect("keeps OFF for stopped backends when the native installer throws", () => {
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.isTrue((yield* updates.installPrepared("1.2.4", false)).failed);
        assert.deepEqual(
          harness.restartPolicies.map(({ policy }) => policy.continueRunningThreads),
          [false],
        );
        assert.deepEqual(harness.clearedRestartPolicies, [
          harness.restartPolicies[0]!.policy.requestId,
        ]);
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps windows and restarts backends when quitAndInstall fails", () => {
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);
        assert.equal(harness.updateRestartMarkers.size, 0);
        assert.equal(harness.installRecords.size, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps the disabled primary stopped when quitAndInstall fails", () => {
    const harness = makeHarness({
      backendDesiredRunning: false,
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.equal(result.state.errorContext, "install");
        assert.deepEqual(harness.installSteps, ["quitAndInstall"]);
        assert.isFalse((yield* (yield* pool.primary).snapshot).desiredRunning);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores only desired-running instances after an installer error event", () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const makeInstance = (id: DesktopBackendPool.BackendInstanceId, initiallyRunning: boolean) => {
      let desiredRunning = initiallyRunning;
      return {
        id,
        label: Effect.succeed(id),
        currentConfig: Effect.succeedNone,
        start: Effect.sync(() => {
          starts.push(id);
          desiredRunning = true;
        }),
        stop: () =>
          Effect.sync(() => {
            stops.push(id);
            desiredRunning = false;
          }),
        snapshot: Effect.sync(() => ({
          desiredRunning,
          ready: false,
          activePid: Option.none(),
          restartAttempt: 0,
          restartScheduled: false,
        })),
        waitForReady: () => Effect.succeed(true),
      } satisfies DesktopBackendPool.DesktopBackendInstance;
    };
    const primary = makeInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, false);
    const wsl = makeInstance(DesktopBackendPool.BackendInstanceId("wsl:default"), true);
    const harness = makeHarness({ backendInstances: [primary, wsl] });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.install;
        assert.sameMembers(stops, [primary.id, wsl.id]);
        assert.isFalse((yield* wsl.snapshot).desiredRunning);
        const { changes } = yield* updates.subscribe;
        const recovered = yield* Stream.runHead(changes).pipe(Effect.forkChild);
        yield* flushCallbacks;
        harness.emit("error", new Error("native installer refused"));
        assert.equal(Option.getOrThrow(yield* Fiber.join(recovered)).errorContext, "install");

        assert.deepEqual(starts, [wsl.id]);
        assert.isFalse((yield* primary.snapshot).desiredRunning);
        assert.isTrue((yield* wsl.snapshot).desiredRunning);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("holds the install reservation until failed-install recovery finishes", () => {
    const recoveryStarted = Deferred.makeUnsafe<void>();
    const releaseRecovery = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
      startBackend: Deferred.succeed(recoveryStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRecovery)),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const failedInstall = yield* updates.install.pipe(Effect.forkChild);
        yield* Deferred.await(recoveryStarted);
        assert.isFalse(yield* updates.isInstallActive);

        const overlappingInstall = yield* updates.install;
        assert.isFalse(overlappingInstall.accepted);
        assert.equal(harness.quitAndInstalls(), 1);
        harness.emit("error", new Error("duplicate native installer error"));
        yield* flushCallbacks;
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);

        yield* Deferred.succeed(releaseRecovery, undefined);
        const failedResult = yield* Fiber.join(failedInstall);
        assert.equal(failedResult.state.errorContext, "install");

        const retry = yield* updates.install;
        assert.isTrue(retry.accepted);
        assert.equal(harness.quitAndInstalls(), 2);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

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

describe("describeUpdateErrorCause", () => {
  it("removes URLs, credentials, response bodies, and headers from summaries", () => {
    const messages = [
      "Cannot download https://user:url-secret@example.com/update?token=query-secret, status 403",
      "Request failed: Bearer bearer-secret",
      "Request failed: Basic basic-secret",
      "Request failed: Authorization: Bearer header-secret",
      "Request failed: Cookie=session-secret",
      "Request failed: api_key=\"key-secret\" password='password-secret' access_token=token-secret",
      '404 Not Found\n{"body":"body-secret"}\nHeaders: cookie=header-secret',
      "Request failed\rHeaders: cookie=header-secret",
    ];

    for (const message of messages) {
      const summary = DesktopUpdates.describeUpdateErrorCause(new Error(message));
      assert.include(summary, "Error:");
      assert.notInclude(summary, "secret");
      assert.notInclude(summary, "https://");
      assert.notInclude(summary, "Headers:");
    }
    assert.equal(
      DesktopUpdates.describeUpdateErrorCause("404 Not Found\nbody-secret"),
      "404 Not Found",
    );
  });

  it("bounds long messages, parallel failures, and cyclic causes", () => {
    const longError = new Error("x".repeat(10_000));
    const parallel = Cause.combine(Cause.fail(longError), Cause.die(longError));
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(parallel).length, 1024);

    const cyclic = new Error("retry failed");
    cyclic.cause = cyclic;
    assert.include(DesktopUpdates.describeUpdateErrorCause(cyclic), "[truncated cause]");
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(cyclic).length, 1024);
  });

  it("does not serialize arbitrary payloads or let unreadable errors break logging", () => {
    assert.equal(DesktopUpdates.describeUpdateErrorCause({ payload: "secret" }), "object");
    const unreadable = Object.defineProperty({}, "message", {
      get() {
        throw new Error("unreadable error");
      },
    });
    assert.equal(DesktopUpdates.describeUpdateErrorCause(unreadable), "UnknownError");
  });
});

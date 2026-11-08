import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates", () => {
  it.effect.each(["ordinary", "confirmed", "unconfirmed", "mixed", "interrupted"] as const)(
    "handles %s installer termination without unsafe recovery",
    (mode) => {
      const unsafe = !["ordinary", "confirmed"].includes(mode);
      const ordinary = new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
        channel: "latest",
        isSilent: true,
        isForceRunAfter: true,
        cause: new Error("installer refused"),
      });
      const error = new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
        channel: "latest",
        isSilent: true,
        isForceRunAfter: true,
        terminationConfirmed: !unsafe,
        cause: new Error("helper exit unconfirmed"),
      });
      const failure =
        mode === "ordinary"
          ? Effect.fail(ordinary)
          : mode === "confirmed"
            ? Effect.fail(error)
            : mode === "unconfirmed"
              ? Effect.die(error)
              : (mode === "mixed" ? Effect.fail(ordinary) : Effect.interrupt).pipe(
                  Effect.ensuring(Effect.die(error)),
                );
      const cleanupStarted = Deferred.makeUnsafe<void>();
      const releaseCleanup = Deferred.makeUnsafe<void>();
      const harness = makeHarness({
        env: { T3CODE_DESKTOP_UPDATE_INSTALLER: "/test/installer" },
        quitAndInstall: Deferred.succeed(cleanupStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCleanup)),
          Effect.andThen(failure),
        ),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const desktopState = yield* DesktopState.DesktopState;
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const installing = yield* updates.install.pipe(Effect.forkChild);
          yield* Deferred.await(cleanupStarted);
          harness.emit("error", new Error("updater error during cleanup"));
          yield* flushCallbacks;
          assert.deepEqual(harness.installSteps, ["quitAndInstall"]);
          assert.equal(harness.updateRestartMarkers.size, 1);
          assert.equal(harness.installRecords.size, 1);
          assert.isFalse((yield* updates.install).accepted);
          yield* Deferred.succeed(releaseCleanup, undefined);
          const result = yield* Fiber.join(installing);
          assert.isTrue(result.accepted);
          assert.isFalse(yield* Ref.get(desktopState.quitting));
          assert.deepEqual(
            harness.installSteps,
            unsafe ? ["quitAndInstall"] : ["quitAndInstall", "startBackend"],
          );
          assert.equal(harness.updateRestartMarkers.size, unsafe ? 1 : 0);
          assert.equal(harness.installRecords.size, unsafe ? 1 : 0);
          if (unsafe) {
            const state = yield* updates.getState;
            assert.equal(state.status, "error");
            assert.equal(state.canRetry, false);
            assert.include(state.message ?? "", "recovery");
            harness.emit("error", new Error("late updater error"));
            yield* flushCallbacks;
            assert.isFalse((yield* updates.install).accepted);
            assert.equal(harness.quitAndInstalls(), 1);
            assert.deepEqual(harness.installSteps, ["quitAndInstall"]);
            assert.equal(harness.updateRestartMarkers.size, 1);
            assert.equal(harness.installRecords.size, 1);
          }
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

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

  it.effect.each(["pending", "settled", "external"] as const)(
    "handles %s installer errors without starting undesired instances",
    (phase) => {
      const installStarted = Deferred.makeUnsafe<void>();
      const releaseInstall = Deferred.makeUnsafe<void>();
      const starts: string[] = [];
      const stops: string[] = [];
      const makeInstance = (
        id: DesktopBackendPool.BackendInstanceId,
        initiallyRunning: boolean,
      ) => {
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
      const harness = makeHarness({
        env: phase === "external" ? { T3CODE_DESKTOP_UPDATE_INSTALLER: "/test/installer" } : {},
        backendInstances: [primary, wsl],
        quitAndInstall: Deferred.succeed(installStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInstall)),
        ),
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installing = yield* updates.install.pipe(Effect.forkChild);
          yield* Deferred.await(installStarted);
          if (phase === "settled") {
            yield* Deferred.succeed(releaseInstall, undefined);
            yield* Fiber.join(installing);
          }
          assert.sameMembers(stops, [primary.id, wsl.id]);
          assert.isFalse((yield* wsl.snapshot).desiredRunning);
          const { changes } = yield* updates.subscribe;
          const recovered = yield* Stream.runHead(changes).pipe(Effect.forkChild);
          yield* flushCallbacks;
          harness.emit("error", new Error("native installer refused"));
          if (phase !== "settled") {
            yield* flushCallbacks;
            assert.deepEqual(starts, phase === "external" ? [] : [wsl.id]);
            assert.equal(harness.updateRestartMarkers.size, phase === "external" ? 1 : 0);
            assert.equal(harness.installRecords.size, phase === "external" ? 1 : 0);
            yield* Deferred.succeed(releaseInstall, undefined);
            yield* Fiber.join(installing);
          }
          if (phase === "external") {
            harness.emit("error", new Error("updater error after external handoff"));
            yield* flushCallbacks;
            assert.deepEqual(starts, []);
            assert.isFalse((yield* wsl.snapshot).desiredRunning);
            assert.equal(harness.updateRestartMarkers.size, 1);
            assert.equal(harness.installRecords.size, 1);
            return;
          }
          assert.equal(Option.getOrThrow(yield* Fiber.join(recovered)).errorContext, "install");
          assert.equal(harness.updateRestartMarkers.size, 0);
          assert.equal(harness.installRecords.size, 0);

          assert.deepEqual(starts, [wsl.id]);
          assert.isFalse((yield* primary.snapshot).desiredRunning);
          assert.isTrue((yield* wsl.snapshot).desiredRunning);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

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
});

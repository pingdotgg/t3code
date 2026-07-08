import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

interface UpdatesHarnessOptions {
  readonly checkForUpdates?: Effect.Effect<
    void,
    ElectronUpdater.ElectronUpdaterCheckForUpdatesError
  >;
  readonly setUpdateChannelError?: DesktopAppSettings.DesktopSettingsWriteError;
  readonly setDisableDifferentialDownload?: Effect.Effect<void>;
  readonly stopBackend?: Effect.Effect<void>;
  readonly env?: Record<string, string | undefined>;
}

const flushCallbacks = Effect.yieldNow;

function makeHarness(options: UpdatesHarnessOptions = {}) {
  let checkCount = 0;
  let allowDowngrade = false;
  const feedUrls: ElectronUpdater.ElectronUpdaterFeedUrl[] = [];
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const sentStates: DesktopUpdateState[] = [];

  const addListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
  };

  const removeListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName);
    if (!eventListeners) {
      return;
    }
    eventListeners.delete(listener);
    if (eventListeners.size === 0) {
      listeners.delete(eventName);
    }
  };

  const updaterLayer = Layer.succeed(ElectronUpdater.ElectronUpdater, {
    setFeedURL: (options) =>
      Effect.sync(() => {
        feedUrls.push(options);
      }),
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setDisableDifferentialDownload: () => options.setDisableDifferentialDownload ?? Effect.void,
    checkForUpdates: Effect.sync(() => {
      checkCount += 1;
    }).pipe(Effect.andThen(options.checkForUpdates ?? Effect.void)),
    downloadUpdate: Effect.void,
    quitAndInstall: () => Effect.void,
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          addListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
        }),
        () =>
          Effect.sync(() => {
            removeListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
          }),
      ).pipe(Effect.asVoid),
  } satisfies ElectronUpdater.ElectronUpdater["Service"]);

  const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeed(Option.none()),
    currentMainOrFirst: Effect.succeed(Option.none()),
    focusedMainOrFirst: Effect.succeed(Option.none()),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const stubBackendInstance: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    start: Effect.void,
    stop: () => options.stopBackend ?? Effect.void,
    currentConfig: Effect.succeed(Option.none()),
    snapshot: Effect.succeed({
      desiredRunning: false,
      ready: false,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    waitForReady: () => Effect.succeed(true),
  };
  const backendLayer = DesktopBackendPool.layerTest([stubBackendInstance]);

  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/t3-desktop-updates-home-${process.pid}`,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
          T3CODE_DESKTOP_MOCK_UPDATES: "true",
          T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
          ...options.env,
        }),
      ),
    ),
  );

  const setUpdateChannelError = options.setUpdateChannelError;
  const settingsLayer = setUpdateChannelError
    ? Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
        get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        load: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        setServerExposureMode: () => Effect.die("unexpected server exposure update"),
        setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
        setUpdateChannel: () => Effect.fail(setUpdateChannelError),
        setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
        setWslDistro: () => Effect.die("unexpected WSL distro change"),
        setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
        applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
        applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
      } satisfies DesktopAppSettings.DesktopAppSettings["Service"])
    : DesktopAppSettings.layer;

  const layer = DesktopUpdates.layer.pipe(
    Layer.provideMerge(updaterLayer),
    Layer.provideMerge(windowLayer),
    Layer.provideMerge(backendLayer),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(
      DesktopConfig.layerTest({
        T3CODE_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
        T3CODE_DESKTOP_MOCK_UPDATES: "true",
        T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
        ...options.env,
      }),
    ),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    checkCount: () => checkCount,
    feedUrls: () => feedUrls,
    listenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, eventListeners) => total + eventListeners.size,
        0,
      ),
    sentStates,
    emit: (eventName: string, payload?: unknown) => {
      for (const listener of listeners.get(eventName) ?? []) {
        listener(payload);
      }
    },
  };
}

describe("DesktopUpdates", () => {
  it("preserves complete causes for update poller and event failures", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("updater failed")),
      Cause.die(new Error("updater defect")),
    );
    const pollerError = new DesktopUpdates.DesktopUpdatePollerError({
      poller: "startup",
      cause,
    });
    const eventError = new DesktopUpdates.DesktopUpdateEventHandlingError({
      event: "download-progress",
      cause,
    });
    const reportedError = new DesktopUpdates.DesktopUpdaterReportedError({
      operation: "download",
      cause,
    });
    const unexpectedActionError = new DesktopUpdates.DesktopUpdateUnexpectedActionError({
      action: "install",
      cause,
    });

    assert.strictEqual(pollerError.cause, cause);
    assert.equal(pollerError.poller, "startup");
    assert.equal(pollerError.message, "Desktop update startup poller failed.");
    assert.strictEqual(eventError.cause, cause);
    assert.equal(eventError.event, "download-progress");
    assert.equal(eventError.message, "Failed to handle desktop update download-progress event.");
    assert.strictEqual(reportedError.cause, cause);
    assert.equal(reportedError.operation, "download");
    assert.equal(reportedError.message, "Desktop updater download operation reported an error.");
    assert.strictEqual(unexpectedActionError.cause, cause);
    assert.equal(unexpectedActionError.action, "install");
    assert.equal(
      unexpectedActionError.message,
      "Desktop update install action failed unexpectedly.",
    );
  });

  it.effect("configures the updater and runs startup checks on the test clock", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const state = yield* updates.getState;
          assert.equal(state.enabled, true);
          assert.equal(state.status, "idle");
          assert.deepEqual(harness.feedUrls(), [
            { provider: "generic", url: "http://localhost:4141" },
          ]);
          assert.equal(harness.listenerCount(), 6);
          assert.equal(harness.checkCount(), 0);

          yield* TestClock.adjust(Duration.millis(15_000));
          assert.equal(harness.checkCount(), 1);
        }),
      );

      assert.equal(harness.listenerCount(), 0);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("updates and broadcasts state from updater events", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.4");
        assert.isNotNull(state.checkedAt);
        assert.equal(harness.sentStates.at(-1)?.status, "available");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps raw updater event failures out of update state", () => {
    const harness = makeHarness();
    const cause = new Error(
      "request failed for https://user:secret@example.com/update?token=secret",
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("error", cause);
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "error");
        assert.equal(state.message, "Desktop updater background operation reported an error.");
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("logs bounded updater failure context without exposing the cause", () => {
    const cause = new Error(
      "request failed for https://user:secret@example.com/update?token=secret",
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

  it.effect("fails channel changes with a typed error while a check is in progress", () =>
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

          const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
          yield* Deferred.await(checkStarted);

          const exit = yield* Effect.exit(updates.setChannel("nightly"));
          assert.equal(exit._tag, "Failure");
          if (exit._tag === "Failure") {
            const error = Cause.squash(exit.cause);
            assert.instanceOf(error, DesktopUpdates.DesktopUpdateActionInProgressError);
            assert.equal(error.action, "check");
            assert.equal(error.requestedChannel, "nightly");
          }

          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(checkFiber);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("preserves settings failure context when an update channel cannot be persisted", () => {
    const diskFailure = new Error("disk exploded");
    const settingsFailure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/tmp/settings.json",
      cause: diskFailure,
    });
    const harness = makeHarness({ setUpdateChannelError: settingsFailure });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);

        assert.instanceOf(error, DesktopUpdates.DesktopUpdateChannelPersistenceError);
        assert.isTrue(DesktopUpdates.isDesktopUpdateSetChannelError(error));
        assert.equal(error.channel, "nightly");
        assert.strictEqual(error.cause, settingsFailure);
        assert.strictEqual(error.cause.cause, diskFailure);
        assert.equal(error.message, "Failed to persist the nightly desktop update channel.");
        assert.notInclude(error.message, diskFailure.message);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});

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
import * as DesktopUpdateRelaunch from "./DesktopUpdateRelaunch.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

interface UpdatesHarnessOptions {
  readonly platform?: NodeJS.Platform;
  readonly checkForUpdates?: Effect.Effect<
    void,
    ElectronUpdater.ElectronUpdaterCheckForUpdatesError
  >;
  readonly downloadUpdate?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterDownloadUpdateError>;
  readonly setUpdateChannelError?: DesktopAppSettings.DesktopSettingsWriteError;
  readonly setDisableDifferentialDownload?: Effect.Effect<void>;
  readonly stopBackend?: Effect.Effect<void>;
  readonly env?: Record<string, string | undefined>;
}

const flushCallbacks = Effect.yieldNow;

function makeHarness(options: UpdatesHarnessOptions = {}) {
  const platform = options.platform ?? "win32";
  const platformEnv = platform === "linux" ? { APPIMAGE: "/tmp/T3-Code.AppImage" } : {};
  let checkCount = 0;
  let destroyAllCount = 0;
  let quitAndInstallCount = 0;
  let allowDowngrade = false;
  let fullChangelog = false;
  const autoInstallOnAppQuitValues: boolean[] = [];
  const feedUrls: ElectronUpdater.ElectronUpdaterFeedUrl[] = [];
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const sentStates: DesktopUpdateState[] = [];
  const stateWaiters = new Set<(state: DesktopUpdateState) => void>();

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
    setAutoInstallOnAppQuit: (value) =>
      Effect.sync(() => {
        autoInstallOnAppQuitValues.push(value);
      }),
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setFullChangelog: (value) =>
      Effect.sync(() => {
        fullChangelog = value;
      }),
    setDisableDifferentialDownload: () => options.setDisableDifferentialDownload ?? Effect.void,
    checkForUpdates: Effect.sync(() => {
      checkCount += 1;
    }).pipe(Effect.andThen(options.checkForUpdates ?? Effect.void)),
    downloadUpdate: options.downloadUpdate ?? Effect.void,
    quitAndInstall: () =>
      Effect.sync(() => {
        quitAndInstallCount += 1;
      }),
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
    onNativeUpdateDownloaded: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          addListener("native-update-downloaded", listener);
        }),
        () =>
          Effect.sync(() => {
            removeListener("native-update-downloaded", listener);
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
        const updateState = state as DesktopUpdateState;
        sentStates.push(updateState);
        for (const waiter of stateWaiters) {
          waiter(updateState);
        }
      }),
    destroyAll: Effect.sync(() => {
      destroyAllCount += 1;
    }),
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
    platform,
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
          ...platformEnv,
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
        setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
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
        ...platformEnv,
        ...options.env,
      }),
    ),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    autoInstallOnAppQuitValues: () => autoInstallOnAppQuitValues,
    awaitState: (predicate: (state: DesktopUpdateState) => boolean) =>
      Effect.promise(() => {
        if (sentStates.some(predicate)) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          const waiter = (state: DesktopUpdateState) => {
            if (!predicate(state)) {
              return;
            }
            stateWaiters.delete(waiter);
            resolve();
          };
          stateWaiters.add(waiter);
        });
      }),
    checkCount: () => checkCount,
    destroyAllCount: () => destroyAllCount,
    feedUrls: () => feedUrls,
    fullChangelog: () => fullChangelog,
    listenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, eventListeners) => total + eventListeners.size,
        0,
      ),
    quitAndInstallCount: () => quitAndInstallCount,
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
    const nativePreparationError = new DesktopUpdates.DesktopUpdateNativePreparationError({
      stage: "resolve-version",
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
    assert.equal(nativePreparationError.stage, "resolve-version");
    assert.equal(
      nativePreparationError.message,
      "Native macOS update preparation completed without an update version.",
    );
    assert.notProperty(nativePreparationError, "cause");
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

  it.effect("enables native pre-staging only on macOS", () =>
    Effect.gen(function* () {
      for (const [platform, expected] of [
        ["darwin", true],
        ["win32", false],
        ["linux", false],
      ] as const) {
        const harness = makeHarness({ platform });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            assert.deepEqual(harness.autoInstallOnAppQuitValues(), [expected]);
            assert.equal(harness.listenerCount(), platform === "darwin" ? 7 : 6);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }
    }),
  );

  it.effect("withholds the macOS restart action until native staging is complete", () => {
    const harness = makeHarness({ platform: "darwin" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const preparingState = yield* updates.getState;
        assert.equal(preparingState.status, "downloading");
        assert.equal(preparingState.downloadPercent, 100);
        assert.equal(preparingState.message, "Preparing update…");
        assert.isUndefined(downloadFiber.pollUnsafe());

        harness.emit("download-progress", { percent: 100 });
        yield* flushCallbacks;
        const stateAfterLateProgress = yield* updates.getState;
        assert.equal(stateAfterLateProgress.status, "downloading");
        assert.equal(stateAfterLateProgress.message, "Preparing update…");

        harness.emit("native-update-downloaded");
        const result = yield* Fiber.join(downloadFiber);
        assert.isTrue(result.accepted);
        assert.isTrue(result.completed);

        const readyState = yield* updates.getState;
        assert.equal(readyState.status, "downloaded");
        assert.equal(readyState.downloadedVersion, "1.2.4");
        assert.isNull(readyState.message);

        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        const stateAfterDuplicateCompletion = yield* updates.getState;
        assert.equal(stateAfterDuplicateCompletion.status, "downloaded");
        assert.equal(stateAfterDuplicateCompletion.downloadedVersion, "1.2.4");
        assert.isNull(stateAfterDuplicateCompletion.message);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps the macOS update ready when completion callbacks race", () => {
    const harness = makeHarness({ platform: "darwin" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        harness.emit("native-update-downloaded");

        const result = yield* Fiber.join(downloadFiber);
        assert.isTrue(result.accepted);
        assert.isTrue(result.completed);
        yield* flushCallbacks;

        const readyState = yield* updates.getState;
        assert.equal(readyState.status, "downloaded");
        assert.equal(readyState.downloadedVersion, "1.2.4");
        assert.isNull(readyState.message);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores download progress after a stray no-update event", () => {
    const harness = makeHarness({ platform: "darwin" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
        yield* flushCallbacks;
        harness.emit("update-not-available");
        yield* flushCallbacks;

        const noUpdateState = yield* updates.getState;
        assert.equal(noUpdateState.status, "up-to-date");
        assert.isNull(noUpdateState.downloadPercent);

        harness.emit("download-progress", { percent: 42 });
        yield* flushCallbacks;

        const downloadingState = yield* updates.getState;
        assert.equal(downloadingState.status, "downloading");
        assert.equal(downloadingState.downloadPercent, 42);
        assert.isNull(downloadingState.message);

        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        harness.emit("native-update-downloaded");
        const result = yield* Fiber.join(downloadFiber);
        assert.isTrue(result.accepted);
        assert.isTrue(result.completed);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect(
    "fails macOS native preparation instead of hanging when no version is available",
    () => {
      const harness = makeHarness({ platform: "darwin" });

      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;

          const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
          yield* flushCallbacks;
          harness.emit("update-not-available");
          yield* flushCallbacks;
          harness.emit("native-update-downloaded");

          const result = yield* Fiber.join(downloadFiber);
          assert.isTrue(result.accepted);
          assert.isFalse(result.completed);
          assert.equal(result.state.status, "error");
          assert.equal(result.state.errorContext, "download");
          assert.equal(
            result.state.message,
            "Native macOS update preparation completed without an update version.",
          );
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

  it.effect("ignores native readiness after a macOS download failure", () => {
    const downloadError = new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
      channel: null,
      cause: new Error("simulated download failure"),
    });
    const harness = makeHarness({
      platform: "darwin",
      downloadUpdate: Effect.fail(downloadError),
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
        assert.equal(failedState.errorContext, "download");
        assert.isTrue(failedState.canRetry);

        harness.emit("native-update-downloaded");
        yield* flushCallbacks;

        assert.deepEqual(yield* updates.getState, failedState);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("only force-destroys windows for the Windows installer", () =>
    Effect.gen(function* () {
      for (const platform of ["darwin", "win32", "linux"] as const) {
        const harness = makeHarness({ platform });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            harness.emit("update-available", { version: "1.2.4" });
            yield* flushCallbacks;

            if (platform === "darwin") {
              const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
              yield* flushCallbacks;
              harness.emit("update-downloaded", { version: "1.2.4" });
              yield* flushCallbacks;
              harness.emit("native-update-downloaded");
              const downloadResult = yield* Fiber.join(downloadFiber);
              assert.isTrue(downloadResult.completed);
            } else {
              const downloadResult = yield* updates.download;
              assert.isTrue(downloadResult.completed);
              harness.emit("update-downloaded", { version: "1.2.4" });
            }
            yield* flushCallbacks;

            const result = yield* updates.install;
            assert.isTrue(result.accepted);
            assert.equal(
              result.state.message,
              "Preparing update… T3 Code will restart automatically.",
            );
            assert.equal(harness.quitAndInstallCount(), 1);
            assert.equal(harness.destroyAllCount(), platform === "win32" ? 1 : 0);
            yield* DesktopUpdateRelaunch.clear;
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }
    }),
  );

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

  it.effect("enables nightly full changelog release notes and broadcasts summaries", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.setChannel("nightly");
        assert.equal(harness.fullChangelog(), true);

        harness.emit("update-available", {
          version: "1.2.4-nightly.20260709.766",
          releaseNotes: [
            {
              version: "1.2.4-nightly.20260709.766",
              note: `<h2>What's Changed</h2><ul><li>feat(client): persist offline environment data by <a>@juliusmarminge</a> in <a>#3795</a></li></ul><h2>Full Changelog</h2>`,
            },
            {
              version: "1.2.4-nightly.20260709.765",
              note: "- [codex] Upgrade Clerk stack by @juliusmarminge in #3821",
            },
          ],
        });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.deepEqual(state.releaseNotes, [
          {
            version: "1.2.4-nightly.20260709.766",
            items: ["feat(client): persist offline environment data by @juliusmarminge in #3795"],
          },
          {
            version: "1.2.4-nightly.20260709.765",
            items: ["[codex] Upgrade Clerk stack by @juliusmarminge in #3821"],
          },
        ]);
        assert.deepEqual(harness.sentStates.at(-1)?.releaseNotes, state.releaseNotes);
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

  it.effect("clears the relaunch marker after an updater-reported install failure", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const installResult = yield* updates.install;
        assert.isTrue(installResult.accepted);
        assert.isTrue(yield* DesktopUpdateRelaunch.consume);
        yield* DesktopUpdateRelaunch.mark;

        harness.emit("error", new Error("native installer failed"));
        yield* harness.awaitState((state) => state.errorContext === "install");

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "downloaded");
        assert.equal(failedState.errorContext, "install");
        assert.equal(failedState.message, "Desktop updater install operation reported an error.");
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.isFalse(yield* DesktopUpdateRelaunch.consume);
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

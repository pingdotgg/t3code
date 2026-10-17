// @effect-diagnostics nodeBuiltinImport:off - Exercises installs and persisted traces at the dependency quit boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import { AppImageUpdater } from "electron-updater";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import { DesktopTraceFlush } from "../app/DesktopObservability.ts";
import { afterEach, beforeEach, vi } from "vite-plus/test";

const { autoUpdaterMock, moduleState } = vi.hoisted(() => ({
  moduleState: { reads: 0, current: undefined as unknown },
  autoUpdaterMock: {
    logger: null as AppImageUpdater["logger"],
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    channel: "latest",
    disableDifferentialDownload: false,
    fullChangelog: false,
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    on: vi.fn(),
    quitAndInstall: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
  },
}));

vi.mock("electron-updater", async (importOriginal) => {
  const actual = await importOriginal<typeof import("electron-updater")>();
  return {
    AppImageUpdater: actual.AppImageUpdater,
    get autoUpdater() {
      moduleState.reads++;
      return moduleState.current ?? autoUpdaterMock;
    },
  };
});

import * as ElectronUpdater from "./ElectronUpdater.ts";

const layerUpdater = ElectronUpdater.layer.pipe(
  Layer.provide(Layer.succeed(DesktopTraceFlush, { flush: Effect.void })),
);

const TraceRecordLine = Schema.Struct({
  name: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  events: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const decodeTraceRecordLine = Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecordLine));

const updaterSpans = (trace: string) =>
  trace
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeTraceRecordLine(line))
    .filter((record) => record.name === "desktop.updater");

const work: Array<string> = [];
const originalAppImage = process.env.APPIMAGE;
afterEach(() => {
  if (originalAppImage === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = originalAppImage;
  for (const root of work.splice(0)) NodeFS.rmSync(root, { force: true, recursive: true });
});

function realUpdaterFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-updater-bridge-"));
  work.push(root);
  const appImageFile = NodePath.join(root, "T3-Code.AppImage");
  const pending = NodePath.join(root, "pending");
  NodeFS.mkdirSync(pending);
  const installerPath = NodePath.join(pending, "T3-Code.AppImage");
  const old = "#!/bin/sh\n# old\nexit 0\n";
  const update = "#!/bin/sh\n# new\nexit 0\n";
  NodeFS.writeFileSync(appImageFile, old, { mode: 0o755 });
  NodeFS.writeFileSync(installerPath, update, { mode: 0o644 });
  process.env.APPIMAGE = appImageFile;
  const adapter = {
    version: "1.2.2",
    name: "t3code",
    isPackaged: true,
    appUpdateConfigPath: NodePath.join(root, "app-update.yml"),
    userDataPath: root,
    baseCachePath: root,
    whenReady: () => Promise.resolve(),
    quit: vi.fn(),
    relaunch: () => {},
    onQuit: () => {},
  };
  const updater = new AppImageUpdater(null, adapter);
  const errors: Array<string> = [];
  updater.on("error", (error: Error) => errors.push(error.message));
  Object.assign(updater, {
    downloadedUpdateHelper: {
      file: installerPath,
      downloadedFileInfo: {
        sha512: NodeCrypto.createHash("sha512").update(update).digest("base64"),
      },
    },
  });
  moduleState.current = updater;
  return {
    root,
    appImageFile,
    installerPath,
    old,
    update,
    updater,
    errors,
    adapter,
  };
}

// `logs` and `traces` each turn on that OTLP signal and keep every body the
// collector takes for it. The collector never replies while `answering` is
// false, and trace file writes wait for `diskReady` when it is given.
function traceLayer(
  root: string,
  options: {
    readonly logs?: Array<string>;
    readonly traces?: Array<string>;
    readonly answering?: () => boolean;
    readonly diskReady?: Promise<void>;
  } = {},
) {
  const { logs, traces, answering = () => true, diskReady } = options;
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: root,
    platform: "linux",
    processArch: "x64",
    appVersion: "1.2.2",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: root,
          ...(logs ? { T3CODE_OTLP_LOGS_URL: "http://collector.invalid/v1/logs" } : {}),
          ...(traces ? { T3CODE_OTLP_TRACES_URL: "http://collector.invalid/v1/traces" } : {}),
        }),
      ),
    ),
  );
  const layerFileSystem = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fileSystem) =>
      FileSystem.FileSystem.of({
        ...fileSystem,
        writeFile: (path, data, writeOptions) =>
          diskReady !== undefined && path.endsWith("desktop.trace.ndjson")
            ? Effect.promise(() => diskReady).pipe(
                Effect.andThen(fileSystem.writeFile(path, data, writeOptions)),
              )
            : fileSystem.writeFile(path, data, writeOptions),
      }),
    ),
  );
  return ElectronUpdater.layer.pipe(
    Layer.provideMerge(
      DesktopObservability.layer.pipe(
        Layer.provide(layerFileSystem),
        Layer.provideMerge(environment),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      logs || traces
        ? Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.suspend(() => {
                const received = request.url.endsWith("/v1/traces") ? traces : logs;
                if (request.body._tag === "Uint8Array") {
                  received?.push(new TextDecoder().decode(request.body.body));
                }
                return answering()
                  ? Effect.succeed(
                      HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
                    )
                  : Effect.never;
              }),
            ),
          )
        : NodeHttpClient.layerUndici,
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
  );
}

describe("ElectronUpdater", () => {
  beforeEach(() => {
    moduleState.reads = 0;
    moduleState.current = undefined;
    autoUpdaterMock.logger = null;
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = true;
    autoUpdaterMock.autoInstallOnAppQuit = true;
    autoUpdaterMock.channel = "latest";
    autoUpdaterMock.disableDifferentialDownload = false;
    autoUpdaterMock.fullChangelog = false;
    autoUpdaterMock.checkForUpdates.mockClear();
    autoUpdaterMock.checkForUpdates.mockImplementation(() => Promise.resolve(null));
    autoUpdaterMock.downloadUpdate.mockClear();
    autoUpdaterMock.downloadUpdate.mockImplementation(() => Promise.resolve([]));
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockClear();
    autoUpdaterMock.removeListener.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
  });

  it.effect("keeps disabled and non-AppImage updater construction lazy", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;
      const registration = updater.on("unused", () => {});
      assert.isDefined(registration);
      assert.equal(moduleState.reads, 0);
      yield* updater.setAutoDownload(false);
      assert.equal(moduleState.reads, 1);
      assert.isFalse(autoUpdaterMock.autoDownload);
    }).pipe(Effect.provide(layerUpdater)),
  );

  it.effect("restores the previous logger when its scope closes", () =>
    Effect.gen(function* () {
      const previous = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      autoUpdaterMock.logger = previous;
      yield* Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.setAutoDownload(false);
        assert.notStrictEqual(autoUpdaterMock.logger, previous);
      }).pipe(Effect.provide(layerUpdater));
      assert.strictEqual(autoUpdaterMock.logger, previous);
    }),
  );

  describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("AppImage install", () => {
    it.effect("keeps the verified installer after the updater scope closes", () => {
      const input = realUpdaterFixture();
      const previous = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      input.updater.logger = previous;
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.setAutoDownload(false);
        }).pipe(Effect.provide(layerUpdater));
        assert.strictEqual(input.updater.logger, previous);
        Object.assign(input.updater, {
          downloadedUpdateHelper: {
            file: input.installerPath,
            downloadedFileInfo: { sha512: "bad-digest" },
          },
        });
        assert.isFalse(input.updater.install(true, false));
        assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), input.old);
        assert.equal(NodeFS.readFileSync(input.installerPath, "utf8"), input.update);
        assert.lengthOf(input.errors, 1);
        assert.include(input.errors[0]!, "does not match");
      });
    });

    // Runs the real install with the explicit-quit flags, then the adapter quit.
    // The dependency's intervening Electron event needs a packaged app.
    // Returns the trace file as it was when the original quit ran, and the
    // OTLP exports as they were when the update launched. Production closes
    // no scope before either, so neither does this.
    const traceAtQuit = (
      input: ReturnType<typeof realUpdaterFixture>,
      collector: { readonly logs: ReadonlyArray<string>; readonly traces: ReadonlyArray<string> },
    ) =>
      Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const originalQuit = input.adapter.quit;
        let trace = "";
        let exported = { logs: [...collector.logs], traces: [...collector.traces] };
        let finish = () => {};
        const quit = new Promise<void>((resolve) => {
          finish = resolve;
        });
        originalQuit.mockImplementation(() => {
          const tracePath = NodePath.join(environment.logDir, "desktop.trace.ndjson");
          trace = NodeFS.existsSync(tracePath) ? NodeFS.readFileSync(tracePath, "utf8") : "";
          finish();
        });
        vi.spyOn(input.updater, "spawnLog").mockImplementation(() => {
          exported = { logs: [...collector.logs], traces: [...collector.traces] };
          return Promise.resolve(true);
        });
        yield* updater.setAutoDownload(false);
        assert.isTrue(input.updater.install(true, true));
        input.adapter.quit();
        yield* Effect.promise(() => quit);
        assert.equal(originalQuit.mock.calls.length, 1);
        return { trace, exported };
      });

    it.effect.each([
      { logs: false, traces: false },
      { logs: true, traces: false },
      { logs: false, traces: true },
      { logs: true, traces: true },
    ])(
      "persists the install records before the adapter quits (OTLP logs $logs, traces $traces)",
      (otlp) => {
        const input = realUpdaterFixture();
        const logExports: Array<string> = [];
        const traceExports: Array<string> = [];
        return Effect.gen(function* () {
          const { trace: persisted, exported } = yield* traceAtQuit(input, {
            logs: logExports,
            traces: traceExports,
          }).pipe(
            Effect.provide(
              traceLayer(input.root, {
                ...(otlp.logs ? { logs: logExports } : {}),
                ...(otlp.traces ? { traces: traceExports } : {}),
              }),
            ),
          );
          const spans = updaterSpans(persisted);
          assert.isNotEmpty(spans);
          for (const span of spans) {
            assert.equal(span.attributes.component, "desktop-updater");
            assert.oneOf(span.attributes.level, ["logDebug", "logInfo", "logWarning", "logError"]);
            assert.notProperty(span.attributes, "message");
            assert.notInclude(JSON.stringify(span.attributes), "AppImage update");
          }
          // Spans reach a trace collector before the launch. With logs on
          // too, the same drain sends both exporters.
          assert.equal(
            exported.traces.some((body) => body.includes("desktop.updater")),
            otlp.traces,
          );
          const events = spans.flatMap((span) => span.events.map((event) => event.name));
          for (const record of [
            "AppImage update stage started",
            "AppImage update verified",
            "AppImage update committed",
          ]) {
            // The span event logger writes the text to the trace, and a trace
            // collector gets it with the spans. An OTLP logger takes that job,
            // and the spans stop carrying it.
            assert.equal(
              events.some((name) => name.startsWith(record)),
              !otlp.logs,
            );
            assert.equal(persisted.includes(record), !otlp.logs);
            assert.equal(
              exported.logs.some((body) => body.includes(record)),
              otlp.logs,
            );
            assert.equal(
              exported.traces.some((body) => body.includes(record)),
              otlp.traces && !otlp.logs,
            );
          }
          assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), input.update);
          assert.deepEqual(input.errors, []);
        });
      },
    );

    it.effect("persists an install failure and preserves the old app", () => {
      const input = realUpdaterFixture();
      const originalQuit = input.adapter.quit;
      Object.assign(input.updater, {
        downloadedUpdateHelper: {
          file: input.installerPath,
          downloadedFileInfo: { sha512: "bad-digest" },
        },
      });
      return Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const { flush } = yield* DesktopTraceFlush;
        yield* updater.setAutoDownload(false);
        vi.spyOn(input.updater, "spawnLog").mockResolvedValue(true);
        assert.isFalse(input.updater.install(true, true));
        // A failed explicit install keeps the app running. Drain the sink
        // before reading, without closing the scope or waiting for its timer.
        yield* flush;
        const persisted = NodeFS.readFileSync(
          NodePath.join(environment.logDir, "desktop.trace.ndjson"),
          "utf8",
        );
        assert.include(persisted, "AppImage update install failed");
        assert.include(persisted, "does not match");
        // The error text can name paths, so it stays out of span attributes.
        const spans = updaterSpans(persisted);
        assert.isNotEmpty(spans);
        for (const span of spans) {
          assert.notProperty(span.attributes, "message");
          assert.notInclude(JSON.stringify(span.attributes), "does not match");
        }
        assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), input.old);
        assert.lengthOf(input.errors, 1);
        assert.equal(originalQuit.mock.calls.length, 0);
      }).pipe(Effect.provide(traceLayer(input.root)));
    });

    // The new AppImage takes the single-instance lock on start. If it starts
    // while this process still holds the lock, it exits as a second instance.
    it.effect("drains the records before it launches the update, then quits at once", () => {
      const input = realUpdaterFixture();
      const steps: Array<string> = [];
      let drain = () => {};
      const draining = new Promise<void>((resolve) => {
        drain = resolve;
      });
      let finish = () => {};
      const quit = new Promise<void>((resolve) => {
        finish = resolve;
      });
      vi.spyOn(input.updater, "spawnLog").mockImplementation(() => {
        steps.push("launch");
        return Promise.resolve(true);
      });
      input.adapter.quit.mockImplementation(() => {
        steps.push("quit");
        finish();
      });
      const flush = Effect.sync(() => steps.push("flush started")).pipe(
        Effect.andThen(Effect.promise(() => draining)),
        Effect.andThen(Effect.sync(() => steps.push("flush done"))),
      );
      return Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.setAutoDownload(false);
        assert.isTrue(input.updater.install(true, true));
        input.adapter.quit();
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        assert.deepEqual(steps, ["flush started"]);
        drain();
        yield* Effect.promise(() => quit);
        assert.deepEqual(steps, ["flush started", "flush done", "launch", "quit"]);
      }).pipe(
        Effect.provide(
          ElectronUpdater.layer.pipe(Layer.provide(Layer.succeed(DesktopTraceFlush, { flush }))),
        ),
      );
    });

    it.effect("drains the span that ends as the install call returns", () => {
      const input = realUpdaterFixture();
      const traceExports: Array<string> = [];
      let trace = "";
      let exported: ReadonlyArray<string> = [];
      let finish = () => {};
      const quit = new Promise<void>((resolve) => {
        finish = resolve;
      });
      vi.spyOn(input.updater, "spawnLog").mockImplementation(() => {
        exported = [...traceExports];
        return Promise.resolve(true);
      });
      return Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        input.adapter.quit.mockImplementation(() => {
          trace = NodeFS.readFileSync(
            NodePath.join(environment.logDir, "desktop.trace.ndjson"),
            "utf8",
          );
          finish();
        });
        yield* updater.setAutoDownload(false);
        // As in DesktopUpdates, the install runs inside a span that ends after
        // the call returns, and the dependency then schedules the quit.
        yield* Effect.sync(() => assert.isTrue(input.updater.install(true, true))).pipe(
          Effect.withSpan("desktop.updates.installDownloadedUpdate"),
        );
        setImmediate(() => input.adapter.quit());
        yield* Effect.promise(() => quit);
        assert.include(trace, "desktop.updates.installDownloadedUpdate");
        assert.isTrue(
          exported.some((body) => body.includes("desktop.updates.installDownloadedUpdate")),
        );
      }).pipe(Effect.provide(traceLayer(input.root, { traces: traceExports })));
    });

    it.effect("drains the records before it quits when nothing was launched", () => {
      const input = realUpdaterFixture();
      const steps: Array<string> = [];
      let drain = () => {};
      const draining = new Promise<void>((resolve) => {
        drain = resolve;
      });
      let finish = () => {};
      const quit = new Promise<void>((resolve) => {
        finish = resolve;
      });
      input.adapter.quit.mockImplementation(() => {
        steps.push("quit");
        finish();
      });
      const flush = Effect.sync(() => steps.push("flush started")).pipe(
        Effect.andThen(Effect.promise(() => draining)),
        Effect.andThen(Effect.sync(() => steps.push("flush done"))),
      );
      return Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        yield* updater.setAutoDownload(false);
        input.adapter.quit();
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        assert.deepEqual(steps, ["flush started"]);
        drain();
        yield* Effect.promise(() => quit);
        assert.deepEqual(steps, ["flush started", "flush done", "quit"]);
      }).pipe(
        Effect.provide(
          ElectronUpdater.layer.pipe(Layer.provide(Layer.succeed(DesktopTraceFlush, { flush }))),
        ),
      );
    });

    it.effect("waits a bounded time for a log collector that never answers", () => {
      const input = realUpdaterFixture();
      const logExports: Array<string> = [];
      const steps: Array<string> = [];
      let answering = false;
      vi.spyOn(input.updater, "spawnLog").mockImplementation(() => {
        steps.push("launch");
        return Promise.resolve(true);
      });
      input.adapter.quit.mockImplementation(() => {
        steps.push("quit");
      });
      return Effect.gen(function* () {
        const updater = yield* ElectronUpdater.ElectronUpdater;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const tracePath = NodePath.join(environment.logDir, "desktop.trace.ndjson");
        yield* updater.setAutoDownload(false);
        assert.isTrue(input.updater.install(true, true));
        input.adapter.quit();
        // The test clock holds the bound, so the file write and the export
        // are awaited in real time.
        yield* Effect.promise(() =>
          vi.waitFor(
            () => {
              assert.include(NodeFS.readFileSync(tracePath, "utf8"), "desktop.updater");
              assert.lengthOf(logExports, 1);
            },
            { timeout: 5_000 },
          ),
        );
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        assert.include(logExports[0], "AppImage update committed");
        assert.deepEqual(steps, []);
        yield* TestClock.adjust("2 seconds");
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.deepEqual(steps, ["launch", "quit"]), { timeout: 5_000 }),
        );
      }).pipe(
        // The scope's own final export must not wait on the test clock.
        Effect.ensuring(
          Effect.sync(() => {
            answering = true;
          }),
        ),
        Effect.provide(traceLayer(input.root, { logs: logExports, answering: () => answering })),
      );
    });

    // With OTLP logs on, the collector does not answer either.
    it.effect.each([false, true])(
      "launches the update when the trace file write never settles (OTLP logs %s)",
      (otlpLogs) => {
        const input = realUpdaterFixture();
        const logExports: Array<string> = [];
        const steps: Array<string> = [];
        let answering = false;
        let release = () => {};
        const diskReady = new Promise<void>((resolve) => {
          release = resolve;
        });
        vi.spyOn(input.updater, "spawnLog").mockImplementation(() => {
          steps.push("launch");
          return Promise.resolve(true);
        });
        input.adapter.quit.mockImplementation(() => {
          steps.push("quit");
        });
        return Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.setAutoDownload(false);
          assert.isTrue(input.updater.install(true, true));
          input.adapter.quit();
          // The export leaves while the write is stuck, so an interval export
          // cannot take the records first. The test clock has not moved.
          yield* Effect.promise(() =>
            vi.waitFor(() => assert.lengthOf(logExports, otlpLogs ? 1 : 0), { timeout: 5_000 }),
          );
          yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
          assert.deepEqual(steps, []);
          assert.equal(
            logExports.some((body) => body.includes("AppImage update committed")),
            otlpLogs,
          );
          // One bound covers both waits.
          yield* TestClock.adjust("2 seconds");
          yield* Effect.promise(() =>
            vi.waitFor(() => assert.deepEqual(steps, ["launch", "quit"]), { timeout: 5_000 }),
          );
        }).pipe(
          // Lets the held write, and the flush at scope close behind it, finish.
          Effect.ensuring(
            Effect.sync(() => {
              answering = true;
              release();
            }),
          ),
          Effect.provide(
            traceLayer(input.root, {
              ...(otlpLogs ? { logs: logExports } : {}),
              answering: () => answering,
              diskReady,
            }),
          ),
        );
      },
    );
  });

  it.effect("scopes updater event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.on("update-available", listener);
        }),
      );

      assert.deepEqual(autoUpdaterMock.on.mock.calls, [["update-available", listener]]);
      assert.deepEqual(autoUpdaterMock.removeListener.mock.calls, [["update-available", listener]]);
    }).pipe(Effect.provide(layerUpdater)),
  );

  it.effect("wraps rejected update checks in the method-specific typed error", () =>
    Effect.gen(function* () {
      const cause = new Error("network unavailable");
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "beta";

      const error = yield* updater.checkForUpdates.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterCheckForUpdatesError);
      assert.equal(error.channel, "beta");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Electron updater failed to check for updates on channel beta.");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(layerUpdater)),
  );

  it.effect("preserves the execution-time channel on download failures", () =>
    Effect.gen(function* () {
      const cause = new Error("download unavailable");
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "nightly";

      const error = yield* updater.downloadUpdate.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
      assert.equal(error.channel, "nightly");
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to download the update on channel nightly.",
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(layerUpdater)),
  );

  it.effect("sets full changelog mode", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.setFullChangelog(true);
      assert.equal(autoUpdaterMock.fullChangelog, true);

      yield* updater.setFullChangelog(false);
      assert.equal(autoUpdaterMock.fullChangelog, false);
    }).pipe(Effect.provide(layerUpdater)),
  );

  it.effect("preserves quit-and-install flags and the execution-time channel", () =>
    Effect.gen(function* () {
      const cause = new Error("quit and install failed");
      autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
        throw cause;
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "alpha";

      const error = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: false })
        .pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
      assert.equal(error.channel, "alpha");
      assert.equal(error.isSilent, true);
      assert.equal(error.isForceRunAfter, false);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to quit and install the update on channel alpha (silent: true, force run after: false).",
      );
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, false]]);
    }).pipe(Effect.provide(layerUpdater)),
  );
});

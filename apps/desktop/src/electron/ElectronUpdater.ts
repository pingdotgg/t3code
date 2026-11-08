import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { autoUpdater } from "electron-updater";
import * as Electron from "electron";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The detached installer must outlive the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Option from "effect/Option";
import * as DesktopConfig from "../app/DesktopConfig.ts";

type AutoUpdater = typeof autoUpdater;

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    stage: Schema.optionalKey(Schema.Literals(["validation", "handoff", "shutdown"])),
    terminationConfirmed: Schema.optionalKey(Schema.Boolean),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (this.terminationConfirmed === false)
      return "External update installer termination is unconfirmed. Manual recovery is required.";
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

const isQuitAndInstallError = Schema.is(ElectronUpdaterQuitAndInstallError);

export const findUnconfirmedInstallerCleanup = (
  cause: Cause.Cause<unknown>,
): ElectronUpdaterQuitAndInstallError | undefined => {
  for (const reason of cause.reasons) {
    const error =
      reason._tag === "Die" ? reason.defect : reason._tag === "Fail" ? reason.error : undefined;
    if (isQuitAndInstallError(error) && error.terminationConfirmed === false) return error;
  }
  return undefined;
};

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const execPath = yield* HostProcess.ExecutablePath;
  const installer =
    platform === "darwin" ? Option.getOrUndefined(config.desktopUpdateInstaller) : undefined;
  let downloaded: { archive: string; version: string } | undefined;
  return ElectronUpdater.of({
    setFeedURL: Effect.fn("ElectronUpdater.setFeedURL")(function (options) {
      return Effect.suspend(() => {
        autoUpdater.setFeedURL(options);
        return Effect.void;
      });
    }),
    setAutoDownload: Effect.fn("ElectronUpdater.setAutoDownload")(function (value) {
      return Effect.suspend(() => {
        autoUpdater.autoDownload = value;
        return Effect.void;
      });
    }),
    setAutoInstallOnAppQuit: Effect.fn("ElectronUpdater.setAutoInstallOnAppQuit")(function (value) {
      return Effect.suspend(() => {
        autoUpdater.autoInstallOnAppQuit = value;
        return Effect.void;
      });
    }),
    setChannel: Effect.fn("ElectronUpdater.setChannel")(function (channel) {
      return Effect.suspend(() => {
        autoUpdater.channel = channel;
        return Effect.void;
      });
    }),
    setAllowPrerelease: Effect.fn("ElectronUpdater.setAllowPrerelease")(function (value) {
      return Effect.suspend(() => {
        autoUpdater.allowPrerelease = value;
        return Effect.void;
      });
    }),
    allowDowngrade: Effect.sync(() => autoUpdater.allowDowngrade),
    setAllowDowngrade: Effect.fn("ElectronUpdater.setAllowDowngrade")(function (value) {
      return Effect.suspend(() => {
        autoUpdater.allowDowngrade = value;
        return Effect.void;
      });
    }),
    setFullChangelog: Effect.fn("ElectronUpdater.setFullChangelog")(function (value) {
      return Effect.suspend(() => {
        autoUpdater.fullChangelog = value;
        return Effect.void;
      });
    }),
    setDisableDifferentialDownload: Effect.fn("ElectronUpdater.setDisableDifferentialDownload")(
      function (value) {
        return Effect.suspend(() => {
          autoUpdater.disableDifferentialDownload = value;
          return Effect.void;
        });
      },
    ),
    checkForUpdates: Effect.suspend(() => {
      const channel = autoUpdater.channel;
      return Effect.tryPromise({
        try: () => autoUpdater.checkForUpdates(),
        catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    downloadUpdate: Effect.suspend(() => {
      const channel = autoUpdater.channel;
      return Effect.tryPromise({
        try: () => autoUpdater.downloadUpdate(),
        catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(function ({
      isSilent,
      isForceRunAfter,
    }) {
      return Effect.suspend(() => {
        const channel = autoUpdater.channel;
        let stage: "validation" | "handoff" | "shutdown" = "validation";
        let helperPid: number | undefined;
        let helper: NodeChildProcess.ChildProcess | undefined;
        let exited: Promise<void> | undefined;
        let helperClosed = false;
        let closed: Promise<void> | undefined;
        let committed = false;
        let ownedStage: string | undefined;
        const installError = (cause: unknown, terminationConfirmed?: boolean) =>
          new ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            stage,
            cause,
            ...(terminationConfirmed === undefined ? {} : { terminationConfirmed }),
          });
        return Effect.gen(function* () {
          if (installer === undefined) {
            stage = "shutdown";
            return yield* Effect.try({
              try: () => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
              catch: installError,
            });
          }
          const selected = downloaded;
          if (!path.isAbsolute(installer) || selected === undefined) {
            return yield* installError(
              new Error(
                "External update installation requires an absolute installer path and a downloaded archive.",
              ),
            );
          }
          const appBundle = path.resolve(execPath, "../../..");
          const stageDirectory = yield* fs
            .makeTempDirectory({ directory: path.dirname(appBundle), prefix: ".t3-update." })
            .pipe(Effect.mapError(installError));
          ownedStage = stageDirectory;
          stage = "handoff";
          yield* Effect.tryPromise({
            try: async (signal) => {
              await new Promise<void>((resolveReady, reject) => {
                const child = NodeChildProcess.spawn(
                  installer,
                  [
                    selected.archive,
                    appBundle,
                    selected.version,
                    String(process.pid),
                    String(isForceRunAfter),
                  ],
                  {
                    detached: true,
                    stdio: ["ignore", "pipe", "pipe"],
                    env: { ...process.env, T3CODE_DESKTOP_UPDATE_STAGE: stageDirectory },
                  },
                );
                helper = child;
                helperPid = child.pid;
                exited = new Promise<void>((resolveExited) =>
                  child.once("exit", () => resolveExited()),
                );
                closed = new Promise<void>((resolveClosed) =>
                  child.once("close", () => {
                    helperClosed = true;
                    resolveClosed();
                  }),
                );
                let output = "";
                let errors = "";
                let finished = false;
                const finish = (error?: Error) => {
                  if (finished) return;
                  finished = true;
                  signal.removeEventListener("abort", abort);
                  if (error) {
                    reject(error);
                  } else {
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    child.unref();
                    resolveReady();
                  }
                };
                const abort = () => finish(new Error("External installer handoff was cancelled."));
                signal.addEventListener("abort", abort, { once: true });
                child.once("error", finish);
                child.once("close", () =>
                  finish(new Error(errors || "External installer exited before becoming ready.")),
                );
                child.stderr?.on("data", (chunk: Buffer) => {
                  errors = (errors + chunk.toString()).slice(-8192);
                });
                child.stdout?.on("data", (chunk: Buffer) => {
                  if (finished) return;
                  output += chunk.toString();
                  if (output === "ready\n") finish();
                  else if (output.includes("\n") || output.length > 4096)
                    finish(new Error("Invalid external installer readiness response."));
                });
                if (signal.aborted) abort();
              });
              signal.throwIfAborted();
              stage = "shutdown";
              // Reuse the synchronous quit gate without invoking Squirrel or ShipIt.
              Electron.autoUpdater.emit("before-quit-for-update");
              Electron.app.quit();
              committed = true;
            },
            catch: installError,
          });
        }).pipe(
          Effect.timeout("120 seconds"),
          Effect.catchTags({ TimeoutError: (cause) => Effect.fail(installError(cause)) }),
          Effect.ensuring(
            Effect.gen(function* () {
              const pid = helperPid;
              if (committed) return;
              if (!helperClosed && pid !== undefined && pid > 1) {
                const signalGroup = (signal: "SIGTERM" | "SIGKILL") =>
                  Effect.try({
                    try: () => {
                      try {
                        process.kill(-pid, signal);
                      } catch (cause) {
                        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
                          throw cause;
                      }
                    },
                    catch: (cause) => installError(cause, false),
                  });
                yield* signalGroup("SIGTERM");
                const stopped = yield* Effect.promise(() => closed!).pipe(
                  Effect.timeoutOption("5 seconds"),
                );
                if (Option.isNone(stopped)) {
                  yield* signalGroup("SIGKILL");
                  yield* Effect.promise(() => exited!).pipe(
                    Effect.timeout("5 seconds"),
                    Effect.mapError((cause) => installError(cause, false)),
                  );
                }
              }
              if (ownedStage !== undefined) {
                yield* fs.remove(path.join(ownedStage, "candidate.app"), {
                  recursive: true,
                  force: true,
                });
                yield* fs.remove(path.join(ownedStage, "extracted"), {
                  recursive: true,
                  force: true,
                });
              }
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (!committed) {
                    helper?.stdout?.destroy();
                    helper?.stderr?.destroy();
                  }
                }),
              ),
              Effect.orDie,
            ),
          ),
        );
      });
    }),
    on: Effect.fn("ElectronUpdater.on")(function (eventName, listener) {
      const eventTarget = autoUpdater as unknown as {
        on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
        removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      };
      const untypedListener = (...args: Array<unknown>) => {
        if (eventName === "update-downloaded") {
          const event = args[0] as { downloadedFile?: unknown; version?: unknown } | undefined;
          downloaded =
            event && typeof event.downloadedFile === "string" && typeof event.version === "string"
              ? { archive: event.downloadedFile, version: event.version }
              : undefined;
        }
        (listener as unknown as (...args: Array<unknown>) => void)(...args);
      };
      return Effect.acquireRelease(
        Effect.sync(() => {
          eventTarget.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            eventTarget.removeListener(eventName, untypedListener);
          }),
      ).pipe(Effect.asVoid);
    }),
  });
});

export const layer = Layer.effect(ElectronUpdater, make).pipe(
  Layer.provide(Layer.merge(NodePath.layer, NodeFileSystem.layer)),
);

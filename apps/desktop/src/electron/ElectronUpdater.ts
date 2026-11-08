// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// The detached installer must survive Electron and its Effect runtime shutting down.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { autoUpdater } from "electron-updater";
import * as Electron from "electron";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Option from "effect/Option";
import * as DesktopConfig from "../app/DesktopConfig.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

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
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

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
        return Effect.tryPromise({
          try: async (signal) => {
            if (installer === undefined) {
              autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
              return;
            }
            if (!NodePath.isAbsolute(installer) || downloaded === undefined) {
              throw new Error(
                "External update installation requires an absolute installer path and a downloaded archive.",
              );
            }
            const appBundle = NodePath.resolve(execPath, "../../..");
            const { stdout } = await execFileAsync(
              installer,
              ["prepare", downloaded.archive, appBundle, downloaded.version],
              { timeout: 120_000, signal },
            );
            const prepared = stdout.trim();
            if (!NodePath.isAbsolute(prepared))
              throw new Error("External installer did not return a staged app path.");
            const installerProcess = await new Promise<NodeChildProcess.ChildProcess>(
              (resolveReady, reject) => {
                const child = NodeChildProcess.spawn(
                  installer,
                  ["install", prepared, appBundle, String(process.pid), String(isForceRunAfter)],
                  { detached: true, stdio: ["ignore", "pipe", "pipe"] },
                );
                let output = "";
                let errors = "";
                let finished = false;
                const finish = (error?: Error) => {
                  if (finished) return;
                  finished = true;
                  clearTimeout(timer);
                  signal.removeEventListener("abort", abort);
                  child.stdout?.destroy();
                  child.stderr?.destroy();
                  if (error) {
                    child.kill();
                    reject(error);
                  } else {
                    child.unref();
                    resolveReady(child);
                  }
                };
                const abort = () => finish(new Error("External installer handoff was cancelled."));
                const timer = setTimeout(
                  () => finish(new Error("External installer did not become ready.")),
                  120_000,
                );
                signal.addEventListener("abort", abort, { once: true });
                child.once("error", finish);
                child.once("exit", () =>
                  finish(new Error(errors || "External installer exited before becoming ready.")),
                );
                child.stderr?.on("data", (chunk: Buffer) => {
                  errors = (errors + chunk.toString()).slice(-8192);
                });
                child.stdout?.on("data", (chunk: Buffer) => {
                  output += chunk.toString();
                  if (output === "ready\n") finish();
                  else if (output.includes("\n") || output.length > 4096)
                    finish(new Error("Invalid external installer readiness response."));
                });
                if (signal.aborted) abort();
              },
            );
            if (signal.aborted) {
              installerProcess.kill();
              signal.throwIfAborted();
            }
            // Reuse the synchronous quit gate without invoking Squirrel or ShipIt.
            Electron.autoUpdater.emit("before-quit-for-update");
            Electron.app.quit();
          },
          catch: (cause) =>
            new ElectronUpdaterQuitAndInstallError({
              channel,
              isSilent,
              isForceRunAfter,
              cause,
            }),
        });
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

export const layer = Layer.effect(ElectronUpdater, make);

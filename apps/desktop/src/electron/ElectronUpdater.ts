// @effect-diagnostics nodeBuiltinImport:off -- Runs Linux .deb package installs asynchronously via child_process.spawn.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { AppImageUpdater, DebUpdater, autoUpdater } from "electron-updater";

type AutoUpdater = typeof autoUpdater;
type SpawnLog = (cmd: string, args?: Array<string>, ...rest: Array<unknown>) => Promise<boolean>;

const SAFE_PACKAGE_MANAGER_REGEX = /^[a-zA-Z0-9_-]+$/;
const PRIVILEGE_COMMANDS = ["gksudo", "kdesudo", "pkexec", "beesu"] as const;

interface DebUpdaterInternal {
  quitAndInstallCalled: boolean;
  readonly autoRunAppAfterInstall: boolean;
  readonly downloadedUpdateHelper: {
    readonly file: string | null;
    readonly downloadedFileInfo: { readonly isAdminRightsRequired: boolean } | null;
  } | null;
  readonly app: {
    readonly name: string;
    readonly relaunch: () => void;
    readonly quit: () => void;
  };
  readonly _logger?: {
    readonly info?: (message: unknown) => void;
    readonly warn?: (message: unknown) => void;
    readonly error?: (message: unknown) => void;
  } | null;
}

class DebInstallError extends Schema.TaggedError<DebInstallError>()("DebInstallError", {
  reason: Schema.String,
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const sanitizeEnvPath = (envPath: string): string =>
  envPath
    .split(NodePath.delimiter)
    .filter((dir) => NodePath.isAbsolute(dir))
    .join(NodePath.delimiter);

const sanitizedProcessEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: sanitizeEnvPath(process.env.PATH ?? ""),
});

const readPackageManagerOverride = (): string | undefined =>
  process.env.ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER?.trim();

const shellQuoteArg = (arg: string): string => `'${arg.replace(/'/g, "'\\''")}'`;

const spawnAsync = (
  cmd: string,
  args: ReadonlyArray<string>,
  options: { readonly detached?: boolean },
): Effect.Effect<void, DebInstallError> =>
  Effect.callback<void, DebInstallError>((resume) => {
    let settled = false;
    const child = NodeChildProcess.spawn(cmd, args, {
      env: sanitizedProcessEnv(),
      detached: options.detached ?? false,
      stdio: "ignore",
    });

    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      resume(
        Effect.fail(
          new DebInstallError({
            reason: `Failed to spawn ${cmd}.`,
            cause,
          }),
        ),
      );
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resume(Effect.void);
      } else {
        resume(
          Effect.fail(
            new DebInstallError({
              reason:
                signal !== null
                  ? `Command ${cmd} terminated by signal ${signal}`
                  : `Command ${cmd} exited with code ${code ?? "unknown"}`,
              exitCode: code,
            }),
          ),
        );
      }
    });

    // Never kill an in-flight detached dpkg/apt transaction on fiber interruption.
    return Effect.sync(() => {
      if (!settled && options.detached) {
        child.unref();
      }
    });
  });

const hasCommandAsync = (cmd: string): Effect.Effect<boolean> =>
  spawnAsync("/bin/sh", ["-c", 'command -v -- "$1" >/dev/null 2>&1', "_", cmd], {}).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const detectDebPackageManagerAsync = Effect.fn("ElectronUpdater.detectDebPackageManager")(
  function* (logger: DebUpdaterInternal["_logger"]) {
    const hasDpkg = yield* hasCommandAsync("dpkg");
    const hasApt = yield* hasCommandAsync("apt");
    if (!hasDpkg && !hasApt) {
      return yield* new DebInstallError({
        reason: "Neither dpkg nor apt command found. Cannot install .deb package.",
      });
    }

    const override = readPackageManagerOverride();
    const candidates: ReadonlyArray<string> =
      override && SAFE_PACKAGE_MANAGER_REGEX.test(override)
        ? [override]
        : (["dpkg", "apt"] as const);
    if (override && !SAFE_PACKAGE_MANAGER_REGEX.test(override)) {
      logger?.warn?.(
        `ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER "${override}" contains unsafe characters. Ignoring override.`,
      );
    }

    for (const pm of candidates) {
      if (pm === "dpkg" && hasDpkg) return "dpkg" as const;
      if (pm === "apt" && hasApt) return "apt" as const;
      if (pm !== "dpkg" && pm !== "apt" && (yield* hasCommandAsync(pm))) {
        return yield* new DebInstallError({ reason: `Package manager ${pm} not supported` });
      }
    }

    return hasDpkg ? ("dpkg" as const) : ("apt" as const);
  },
);

const determineSudoCommandAsync = Effect.gen(function* () {
  for (const sudo of PRIVILEGE_COMMANDS) {
    if (yield* hasCommandAsync(sudo)) return sudo;
  }
  return "sudo" as const;
});

const buildPrivilegedDebCommand = (
  sudo: (typeof PRIVILEGE_COMMANDS)[number] | "sudo",
  appName: string,
  commandWithArgs: ReadonlyArray<string>,
): readonly [string, ReadonlyArray<string>] => {
  const safeName = appName.replace(/["`$\\!\n\r;|&<>(){}*?[\]#~]/g, "");
  const installComment = `${safeName} would like to update`;
  if (sudo === "pkexec") {
    return ["pkexec", ["--disable-internal-agent", ...commandWithArgs]];
  }
  if (sudo === "kdesudo") {
    return [
      "kdesudo",
      ["--comment", installComment, "-c", commandWithArgs.map(shellQuoteArg).join(" ")],
    ];
  }
  if (sudo === "gksudo") {
    return ["gksudo", ["--message", installComment, commandWithArgs.map(shellQuoteArg).join(" ")]];
  }
  return [sudo, commandWithArgs];
};

const runDebCommandWithSudoAsync = Effect.fn("ElectronUpdater.runDebCommandWithSudo")(function* (
  appName: string,
  logger: DebUpdaterInternal["_logger"],
  commandWithArgs: ReadonlyArray<string>,
) {
  const isRoot = process.getuid?.() === 0;
  if (isRoot) {
    logger?.info?.("Running as root, no need to use sudo");
    const [cmd, ...args] = commandWithArgs;
    if (!cmd) {
      return yield* new DebInstallError({ reason: "Missing command for .deb install." });
    }
    return yield* spawnAsync(cmd, args, { detached: true });
  }
  const sudo = yield* determineSudoCommandAsync;
  const [cmd, args] = buildPrivilegedDebCommand(sudo, appName, commandWithArgs);
  logger?.info?.(`Running as non-root user, using ${sudo} to install`);
  return yield* spawnAsync(cmd, args, { detached: true });
});

const emitElectronBeforeQuitForUpdate = (): void => {
  const requireFromUpdater = NodeModule.createRequire(
    NodeModule.createRequire(import.meta.url).resolve("electron-updater"),
  );
  const electron = requireFromUpdater("electron") as {
    readonly autoUpdater?: { readonly emit?: (event: string) => boolean };
  };
  electron.autoUpdater?.emit?.("before-quit-for-update");
};

// DebUpdater.doInstall runs `pkexec ... dpkg -i` via spawnSync, blocking Electron's main thread
// and piping stdout back to Electron. Run asynchronously with detached/ignored stdio so the UI
// stays responsive and an app exit cannot SIGPIPE dpkg mid-transaction.
const quitAndInstallDebAsync = Effect.fn("ElectronUpdater.quitAndInstallDeb")(function* (
  updater: DebUpdater,
  isSilent: boolean,
  isForceRunAfter: boolean,
) {
  const deb = updater as unknown as DebUpdaterInternal;
  if (deb.quitAndInstallCalled) {
    deb._logger?.warn?.("install call ignored: quitAndInstallCalled is set to true");
    return;
  }

  const installerPath = deb.downloadedUpdateHelper?.file ?? null;
  const downloadedFileInfo = deb.downloadedUpdateHelper?.downloadedFileInfo ?? null;
  if (installerPath === null || downloadedFileInfo === null) {
    return yield* new DebInstallError({
      reason: "No update filepath provided, can't quit and install",
    });
  }

  deb.quitAndInstallCalled = true;
  const runInstall = Effect.gen(function* () {
    const packageManager = yield* detectDebPackageManagerAsync(deb._logger);
    if (packageManager === "dpkg") {
      yield* runDebCommandWithSudoAsync(deb.app.name, deb._logger, [
        "dpkg",
        "-i",
        installerPath,
      ]).pipe(
        Effect.catch((error) => {
          if (error.exitCode === 126 || error.exitCode === 127) {
            return Effect.fail(error);
          }
          deb._logger?.warn?.(error.message);
          deb._logger?.warn?.(
            "dpkg installation failed, trying to fix broken dependencies with apt-get",
          );
          return runDebCommandWithSudoAsync(deb.app.name, deb._logger, [
            "apt-get",
            "install",
            "-f",
            "-y",
          ]);
        }),
      );
    } else {
      deb._logger?.warn?.(
        "Using apt to install a local .deb. This may fail for unsigned packages unless properly configured.",
      );
      yield* runDebCommandWithSudoAsync(deb.app.name, deb._logger, [
        "apt",
        "install",
        "-y",
        "--allow-unauthenticated",
        "--allow-downgrades",
        "--allow-change-held-packages",
        installerPath,
      ]);
    }

    const shouldRelaunch = isSilent ? isForceRunAfter : deb.autoRunAppAfterInstall;
    if (shouldRelaunch) {
      deb.app.relaunch();
    }
    emitElectronBeforeQuitForUpdate();
    deb.app.quit();
  });

  yield* runInstall.pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        deb.quitAndInstallCalled = false;
      }),
    ),
  );
});

// Electron holds the AppImage runtime's keepalive pipe and some files without O_CLOEXEC; a
// relaunched AppImage inherits them, so old runtimes and FUSE mounts never exit. bash (AppRun
// already needs it; dash cannot close multi-digit fds) closes them before exec'ing the AppImage.
// -p skips BASH_ENV and exported functions in the helper only; the AppImage still receives both.
const CLOSE_INHERITED_FDS_THEN_EXEC =
  'for fd in /proc/self/fd/*; do fd=${fd##*/}; case $fd in *[!0-9]*|[012]) ;; *) eval "exec $fd>&-" ;; esac; done; exec "$@"';

const relaunchWithoutInheritedDescriptors = (updater: AppImageUpdater) => {
  const spawnLog = (AppImageUpdater.prototype as unknown as { spawnLog: SpawnLog }).spawnLog;
  (updater as unknown as { spawnLog: SpawnLog }).spawnLog = function (cmd, args = [], ...rest) {
    return spawnLog.call(
      this,
      "bash",
      ["-p", "-c", CLOSE_INHERITED_FDS_THEN_EXEC, cmd, cmd, ...args],
      ...rest,
    );
  };
};

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
export const make = ElectronUpdater.of({
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
      if (autoUpdater instanceof DebUpdater) {
        return quitAndInstallDebAsync(autoUpdater, isSilent, isForceRunAfter).pipe(
          Effect.mapError(
            (cause) =>
              new ElectronUpdaterQuitAndInstallError({
                channel,
                isSilent,
                isForceRunAfter,
                cause,
              }),
          ),
        );
      }
      if (autoUpdater instanceof AppImageUpdater) relaunchWithoutInheritedDescriptors(autoUpdater);
      return Effect.try({
        try: () => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
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
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
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

export const layer = Layer.succeed(ElectronUpdater, make);

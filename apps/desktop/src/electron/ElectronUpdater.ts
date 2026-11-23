// @effect-diagnostics nodeBuiltinImport:off -- Spawns the .deb install outside electron-updater.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";
import { AppImageUpdater, DebUpdater, autoUpdater } from "electron-updater";

type AutoUpdater = typeof autoUpdater;
type SpawnLog = (cmd: string, args?: Array<string>, ...rest: Array<unknown>) => Promise<boolean>;

const PRIVILEGE_COMMANDS = ["gksudo", "kdesudo", "pkexec", "beesu"] as const;
type PrivilegeCommand = (typeof PRIVILEGE_COMMANDS)[number] | "sudo";
const TRUSTED_SYSTEM_BIN_DIRS: ReadonlyArray<string> = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
// pkexec exits 126 when the user dismisses the prompt and 127 when not authorized; dpkg never ran.
const AUTHORIZATION_EXIT_CODES: ReadonlySet<number | null> = new Set([126, 127]);

interface ResolvedPrivilegeCommand {
  readonly name: PrivilegeCommand;
  readonly path: string;
}

interface DebUpdaterInternal {
  quitAndInstallCalled: boolean;
  readonly autoRunAppAfterInstall: boolean;
  readonly downloadedUpdateHelper: {
    readonly file: string | null;
    readonly downloadedFileInfo: unknown;
  } | null;
  readonly app: { readonly name: string; readonly relaunch: () => void; readonly quit: () => void };
  readonly dispatchError: (error: Error) => void;
  readonly _logger: {
    readonly info: (message: string) => void;
    readonly warn: (message: string) => void;
  };
}

class DebInstallError extends Schema.TaggedError<DebInstallError>()("DebInstallError", {
  reason: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

// Restrict PATH to trusted system directories so user-writable entries cannot shadow system tools.
const sanitizedEnv = (binDirs: ReadonlyArray<string>): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: binDirs.filter((dir) => NodePath.isAbsolute(dir)).join(NodePath.delimiter),
});

const spawnAsync = (
  cmd: string,
  args: ReadonlyArray<string>,
  binDirs: ReadonlyArray<string>,
  options: { readonly detached: boolean; readonly stdio: "ignore" | "inherit" } = {
    detached: false,
    stdio: "ignore",
  },
) =>
  Effect.callback<void, DebInstallError>((resume) => {
    let settled = false;
    const child = NodeChildProcess.spawn(cmd, args, {
      env: sanitizedEnv(binDirs),
      detached: options.detached,
      stdio: options.stdio,
    });
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      resume(
        Effect.fail(
          new DebInstallError({ reason: `Failed to spawn ${cmd}.`, exitCode: null, cause }),
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) return resume(Effect.void);
      const reason =
        signal === null
          ? `Command ${cmd} exited with code ${code ?? "unknown"}`
          : `Command ${cmd} terminated by signal ${signal}`;
      resume(Effect.fail(new DebInstallError({ reason, exitCode: code })));
    });
    // Never kill an in-flight dpkg transaction when the fiber is interrupted.
    return Effect.sync(() => {
      if (!settled && options.detached) child.unref();
    });
  });

const isExecutableFile = (filePath: string) =>
  Effect.promise(async () => {
    try {
      const stat = await NodeFS.promises.stat(filePath);
      if (!stat.isFile()) return false;
      await NodeFS.promises.access(filePath, NodeFS.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

// Untraced helper: callers (`findPrivilegeCommand`, `quitAndInstallDeb`) own the span.
const resolveSystemBinary = Effect.fnUntraced(function* (
  cmd: string,
  binDirs: ReadonlyArray<string>,
) {
  for (const dir of binDirs) {
    if (!NodePath.isAbsolute(dir)) continue;
    const candidate = NodePath.join(dir, cmd);
    if (yield* isExecutableFile(candidate)) return candidate;
  }
  return null;
});

const findPrivilegeCommand = Effect.fn("ElectronUpdater.findPrivilegeCommand")(function* (
  binDirs: ReadonlyArray<string>,
) {
  for (const name of [...PRIVILEGE_COMMANDS, "sudo"] as const) {
    const path = yield* resolveSystemBinary(name, binDirs);
    if (path !== null) return { name, path } satisfies ResolvedPrivilegeCommand;
  }
  return yield* new DebInstallError({
    reason: "No privilege escalation command found in trusted system directories.",
    exitCode: null,
  });
});

const shellQuote = (arg: string): string => `'${arg.replace(/'/g, "'\\''")}'`;

const privilegedCommand = (
  sudo: ResolvedPrivilegeCommand,
  appName: string,
  command: ReadonlyArray<string>,
): readonly [string, ReadonlyArray<string>] => {
  const comment = `${appName.replace(/["`$\\!\n\r;|&<>(){}*?[\]#~]/g, "")} would like to update`;
  switch (sudo.name) {
    case "pkexec":
      return [sudo.path, ["--disable-internal-agent", ...command]];
    case "kdesudo":
      return [sudo.path, ["--comment", comment, "-c", command.map(shellQuote).join(" ")]];
    case "gksudo":
      return [sudo.path, ["--message", comment, command.map(shellQuote).join(" ")]];
    case "beesu":
      return [sudo.path, [command.map(shellQuote).join(" ")]];
    default:
      return [sudo.path, command];
  }
};

// Keep the controlling terminal when falling back to interactive terminal sudo.
const isInteractiveSudo = (sudo: ResolvedPrivilegeCommand): boolean =>
  sudo.name === "sudo" && Boolean(process.stdin.isTTY) && !process.env.SUDO_ASKPASS;

const runAsRoot = Effect.fn("ElectronUpdater.runDebCommandAsRoot")(function* (
  deb: DebUpdaterInternal,
  command: readonly [string, ...Array<string>],
  binDirs: ReadonlyArray<string>,
) {
  if (process.getuid?.() === 0) {
    return yield* spawnAsync(command[0], command.slice(1), binDirs, {
      detached: true,
      stdio: "ignore",
    });
  }
  const sudo = yield* findPrivilegeCommand(binDirs);
  deb._logger.info(`Running as non-root user, using ${sudo.name} to install`);
  const [cmd, args] = privilegedCommand(sudo, deb.app.name, command);
  const interactiveSudo = isInteractiveSudo(sudo);
  return yield* spawnAsync(cmd, args, binDirs, {
    detached: !interactiveSudo,
    stdio: interactiveSudo ? "inherit" : "ignore",
  });
});

const readDebPackageManagerOverride = (): string | undefined =>
  process.env.ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER?.trim();

const resolveDebPackageManager = Effect.fnUntraced(function* (binDirs: ReadonlyArray<string>) {
  const order =
    readDebPackageManagerOverride() === "apt"
      ? (["apt", "dpkg"] as const)
      : (["dpkg", "apt"] as const);
  for (const name of order) {
    const path = yield* resolveSystemBinary(name, binDirs);
    if (path !== null) return { name, path } as const;
  }
  return yield* new DebInstallError({
    reason: "Neither dpkg nor apt command found. Cannot install .deb package.",
    exitCode: null,
  });
});

// DebUpdater.doInstall runs the privileged `dpkg -i` through spawnSync, freezing Electron's main
// thread for as long as the polkit prompt and dpkg take. This mirrors it without blocking, detached
// with ignored stdio so the app quitting cannot SIGPIPE dpkg mid-transaction.
const quitAndInstallDeb = Effect.fn("ElectronUpdater.quitAndInstallDeb")(function* (
  updater: DebUpdater,
  isSilent: boolean,
  isForceRunAfter: boolean,
  binDirs: ReadonlyArray<string>,
) {
  const deb = updater as unknown as DebUpdaterInternal;
  if (deb.quitAndInstallCalled) {
    deb._logger.warn("install call ignored: quitAndInstallCalled is set to true");
    return;
  }
  deb.quitAndInstallCalled = true;
  yield* Effect.gen(function* () {
    const installerPath = deb.downloadedUpdateHelper?.file ?? null;
    if (installerPath === null || deb.downloadedUpdateHelper?.downloadedFileInfo == null) {
      return yield* new DebInstallError({
        reason: "No update filepath provided, can't quit and install",
        exitCode: null,
      });
    }
    const packageManager = yield* resolveDebPackageManager(binDirs);
    if (packageManager.name === "dpkg") {
      yield* runAsRoot(deb, [packageManager.path, "-i", installerPath], binDirs).pipe(
        Effect.catch((error) => {
          if (AUTHORIZATION_EXIT_CODES.has(error.exitCode)) return Effect.fail(error);
          deb._logger.warn(`${error.message}; fixing broken dependencies with apt-get`);
          return Effect.gen(function* () {
            const aptGetPath = yield* resolveSystemBinary("apt-get", binDirs);
            if (aptGetPath === null) {
              return yield* new DebInstallError({
                reason: "apt-get command not found in trusted system directories.",
                exitCode: null,
              });
            }
            return yield* runAsRoot(deb, [aptGetPath, "install", "-f", "-y"], binDirs);
          });
        }),
      );
    } else {
      yield* runAsRoot(
        deb,
        [
          packageManager.path,
          "install",
          "-y",
          "--allow-unauthenticated",
          "--allow-downgrades",
          "--allow-change-held-packages",
          installerPath,
        ],
        binDirs,
      );
    }

    if (isSilent ? isForceRunAfter : deb.autoRunAppAfterInstall) deb.app.relaunch();
    Electron.autoUpdater.emit("before-quit-for-update");
    deb.app.quit();
  }).pipe(
    // A cancelled or failed install leaves the download in place for a retry.
    Effect.onError(() =>
      Effect.sync(() => {
        deb.quitAndInstallCalled = false;
      }),
    ),
    // Report through the updater's error event, as electron-updater's own install does.
    Effect.catch((error) => Effect.sync(() => deb.dispatchError(error))),
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

export const makeWithOptions = (options?: {
  readonly systemBinDirs?: ReadonlyArray<string>;
}): ElectronUpdater["Service"] => {
  const systemBinDirs = options?.systemBinDirs ?? TRUSTED_SYSTEM_BIN_DIRS;
  return ElectronUpdater.of({
    setFeedURL: Effect.fn("ElectronUpdater.setFeedURL")(function (feedOptions) {
      return Effect.suspend(() => {
        autoUpdater.setFeedURL(feedOptions);
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
          return quitAndInstallDeb(autoUpdater, isSilent, isForceRunAfter, systemBinDirs);
        }
        if (autoUpdater instanceof AppImageUpdater)
          relaunchWithoutInheritedDescriptors(autoUpdater);
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
};

/** @public */
export const make = makeWithOptions();

export const layer = Layer.succeed(ElectronUpdater, make);

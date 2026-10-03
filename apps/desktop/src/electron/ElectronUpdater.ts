// @effect-diagnostics nodeBuiltinImport:off - the safe AppImage install path keeps this adapter dependency-free: it stages, verifies, and atomically swaps the update with synchronous Node APIs on the terminal quit-and-install flow.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";
import { autoUpdater } from "electron-updater";

type AutoUpdater = typeof autoUpdater;

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

/** Sync logger electron-updater writes install progress to; DesktopUpdates wires it into the desktop-updater trace. */
export interface ElectronUpdaterLogger {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
  readonly debug?: (message: string) => void;
}

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
    readonly setLogger: (logger: ElectronUpdaterLogger) => Effect.Effect<void>;
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

const noopUpdaterLogger: ElectronUpdaterLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const updaterLogger = (): ElectronUpdaterLogger => autoUpdater.logger ?? noopUpdaterLogger;

const shouldUseSafeAppImageInstall = (platform: NodeJS.Platform): boolean =>
  platform === "linux" && (process.env.APPIMAGE ?? "") !== "";

interface DownloadedAppImageUpdate {
  readonly installerPath: string;
  readonly sha512: string;
}

const readDownloadedAppImageUpdate = (): DownloadedAppImageUpdate | null => {
  const helper = (
    autoUpdater as unknown as {
      readonly downloadedUpdateHelper?: {
        readonly file?: string | null;
        readonly downloadedFileInfo?: { readonly sha512?: string | null } | null;
      } | null;
    }
  ).downloadedUpdateHelper;
  const installerPath = helper?.file ?? null;
  const sha512 = helper?.downloadedFileInfo?.sha512 ?? null;
  if (!installerPath || !sha512) {
    return null;
  }
  return { installerPath, sha512 };
};

// Same digest electron-updater verifies downloads with: base64 sha512 over the whole file.
const hashFileSha512 = (filePath: string): string =>
  NodeCrypto.createHash("sha512").update(NodeFS.readFileSync(filePath)).digest("base64");

const verifyAppImageBytes = (label: string, filePath: string, expectedSha512: string): void => {
  if (NodeFS.statSync(filePath).size === 0) {
    throw new Error(`${label} is empty: ${filePath}`);
  }
  const actualSha512 = hashFileSha512(filePath);
  if (actualSha512 !== expectedSha512) {
    throw new Error(`${label} sha512 mismatch: ${filePath}`);
  }
};

const APPIMAGE_STAGE_PREFIX = ".t3-appimage-staging-";

// Best-effort hygiene: a SIGKILL between mkdtemp and cleanup leaves a staging directory
// behind. Only our own distinctive prefix is swept, and a sweep failure never aborts.
const sweepStaleAppImageStageDirs = (appImageDir: string): void => {
  let entries: ReadonlyArray<string>;
  try {
    entries = NodeFS.readdirSync(appImageDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(APPIMAGE_STAGE_PREFIX)) {
      continue;
    }
    try {
      NodeFS.rmSync(NodePath.join(appImageDir, entry), { recursive: true, force: true });
    } catch {
      // Leftover staging dirs are inert: never executed, never renamed into place.
    }
  }
};

const quitAndInstallAppImage = (isForceRunAfter: boolean): void => {
  const logger = updaterLogger();
  const appImagePath = process.env.APPIMAGE ?? "";
  if (!NodePath.isAbsolute(appImagePath)) {
    throw new Error(`APPIMAGE env is not a valid absolute path: "${appImagePath}"`);
  }
  const pending = readDownloadedAppImageUpdate();
  if (pending === null) {
    throw new Error("No downloaded AppImage update is available");
  }
  logger.info(`Safe AppImage install of ${pending.installerPath} over ${appImagePath}`);
  verifyAppImageBytes("Downloaded AppImage", pending.installerPath, pending.sha512);

  const appImageDir = NodePath.dirname(appImagePath);
  sweepStaleAppImageStageDirs(appImageDir);

  // Fresh private directory on the AppImage filesystem: mkdtemp names are unpredictable
  // and mode 0700, so nothing can pre-plant a symlink at the staging path — copyFileSync
  // would follow it and corrupt the link target. The final swap stays on one filesystem
  // however the updater cache is mounted.
  const stageDir = NodeFS.mkdtempSync(NodePath.join(appImageDir, APPIMAGE_STAGE_PREFIX));
  const stagedPath = NodePath.join(stageDir, "pending.AppImage");
  try {
    NodeFS.copyFileSync(pending.installerPath, stagedPath, NodeFS.constants.COPYFILE_EXCL);
    NodeFS.chmodSync(stagedPath, 0o755);
    verifyAppImageBytes("Staged AppImage", stagedPath, pending.sha512);
    // Same filesystem, so this is an atomic rename(2): no copy, no partial file, no window
    // where the launch path is missing. rename never follows symlinks: even a swapped
    // destination is replaced, not traversed. The old AppImage stays until this instant.
    NodeFS.renameSync(stagedPath, appImagePath);
    verifyAppImageBytes("Installed AppImage", appImagePath, pending.sha512);
    logger.info(`Safe AppImage install verified at ${appImagePath}`);
  } finally {
    // Cleanup never fails the install; anything left behind is swept next time.
    try {
      NodeFS.rmSync(stageDir, { recursive: true, force: true });
    } catch {
      // Next install sweeps it.
    }
  }

  // Any throw above aborts before quit, so DesktopUpdates can restart the backends and
  // keep running. Past this point the install is verified and only the handoff remains.
  if (isForceRunAfter) {
    const child = NodeChildProcess.spawn(appImagePath, [], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, APPIMAGE_SILENT_INSTALL: "true" },
    });
    child.on("error", (error) => {
      logger.error(`Safe AppImage install relaunch failed: ${String(error)}`);
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`Safe AppImage install relaunch failed for ${appImagePath}`);
    }
    logger.info(`Safe AppImage install relaunched pid ${child.pid}`);
  } else {
    NodeChildProcess.execFileSync(appImagePath, [], {
      env: { ...process.env, APPIMAGE_EXIT_AFTER_INSTALL: "true" },
    });
  }

  // Mirror stock quitAndInstall: emit before-quit-for-update, then quit on next tick.
  setImmediate(() => {
    Electron.autoUpdater.emit("before-quit-for-update");
    Electron.app.quit();
  });
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronUpdater.of({
  setFeedURL: (options) =>
    Effect.suspend(() => {
      autoUpdater.setFeedURL(options);
      return Effect.void;
    }),
  setAutoDownload: (value) =>
    Effect.suspend(() => {
      autoUpdater.autoDownload = value;
      return Effect.void;
    }),
  setAutoInstallOnAppQuit: (value) =>
    Effect.suspend(() => {
      autoUpdater.autoInstallOnAppQuit = value;
      return Effect.void;
    }),
  setChannel: (channel) =>
    Effect.suspend(() => {
      autoUpdater.channel = channel;
      return Effect.void;
    }),
  setAllowPrerelease: (value) =>
    Effect.suspend(() => {
      autoUpdater.allowPrerelease = value;
      return Effect.void;
    }),
  allowDowngrade: Effect.sync(() => autoUpdater.allowDowngrade),
  setAllowDowngrade: (value) =>
    Effect.suspend(() => {
      autoUpdater.allowDowngrade = value;
      return Effect.void;
    }),
  setFullChangelog: (value) =>
    Effect.suspend(() => {
      autoUpdater.fullChangelog = value;
      return Effect.void;
    }),
  setDisableDifferentialDownload: (value) =>
    Effect.suspend(() => {
      autoUpdater.disableDifferentialDownload = value;
      return Effect.void;
    }),
  setLogger: (logger) =>
    Effect.suspend(() => {
      autoUpdater.logger = logger;
      return Effect.void;
    }),
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
  quitAndInstall: ({ isSilent, isForceRunAfter }) =>
    HostProcessPlatform.pipe(
      Effect.flatMap((platform) =>
        Effect.suspend(() => {
          const channel = autoUpdater.channel;
          return Effect.try({
            try: () => {
              // Stock AppImageUpdater.doInstall unlinks $APPIMAGE first, then `mv -f`s the
              // cached download across filesystems with no verification — a short copy bricks
              // the install as a 0-byte binary with no log line (see #10685). AppImage installs
              // bypass it with a staged, verified, atomic swap; every other target keeps stock.
              if (shouldUseSafeAppImageInstall(platform)) {
                quitAndInstallAppImage(isForceRunAfter);
                return;
              }
              autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
            },
            catch: (cause) =>
              new ElectronUpdaterQuitAndInstallError({
                channel,
                isSilent,
                isForceRunAfter,
                cause,
              }),
          });
        }),
      ),
    ),
  on: (eventName, listener) => {
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
  },
});

export const layer = Layer.succeed(ElectronUpdater, make);

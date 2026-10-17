// @effect-diagnostics nodeBuiltinImport:off - electron-updater calls doInstall synchronously while the app quits.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { AppImageUpdater } from "electron-updater";

type CopyFile = (from: string, to: string) => void;
type InstallLogger = NonNullable<AppImageUpdater["logger"]>;

const copyExclusive: CopyFile = (from, to) =>
  NodeFS.copyFileSync(from, to, NodeFS.constants.COPYFILE_EXCL);

function syncFile(path: string): void {
  const fd = NodeFS.openSync(path, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

function sha512Base64(file: string): string {
  const hash = NodeCrypto.createHash("sha512");
  const fd = NodeFS.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read: number;
    while ((read = NodeFS.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  return hash.digest("base64");
}

/**
 * Puts a downloaded AppImage in place, keeping the old one until the new one
 * is verified. Returns the installed path, which follows electron-updater's
 * naming: a custom name without a version is replaced, and a versioned name
 * gets the update's versioned name beside it.
 */
export function installAppImageUpdate(input: {
  readonly appImageFile: string;
  readonly installerPath: string;
  readonly sha512: string;
  readonly size?: number | undefined;
  readonly logger?: InstallLogger | undefined;
  readonly copyFile?: CopyFile;
}): string {
  const existingBaseName = NodePath.basename(input.appImageFile);
  const destination =
    NodePath.basename(input.installerPath) === existingBaseName ||
    !/\d+\.\d+\.\d+/.test(existingBaseName)
      ? input.appImageFile
      : NodePath.join(NodePath.dirname(input.appImageFile), NodePath.basename(input.installerPath));
  const sourceSize = NodeFS.statSync(input.installerPath).size;
  if (sourceSize === 0 || (input.size !== undefined && sourceSize !== input.size)) {
    throw new Error("The downloaded update has an invalid size.");
  }
  // A private directory prevents another attempt or a pre-existing symlink
  // from sharing our stage. The final rename stays on the app's filesystem.
  // A fixed prefix keeps a long AppImage name from making the stage name
  // longer than the filesystem allows.
  const stageDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodePath.dirname(destination), ".t3code-update-"),
  );
  const staged = NodePath.join(stageDirectory, "update.AppImage");
  const cleanup = (path: string, directory = false) => {
    try {
      // Equal realpaths protect filesystems with unstable inode numbers.
      // A matching device and inode also covers mount aliases such as a
      // bind mount, which realpath does not resolve.
      if (!directory) {
        const file = NodeFS.statSync(path, { bigint: true });
        const installed = NodeFS.statSync(destination, { bigint: true });
        if (
          NodeFS.realpathSync(path) === NodeFS.realpathSync(destination) ||
          (file.dev === installed.dev && file.ino === installed.ino)
        )
          return;
      }
      NodeFS.rmSync(path, { force: true, recursive: directory });
    } catch (error) {
      input.logger?.warn(
        `AppImage update cleanup failed (${path}) ${String(error)}`.slice(0, 2048),
      );
    }
  };
  try {
    input.logger?.info("AppImage update stage started");
    (input.copyFile ?? copyExclusive)(input.installerPath, staged);
    const stagedSize = NodeFS.statSync(staged).size;
    // Cached update-info.json has no size. In that case require a nonempty
    // source, an equal staged length, and the downloaded SHA-512 below.
    if (stagedSize === 0 || stagedSize !== sourceSize) {
      throw new Error("The copied update has an invalid size.");
    }
    if (sha512Base64(staged) !== input.sha512) {
      throw new Error(`The copied update at ${staged} does not match the downloaded update.`);
    }
    NodeFS.chmodSync(staged, 0o755);
    syncFile(staged);
    input.logger?.info(`AppImage update verified (${stagedSize} bytes)`);
    NodeFS.renameSync(staged, destination);
  } catch (error) {
    cleanup(stageDirectory, true);
    throw error;
  }
  input.logger?.info("AppImage update committed");
  try {
    syncFile(NodePath.dirname(destination));
  } catch (error) {
    // The replacement is already committed. A filesystem without directory
    // fsync support must not turn it into an install failure.
    input.logger?.warn(`AppImage update directory sync failed ${String(error)}`.slice(0, 2048));
  }
  cleanup(stageDirectory, true);
  if (destination !== input.appImageFile) cleanup(input.appImageFile);
  cleanup(input.installerPath);
  return destination;
}

interface AppImageUpdaterInternals {
  readonly installerPath: string | null;
  readonly downloadedUpdateHelper: {
    readonly downloadedFileInfo: { readonly sha512: string } | null;
    readonly fileInfo?: { readonly info: { readonly size?: number } } | null;
  } | null;
  readonly logger: InstallLogger | null;
  spawnLog(cmd: string, args: Array<string>, env: NodeJS.ProcessEnv): Promise<boolean>;
  emit(event: string, ...args: Array<unknown>): boolean;
  dispatchError(error: Error): void;
  doInstall(options: { readonly isForceRunAfter: boolean }): boolean;
}

/**
 * electron-updater's AppImage install deletes the running AppImage, then moves
 * the download over from its cache. Across filesystems that move is a copy,
 * and a failed copy leaves no working AppImage, so the app never launches
 * again (#10685). This replaces that step with installAppImageUpdate and keeps
 * the rest: the same destination, the rename event, and the relaunch.
 */
export function verifyAppImageInstalls(
  updater: AppImageUpdater,
  copyFile: CopyFile = copyExclusive,
): void {
  const internals = updater as unknown as AppImageUpdaterInternals;
  internals.doInstall = function (this: AppImageUpdaterInternals, options) {
    try {
      const appImageFile = process.env.APPIMAGE;
      if (
        appImageFile === undefined ||
        !NodePath.isAbsolute(appImageFile) ||
        appImageFile.includes("\0")
      ) {
        throw new Error(`APPIMAGE is not a valid absolute path: "${appImageFile ?? ""}"`);
      }
      const installerPath = this.installerPath;
      const sha512 = this.downloadedUpdateHelper?.downloadedFileInfo?.sha512;
      if (installerPath === null || sha512 === undefined) {
        throw new Error("No update filepath provided, can't quit and install");
      }
      const destination = installAppImageUpdate({
        appImageFile,
        installerPath,
        sha512,
        size: this.downloadedUpdateHelper?.fileInfo?.info.size,
        logger: this.logger ?? undefined,
        copyFile,
      });
      if (destination !== appImageFile) {
        this.emit("appimage-filename-updated", destination);
      }
      const env: NodeJS.ProcessEnv = { ...process.env, APPIMAGE_SILENT_INSTALL: "true" };
      if (options.isForceRunAfter) {
        void this.spawnLog(destination, [], env);
      } else {
        env.APPIMAGE_EXIT_AFTER_INSTALL = "true";
        NodeChildProcess.execFileSync(destination, [], { env });
      }
      return true;
    } catch (error) {
      this.logger?.error(`AppImage update install failed ${String(error)}`.slice(0, 2048));
      throw error;
    }
  };
}

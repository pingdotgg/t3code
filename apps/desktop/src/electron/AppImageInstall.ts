// @effect-diagnostics nodeBuiltinImport:off - electron-updater installs synchronously while the app quits.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { AppImageUpdater } from "electron-updater";
import type { InstallOptions } from "electron-updater/out/BaseUpdater.js";

function syncPath(path: string): void {
  const fd = NodeFS.openSync(path, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

function verifyAndSync(path: string, sourceSize: number, sha512: string): void {
  const fd = NodeFS.openSync(path, "r");
  try {
    if (NodeFS.fstatSync(fd).size !== sourceSize) {
      throw new Error("The AppImage update has an invalid size.");
    }
    const hash = NodeCrypto.createHash("sha512");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read: number;
    while ((read = NodeFS.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
    if (hash.digest("base64") !== sha512) {
      throw new Error("The AppImage update has an invalid SHA-512 digest.");
    }
    NodeFS.fchmodSync(fd, 0o755);
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

// A partial cross-device move would truncate the app, so copy into a private stage
// on the destination filesystem, verify it, then rename it into place.
function installAcrossFilesystems(
  input: { readonly installerPath: string; readonly sha512: string },
  destination: string,
  sourceSize: number,
  bestEffort: (operation: () => void) => void,
): void {
  const stageDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodePath.dirname(destination), ".t3code-update-"),
  );
  const staged = NodePath.join(stageDirectory, "update.AppImage");
  try {
    NodeFS.copyFileSync(input.installerPath, staged, NodeFS.constants.COPYFILE_EXCL);
    verifyAndSync(staged, sourceSize, input.sha512);
    NodeFS.renameSync(staged, destination);
  } finally {
    bestEffort(() => NodeFS.rmSync(stageDirectory, { recursive: true, force: true }));
  }
}

export function installAppImageUpdate(input: {
  readonly appImageFile: string;
  readonly installerPath: string;
  readonly sha512: string;
  readonly size?: number | undefined;
  readonly logger?: NonNullable<AppImageUpdater["logger"]> | undefined;
}): string {
  const installedName = NodePath.basename(input.appImageFile);
  // Match electron-updater: retain custom names, but advance versioned filenames.
  const destination = /\d+\.\d+\.\d+/.test(installedName)
    ? NodePath.join(NodePath.dirname(input.appImageFile), NodePath.basename(input.installerPath))
    : input.appImageFile;
  const sourceSize = NodeFS.statSync(input.installerPath).size;
  if (sourceSize === 0 || (input.size !== undefined && sourceSize !== input.size)) {
    throw new Error("The downloaded AppImage update has an invalid size.");
  }

  const bestEffort = (operation: () => void) => {
    try {
      operation();
    } catch (error) {
      try {
        input.logger?.warn(`AppImage update cleanup or directory sync failed: ${String(error)}`);
      } catch {
        // Logging must not turn a committed replacement into an installation failure.
      }
    }
  };
  const removeObsolete = (path: string) =>
    bestEffort(() => {
      const file = NodeFS.statSync(path, { bigint: true });
      const installed = NodeFS.statSync(destination, { bigint: true });
      // realpath covers symlinks; device/inode identity also covers bind mounts.
      if (
        NodeFS.realpathSync(path) === NodeFS.realpathSync(destination) ||
        (file.dev === installed.dev && file.ino === installed.ino)
      ) {
        return;
      }
      NodeFS.rmSync(path, { force: true });
    });

  verifyAndSync(input.installerPath, sourceSize, input.sha512);
  let copied = false;
  try {
    // Same filesystem: an atomic rename, like electron-updater's own `mv`, needs no extra space.
    NodeFS.renameSync(input.installerPath, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    installAcrossFilesystems(input, destination, sourceSize, bestEffort);
    copied = true;
  }

  bestEffort(() => syncPath(NodePath.dirname(destination)));
  if (destination !== input.appImageFile) removeObsolete(input.appImageFile);
  if (copied) removeObsolete(input.installerPath);
  return destination;
}

// These protected/private members belong to electron-updater 6.8.9. Keep the
// override at doInstall so BaseUpdater still owns quit handling and errors.
interface AppImageUpdaterInternals {
  readonly installerPath: string | null;
  readonly downloadedUpdateHelper: {
    readonly downloadedFileInfo: { readonly sha512: string } | null;
    readonly fileInfo: { readonly info: { readonly size?: number } } | null;
  } | null;
  readonly logger: AppImageUpdater["logger"];
  emit: AppImageUpdater["emit"];
  spawnLog(command: string, args: Array<string>, env: NodeJS.ProcessEnv): Promise<boolean>;
  doInstall(options: InstallOptions): boolean;
}

export function verifyAppImageInstalls(updater: AppImageUpdater): void {
  const internals = updater as unknown as AppImageUpdaterInternals;
  internals.doInstall = function (options) {
    const appImageFile = process.env.APPIMAGE;
    if (
      appImageFile === undefined ||
      !NodePath.isAbsolute(appImageFile) ||
      appImageFile.includes("\0")
    ) {
      throw new Error("APPIMAGE is not a valid absolute path.");
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
  };
}

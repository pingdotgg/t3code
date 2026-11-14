// @effect-diagnostics nodeBuiltinImport:off - electron-updater installs synchronously while the app quits.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { AppImageUpdater } from "electron-updater";

function syncPath(path: string): void {
  const fd = NodeFS.openSync(path, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

function verifyAndSyncStage(path: string, sourceSize: number, sha512: string): void {
  const fd = NodeFS.openSync(path, "r");
  try {
    if (NodeFS.fstatSync(fd).size !== sourceSize) {
      throw new Error("The copied AppImage update has an invalid size.");
    }
    const hash = NodeCrypto.createHash("sha512");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read: number;
    while ((read = NodeFS.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
    if (hash.digest("base64") !== sha512) {
      throw new Error("The copied AppImage update has an invalid SHA-512 digest.");
    }
    NodeFS.fchmodSync(fd, 0o755);
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
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

  // A private stage on the destination filesystem allows an atomic rename. Its
  // fixed-length name also accommodates AppImage names near the filename limit.
  const stageDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodePath.dirname(destination), ".t3code-update-"),
  );
  const staged = NodePath.join(stageDirectory, "update.AppImage");
  try {
    NodeFS.copyFileSync(input.installerPath, staged, NodeFS.constants.COPYFILE_EXCL);
    verifyAndSyncStage(staged, sourceSize, input.sha512);
    NodeFS.renameSync(staged, destination);
  } finally {
    bestEffort(() => NodeFS.rmSync(stageDirectory, { recursive: true, force: true }));
  }

  bestEffort(() => syncPath(NodePath.dirname(destination)));
  if (destination !== input.appImageFile) removeObsolete(input.appImageFile);
  removeObsolete(input.installerPath);
  return destination;
}

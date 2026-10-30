// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary spawns native capture tools and reads their temporary output with Node.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import * as Electron from "electron";
import type { ActiveWindow } from "./ActiveWindow.ts";

const MAC_SCREEN_CAPTURE_PATH = "/usr/sbin/screencapture";
const MAC_SCREEN_CAPTURE_TIMEOUT_MS = 15_000;
const MAC_REGION_SELECTION_TIMEOUT_MS = 120_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type MacSnapShotSource = {
  readonly appIcon?: Electron.NativeImage;
  readonly name: string;
};

function runMacScreenCapture(args: ReadonlyArray<string>, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(MAC_SCREEN_CAPTURE_PATH, args, { timeout }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readMacSnapShot(outputPath: string, maxSize: Electron.Size): Promise<Buffer> {
  const capturedPng = await NodeFSP.readFile(outputPath);
  if (
    capturedPng.length < PNG_SIGNATURE.length ||
    !capturedPng.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error("macOS returned an invalid snapshot.");
  }
  const image = Electron.nativeImage.createFromBuffer(capturedPng);
  if (image.isEmpty()) throw new Error("macOS returned an invalid snapshot.");
  const size = image.getSize();
  const scale = Math.min(maxSize.width / size.width, maxSize.height / size.height, 1);
  const png =
    scale < 1
      ? image
          .resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: "best",
          })
          .toPNG()
      : capturedPng;
  if (png !== capturedPng) await NodeFSP.writeFile(outputPath, png);
  return png;
}

export async function captureMacWindowSnapshot(
  active: ActiveWindow,
  outputPath: string,
  maxSize: Electron.Size,
): Promise<{ readonly source: MacSnapShotSource; readonly png: Buffer }> {
  await runMacScreenCapture(
    ["-l", String(active.id), "-o", "-x", "-t", "png", outputPath],
    MAC_SCREEN_CAPTURE_TIMEOUT_MS,
  );
  return {
    source: {
      name: active.title.trim() || active.owner.name.trim() || "Window",
    },
    png: await readMacSnapShot(outputPath, maxSize),
  };
}

/** Resolves `undefined` when the user cancels the selection. */
export async function captureMacRegionSnapshot(
  outputPath: string,
  maxSize: Electron.Size,
): Promise<{ readonly source: MacSnapShotSource; readonly png: Buffer } | undefined> {
  await runMacScreenCapture(
    ["-i", "-s", "-x", "-t", "png", outputPath],
    MAC_REGION_SELECTION_TIMEOUT_MS,
  );
  // Escape exits successfully without writing the file.
  const selected = await NodeFSP.access(outputPath).then(
    () => true,
    () => false,
  );
  if (!selected) return undefined;
  return {
    source: { name: "Screen region" },
    png: await readMacSnapShot(outputPath, maxSize),
  };
}

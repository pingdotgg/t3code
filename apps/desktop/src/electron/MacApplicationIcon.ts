// @effect-diagnostics nodeBuiltinImport:off - macOS bundle paths use the host path grammar.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Electron from "electron";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

async function resolveBundleIconPath(applicationPath: string): Promise<string | null> {
  const infoPlistPath = NodePath.join(applicationPath, "Contents", "Info.plist");
  const { stdout } = await execFile(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIconFile", "raw", infoPlistPath],
    { encoding: "utf8" },
  );
  const configuredName = stdout.trim();
  if (
    configuredName.length === 0 ||
    NodePath.basename(configuredName) !== configuredName ||
    configuredName === "." ||
    configuredName === ".."
  ) {
    return null;
  }
  const iconName = NodePath.extname(configuredName) ? configuredName : `${configuredName}.icns`;
  const iconPath = NodePath.join(applicationPath, "Contents", "Resources", iconName);
  const stat = await NodeFSP.stat(iconPath);
  return stat.isFile() ? iconPath : null;
}

async function convertIcnsToDataUrl(iconPath: string): Promise<string> {
  const temporaryDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3code-open-with-icon-"),
  );
  const pngPath = NodePath.join(temporaryDirectory, "icon.png");
  try {
    await execFile("/usr/bin/sips", ["-s", "format", "png", iconPath, "--out", pngPath]);
    const png = await NodeFSP.readFile(pngPath);
    const image = Electron.nativeImage.createFromBuffer(png);
    if (image.isEmpty()) throw new Error("The converted application icon is empty.");
    return image.toDataURL();
  } finally {
    await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Electron's macOS file-icon lookup can return the generic application-bundle icon for a
 * `.app` directory. Prefer the bundle's declared ICNS asset when it can be read, then use
 * Electron's system lookup for asset-catalog apps and all failure cases.
 */
export async function resolveMacApplicationIconDataUrl(applicationPath: string): Promise<string> {
  try {
    const iconPath = await resolveBundleIconPath(applicationPath);
    if (iconPath !== null) return await convertIcnsToDataUrl(iconPath);
  } catch {
    // Fall through to Electron's system icon lookup.
  }
  return (await Electron.app.getFileIcon(applicationPath, { size: "large" })).toDataURL();
}

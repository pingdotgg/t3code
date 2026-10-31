// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// Electron's Linux zips can ship world-writable files (44.10.0 has 0777 binaries), and
// electron-builder copies zip modes verbatim into the .deb and AppImage.
export default async function afterPack(context: { readonly appOutDir: string }): Promise<void> {
  await removeSharedWriteAccess(context.appOutDir);
}

// Walks by hand: recursive readdir follows directory symlinks out of the app folder.
async function removeSharedWriteAccess(path: string): Promise<void> {
  const stats = await NodeFSP.lstat(path);
  if (stats.isSymbolicLink()) return;
  if (stats.mode & 0o022) await NodeFSP.chmod(path, stats.mode & 0o7755);
  if (!stats.isDirectory()) return;
  for (const entry of await NodeFSP.readdir(path)) {
    await removeSharedWriteAccess(NodePath.join(path, entry));
  }
}

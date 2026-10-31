// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// Electron's Linux zips can ship world-writable files (44.10.0 has 0777 binaries), and
// electron-builder copies zip modes verbatim into the .deb and AppImage.
export default async function afterPack(context: { readonly appOutDir: string }): Promise<void> {
  const entries = await NodeFSP.readdir(context.appOutDir, {
    recursive: true,
    withFileTypes: true,
  });
  const paths = [
    context.appOutDir,
    ...entries.map((entry) => NodePath.join(entry.parentPath, entry.name)),
  ];
  for (const path of paths) {
    const stats = await NodeFSP.lstat(path);
    if (stats.isSymbolicLink() || (stats.mode & 0o022) === 0) continue;
    await NodeFSP.chmod(path, stats.mode & 0o7755);
  }
}

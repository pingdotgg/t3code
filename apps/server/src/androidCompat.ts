import * as NodeModule from "node:module";

const requireBuiltin = NodeModule.createRequire(import.meta.url);

const PATCHED_SYMBOL = Symbol.for("t3code.androidHardlinkFallbackPatched");

type PathLike = Parameters<typeof import("node:fs").link>[0];
type NoParamCallback = Parameters<typeof import("node:fs").link>[2];

type PatchableFs = {
  link: (existingPath: PathLike, newPath: PathLike, callback: NoParamCallback) => void;
  linkSync: (existingPath: PathLike, newPath: PathLike) => void;
  copyFile: (src: PathLike, dest: PathLike, mode: number, callback: NoParamCallback) => void;
  copyFileSync: (src: PathLike, dest: PathLike, mode?: number) => void;
  readonly constants: { readonly COPYFILE_EXCL: number };
  readonly promises: {
    link: (existingPath: PathLike, newPath: PathLike) => Promise<void>;
    copyFile: (src: PathLike, dest: PathLike, mode?: number) => Promise<void>;
  };
  [PATCHED_SYMBOL]?: boolean;
};

function isHardlinkBlocked(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Android SELinux blocks hardlinks (`link(2)` fails with EACCES/EPERM).
 * Fall back to exclusive copy (`COPYFILE_EXCL`) so `EEXIST` semantics are preserved.
 */
export function patchAndroidHardlinkFallback(
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before ACP dispatch without loading the Effect graph.
  platform: NodeJS.Platform = process.platform,
  fsModule?: PatchableFs,
): void {
  if (platform !== "android") return;

  const isBuiltinFs = fsModule === undefined;
  const fs = fsModule ?? (requireBuiltin("node:fs") as PatchableFs);
  if (fs[PATCHED_SYMBOL]) return;
  fs[PATCHED_SYMBOL] = true;

  const origLink = fs.link;
  const origLinkSync = fs.linkSync;
  const origPromisesLink = fs.promises.link;

  fs.link = function patchedLink(existingPath, newPath, callback) {
    origLink(existingPath, newPath, (err) => {
      if (err && isHardlinkBlocked(err)) {
        fs.copyFile(existingPath, newPath, fs.constants.COPYFILE_EXCL, callback);
        return;
      }
      callback(err);
    });
  };

  fs.linkSync = function patchedLinkSync(existingPath, newPath) {
    try {
      origLinkSync(existingPath, newPath);
    } catch (err) {
      if (isHardlinkBlocked(err)) {
        fs.copyFileSync(existingPath, newPath, fs.constants.COPYFILE_EXCL);
        return;
      }
      throw err;
    }
  };

  fs.promises.link = async function patchedPromisesLink(existingPath, newPath) {
    try {
      await origPromisesLink(existingPath, newPath);
    } catch (err) {
      if (isHardlinkBlocked(err)) {
        await fs.promises.copyFile(existingPath, newPath, fs.constants.COPYFILE_EXCL);
        return;
      }
      throw err;
    }
  };

  if (isBuiltinFs) {
    NodeModule.syncBuiltinESMExports();
  }
}

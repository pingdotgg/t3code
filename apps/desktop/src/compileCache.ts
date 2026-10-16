// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Linux uses the user's cache dir because /tmp is shared between users; the macOS and Windows
// temp dirs are already per user. Skipped under AppImage: it mounts the app at a new
// /tmp/.mount_* path each launch, and Node keys entries by path, so every launch would miss
// and leave another copy behind.
try {
  if (!process.env.APPIMAGE) {
    const cacheRoot =
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Loads before any Effect runtime.
      process.platform === "linux"
        ? process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache")
        : NodeOS.tmpdir();
    NodeModule.enableCompileCache(NodePath.join(cacheRoot, "t3code", "compile-cache"));
  }
} catch {}

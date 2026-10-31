// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Linux /tmp is shared; macOS and Windows temp dirs are per user.
// AppImage mounts change paths each launch, so Node's path-keyed cache would miss and accumulate copies.
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

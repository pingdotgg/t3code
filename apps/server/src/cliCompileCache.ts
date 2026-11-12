// @effect-diagnostics nodeBuiltinImport:off -- Runs before the CLI's Effect runtime loads.
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";

export function enableCliCompileCache(): void {
  try {
    // AppImage paths change each launch; SEA has no separate modules to cache.
    if (process.env.APPIMAGE || NodeSea.isSea()) return;
    const cacheRoot =
      process.env.XDG_CACHE_HOME ||
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before the CLI's Effect runtime loads.
      (process.platform === "linux" ? NodePath.join(NodeOS.homedir(), ".cache") : NodeOS.tmpdir());
    NodeModule.enableCompileCache(NodePath.join(cacheRoot, "t3code", "compile-cache"));
  } catch {}
}

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { enablePreparedServerCache } from "../../../scripts/lib/server-compile-cache.ts";
import { enablePackagedCompileCache } from "./packagedCompileCache.ts";

// Linux /tmp is shared; macOS and Windows temp dirs are per user.
try {
  const packagedDirectory = NodePath.resolve(__dirname, "../../../../compile-cache");
  const manifestPath = NodePath.join(packagedDirectory, "runtime.json");
  const cacheRoot =
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before the Effect runtime.
    process.platform === "linux"
      ? process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache")
      : NodeOS.tmpdir();
  const directory = NodePath.join(cacheRoot, "t3code", "compile-cache");
  const preparedManifest = NodePath.resolve(
    __dirname,
    "../../../../server-compile-cache/manifest.json",
  );
  if (process.env.ELECTRON_RUN_AS_NODE === "1" && NodeFS.existsSync(preparedManifest)) {
    enablePreparedServerCache(process.argv[1] ?? "", directory);
  } else if (NodeFS.existsSync(manifestPath)) {
    enablePackagedCompileCache(NodePath.dirname(packagedDirectory));
  } else if (
    process.env.ELECTRON_RUN_AS_NODE === "1" ||
    (!__dirname.includes("app.asar") && !process.env.APPIMAGE)
  ) {
    const prepared =
      process.env.ELECTRON_RUN_AS_NODE === "1" &&
      enablePreparedServerCache(process.argv[1] ?? "", directory);
    if (!prepared && !process.env.APPIMAGE) {
      NodeModule.enableCompileCache(directory);
    }
  }
} catch {}

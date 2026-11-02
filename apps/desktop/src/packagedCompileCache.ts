// @effect-diagnostics nodeBuiltinImport:off - Runs before the application runtime.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeV8 from "node:v8";
import * as NodeZlib from "node:zlib";

interface PackagedCache {
  readonly node: string;
  readonly v8: string;
  readonly electron?: string;
  readonly arch: string;
  readonly tag: number;
  readonly cacheDirectory: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly type: number;
    readonly target: "main" | "server";
    readonly cache: string;
  }>;
}

export function enablePackagedCompileCache(resources: string): boolean {
  const directory = NodePath.join(resources, "compile-cache");
  const runtime: PackagedCache = JSON.parse(
    NodeFS.readFileSync(NodePath.join(directory, "runtime.json"), "utf8"),
  );
  if (
    runtime.node !== process.versions.node ||
    runtime.v8 !== process.versions.v8 ||
    runtime.electron !== process.versions.electron ||
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before the application runtime.
    runtime.arch !== process.arch ||
    runtime.tag !== NodeV8.cachedDataVersionTag()
  )
    return false;

  if (process.getuid === undefined) {
    return (
      NodeModule.enableCompileCache({ directory, portable: true }).status ===
      NodeModule.constants.compileCacheStatus.ENABLED
    );
  }

  // Node salts directories with uid; a read-only bridge also keeps cache misses out of app resources.
  const bridge = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-compile-"));
  let versionDirectory: string | undefined;
  const cleanup = () => {
    try {
      if (versionDirectory !== undefined) NodeFS.chmodSync(versionDirectory, 0o755);
      NodeFS.rmSync(bridge, { recursive: true, force: true });
    } catch {}
  };
  try {
    const result = NodeModule.enableCompileCache(bridge);
    if (result.status !== NodeModule.constants.compileCacheStatus.ENABLED) {
      cleanup();
      return false;
    }
    versionDirectory = NodePath.join(bridge, NodeFS.readdirSync(bridge)[0]!);
    const target =
      process.versions.electron !== undefined && process.env.ELECTRON_RUN_AS_NODE !== "1"
        ? "main"
        : "server";
    for (const file of runtime.files) {
      if (file.target !== target) continue;
      const filename = NodePath.resolve(resources, file.path);
      const key = file.type === 0 ? filename : NodeURL.pathToFileURL(filename).href;
      // Node's version-pinned key is CRC32(code type byte, filename); source hashes remain authoritative.
      const hash = NodeZlib.crc32(Buffer.concat([Buffer.from([file.type]), Buffer.from(key)]))
        .toString(16)
        .padStart(8, "0");
      NodeFS.symlinkSync(
        NodePath.join(directory, runtime.cacheDirectory, file.cache),
        NodePath.join(versionDirectory, hash),
      );
    }
    NodeFS.chmodSync(versionDirectory, 0o555);
    process.once("exit", cleanup);
    return true;
  } catch {
    cleanup();
    return false;
  }
}

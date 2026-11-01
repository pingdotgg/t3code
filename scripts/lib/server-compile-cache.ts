/* oxlint-disable t3code/no-global-process-runtime -- Runs in the packaged engine before an Effect runtime exists. */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeV8 from "node:v8";
import * as NodeZlib from "node:zlib";
import * as NodeURL from "node:url";

export const runtimeIdentity = () =>
  [
    process.versions.electron,
    process.version,
    process.platform,
    process.arch,
    NodeV8.cachedDataVersionTag(),
  ].join("-");

// Node 24's portable key is CRC32 of the one-byte ESM type followed by the relative filename.
// Generation verifies this against files produced by the packaged engine before shipping them.
export const cacheKey = (active: string, filename: string) =>
  NodeZlib.crc32(NodePath.relative(active, filename), NodeZlib.crc32(Buffer.from([1])))
    .toString(16)
    .padStart(8, "0");

export function seedPreparedCache(prepared: string, active: string, runtime: string): boolean {
  try {
    const manifest: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(prepared, "manifest.json"), "utf8"),
    );
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("format" in manifest) ||
      manifest.format !== 1 ||
      !("runtime" in manifest) ||
      manifest.runtime !== runtime ||
      !("entries" in manifest) ||
      !Array.isArray(manifest.entries) ||
      manifest.entries.length === 0
    )
      return false;
    for (const entry of manifest.entries) {
      if (
        typeof entry?.module !== "string" ||
        typeof entry?.file !== "string" ||
        !/^[a-f0-9]{8}$/.test(entry.file) ||
        !/^(app|server)\.asar\/apps\/server\/dist\/[^/\\]+\.mjs$/.test(entry.module)
      )
        return false;
      const source = NodePath.join(prepared, entry.file);
      const destination = NodePath.join(
        active,
        cacheKey(active, NodePath.join(NodePath.dirname(prepared), entry.module)),
      );
      try {
        // Node replaces cache files atomically. A directory link would instead allow writes into signed resources.
        if (process.platform === "win32") NodeFS.linkSync(source, destination);
        else NodeFS.symlinkSync(source, destination);
      } catch {}
      if (!NodeFS.existsSync(destination)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function enablePreparedServerCache(entry: string, cacheRoot: string): boolean {
  try {
    const archive = entry.match(/^(.*[\\/](?:app|server)\.asar)[\\/]/)?.[1];
    if (!archive) return false;
    const resources = NodeFS.realpathSync(NodePath.dirname(archive));
    // Keep different installations and builds separate without reading or copying their source files.
    const prepared = NodePath.join(resources, "server-compile-cache");
    if (process.env.APPIMAGE && !NodeFS.existsSync(NodePath.join(prepared, "manifest.json")))
      return false;
    const identity = NodeZlib.crc32(resources).toString(16);
    NodeFS.mkdirSync(NodePath.join(cacheRoot, "server"), { recursive: true });
    const directory = process.env.APPIMAGE
      ? NodeFS.mkdtempSync(NodePath.join(cacheRoot, "server", "appimage-"))
      : NodePath.join(cacheRoot, "server", identity);
    if (process.env.APPIMAGE) {
      // Each mount has different module paths; discard its links rather than accumulating caches.
      process.once("exit", () => {
        try {
          NodeFS.rmSync(directory, { recursive: true, force: true });
        } catch {}
      });
    }
    const result = NodeModule.enableCompileCache({
      directory,
      portable: true,
    });
    const active = NodeModule.getCompileCacheDir();
    if (result.status !== NodeModule.constants.compileCacheStatus.ENABLED || !active) return false;
    const seeded = seedPreparedCache(prepared, active, runtimeIdentity());
    if (seeded) Reflect.set(globalThis, Symbol.for("t3code.preparedServerCache"), true);
    return true;
  } catch {
    return false;
  }
}

export async function generatePreparedServerCache(resourcesInput: string): Promise<void> {
  const resources = NodeFS.realpathSync(resourcesInput);
  const prepared = NodePath.join(resources, "server-compile-cache");
  const archive = NodeFS.existsSync(NodePath.join(resources, "server.asar"))
    ? "server.asar"
    : "app.asar";
  const dist = NodePath.join(resources, archive, "apps/server/dist");
  NodeFS.mkdirSync(prepared, { recursive: true });
  const result = NodeModule.enableCompileCache({ directory: prepared, portable: true });
  if (result.status !== NodeModule.constants.compileCacheStatus.ENABLED)
    throw new Error("Cannot enable release compile cache");
  const cli = NodeFS.readdirSync(dist).find((file) => /^binCli-.*\.mjs$/.test(file));
  if (!cli) throw new Error("Missing bundled server CLI");
  await import(NodeURL.pathToFileURL(NodePath.join(dist, cli)).href);
  NodeModule.flushCompileCache();
  const active = NodeModule.getCompileCacheDir()!;
  const entries = NodeFS.readdirSync(dist)
    .filter((file) => file.endsWith(".mjs"))
    .flatMap((file) => {
      const key = cacheKey(active, NodePath.join(dist, file));
      if (!NodeFS.existsSync(NodePath.join(active, key))) return [];
      NodeFS.copyFileSync(NodePath.join(active, key), NodePath.join(prepared, key));
      return [{ module: `${archive}/apps/server/dist/${file}`, file: key }];
    });
  if (!entries.some((entry) => entry.module.endsWith(`/${cli}`)))
    throw new Error("Packaged engine cache key format is unsupported");
  NodeFS.writeFileSync(
    NodePath.join(prepared, "manifest.json"),
    JSON.stringify({ format: 1, runtime: runtimeIdentity(), entries }),
  );
  NodeFS.rmSync(active, { recursive: true });
}

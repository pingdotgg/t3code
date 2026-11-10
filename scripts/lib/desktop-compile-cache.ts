// @effect-diagnostics nodeBuiltinImport:off - electron-builder calls this hook outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// Main-process bytecode only; prepare-server-compile-cache.cjs prepares the backend.
export async function prebuildDesktopCompileCache(resources: string, executable: string) {
  const directory = NodePath.join(resources, "compile-cache");
  await NodeFSP.mkdir(directory, { recursive: true });
  // Use the packaged runtime: Electron's V8 build differs from the build host's Node.
  const warmup = `
const fs = require("node:fs");
const path = require("node:path");
const moduleApi = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { crc32 } = require("node:zlib");
const resources = process.argv[1];
const directory = path.join(resources, "compile-cache");
const result = moduleApi.enableCompileCache({ directory, portable: true });
if (result.status !== moduleApi.constants.compileCacheStatus.ENABLED) throw new Error(JSON.stringify(result));
const app = path.join(resources, "app.asar");
const main = path.join(app, path.dirname(JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8")).main), "main.cjs");
const stop = Symbol("compiled");
const sources = new Map();
const hook = moduleApi.registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === pathToFileURL(main).href) throw stop;
    return next(specifier, context);
  },
  load(url, context, next) {
    const result = next(url, context);
    if (url.startsWith("file:") && (result.format === "commonjs" || result.format === "module"))
      sources.set(url, result.format === "commonjs" ? 0 : 1);
    return result;
  },
});
try { require(main); } catch (error) { if (error !== stop) throw error; }
hook.deregister();
moduleApi.flushCompileCache();
const cacheDirectory = fs.readdirSync(directory).find(name => name.startsWith("v"));
const files = [...sources].flatMap(([url, type]) => {
  const file = fileURLToPath(url);
  const relative = path.relative(path.join(directory, cacheDirectory), file).replaceAll("\\\\", "/");
  const cache = crc32(Buffer.concat([Buffer.from([type]), Buffer.from(relative)])).toString(16).padStart(8, "0");
  return fs.existsSync(path.join(directory, cacheDirectory, cache))
    ? [{ path: path.relative(resources, file), type, cache }] : [];
});
if (files.length === 0) throw new Error("Packaged compile cache is incomplete");
fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify({
  node: process.versions.node, v8: process.versions.v8, electron: process.versions.electron,
  arch: process.arch, tag: require("node:v8").cachedDataVersionTag(),
  cacheDirectory, files,
}));
`;
  NodeChildProcess.execFileSync(executable, ["-e", warmup, resources], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_COMPILE_CACHE: "" },
    stdio: "pipe",
    timeout: 60_000,
  });
  for (const entry of await NodeFSP.readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) await NodeFSP.chmod(NodePath.join(entry.parentPath, entry.name), 0o444);
  }
}

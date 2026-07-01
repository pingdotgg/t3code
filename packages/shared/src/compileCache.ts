import * as Module from "node:module";
import * as OS from "node:os";
import * as Path from "node:path";

/**
 * V8 compile cache utilities.
 *
 * The compile cache persists V8 bytecode for the modules a process loads, so
 * subsequent launches skip recompilation. On Windows this is doubly valuable:
 * cold start reads many small `node_modules` files, and each read is scanned by
 * antivirus/Defender, so cutting recompilation and repeated file access
 * materially shrinks startup latency.
 *
 * @module compileCache
 */

interface CompileCacheResult {
  readonly status: number;
  readonly message?: string;
  readonly directory?: string;
}

interface NodeModuleCompileCache {
  enableCompileCache?: (cacheDir?: string) => CompileCacheResult;
  constants?: { compileCacheStatus?: { FAILED?: number } };
}

/**
 * Environment variable Node reads at process startup to enable the compile
 * cache for every module — including an entry file's own static imports — with
 * no in-code ordering constraints. Prefer setting this on spawned child
 * processes over calling {@link enableV8CompileCache} from inside their entry.
 */
export const NODE_COMPILE_CACHE_ENV = "NODE_COMPILE_CACHE";

/**
 * Enable the V8 compile cache for the current process, best-effort.
 *
 * Safe to call on any Node version: it feature-detects `module.enableCompileCache`
 * (Node >= 22.8) and swallows failures, returning whether caching is active.
 *
 * Note: because a module's static imports are evaluated before its body runs,
 * calling this from an entry file cannot cache that entry's own first-run
 * imports. To cover those, set {@link NODE_COMPILE_CACHE_ENV} before the process
 * starts (see {@link withCompileCacheEnv}).
 */
export function enableV8CompileCache(cacheDir?: string): boolean {
  const mod = Module as unknown as NodeModuleCompileCache;
  if (typeof mod.enableCompileCache !== "function") {
    return false;
  }
  try {
    const result =
      cacheDir === undefined ? mod.enableCompileCache() : mod.enableCompileCache(cacheDir);
    const failed = mod.constants?.compileCacheStatus?.FAILED;
    return failed === undefined ? true : result.status !== failed;
  } catch {
    return false;
  }
}

/**
 * Resolve a stable, per-application compile-cache directory. Callers that own a
 * durable user-data path (e.g. Electron's `userData`) should pass it as `baseDir`
 * so the cache survives across launches; otherwise a temp-dir location is used.
 */
export function resolveCompileCacheDir(appName: string, baseDir?: string): string {
  const root = baseDir ?? OS.tmpdir();
  return Path.join(root, `${appName}-v8-compile-cache`);
}

/**
 * Return a copy of `env` with {@link NODE_COMPILE_CACHE_ENV} pointing at
 * `cacheDir`, unless the caller already set it. Use when spawning child
 * processes so their startup is fully compile-cached from the first run.
 */
export function withCompileCacheEnv(env: NodeJS.ProcessEnv, cacheDir: string): NodeJS.ProcessEnv {
  if (env[NODE_COMPILE_CACHE_ENV]) {
    return env;
  }
  return { ...env, [NODE_COMPILE_CACHE_ENV]: cacheDir };
}

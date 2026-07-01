import { describe, expect, it } from "vitest";

import {
  NODE_COMPILE_CACHE_ENV,
  enableV8CompileCache,
  resolveCompileCacheDir,
  withCompileCacheEnv,
} from "./compileCache.ts";

describe("enableV8CompileCache", () => {
  it("enables the compile cache without throwing on supported runtimes", () => {
    // Node >= 22.8 exposes module.enableCompileCache; on those runtimes this
    // returns true, and on older ones it must degrade to false rather than throw.
    const result = enableV8CompileCache();
    expect(typeof result).toBe("boolean");
  });
});

describe("resolveCompileCacheDir", () => {
  it("namespaces the cache directory by app name under the provided base dir", () => {
    expect(resolveCompileCacheDir("t3code-backend", "/data/user")).toBe(
      "/data/user/t3code-backend-v8-compile-cache",
    );
  });

  it("falls back to a temp-dir location when no base dir is given", () => {
    const dir = resolveCompileCacheDir("t3code");
    expect(dir.endsWith("t3code-v8-compile-cache")).toBe(true);
  });
});

describe("withCompileCacheEnv", () => {
  it("sets NODE_COMPILE_CACHE when unset", () => {
    const env = withCompileCacheEnv({ PATH: "/usr/bin" }, "/cache/dir");
    expect(env[NODE_COMPILE_CACHE_ENV]).toBe("/cache/dir");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("preserves a caller-provided NODE_COMPILE_CACHE", () => {
    const env = withCompileCacheEnv({ [NODE_COMPILE_CACHE_ENV]: "/existing" }, "/cache/dir");
    expect(env[NODE_COMPILE_CACHE_ENV]).toBe("/existing");
  });
});

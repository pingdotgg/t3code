import { describe, expect, it } from "vitest";
import Path from "node:path";

import {
  NODE_COMPILE_CACHE_ENV,
  resolveCompileCacheDir,
  withCompileCacheEnv,
} from "./compileCache.ts";

describe("resolveCompileCacheDir", () => {
  it("namespaces the cache directory by app name under the provided base dir", () => {
    expect(resolveCompileCacheDir("t3code-backend", Path.join("/data", "user"))).toBe(
      Path.join("/data", "user", "t3code-backend-v8-compile-cache"),
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

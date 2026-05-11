import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRenderablePatchCacheEntryCountForTests,
  getOrCreateRenderablePatch,
  primeRenderablePatchCache,
  readRenderablePatchCache,
  resetRenderablePatchCacheForTests,
} from "./diffPatchCache";

afterEach(() => {
  resetRenderablePatchCacheForTests();
  vi.restoreAllMocks();
});

describe("diffPatchCache", () => {
  it("parses once and reuses the cached renderable patch", () => {
    const patch = [
      "diff --git a/src/app.tsx b/src/app.tsx",
      "index 1111111..2222222 100644",
      "--- a/src/app.tsx",
      "+++ b/src/app.tsx",
      "@@ -1 +1,2 @@",
      " console.log('hello')",
      "+console.log('world')",
    ].join("\n");
    const first = getOrCreateRenderablePatch(patch, "cache:once");
    const second = getOrCreateRenderablePatch(patch, "cache:once");

    expect(first).toBe(second);
    expect(getRenderablePatchCacheEntryCountForTests()).toBe(1);
  });

  it("keeps different cache scopes isolated", () => {
    const patch = [
      "diff --git a/src/scope.ts b/src/scope.ts",
      "index 3333333..4444444 100644",
      "--- a/src/scope.ts",
      "+++ b/src/scope.ts",
      "@@ -1 +1,2 @@",
      " export const value = 1;",
      "+export const nextValue = 2;",
    ].join("\n");
    const first = getOrCreateRenderablePatch(patch, "cache:scope-a");
    const second = getOrCreateRenderablePatch(patch, "cache:scope-b");

    expect(first).not.toBe(second);
    expect(readRenderablePatchCache(patch, "cache:scope-a")).toBe(first);
    expect(readRenderablePatchCache(patch, "cache:scope-b")).toBe(second);
    expect(getRenderablePatchCacheEntryCountForTests()).toBe(2);
  });

  it("returns null for empty patches without poisoning the cache", () => {
    expect(getOrCreateRenderablePatch("   ", "cache:empty")).toBeNull();
    expect(readRenderablePatchCache("   ", "cache:empty")).toBeUndefined();
    expect(getRenderablePatchCacheEntryCountForTests()).toBe(0);
  });

  it("caches raw fallback results for unsupported patch content", () => {
    const patch = "this is not a unified diff";
    const first = getOrCreateRenderablePatch(patch, "cache:bad");
    const second = getOrCreateRenderablePatch(patch, "cache:bad");

    expect(first).toEqual({
      kind: "raw",
      text: patch,
      reason: "Unsupported diff format. Showing raw patch.",
    });
    expect(second).toBe(first);
    expect(getRenderablePatchCacheEntryCountForTests()).toBe(1);
  });
});

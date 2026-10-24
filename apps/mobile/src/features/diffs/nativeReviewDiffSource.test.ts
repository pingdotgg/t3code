import { expect, it, vi } from "vite-plus/test";

import { createNativeReviewDiffSourceLoader } from "./nativeReviewDiffSource";
import type { NativeReviewDiffSource } from "./nativeReviewDiffTypes";

const SOURCE = { oldContents: "const before = true;", newContents: "const after = false;" };

vi.mock("expo-file-system", () => ({
  Paths: { document: "test-documents" },
  File: class {
    create() {}
    async write() {}
  },
}));

it("does not retain oversized source text or repeatedly refetch it", async () => {
  const fetch = vi.fn(async () => ({ oldContents: "", newContents: "x".repeat(500_001) }));
  const load = createNativeReviewDiffSourceLoader(fetch);
  expect(await load("generated.ts")).toBeNull();
  expect(await load("generated.ts")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("lets later viewport requests retry a failed source fetch", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(SOURCE);
  const load = createNativeReviewDiffSourceLoader(fetch);
  await expect(load("retry.ts")).rejects.toThrow("Offline");
  expect(await load("retry.ts")).toBe(SOURCE);
});

it("serializes RPCs and drops cancelled queued files", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<NativeReviewDiffSource>();
  const fetch = vi.fn((file: string) => {
    if (file !== "active.ts") return Promise.resolve(SOURCE);
    started.resolve();
    return response.promise;
  });
  const load = createNativeReviewDiffSourceLoader(fetch);
  const active = load("active.ts");
  await started.promise;
  const controller = new AbortController();
  const queued = load("cancelled.ts", controller.signal);
  controller.abort();
  expect(await queued).toBeNull();
  expect(fetch.mock.calls).toEqual([["active.ts"]]);
  response.resolve(SOURCE);
  await active;
  await load("next.ts");
  expect(fetch.mock.calls).toEqual([["active.ts"], ["next.ts"]]);
});

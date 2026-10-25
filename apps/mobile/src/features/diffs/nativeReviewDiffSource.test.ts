import { expect, it, vi } from "vite-plus/test";

import { createNativeReviewDiffSourceLoader } from "./nativeReviewDiffSource";
import * as DiffHighlightTrace from "./nativeReviewDiffTrace";
import type { NativeReviewDiffSource } from "./nativeReviewDiffTypes";

const SOURCE = { oldContents: "const before = true;", newContents: "const after = false;" };

vi.mock("expo-file-system", () => ({
  Paths: { document: "test-documents" },
  File: class {
    create() {}
    async write() {}
  },
}));

it("retains fetched stress sources above 500k characters within the aggregate budget", async () => {
  const source = { oldContents: "", newContents: "x".repeat(3_270_000) };
  const fetch = vi.fn(async () => source);
  const load = createNativeReviewDiffSourceLoader(fetch);
  expect(await load("generated.c")).toBe(source);
  expect(await load("generated.c")).toBe(source);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("evicts source text by aggregate size and returns an over-budget response uncached", async () => {
  const source = { oldContents: "", newContents: "x".repeat(4_500_000) };
  const huge = { oldContents: "", newContents: "x".repeat(9_000_000) };
  const fetch = vi.fn(async (id: string) => (id === "huge" ? huge : source));
  const load = createNativeReviewDiffSourceLoader(fetch);
  expect(await load("first")).toBe(source);
  expect(await load("second")).toBe(source);
  expect(await load("first")).toBe(source);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await load("huge")).toBe(huge);
  expect(await load("huge")).toBe(huge);
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(await load("first")).toBe(source);
  expect(fetch).toHaveBeenCalledTimes(5);
});

it("lets later viewport requests retry a failed source fetch", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(SOURCE);
  const load = createNativeReviewDiffSourceLoader(fetch);
  await expect(load("retry.ts")).rejects.toThrow("Offline");
  expect(await load("retry.ts")).toBe(SOURCE);
});

const failureKeys = [
  ["string", () => "retry.ts"],
  ["number", () => 1],
  ["boolean", () => false],
  ["bigint", () => 1n],
  ["symbol", () => Symbol("retry.ts")],
  ["null", () => null],
  ["undefined", () => undefined],
  ["object", () => ({ id: "retry.ts" })],
  ["function", () => () => SOURCE],
] as const;

it.each(failureKeys)("bounds transient retries for a %s key", async (_name, createKey) => {
  const key = createKey();
  const fetch = vi.fn(async () => {
    throw new Error("Offline");
  });
  const load = createNativeReviewDiffSourceLoader(fetch);
  await expect(load(key)).rejects.toThrow("Offline");
  expect(await load(key)).toBeNull();
  expect(await load(key)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(failureKeys)(
  "remembers permanent unavailability for a %s key",
  async (_name, createKey) => {
    const key = createKey();
    const fetch = vi.fn(async () => {
      throw { reason: "unsupported" };
    });
    const load = createNativeReviewDiffSourceLoader(fetch);
    expect(await load(key)).toBeNull();
    expect(await load(key)).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each(failureKeys)(
  "resets retries after success and eviction for a %s key",
  async (_name, createKey) => {
    const key = createKey();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(SOURCE)
      .mockResolvedValueOnce({ oldContents: "", newContents: "x".repeat(8_000_000) })
      .mockRejectedValueOnce(new Error("Offline again"))
      .mockResolvedValueOnce(SOURCE);
    const load = createNativeReviewDiffSourceLoader(fetch);
    await expect(load(key)).rejects.toThrow("Offline");
    expect(await load(key)).toBe(SOURCE);
    await load({ id: "evict" });
    await expect(load(key)).rejects.toThrow("Offline again");
    expect(await load(key)).toBe(SOURCE);
    expect(fetch).toHaveBeenCalledTimes(5);
  },
);

it("shares an in-flight function request while one subscriber cancels", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<NativeReviewDiffSource>();
  let calls = 0;
  const request = () => {
    calls++;
    started.resolve();
    return response.promise;
  };
  const load = createNativeReviewDiffSourceLoader((sourceRequest: typeof request) =>
    sourceRequest(),
  );
  const controller = new AbortController();
  const first = load(request, controller.signal);
  await started.promise;
  const second = load(request);
  controller.abort();
  expect(await first).toBeNull();
  response.resolve(SOURCE);
  expect(await second).toBe(SOURCE);
  expect(await load(request)).toBe(SOURCE);
  expect(calls).toBe(1);
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

it("starts a shared fresh request for a file whose cancelled request was dropped", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<NativeReviewDiffSource>();
  const dropped = Promise.withResolvers<void>();
  const replacementStarted = Promise.withResolvers<void>();
  const replacementResponse = Promise.withResolvers<NativeReviewDiffSource>();
  using _trace = vi.spyOn(DiffHighlightTrace, "traceDiffHighlight").mockImplementation((event) => {
    if (event === "source-dropped") dropped.resolve();
  });
  const fetch = vi.fn((file: string) => {
    if (file === "active.ts") {
      started.resolve();
      return response.promise;
    }
    replacementStarted.resolve();
    return replacementResponse.promise;
  });
  const load = createNativeReviewDiffSourceLoader(fetch);
  const active = load("active.ts");
  await started.promise;
  const controller = new AbortController();
  const queued = load("cancelled.ts", controller.signal);
  controller.abort();
  expect(await queued).toBeNull();
  response.resolve(SOURCE);
  await dropped.promise;
  const fresh = load("cancelled.ts");
  // Settling first means the fresh caller joined the dropped request instead of fetching.
  await Promise.race([replacementStarted.promise, fresh]);
  const shared = load("cancelled.ts");
  replacementResponse.resolve(SOURCE);
  expect(await fresh).toBe(SOURCE);
  expect(await shared).toBe(SOURCE);
  expect(await active).toBe(SOURCE);
  expect(fetch.mock.calls).toEqual([["active.ts"], ["cancelled.ts"]]);
});

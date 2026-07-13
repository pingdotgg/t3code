import { describe, expect, it } from "bun:test";

import { createAttachmentImageCache } from "./attachmentImages.ts";

const IMAGE = {
  data: new Uint8Array([1, 2, 3, 255]),
  imageWidth: 1,
  imageHeight: 1,
};

describe("attachment image cache", () => {
  it("deduplicates concurrent downloads and decoded previews", async () => {
    let fetchCount = 0;
    let decodeCount = 0;
    const cache = createAttachmentImageCache({
      fetcher: async () => {
        fetchCount += 1;
        return new Response(new Uint8Array([1, 2, 3]));
      },
      decoder: async () => {
        decodeCount += 1;
        return IMAGE;
      },
    });

    const [first, second] = await Promise.all([
      cache.load("attachment-1", "https://example.test/one"),
      cache.load("attachment-1", "https://example.test/one"),
    ]);

    expect(first).toBe(IMAGE);
    expect(second).toBe(IMAGE);
    expect(fetchCount).toBe(1);
    expect(decodeCount).toBe(1);
  });

  it("does not permanently cache transient failures", async () => {
    let fetchCount = 0;
    const cache = createAttachmentImageCache({
      fetcher: async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? new Response(null, { status: 503 })
          : new Response(new Uint8Array([1]));
      },
      decoder: async () => IMAGE,
    });

    expect(await cache.load("attachment-1", "https://example.test/one")).toBeNull();
    expect(await cache.load("attachment-1", "https://example.test/two")).toBe(IMAGE);
    expect(fetchCount).toBe(2);
  });

  it("rejects oversized responses before decoding", async () => {
    let decoded = false;
    const cache = createAttachmentImageCache({
      maxEncodedBytes: 4,
      fetcher: async () =>
        new Response(new Uint8Array([1, 2, 3, 4, 5]), {
          headers: { "content-length": "5" },
        }),
      decoder: async () => {
        decoded = true;
        return IMAGE;
      },
    });

    expect(await cache.load("attachment-1", "https://example.test/large")).toBeNull();
    expect(decoded).toBe(false);
  });

  it("passes a bounded abort signal to attachment downloads", async () => {
    const cache = createAttachmentImageCache({
      fetchTimeoutMs: 1,
      fetcher: (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      decoder: async () => IMAGE,
    });

    expect(await cache.load("attachment-1", "https://example.test/one")).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  contentCacheKey,
  isCompressibleContentType,
  makeStaticCompressionCache,
  negotiateStaticEncoding,
  resolveStaticCacheControl,
} from "./staticAssetDelivery.ts";

describe("contentCacheKey", () => {
  const encode = (value: string) => new TextEncoder().encode(value);

  it("keys identical content the same way", () => {
    expect(contentCacheKey(encode("<html>a</html>"))).toBe(
      contentCacheKey(encode("<html>a</html>")),
    );
  });

  it("separates content of the same length", () => {
    // A rebuild can reuse a filename, a size, and even a timestamp, so the
    // key has to come from the bytes themselves.
    expect(contentCacheKey(encode("<html>a</html>"))).not.toBe(
      contentCacheKey(encode("<html>b</html>")),
    );
  });
});

describe("resolveStaticCacheControl", () => {
  it("marks content-hashed bundle assets immutable", () => {
    expect(resolveStaticCacheControl("assets/index-DxV9k2Qp.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(resolveStaticCacheControl("assets/style-a1b2c3d4.css")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("revalidates entry documents and unhashed files", () => {
    expect(resolveStaticCacheControl("index.html")).toBe("no-cache");
    expect(resolveStaticCacheControl("/index.html")).toBe("no-cache");
    // No hash means a rebuild reuses the name, so it must not be pinned.
    expect(resolveStaticCacheControl("assets/logo.svg")).toBe("no-cache");
    expect(resolveStaticCacheControl("favicon.ico")).toBe("no-cache");
  });
});

describe("negotiateStaticEncoding", () => {
  it("prefers brotli when the client accepts both", () => {
    expect(negotiateStaticEncoding("gzip, deflate, br")).toBe("br");
  });

  it("falls back to gzip when brotli is absent", () => {
    expect(negotiateStaticEncoding("gzip, deflate")).toBe("gzip");
  });

  it("returns null when nothing usable is offered", () => {
    expect(negotiateStaticEncoding(undefined)).toBeNull();
    expect(negotiateStaticEncoding("")).toBeNull();
    expect(negotiateStaticEncoding("deflate")).toBeNull();
  });

  it("honors explicit refusals expressed as q=0", () => {
    expect(negotiateStaticEncoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateStaticEncoding("gzip;q=0, br;q=0")).toBeNull();
  });

  it("accepts a wildcard offer", () => {
    expect(negotiateStaticEncoding("*")).toBe("br");
  });
});

describe("isCompressibleContentType", () => {
  it("compresses text and structured payloads", () => {
    expect(isCompressibleContentType("text/html; charset=utf-8")).toBe(true);
    expect(isCompressibleContentType("application/javascript")).toBe(true);
    expect(isCompressibleContentType("image/svg+xml")).toBe(true);
  });

  it("leaves already-compressed binaries alone", () => {
    expect(isCompressibleContentType("image/png")).toBe(false);
    expect(isCompressibleContentType("font/woff2")).toBe(false);
    expect(isCompressibleContentType("application/octet-stream")).toBe(false);
  });
});

describe("makeStaticCompressionCache", () => {
  const bundle = new TextEncoder().encode("export const value = 1;\n".repeat(500));

  it("compresses a payload once and reuses the result", async () => {
    let compressCalls = 0;
    const cache = makeStaticCompressionCache(async (data) => {
      compressCalls += 1;
      return data.subarray(0, 64);
    });

    const first = await cache.get({ cacheKey: "bundle.js 1 100", data: bundle, encoding: "gzip" });
    const second = await cache.get({ cacheKey: "bundle.js 1 100", data: bundle, encoding: "gzip" });

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(compressCalls).toBe(1);
  });

  it("compresses once for a burst of concurrent requests", async () => {
    let compressCalls = 0;
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = makeStaticCompressionCache(async (data) => {
      compressCalls += 1;
      await started;
      return data.subarray(0, 64);
    });

    const requests = [
      cache.get({ cacheKey: "bundle.js 1 100", data: bundle, encoding: "br" }),
      cache.get({ cacheKey: "bundle.js 1 100", data: bundle, encoding: "br" }),
      cache.get({ cacheKey: "bundle.js 1 100", data: bundle, encoding: "br" }),
    ];
    release();
    const results = await Promise.all(requests);

    expect(compressCalls).toBe(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it("retries after a failed compression instead of caching the failure", async () => {
    let compressCalls = 0;
    const cache = makeStaticCompressionCache(async (data) => {
      compressCalls += 1;
      if (compressCalls === 1) throw new Error("zlib buffer error");
      return data.subarray(0, 64);
    });

    await expect(
      cache.get({ cacheKey: "bundle.js 1 100", data: bundle, encoding: "gzip" }),
    ).rejects.toThrow("zlib buffer error");

    const retried = await cache.get({
      cacheKey: "bundle.js 1 100",
      data: bundle,
      encoding: "gzip",
    });

    expect(compressCalls).toBe(2);
    expect(retried).not.toBeNull();
  });

  it("recompresses when the file changes underneath the same path", async () => {
    let compressCalls = 0;
    const cache = makeStaticCompressionCache(async (data) => {
      compressCalls += 1;
      return data.subarray(0, 64);
    });

    await cache.get({ cacheKey: "bundle.js 1 100", data: bundle, encoding: "gzip" });
    await cache.get({ cacheKey: "bundle.js 2 140", data: bundle, encoding: "gzip" });

    expect(compressCalls).toBe(2);
  });

  it("keeps brotli and gzip results apart", async () => {
    const cache = makeStaticCompressionCache(async (data, encoding) =>
      new TextEncoder().encode(`${encoding}:${data.byteLength}`),
    );

    const brotli = await cache.get({ cacheKey: "bundle.js 1 100", data: bundle, encoding: "br" });
    const gzipped = await cache.get({
      cacheKey: "bundle.js 1 100",
      data: bundle,
      encoding: "gzip",
    });

    expect(new TextDecoder().decode(brotli ?? new Uint8Array())).toContain("br:");
    expect(new TextDecoder().decode(gzipped ?? new Uint8Array())).toContain("gzip:");
  });

  it("skips payloads too small to be worth compressing", async () => {
    let compressCalls = 0;
    const cache = makeStaticCompressionCache(async (data) => {
      compressCalls += 1;
      return data;
    });

    const result = await cache.get({
      cacheKey: "tiny.js 1 8",
      data: new TextEncoder().encode("const a=1;"),
      encoding: "gzip",
    });

    expect(result).toBeNull();
    expect(compressCalls).toBe(0);
  });

  it("declines a result that did not get smaller", async () => {
    const cache = makeStaticCompressionCache(async (data) => new Uint8Array(data.byteLength + 32));

    const result = await cache.get({
      cacheKey: "incompressible.bin 1 100",
      data: bundle,
      encoding: "gzip",
    });

    expect(result).toBeNull();
    expect(cache.retainedByteLength).toBe(0);
  });

  it("really shrinks a realistic bundle with the default compressor", async () => {
    const cache = makeStaticCompressionCache();

    const compressed = await cache.get({
      cacheKey: "real.js 1 100",
      data: bundle,
      encoding: "br",
    });

    expect(compressed).not.toBeNull();
    expect((compressed as Uint8Array).byteLength).toBeLessThan(bundle.byteLength / 2);
  });
});

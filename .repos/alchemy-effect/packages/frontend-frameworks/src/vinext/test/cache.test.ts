import { describe, expect, it } from "vitest";
import { makeDataCacheHandler, type DataCacheStore } from "../cache/handler.ts";
import { makeVinextCachePlugin } from "../cache/plugin.ts";
import { fileURLToPath } from "node:url";
import { loadProjectModule } from "../../core/Loader.ts";
import { kvAdapter } from "../cache/kv.ts";
import createKvDataCacheAdapter from "../cache/kv-runtime.ts";
import { redisAdapter } from "../cache/redis.ts";
import { s3Adapter } from "../cache/s3.ts";
import { kvHttpNamespaceFromEnv } from "../cache/kv-http.ts";
import { seedPrerenderTo, type SeedSink } from "../cache/seed.ts";
import {
  keySpace,
  readEnvString,
  restoreArrayBuffers,
  serializeForJSON,
  validateCacheEntry,
  validateTag,
} from "../cache/shared.ts";
import * as Effect from "effect/Effect";

const memoryStore = (): DataCacheStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    async getText(key) {
      return data.get(key);
    },
    async putText(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
};

describe("vinext cache adapters", () => {
  it.each(["redis", "s3", "kv"] as const)(
    "injects the %s cache without application configuration",
    async (kind) => {
      const root = fileURLToPath(
        new URL(
          "../../../../../examples/prisma-website-vinext/",
          import.meta.url,
        ),
      );
      const plugin = await Effect.runPromise(makeVinextCachePlugin(root, kind));
      const vite = await Effect.runPromise(
        loadProjectModule<typeof import("vite")>(root, "vite"),
      );
      const server = await vite.createServer({
        root,
        configFile: false,
        plugins: [plugin],
        server: { watch: null },
        optimizeDeps: { noDiscovery: true },
      });
      try {
        const container = server.environments.ssr.pluginContainer;
        const id = await container.resolveId("virtual:vinext-cache-adapters");
        expect(await container.load(id!.id)).toContain(`${kind}-runtime.js`);
        const cdnId = await container.resolveId(
          "virtual:vinext-cdn-cache-adapter",
        );
        const cdn = await container.load(cdnId!.id);
        expect(cdn).toContain("hasConfiguredDataCache = true");
        expect(cdn).not.toContain(`${kind}-runtime.js`);
      } finally {
        await server.close();
      }
    },
  );

  it("redisAdapter points at alchemy/Redis connect runtime", () => {
    const descriptor = redisAdapter({
      urlEnv: "REDIS_URL",
      appPrefix: "app",
    });
    expect(descriptor.adapter).toMatch(/redis-runtime\.js$/);
    expect(descriptor.options).toEqual({
      urlEnv: "REDIS_URL",
      appPrefix: "app",
    });
  });

  it("s3Adapter points at the runtime factory", () => {
    const descriptor = s3Adapter({ bucketEnv: "CACHE_BUCKET_NAME" });
    expect(descriptor.adapter).toMatch(/s3-runtime\.js$/);
    expect(descriptor.options?.bucketEnv).toBe("CACHE_BUCKET_NAME");
  });

  it("kvAdapter points at the runtime factory", () => {
    const descriptor = kvAdapter({ binding: "VINEXT_KV_CACHE" });
    expect(descriptor.adapter).toMatch(/kv-runtime\.js$/);
    expect(descriptor.options?.binding).toBe("VINEXT_KV_CACHE");
  });

  it("KV factory throws without a binding and round-trips through a mock namespace", async () => {
    expect(() => createKvDataCacheAdapter({ env: {} })).toThrow(
      /VINEXT_KV_CACHE/,
    );
    const data = new Map<string, string>();
    const ns = {
      async get(key: string) {
        return data.get(key) ?? null;
      },
      async put(key: string, value: string) {
        data.set(key, value);
      },
      async delete(key: string) {
        data.delete(key);
      },
    };
    const handler = createKvDataCacheAdapter({
      env: { VINEXT_KV_CACHE: ns },
    });
    await handler.set("page", {
      kind: "APP_PAGE",
      html: "<p>kv</p>",
      tags: ["posts"],
      revalidate: 60,
    });
    const hit = await handler.get("page");
    expect((hit?.value as { html?: string })?.html).toBe("<p>kv</p>");
    expect(data.size).toBeGreaterThan(0);
  });

  it("round-trips APP_PAGE ArrayBuffers through JSON", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const serialized = serializeForJSON({
      kind: "APP_PAGE",
      html: "<p>ok</p>",
      rscData: bytes,
    }) as Record<string, unknown>;
    expect(typeof serialized.rscData).toBe("string");
    const restored = restoreArrayBuffers(serialized);
    expect(restored?.rscData).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(restored!.rscData as ArrayBuffer)]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("rejects invalid tags and cache entries", () => {
    expect(validateTag("")).toBeNull();
    expect(validateTag("ok")).toBe("ok");
    expect(validateTag("a:b")).toBeNull();
    expect(validateCacheEntry({ lastModified: 1, tags: [] })).toBeNull();
    expect(
      validateCacheEntry({
        lastModified: 1,
        tags: [],
        revalidateAt: null,
        expireAt: null,
        value: null,
      }),
    ).not.toBeNull();
  });

  it("namespaces entry and tag keys", () => {
    const keys = keySpace("site");
    expect(keys.entryKey("abc")).toBe("site:cache:abc");
    expect(keys.tagKey("posts")).toBe("site:__tag:posts");
  });

  it("hashes keys that exceed the KV byte limit", () => {
    const keys = keySpace(undefined);
    expect(keys.entryKey("abc")).toBe("cache:abc");
    const hashed = keys.entryKey("x".repeat(600));
    expect(hashed.startsWith("cache:__hash:")).toBe(true);
    expect(hashed.length).toBeLessThan(40);
  });

  it("rejects a non-string redis urlEnv", () => {
    expect(() => redisAdapter({ urlEnv: 1 as unknown as string })).toThrow(
      /urlEnv/,
    );
  });

  it("reads env strings from the bag then process.env", () => {
    expect(readEnvString({ REDIS_URL: "redis://bag" }, "REDIS_URL")).toBe(
      "redis://bag",
    );
    expect(readEnvString({ REDIS_URL: "" }, "REDIS_URL")).toBe(
      process.env.REDIS_URL || undefined,
    );
    expect(readEnvString(undefined, "VINEXT_MISSING_ENV_KEY")).toBeUndefined();
  });

  it("round-trips a cache entry through the shared handler", async () => {
    const store = memoryStore();
    const handler = makeDataCacheHandler(store, { appPrefix: "site" });
    await handler.set("page", {
      kind: "APP_PAGE",
      html: "<p>ok</p>",
      tags: ["posts"],
      revalidate: 60,
    });
    const hit = await handler.get("page");
    expect(hit).not.toBeNull();
    expect((hit?.value as { html?: string })?.html).toBe("<p>ok</p>");
    expect(store.data.has("site:cache:page")).toBe(true);
  });

  it("treats revalidateTag as a miss for tagged entries", async () => {
    const store = memoryStore();
    const handler = makeDataCacheHandler(store);
    await handler.set("page", {
      kind: "APP_PAGE",
      html: "<p>old</p>",
      tags: ["posts"],
      revalidate: 60,
    });
    await handler.revalidateTag("posts");
    expect(await handler.get("page")).toBeNull();
  });

  it("kvHttpNamespaceFromEnv reads accountId + namespaceId", () => {
    expect(kvHttpNamespaceFromEnv({})).toBeUndefined();
    expect(
      kvHttpNamespaceFromEnv({
        VINEXT_KV_CACHE: { namespaceId: "ns" },
      }),
    ).toBeUndefined();
    expect(
      kvHttpNamespaceFromEnv({
        VINEXT_KV_CACHE: { namespaceId: "ns", accountId: "acct" },
      }),
    ).toEqual({ namespaceId: "ns", accountId: "acct" });
  });

  it("seedPrerenderTo writes through putText regardless of backend", async () => {
    const written: Array<{ key: string; value: string; ttlMs?: number }> = [];
    const sink: SeedSink = {
      putText: (key, value, ttlMs) =>
        Effect.sync(() => {
          written.push({ key, value, ttlMs });
        }),
    };
    const result = await Effect.runPromise(
      seedPrerenderTo(sink, {
        rootDir: "/tmp/vinext-cache-missing",
        label: "memory",
      }),
    );
    expect(result).toEqual({ count: 0, routeCount: 0 });
    expect(written).toEqual([]);
  });
});

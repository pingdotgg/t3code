// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's cache plugin tests
 * (`workers-sdk/packages/miniflare/test/plugins/cache/index.spec.ts`).
 *
 * Miniflare drives the Cache API from Node through its magic proxy; here a
 * test worker exposes `caches` over HTTP (`POST /cache`) and a Node-side
 * `TestCache` client mirrors the `Cache` API, so the upstream test bodies
 * port near-verbatim. Control operations (fake timers, storage inspection)
 * reach the `CacheObject` Durable Object through a raw service binding to the
 * `cache` service.
 *
 * Upstream tests intentionally not ported:
 * - "operations log warning on workers.dev subdomain": `cacheWarnUsage`
 *   logging is not implemented (out of scope).
 * - "purgeCache ..." (3 tests): the `purgeCache()` Node API is not
 *   implemented (out of scope).
 */
import assert from "node:assert";
import crypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Cache from "../../bindings/cache/index.ts";
import * as Docker from "../../Docker.ts";
import * as Globals from "../../globals/Globals.ts";
import * as Internet from "../../globals/Internet.ts";
import * as Storage from "../../globals/Storage.ts";
import * as Paths from "../../internal/Paths.ts";
import * as Plugin from "../../Plugin.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";
import * as Workerd from "../../workerd/Workerd.ts";
import type { TestWorker } from "../helpers/runtime.ts";
import {
  localRuntimeLayer,
  makeTempDirectory,
  startTestWorker,
} from "../helpers/runtime.ts";

// Time in milliseconds the fake `Date.now()` always returns
const TIME_NOW = 1_000_000;

// -----------------------------------------------------------------------------
// Test worker: exposes `caches` over HTTP and forwards control ops
// -----------------------------------------------------------------------------

const TEST_SCRIPT = `
function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function base64FromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodeBody(body) {
  if (body === null) return null;
  switch (body.kind) {
    case "text":
      return body.data;
    case "bytes":
      return bytesFromBase64(body.base64);
    case "stream":
      return new Blob([bytesFromBase64(body.base64)]).stream();
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/control") {
      return env.CONTROL.fetch("http://placeholder/", {
        method: "POST",
        headers: { "${Cache.HEADER_CACHE_CONTROL_OP}": "true" },
        body: request.body,
      });
    }
    const op = await request.json();
    try {
      const cache = op.cacheName === undefined ? caches.default : await caches.open(op.cacheName);
      const makeRequest = (key) => new Request(key.url, { headers: key.headers ?? {}, cf: key.cf });
      let result = null;
      switch (op.method) {
        case "put": {
          const res = new Response(decodeBody(op.response.body), {
            status: op.response.status ?? 200,
            headers: op.response.headers ?? {},
          });
          await cache.put(makeRequest(op.key), res);
          break;
        }
        case "match": {
          const res = await cache.match(makeRequest(op.key));
          if (res !== undefined) {
            const buffer = await res.arrayBuffer();
            result = {
              status: res.status,
              headers: [...res.headers],
              base64: base64FromBytes(new Uint8Array(buffer)),
            };
          }
          break;
        }
        case "delete":
          result = await cache.delete(makeRequest(op.key));
          break;
      }
      return Response.json({ ok: true, result });
    } catch (e) {
      return Response.json({
        ok: false,
        name: e?.name,
        message: e?.message ?? String(e),
      });
    }
  },
};
`;

// -----------------------------------------------------------------------------
// Node-side cache client and control stub
// -----------------------------------------------------------------------------

type EncodedBody =
  | { kind: "text"; data: string }
  | { kind: "bytes"; base64: string }
  | { kind: "stream"; base64: string }
  | null;

/** Request-shaped cache key: a URL with optional headers and `cf`. */
interface CacheKey {
  url: string;
  headers?: Record<string, string>;
  cf?: Record<string, unknown>;
}

/** Response to cache, mirroring `new Response(body, init)` in the worker. */
interface ResponseToCache {
  body: EncodedBody;
  status?: number;
  headers?: Record<string, string>;
}

interface MatchedResponse {
  status: number;
  headers: Headers;
  text: () => string;
  arrayBuffer: () => ArrayBuffer;
}

function textResponse(
  body: string,
  headers?: Record<string, string>,
): ResponseToCache {
  return { body: { kind: "text", data: body }, headers };
}

/** `Cache`-shaped client over the test worker's `POST /cache` route. */
class TestCache {
  constructor(
    readonly baseUrl: URL,
    readonly cacheName?: string,
  ) {}

  async #call(op: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(new URL("/cache", this.baseUrl), {
      method: "POST",
      body: JSON.stringify({ ...op, cacheName: this.cacheName }),
    });
    const body = (await res.json()) as
      | { ok: true; result: unknown }
      | { ok: false; name?: string; message: string };
    if (!body.ok) throw new Error(body.message);
    return body.result;
  }

  #key(key: string | CacheKey): CacheKey {
    return typeof key === "string" ? { url: key } : key;
  }

  async put(key: string | CacheKey, response: ResponseToCache): Promise<void> {
    await this.#call({ method: "put", key: this.#key(key), response });
  }

  async match(key: string | CacheKey): Promise<MatchedResponse | undefined> {
    const result = (await this.#call({
      method: "match",
      key: this.#key(key),
    })) as {
      status: number;
      headers: Array<[string, string]>;
      base64: string;
    } | null;
    if (result === null) return undefined;
    const buffer = Buffer.from(result.base64, "base64");
    return {
      status: result.status,
      headers: new Headers(result.headers),
      text: () => buffer.toString(),
      arrayBuffer: () =>
        buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ),
    };
  }

  async delete(key: string | CacheKey): Promise<boolean> {
    return (await this.#call({
      method: "delete",
      key: this.#key(key),
    })) as boolean;
  }
}

/**
 * Sends control operations to the default `CacheObject` Durable Object
 * through the test worker's `/control` route (equivalent of Miniflare's
 * `MiniflareDurableObjectControlStub`).
 */
class ControlStub {
  constructor(readonly baseUrl: URL) {}

  async #op(name: string, ...args: Array<unknown>): Promise<Response> {
    const res = await fetch(new URL("/control", this.baseUrl), {
      method: "POST",
      body: JSON.stringify({ name, args }),
    });
    assert(
      res.status === 200 || res.status === 404,
      `Control op ${name} failed: ${res.status}`,
    );
    return res;
  }

  async enableFakeTimers(timestamp: number): Promise<void> {
    await this.#op("enableFakeTimers", timestamp);
  }

  async advanceFakeTime(delta: number): Promise<void> {
    await this.#op("advanceFakeTime", delta);
  }

  async waitForFakeTasks(): Promise<void> {
    await this.#op("waitForFakeTasks");
  }

  async sqlQuery<Row>(
    query: string,
    ...params: Array<unknown>
  ): Promise<Array<Row>> {
    const res = await this.#op("sqlQuery", query, ...params);
    return (await res.json()) as Array<Row>;
  }

  async getBlob(id: string): Promise<string | null> {
    const res = await this.#op("getBlob", id);
    if (res.status === 404) return null;
    return await res.text();
  }
}

function sqlStmts(object: ControlStub) {
  return {
    getBlobIdByKey: async (key: string): Promise<string | undefined> => {
      const rows = await object.sqlQuery<{ blob_id: string }>(
        "SELECT blob_id FROM _mf_entries WHERE key = ?",
        key,
      );
      return rows[0]?.blob_id;
    },
  };
}

// -----------------------------------------------------------------------------
// Shared test worker
// -----------------------------------------------------------------------------

class CacheTestWorker extends Context.Service<CacheTestWorker, TestWorker>()(
  "test/CacheTestWorker",
) {}

// Raw binding to the `cache` service, used to send control operations (fake
// timers, storage inspection) to the default cache's Durable Object. The
// plugin doesn't export a hook for this; the designator is constructed
// directly (the cache services always exist, as the plugin is always on).
const controlBinding = Effect.succeed({
  name: "CONTROL",
  service: {
    name: Cache.SERVICE_CACHE,
    props: {
      json: JSON.stringify({ enabled: true } satisfies Cache.CacheServiceProps),
    },
  },
});

const CacheTestWorkerLive = Layer.effect(
  CacheTestWorker,
  startTestWorker({
    name: "cache-test",
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    modules: [{ name: "main.js", type: "ESModule", content: TEST_SCRIPT }],
    bindings: [controlBinding],
  }),
);

interface CacheTestContext {
  /** Unique URL path prefix per test, so tests don't race on shared keys. */
  key: (name: string) => string;
  caches: { default: TestCache; open: (name: string) => TestCache };
  defaultObject: ControlStub;
}

const setup: Effect.Effect<CacheTestContext, never, CacheTestWorker> =
  Effect.gen(function* () {
    const worker = yield* CacheTestWorker;
    const ns = `${Date.now()}_${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)}`;
    const defaultObject = new ControlStub(worker.baseUrl);
    yield* Effect.promise(() => defaultObject.enableFakeTimers(TIME_NOW));
    return {
      key: (name: string) => `http://localhost/${ns}/${name}`,
      caches: {
        default: new TestCache(worker.baseUrl),
        open: (name: string) => new TestCache(worker.baseUrl, name),
      },
      defaultObject,
    };
  });

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

const CacheTestLayer = CacheTestWorkerLive.pipe(
  Layer.provideMerge(localRuntimeLayer),
  // Let control ops (fake timers, storage inspection) through to the
  // `CacheObject` Durable Object
  Layer.provide(Layer.succeed(Plugin.UnsafeEnableControlEndpoints, true)),
);

layer(CacheTestLayer)("Cache binding", (it) => {
  const cacheTest = (
    name: string,
    fn: (ctx: CacheTestContext) => Promise<void>,
  ) =>
    it.effect(name, () =>
      setup.pipe(Effect.flatMap((ctx) => Effect.promise(() => fn(ctx)))),
    );

  cacheTest("match returns cached responses", async (ctx) => {
    const cache = ctx.caches.default;
    const key = ctx.key("cache-hit");

    // Check caching text body
    await cache.put(
      key,
      textResponse("body", {
        "Cache-Control": "max-age=3600",
        "X-Key": "value",
      }),
    );
    let res = await cache.match(key);
    assert(res !== undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("max-age=3600");
    expect(res.headers.get("CF-Cache-Status")).toBe("HIT");
    expect(res.headers.get("X-Key")).toBe("value"); // Check custom headers stored
    expect(res.text()).toBe("body");

    // Check caching binary body
    const array = new Uint8Array([1, 2, 3]);
    await cache.put(key, {
      body: { kind: "bytes", base64: Buffer.from(array).toString("base64") },
      headers: { "Cache-Control": "max-age=3600" },
    });
    res = await cache.match(key);
    assert(res !== undefined);
    expect(res.status).toBe(200);
    expect(new Uint8Array(res.arrayBuffer())).toEqual(array);

    // Check caching streamed body
    await cache.put(key, {
      body: {
        kind: "stream",
        base64: Buffer.from("streamed").toString("base64"),
      },
      headers: { "Cache-Control": "max-age=3600" },
    });
    res = await cache.match(key);
    assert(res !== undefined);
    expect(res.status).toBe(200);
    expect(res.text()).toBe("streamed");
  });

  cacheTest("match returns empty response", async (ctx) => {
    const cache = ctx.caches.default;
    const key = ctx.key("cache-empty");
    await cache.put(key, {
      body: null,
      headers: { "Cache-Control": "max-age=3600" },
    });
    const res = await cache.match(key);
    assert(res !== undefined);
    expect(res.status).toBe(200);
    expect(res.text()).toBe("");
  });

  cacheTest("match returns nothing on cache miss", async (ctx) => {
    const cache = ctx.caches.default;
    const key = ctx.key("cache-miss");
    const res = await cache.match(key);
    expect(res).toBeUndefined();
  });

  cacheTest("match respects If-None-Match header", async (ctx) => {
    const cache = ctx.caches.default;
    const key = ctx.key("cache-if-none-match");
    await cache.put(
      key,
      textResponse("body", {
        ETag: '"thing"',
        "Cache-Control": "max-age=3600",
      }),
    );

    const ifNoneMatch = (value: string) =>
      cache.match({ url: key, headers: { "If-None-Match": value } });

    // Check returns 304 only if an ETag in `If-Modified-Since` matches
    let res = await ifNoneMatch('"thing"');
    expect(res?.status).toBe(304);
    res = await ifNoneMatch('   W/"thing"      ');
    expect(res?.status).toBe(304);
    res = await ifNoneMatch('"not the thing"');
    expect(res?.status).toBe(200);
    res = await ifNoneMatch(
      '"not the thing",    "thing"    , W/"still not the thing"',
    );
    expect(res?.status).toBe(304);
    res = await ifNoneMatch("*");
    expect(res?.status).toBe(304);
    res = await ifNoneMatch("    *   ");
    expect(res?.status).toBe(304);
  });

  cacheTest("match respects If-Modified-Since header", async (ctx) => {
    const cache = ctx.caches.default;
    const key = ctx.key("cache-if-modified-since");
    await cache.put(
      key,
      textResponse("body", {
        "Last-Modified": "Tue, 13 Sep 2022 12:00:00 GMT",
        "Cache-Control": "max-age=3600",
      }),
    );

    const ifModifiedSince = (value: string) =>
      cache.match({ url: key, headers: { "If-Modified-Since": value } });

    // Check returns 200 if modified after `If-Modified-Since`
    let res = await ifModifiedSince("Tue, 13 Sep 2022 11:00:00 GMT");
    expect(res?.status).toBe(200);
    // Check returns 304 if modified on `If-Modified-Since`
    res = await ifModifiedSince("Tue, 13 Sep 2022 12:00:00 GMT");
    expect(res?.status).toBe(304);
    // Check returns 304 if modified before `If-Modified-Since`
    res = await ifModifiedSince("Tue, 13 Sep 2022 13:00:00 GMT");
    expect(res?.status).toBe(304);
    // Check returns 200 if `If-Modified-Since` is not a "valid" UTC date
    res = await ifModifiedSince("13 Sep 2022 13:00:00 GMT");
    expect(res?.status).toBe(200);
  });

  cacheTest("match respects Range header", async (ctx) => {
    const cache = ctx.caches.default;
    const key = ctx.key("cache-range");
    await cache.put(
      key,
      textResponse("0123456789", {
        "Content-Length": "10",
        "Content-Type": "text/plain",
        "Cache-Control": "max-age=3600",
      }),
    );

    // Check with single range
    let res = await cache.match({ url: key, headers: { Range: "bytes=2-4" } });
    assert(res !== undefined);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Length")).toBe("3");
    expect(res.headers.get("Cache-Control")).toBe("max-age=3600");
    expect(res.headers.get("CF-Cache-Status")).toBe("HIT");
    expect(res.text()).toBe("234");

    // Check with multiple ranges
    res = await cache.match({ url: key, headers: { Range: "bytes=1-3,5-6" } });
    assert(res !== undefined);
    expect(res.status).toBe(206);
    expect(res.headers.get("Cache-Control")).toBe("max-age=3600");
    expect(res.headers.get("CF-Cache-Status")).toBe("HIT");
    const contentType = res.headers.get("Content-Type");
    assert(contentType !== null);
    const [brand, boundary] = contentType.split("=");
    expect(brand).toBe("multipart/byteranges; boundary");
    expect(res.text()).toBe(
      [
        `--${boundary}`,
        "Content-Type: text/plain",
        "Content-Range: bytes 1-3/10",
        "",
        "123",
        `--${boundary}`,
        "Content-Type: text/plain",
        "Content-Range: bytes 5-6/10",
        "",
        "56",
        `--${boundary}--`,
      ].join("\r\n"),
    );

    // Check with unsatisfiable range
    res = await cache.match({ url: key, headers: { Range: "bytes=15-" } });
    assert(res !== undefined);
    expect(res.status).toBe(416);
  });

  cacheTest("put overrides existing responses", async (ctx) => {
    const cache = ctx.caches.default;
    const defaultObject = ctx.defaultObject;
    const stmts = sqlStmts(defaultObject);

    const key = ctx.key("cache-override");
    await cache.put(
      key,
      textResponse("body1", { "Cache-Control": "max-age=3600" }),
    );
    const blobId = await stmts.getBlobIdByKey(key);
    assert(blobId !== undefined);
    await cache.put(
      key,
      textResponse("body2", { "Cache-Control": "max-age=3600" }),
    );
    const res = await cache.match(key);
    expect(res?.text()).toBe("body2");

    // Check deletes old blob
    await defaultObject.waitForFakeTasks();
    expect(await defaultObject.getBlob(blobId)).toBe(null);

    // Check created new blob
    const newBlobId = await stmts.getBlobIdByKey(key);
    assert(newBlobId !== undefined);
    expect(blobId).not.toBe(newBlobId);
  });

  async function testExpire(
    ctx: CacheTestContext,
    opts: { headers: Record<string, string>; expectedTtl: number },
  ) {
    const cache = ctx.caches.default;
    const defaultObject = ctx.defaultObject;

    const key = ctx.key("cache-expire");
    await cache.put(key, textResponse("body", opts.headers));

    let res = await cache.match(key);
    expect(res?.status).toBe(200);

    await defaultObject.advanceFakeTime(opts.expectedTtl / 2);
    res = await cache.match(key);
    expect(res?.status).toBe(200);

    await defaultObject.advanceFakeTime(opts.expectedTtl / 2);
    res = await cache.match(key);
    expect(res).toBeUndefined();
  }

  cacheTest("expires after Expires", async (ctx) => {
    await testExpire(ctx, {
      headers: { Expires: new Date(TIME_NOW + 2_000).toUTCString() },
      expectedTtl: 2000,
    });
  });

  cacheTest("expires after Cache-Control's max-age", async (ctx) => {
    await testExpire(ctx, {
      headers: { "Cache-Control": "max-age=1" },
      expectedTtl: 1000,
    });
  });

  cacheTest("expires after Cache-Control's s-maxage", async (ctx) => {
    await testExpire(ctx, {
      headers: { "Cache-Control": "s-maxage=1, max-age=10" },
      expectedTtl: 1000,
    });
  });

  async function testIsCached(
    ctx: CacheTestContext,
    opts: { headers: Record<string, string>; cached: boolean },
  ) {
    const cache = ctx.caches.default;

    // Use different key for each invocation of this helper
    const headersHash = crypto
      .createHash("sha1")
      .update(JSON.stringify(opts.headers))
      .digest("hex");
    const key = ctx.key(`cache-is-cached-${headersHash}`);

    const expires = new Date(TIME_NOW + 2000).toUTCString();
    await cache.put(
      key,
      textResponse("body", { ...opts.headers, Expires: expires }),
    );
    const res = await cache.match(key);
    expect(res?.status).toBe(opts.cached ? 200 : undefined);
  }

  cacheTest("put does not cache with private Cache-Control", async (ctx) => {
    await testIsCached(ctx, {
      headers: { "Cache-Control": "private" },
      cached: false,
    });
  });

  cacheTest("put does not cache with no-store Cache-Control", async (ctx) => {
    await testIsCached(ctx, {
      headers: { "Cache-Control": "no-store" },
      cached: false,
    });
  });

  cacheTest("put does not cache with no-cache Cache-Control", async (ctx) => {
    await testIsCached(ctx, {
      headers: { "Cache-Control": "no-cache" },
      cached: false,
    });
  });

  cacheTest("put does not cache with Set-Cookie", async (ctx) => {
    await testIsCached(ctx, {
      headers: { "Set-Cookie": "key=value" },
      cached: false,
    });
  });

  cacheTest(
    "put caches with Set-Cookie if Cache-Control private=set-cookie",
    async (ctx) => {
      await testIsCached(ctx, {
        headers: {
          "Cache-Control": "private=set-cookie",
          "Set-Cookie": "key=value",
        },
        cached: true,
      });
    },
  );

  cacheTest("delete returns if deleted", async (ctx) => {
    const cache = ctx.caches.default;
    const key = ctx.key("cache-delete");
    await cache.put(
      key,
      textResponse("body", { "Cache-Control": "max-age=3600" }),
    );

    // Check first delete deletes
    let deleted = await cache.delete(key);
    expect(deleted).toBe(true);

    // Check subsequent deletes don't match
    deleted = await cache.delete(key);
    expect(deleted).toBe(false);
  });

  cacheTest("operations respect cf.cacheKey", async (ctx) => {
    const cache = ctx.caches.default;
    const key = ctx.key("cache-cf-key-unused");

    // Check put respects `cf.cacheKey`
    const key1: CacheKey = { url: key, cf: { cacheKey: `${key}/1` } };
    const key2: CacheKey = { url: key, cf: { cacheKey: `${key}/2` } };
    await cache.put(
      key1,
      textResponse("body1", { "Cache-Control": "max-age=3600" }),
    );
    await cache.put(
      key2,
      textResponse("body2", { "Cache-Control": "max-age=3600" }),
    );

    // Check match respects `cf.cacheKey`
    const res1 = await cache.match(key1);
    expect(res1?.text()).toBe("body1");
    const res2 = await cache.match(key2);
    expect(res2?.text()).toBe("body2");

    // Check delete respects `cf.cacheKey`
    const deleted1 = await cache.delete(key1);
    expect(deleted1).toBe(true);
    const deleted2 = await cache.delete(key2);
    expect(deleted2).toBe(true);
  });

  cacheTest("default and named caches are disjoint", async (ctx) => {
    const key = ctx.key("cache-disjoint");
    const defaultCache = ctx.caches.default;
    const namedCache1 = ctx.caches.open("1");
    const namedCache2 = ctx.caches.open("2");

    // Check put respects cache name
    const headers = { "Cache-Control": "max-age=3600" };
    await defaultCache.put(key, textResponse("bodyDefault", headers));
    await namedCache1.put(key, textResponse("body1", headers));
    await namedCache2.put(key, textResponse("body2", headers));

    // Check match respects cache name
    const resDefault = await defaultCache.match(key);
    const res1 = await namedCache1.match(key);
    const res2 = await namedCache2.match(key);

    expect(resDefault?.text()).toBe("bodyDefault");
    expect(res1?.text()).toBe("body1");
    expect(res2?.text()).toBe("body2");

    // Check delete respects cache name
    const deletedDefault = await defaultCache.delete(key);
    const deleted1 = await namedCache1.delete(key);
    const deleted2 = await namedCache2.delete(key);
    expect(deletedDefault).toBe(true);
    expect(deleted1).toBe(true);
    expect(deleted2).toBe(true);
  });

  it.effect("operations are no-ops when caching disabled", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "cache-disabled-test",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: TEST_SCRIPT }],
        bindings: [],
        cache: false,
      });
      yield* Effect.promise(async () => {
        const cache = new TestCache(worker.baseUrl);
        const key = "http://localhost/cache-disabled";

        // Check match never matches
        await cache.put(
          key,
          textResponse("body", { "Cache-Control": "max-age=3600" }),
        );
        const res = await cache.match(key);
        expect(res).toBeUndefined();

        // Check delete never deletes
        await cache.put(
          key,
          textResponse("body", { "Cache-Control": "max-age=3600" }),
        );
        const deleted = await cache.delete(key);
        expect(deleted).toBe(false);
      });
    }).pipe(Effect.scoped),
  );
});

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

describe("Cache binding persistence", () => {
  it.effect(
    "operations persist cached data",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const tmp = yield* makeTempDirectory("cache-persist-");

        const runtimeLayerTempDir = Runtime.RuntimeLive.pipe(
          Layer.provideMerge(RuntimeServices.layerLocalBindings()),
          Layer.provide(Globals.GlobalsLive),
          Layer.provideMerge(RuntimeServices.layerLoopback()),
          Layer.provide(Storage.layerDisk(tmp)),
          Layer.provide(Internet.InternetLive),
          Layer.provideMerge(RuntimeServices.layerRegistry()),
          Layer.provide(Paths.PathsLive),
          Layer.provide(Docker.DockerLive),
          Layer.provide(Workerd.WorkerdLive),
          Layer.provideMerge(
            Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
          ),
        );

        const runAgainstStorage = Effect.fn(
          function* (run: (cache: TestCache) => Promise<void>) {
            const worker = yield* startTestWorker({
              name: "cache-persist-test",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              modules: [
                { name: "main.js", type: "ESModule", content: TEST_SCRIPT },
              ],
              bindings: [],
            });
            yield* Effect.promise(() => run(new TestCache(worker.baseUrl)));
          },
          (self) =>
            self.pipe(Effect.provide(runtimeLayerTempDir), Effect.scoped),
        );

        const key = "http://localhost/cache-persist";

        // Check put respects persist
        yield* runAgainstStorage(async (cache) => {
          await cache.put(
            key,
            textResponse("body", { "Cache-Control": "max-age=3600" }),
          );
        });

        // Check directories created for the Durable Object SQLite databases
        // and the default cache's blobs
        const names = yield* fs.readDirectory(path.join(tmp, "cache"));
        expect(names).toContain("cloudflare-runtime-CacheObject");
        expect(names).toContain("default");

        // Check "restarting" keeps persisted data
        yield* runAgainstStorage(async (cache) => {
          // Check match respects persist
          const res = await cache.match(key);
          expect(res?.status).toBe(200);
          expect(res?.text()).toBe("body");

          // Check delete respects persist
          const deleted = await cache.delete(key);
          expect(deleted).toBe(true);
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
});

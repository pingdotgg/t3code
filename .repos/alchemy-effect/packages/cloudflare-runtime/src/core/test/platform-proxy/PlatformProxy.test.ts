import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DurableObjectNamespace from "../../bindings/DurableObjectNamespace.ts";
import * as Json from "../../bindings/Json.ts";
import * as KvNamespace from "../../bindings/kv-namespace/index.ts";
import * as R2Bucket from "../../bindings/r2-bucket/index.ts";
import * as Text from "../../bindings/Text.ts";
import { ExecutionContext, open } from "../../platform-proxy/PlatformProxy.ts";
import { localRuntimeLayer } from "../helpers/runtime.ts";

const DO_SCRIPT = `
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/echo" && request.method === "POST") {
      return Response.json({ body: await request.text() });
    }
    return Response.json({ pathname: url.pathname });
  }

  async increment(by = 1) {
    const count = ((await this.ctx.storage.get("count")) ?? 0) + by;
    await this.ctx.storage.put("count", count);
    return count;
  }
}
`;

const openTestProxy = open({
  bindings: [
    Text.local("TEXT", "text-value"),
    Json.local("CONFIG", { nested: { flag: true }, values: [1, 2, 3] }),
    KvNamespace.local({ binding: "KV" }),
    R2Bucket.local({ binding: "R2", id: "platform-proxy-test" }),
    DurableObjectNamespace.local({ binding: "DO", className: "Counter" }),
  ],
  modules: [{ name: "user.mjs", type: "ESModule", content: DO_SCRIPT }],
  durableObjectNamespaces: [{ className: "Counter", sql: false }],
});

layer(localRuntimeLayer, { excludeTestServices: true })(
  "PlatformProxy",
  (it) => {
    it.effect(
      "materialises plain-value bindings eagerly on env",
      () =>
        Effect.gen(function* () {
          const proxy = yield* openTestProxy;
          const env = proxy.env as Record<string, unknown>;
          expect(env.TEXT).toBe("text-value");
          expect(env.CONFIG).toEqual({
            nested: { flag: true },
            values: [1, 2, 3],
          });
          expect(env.__PLATFORM_PROXY_TOKEN__).toBeUndefined();
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "proxies KV get/put/delete/list from plain Node code",
      () =>
        Effect.gen(function* () {
          const proxy = yield* openTestProxy;
          yield* Effect.promise(async () => {
            const kv = (proxy.env as Record<string, any>).KV;
            await kv.put("key", "value", { metadata: { from: "node" } });
            expect(await kv.get("key")).toBe("value");
            const withMetadata = await kv.getWithMetadata("key");
            expect(withMetadata.value).toBe("value");
            expect(withMetadata.metadata).toEqual({ from: "node" });
            const buffer = await kv.get("key", "arrayBuffer");
            expect(new TextDecoder().decode(buffer)).toBe("value");
            expect(await kv.get("missing")).toBeNull();
            const list = await kv.list();
            expect(
              list.keys.map((key: { name: string }) => key.name),
            ).toContain("key");
            await kv.delete("key");
            expect(await kv.get("key")).toBeNull();
          });
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "proxies R2 rich objects (put/get/head/list/delete) from plain Node code",
      () =>
        Effect.gen(function* () {
          const proxy = yield* openTestProxy;
          yield* Effect.promise(async () => {
            const r2 = (proxy.env as Record<string, any>).R2;
            const put = await r2.put("greeting.txt", "hello r2", {
              httpMetadata: { contentType: "text/plain" },
              customMetadata: { from: "node" },
            });
            expect(put.key).toBe("greeting.txt");
            expect(typeof put.etag).toBe("string");

            const head = await r2.head("greeting.txt");
            expect(head.key).toBe("greeting.txt");
            expect(head.size).toBe("hello r2".length);
            expect(head.uploaded).toBeInstanceOf(Date);
            expect(head.httpMetadata).toEqual({ contentType: "text/plain" });
            expect(head.customMetadata).toEqual({ from: "node" });
            const headers = new Headers();
            head.writeHttpMetadata(headers);
            expect(headers.get("content-type")).toBe("text/plain");

            const got = await r2.get("greeting.txt");
            expect(got.key).toBe("greeting.txt");
            expect(got.bodyUsed).toBe(false);
            expect(await got.text()).toBe("hello r2");
            expect(got.bodyUsed).toBe(true);
            const gotAgain = await r2.get("greeting.txt");
            expect(new TextDecoder().decode(await gotAgain.arrayBuffer())).toBe(
              "hello r2",
            );
            expect(await r2.get("missing")).toBeNull();
            expect(await r2.head("missing")).toBeNull();

            const list = await r2.list();
            expect(list.truncated).toBe(false);
            expect(
              list.objects.map((object: { key: string }) => object.key),
            ).toContain("greeting.txt");

            await r2.delete("greeting.txt");
            expect(await r2.get("greeting.txt")).toBeNull();
          });
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "propagates binding errors as rejected promises",
      () =>
        Effect.gen(function* () {
          const proxy = yield* openTestProxy;
          yield* Effect.promise(async () => {
            const kv = (proxy.env as Record<string, any>).KV;
            await expect(kv.get("")).rejects.toThrow();
          });
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "proxies Durable Object stubs: fetch passthrough and RPC method chains",
      () =>
        Effect.gen(function* () {
          const proxy = yield* openTestProxy;
          yield* Effect.promise(async () => {
            const DO = (proxy.env as Record<string, any>).DO;
            // fetch passthrough on a stub resolved from a lazy id chain
            const id = DO.idFromName("proxy-test");
            const stub = DO.get(id);
            const response = await stub.fetch("https://do.internal/hello");
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ pathname: "/hello" });
            // request bodies stream through
            const echo = await stub.fetch("https://do.internal/echo", {
              method: "POST",
              body: "echo-body",
            });
            expect(await echo.json()).toEqual({ body: "echo-body" });
            // RPC method chain with a nested id expression
            expect(await DO.get(DO.idFromName("proxy-test")).increment(2)).toBe(
              2,
            );
            expect(await DO.get(DO.idFromName("proxy-test")).increment()).toBe(
              3,
            );
            // materialised ids round-trip
            const materialised = await DO.idFromName("proxy-test");
            expect(typeof materialised.toString()).toBe("string");
            expect(await DO.get(materialised).increment()).toBe(4);
            // awaiting an intermediate stub fails with a descriptive error
            await expect(DO.get(DO.idFromName("proxy-test"))).rejects.toThrow(
              /cannot serialize/,
            );
          });
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "caches round-trip through the worker-hosted store",
      () =>
        Effect.gen(function* () {
          const proxy = yield* openTestProxy;
          yield* Effect.promise(async () => {
            const key = "https://example.com/asset";
            const response = new Response("cached-body", {
              status: 200,
              headers: {
                "content-type": "text/plain",
                "cache-control": "max-age=60",
              },
            });
            await proxy.caches.default.put(key, response);
            const match = await proxy.caches.default.match(key);
            expect(match).toBeDefined();
            expect(match!.status).toBe(200);
            expect(match!.headers.get("content-type")).toBe("text/plain");
            expect(match!.headers.get("cf-cache-status")).toBe("HIT");
            expect(await match!.text()).toBe("cached-body");
            // named caches are isolated
            const named = await proxy.caches.open("named");
            expect(await named.match(key)).toBeUndefined();
            await named.put(key, new Response("named-body"));
            expect(await (await named.match(key))!.text()).toBe("named-body");
            expect(await proxy.caches.default.delete(key)).toBe(true);
            expect(await proxy.caches.default.match(key)).toBeUndefined();
            expect(await proxy.caches.default.delete(key)).toBe(false);
            // invalid puts are rejected like the runtime rejects them
            await expect(
              proxy.caches.default.put(
                key,
                new Response("partial", { status: 206 }),
              ),
            ).rejects.toThrow(/206/);
          });
        }),
      { timeout: 30_000 },
    );

    it.effect(
      "provides wrangler-compatible cf and ctx mocks",
      () =>
        Effect.gen(function* () {
          const proxy = yield* openTestProxy;
          expect(proxy.cf.country).toBe("US");
          expect(proxy.cf.colo).toBe("DFW");
          expect(Object.isFrozen(proxy.cf)).toBe(true);
          expect(() => {
            (proxy.cf as Record<string, unknown>).colo = "LAX";
          }).toThrow();
          expect(proxy.ctx).toBeInstanceOf(ExecutionContext);
          proxy.ctx.waitUntil(Promise.resolve());
          proxy.ctx.passThroughOnException();
          const detached = proxy.ctx.waitUntil;
          expect(() => detached(Promise.resolve())).toThrow(
            "Illegal invocation",
          );
        }),
      { timeout: 30_000 },
    );
  },
);

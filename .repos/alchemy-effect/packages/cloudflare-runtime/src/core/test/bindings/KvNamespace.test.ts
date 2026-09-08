// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's KV plugin tests
 * (`workers-sdk/packages/miniflare/test/plugins/kv/index.spec.ts`).
 *
 * Miniflare drives the KV binding from Node through its magic proxy; here a
 * test worker exposes the binding over HTTP (`POST /kv`) and a Node-side
 * `NamespacedKv` client mirrors the `KVNamespace` API, so the upstream test
 * bodies port near-verbatim. Control operations (fake timers, storage
 * inspection) reach the `KVNamespaceObject` Durable Object through a raw
 * service binding created by `KvNamespace.unsafeControl`.
 *
 * Upstream tests intentionally not ported:
 * - Workers Sites (`sites.spec.ts`): separate feature, not implemented.
 * - "persists in-memory between options reloads": relies on Miniflare's
 *   `setOptions`; restart persistence is covered by "persists on file-system".
 * - "migrates database to new location": migrates pre-Durable-Object Miniflare
 *   storage; this runtime has no legacy format.
 * - "sticky blobs never deleted": supports Miniflare's "stacked storage" for
 *   `vitest-pool-workers`, which this runtime doesn't implement.
 */
import assert from "node:assert";
import { Blob } from "node:buffer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as KvNamespace from "../../bindings/kv-namespace/index.ts";
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

// Time in seconds the fake `Date.now()` always returns
const TIME_NOW = 1000;
// Expiration value to signal a key that will expire in the future
const TIME_FUTURE = 1500;

const MAX_BULK_GET_KEYS = 100;

function secondsToMillis(seconds: number): number {
  return seconds * 1000;
}

// -----------------------------------------------------------------------------
// Test worker: exposes the KV binding over HTTP and forwards control ops
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
function decodeValue(value) {
  switch (value.kind) {
    case "text":
      return value.data;
    case "arrayBuffer":
      return bytesFromBase64(value.base64).buffer;
    case "stream":
      return new Blob([bytesFromBase64(value.base64)]).stream();
    case "junkStream": {
      let position = 0;
      return new ReadableStream({
        pull(controller) {
          if (position >= value.length) {
            controller.close();
            return;
          }
          const chunkLength = Math.min(4096, value.length - position);
          controller.enqueue(new Uint8Array(chunkLength).fill(120)); // 'x'
          position += chunkLength;
        },
      });
    }
  }
}
async function encodeResult(result) {
  if (result instanceof Map) return { kind: "map", entries: [...result] };
  if (result instanceof ArrayBuffer) {
    return { kind: "arrayBuffer", base64: base64FromBytes(new Uint8Array(result)) };
  }
  if (result instanceof ReadableStream) {
    const buffer = await new Response(result).arrayBuffer();
    return { kind: "stream", base64: base64FromBytes(new Uint8Array(buffer)) };
  }
  return { kind: "json", data: result === undefined ? null : result };
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/control") {
      return env.CONTROL.fetch("http://placeholder/", {
        method: "POST",
        headers: { "${KvNamespace.HEADER_KV_CONTROL_OP}": "true" },
        body: request.body,
      });
    }
    const op = await request.json();
    try {
      let result;
      switch (op.method) {
        case "get":
          result =
            op.options === undefined
              ? await env.NAMESPACE.get(op.key)
              : await env.NAMESPACE.get(op.key, op.options);
          break;
        case "getWithMetadata":
          result =
            op.options === undefined
              ? await env.NAMESPACE.getWithMetadata(op.key)
              : await env.NAMESPACE.getWithMetadata(op.key, op.options);
          break;
        case "put":
          result = await env.NAMESPACE.put(op.key, decodeValue(op.value), op.options);
          break;
        case "delete":
          result = await env.NAMESPACE.delete(op.key);
          break;
        case "list":
          result = await env.NAMESPACE.list(op.options);
          break;
      }
      return Response.json({ ok: true, result: await encodeResult(result) });
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
// Node-side KV client and control stub
// -----------------------------------------------------------------------------

type EncodedValue =
  | { kind: "text"; data: string }
  | { kind: "arrayBuffer"; base64: string }
  | { kind: "stream"; base64: string }
  | { kind: "junkStream"; length: number };

type EncodedResult =
  | { kind: "json"; data: unknown }
  | { kind: "map"; entries: Array<[string, unknown]> }
  | { kind: "arrayBuffer"; base64: string }
  | { kind: "stream"; base64: string };

type PutValue =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream
  | EncodedValue;

/** Stand-in for Miniflare's `createJunkStream`: a stream of `length` "x"s. */
function createJunkStream(length: number): EncodedValue {
  return { kind: "junkStream", length };
}

async function encodeValue(value: PutValue): Promise<EncodedValue> {
  if (typeof value === "string") return { kind: "text", data: value };
  if (value instanceof ArrayBuffer) {
    return {
      kind: "arrayBuffer",
      base64: Buffer.from(value).toString("base64"),
    };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      kind: "arrayBuffer",
      base64: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ).toString("base64"),
    };
  }
  if (value instanceof ReadableStream) {
    const buffer = await new Response(value).arrayBuffer();
    return { kind: "stream", base64: Buffer.from(buffer).toString("base64") };
  }
  return value;
}

function decodeResult(result: EncodedResult): unknown {
  switch (result.kind) {
    case "json":
      return result.data;
    case "map":
      return new Map(result.entries);
    case "arrayBuffer": {
      const buffer = Buffer.from(result.base64, "base64");
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      );
    }
    case "stream":
      return new Blob([Buffer.from(result.base64, "base64")]).stream();
  }
}

interface ListResult {
  keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
  list_complete: boolean;
  cursor?: string;
  cacheStatus: null;
}

/**
 * `KVNamespace`-shaped client over the test worker's `POST /kv` route.
 * Mirrors Miniflare's `Namespaced` test helper: keys are automatically
 * prefixed with `ns` (and stripped from bulk-get result Maps) so tests
 * sharing the same namespace don't have races from key collisions. `list` is
 * not prefixed; tests pass `prefix: ns` themselves.
 */
class NamespacedKv {
  ns: string;

  constructor(
    readonly baseUrl: URL,
    ns: string,
  ) {
    this.ns = ns;
  }

  async #call(op: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(new URL("/kv", this.baseUrl), {
      method: "POST",
      body: JSON.stringify(op),
    });
    const body = (await res.json()) as
      | { ok: true; result: EncodedResult }
      | { ok: false; name?: string; message: string };
    if (!body.ok) {
      // Rethrow with the original constructor so error type assertions hold
      // (e.g. key validation errors are `TypeError`s)
      throw body.name === "TypeError"
        ? new TypeError(body.message)
        : new Error(body.message);
    }
    return decodeResult(body.result);
  }

  #keys(keys: string | Array<string>): string | Array<string> {
    return typeof keys === "string"
      ? this.ns + keys
      : keys.map((key) => this.ns + key);
  }

  #stripNs(result: unknown): unknown {
    if (result instanceof Map) {
      const stripped = new Map<string, unknown>();
      for (const [key, value] of result)
        stripped.set(key.slice(this.ns.length), value);
      return stripped;
    }
    return result;
  }

  async get(key: string | Array<string>, options?: unknown): Promise<any> {
    return this.#stripNs(
      await this.#call({ method: "get", key: this.#keys(key), options }),
    );
  }

  async getWithMetadata(
    key: string | Array<string>,
    options?: unknown,
  ): Promise<any> {
    return this.#stripNs(
      await this.#call({
        method: "getWithMetadata",
        key: this.#keys(key),
        options,
      }),
    );
  }

  async put(key: string, value: PutValue, options?: unknown): Promise<void> {
    await this.#call({
      method: "put",
      key: this.ns + key,
      value: await encodeValue(value),
      options,
    });
  }

  async delete(key: string): Promise<void> {
    await this.#call({ method: "delete", key: this.ns + key });
  }

  async list(options?: unknown): Promise<ListResult> {
    return (await this.#call({ method: "list", options })) as ListResult;
  }
}

/**
 * Sends control operations to the `KVNamespaceObject` Durable Object through
 * the test worker's `/control` route (equivalent of Miniflare's
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

class KvTestWorker extends Context.Service<KvTestWorker, TestWorker>()(
  "test/KvTestWorker",
) {}

// Raw binding to the `kv` service for the test namespace, used to send
// control operations (fake timers, storage inspection) to its Durable Object.
// The plugin doesn't export a hook for this; the designator is constructed
// directly, relying on the `NAMESPACE` binding to make the services exist.
const controlBinding = Effect.succeed({
  name: "CONTROL",
  service: {
    name: KvNamespace.SERVICE_KV,
    props: {
      json: JSON.stringify({
        namespaceId: "namespace",
      } satisfies KvNamespace.KvServiceProps),
    },
  },
});

const KvTestWorkerLive = Layer.effect(
  KvTestWorker,
  startTestWorker({
    name: "kv-namespace-test",
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    modules: [{ name: "main.js", type: "ESModule", content: TEST_SCRIPT }],
    bindings: [
      KvNamespace.local({ binding: "NAMESPACE", id: "namespace" }),
      controlBinding,
    ],
  }),
);

interface KvTestContext {
  ns: string;
  kv: NamespacedKv;
  object: ControlStub;
}

const setup: Effect.Effect<KvTestContext, never, KvTestWorker> = Effect.gen(
  function* () {
    const worker = yield* KvTestWorker;
    // Namespace keys so tests accessing the same namespace don't have races
    // from key collisions
    const ns = `${Date.now()}_${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)}`;
    const object = new ControlStub(worker.baseUrl);
    yield* Effect.promise(() =>
      object.enableFakeTimers(secondsToMillis(TIME_NOW)),
    );
    return { ns, kv: new NamespacedKv(worker.baseUrl, ns), object };
  },
);

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

const KvTestLayer = KvTestWorkerLive.pipe(
  Layer.provideMerge(localRuntimeLayer),
  // Let control ops (fake timers, storage inspection) through to the
  // `KVNamespaceObject` Durable Object
  Layer.provide(Layer.succeed(Plugin.UnsafeEnableControlEndpoints, true)),
);

layer(KvTestLayer)("KvNamespace binding", (it) => {
  const kvTest = (name: string, fn: (ctx: KvTestContext) => Promise<void>) =>
    it.effect(name, () =>
      setup.pipe(Effect.flatMap((ctx) => Effect.promise(() => fn(ctx)))),
    );

  async function testValidatesKey(
    ctx: KvTestContext,
    method: string,
    f: (key: string) => Promise<unknown>,
  ) {
    ctx.kv.ns = "";
    await expect(f("")).rejects.toThrow(
      new TypeError("Key name cannot be empty."),
    );
    await expect(f(".")).rejects.toThrow(
      new TypeError('"." is not allowed as a key name.'),
    );
    await expect(f("..")).rejects.toThrow(
      new TypeError('".." is not allowed as a key name.'),
    );
    await expect(f("".padStart(513, "x"))).rejects.toThrow(
      new Error(
        `KV ${method.toUpperCase()} failed: 414 UTF-8 encoded length of 513 exceeds key length limit of 512.`,
      ),
    );
  }

  kvTest("get: validates key", async (ctx) => {
    await testValidatesKey(ctx, "get", (key) => ctx.kv.get(key));
  });

  kvTest("get: returns value", async ({ kv }) => {
    await kv.put("key", "value");
    const result = await kv.get("key");
    expect(result).toBe("value");
  });

  kvTest("get: returns ArrayBuffer values", async ({ kv }) => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    await kv.put("array-buffer-key", bytes.buffer);

    const result = await kv.get("array-buffer-key", "arrayBuffer");
    expect(result).not.toBeNull();
    expect(new Uint8Array(result as ArrayBuffer)).toEqual(bytes);
  });

  kvTest("get: returns stream values", async ({ kv }) => {
    const bytes = Uint8Array.from([255, 0, 10, 20, 30, 200]);
    await kv.put("stream-key", new Blob([bytes]).stream());

    const result = await kv.get("stream-key", "stream");
    expect(new Uint8Array(await new Response(result).arrayBuffer())).toEqual(
      bytes,
    );
  });

  kvTest("bulk get: returns value", async ({ kv }) => {
    await kv.put("key1", "value1");
    const result = await kv.get(["key1", "key2"]);
    const expectedResult = new Map([
      ["key1", "value1"],
      ["key2", null],
    ]);
    expect(result).toEqual(expectedResult);
  });

  kvTest("bulk get: check max keys", async ({ kv }) => {
    await kv.put("key1", "value1");
    const keyArray = [];
    for (let i = 0; i <= MAX_BULK_GET_KEYS; i++) {
      keyArray.push(`key${i}`);
    }
    await expect(kv.get(keyArray)).rejects.toThrow(
      new Error(
        "KV GET_BULK failed: 400 You can request a maximum of 100 keys",
      ),
    );
  });

  kvTest("bulk get: check minimum keys", async ({ kv }) => {
    await expect(kv.get([])).rejects.toThrow(
      new Error("KV GET_BULK failed: 400 You must request a minimum of 1 key"),
    );
  });

  kvTest("bulk get: invalid type", async ({ kv }) => {
    await expect(kv.get(["key"], { type: "invalid" })).rejects.toThrow(
      new Error(
        'KV GET_BULK failed: 400 "invalid" is not a valid type. Use "json" or "text"',
      ),
    );
  });

  kvTest("bulk get: request json type", async ({ kv }) => {
    await kv.put("key1", '{"example": "ex"}');
    await kv.put("key2", "example");
    let result = await kv.get(["key1"]);
    let expectedResult: Map<string, unknown> = new Map([
      ["key1", '{"example": "ex"}'],
    ]);
    expect(result).toEqual(expectedResult);

    result = await kv.get(["key1"], "json");
    expectedResult = new Map([["key1", { example: "ex" }]]);
    expect(result).toEqual(expectedResult);

    await expect(kv.get(["key1", "key2"], "json")).rejects.toThrow(
      new Error(
        "KV GET_BULK failed: 400 At least one of the requested keys corresponds to a non-json value",
      ),
    );
  });

  kvTest("bulk get: check metadata", async ({ kv }) => {
    await kv.put("key1", "value1", {
      expiration: TIME_FUTURE,
      metadata: { testing: true },
    });
    await kv.put("key2", "value2");
    const result = await kv.getWithMetadata(["key1", "key2"]);
    const expectedResult = new Map([
      ["key1", { value: "value1", metadata: { testing: true } }],
      ["key2", { value: "value2", metadata: null }],
    ]);
    expect(result).toEqual(expectedResult);
  });

  kvTest("bulk get: check metadata with int", async ({ kv }) => {
    await kv.put("key1", "value1", {
      expiration: TIME_FUTURE,
      metadata: 123,
    });
    const result = await kv.getWithMetadata(["key1"]);
    const expectedResult = new Map([
      ["key1", { value: "value1", metadata: 123 }],
    ]);
    expect(result).toEqual(expectedResult);
  });

  kvTest("bulk get: check metadata as string", async ({ kv }) => {
    await kv.put("key1", "value1", {
      expiration: TIME_FUTURE,
      metadata: "example",
    });
    const result = await kv.getWithMetadata(["key1"]);
    const expectedResult = new Map([
      ["key1", { value: "value1", metadata: "example" }],
    ]);
    expect(result).toEqual(expectedResult);
  });

  kvTest("bulk get: get with metadata for 404", async ({ kv }) => {
    const result = await kv.getWithMetadata(["key1"]);
    const expectedResult = new Map([["key1", null]]);
    expect(result).toEqual(expectedResult);
  });

  kvTest("bulk get: get over size limit", async ({ kv }) => {
    const bigValue = new Array(1024).fill("x").join("");
    await kv.put("key1", bigValue);
    await kv.put("key2", bigValue);
    await expect(kv.getWithMetadata(["key1", "key2"])).rejects.toThrow(
      // 1024 Bytes for testing
      new Error(
        "KV GET_BULK failed: 413 Total size of request exceeds the limit of 0.0009765625MB",
      ),
    );
  });

  kvTest("get: returns null for non-existent keys", async ({ kv }) => {
    expect(await kv.get("key")).toBe(null);
  });

  kvTest("get: returns null for expired keys", async ({ kv, object }) => {
    await kv.put("key", "value", { expirationTtl: 60 });
    expect(await kv.get("key")).not.toBe(null);
    await object.advanceFakeTime(60_000);
    expect(await kv.get("key")).toBe(null);
  });

  kvTest("get: validates but ignores cache ttl", async ({ kv }) => {
    await kv.put("key", "value");
    await expect(kv.get("key", { cacheTtl: "not a number" })).rejects.toThrow(
      new Error(
        "KV GET failed: 400 Invalid cache_ttl of 0. Cache TTL must be at least 30.",
      ),
    );
    await expect(kv.get("key", { cacheTtl: 10 })).rejects.toThrow(
      new Error(
        "KV GET failed: 400 Invalid cache_ttl of 10. Cache TTL must be at least 30.",
      ),
    );
    expect(await kv.get("key", { cacheTtl: 30 })).toBeDefined();
    expect(await kv.get("key", { cacheTtl: 60 })).toBeDefined();
  });

  kvTest("put: validates key", async (ctx) => {
    await testValidatesKey(ctx, "put", (key) => ctx.kv.put(key, "value"));
  });

  kvTest("put: puts value", async ({ kv, ns }) => {
    await kv.put("key", "value", {
      expiration: TIME_FUTURE,
      metadata: { testing: true },
    });
    const result = await kv.getWithMetadata("key");
    expect(result.value).toBe("value");
    expect(result.metadata).toEqual({ testing: true });
    // Check expiration set too
    const results = await kv.list({ prefix: ns });
    expect(results.keys[0]?.expiration).toBe(TIME_FUTURE);
  });

  kvTest("put: puts empty value", async ({ kv }) => {
    // https://github.com/cloudflare/miniflare/issues/703
    await kv.put("key", "");
    const value = await kv.get("key");
    expect(value).toBe("");
  });

  kvTest("put: overrides existing keys", async ({ kv, ns, object }) => {
    const stmts = sqlStmts(object);
    await kv.put("key", "value1");
    const blobId = await stmts.getBlobIdByKey(`${ns}key`);
    assert(blobId !== undefined);
    await kv.put("key", "value2", {
      expiration: TIME_FUTURE,
      metadata: { testing: true },
    });
    const result = await kv.getWithMetadata("key");
    expect(result.value).toBe("value2");
    expect(result.metadata).toEqual({ testing: true });

    // Check deletes old blob
    await object.waitForFakeTasks();
    expect(await object.getBlob(blobId)).toBe(null);

    // Check created new blob
    const newBlobId = await stmts.getBlobIdByKey(`${ns}key`);
    assert(newBlobId !== undefined);
    expect(blobId).not.toBe(newBlobId);
  });

  kvTest("put: keys are case-sensitive", async ({ kv }) => {
    await kv.put("key", "lower");
    await kv.put("KEY", "upper");
    let result = await kv.get("key");
    expect(result).toBe("lower");
    result = await kv.get("KEY");
    expect(result).toBe("upper");
  });

  kvTest("put: validates expiration ttl", async ({ kv }) => {
    await expect(
      kv.put("key", "value", { expirationTtl: "nan" }),
    ).rejects.toThrow(
      new Error(
        "KV PUT failed: 400 Invalid expiration_ttl of 0. Please specify integer greater than 0.",
      ),
    );
    await expect(kv.put("key", "value", { expirationTtl: 0 })).rejects.toThrow(
      new Error(
        "KV PUT failed: 400 Invalid expiration_ttl of 0. Please specify integer greater than 0.",
      ),
    );
    await expect(kv.put("key", "value", { expirationTtl: 30 })).rejects.toThrow(
      new Error(
        "KV PUT failed: 400 Invalid expiration_ttl of 30. Expiration TTL must be at least 60.",
      ),
    );
  });

  kvTest("put: validates expiration", async ({ kv }) => {
    await expect(kv.put("key", "value", { expiration: "nan" })).rejects.toThrow(
      new Error(
        "KV PUT failed: 400 Invalid expiration of 0. Please specify integer greater than the current number of seconds since the UNIX epoch.",
      ),
    );
    await expect(
      kv.put("key", "value", { expiration: TIME_NOW }),
    ).rejects.toThrow(
      new Error(
        `KV PUT failed: 400 Invalid expiration of ${TIME_NOW}. Please specify integer greater than the current number of seconds since the UNIX epoch.`,
      ),
    );
    await expect(
      kv.put("key", "value", { expiration: TIME_NOW + 30 }),
    ).rejects.toThrow(
      new Error(
        `KV PUT failed: 400 Invalid expiration of ${
          TIME_NOW + 30
        }. Expiration times must be at least 60 seconds in the future.`,
      ),
    );
  });

  kvTest("put: validates value size", async ({ kv }) => {
    const maxValueSize = 1024;
    const byteLength = maxValueSize + 1;
    // Check with and without `valueLengthHint`
    await expect(kv.put("key", createJunkStream(byteLength))).rejects.toThrow(
      new Error(
        `KV PUT failed: 413 Value length of ${byteLength} exceeds limit of ${maxValueSize}.`,
      ),
    );
    // Check 1 less byte is accepted
    await kv.put("key", createJunkStream(byteLength - 1));
  });

  kvTest("put: validates metadata size", async ({ kv }) => {
    const maxMetadataSize = 1024;
    await expect(
      kv.put("key", new Blob(["value"]).stream(), {
        metadata: {
          key: "".padStart(maxMetadataSize - `{"key":""}`.length + 1, "x"),
        },
      }),
    ).rejects.toThrow(
      new Error(
        `KV PUT failed: 413 Metadata length of ${
          maxMetadataSize + 1
        } exceeds limit of ${maxMetadataSize}.`,
      ),
    );
  });

  kvTest("delete: validates key", async (ctx) => {
    await testValidatesKey(ctx, "delete", (key) => ctx.kv.delete(key));
  });

  kvTest("delete: deletes existing keys", async ({ kv }) => {
    await kv.put("key", "value");
    expect(await kv.get("key")).not.toBe(null);
    await kv.delete("key");
    expect(await kv.get("key")).toBe(null);
  });

  kvTest("delete: does nothing for non-existent keys", async ({ kv }) => {
    await kv.delete("key");
  });

  async function testList(
    ctx: KvTestContext,
    opts: {
      values: Record<
        string,
        { value: string; expiration?: number; metadata?: unknown }
      >;
      options?: { prefix?: string; limit?: number; cursor?: string };
      pages: Array<ListResult["keys"]>;
    },
  ) {
    const { kv, ns } = ctx;
    for (const [key, value] of Object.entries(opts.values)) {
      await kv.put(key, value.value, {
        expiration: value.expiration,
        metadata: value.metadata,
      });
    }

    const options = opts.options ?? {};
    let lastCursor = "";
    for (let i = 0; i < opts.pages.length; i++) {
      const result = await kv.list({
        prefix: ns + (options.prefix ?? ""),
        limit: options.limit,
        cursor: options.cursor ?? lastCursor,
      });
      expect(result.keys).toEqual(
        opts.pages[i].map((value) => ({
          ...value,
          name: ns + value.name,
        })),
      );
      if (i === opts.pages.length - 1) {
        // Last Page
        assert(result.list_complete && !("cursor" in result));
        lastCursor = "";
      } else {
        assert(!result.list_complete && typeof result.cursor === "string");
        lastCursor = result.cursor;
      }
    }
  }

  kvTest("list: lists keys in sorted order", async (ctx) => {
    await testList(ctx, {
      values: {
        key3: { value: "value3" },
        key1: { value: "value1" },
        key2: { value: "value2" },
      },
      pages: [[{ name: "key1" }, { name: "key2" }, { name: "key3" }]],
    });
  });

  kvTest("list: lists keys matching prefix", async (ctx) => {
    await testList(ctx, {
      values: {
        section1key1: { value: "value11" },
        section1key2: { value: "value12" },
        section2key1: { value: "value21" },
      },
      options: { prefix: "section1" },
      pages: [[{ name: "section1key1" }, { name: "section1key2" }]],
    });
  });

  kvTest("list: prefix is case-sensitive", async (ctx) => {
    await testList(ctx, {
      values: {
        key1: { value: "lower1" },
        key2: { value: "lower2 " },
        KEY1: { value: "upper1" },
        KEY2: { value: "upper2" },
      },
      options: { prefix: "KEY" },
      pages: [[{ name: "KEY1" }, { name: "KEY2" }]],
    });
  });

  kvTest("list: prefix permits special characters", async (ctx) => {
    await testList(ctx, {
      values: {
        ["key\\_%1"]: { value: "value1" },
        ["key\\a"]: { value: "bad1" },
        ["key\\_%2"]: { value: "value2" },
        ["key\\bbb"]: { value: "bad2" },
        ["key\\_%3"]: { value: "value3" },
      },
      options: { prefix: "key\\_%" },
      pages: [
        [{ name: "key\\_%1" }, { name: "key\\_%2" }, { name: "key\\_%3" }],
      ],
    });
  });

  kvTest("list: lists keys with expiration", async (ctx) => {
    await testList(ctx, {
      values: {
        key1: { value: "value1", expiration: TIME_FUTURE },
        key2: { value: "value2", expiration: TIME_FUTURE + 100 },
        key3: { value: "value3", expiration: TIME_FUTURE + 200 },
      },
      pages: [
        [
          { name: "key1", expiration: TIME_FUTURE },
          { name: "key2", expiration: TIME_FUTURE + 100 },
          { name: "key3", expiration: TIME_FUTURE + 200 },
        ],
      ],
    });
  });

  kvTest("list: lists keys with metadata", async (ctx) => {
    await testList(ctx, {
      values: {
        key1: { value: "value1", metadata: { testing: 1 } },
        key2: { value: "value2", metadata: { testing: 2 } },
        key3: { value: "value3", metadata: { testing: 3 } },
      },
      pages: [
        [
          { name: "key1", metadata: { testing: 1 } },
          { name: "key2", metadata: { testing: 2 } },
          { name: "key3", metadata: { testing: 3 } },
        ],
      ],
    });
  });

  kvTest("list: lists keys with expiration and metadata", async (ctx) => {
    await testList(ctx, {
      values: {
        key1: {
          value: "value1",
          expiration: TIME_FUTURE,
          metadata: { testing: 1 },
        },
        key2: {
          value: "value2",
          expiration: TIME_FUTURE + 100,
          metadata: { testing: 2 },
        },
        key3: {
          value: "value3",
          expiration: TIME_FUTURE + 200,
          metadata: { testing: 3 },
        },
      },
      pages: [
        [
          { name: "key1", expiration: TIME_FUTURE, metadata: { testing: 1 } },
          {
            name: "key2",
            expiration: TIME_FUTURE + 100,
            metadata: { testing: 2 },
          },
          {
            name: "key3",
            expiration: TIME_FUTURE + 200,
            metadata: { testing: 3 },
          },
        ],
      ],
    });
  });

  kvTest("list: returns an empty list with no keys", async (ctx) => {
    await testList(ctx, {
      values: {},
      pages: [[]],
    });
  });

  kvTest("list: returns an empty list with no matching keys", async (ctx) => {
    await testList(ctx, {
      values: {
        key1: { value: "value1" },
        key2: { value: "value2" },
        key3: { value: "value3" },
      },
      options: { prefix: "none" },
      pages: [[]],
    });
  });

  kvTest("list: paginates keys", async (ctx) => {
    await testList(ctx, {
      values: {
        key1: { value: "value1" },
        key2: { value: "value2" },
        key3: { value: "value3" },
      },
      options: { limit: 2 },
      pages: [[{ name: "key1" }, { name: "key2" }], [{ name: "key3" }]],
    });
  });

  kvTest("list: paginates keys matching prefix", async (ctx) => {
    await testList(ctx, {
      values: {
        section1key1: { value: "value11" },
        section1key2: { value: "value12" },
        section1key3: { value: "value13" },
        section2key1: { value: "value21" },
      },
      options: { prefix: "section1", limit: 2 },
      pages: [
        [{ name: "section1key1" }, { name: "section1key2" }],
        [{ name: "section1key3" }],
      ],
    });
  });

  kvTest("list: accepts long prefix", async ({ kv, ns }) => {
    // Max key length, minus padding for namespace
    const longKey = "x".repeat(512 - ns.length);
    await kv.put(longKey, "value");
    const page = await kv.list({ prefix: ns + longKey });
    expect(page.keys).toEqual([{ name: ns + longKey }]);
  });

  kvTest("list: paginates with variable limit", async ({ kv, ns }) => {
    await kv.put("key1", "value1");
    await kv.put("key2", "value2");
    await kv.put("key3", "value3");

    // Get first page
    let page = await kv.list({ prefix: ns, limit: 1 });
    expect(page.keys).toEqual([{ name: `${ns}key1` }]);
    assert(!page.list_complete);
    expect(page.cursor).toBeDefined();

    // Get second page with different limit
    page = await kv.list({ prefix: ns, limit: 2, cursor: page.cursor });
    expect(page.keys).toEqual([{ name: `${ns}key2` }, { name: `${ns}key3` }]);
    assert(page.list_complete);
  });

  kvTest(
    "list: returns keys inserted whilst paginating",
    async ({ kv, ns }) => {
      await kv.put("key1", "value1");
      await kv.put("key3", "value3");
      await kv.put("key5", "value5");

      // Get first page
      let page = await kv.list({ prefix: ns, limit: 2 });
      expect(page.keys).toEqual([{ name: `${ns}key1` }, { name: `${ns}key3` }]);
      assert(!page.list_complete);
      expect(page.cursor).toBeDefined();

      // Insert key2 and key4
      await kv.put("key2", "value2");
      await kv.put("key4", "value4");

      // Get second page, expecting to see key4 but not key2
      page = await kv.list({ prefix: ns, limit: 2, cursor: page.cursor });
      expect(page.keys).toEqual([{ name: `${ns}key4` }, { name: `${ns}key5` }]);
      assert(page.list_complete);
    },
  );

  kvTest("list: ignores expired keys", async ({ kv, ns, object }) => {
    for (let i = 1; i <= 3; i++) {
      await kv.put(`key${i}`, `value${i}`, { expiration: TIME_NOW + i * 60 });
    }
    await object.advanceFakeTime(130_000 /* 2m10s */);
    expect(await kv.list({ prefix: ns })).toEqual({
      keys: [{ name: `${ns}key3`, expiration: TIME_NOW + 3 * 60 }],
      list_complete: true,
      cacheStatus: null,
    });
  });

  kvTest("list: sorts lexicographically", async ({ kv, ns }) => {
    await kv.put(", ", "value");
    await kv.put("!", "value");
    expect(await kv.list({ prefix: ns })).toEqual({
      keys: [{ name: `${ns}!` }, { name: `${ns}, ` }],
      list_complete: true,
      cacheStatus: null,
    });
  });

  kvTest("list: validates limit", async ({ kv }) => {
    // The runtime will only send the limit if it's > 0
    await expect(kv.list({ limit: 1001 })).rejects.toThrow(
      new Error(
        "KV GET failed: 400 Invalid key_count_limit of 1001. Please specify an integer less than 1000.",
      ),
    );
  });
});

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

describe("KvNamespace binding persistence", () => {
  it.effect(
    "persists on file-system",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const tmp = yield* makeTempDirectory("kv-persist-");

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
          function* (run: (kv: NamespacedKv) => Promise<void>) {
            const worker = yield* startTestWorker({
              name: "kv-persist-test",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              modules: [
                { name: "main.js", type: "ESModule", content: TEST_SCRIPT },
              ],
              bindings: [
                KvNamespace.local({ binding: "NAMESPACE", id: "namespace" }),
              ],
            });
            yield* Effect.promise(() =>
              run(new NamespacedKv(worker.baseUrl, "")),
            );
          },
          (self) =>
            self.pipe(Effect.provide(runtimeLayerTempDir), Effect.scoped),
        );

        yield* runAgainstStorage(async (kv) => {
          await kv.put("key", "value");
          expect(await kv.get("key")).toBe("value");
        });

        // Check directories created for the Durable Object SQLite databases
        // and the namespace's blobs
        const names = yield* fs.readDirectory(path.join(tmp, "kv"));
        expect(names).toContain("cloudflare-runtime-KVNamespaceObject");
        expect(names).toContain("namespace");

        // Check "restarting" keeps persisted data
        yield* runAgainstStorage(async (kv) => {
          expect(await kv.get("key")).toBe("value");
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
});

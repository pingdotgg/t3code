// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's R2 plugin tests
 * (`workers-sdk/packages/miniflare/test/plugins/r2/index.spec.ts` and the
 * in-worker conditional tests from `test/fixtures/r2/validator.ts`).
 *
 * Miniflare drives the R2 binding from Node through its magic proxy; here a
 * test worker exposes the binding over HTTP (`POST /r2`) and a Node-side
 * `NamespacedR2` client mirrors the `R2Bucket` API (including multipart
 * uploads), so the upstream test bodies port near-verbatim. `R2Object`s are
 * serialised in the worker and revived as `R2ObjectLike`s; bodies are read
 * eagerly in the worker, so "delete: waits for in-progress multipart gets"
 * exercises correctness of the returned data rather than the wait-group
 * timing itself. Control operations (fake timers, storage inspection) reach
 * the `R2BucketObject` Durable Object through a raw service binding.
 *
 * Upstream tests intentionally not ported:
 * - Public bucket dev URLs (`public.spec.ts`): separate feature, not
 *   implemented.
 * - "migrates database to new location": migrates pre-Durable-Object
 *   Miniflare storage; this runtime has no legacy format.
 */
import assert from "node:assert";
import * as crypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as R2Bucket from "../../bindings/r2-bucket/index.ts";
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

const WITHIN_EPSILON = 10_000;

function hash(value: string, algorithm = "md5") {
  return crypto.createHash(algorithm).update(value).digest("hex");
}

// -----------------------------------------------------------------------------
// Test worker: exposes the R2 binding over HTTP and forwards control ops
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
  }
}
function decodeDate(ms) {
  return ms === undefined ? undefined : new Date(ms);
}
function decodeConditional(onlyIf) {
  if (onlyIf === undefined) return undefined;
  return {
    ...onlyIf,
    uploadedBefore: decodeDate(onlyIf.uploadedBefore),
    uploadedAfter: decodeDate(onlyIf.uploadedAfter),
  };
}
function decodeGetOptions(options) {
  if (options === undefined) return undefined;
  const decoded = { ...options, onlyIf: decodeConditional(options.onlyIf) };
  if (options.range !== undefined && options.range.kind === "headers") {
    decoded.range = new Headers(options.range.entries);
  }
  return decoded;
}
function decodePutOptions(options) {
  if (options === undefined) return undefined;
  const decoded = { ...options, onlyIf: decodeConditional(options.onlyIf) };
  if (options.httpMetadata !== undefined) {
    decoded.httpMetadata = {
      ...options.httpMetadata,
      cacheExpiry: decodeDate(options.httpMetadata.cacheExpiry),
    };
  }
  return decoded;
}
function encodeHttpMetadata(httpMetadata) {
  const encoded = { ...httpMetadata };
  if (encoded.cacheExpiry !== undefined) encoded.cacheExpiry = encoded.cacheExpiry.getTime();
  return encoded;
}
async function encodeObject(object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const hasBody = "body" in object && object.body !== undefined;
  return {
    hasBody,
    key: object.key,
    version: object.version,
    size: object.size,
    etag: object.etag,
    httpEtag: object.httpEtag,
    checksums: object.checksums.toJSON(),
    httpMetadata: encodeHttpMetadata(object.httpMetadata),
    customMetadata: object.customMetadata,
    range: object.range ?? null,
    uploaded: object.uploaded.getTime(),
    writeHttpMetadataEntries: [...headers],
    ...(hasBody
      ? { bodyBase64: base64FromBytes(new Uint8Array(await object.arrayBuffer())) }
      : {}),
  };
}
async function encodeMaybeObject(object) {
  return object === null ? null : await encodeObject(object);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/control") {
      return env.CONTROL.fetch("http://placeholder/", {
        method: "POST",
        headers: { "${R2Bucket.HEADER_R2_CONTROL_OP}": "true" },
        body: request.body,
      });
    }
    const op = await request.json();
    try {
      let result;
      switch (op.method) {
        case "head":
          result = await encodeMaybeObject(await env.BUCKET.head(op.key));
          break;
        case "get":
          result = await encodeMaybeObject(
            await env.BUCKET.get(op.key, decodeGetOptions(op.options)),
          );
          break;
        case "put":
          result = await encodeMaybeObject(
            await env.BUCKET.put(op.key, decodeValue(op.value), decodePutOptions(op.options)),
          );
          break;
        case "delete":
          await env.BUCKET.delete(op.keys ?? op.key);
          result = null;
          break;
        case "list": {
          const page = await env.BUCKET.list(op.options);
          result = {
            objects: await Promise.all(page.objects.map(encodeObject)),
            truncated: page.truncated,
            cursor: page.cursor,
            delimitedPrefixes: page.delimitedPrefixes,
          };
          break;
        }
        case "createMultipartUpload": {
          const upload = await env.BUCKET.createMultipartUpload(
            op.key,
            decodePutOptions(op.options),
          );
          result = { key: upload.key, uploadId: upload.uploadId };
          break;
        }
        case "uploadPart": {
          const upload = env.BUCKET.resumeMultipartUpload(op.key, op.uploadId);
          const part = await upload.uploadPart(op.partNumber, decodeValue(op.value));
          result = { partNumber: part.partNumber, etag: part.etag };
          break;
        }
        case "completeMultipartUpload": {
          const upload = env.BUCKET.resumeMultipartUpload(op.key, op.uploadId);
          result = await encodeObject(await upload.complete(op.parts));
          break;
        }
        case "abortMultipartUpload": {
          const upload = env.BUCKET.resumeMultipartUpload(op.key, op.uploadId);
          await upload.abort();
          result = null;
          break;
        }
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
// Node-side R2 client and control stub
// -----------------------------------------------------------------------------

type EncodedValue =
  | { kind: "text"; data: string }
  | { kind: "arrayBuffer"; base64: string };

type PutValue = string | ArrayBuffer | ArrayBufferView;

function encodeValue(value: PutValue): EncodedValue {
  if (typeof value === "string") return { kind: "text", data: value };
  if (value instanceof ArrayBuffer) {
    return {
      kind: "arrayBuffer",
      base64: Buffer.from(value).toString("base64"),
    };
  }
  return {
    kind: "arrayBuffer",
    base64: Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).toString("base64"),
  };
}

interface R2Checksums {
  md5?: string;
  sha1?: string;
  sha256?: string;
  sha384?: string;
  sha512?: string;
}

interface R2HttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
}

interface R2GetOptions {
  range?: { offset?: number; length?: number; suffix?: number } | Headers;
  onlyIf?: R2Conditional;
}

interface R2PutOptions {
  httpMetadata?: R2HttpMetadata;
  customMetadata?: Record<string, string>;
  onlyIf?: R2Conditional;
  md5?: string;
  sha1?: string;
  sha256?: string;
  sha384?: string;
  sha512?: string;
}

interface R2ListOptions {
  limit?: number;
  prefix?: string;
  cursor?: string;
  delimiter?: string;
  startAfter?: string;
  include?: Array<"httpMetadata" | "customMetadata">;
}

interface EncodedR2Object {
  hasBody: boolean;
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  checksums: R2Checksums;
  httpMetadata: Omit<R2HttpMetadata, "cacheExpiry"> & { cacheExpiry?: number };
  customMetadata: Record<string, string>;
  range: { offset?: number; length?: number; suffix?: number } | null;
  uploaded: number;
  writeHttpMetadataEntries: Array<[string, string]>;
  bodyBase64?: string;
}

/** Node-side stand-in for a worker `R2Object`, revived from the test worker. */
class R2ObjectLike {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly checksums: { toJSON: () => R2Checksums };
  readonly httpMetadata: R2HttpMetadata;
  readonly customMetadata: Record<string, string>;
  readonly range?: { offset?: number; length?: number; suffix?: number };
  readonly uploaded: Date;
  readonly #writeHttpMetadataEntries: Array<[string, string]>;

  constructor(data: EncodedR2Object) {
    this.key = data.key;
    this.version = data.version;
    this.size = data.size;
    this.etag = data.etag;
    this.httpEtag = data.httpEtag;
    this.checksums = { toJSON: () => data.checksums };
    const { cacheExpiry, ...httpMetadata } = data.httpMetadata;
    this.httpMetadata = {
      ...httpMetadata,
      ...(cacheExpiry === undefined
        ? {}
        : { cacheExpiry: new Date(cacheExpiry) }),
    };
    this.customMetadata = data.customMetadata;
    this.range = data.range ?? undefined;
    this.uploaded = new Date(data.uploaded);
    this.#writeHttpMetadataEntries = data.writeHttpMetadataEntries;
  }

  writeHttpMetadata(headers: Headers): void {
    for (const [key, value] of this.#writeHttpMetadataEntries)
      headers.set(key, value);
  }
}

class R2ObjectBodyLike extends R2ObjectLike {
  readonly #bodyBase64: string;

  constructor(data: EncodedR2Object) {
    super(data);
    assert(data.bodyBase64 !== undefined);
    this.#bodyBase64 = data.bodyBase64;
  }

  get body(): ReadableStream<Uint8Array> {
    return new Blob([Buffer.from(this.#bodyBase64, "base64")]).stream();
  }

  async text(): Promise<string> {
    return Buffer.from(this.#bodyBase64, "base64").toString();
  }
}

function decodeObject(data: EncodedR2Object): R2ObjectLike;
function decodeObject(data: EncodedR2Object | null): R2ObjectLike | null;
function decodeObject(data: EncodedR2Object | null): R2ObjectLike | null {
  if (data === null) return null;
  return data.hasBody ? new R2ObjectBodyLike(data) : new R2ObjectLike(data);
}

interface ListResult {
  objects: Array<R2ObjectLike>;
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: Array<string>;
}

function encodeConditional(onlyIf: R2Conditional | undefined) {
  if (onlyIf === undefined) return undefined;
  return {
    ...onlyIf,
    uploadedBefore: onlyIf.uploadedBefore?.getTime(),
    uploadedAfter: onlyIf.uploadedAfter?.getTime(),
  };
}

function encodeGetOptions(options: R2GetOptions | undefined) {
  if (options === undefined) return undefined;
  return {
    ...options,
    onlyIf: encodeConditional(options.onlyIf),
    range:
      options.range instanceof Headers
        ? { kind: "headers", entries: [...options.range] }
        : options.range,
  };
}

function encodePutOptions(options: R2PutOptions | undefined) {
  if (options === undefined) return undefined;
  return {
    ...options,
    onlyIf: encodeConditional(options.onlyIf),
    httpMetadata: options.httpMetadata && {
      ...options.httpMetadata,
      cacheExpiry: options.httpMetadata.cacheExpiry?.getTime(),
    },
  };
}

/** Multipart upload handle mirroring the worker `R2MultipartUpload` API. */
class MultipartUpload {
  constructor(
    readonly bucket: NamespacedR2,
    /** Full (already namespaced) key. */
    readonly key: string,
    readonly uploadId: string,
  ) {}

  async uploadPart(
    partNumber: number,
    value: PutValue,
  ): Promise<{ partNumber: number; etag: string }> {
    return (await this.bucket.call({
      method: "uploadPart",
      key: this.key,
      uploadId: this.uploadId,
      partNumber,
      value: encodeValue(value),
    })) as { partNumber: number; etag: string };
  }

  async complete(
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<R2ObjectLike> {
    const result = await this.bucket.call({
      method: "completeMultipartUpload",
      key: this.key,
      uploadId: this.uploadId,
      parts,
    });
    return decodeObject(result as EncodedR2Object);
  }

  async abort(): Promise<void> {
    await this.bucket.call({
      method: "abortMultipartUpload",
      key: this.key,
      uploadId: this.uploadId,
    });
  }
}

/**
 * `R2Bucket`-shaped client over the test worker's `POST /r2` route. Mirrors
 * Miniflare's `Namespaced` test helper: keys are automatically prefixed with
 * `ns` so tests sharing the same bucket don't have races from key
 * collisions. `list` is not prefixed; tests pass `prefix: ns` themselves.
 */
class NamespacedR2 {
  ns: string;

  constructor(
    readonly baseUrl: URL,
    ns: string,
  ) {
    this.ns = ns;
  }

  async call(op: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(new URL("/r2", this.baseUrl), {
      method: "POST",
      body: JSON.stringify(op),
    });
    const body = (await res.json()) as
      | { ok: true; result: unknown }
      | { ok: false; name?: string; message: string };
    if (!body.ok) {
      // Rethrow with the original constructor so error type assertions hold
      throw body.name === "TypeError"
        ? new TypeError(body.message)
        : new Error(body.message);
    }
    return body.result;
  }

  async head(key: string): Promise<R2ObjectLike | null> {
    const result = await this.call({ method: "head", key: this.ns + key });
    return decodeObject(result as EncodedR2Object | null);
  }

  async get(
    key: string,
    options?: R2GetOptions,
  ): Promise<R2ObjectBodyLike | R2ObjectLike | null> {
    const result = await this.call({
      method: "get",
      key: this.ns + key,
      options: encodeGetOptions(options),
    });
    return decodeObject(result as EncodedR2Object | null);
  }

  async put(
    key: string,
    value: PutValue,
    options?: R2PutOptions,
  ): Promise<R2ObjectLike | null> {
    const result = await this.call({
      method: "put",
      key: this.ns + key,
      value: encodeValue(value),
      options: encodePutOptions(options),
    });
    return decodeObject(result as EncodedR2Object | null);
  }

  async delete(keys: string | Array<string>): Promise<void> {
    if (typeof keys === "string") {
      await this.call({ method: "delete", key: this.ns + keys });
    } else {
      await this.call({
        method: "delete",
        keys: keys.map((key) => this.ns + key),
      });
    }
  }

  async list(options?: R2ListOptions): Promise<ListResult> {
    const result = (await this.call({ method: "list", options })) as Omit<
      ListResult,
      "objects"
    > & {
      objects: Array<EncodedR2Object>;
    };
    return {
      ...result,
      objects: result.objects.map((object) => decodeObject(object)),
    };
  }

  async createMultipartUpload(
    key: string,
    options?: R2PutOptions,
  ): Promise<MultipartUpload> {
    const result = (await this.call({
      method: "createMultipartUpload",
      key: this.ns + key,
      options: encodePutOptions(options),
    })) as { key: string; uploadId: string };
    return new MultipartUpload(this, result.key, result.uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    return new MultipartUpload(this, this.ns + key, uploadId);
  }
}

/**
 * Sends control operations to the `R2BucketObject` Durable Object through
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

interface ObjectRow {
  key: string;
  blob_id: string | null;
  version: string;
  size: number;
  etag: string;
  uploaded: number;
  checksums: string;
  http_metadata: string;
  custom_metadata: string;
}

interface MultipartPartRow {
  upload_id: string;
  part_number: number;
  blob_id: string;
  size: number;
  etag: string;
  checksum_md5: string;
  object_key: string | null;
}

function sqlStmts(object: ControlStub) {
  return {
    getObjectByKey: async (key: string): Promise<ObjectRow | undefined> =>
      (
        await object.sqlQuery<ObjectRow>(
          "SELECT * FROM _mf_objects WHERE key = ?",
          key,
        )
      )[0],
    getPartsByUploadId: (uploadId: string) =>
      object.sqlQuery<MultipartPartRow>(
        "SELECT * FROM _mf_multipart_parts WHERE upload_id = ? ORDER BY part_number",
        uploadId,
      ),
  };
}

// -----------------------------------------------------------------------------
// Shared test worker
// -----------------------------------------------------------------------------

class R2TestWorker extends Context.Service<R2TestWorker, TestWorker>()(
  "test/R2TestWorker",
) {}

// Raw binding to the `r2` service for the test bucket, used to send control
// operations (fake timers, storage inspection) to its Durable Object. The
// plugin doesn't export a hook for this; the designator is constructed
// directly, relying on the `BUCKET` binding to make the services exist.
const controlBinding = Effect.succeed({
  name: "CONTROL",
  service: {
    name: R2Bucket.SERVICE_R2,
    props: {
      json: JSON.stringify({
        bucketName: "bucket",
      } satisfies R2Bucket.R2ServiceProps),
    },
  },
});

const R2TestWorkerLive = Layer.effect(
  R2TestWorker,
  startTestWorker({
    name: "r2-bucket-test",
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    modules: [{ name: "main.js", type: "ESModule", content: TEST_SCRIPT }],
    bindings: [
      R2Bucket.local({ binding: "BUCKET", id: "bucket" }),
      controlBinding,
    ],
  }),
);

interface R2TestContext {
  ns: string;
  r2: NamespacedR2;
  object: ControlStub;
}

const setup: Effect.Effect<R2TestContext, never, R2TestWorker> = Effect.gen(
  function* () {
    const worker = yield* R2TestWorker;
    // Namespace keys so tests accessing the same bucket don't have races from
    // key collisions
    const ns = `${Date.now()}_${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)}`;
    const object = new ControlStub(worker.baseUrl);
    yield* Effect.promise(() => object.enableFakeTimers(1_000_000));
    return { ns, r2: new NamespacedR2(worker.baseUrl, ns), object };
  },
);

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

const R2TestLayer = R2TestWorkerLive.pipe(
  Layer.provideMerge(localRuntimeLayer),
  // Let control ops (fake timers, storage inspection) through to the
  // `R2BucketObject` Durable Object
  Layer.provide(Layer.succeed(Plugin.UnsafeEnableControlEndpoints, true)),
);

layer(R2TestLayer)("R2Bucket binding", (it) => {
  const r2Test = (name: string, fn: (ctx: R2TestContext) => Promise<void>) =>
    it.effect(
      name,
      () => setup.pipe(Effect.flatMap((ctx) => Effect.promise(() => fn(ctx)))),
      {
        timeout: 30_000,
      },
    );

  async function testValidatesKey(
    ctx: R2TestContext,
    method: string,
    f: (key: string) => Promise<unknown>,
  ) {
    await expect(f("x".repeat(1025 - ctx.ns.length))).rejects.toThrow(
      new Error(`${method}: The specified object name is not valid. (10020)`),
    );
  }

  r2Test("head: returns null for non-existent keys", async ({ r2 }) => {
    expect(await r2.head("key")).toBe(null);
  });

  r2Test("head: returns metadata for existing keys", async ({ r2, ns }) => {
    const start = Date.now();
    await r2.put("key", "value", {
      httpMetadata: {
        contentType: "text/plain",
        contentLanguage: "en-GB",
        contentDisposition: 'attachment; filename="value.txt"',
        contentEncoding: "gzip",
        cacheControl: "max-age=3600",
        cacheExpiry: new Date("Fri, 24 Feb 2023 00:00:00 GMT"),
      },
      customMetadata: { key: "value" },
    });
    const object = await r2.head("key");
    assert(object !== null);
    expect(object.key).toBe(`${ns}key`);
    expect(object.version).toMatch(/^[0-9a-f]{32}$/);
    expect(object.size).toBe("value".length);
    expect(object.etag).toBe("2063c1608d6e0baf80249c42e2be5804");
    expect(object.httpEtag).toBe(`"2063c1608d6e0baf80249c42e2be5804"`);
    expect(object.checksums.toJSON()).toEqual({
      md5: "2063c1608d6e0baf80249c42e2be5804",
    });
    expect(object.httpMetadata).toEqual({
      contentType: "text/plain",
      contentLanguage: "en-GB",
      contentDisposition: 'attachment; filename="value.txt"',
      contentEncoding: "gzip",
      cacheControl: "max-age=3600",
      cacheExpiry: new Date("Fri, 24 Feb 2023 00:00:00 GMT"),
    });
    expect(object.customMetadata).toEqual({ key: "value" });
    expect(object.range).toEqual({ offset: 0, length: 5 });
    expect(object.uploaded.getTime()).toBeGreaterThanOrEqual(start);
    expect(object.uploaded.getTime()).toBeLessThanOrEqual(
      start + WITHIN_EPSILON,
    );

    // Test proxying of `writeHttpMetadata()`
    const headers = new Headers({ "X-Key": "value" });
    expect(object.writeHttpMetadata(headers)).toBeUndefined();
    expect(headers.get("Content-Type")).toBe("text/plain");
    expect(headers.get("X-Key")).toBe("value");
  });

  r2Test("head: validates key", async (ctx) => {
    await testValidatesKey(ctx, "head", (key) => ctx.r2.head(key));
  });

  r2Test("get: returns null for non-existent keys", async ({ r2 }) => {
    expect(await r2.get("key")).toBe(null);
  });

  r2Test(
    "get: returns metadata and body for existing keys",
    async ({ r2, ns }) => {
      const start = Date.now();
      await r2.put("key", "value", {
        httpMetadata: {
          contentType: "text/plain",
          contentLanguage: "en-GB",
          contentDisposition: 'attachment; filename="value.txt"',
          contentEncoding: "gzip",
          cacheControl: "max-age=3600",
          cacheExpiry: new Date("Fri, 24 Feb 2023 00:00:00 GMT"),
        },
        customMetadata: { key: "value" },
      });
      const body = await r2.get("key");
      assert(body !== null);
      expect(body.key).toBe(`${ns}key`);
      expect(body.version).toMatch(/^[0-9a-f]{32}$/);
      expect(body.size).toBe("value".length);
      expect(body.etag).toBe("2063c1608d6e0baf80249c42e2be5804");
      expect(body.httpEtag).toBe(`"2063c1608d6e0baf80249c42e2be5804"`);
      expect(body.checksums.toJSON()).toEqual({
        md5: "2063c1608d6e0baf80249c42e2be5804",
      });
      expect(body.httpMetadata).toEqual({
        contentType: "text/plain",
        contentLanguage: "en-GB",
        contentDisposition: 'attachment; filename="value.txt"',
        contentEncoding: "gzip",
        cacheControl: "max-age=3600",
        cacheExpiry: new Date("Fri, 24 Feb 2023 00:00:00 GMT"),
      });
      expect(body.customMetadata).toEqual({ key: "value" });
      expect(body.range).toEqual({ offset: 0, length: 5 });
      expect(body.uploaded.getTime()).toBeGreaterThanOrEqual(start);
      expect(body.uploaded.getTime()).toBeLessThanOrEqual(
        start + WITHIN_EPSILON,
      );

      // Test proxying of `writeHttpMetadata()`
      const headers = new Headers({ "X-Key": "value" });
      expect(body.writeHttpMetadata(headers)).toBeUndefined();
      expect(headers.get("Content-Type")).toBe("text/plain");
      expect(headers.get("X-Key")).toBe("value");
    },
  );

  r2Test("get: validates key", async (ctx) => {
    await testValidatesKey(ctx, "get", (key) => ctx.r2.get(key));
  });

  r2Test("get: range using object", async ({ r2 }) => {
    await r2.put("key", "value");

    // Check with offset
    let body = await r2.get("key", { range: { offset: 3 } });
    assert(body instanceof R2ObjectBodyLike);
    expect(body.range).toEqual({ offset: 3, length: 2 });
    expect(await body.text()).toBe("ue");

    // Check with length
    body = await r2.get("key", { range: { length: 3 } });
    assert(body instanceof R2ObjectBodyLike);
    expect(body.range).toEqual({ offset: 0, length: 3 });
    expect(await body.text()).toBe("val");
    // Check with overflowing length
    body = await r2.get("key", { range: { length: 42 } });
    assert(body instanceof R2ObjectBodyLike);
    expect(body.range).toEqual({ offset: 0, length: 5 });
    expect(await body.text()).toBe("value");

    // Check with offset and length
    body = await r2.get("key", { range: { offset: 1, length: 3 } });
    assert(body instanceof R2ObjectBodyLike);
    expect(body.range).toEqual({ offset: 1, length: 3 });
    expect(await body.text()).toBe("alu");

    // Check with suffix
    body = await r2.get("key", { range: { suffix: 3 } });
    assert(body instanceof R2ObjectBodyLike);
    expect(body.range).toEqual({ offset: 2, length: 3 });
    expect(await body.text()).toBe("lue");
    // Check with underflowing suffix
    body = await r2.get("key", { range: { suffix: 42 } });
    assert(body instanceof R2ObjectBodyLike);
    expect(body.range).toEqual({ offset: 0, length: 5 });
    expect(await body.text()).toBe("value");

    // Check unsatisfiable ranges
    await expect(r2.get("key", { range: { offset: 42 } })).rejects.toThrow(
      new Error("get: The requested range is not satisfiable (10039)"),
    );
    await expect(r2.get("key", { range: { length: 0 } })).rejects.toThrow(
      new Error("get: The requested range is not satisfiable (10039)"),
    );
    await expect(r2.get("key", { range: { suffix: 0 } })).rejects.toThrow(
      new Error("get: The requested range is not satisfiable (10039)"),
    );
    // `workerd` will validate all numbers are positive, and suffix not mixed
    // with offset or length:
    // https://github.com/cloudflare/workerd/blob/4290f9717bc94647d9c8afd29602cdac97fdff1b/src/workerd/api/r2-bucket.c%2B%2B#L239-L265
  });

  r2Test('get: range using "Range" header', async ({ r2 }) => {
    const value = "abcdefghijklmnopqrstuvwxyz";
    await r2.put("key", value);
    const range = new Headers();

    // Check missing "Range" header returns full response
    let body = await r2.get("key", { range });
    assert(body instanceof R2ObjectBodyLike);
    expect(await body.text()).toBe(value);
    expect(body.range).toEqual({ offset: 0, length: 26 });

    // Check "Range" with start and end returns partial response
    range.set("Range", "bytes=3-6");
    body = await r2.get("key", { range });
    assert(body instanceof R2ObjectBodyLike);
    expect(await body.text()).toBe("defg");
    expect(body.range).toEqual({ offset: 3, length: 4 });

    // Check "Range" with just start returns partial response
    range.set("Range", "bytes=10-");
    body = await r2.get("key", { range });
    assert(body instanceof R2ObjectBodyLike);
    expect(await body.text()).toBe("klmnopqrstuvwxyz");
    expect(body.range).toEqual({ offset: 10, length: 16 });

    // Check "Range" with just end returns partial response
    range.set("Range", "bytes=-5");
    body = await r2.get("key", { range });
    assert(body instanceof R2ObjectBodyLike);
    expect(await body.text()).toBe("vwxyz");
    expect(body.range).toEqual({ offset: 21, length: 5 });

    // Check "Range" with multiple ranges returns full response
    range.set("Range", "bytes=5-6,10-11");
    body = await r2.get("key", { range });
    assert(body instanceof R2ObjectBodyLike);
    expect(await body.text()).toBe(value);
    expect(body.range).toEqual({ offset: 0, length: 26 });
  });

  r2Test("get: returns body only if passes onlyIf", async ({ r2 }) => {
    const pastDate = new Date(Date.now() - 60_000);
    await r2.put("key", "value");
    const futureDate = new Date(Date.now() + 60_000);
    const etag = hash("value");
    const badEtag = hash("👻");

    // `workerd` will handle extracting `onlyIf`s from `Header`s:
    // https://github.com/cloudflare/workerd/blob/4290f9717bc94647d9c8afd29602cdac97fdff1b/src/workerd/api/r2-bucket.c%2B%2B#L195-L201
    // Only doing basic tests here, more complex tests are in the
    // "testR2Conditional" suite below

    const pass = async (cond: R2Conditional) => {
      const object = await r2.get("key", { onlyIf: cond });
      // R2ObjectBody
      expect(
        object !== null && "body" in object && object?.body !== undefined,
      ).toBe(true);
    };
    const fail = async (cond: R2Conditional) => {
      const object = await r2.get("key", { onlyIf: cond });
      expect(object).not.toBe(null);
      // R2Object
      expect(object !== null && !("body" in object)).toBe(true);
    };

    await pass({ etagMatches: etag });
    await fail({ etagMatches: badEtag });

    await fail({ etagDoesNotMatch: etag });
    await pass({ etagDoesNotMatch: badEtag });

    await pass({ uploadedBefore: futureDate });
    await fail({ uploadedBefore: pastDate });

    await fail({ uploadedAfter: futureDate });
    await pass({ uploadedAfter: pastDate });
  });

  r2Test("put: returns metadata for created object", async ({ r2, ns }) => {
    const start = Date.now();
    // `workerd` will handle extracting `httpMetadata`s from `Header`s:
    // https://github.com/cloudflare/workerd/blob/4290f9717bc94647d9c8afd29602cdac97fdff1b/src/workerd/api/r2-bucket.c%2B%2B#L410-L420
    const object = await r2.put("key", "value", {
      httpMetadata: {
        contentType: "text/plain",
        contentLanguage: "en-GB",
        contentDisposition: 'attachment; filename="value.txt"',
        contentEncoding: "gzip",
        cacheControl: "max-age=3600",
        cacheExpiry: new Date("Fri, 24 Feb 2023 00:00:00 GMT"),
      },
      customMetadata: { key: "value" },
    });
    assert(object !== null);
    expect(object.key).toBe(`${ns}key`);
    expect(object.version).toMatch(/^[0-9a-f]{32}$/);
    expect(object.size).toBe("value".length);
    expect(object.etag).toBe("2063c1608d6e0baf80249c42e2be5804");
    expect(object.httpEtag).toBe(`"2063c1608d6e0baf80249c42e2be5804"`);
    expect(object.checksums.toJSON()).toEqual({
      md5: "2063c1608d6e0baf80249c42e2be5804",
    });
    expect(object.httpMetadata).toEqual({
      contentType: "text/plain",
      contentLanguage: "en-GB",
      contentDisposition: 'attachment; filename="value.txt"',
      contentEncoding: "gzip",
      cacheControl: "max-age=3600",
      cacheExpiry: new Date("Fri, 24 Feb 2023 00:00:00 GMT"),
    });
    expect(object.customMetadata).toEqual({ key: "value" });
    expect(object.range).toBeUndefined();
    expect(object.uploaded.getTime()).toBeGreaterThanOrEqual(start);
    expect(object.uploaded.getTime()).toBeLessThanOrEqual(
      start + WITHIN_EPSILON,
    );
  });

  r2Test("put: puts empty value", async ({ r2 }) => {
    const object = await r2.put("key", "");
    assert(object !== null);
    expect(object.size).toBe(0);
    const objectBody = await r2.get("key");
    assert(objectBody instanceof R2ObjectBodyLike);
    expect(await objectBody.text()).toBe("");
  });

  r2Test("put: overrides existing keys", async ({ r2, ns, object }) => {
    await r2.put("key", "value1");
    const stmts = sqlStmts(object);
    const objectRow = await stmts.getObjectByKey(`${ns}key`);
    assert(objectRow?.blob_id != null);

    await r2.put("key", "value2");
    const body = await r2.get("key");
    assert(body instanceof R2ObjectBodyLike);
    expect(await body.text()).toBe("value2");

    // Check deletes old blob
    await object.waitForFakeTasks();
    expect(await object.getBlob(objectRow.blob_id)).toBe(null);
  });

  r2Test("put: validates key", async (ctx) => {
    await testValidatesKey(ctx, "put", (key) => ctx.r2.put(key, "v"));
  });

  r2Test("put: validates checksums", async ({ r2 }) => {
    const checksumError = (name: string, provided: string, expected: string) =>
      new Error(
        [
          `put: The ${name} checksum you specified did not match what we received.`,
          `You provided a ${name} checksum with value: ${provided}`,
          `Actual ${name} was: ${expected} (10037)`,
        ].join("\n"),
      );

    // `workerd` validates types, hex strings, hash lengths and that we're only
    // specifying one hash:
    // https://github.com/cloudflare/workerd/blob/4290f9717bc94647d9c8afd29602cdac97fdff1b/src/workerd/api/r2-bucket.c%2B%2B#L441-L520

    // Check only stores if computed hash matches
    const md5 = hash("value", "md5");
    await r2.put("key", "value", { md5 });
    const badMd5 = md5.replace("0", "1");
    await expect(r2.put("key", "value", { md5: badMd5 })).rejects.toThrow(
      checksumError("MD5", badMd5, md5),
    );
    let checksums = (await r2.head("key"))?.checksums.toJSON();
    expect(checksums).toEqual({ md5 });

    const sha1 = hash("value", "sha1");
    await r2.put("key", "value", { sha1 });
    const badSha1 = sha1.replace("0", "1");
    await expect(r2.put("key", "value", { sha1: badSha1 })).rejects.toThrow(
      checksumError("SHA-1", badSha1, sha1),
    );
    // Check `get()` returns checksums
    checksums = (await r2.get("key"))?.checksums.toJSON();
    expect(checksums).toEqual({ md5, sha1 });

    const sha256 = hash("value", "sha256");
    // Check always stores lowercase hash
    await r2.put("key", "value", { sha256: sha256.toUpperCase() });
    const badSha256 = sha256.replace("0", "1");
    await expect(r2.put("key", "value", { sha256: badSha256 })).rejects.toThrow(
      checksumError("SHA-256", badSha256, sha256),
    );
    checksums = (await r2.head("key"))?.checksums.toJSON();
    expect(checksums).toEqual({ md5, sha256 });

    const sha384 = hash("value", "sha384");
    await r2.put("key", "value", { sha384 });
    const badSha384 = sha384.replace("0", "1");
    await expect(r2.put("key", "value", { sha384: badSha384 })).rejects.toThrow(
      checksumError("SHA-384", badSha384, sha384),
    );
    checksums = (await r2.head("key"))?.checksums.toJSON();
    expect(checksums).toEqual({ md5, sha384 });

    const sha512 = hash("value", "sha512");
    await r2.put("key", "value", { sha512 });
    const badSha512 = sha512.replace("0", "1");
    await expect(r2.put("key", "value", { sha512: badSha512 })).rejects.toThrow(
      checksumError("SHA-512", badSha512, sha512),
    );
    checksums = (await r2.head("key"))?.checksums.toJSON();
    expect(checksums).toEqual({ md5, sha512 });
  });

  r2Test("put: stores only if passes onlyIf", async ({ r2 }) => {
    const pastDate = new Date(Date.now() - 60_000);
    const futureDate = new Date(Date.now() + 300_000);
    const etag = hash("1");
    const badEtag = hash("👻");

    const reset = () => r2.put("key", "1");
    await reset();

    const pass = async (cond: R2Conditional) => {
      const object = await r2.put("key", "2", { onlyIf: cond });
      expect(object).not.toBe(null);
      const body = await r2.get("key");
      assert(body instanceof R2ObjectBodyLike);
      expect(await body.text()).toBe("2");
      await reset();
    };
    const fail = async (cond: R2Conditional) => {
      const object = await r2.put("key", "2", { onlyIf: cond });
      expect(object).toBe(null);
      const body = await r2.get("key");
      assert(body instanceof R2ObjectBodyLike);
      expect(await body.text()).toBe("1");
      // No `reset()` as we've just checked we didn't update anything
    };

    await pass({ etagMatches: etag });
    await fail({ etagMatches: badEtag });

    await fail({ etagDoesNotMatch: etag });
    await pass({ etagDoesNotMatch: badEtag });

    await pass({ uploadedBefore: futureDate });
    await fail({ uploadedBefore: pastDate });

    await fail({ uploadedAfter: futureDate });
    await pass({ uploadedAfter: pastDate });

    // Check non-existent key with failed condition
    const object = await r2.put("no-key", "2", {
      onlyIf: { etagMatches: etag },
    });
    expect(object).toBe(null);
  });

  r2Test("put: validates metadata size", async ({ r2 }) => {
    const metadataError = new Error(
      "put: Your metadata headers exceed the maximum allowed metadata size. (10012)",
    );

    // Check with ASCII characters
    await r2.put("key", "value", { customMetadata: { key: "x".repeat(2045) } });
    await expect(
      r2.put("key", "value", { customMetadata: { key: "x".repeat(2046) } }),
    ).rejects.toThrow(metadataError);
    await r2.put("key", "value", { customMetadata: { hi: "x".repeat(2046) } });

    // Check with extended characters: note "🙂" is 2 UTF-16 code units, so
    // `"🙂".length === 2`, and it requires 4 bytes to store
    await r2.put("key", "value", { customMetadata: { key: "🙂".repeat(511) } }); // 3 + 4*511 = 2047
    await r2.put("key", "value", {
      customMetadata: { key1: "🙂".repeat(511) },
    }); // 4 + 4*511 = 2048
    await expect(
      r2.put("key", "value", { customMetadata: { key12: "🙂".repeat(511) } }),
    ).rejects.toThrow(metadataError);
    await expect(
      r2.put("key", "value", { customMetadata: { key: "🙂".repeat(512) } }),
    ).rejects.toThrow(metadataError);
  });

  it.effect(
    "put: can copy values",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "r2-copy-test",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: `export default {
                async fetch(request, env, ctx) {
                  await env.BUCKET.put("key", "0123456789");

                  let object = await env.BUCKET.get("key");
                  await env.BUCKET.put("key-copy", object.body);
                  const copy = await (await env.BUCKET.get("key-copy"))?.text();

                  object = await env.BUCKET.get("key", { range: { offset: 1, length: 4 } });
                  await env.BUCKET.put("key-copy-range-1", object.body);
                  const copyRange1 = await (await env.BUCKET.get("key-copy-range-1"))?.text();

                  object = await env.BUCKET.get("key", { range: { length: 3 } });
                  await env.BUCKET.put("key-copy-range-2", object.body);
                  const copyRange2 = await (await env.BUCKET.get("key-copy-range-2"))?.text();

                  object = await env.BUCKET.get("key", { range: { suffix: 5 } });
                  await env.BUCKET.put("key-copy-range-3", object.body);
                  const copyRange3 = await (await env.BUCKET.get("key-copy-range-3"))?.text();

                  const range = new Headers();
                  range.set("Range", "bytes=0-5");
                  object = await env.BUCKET.get("key", { range });
                  await env.BUCKET.put("key-copy-range-4", object.body);
                  const copyRange4 = await (await env.BUCKET.get("key-copy-range-4"))?.text();

                  return Response.json({ copy, copyRange1, copyRange2, copyRange3, copyRange4 });
                },
              };`,
            },
          ],
          bindings: [R2Bucket.local({ binding: "BUCKET", id: "copy-bucket" })],
        });
        const result = yield* worker.fetchJson("/");
        expect(result).toEqual({
          copy: "0123456789",
          copyRange1: "1234",
          copyRange2: "012",
          copyRange3: "56789",
          copyRange4: "012345",
        });
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  r2Test("delete: deletes existing keys", async ({ r2, ns, object }) => {
    // Check does nothing with non-existent key
    await r2.delete("key");

    // Check deletes single key
    await r2.put("key", "value");
    const stmts = sqlStmts(object);
    const objectRow = await stmts.getObjectByKey(`${ns}key`);
    assert(objectRow?.blob_id != null);
    expect(await r2.head("key")).not.toBe(null);
    await r2.delete("key");
    expect(await r2.head("key")).toBe(null);
    // Check deletes old blob
    await object.waitForFakeTasks();
    expect(await object.getBlob(objectRow.blob_id)).toBe(null);

    // Check deletes multiple keys, skipping non-existent keys
    await r2.put("key1", "value1");
    await r2.put("key2", "value2");
    await r2.put("key3", "value3");
    await r2.delete(["key1", "key200", "key3"]);
    expect(await r2.head("key1")).toBe(null);
    expect(await r2.head("key2")).not.toBe(null);
    expect(await r2.head("key3")).toBe(null);
  });

  r2Test("delete: validates key", async (ctx) => {
    await testValidatesKey(ctx, "delete", (key) => ctx.r2.delete(key));
  });

  r2Test("delete: validates keys", async (ctx) => {
    await testValidatesKey(ctx, "delete", (key) =>
      ctx.r2.delete(["valid key", key]),
    );
  });

  async function testList(
    ctx: R2TestContext,
    opts: {
      keys: Array<string>;
      options?: R2ListOptions;
      pages: Array<Array<string>>;
    },
  ) {
    const { r2, ns } = ctx;

    // Seed bucket
    for (let i = 0; i < opts.keys.length; i++)
      await r2.put(opts.keys[i], `value${i}`);

    let lastCursor: string | undefined;
    for (let pageIndex = 0; pageIndex < opts.pages.length; pageIndex++) {
      const result = await r2.list({
        ...opts.options,
        prefix: ns + (opts.options?.prefix ?? ""),
        cursor: opts.options?.cursor ?? lastCursor,
        startAfter: opts.options?.startAfter
          ? ns + opts.options.startAfter
          : undefined,
      });
      const { objects, truncated } = result;
      const cursor = truncated ? result.cursor : undefined;

      // Check objects in page match
      const objectKeys = objects.map(({ key }) => key.substring(ns.length));
      const expectedKeys = opts.pages[pageIndex];
      expect(objectKeys).toEqual(expectedKeys);

      // Check other return values and advance cursor to next page
      if (pageIndex === opts.pages.length - 1) {
        // Last Page
        expect(truncated).toBe(false);
        expect(cursor).toBeUndefined();
      } else {
        expect(truncated).toBe(true);
        expect(cursor).toBeDefined();
      }
      lastCursor = cursor;
    }
  }

  r2Test("list: lists keys in sorted order", async (ctx) => {
    await testList(ctx, {
      keys: ["key3", "key1", "key2", ", ", "!"],
      pages: [["!", ", ", "key1", "key2", "key3"]],
    });
  });

  r2Test("list: lists keys matching prefix", async (ctx) => {
    await testList(ctx, {
      keys: ["section1key1", "section1key2", "section2key1"],
      options: { prefix: "section1" },
      pages: [["section1key1", "section1key2"]],
    });
  });

  r2Test("list: returns an empty list with no keys", async (ctx) => {
    await testList(ctx, {
      keys: [],
      pages: [[]],
    });
  });

  r2Test("list: returns an empty list with no matching keys", async (ctx) => {
    await testList(ctx, {
      keys: ["key1", "key2", "key3"],
      options: { prefix: "none" },
      pages: [[]],
    });
  });

  r2Test("list: returns an empty list with an invalid cursor", async (ctx) => {
    await testList(ctx, {
      keys: ["key1", "key2", "key3"],
      options: { cursor: "bad" },
      pages: [[]],
    });
  });

  r2Test("list: paginates keys", async (ctx) => {
    await testList(ctx, {
      keys: ["key1", "key2", "key3"],
      options: { limit: 2 },
      pages: [["key1", "key2"], ["key3"]],
    });
  });

  r2Test("list: paginates keys matching prefix", async (ctx) => {
    await testList(ctx, {
      keys: ["section1key1", "section1key2", "section1key3", "section2key1"],
      options: { prefix: "section1", limit: 2 },
      pages: [["section1key1", "section1key2"], ["section1key3"]],
    });
  });

  r2Test("list: lists keys starting from startAfter exclusive", async (ctx) => {
    await testList(ctx, {
      keys: ["key1", "key2", "key3", "key4"],
      options: { startAfter: "key2" },
      pages: [["key3", "key4"]],
    });
  });

  r2Test(
    "list: lists keys with startAfter and limit (where startAfter matches key)",
    async (ctx) => {
      await testList(ctx, {
        keys: ["key1", "key2", "key3", "key4"],
        options: { startAfter: "key1", limit: 2 },
        pages: [["key2", "key3"], ["key4"]],
      });
    },
  );

  r2Test(
    "list: lists keys with startAfter and limit (where startAfter doesn't match key)",
    async (ctx) => {
      await testList(ctx, {
        keys: ["key1", "key2", "key3", "key4"],
        options: { startAfter: "key", limit: 2 },
        pages: [
          ["key1", "key2"],
          ["key3", "key4"],
        ],
      });
    },
  );

  r2Test("list: accepts long prefix", async ({ r2, ns }) => {
    // Max key length, minus padding for namespace
    const longKey = "x".repeat(1024 - ns.length);
    await r2.put(longKey, "value");
    const { objects } = await r2.list({ prefix: ns + longKey });
    expect(objects.length).toBe(1);
    expect(objects[0].key).toBe(ns + longKey);
  });

  r2Test("list: returns metadata with objects", async ({ r2, ns }) => {
    const start = Date.now();
    await r2.put("key", "value");
    const { objects } = await r2.list({ prefix: ns });
    expect(objects.length).toBe(1);
    const object = objects[0];
    expect(object.key).toBe(`${ns}key`);
    expect(object.version).toMatch(/^[0-9a-f]{32}$/);
    expect(object.size).toBe("value".length);
    expect(object.etag).toBe("2063c1608d6e0baf80249c42e2be5804");
    expect(object.httpEtag).toBe(`"2063c1608d6e0baf80249c42e2be5804"`);
    expect(object.checksums.toJSON()).toEqual({
      md5: "2063c1608d6e0baf80249c42e2be5804",
    });
    expect(object.httpMetadata).toEqual({});
    expect(object.customMetadata).toEqual({});
    expect(object.range).toBeUndefined();
    expect(object.uploaded.getTime()).toBeGreaterThanOrEqual(start);
    expect(object.uploaded.getTime()).toBeLessThanOrEqual(
      start + WITHIN_EPSILON,
    );
  });

  r2Test("list: paginates with variable limit", async ({ r2, ns }) => {
    await r2.put("key1", "value1");
    await r2.put("key2", "value2");
    await r2.put("key3", "value3");

    // Get first page
    let result = await r2.list({ prefix: ns, limit: 1 });
    expect(result.objects.length).toBe(1);
    expect(result.objects[0].key).toBe(`${ns}key1`);
    assert(result.truncated && result.cursor !== undefined);

    // Get second page with different limit
    result = await r2.list({ prefix: ns, limit: 2, cursor: result.cursor });
    expect(result.objects.length).toBe(2);
    expect(result.objects[0].key).toBe(`${ns}key2`);
    expect(result.objects[1].key).toBe(`${ns}key3`);
    expect(result.truncated && result.cursor === undefined).toBe(false);
  });

  r2Test(
    "list: returns keys inserted whilst paginating",
    async ({ r2, ns }) => {
      await r2.put("key1", "value1");
      await r2.put("key3", "value3");
      await r2.put("key5", "value5");

      // Get first page
      let result = await r2.list({ prefix: ns, limit: 2 });
      expect(result.objects.length).toBe(2);
      expect(result.objects[0].key).toBe(`${ns}key1`);
      expect(result.objects[1].key).toBe(`${ns}key3`);
      assert(result.truncated && result.cursor !== undefined);

      // Insert key2 and key4
      await r2.put("key2", "value2");
      await r2.put("key4", "value4");

      // Get second page, expecting to see key4 but not key2
      result = await r2.list({ prefix: ns, limit: 2, cursor: result.cursor });
      expect(result.objects.length).toBe(2);
      expect(result.objects[0].key).toBe(`${ns}key4`);
      expect(result.objects[1].key).toBe(`${ns}key5`);
      expect(result.truncated && result.cursor === undefined).toBe(false);
    },
  );

  r2Test("list: validates limit", async ({ r2 }) => {
    // R2 actually accepts 0 and -1 as valid limits, but this is probably a bug
    await expect(r2.list({ limit: 0 })).rejects.toThrow(
      new Error(
        "list: MaxKeys params must be positive integer <= 1000. (10022)",
      ),
    );
    await expect(r2.list({ limit: 1001 })).rejects.toThrow(
      new Error(
        "list: MaxKeys params must be positive integer <= 1000. (10022)",
      ),
    );
  });

  r2Test(
    "list: includes httpMetadata and customMetadata if specified",
    async ({ r2, ns }) => {
      await r2.put("key1", "value1", {
        httpMetadata: { contentEncoding: "gzip" },
        customMetadata: { foo: "bar" },
      });
      await r2.put("key2", "value2", {
        httpMetadata: { contentType: "dinosaur" },
        customMetadata: { bar: "fiz" },
      });
      await r2.put("key3", "value3", {
        httpMetadata: { contentLanguage: "en" },
        customMetadata: { fiz: "bang" },
      });

      // Check no metadata included by default
      let result = await r2.list({ prefix: ns });
      expect(result.objects.length).toEqual(3);
      expect(result.objects[0].httpMetadata).toEqual({});
      expect(result.objects[0].customMetadata).toEqual({});
      expect(result.objects[1].httpMetadata).toEqual({});
      expect(result.objects[1].customMetadata).toEqual({});
      expect(result.objects[2].httpMetadata).toEqual({});
      expect(result.objects[2].customMetadata).toEqual({});

      // Check httpMetadata included if specified
      result = await r2.list({ prefix: ns, include: ["httpMetadata"] });
      expect(result.objects.length).toEqual(3);
      expect(result.objects[0].httpMetadata).toEqual({
        contentEncoding: "gzip",
      });
      expect(result.objects[0].customMetadata).toEqual({});
      expect(result.objects[1].httpMetadata).toEqual({
        contentType: "dinosaur",
      });
      expect(result.objects[1].customMetadata).toEqual({});
      expect(result.objects[2].httpMetadata).toEqual({ contentLanguage: "en" });
      expect(result.objects[2].customMetadata).toEqual({});

      // Check customMetadata included if specified
      result = await r2.list({ prefix: ns, include: ["customMetadata"] });
      expect(result.objects.length).toEqual(3);
      expect(result.objects[0].httpMetadata).toEqual({});
      expect(result.objects[0].customMetadata).toEqual({ foo: "bar" });
      expect(result.objects[1].httpMetadata).toEqual({});
      expect(result.objects[1].customMetadata).toEqual({ bar: "fiz" });
      expect(result.objects[2].httpMetadata).toEqual({});
      expect(result.objects[2].customMetadata).toEqual({ fiz: "bang" });

      // Check both included if specified
      result = await r2.list({
        prefix: ns,
        include: ["httpMetadata", "customMetadata"],
      });
      expect(result.objects.length).toEqual(3);
      expect(result.objects[0].httpMetadata).toEqual({
        contentEncoding: "gzip",
      });
      expect(result.objects[0].customMetadata).toEqual({ foo: "bar" });
      expect(result.objects[1].httpMetadata).toEqual({
        contentType: "dinosaur",
      });
      expect(result.objects[1].customMetadata).toEqual({ bar: "fiz" });
      expect(result.objects[2].httpMetadata).toEqual({ contentLanguage: "en" });
      expect(result.objects[2].customMetadata).toEqual({ fiz: "bang" });

      // `workerd` will validate the `include` array:
      // https://github.com/cloudflare/workerd/blob/44907df95f231a2411d4e9767400951e55c6eb4c/src/workerd/api/r2-bucket.c%2B%2B#L737
    },
  );

  r2Test(
    "list: returns correct delimitedPrefixes for delimiter and prefix",
    async ({ r2, ns }) => {
      const values: Record<string, string> = {
        // In lexicographic key order, so `allKeys` is sorted
        "dir0/file0": "value0",
        "dir0/file1": "value1",
        "dir0/sub0/file2": "value2",
        "dir0/sub0/file3": "value3",
        "dir0/sub1/file4": "value4",
        "dir0/sub1/file5": "value5",
        "dir1/file6": "value6",
        "dir1/file7": "value7",
        file8: "value8",
        file9: "value9",
      };
      const allKeys = Object.keys(values);
      for (const [key, value] of Object.entries(values))
        await r2.put(key, value);

      const keys = (result: ListResult) =>
        result.objects.map(({ key }) => key.substring(ns.length));
      const delimitedPrefixes = (result: ListResult) =>
        result.delimitedPrefixes.map((prefix) => prefix.substring(ns.length));
      const allKeysWithout = (...exclude: Array<string>) =>
        allKeys.filter((value) => !exclude.includes(value));

      // Check no/empty delimiter
      let result = await r2.list({ prefix: ns });
      expect(result.truncated).toBe(false);
      expect(keys(result)).toEqual(allKeys);
      expect(delimitedPrefixes(result)).toEqual([]);
      result = await r2.list({ prefix: ns, delimiter: "" });
      expect(result.truncated).toBe(false);
      expect(keys(result)).toEqual(allKeys);
      expect(delimitedPrefixes(result)).toEqual([]);

      // Check with file delimiter
      result = await r2.list({ prefix: ns, delimiter: "file8" });
      expect(result.truncated).toBe(false);
      expect(keys(result)).toEqual(allKeysWithout("file8"));
      expect(delimitedPrefixes(result)).toEqual(["file8"]);
      // ...and prefix
      result = await r2.list({ prefix: `${ns}dir1/`, delimiter: "file6" });
      expect(result.truncated).toBe(false);
      expect(keys(result)).toEqual(["dir1/file7"]);
      expect(delimitedPrefixes(result)).toEqual(["dir1/file6"]);

      // Check with "/" delimiter
      result = await r2.list({ prefix: ns, delimiter: "/" });
      expect(result.truncated).toBe(false);
      expect(keys(result)).toEqual(["file8", "file9"]);
      expect(delimitedPrefixes(result)).toEqual(["dir0/", "dir1/"]);
      // ...and prefix
      result = await r2.list({ prefix: `${ns}dir0/`, delimiter: "/" });
      expect(result.truncated).toBe(false);
      expect(keys(result)).toEqual(["dir0/file0", "dir0/file1"]);
      expect(delimitedPrefixes(result)).toEqual(["dir0/sub0/", "dir0/sub1/"]);
      result = await r2.list({ prefix: `${ns}dir0`, delimiter: "/" });
      expect(result.truncated).toBe(false);
      expect(keys(result)).toEqual([]);
      expect(delimitedPrefixes(result)).toEqual(["dir0/"]);

      // Check with limit (limit includes returned objects and delimitedPrefixes)
      const opt: R2ListOptions = {
        prefix: `${ns}dir0/`,
        delimiter: "/",
        limit: 2,
      };
      result = await r2.list(opt);
      assert(result.truncated);
      expect(keys(result)).toEqual(["dir0/file0", "dir0/file1"]);
      expect(delimitedPrefixes(result)).toEqual([]);
      result = await r2.list({ ...opt, cursor: result.cursor });
      expect(result.truncated).toBe(false);
      expect(keys(result)).toEqual([]);
      expect(delimitedPrefixes(result)).toEqual(["dir0/sub0/", "dir0/sub1/"]);
    },
  );

  r2Test("operations permit empty key", async ({ r2 }) => {
    // Explicitly testing empty string key, so cannot prefix with namespace
    r2.ns = "";
    try {
      await r2.put("", "empty");
      const object = await r2.head("");
      expect(object?.key).toBe("");

      const objectBody = await r2.get("");
      assert(objectBody instanceof R2ObjectBodyLike);
      expect(await objectBody.text()).toBe("empty");

      const { objects } = await r2.list();
      // Filter by empty key since other tests may have objects in the shared
      // bucket
      const emptyKeyObjects = objects.filter((o) => o.key === "");
      expect(emptyKeyObjects.length).toBe(1);
      expect(emptyKeyObjects[0].key).toBe("");

      await r2.delete("");
      expect(await r2.head("")).toBe(null);
    } finally {
      // Ensure globally namespaced key cleaned up, so it doesn't affect other
      // tests
      await r2.delete("");
    }
  });

  it.effect(
    "operations permit strange bucket names",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "r2-strange-name-test",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: TEST_SCRIPT },
          ],
          bindings: [R2Bucket.local({ binding: "BUCKET", id: "my/ Bucket" })],
        });
        const r2 = new NamespacedR2(worker.baseUrl, "");
        yield* Effect.promise(async () => {
          // Check basic operations work
          await r2.put("key", "value");
          const object = await r2.get("key");
          assert(object instanceof R2ObjectBodyLike);
          expect(await object.text()).toBe("value");
        });
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  // Multipart tests
  const PART_SIZE = 50;

  r2Test("createMultipartUpload", async ({ r2, ns }) => {
    // Check creates upload
    const upload1 = await r2.createMultipartUpload("key", {
      customMetadata: { key: "value" },
      httpMetadata: { contentType: "text/plain" },
    });
    expect(upload1.key).toBe(`${ns}key`);
    expect(upload1.uploadId).not.toBe("");

    // Check creates multiple distinct uploads with different uploadIds for key
    const upload2 = await r2.createMultipartUpload("key");
    expect(upload2.key).toBe(`${ns}key`);
    expect(upload2.uploadId).not.toBe("");
    expect(upload2.uploadId).not.toBe(upload1.uploadId);

    // Check validates key
    r2.ns = "";
    await expect(r2.createMultipartUpload("x".repeat(1025))).rejects.toThrow(
      new Error(
        `createMultipartUpload: The specified object name is not valid. (10020)`,
      ),
    );
  });

  r2Test("uploadPart", async ({ r2, object }) => {
    // Check uploads parts
    const upload = await r2.createMultipartUpload("key");
    const part1 = await upload.uploadPart(1, "value1");
    expect(part1.partNumber).toBe(1);
    expect(part1.etag).not.toBe("");
    const part2 = await upload.uploadPart(2, "value two");
    expect(part2.partNumber).toBe(2);
    expect(part2.etag).not.toBe("");
    expect(part2.etag).not.toBe(part1.etag);
    const stmts = sqlStmts(object);
    const partRows = await stmts.getPartsByUploadId(upload.uploadId);
    expect(partRows.length).toBe(2);
    expect(partRows[0].part_number).toBe(1);
    expect(partRows[0].size).toBe(6);
    expect(partRows[1].part_number).toBe(2);
    expect(partRows[1].size).toBe(9);
    const value1 = await object.getBlob(partRows[0].blob_id);
    expect(value1).toBe("value1");
    const value2 = await object.getBlob(partRows[1].blob_id);
    expect(value2).toBe("value two");

    // Check upload part with same part number and same value
    const part1b = await upload.uploadPart(1, "value1");
    expect(part1b.partNumber).toBe(1);
    expect(part1b.etag).not.toBe(part1.etag);

    // Check upload part with different part number but same value
    const part100 = await upload.uploadPart(100, "value1");
    expect(part100.partNumber).toBe(100);
    expect(part100.etag).not.toBe(part1.etag);

    // Check validates key and uploadId
    let nonExistentUpload = r2.resumeMultipartUpload("key", "bad");
    await expect(nonExistentUpload.uploadPart(1, "value")).rejects.toThrow(
      new Error(
        `uploadPart: The specified multipart upload does not exist. (10024)`,
      ),
    );
    nonExistentUpload = r2.resumeMultipartUpload("badkey", upload.uploadId);
    await expect(nonExistentUpload.uploadPart(1, "value")).rejects.toThrow(
      new Error(
        `uploadPart: The specified multipart upload does not exist. (10024)`,
      ),
    );
    nonExistentUpload = r2.resumeMultipartUpload("x".repeat(1025), "bad");
    await expect(nonExistentUpload.uploadPart(1, "value")).rejects.toThrow(
      new Error(`uploadPart: The specified object name is not valid. (10020)`),
    );
  });

  r2Test("abortMultipartUpload", async ({ r2, object }) => {
    // Check deletes upload and all parts for corresponding upload
    const upload1 = await r2.createMultipartUpload("key");
    const upload2 = await r2.createMultipartUpload("key");
    await upload1.uploadPart(1, "value1");
    await upload1.uploadPart(2, "value2");
    await upload1.uploadPart(3, "value3");
    const stmts = sqlStmts(object);
    const parts = await stmts.getPartsByUploadId(upload1.uploadId);
    expect(parts.length).toBe(3);
    await upload1.abort();
    expect((await stmts.getPartsByUploadId(upload1.uploadId)).length).toBe(0);
    // Check blobs deleted
    await object.waitForFakeTasks();
    for (const part of parts)
      expect(await object.getBlob(part.blob_id)).toBe(null);

    // Check cannot upload after abort
    await expect(upload1.uploadPart(4, "value4")).rejects.toThrow(
      new Error(
        `uploadPart: The specified multipart upload does not exist. (10024)`,
      ),
    );

    // Check can abort already aborted upload
    await upload1.abort();

    // Check can abort already completed upload
    const part1 = await upload2.uploadPart(1, "value1");
    await upload2.complete([part1]);
    await upload2.abort();
    const body = await r2.get("key");
    assert(body instanceof R2ObjectBodyLike);
    expect(await body.text()).toBe("value1");

    // Check validates key and uploadId
    const upload3 = await r2.createMultipartUpload("key");
    // Note this is internalErrorExpectations, not doesNotExistExpectations
    let nonExistentUpload = r2.resumeMultipartUpload("key", "bad");
    await expect(nonExistentUpload.abort()).rejects.toThrow(
      new Error(
        `abortMultipartUpload: We encountered an internal error. Please try again. (10001)`,
      ),
    );
    nonExistentUpload = r2.resumeMultipartUpload("bad", upload3.uploadId);
    await expect(nonExistentUpload.abort()).rejects.toThrow(
      new Error(
        "abortMultipartUpload: We encountered an internal error. Please try again. (10001)",
      ),
    );
    nonExistentUpload = r2.resumeMultipartUpload("x".repeat(1025), "bad");
    await expect(nonExistentUpload.abort()).rejects.toThrow(
      new Error(
        "abortMultipartUpload: The specified object name is not valid. (10020)",
      ),
    );
  });

  r2Test("completeMultipartUpload", async ({ r2, ns, object: objectStub }) => {
    // Check creates regular key with correct metadata, and returns object
    const upload1 = await r2.createMultipartUpload("key", {
      customMetadata: { key: "value" },
      httpMetadata: { contentType: "text/plain" },
    });
    const upload2 = await r2.createMultipartUpload("key");
    let part1 = await upload1.uploadPart(1, "1".repeat(PART_SIZE));
    let part2 = await upload1.uploadPart(2, "2".repeat(PART_SIZE));
    let part3 = await upload1.uploadPart(3, "3");
    let object = await upload1.complete([part1, part2, part3]);
    expect(object.key).toBe(`${ns}key`);
    expect(object.version).not.toBe("");
    expect(object.size).toBe(2 * PART_SIZE + 1);
    expect(object.etag).toBe("3b676245e58d988dc75f80c0c27a9645-3");
    expect(object.httpEtag).toBe('"3b676245e58d988dc75f80c0c27a9645-3"');
    expect(object.range).toBeUndefined();
    expect(object.checksums.toJSON()).toEqual({});
    expect(object.customMetadata).toEqual({ key: "value" });
    expect(object.httpMetadata).toEqual({ contentType: "text/plain" });
    let objectBody = await r2.get("key");
    assert(objectBody instanceof R2ObjectBodyLike);
    expect(await objectBody.text()).toBe(
      `${"1".repeat(PART_SIZE)}${"2".repeat(PART_SIZE)}3`,
    );

    const stmts = sqlStmts(objectStub);
    const parts = await stmts.getPartsByUploadId(upload1.uploadId);
    expect(parts.length).toBe(3);

    // Check requires all but last part to be greater than 5MB
    part1 = await upload2.uploadPart(1, "1");
    part2 = await upload2.uploadPart(2, "2");
    part3 = await upload2.uploadPart(3, "3");
    const sizeError = new Error(
      "completeMultipartUpload: Your proposed upload is smaller than the minimum allowed object size. (10011)",
    );
    await expect(upload2.complete([part1, part2, part3])).rejects.toThrow(
      sizeError,
    );
    await expect(upload2.complete([part1, part2])).rejects.toThrow(sizeError);
    object = await upload2.complete([part1]);
    expect(object.size).toBe(1);
    expect(object.etag).toBe("46d1741e8075da4ac72c71d8130fcb71-1");
    // Check previous multipart uploads blobs deleted
    await objectStub.waitForFakeTasks();
    for (const part of parts)
      expect(await objectStub.getBlob(part.blob_id)).toBe(null);

    // Check completing multiple uploads overrides existing, deleting all parts
    expect((await stmts.getPartsByUploadId(upload1.uploadId)).length).toBe(0);
    expect((await stmts.getPartsByUploadId(upload2.uploadId)).length).toBe(1);
    objectBody = await r2.get("key");
    assert(objectBody instanceof R2ObjectBodyLike);
    expect(await objectBody.text()).toBe("1");

    // Check completing with overridden part
    const upload3 = await r2.createMultipartUpload("key");
    let part1a = await upload3.uploadPart(1, "value");
    let part1b = await upload3.uploadPart(1, "value");
    expect(part1a.partNumber).toBe(part1b.partNumber);
    expect(part1a.etag).not.toBe(part1b.etag);
    const notFoundError = new Error(
      "completeMultipartUpload: One or more of the specified parts could not be found. (10025)",
    );
    await expect(upload3.complete([part1a])).rejects.toThrow(notFoundError);
    object = await upload3.complete([part1b]);
    expect(object.size).toBe(5);

    // Check completing with multiple parts of same part number
    const upload4 = await r2.createMultipartUpload("key");
    part1a = await upload4.uploadPart(1, "1".repeat(PART_SIZE));
    part1b = await upload4.uploadPart(1, "2".repeat(PART_SIZE));
    const part1c = await upload4.uploadPart(1, "3".repeat(PART_SIZE));
    await expect(upload4.complete([part1a, part1b, part1c])).rejects.toThrow(
      new Error(
        "completeMultipartUpload: We encountered an internal error. Please try again. (10001)",
      ),
    );

    // Check completing with out-of-order parts
    const upload5a = await r2.createMultipartUpload("key");
    part1 = await upload5a.uploadPart(1, "1".repeat(PART_SIZE));
    part2 = await upload5a.uploadPart(2, "2".repeat(PART_SIZE));
    part3 = await upload5a.uploadPart(3, "3".repeat(PART_SIZE));
    object = await upload5a.complete([part2, part3, part1]);
    expect(object.size).toBe(3 * PART_SIZE);
    expect(object.etag).toBe("f1115cc5564e7e0b25bbd87d95c72c86-3");
    objectBody = await r2.get("key");
    assert(objectBody instanceof R2ObjectBodyLike);
    expect(await objectBody.text()).toBe(
      `${"1".repeat(PART_SIZE)}${"2".repeat(PART_SIZE)}${"3".repeat(PART_SIZE)}`,
    );
    const upload5b = await r2.createMultipartUpload("key");
    part1 = await upload5b.uploadPart(1, "1");
    part2 = await upload5b.uploadPart(2, "2".repeat(PART_SIZE));
    part3 = await upload5b.uploadPart(3, "3".repeat(PART_SIZE));
    // Check part size checking happens in argument order (part1's size isn't
    // checked until too late, as it's the last argument so ignored...)
    await expect(upload5b.complete([part2, part3, part1])).rejects.toThrow(
      new Error(
        "completeMultipartUpload: There was a problem with the multipart upload. (10048)",
      ),
    );
    const upload5c = await r2.createMultipartUpload("key");
    part1 = await upload5c.uploadPart(1, "1".repeat(PART_SIZE));
    part2 = await upload5c.uploadPart(2, "2".repeat(PART_SIZE));
    part3 = await upload5c.uploadPart(3, "3");
    // (...but here, part3 isn't the last argument, so get a regular size
    // error)
    await expect(upload5c.complete([part2, part3, part1])).rejects.toThrow(
      sizeError,
    );

    // Check completing with missing parts
    const upload6 = await r2.createMultipartUpload("key");
    part2 = await upload6.uploadPart(2, "2".repeat(PART_SIZE));
    const part5 = await upload6.uploadPart(5, "5".repeat(PART_SIZE));
    const part9 = await upload6.uploadPart(9, "9".repeat(PART_SIZE));
    object = await upload6.complete([part2, part5, part9]);
    expect(object.size).toBe(3 * PART_SIZE);
    expect(object.etag).toBe("471d773597286301a10c61cd8c84e659-3");
    objectBody = await r2.get("key");
    assert(objectBody instanceof R2ObjectBodyLike);
    expect(await objectBody.text()).toBe(
      `${"2".repeat(PART_SIZE)}${"5".repeat(PART_SIZE)}${"9".repeat(PART_SIZE)}`,
    );

    // Check completing with no parts
    const upload7 = await r2.createMultipartUpload("key");
    object = await upload7.complete([]);
    expect(object.size).toBe(0);
    expect(object.etag).toBe("d41d8cd98f00b204e9800998ecf8427e-0");
    objectBody = await r2.get("key");
    assert(objectBody instanceof R2ObjectBodyLike);
    expect(await objectBody.text()).toBe("");

    // Check cannot complete with parts from another upload
    const upload8a = await r2.createMultipartUpload("key");
    const upload8b = await r2.createMultipartUpload("key");
    part1 = await upload8b.uploadPart(1, "value");
    await expect(upload8a.complete([part1])).rejects.toThrow(notFoundError);

    const doesNotExistError = new Error(
      "completeMultipartUpload: The specified multipart upload does not exist. (10024)",
    );
    // Check cannot complete already completed upload
    const upload9 = await r2.createMultipartUpload("key");
    part1 = await upload9.uploadPart(1, "value");
    await upload9.complete([part1]);
    await expect(upload9.complete([part1])).rejects.toThrow(doesNotExistError);

    // Check cannot complete aborted upload
    const upload10 = await r2.createMultipartUpload("key");
    part1 = await upload10.uploadPart(1, "value");
    await upload10.abort();
    await expect(upload10.complete([part1])).rejects.toThrow(doesNotExistError);

    // Check validates key and uploadId
    const upload11 = await r2.createMultipartUpload("key");
    // Note this is internalErrorExpectations, not doesNotExistExpectations
    let nonExistentUpload = r2.resumeMultipartUpload("key", "bad");
    await expect(nonExistentUpload.complete([])).rejects.toThrow(
      new Error(
        `completeMultipartUpload: We encountered an internal error. Please try again. (10001)`,
      ),
    );
    nonExistentUpload = r2.resumeMultipartUpload("badkey", upload11.uploadId);
    await expect(nonExistentUpload.complete([])).rejects.toThrow(
      new Error(
        `completeMultipartUpload: We encountered an internal error. Please try again. (10001)`,
      ),
    );
    nonExistentUpload = r2.resumeMultipartUpload("x".repeat(1025), "bad");
    await expect(nonExistentUpload.complete([])).rejects.toThrow(
      new Error(
        `completeMultipartUpload: The specified object name is not valid. (10020)`,
      ),
    );

    // Check requires all but last part to have same size
    const upload13 = await r2.createMultipartUpload("key");
    part1 = await upload13.uploadPart(1, "1".repeat(PART_SIZE));
    part2 = await upload13.uploadPart(2, "2".repeat(PART_SIZE + 1));
    part3 = await upload13.uploadPart(3, "3".repeat(PART_SIZE));
    const multipartError = new Error(
      "completeMultipartUpload: There was a problem with the multipart upload. (10048)",
    );
    await expect(upload13.complete([part1, part2, part3])).rejects.toThrow(
      multipartError,
    );
    part2 = await upload13.uploadPart(2, "2".repeat(PART_SIZE));
    // Check allows last part to have different size, only if <= others
    part3 = await upload13.uploadPart(3, "3".repeat(PART_SIZE + 1));
    await expect(upload13.complete([part1, part2, part3])).rejects.toThrow(
      multipartError,
    );
    part3 = await upload13.uploadPart(3, "3".repeat(PART_SIZE - 1));
    object = await upload13.complete([part1, part2, part3]);
    expect(object.size).toBe(3 * PART_SIZE - 1);

    // Check with non-existent and non-matching parts
    const upload14 = await r2.createMultipartUpload("key");
    part1 = await upload14.uploadPart(1, "1".repeat(PART_SIZE));
    part2 = await upload14.uploadPart(2, "2");
    await expect(
      upload14.complete([part1, { partNumber: 3, etag: part2.etag }]),
    ).rejects.toThrow(notFoundError);
    await expect(
      upload14.complete([part1, { partNumber: 2, etag: "bad" }]),
    ).rejects.toThrow(notFoundError);
    await expect(
      upload14.complete([part1, { partNumber: 4, etag: "very bad" }]),
    ).rejects.toThrow(notFoundError);
  });

  // Check regular operations on buckets with existing multipart keys
  r2Test("head: is multipart aware", async ({ r2, ns }) => {
    // Check returns nothing for in-progress multipart upload
    const upload = await r2.createMultipartUpload("key", {
      customMetadata: { key: "value" },
      httpMetadata: { contentType: "text/plain" },
    });
    const part1 = await upload.uploadPart(1, "1".repeat(PART_SIZE));
    const part2 = await upload.uploadPart(2, "2".repeat(PART_SIZE));
    const part3 = await upload.uploadPart(3, "3".repeat(PART_SIZE));
    expect(await r2.head("key")).toBe(null);

    // Check returns metadata for completed upload
    const completed = await upload.complete([part1, part2, part3]);
    const object = await r2.head("key");
    expect(object?.key).toBe(`${ns}key`);
    expect(object?.version).toBe(completed.version);
    expect(object?.size).toBe(3 * PART_SIZE);
    expect(object?.etag).toBe("f1115cc5564e7e0b25bbd87d95c72c86-3");
    expect(object?.httpEtag).toBe('"f1115cc5564e7e0b25bbd87d95c72c86-3"');
    expect(object?.range).toEqual({ offset: 0, length: 150 });
    expect(object?.checksums.toJSON()).toEqual({});
    expect(object?.customMetadata).toEqual({ key: "value" });
    expect(object?.httpMetadata).toEqual({ contentType: "text/plain" });
  });

  r2Test("get: is multipart aware", async ({ r2, ns }) => {
    // Check returns nothing for in-progress multipart upload
    const upload = await r2.createMultipartUpload("key", {
      customMetadata: { key: "value" },
      httpMetadata: { contentType: "text/plain" },
    });
    const part1 = await upload.uploadPart(1, "a".repeat(PART_SIZE));
    const part2 = await upload.uploadPart(2, "b".repeat(PART_SIZE));
    const part3 = await upload.uploadPart(3, "c".repeat(PART_SIZE));
    expect(await r2.get("key")).toBe(null);

    // Check returns metadata and value for completed upload
    const completed = await upload.complete([part1, part2, part3]);
    let object = await r2.get("key");
    assert(object instanceof R2ObjectBodyLike);
    expect(object?.key).toBe(`${ns}key`);
    expect(object?.version).toBe(completed.version);
    expect(object?.size).toBe(3 * PART_SIZE);
    expect(object?.etag).toBe("d63a28fd44cfddc0215c8da47e582eb7-3");
    expect(object?.httpEtag).toBe('"d63a28fd44cfddc0215c8da47e582eb7-3"');
    expect(object?.range).toEqual({ offset: 0, length: 3 * PART_SIZE });
    expect(object?.checksums.toJSON()).toEqual({});
    expect(object?.customMetadata).toEqual({ key: "value" });
    expect(object?.httpMetadata).toEqual({ contentType: "text/plain" });
    expect(await object?.text()).toBe(
      `${"a".repeat(PART_SIZE)}${"b".repeat(PART_SIZE)}${"c".repeat(PART_SIZE)}`,
    );

    // Check ranged get accessing single part
    const halfPartSize = Math.floor(PART_SIZE / 2);
    const quarterPartSize = Math.floor(PART_SIZE / 4);
    object = await r2.get("key", {
      range: { offset: halfPartSize, length: quarterPartSize },
    });
    assert(object instanceof R2ObjectBodyLike);
    expect(await object?.text()).toBe("a".repeat(quarterPartSize));

    // Check ranged get accessing multiple parts
    object = await r2.get("key", {
      range: {
        offset: halfPartSize,
        length: halfPartSize + PART_SIZE + quarterPartSize,
      },
    });
    assert(object instanceof R2ObjectBodyLike);
    expect(await object?.text()).toBe(
      `${"a".repeat(halfPartSize)}${"b".repeat(PART_SIZE)}${"c".repeat(quarterPartSize)}`,
    );

    // Check ranged get of suffix
    object = await r2.get("key", {
      range: { suffix: quarterPartSize + PART_SIZE },
    });
    assert(object instanceof R2ObjectBodyLike);
    expect(await object?.text()).toBe(
      `${"b".repeat(quarterPartSize)}${"c".repeat(PART_SIZE)}`,
    );
  });

  r2Test("put: is multipart aware", async ({ r2, object: objectStub }) => {
    // Check doesn't overwrite parts for in-progress multipart upload
    const upload = await r2.createMultipartUpload("key");
    const part1 = await upload.uploadPart(1, "1".repeat(PART_SIZE));
    const part2 = await upload.uploadPart(2, "2".repeat(PART_SIZE));
    const part3 = await upload.uploadPart(3, "3".repeat(PART_SIZE));
    await r2.put("key", "value");

    const stmts = sqlStmts(objectStub);
    expect((await stmts.getPartsByUploadId(upload.uploadId)).length).toBe(3);

    const object = await upload.complete([part1, part2, part3]);
    expect(object.size).toBe(3 * PART_SIZE);
    const parts = await stmts.getPartsByUploadId(upload.uploadId);
    expect(parts.length).toBe(3);

    // Check overwrites all multipart parts of completed upload
    await r2.put("key", "new-value");
    expect((await stmts.getPartsByUploadId(upload.uploadId)).length).toBe(0);
    // Check deletes all previous blobs
    await objectStub.waitForFakeTasks();
    for (const part of parts)
      expect(await objectStub.getBlob(part.blob_id)).toBe(null);
  });

  r2Test("delete: is multipart aware", async ({ r2, object: objectStub }) => {
    // Check doesn't remove parts for in-progress multipart upload
    const upload = await r2.createMultipartUpload("key");
    const part1 = await upload.uploadPart(1, "1".repeat(PART_SIZE));
    const part2 = await upload.uploadPart(2, "2".repeat(PART_SIZE));
    const part3 = await upload.uploadPart(3, "3".repeat(PART_SIZE));
    await r2.delete("key");

    // Check removes all multipart parts of completed upload
    const object = await upload.complete([part1, part2, part3]);
    expect(object.size).toBe(3 * PART_SIZE);
    const stmts = sqlStmts(objectStub);
    const parts = await stmts.getPartsByUploadId(upload.uploadId);
    expect(parts.length).toBe(3);
    await r2.delete("key");
    expect((await stmts.getPartsByUploadId(upload.uploadId)).length).toBe(0);
    // Check deletes all previous blobs
    await objectStub.waitForFakeTasks();
    for (const part of parts)
      expect(await objectStub.getBlob(part.blob_id)).toBe(null);
  });

  r2Test(
    "delete: waits for in-progress multipart gets before deleting part blobs",
    async ({ r2, object: objectStub }) => {
      const upload = await r2.createMultipartUpload("key");
      const part1 = await upload.uploadPart(1, "1".repeat(PART_SIZE));
      const part2 = await upload.uploadPart(2, "2".repeat(PART_SIZE));
      const part3 = await upload.uploadPart(3, "3".repeat(PART_SIZE));
      await upload.complete([part1, part2, part3]);

      const objectBody1 = await r2.get("key");
      const objectBody2 = await r2.get("key", { range: { offset: PART_SIZE } });
      const stmts = sqlStmts(objectStub);
      const parts = await stmts.getPartsByUploadId(upload.uploadId);
      expect(parts.length).toBe(3);
      await r2.delete("key");
      assert(objectBody1 instanceof R2ObjectBodyLike);
      assert(objectBody2 instanceof R2ObjectBodyLike);
      expect(await objectBody1.text()).toBe(
        `${"1".repeat(PART_SIZE)}${"2".repeat(PART_SIZE)}${"3".repeat(PART_SIZE)}`,
      );
      expect(await objectBody2.text()).toBe(
        `${"2".repeat(PART_SIZE)}${"3".repeat(PART_SIZE)}`,
      );

      await objectStub.waitForFakeTasks();
      for (const part of parts)
        expect(await objectStub.getBlob(part.blob_id)).toBe(null);
    },
  );

  r2Test("list: is multipart aware", async ({ r2, ns }) => {
    // Check returns nothing for in-progress multipart upload
    const upload = await r2.createMultipartUpload("key", {
      customMetadata: { key: "value" },
      httpMetadata: { contentType: "text/plain" },
    });
    const part1 = await upload.uploadPart(1, "x".repeat(PART_SIZE));
    const part2 = await upload.uploadPart(2, "y".repeat(PART_SIZE));
    const part3 = await upload.uploadPart(3, "z".repeat(PART_SIZE));
    let { objects } = await r2.list({
      prefix: ns,
      include: ["httpMetadata", "customMetadata"],
    });
    expect(objects.length).toBe(0);

    // Check returns metadata for completed upload
    const completed = await upload.complete([part1, part2, part3]);
    ({ objects } = await r2.list({
      prefix: ns,
      include: ["httpMetadata", "customMetadata"],
    }));
    expect(objects.length).toBe(1);
    const object = objects[0];
    expect(object?.key).toBe(`${ns}key`);
    expect(object?.version).toBe(completed.version);
    expect(object?.size).toBe(3 * PART_SIZE);
    expect(object?.etag).toBe("9f4271a2af6d83c1d3fef1cc6d170f9f-3");
    expect(object?.httpEtag).toBe('"9f4271a2af6d83c1d3fef1cc6d170f9f-3"');
    expect(object?.range).toBeUndefined();
    expect(object?.checksums.toJSON()).toEqual({});
    expect(object?.customMetadata).toEqual({ key: "value" });
    expect(object?.httpMetadata).toEqual({ contentType: "text/plain" });
  });
});

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

describe("R2Bucket binding persistence", () => {
  it.effect(
    "persists on file-system",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const tmp = yield* makeTempDirectory("r2-persist-");

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
          function* (run: (r2: NamespacedR2) => Promise<void>) {
            const worker = yield* startTestWorker({
              name: "r2-persist-test",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              modules: [
                { name: "main.js", type: "ESModule", content: TEST_SCRIPT },
              ],
              bindings: [R2Bucket.local({ binding: "BUCKET", id: "bucket" })],
            });
            yield* Effect.promise(() =>
              run(new NamespacedR2(worker.baseUrl, "")),
            );
          },
          (self) =>
            self.pipe(Effect.provide(runtimeLayerTempDir), Effect.scoped),
        );

        yield* runAgainstStorage(async (r2) => {
          // Check put respects persist
          await r2.put("key", "value");

          // Check head respects persist
          const object = await r2.head("key");
          expect(object?.size).toBe(5);
        });

        // Check directories created for the Durable Object SQLite databases
        // and the bucket's blobs
        const names = yield* fs.readDirectory(path.join(tmp, "r2"));
        expect(names).toContain("cloudflare-runtime-R2BucketObject");
        expect(names).toContain("bucket");

        // Check "restarting" keeps persisted data
        yield* runAgainstStorage(async (r2) => {
          // Check get respects persist
          const objectBody = await r2.get("key");
          assert(objectBody instanceof R2ObjectBodyLike);
          expect(await objectBody.text()).toBe("value");

          // Check list respects persist
          const { objects } = await r2.list();
          expect(objects.length).toBe(1);
          expect(objects[0].size).toBe(5);

          // Check delete respects persist
          await r2.delete("key");
          expect(await r2.head("key")).toBe(null);

          // Check multipart operations respect persist
          const upload = await r2.createMultipartUpload("multipart");
          const part = await upload.uploadPart(1, "multipart");
          const completed = await upload.complete([part]);
          expect(completed?.size).toBe(9);
          expect(await r2.head("multipart")).not.toBe(null);
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
});

// -----------------------------------------------------------------------------
// Conditional evaluation (adapted from Miniflare's
// `test/fixtures/r2/validator.ts`, run in-worker upstream)
// -----------------------------------------------------------------------------

describe("testR2Conditional", () => {
  it("matches various conditions", () => {
    // Adapted from internal R2 gateway tests
    const etag = "test";
    const badEtag = "not-test";

    const uploadedDate = new Date("2023-02-24T00:09:00.500Z");
    const pastDate = new Date(uploadedDate.getTime() - 30_000);
    const futureDate = new Date(uploadedDate.getTime() + 30_000);

    const metadata = { etag, uploaded: uploadedDate.getTime() };

    const using = (cond: R2Bucket.R2Conditional) =>
      R2Bucket.testR2Conditional(cond, metadata);
    const usingMissing = (cond: R2Bucket.R2Conditional) =>
      R2Bucket.testR2Conditional(cond);

    // Check single conditions
    expect(using({ etagMatches: [{ type: "strong", value: etag }] })).toBe(
      true,
    );
    expect(using({ etagMatches: [{ type: "strong", value: badEtag }] })).toBe(
      false,
    );

    expect(
      using({ etagDoesNotMatch: [{ type: "strong", value: badEtag }] }),
    ).toBe(true);
    expect(using({ etagDoesNotMatch: [{ type: "strong", value: etag }] })).toBe(
      false,
    );

    expect(using({ uploadedBefore: pastDate })).toBe(false);
    expect(using({ uploadedBefore: futureDate })).toBe(true);

    expect(using({ uploadedAfter: pastDate })).toBe(true);
    expect(using({ uploadedAfter: futureDate })).toBe(false);

    // Check with weaker etags
    expect(using({ etagMatches: [{ type: "weak", value: etag }] })).toBe(false);
    expect(using({ etagDoesNotMatch: [{ type: "weak", value: etag }] })).toBe(
      false,
    );
    expect(
      using({ etagDoesNotMatch: [{ type: "weak", value: badEtag }] }),
    ).toBe(true);
    expect(using({ etagMatches: [{ type: "wildcard" }] })).toBe(true);
    expect(using({ etagDoesNotMatch: [{ type: "wildcard" }] })).toBe(false);

    // Check multiple conditions that evaluate to false
    expect(
      using({
        etagMatches: [{ type: "strong", value: etag }],
        etagDoesNotMatch: [{ type: "strong", value: etag }],
      }),
    ).toBe(false);
    expect(
      using({
        etagMatches: [{ type: "strong", value: etag }],
        uploadedAfter: futureDate,
      }),
    ).toBe(false);
    expect(
      using({
        // `etagMatches` pass makes `uploadedBefore` pass, but `uploadedAfter`
        // fails
        etagMatches: [{ type: "strong", value: etag }],
        uploadedAfter: futureDate,
        uploadedBefore: pastDate,
      }),
    ).toBe(false);
    expect(
      using({
        etagDoesNotMatch: [{ type: "strong", value: badEtag }],
        uploadedBefore: pastDate,
      }),
    ).toBe(false);
    expect(
      using({
        // `etagDoesNotMatch` pass makes `uploadedAfter` pass, but
        // `uploadedBefore` fails
        etagDoesNotMatch: [{ type: "strong", value: badEtag }],
        uploadedAfter: futureDate,
        uploadedBefore: pastDate,
      }),
    ).toBe(false);
    expect(
      using({
        etagMatches: [{ type: "strong", value: badEtag }],
        etagDoesNotMatch: [{ type: "strong", value: badEtag }],
        uploadedAfter: pastDate,
        uploadedBefore: futureDate,
      }),
    ).toBe(false);

    // Check multiple conditions that evaluate to true
    expect(
      using({
        etagMatches: [{ type: "strong", value: etag }],
        etagDoesNotMatch: [{ type: "strong", value: badEtag }],
      }),
    ).toBe(true);
    // `etagMatches` pass makes `uploadedBefore` pass
    expect(
      using({
        etagMatches: [{ type: "strong", value: etag }],
        uploadedBefore: pastDate,
      }),
    ).toBe(true);
    // `etagDoesNotMatch` pass makes `uploadedAfter` pass
    expect(
      using({
        etagDoesNotMatch: [{ type: "strong", value: badEtag }],
        uploadedAfter: futureDate,
      }),
    ).toBe(true);
    expect(
      using({
        // `etagMatches` pass makes `uploadedBefore` pass
        etagMatches: [{ type: "strong", value: etag }],
        uploadedBefore: pastDate,
        // `etagDoesNotMatch` pass makes `uploadedAfter` pass
        etagDoesNotMatch: [{ type: "strong", value: badEtag }],
        uploadedAfter: futureDate,
      }),
    ).toBe(true);
    expect(
      using({
        uploadedBefore: futureDate,
        // `etagDoesNotMatch` pass makes `uploadedAfter` pass
        etagDoesNotMatch: [{ type: "strong", value: badEtag }],
        uploadedAfter: futureDate,
      }),
    ).toBe(true);
    expect(
      using({
        uploadedAfter: pastDate,
        // `etagMatches` pass makes `uploadedBefore` pass
        etagMatches: [{ type: "strong", value: etag }],
        uploadedBefore: pastDate,
      }),
    ).toBe(true);

    // Check missing metadata fails with either `etagMatches` and
    // `uploadedAfter`
    expect(
      usingMissing({ etagMatches: [{ type: "strong", value: etag }] }),
    ).toBe(false);
    expect(usingMissing({ uploadedAfter: pastDate })).toBe(false);
    expect(
      usingMissing({
        etagMatches: [{ type: "strong", value: etag }],
        uploadedAfter: pastDate,
      }),
    ).toBe(false);
    expect(
      usingMissing({ etagDoesNotMatch: [{ type: "strong", value: etag }] }),
    ).toBe(true);
    expect(usingMissing({ uploadedBefore: pastDate })).toBe(true);
    expect(
      usingMissing({
        etagDoesNotMatch: [{ type: "strong", value: etag }],
        uploadedBefore: pastDate,
      }),
    ).toBe(true);
    expect(
      usingMissing({
        etagMatches: [{ type: "strong", value: etag }],
        uploadedBefore: pastDate,
      }),
    ).toBe(false);
    expect(
      usingMissing({
        etagDoesNotMatch: [{ type: "strong", value: etag }],
        uploadedAfter: pastDate,
      }),
    ).toBe(false);

    // Check with second granularity
    const justPastDate = new Date(uploadedDate.getTime() - 250);
    const justFutureDate = new Date(uploadedDate.getTime() + 250);
    expect(using({ uploadedAfter: justPastDate })).toBe(true);
    expect(
      using({ uploadedAfter: justPastDate, secondsGranularity: true }),
    ).toBe(false);
    expect(using({ uploadedBefore: justFutureDate })).toBe(true);
    expect(
      using({ uploadedBefore: justFutureDate, secondsGranularity: true }),
    ).toBe(false);
  });
});

import { createHash } from "node:crypto";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import Stack from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const HOOK_TIMEOUT = 120_000;
const TEST_TIMEOUT = 120_000;

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

// Bounded spaced schedule — caps total wait so a genuine failure
// surfaces fast instead of an uncapped exponential blowing past the
// test timeout while riding out cold-start propagation.
const ready = Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(10)]);

/** Retry an HTTP call until it returns 200 (rides out cold-start 404s). */
const untilOk = <E, R>(eff: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>) =>
  eff.pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) => Effect.fail(new WorkerNotReady({ status: res.status, body }))),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: ready,
    }),
  );

class ValueMismatch extends Data.TaggedError("ValueMismatch")<{
  expected: string;
  actual: string | null;
}> {}

const retryMismatch = <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  eff.pipe(
    Effect.retry({
      while: (e: E) => e instanceof ValueMismatch,
      schedule: ready,
    }),
  );

/** GET `${base}/get?key=` and retry until the value matches (read-after-write propagation). */
const expectValue = (base: string, key: string, expected: string) =>
  untilOk(HttpClient.get(`${base}/get?key=${encodeURIComponent(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const actual = (body as { value: string | null }).value;
      return actual === expected
        ? Effect.succeed(actual)
        : Effect.fail(new ValueMismatch({ expected, actual }));
    }),
    retryMismatch,
  );

/** GET `/get` and retry until the object is gone (`value === null`). */
const expectMissing = (base: string, key: string) =>
  untilOk(HttpClient.get(`${base}/get?key=${encodeURIComponent(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const actual = (body as { value: string | null }).value;
      return actual === null
        ? Effect.succeed(null)
        : Effect.fail(new ValueMismatch({ expected: "<missing>", actual }));
    }),
    retryMismatch,
  );

/** HEAD-equivalent: `/head` returns `{ exists, size }` (metadata only, no body). */
const headObject = (base: string, key: string) =>
  untilOk(HttpClient.get(`${base}/head?key=${encodeURIComponent(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.map((body) => body as { exists: boolean; size: number | null }),
  );

/** `/list?prefix=` and retry until `key` appears (list is eventually consistent). */
const expectListed = (base: string, prefix: string, key: string) =>
  untilOk(HttpClient.get(`${base}/list?prefix=${encodeURIComponent(prefix)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const keys = (body as { keys: string[] }).keys;
      return keys.includes(key)
        ? Effect.succeed(keys)
        : Effect.fail(new ValueMismatch({ expected: key, actual: keys.join(",") }));
    }),
    retryMismatch,
  );

const put = (base: string, key: string, value: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.put(`${base}/put?key=${encodeURIComponent(key)}`).pipe(
        HttpClientRequest.bodyText(value),
      ),
    ),
  );

/** PUT `/put-stream?key=&sha256=`: the body is streamed into R2 under a declared hash. */
const putStream = (base: string, key: string, body: string, sha256: string) =>
  HttpClient.execute(
    HttpClientRequest.put(
      `${base}/put-stream?key=${encodeURIComponent(key)}&sha256=${sha256}`,
    ).pipe(HttpClientRequest.bodyText(body)),
  );

const del = (base: string, key: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.make("DELETE")(`${base}/del?key=${encodeURIComponent(key)}`),
    ),
  );

const delMany = (base: string, keys: string[]) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.make("DELETE")(
        `${base}/del-many?keys=${encodeURIComponent(keys.join(","))}`,
      ),
    ),
  );

const putCopySource = (base: string, key: string, value: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.put(`${base}/copy-source?key=${encodeURIComponent(key)}`).pipe(
        HttpClientRequest.bodyText(value),
      ),
    ),
  );

const copyStream = (
  base: string,
  source: string,
  key: string,
  options: Record<string, string> = {},
) =>
  HttpClient.execute(
    HttpClientRequest.post(
      `${base}/copy-stream?${new URLSearchParams({ source, key, ...options })}`,
    ),
  );

const readCopy = (base: string, key: string) =>
  untilOk(HttpClient.get(`${base}/copy-readback?key=${encodeURIComponent(key)}`)).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map(
      (body) =>
        body as {
          exists: boolean;
          size: number;
          bytes: number[];
          httpMetadata: { contentType: string; cacheControl: string };
          customMetadata: { purpose: string; label: string };
        },
    ),
  );

const expectCopy = (base: string, key: string, bytes: Uint8Array, source: string) =>
  Effect.gen(function* () {
    const object = yield* readCopy(base, key);
    expect(object.exists).toBe(true);
    expect(object.size).toBe(bytes.byteLength);
    expect(object.bytes).toEqual(Array.from(bytes));
    expect(object.httpMetadata).toMatchObject({
      contentType: "application/octet-stream",
      cacheControl: "max-age=60",
    });
    expect(object.customMetadata).toEqual({ purpose: "stream-copy", label: source });
  });

/**
 * Drive every client method through `fetch`: `put` → `get` → `head` →
 * `list` → `delete` (single) → `delete` (batch), reading back through
 * `readBase` and writing through `writeBase`. All workers share one bucket,
 * so keys are namespaced by `label` to keep the four runs independent.
 */
const post = (base: string, path: string, key: string) =>
  untilOk(
    HttpClient.execute(HttpClientRequest.post(`${base}/${path}?key=${encodeURIComponent(key)}`)),
  );

const exercise = (
  label: string,
  writeBase: string,
  readBase: string,
  /** Multipart upload is only supported over the native binding. */
  multipart: boolean,
) =>
  Effect.gen(function* () {
    const prefix = `${label}/`;
    const k1 = `${prefix}k1`;
    const v1 = `${label}-value`;

    // put + get (read-after-write)
    expect((yield* put(writeBase, k1, v1)).status).toBe(200);
    expect(yield* expectValue(readBase, k1, v1)).toBe(v1);

    // head — metadata reflects the written object
    const meta = yield* headObject(readBase, k1);
    expect(meta.exists).toBe(true);
    expect(meta.size).toBe(new TextEncoder().encode(v1).length);

    // list — the key shows up under its prefix
    expect(yield* expectListed(readBase, prefix, k1)).toContain(k1);

    // delete (single) — head/get then report it gone
    yield* del(writeBase, k1);
    yield* expectMissing(readBase, k1);
    expect((yield* headObject(readBase, k1)).exists).toBe(false);

    // delete (missing key) — idempotent in BOTH implementations: the native
    // binding resolves on a key that was never there, so the HTTP client must
    // not surface R2's `NoSuchKey` either.
    expect((yield* del(writeBase, `${prefix}never-written`)).status).toBe(200);

    // delete (batch) — write two, delete both in one call
    const k2 = `${prefix}k2`;
    const k3 = `${prefix}k3`;
    yield* put(writeBase, k2, "v2");
    yield* put(writeBase, k3, "v3");
    expect(yield* expectValue(readBase, k2, "v2")).toBe("v2");
    yield* delMany(writeBase, [k2, k3]);
    yield* expectMissing(readBase, k2);
    yield* expectMissing(readBase, k3);

    if (multipart) {
      // 5 MiB first part + 4-byte tail. `head` reads back the size without
      // downloading the payload.
      const expectedSize = 5 * 1024 * 1024 + 4;

      // create → uploadPart → complete
      const mk = `${prefix}mpu`;
      const created = yield* (yield* post(writeBase, "mpu", mk)).json;
      expect((created as { size: number }).size).toBe(expectedSize);
      expect((yield* headObject(readBase, mk)).size).toBe(expectedSize);

      // create → uploadPart → abort (object never materializes)
      const ak = `${prefix}mpu-abort`;
      yield* post(writeBase, "mpu-abort", ak);
      expect((yield* headObject(readBase, ak)).exists).toBe(false);

      // create → resumeMultipartUpload → uploadPart → complete
      const rk = `${prefix}mpu-resume`;
      const resumed = yield* (yield* post(writeBase, "mpu-resume", rk)).json;
      expect((resumed as { size: number }).size).toBe(expectedSize);
      expect((yield* headObject(readBase, rk)).size).toBe(expectedSize);
    }
  });

/**
 * Deploys six Workers that all bind one shared R2 bucket — read /
 * write / read-write, each over the native Worker binding
 * (`*BucketBinding`) and over a scoped HTTP API token (`*BucketHttp`)
 * — via {@link Stack}, then drives each binding flavor over `fetch` in
 * its own test:
 *
 * - write through the Write worker, read it back through the Read
 *   worker (cross-worker, proving both halves agree on the bucket);
 * - round-trip a key through the ReadWrite worker by itself.
 *
 * The stack lives in `fixtures/stack.ts` so it can also be inspected
 * directly, e.g. `alchemy logs --tail --stage test --config ./test/Cloudflare/R2/fixtures/stack.ts`.
 */
const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const output = yield* Effect.exit(stack);
    yield* destroy(Stack);
    if (Exit.isSuccess(output)) {
      yield* Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const gone = yield* r2.getBucket({ accountId, bucketName: output.value.bucketName }).pipe(
          Effect.as(false),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
        );
        expect(gone).toBe(true);
        for (const scriptName of output.value.workerNames) {
          const absent = yield* workers.getScriptSetting({ accountId, scriptName }).pipe(
            Effect.as(false),
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(true)),
          );
          expect(absent).toBe(true);
        }
      }).pipe(Effect.provide(CloudflareApiLive()), Effect.scoped);
    }
  }),
  { timeout: HOOK_TIMEOUT },
);

// ── Native Worker binding ── write through the Write worker, read back through
// the Read worker (cross-worker, proving both halves agree on the bucket).
test(
  "native binding: write + read across separate workers",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise("bind", out.writeBinding, out.readBinding, true);
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:r2", "provider:cloudflare:worker", "live"],
    timeout: TEST_TIMEOUT,
  },
);

// The ReadWrite worker round-trips a key by itself over the native binding.
test(
  "native binding: read-write round-trip in one worker",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise("rw-bind", out.readWriteBinding, out.readWriteBinding, true);
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:r2", "provider:cloudflare:worker", "live"],
    timeout: TEST_TIMEOUT,
  },
);

// A `put` given an Effect `Stream` goes through a `FixedLengthStream`, and
// the options passed alongside it must still reach R2. Without them R2 has
// nothing to verify and stores whatever bytes arrive under the declared
// hash, which lets a caller plant content under a hash it does not have.
test(
  "native binding: a streamed put is verified against its declared sha256",
  Effect.gen(function* () {
    const out = yield* stack;
    const value = "stream-value";
    const sha256 = yield* Effect.sync(() => createHash("sha256").update(value).digest("hex"));

    // Matching hash: stored and readable.
    const ok = yield* untilOk(putStream(out.writeBinding, "stream/ok", value, sha256));
    expect(((yield* ok.json) as { stored: boolean }).stored).toBe(true);
    expect(yield* expectValue(out.readBinding, "stream/ok", value)).toBe(value);

    // Mismatched hash: R2 rejects the body and nothing is stored. The key is
    // cleared first so a previous run cannot satisfy the final check.
    yield* del(out.writeBinding, "stream/bad");
    yield* expectMissing(out.readBinding, "stream/bad");
    const bad = yield* putStream(out.writeBinding, "stream/bad", value, "0".repeat(64));
    expect(bad.status).toBe(400);
    expect(((yield* bad.json) as { stored: boolean }).stored).toBe(false);
    expect((yield* headObject(out.readBinding, "stream/bad")).exists).toBe(false);
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:r2", "provider:cloudflare:worker", "live"],
    timeout: TEST_TIMEOUT,
  },
);

test(
  "native binding: copies real object bodies, ranges and empty bodies with metadata",
  Effect.gen(function* () {
    const { readWriteBinding: base } = yield* stack;
    const source = "copy/native-source";
    const value = "native R2 copy ☃\u0000".repeat(1024);
    const bytes = new TextEncoder().encode(value);
    yield* putCopySource(base, source, value);
    for (const [label, options, expected] of [
      ["implicit", {}, bytes],
      ["explicit", { contentLength: String(bytes.byteLength) }, bytes],
      ["range", { offset: "17", rangeLength: "257", contentLength: "257" }, bytes.slice(17, 274)],
    ] as const) {
      const key = `copy/${label}`;
      yield* del(base, key);
      const copied = yield* untilOk(copyStream(base, source, key, options));
      expect((yield* copied.json) as unknown).toMatchObject({
        stored: true,
        size: expected.byteLength,
      });
      yield* expectCopy(base, key, expected, source);
    }
    const emptySource = "copy/empty-source";
    yield* putCopySource(base, emptySource, "");
    for (const [label, options] of [
      ["implicit", {}],
      ["explicit", { contentLength: "0" }],
    ] as const) {
      const key = `copy/empty-${label}`;
      yield* del(base, key);
      expect((yield* untilOk(copyStream(base, emptySource, key, options))).status).toBe(200);
      yield* expectCopy(base, key, new Uint8Array(), emptySource);
    }
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:r2", "provider:cloudflare:worker", "live"],
    timeout: TEST_TIMEOUT,
  },
);

test(
  "native binding: transformed object streams store their transformed bytes",
  Effect.gen(function* () {
    const { readWriteBinding: base } = yield* stack;
    const source = "copy/transform-source";
    const key = "copy/transformed";
    const value = "transform native bytes ☃".repeat(256);
    const bytes = new TextEncoder().encode(value);
    const transformed = bytes.map((byte) => byte ^ 0xff);
    const sha256 = createHash("sha256").update(transformed).digest("hex");
    yield* putCopySource(base, source, value);
    yield* del(base, key);
    const copied = yield* untilOk(
      copyStream(base, source, key, {
        transform: "invert",
        contentLength: String(bytes.byteLength),
        sha256,
      }),
    );
    expect((yield* copied.json) as unknown).toMatchObject({ stored: true, size: bytes.byteLength });
    yield* expectCopy(base, key, transformed, source);
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:r2", "provider:cloudflare:worker", "live"],
    timeout: TEST_TIMEOUT,
  },
);

test(
  "native binding: forwarded bodies enforce lengths, checksums and conditional writes",
  Effect.gen(function* () {
    const { readWriteBinding: base } = yield* stack;
    const source = "copy/validation-source";
    const value = "verified native body";
    const bytes = new TextEncoder().encode(value);
    yield* putCopySource(base, source, value);
    for (const [label, options] of [
      ["short", { contentLength: String(bytes.byteLength - 1) }],
      ["long", { contentLength: String(bytes.byteLength + 1) }],
      ["checksum", { sha256: "0".repeat(64) }],
    ] as const) {
      const key = `copy/invalid-${label}`;
      yield* del(base, key);
      const rejected = yield* copyStream(base, source, key, options);
      expect(rejected.status).toBe(400);
      expect((yield* rejected.json) as unknown).toMatchObject({ stored: false });
      expect((yield* readCopy(base, key)).exists).toBe(false);
    }
    const checked = "copy/checksum-ok";
    yield* del(base, checked);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect((yield* untilOk(copyStream(base, source, checked, { sha256 }))).status).toBe(200);
    yield* expectCopy(base, checked, bytes, source);

    const existing = "copy/existing";
    yield* putCopySource(base, existing, "keep this value");
    const conditional = yield* untilOk(copyStream(base, source, existing));
    expect((yield* conditional.json) as unknown).toMatchObject({ stored: false, size: null });
    yield* expectCopy(base, existing, new TextEncoder().encode("keep this value"), existing);
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:r2", "provider:cloudflare:worker", "live"],
    timeout: TEST_TIMEOUT,
  },
);

// ── Scoped HTTP API token ── same matrix over the `*BucketHttp` clients
// (multipart is unsupported over the HTTP API, so it is skipped here).
test(
  "http token: write + read across separate workers",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise("http", out.writeHttp, out.readHttp, false);
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:r2", "provider:cloudflare:worker", "live"],
    timeout: TEST_TIMEOUT,
  },
);

test(
  "http token: read-write round-trip in one worker",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise("rw-http", out.readWriteHttp, out.readWriteHttp, false);
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:r2", "provider:cloudflare:worker", "live"],
    timeout: TEST_TIMEOUT,
  },
);

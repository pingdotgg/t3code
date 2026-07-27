import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import Stack from "./fixtures/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 120_000;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

// Bounded spaced schedule — caps total wait so a genuine failure
// surfaces fast instead of an uncapped exponential blowing past the
// test timeout while riding out cold-start propagation.
const ready = Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]);

/** Retry an HTTP call until it returns 200 (rides out cold-start 404s). */
const untilOk = <E, R>(
  eff: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
) =>
  eff.pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body })),
            ),
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

const retryMismatch = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
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
  untilOk(
    HttpClient.get(`${base}/list?prefix=${encodeURIComponent(prefix)}`),
  ).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const keys = (body as { keys: string[] }).keys;
      return keys.includes(key)
        ? Effect.succeed(keys)
        : Effect.fail(
            new ValueMismatch({ expected: key, actual: keys.join(",") }),
          );
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

const del = (base: string, key: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.make("DELETE")(
        `${base}/del?key=${encodeURIComponent(key)}`,
      ),
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

/**
 * Drive every client method through `fetch`: `put` → `get` → `head` →
 * `list` → `delete` (single) → `delete` (batch), reading back through
 * `readBase` and writing through `writeBase`. All workers share one bucket,
 * so keys are namespaced by `label` to keep the four runs independent.
 */
const post = (base: string, path: string, key: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.post(`${base}/${path}?key=${encodeURIComponent(key)}`),
    ),
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
 * directly, e.g. `alchemy tail --stage test ./test/Cloudflare/R2/fixtures/stack.ts`.
 */
const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

// ── Native Worker binding ── write through the Write worker, read back through
// the Read worker (cross-worker, proving both halves agree on the bucket).
test(
  "native binding: write + read across separate workers",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise("bind", out.writeBinding, out.readBinding, true);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);

// The ReadWrite worker round-trips a key by itself over the native binding.
test(
  "native binding: read-write round-trip in one worker",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise(
      "rw-bind",
      out.readWriteBinding,
      out.readWriteBinding,
      true,
    );
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);

// ── Scoped HTTP API token ── same matrix over the `*BucketHttp` clients
// (multipart is unsupported over the HTTP API, so it is skipped here).
test(
  "http token: write + read across separate workers",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise("http", out.writeHttp, out.readHttp, false);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);

test(
  "http token: read-write round-trip in one worker",
  Effect.gen(function* () {
    const out = yield* stack;
    yield* exercise("rw-http", out.readWriteHttp, out.readWriteHttp, false);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);

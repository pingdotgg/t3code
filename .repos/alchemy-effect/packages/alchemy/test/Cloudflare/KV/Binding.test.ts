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
import ReadBindingWorker from "./fixtures/read-binding.ts";
import ReadHttpWorker from "./fixtures/read-http.ts";
import ReadWriteBindingWorker from "./fixtures/readwrite-binding.ts";
import ReadWriteHttpWorker from "./fixtures/readwrite-http.ts";
import WriteBindingWorker from "./fixtures/write-binding.ts";
import WriteHttpWorker from "./fixtures/write-http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

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

// KV is eventually consistent — a fresh write can take a while to be
// visible to a read on a different binding/edge, so allow generous
// retries on the read-back.
const propagate = Schedule.max([
  Schedule.spaced("2 seconds"),
  Schedule.recurs(45),
]);

const enc = encodeURIComponent;

/** Retry a read-back until KV propagation makes it consistent. */
const retryMismatch = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  eff.pipe(
    Effect.retry({
      while: (e: E) => e instanceof ValueMismatch,
      schedule: propagate,
    }),
  );

/** `GET /get` (text) and retry until the value matches. */
const expectValue = (base: string, key: string, expected: string) =>
  untilOk(HttpClient.get(`${base}/get?key=${enc(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const actual = (body as { value: string | null }).value;
      return actual === expected
        ? Effect.succeed(actual)
        : Effect.fail(new ValueMismatch({ expected, actual }));
    }),
    retryMismatch,
  );

/** `GET /get-json` and retry until the parsed value deep-matches. */
const expectJson = (base: string, key: string, expected: unknown) =>
  untilOk(HttpClient.get(`${base}/get-json?key=${enc(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const actual = (body as { value: unknown }).value;
      return JSON.stringify(actual) === JSON.stringify(expected)
        ? Effect.succeed(actual)
        : Effect.fail(
            new ValueMismatch({
              expected: JSON.stringify(expected),
              actual: JSON.stringify(actual),
            }),
          );
    }),
    retryMismatch,
  );

/** `GET /get-bulk` and retry until every key resolves to its expected value. */
const expectBulk = (base: string, expected: Record<string, string>) =>
  untilOk(
    HttpClient.get(
      `${base}/get-bulk?keys=${enc(Object.keys(expected).join(","))}`,
    ),
  ).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const values = (body as { values: Record<string, string | null> }).values;
      return Object.entries(expected).every(([k, v]) => values[k] === v)
        ? Effect.succeed(values)
        : Effect.fail(
            new ValueMismatch({
              expected: JSON.stringify(expected),
              actual: JSON.stringify(values),
            }),
          );
    }),
    retryMismatch,
  );

/** `GET /getWithMetadata` and retry until value + metadata are present. */
const expectMeta = (base: string, key: string, expectedValue: string) =>
  untilOk(HttpClient.get(`${base}/getWithMetadata?key=${enc(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const b = body as {
        value: string | null;
        metadata: { tag?: string } | null;
      };
      return b.value === expectedValue && b.metadata?.tag === "meta"
        ? Effect.succeed(b)
        : Effect.fail(
            new ValueMismatch({
              expected: `${expectedValue}+{tag:meta}`,
              actual: JSON.stringify(b),
            }),
          );
    }),
    retryMismatch,
  );

/** `GET /list?prefix=` and retry until `key` appears under `prefix`. */
const expectListed = (base: string, prefix: string, key: string) =>
  untilOk(HttpClient.get(`${base}/list?prefix=${enc(prefix)}`)).pipe(
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

/** `GET /get` and retry until the object is gone (`value === null`). */
const expectMissing = (base: string, key: string) =>
  untilOk(HttpClient.get(`${base}/get?key=${enc(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const actual = (body as { value: string | null }).value;
      return actual === null
        ? Effect.succeed(null)
        : Effect.fail(new ValueMismatch({ expected: "<missing>", actual }));
    }),
    retryMismatch,
  );

const put = (base: string, key: string, value: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.put(`${base}/put?key=${enc(key)}`).pipe(
        HttpClientRequest.bodyText(value),
      ),
    ),
  );

const putMeta = (base: string, key: string, value: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.put(`${base}/put-meta?key=${enc(key)}`).pipe(
        HttpClientRequest.bodyText(value),
      ),
    ),
  );

const del = (base: string, key: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.make("DELETE")(`${base}/del?key=${enc(key)}`),
    ),
  );

/**
 * Drive the FULL {@link ReadWriteNamespaceClient} surface through one
 * read-write worker: every write method (`put`, `put` with metadata/ttl,
 * `delete`) and every read method (`get` text/json, bulk `get`,
 * `getWithMetadata`, `list` with prefix). Keys are namespaced by `label`
 * so the binding and http runs stay independent on the shared namespace.
 */
const exercise = (label: string, base: string) =>
  Effect.gen(function* () {
    const prefix = `${label}/`;
    const k = (s: string) => `${prefix}${s}`;

    // put + get (text)
    expect((yield* put(base, k("v"), `${label}-v`)).status).toBe(200);
    expect(yield* expectValue(base, k("v"), `${label}-v`)).toBe(`${label}-v`);

    // put with metadata + ttl → getWithMetadata round-trips value + metadata
    yield* putMeta(base, k("m"), `${label}-m`);
    yield* expectMeta(base, k("m"), `${label}-m`);

    // put JSON string → get(key, "json") parses it
    yield* put(base, k("j"), JSON.stringify({ n: 1, label }));
    yield* expectJson(base, k("j"), { n: 1, label });

    // bulk get → get([...], "text") returns every key
    yield* put(base, k("b1"), "B1");
    yield* put(base, k("b2"), "B2");
    yield* expectBulk(base, { [k("b1")]: "B1", [k("b2")]: "B2" });

    // list({ prefix }) surfaces a written key under its prefix
    yield* expectListed(base, prefix, k("v"));

    // delete → get reports it gone
    yield* del(base, k("v"));
    yield* expectMissing(base, k("v"));
  });

/**
 * Deploys six Workers that all bind one shared KV namespace — read /
 * write / read-write, each over the native Worker binding
 * (`*NamespaceBinding`) and over a scoped HTTP API token
 * (`*NamespaceHttp`) — then drives them over `fetch`:
 *
 * - the read-write worker exercises the entire client surface by itself
 *   (every read + write method), once per transport;
 * - the split Read/Write workers prove the separate bindings agree on
 *   the namespace: write through Write, read back through Read, delete
 *   through Write, observe gone through Read.
 */
test.provider.skipIf(!!process.env.FAST)(
  "KV read/write/read-write bindings over binding + http",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const readBinding = yield* ReadBindingWorker;
          const writeBinding = yield* WriteBindingWorker;
          const readWriteBinding = yield* ReadWriteBindingWorker;
          const readHttp = yield* ReadHttpWorker;
          const writeHttp = yield* WriteHttpWorker;
          const readWriteHttp = yield* ReadWriteHttpWorker;
          return {
            readBinding: readBinding.url,
            writeBinding: writeBinding.url,
            readWriteBinding: readWriteBinding.url,
            readHttp: readHttp.url,
            writeHttp: writeHttp.url,
            readWriteHttp: readWriteHttp.url,
          };
        }),
      );

      const url = (u: unknown) => {
        expect(u).toBeTypeOf("string");
        return u as string;
      };

      // ── Full client surface through a single read-write worker ──
      yield* exercise("rw-bind", url(out.readWriteBinding));
      yield* exercise("rw-http", url(out.readWriteHttp));

      // ── Split Read/Write bindings agree on the shared namespace ──
      const crossWorker = (
        label: string,
        writeBase: string,
        readBase: string,
      ) =>
        Effect.gen(function* () {
          const key = `${label}-key`;
          expect((yield* put(writeBase, key, `${label}-value`)).status).toBe(
            200,
          );
          expect(yield* expectValue(readBase, key, `${label}-value`)).toBe(
            `${label}-value`,
          );
          yield* del(writeBase, key);
          yield* expectMissing(readBase, key);
        });

      yield* crossWorker("bind", url(out.writeBinding), url(out.readBinding));
      yield* crossWorker("http", url(out.writeHttp), url(out.readHttp));

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

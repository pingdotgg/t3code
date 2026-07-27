import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import Stack from "./fixtures/stack.ts";
import {
  LITERAL_SECRET_VALUE,
  NUMBER_VAR_VALUE,
  OBJECT_VAR_VALUE,
  STRING_VAR_VALUE,
} from "./fixtures/worker.ts";
/**
 * `Config.redacted("CONFIG_SECRET")` resolves against the active
 * `ConfigProvider` at deploy time. The default provider reads from
 * `process.env`, so populate it before `beforeAll(deploy(Stack))`
 * compiles the stack.
 */
const CONFIG_SECRET_VALUE = (process.env.CONFIG_SECRET =
  "sk-from-config-source-xyz");

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/**
 * Cloudflare's edge takes a few seconds to start serving a fresh
 * workers.dev URL — initial requests can return Cloudflare's "There is
 * nothing here yet" 404 page or a 5xx while the script propagates.
 * Retry until we get a 2xx (or a 4xx that isn't 404 — those are real
 * client errors and should fail loud).
 */
class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const fetchWhenReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res: HttpClientResponse) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady =>
          e instanceof WorkerNotReady && (e.status === 404 || e.status >= 500),
        schedule: Schedule.max([
          Schedule.exponential("500 millis"),
          Schedule.recurs(20),
        ]),
      }),
    );
  });

test(
  "Config.redacted with literal default round-trips to runtime as Redacted<string>",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");

    const res = yield* fetchWhenReady(`${url}/secret/literal`);
    expect(res.status).toBe(200);

    const body = (yield* res.json) as { isRedacted: boolean; value: string };
    expect(body).toEqual({
      isRedacted: true,
      value: LITERAL_SECRET_VALUE,
    });
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "Config.redacted resolved from env deploys as a secret_text and round-trips",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const res = yield* fetchWhenReady(`${url}/secret/config`);
    expect(res.status).toBe(200);

    const body = (yield* res.json) as { isRedacted: boolean; value: string };
    expect(body).toEqual({
      isRedacted: true,
      value: CONFIG_SECRET_VALUE,
    });
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "Config.string round-trips to runtime as a string",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const res = yield* fetchWhenReady(`${url}/var/string`);
    expect(res.status).toBe(200);

    const body = (yield* res.json) as { type: string; value: unknown };
    expect(body).toEqual({ type: "string", value: STRING_VAR_VALUE });
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "Config.number round-trips to runtime preserving the number type",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const res = yield* fetchWhenReady(`${url}/var/number`);
    expect(res.status).toBe(200);

    const body = (yield* res.json) as { type: string; value: unknown };
    expect(body).toEqual({ type: "number", value: NUMBER_VAR_VALUE });
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "Config.string with object default round-trips to runtime preserving nested shape",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const res = yield* fetchWhenReady(`${url}/var/object`);
    expect(res.status).toBe(200);

    const body = (yield* res.json) as { type: string; value: unknown };
    expect(body).toEqual({ type: "object", value: OBJECT_VAR_VALUE });
  }).pipe(logLevel),
  { timeout: 180_000 },
);

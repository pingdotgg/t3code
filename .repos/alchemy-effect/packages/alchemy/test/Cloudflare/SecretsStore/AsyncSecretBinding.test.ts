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
import { SECRET_VALUE } from "./fixtures/secret.ts";

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

const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

// Fresh `workers.dev` URLs take a few seconds to start serving 200s, so the
// first request rides this bounded schedule. Capping at 30 recurs surfaces a
// genuine failure fast instead of an uncapped exponential blowing past the
// test timeout.
class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const ready = Schedule.max([
  Schedule.exponential("500 millis"),
  Schedule.recurs(30),
]);

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
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: ready,
      }),
    );
  });

const assertSecret = (url: string) =>
  Effect.gen(function* () {
    const res = yield* fetchWhenReady(`${url}/secret`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as {
      value: string;
      viaGet: string;
      viaRaw: string;
    };
    expect(body.value).toBe(SECRET_VALUE);
    expect(body.viaGet).toBe(SECRET_VALUE);
    expect(body.viaRaw).toBe(SECRET_VALUE);
  });

// Style (1): `Cloudflare.SecretsStore.ReadSecret(secret)` inside the Worker
// init, binding provided via `ReadSecretBinding`. Drives the full
// `ReadSecretClient` surface (direct Effect, `.get()`, `.raw`).
test(
  "effect-worker: ReadSecret client round-trips the secret value at runtime",
  Effect.gen(function* () {
    const { effect } = yield* stack;
    expect(effect).toBeTypeOf("string");
    yield* assertSecret(effect);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);

// Style (2): the same Secret declared on the Worker `env` async binding. The
// Worker provider must map it to a real `secrets_store_secret` binding so the
// runtime sees a `SecretsStoreSecret` with `.get()`, not a JSON blob.
test(
  "async-worker: Secret on the Worker env round-trips as a SecretsStoreSecret",
  Effect.gen(function* () {
    const { async } = yield* stack;
    expect(async).toBeTypeOf("string");
    yield* assertSecret(async);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);

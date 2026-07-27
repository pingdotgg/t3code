import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/bindings-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Teardown contains a deterministic, bounded long wait that exceeds the 120s
// default hook timeout: deleting the AiSearch instance returns immediately,
// but Cloudflare releases the instance's service token only after its managed
// Vectorize index tears down asynchronously. `AiSearchToken.delete` therefore
// retries `TokenInUseByInstances` for up to ~5 minutes (60 x 5s) — well past
// 120s on its own. Size both hooks above that worst case (plus the rest of the
// teardown) so the destroy completes its real wait instead of being killed
// mid-retry.
const stack = beforeAll(deploy(Stack), { timeout: 420_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 420_000 });

// Deploying the Worker succeeding at all proves Cloudflare accepted both the
// `ai_search` and `ai_search_namespace` bindings. The `/bindings` route then
// confirms they are injected and shaped correctly at runtime.
test(
  "worker deploys with ai_search + ai_search_namespace bindings injected",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");

    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(`${url}/bindings`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      // Cap the backoff at 3s so a fresh worker that takes a while to start
      // serving 200s keeps getting polled steadily, rather than the
      // unbounded exponential delay overshooting the test timeout.
      Effect.retry({
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("3 seconds"),
        ]),
        times: 40,
      }),
    );

    const body = (yield* res.json) as {
      search: string;
      searchChatCompletions: string;
      searchSearch: string;
      ns: string;
      nsGet: string;
    };

    // Single-instance `ai_search` binding resolves to an `AiSearchInstance`
    // object exposing `search()` / `chatCompletions()`.
    expect(body.search).toBe("object");
    expect(body.searchChatCompletions).toBe("function");
    expect(body.searchSearch).toBe("function");
    // `ai_search_namespace` binding resolves to an `AiSearchNamespace` with
    // `.get()`.
    expect(body.ns).toBe("object");
    expect(body.nsGet).toBe("function");
  }).pipe(logLevel),
  { timeout: 240_000 },
);

// The Effect worker attaches the same two binding flavors via
// `Cloudflare.AI.Search.Search(...)` / `Cloudflare.AI.SearchNamespace(...)`
// and reads them through the Effect-native client. Resolving each client's
// `raw` runtime handle proves the Effect-first path wires through to the
// live runtime bindings.
test(
  "effect worker resolves ai_search + ai_search_namespace via Effect clients",
  Effect.gen(function* () {
    const { effectUrl } = yield* stack;
    expect(effectUrl).toBeTypeOf("string");

    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(`${effectUrl}/bindings`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      // Cap the backoff at 3s so a fresh worker that takes a while to start
      // serving 200s keeps getting polled steadily, rather than the
      // unbounded exponential delay overshooting the test timeout.
      Effect.retry({
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("3 seconds"),
        ]),
        times: 40,
      }),
    );

    const body = (yield* res.json) as {
      mode: string;
      searchRaw: string;
      searchChatCompletions: string;
      searchSearch: string;
      nsRaw: string;
      nsChatCompletions: string;
    };

    expect(body.mode).toBe("effect");
    // `Cloudflare.AI.Search.Search(...).raw` resolves to the runtime
    // `AiSearchInstance` exposing `search()` / `chatCompletions()`.
    expect(body.searchRaw).toBe("object");
    expect(body.searchChatCompletions).toBe("function");
    expect(body.searchSearch).toBe("function");
    // `Cloudflare.AI.SearchNamespace(...).raw` resolves to the runtime
    // `AiSearchNamespace`; `.get(name)` scopes to an instance exposing
    // `chatCompletions()`. The namespace handle may be a callable runtime
    // proxy (`typeof` `"function"`) or an object.
    expect(["object", "function"]).toContain(body.nsRaw);
    expect(body.nsChatCompletions).toBe("function");
  }).pipe(logLevel),
  { timeout: 240_000 },
);

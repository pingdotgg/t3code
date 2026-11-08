import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import { A as AsyncCycleA, B as AsyncCycleB } from "./fixtures/async-circular-bindings/stack.ts";
import Stack from "./fixtures/worker-worker-binding/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const deployed = yield* Effect.exit(stack);
    yield* destroy(Stack);
    if (Exit.isFailure(deployed)) return;
    const urls = [
      deployed.value.targetUrl,
      deployed.value.asyncCallerUrl,
      deployed.value.effectCallerUrl,
      deployed.value.selfWorkerUrl,
    ];
    yield* Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      for (const url of urls) {
        const deleted = yield* workers
          .getScript({
            accountId,
            scriptName: new URL(url).hostname.split(".")[0]!,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(true)),
            Effect.repeat({
              while: (gone) => !gone,
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
            Effect.timeout("15 seconds"),
          );
        expect(deleted).toBe(true);
      }
    }).pipe(Effect.provide(CloudflareApiLive()), Effect.scoped);
  }),
  { timeout: 120_000 },
);

// Cold-start retry — fresh `workers.dev` URLs take a few seconds to start
// answering 200, so the very first request rides this schedule. Cap the
// exponential at 5s: uncapped, the doubling sleeps blow through the test
// timeout in a single wait after ~7 misses, even though the edge would
// have propagated moments later.
const coldStartRetry = Effect.retry({
  schedule: Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("5 seconds")]),
  times: 10,
});

for (const encoding of ["json", "bytes"] as const) {
  for (const scenario of ["complete", "cancel", "empty", "head-failure", "tail-failure"] as const) {
    test(
      `native RPC ${encoding} stream handles ${scenario} with its source and event scopes`,
      Effect.gen(function* () {
        const { effectCallerUrl } = yield* stack;
        const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeader("connection", "close")),
        );
        yield* client.get(`${effectCallerUrl}/rpc-stream-ready`).pipe(
          Effect.flatMap((response) => response.text),
          Effect.flatMap((body) =>
            body === "rpc-stream-scopes"
              ? Effect.void
              : Effect.fail(new Error(`Worker not ready: ${body}`)),
          ),
          coldStartRetry,
        );

        // A later request can reach an edge that has not received the route.
        // Only Cloudflare's pre-invocation placeholder is safe to retry.
        const response = yield* requestWorker(
          HttpClientRequest.get(`${effectCallerUrl}/rpc-stream/${encoding}/${scenario}`).pipe(
            HttpClientRequest.setHeader("connection", "close"),
          ),
          { retryDelay: "5 seconds" },
        );
        expect(response.status).toBe(200);
        const body = (yield* response.json) as {
          values: Array<{ part: string; eventClosed: number; sourceClosed: number }>;
          failed: boolean;
          error?: { _tag: string; error?: { _tag: string; phase: string } };
          after: string;
        };
        const parts =
          scenario === "complete"
            ? ["head", "tail"]
            : scenario === "cancel" || scenario === "tail-failure"
              ? ["head"]
              : [];
        expect(body.values).toEqual(
          parts.map((part) => ({ part, eventClosed: 0, sourceClosed: 0 })),
        );
        expect(body.failed).toBe(scenario === "head-failure" || scenario === "tail-failure");
        expect(body.after).toBe("hello after stream");
        if (scenario === "head-failure" || (scenario === "tail-failure" && encoding === "json")) {
          expect(body.error).toMatchObject({
            _tag: "RpcRemoteStreamError",
            error: {
              _tag: "RpcStreamFixtureError",
              phase: scenario === "head-failure" ? "head" : "tail",
            },
          });
        } else if (scenario === "tail-failure") {
          expect(body.error?._tag).toBe("SocketError");
        }
      }).pipe(logLevel),
      { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"], timeout: 90_000 },
    );
  }
}

test(
  "target worker's own fetch handler responds",
  Effect.gen(function* () {
    const { targetUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client.get(targetUrl).pipe(coldStartRetry);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("hello from BindingTargetWorker");
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 120_000,
  },
);

test(
  "async caller can call target's RPC method via service binding",
  Effect.gen(function* () {
    const { asyncCallerUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client.get(`${asyncCallerUrl}/?name=alice`).pipe(coldStartRetry);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("hello alice");
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 120_000,
  },
);

test(
  "async caller can await a toRpcAsync view and call through it",
  Effect.gen(function* () {
    const { asyncCallerUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    // Warm the binding on the plain route so cold starts don't mask the
    // result; the `/rpc-async` call itself is not retried, so a view that
    // is mistaken for a thenable surfaces as the fixture's timeout 500.
    yield* HttpClient.filterStatusOk(client)
      .get(`${asyncCallerUrl}/?name=warmup`)
      .pipe(coldStartRetry);

    const res = yield* client.get(`${asyncCallerUrl}/rpc-async?name=carol`);
    expect(yield* res.text).toBe("hello carol");
    expect(res.status).toBe(200);
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 120_000,
  },
);

test(
  "effect caller can call target's RPC method via bindWorker",
  Effect.gen(function* () {
    const { effectCallerUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client.get(`${effectCallerUrl}/?name=bob`).pipe(coldStartRetry);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("hello bob");
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 120_000,
  },
);

test(
  "effect worker calls its own RPC method via bindWorker(Self)",
  Effect.gen(function* () {
    const { selfWorkerUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client.get(`${selfWorkerUrl}/?name=carol`).pipe(coldStartRetry);
    expect(yield* res.text).toBe("hello carol from self");
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "an effect worker's self binding is not deployed as a service binding",
  () =>
    Effect.gen(function* () {
      const { selfWorkerName } = yield* stack;
      const { accountId } = yield* yield* CloudflareEnvironment;

      // `bindWorker(Self)` resolves through workerd's `ctx.exports.default`
      // loopback, so the upload carries no service binding naming the
      // Worker's own script.
      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: selfWorkerName,
      });
      const selfServiceBindings = (settings.bindings ?? []).filter(
        (binding) => binding.type === "service" && binding.service === selfWorkerName,
      );
      expect(selfServiceBindings).toEqual([]);
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 120_000,
  },
);

test(
  "async worker re-enters its default export through Workers.Self",
  Effect.gen(function* () {
    const { asyncCallerUrl } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    const res = yield* client.get(`${asyncCallerUrl}/self?name=dave`).pipe(coldStartRetry);
    expect(yield* res.text).toBe("via self: inner dave");
  }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 120_000,
  },
);

/**
 * Two plain async Workers bind each other: A binds B's default entrypoint
 * and B binds A's named `Callbacks` entrypoint. Declaring the stack used to
 * recurse between the two `env` declarations until the heap ran out (#2672).
 */
test.provider(
  "async workers in a cycle deploy and call each other",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* AsyncCycleA;
          const b = yield* AsyncCycleB;
          return {
            urlA: a.url.as<string>(),
            workerNames: [a.workerName, b.workerName],
          };
        }),
      );

      // A → B.start → A's Callbacks.done: both edges of the cycle.
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const res = yield* client.get(`${deployed.urlA}/?id=7`).pipe(coldStartRetry);
      expect(yield* res.text).toBe("a got 7");

      yield* stack.destroy();

      const { accountId } = yield* yield* CloudflareEnvironment;
      for (const scriptName of deployed.workerNames) {
        const gone = yield* workers.getScript({ accountId, scriptName }).pipe(
          Effect.as(false),
          Effect.catchTag("WorkerNotFound", () => Effect.succeed(true)),
          Effect.repeat({
            while: (gone) => !gone,
            schedule: Schedule.spaced("1 second"),
            times: 8,
          }),
        );
        expect(gone).toBe(true);
      }
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);

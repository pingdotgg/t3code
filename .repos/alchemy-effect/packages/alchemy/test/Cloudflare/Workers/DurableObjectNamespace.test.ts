import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "./fixtures/do-rpc/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Cap exponential backoff at 3s — keeps the fast-path snappy but stops
// the geometric blow-up (0.5 + 1 + 2 + 4 + 8 + 16 + 32 + 64s ...) that
// makes retries dominate test wall time when CF edge is slow.
const readinessSchedule = Schedule.exponential("500 millis").pipe(
  Schedule.either(Schedule.spaced("3 seconds")),
);

const readinessRetries = 15;

// The test runtime's HttpClient (FetchHttpClient/undici) keeps HTTP/1.1
// connections alive and pooled. A pooled connection stays pinned to a single
// Cloudflare edge metal, so when that metal lags the freshly-deployed version
// every retry rides the same stale socket and keeps reading the old body for
// the life of the keep-alive — even though the new version is already live.
// Forcing `Connection: close` makes each readiness attempt open a fresh
// connection, letting it land on an edge that has the new version (this is
// why a brand-new `curl` sees the update immediately while a kept-alive
// client does not). See do-rpc DurableObjectNamespace test investigation.
const freshConn = HttpClient.mapRequest(
  HttpClientRequest.setHeader("connection", "close"),
);

test(
  "durable object methods can use binding clients",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* client.post(`${url}/roundtrip`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({ schedule: readinessSchedule, times: 15 }),
    );

    expect(res.status).toBe(200);
    const body = (yield* res.json) as { value: string };
    expect(body.value).toBe("ok");
  }).pipe(logLevel),
  { timeout: 60_000 },
);

// Reproduces the `tick` streaming example from the Durable Objects tutorial:
// https://v2.alchemy.run/tutorial/cloudflare/durable-objects/
//
// The DO exposes `tick(n): Stream<number>` and the Worker forwards it to the
// HTTP response with `HttpServerResponse.stream`. The client reads the body as
// newline-delimited integers. With `/tick/5` we expect ["0","1","2","3","4"].
test(
  "tick streams sequential values from a durable object (tutorial repro)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = freshConn(yield* HttpClient.HttpClient);

    const lines = yield* client.get(`${url}/tick/5`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? res.stream.pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.filter((line) => line.length > 0),
              Stream.runCollect,
              Effect.map((chunk) => [...chunk]),
            )
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({ schedule: readinessSchedule, times: readinessRetries }),
    );

    expect(lines).toEqual(["0", "1", "2", "3", "4"]);
  }).pipe(logLevel),
  { timeout: 60_000 },
);

// While a freshly pre-created worker is propagating, Cloudflare's edge
// serves Alchemy's pre-create stub, which responds 200 with this plain-text
// body. It is not the real script, so any poll that sees it must retry.
const DEPLOY_PLACEHOLDER = "Alchemy worker is being deployed...";

// Cloudflare's edge keeps serving the previous worker version (or the
// pre-create stub) for a while after a (re)deploy, so retrying on 200-only
// is not enough — the stale version still returns 200 with the old body.
// Retry until the body matches the expected version string.
const fetchReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.status === 200
          ? Effect.flatMap(r.text, (body) =>
              body === expected
                ? Effect.succeed(body)
                : Effect.fail(
                    new Error(`stale: got ${body}, want ${expected}`),
                  ),
            )
          : Effect.fail(new Error(`Worker not ready: ${r.status}`)),
      ),
      Effect.retry({ schedule: readinessSchedule, times: readinessRetries }),
    );
  });

const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      // Parse the body INSIDE the retry: the pre-create stub answers 200 with
      // a non-JSON placeholder, so JSON decoding must be part of the readiness
      // check (a 200 status alone does not mean the real script is live yet).
      Effect.flatMap((r) =>
        r.status !== 200
          ? Effect.fail(new Error(`Worker not ready: ${r.status}`))
          : Effect.flatMap(r.text, (body) =>
              body.includes(DEPLOY_PLACEHOLDER)
                ? Effect.fail(new Error("stale: still deploying"))
                : Effect.try({
                    try: () => JSON.parse(body) as T,
                    catch: () => new Error(`non-json body: ${body}`),
                  }),
            ),
      ),
      Effect.retry({ schedule: readinessSchedule, times: readinessRetries }),
    );
  });

const hostWorkerScript = `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment() {
    const value = (await this.ctx.storage.get("count")) ?? 0;
    const next = value + 1;
    await this.ctx.storage.put("count", next);
    return next;
  }
  async reset() {
    await this.ctx.storage.delete("count");
  }
  async get() {
    return (await this.ctx.storage.get("count")) ?? 0;
  }
}
export default {
  async fetch(request, env) {
    const stub = env.Counter.getByName("shared");
    const url = new URL(request.url);
    if (url.pathname === "/increment") {
      return Response.json({ value: await stub.increment() });
    }
    if (url.pathname === "/get") {
      return Response.json({ value: await stub.get() });
    }
    if (url.pathname === "/reset") {
      await stub.reset();
      return Response.json({ ok: true });
    }
    return new Response("Not Found", { status: 404 });
  },
};
`;

const consumerWorkerScript = `export default {
  async fetch(request, env) {
    const stub = env.Counter.getByName("shared");
    const url = new URL(request.url);
    if (url.pathname === "/increment") {
      return Response.json({ value: await stub.increment() });
    }
    if (url.pathname === "/get") {
      return Response.json({ value: await stub.get() });
    }
    if (url.pathname === "/reset") {
      await stub.reset();
      return Response.json({ ok: true });
    }
    return new Response("Not Found", { status: 404 });
  },
};
`;

test.provider(
  "async worker durable object binding accepts scriptName",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            host: yield* Cloudflare.Worker("host-worker", {
              script: hostWorkerScript,
              env: {
                Counter: Cloudflare.DurableObjectNamespace("Counter"),
              },
            }),
          };
        }),
      );

      const deployed = yield* scratch.deploy(
        Effect.gen(function* () {
          const host = yield* Cloudflare.Worker("host-worker", {
            script: hostWorkerScript,
            env: {
              Counter: Cloudflare.DurableObjectNamespace("Counter"),
            },
          });
          const consumer = yield* Cloudflare.Worker("consumer-worker", {
            script: consumerWorkerScript,
            env: {
              Counter: Cloudflare.DurableObjectNamespace("Counter", {
                scriptName: host.workerName,
              }),
            },
          });

          return { consumer, host };
        }),
      );

      const reset = yield* fetchJsonReady<{ ok: boolean }>(
        `${deployed.host.url}/reset`,
      );
      expect(reset.ok).toBe(true);

      const first = yield* fetchJsonReady<{ value: number }>(
        `${deployed.consumer.url}/increment`,
      );
      expect(first.value).toBe(1);

      const second = yield* fetchJsonReady<{ value: number }>(
        `${deployed.host.url}/get`,
      );
      expect(second.value).toBe(1);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

// Walk an async worker through four redeploys against the same scratch state,
// each one swapping in a new script + bindings shape so we exercise the
// migration paths `putWorker` relies on:
//   v1 — create with a single DO class `DO_A`
//   v2 — rename `DO_A` → `DO_A_v2` (className change, same binding id)
//   v3 — add a brand-new DO class `DO_B` alongside `DO_A_v2`
//   v4 — delete `DO_A`, keep only `DO_B`
test.provider(
  "durable object class migrations across redeploys",
  (scratch) =>
    Effect.gen(function* () {
      const v1 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: `import { DurableObject } from "cloudflare:workers";
export class DO_A extends DurableObject {}
export default { async fetch() { return new Response("v1"); } };
`,
              env: {
                DO_A: Cloudflare.DurableObjectNamespace("DO_A"),
              },
            }),
          };
        }),
      );
      expect(yield* fetchReady(v1.worker.url!, "v1")).toBe("v1");

      const v2 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: `import { DurableObject } from "cloudflare:workers";
export class DO_A_v2 extends DurableObject {}
export default { async fetch() { return new Response("v2"); } };
`,
              env: {
                DO_A: Cloudflare.DurableObjectNamespace("DO_A", {
                  className: "DO_A_v2",
                }),
              },
            }),
          };
        }),
      );
      expect(yield* fetchReady(v2.worker.url!, "v2")).toBe("v2");

      const v3 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: `import { DurableObject } from "cloudflare:workers";
export class DO_A_v2 extends DurableObject {}
export class DO_B extends DurableObject {}
export default { async fetch() { return new Response("v3"); } };
`,
              env: {
                DO_A: Cloudflare.DurableObjectNamespace("DO_A", {
                  className: "DO_A_v2",
                }),
                DO_B: Cloudflare.DurableObjectNamespace("DO_B"),
              },
            }),
          };
        }),
      );
      expect(yield* fetchReady(v3.worker.url!, "v3")).toBe("v3");

      const v4 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: `import { DurableObject } from "cloudflare:workers";
export class DO_B extends DurableObject {}
export default { async fetch() { return new Response("v4"); } };
`,
              env: {
                DO_B: Cloudflare.DurableObjectNamespace("DO_B"),
              },
            }),
          };
        }),
      );
      expect(yield* fetchReady(v4.worker.url!, "v4")).toBe("v4");

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

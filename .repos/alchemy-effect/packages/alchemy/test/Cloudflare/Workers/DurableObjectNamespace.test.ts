import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { getWorkerTags } from "../Utils/Worker.ts";
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
const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

const readinessRetries = 15;

// The test runtime's HttpClient (FetchHttpClient/undici) keeps HTTP/1.1
// connections alive and pooled. A pooled connection stays pinned to a single
// Cloudflare edge metal, so when that metal lags the freshly-deployed version
// every retry rides the same stale socket and keeps reading the old body for
// the life of the keep-alive — even though the new version is already live.
// Forcing `Connection: close` makes each readiness attempt open a fresh
// connection, letting it land on an edge that has the new version (this is
// why a brand-new `curl` sees the update immediately while a kept-alive
// client does not). See do-rpc DurableObject test investigation.
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

// Every name here is a fresh UUID, so each is CREATED by this test's request —
// which is the only moment a `locationHint` has any say.
const coloFor = (url: string, hint?: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    const query = `name=${crypto.randomUUID()}${hint ? `&hint=${hint}` : ""}`;
    return yield* client.get(`${url}/colo?${query}`).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.flatMap(res.json, (body) => {
              const colo = (body as { colo?: string }).colo;
              return colo && colo !== "unknown"
                ? Effect.succeed(colo)
                : Effect.fail(new Error(`no colo: ${JSON.stringify(body)}`));
            })
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({ schedule: readinessSchedule, times: readinessRetries }),
    );
  });

// The CONTROL for the test below. Without a hint, an instance is created
// wherever its first request came from — so two unhinted instances, created by
// two requests from this same test, must land in the same colo.
//
// This is what makes "the hinted pair differ" mean anything. If unhinted
// instances could scatter across colos on their own, a passing hint test would
// prove nothing: the difference could just be noise in how this box's requests
// get routed. Pinning the baseline first rules that out.
test(
  "unhinted instances are created in the caller's colo",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const [first, second] = yield* Effect.all([coloFor(url), coloFor(url)], {
      concurrency: 2,
    });

    expect(first).toBe(second);
  }).pipe(logLevel),
  { timeout: 60_000 },
);

// `locationHint` steers where an instance is CREATED. Two brand-new names are
// hinted at opposite sides of the planet and asked which colo they ended up
// in. Given the control above — unhinted instances all land in this caller's
// one colo — the pair can only come apart if the hint reached the runtime. If
// it were dropped on the floor (the old `getByName(name)` signature ignored
// Cloudflare's options bag), both would be created in that same colo and this
// fails.
//
// The assertion is "different colos", not "this exact colo": a hint is
// best-effort — Cloudflare places the instance in the nearest location it can
// to the hinted region, which is not necessarily a colo inside it.
test(
  "locationHint places new instances in different regions",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const [wnam, apac] = yield* Effect.all(
      [coloFor(url, "wnam"), coloFor(url, "apac")],
      { concurrency: 2 },
    );

    expect(wnam).not.toBe(apac);
  }).pipe(logLevel),
  { timeout: 60_000 },
);

// Reproduces the `tick` streaming example from the Durable Objects tutorial:
// https://alchemy.run/cloudflare/compute/durable-objects
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
              // A cold edge can answer 200 with an empty/placeholder body
              // (the script isn't serving yet), which collects to `[]`
              // instead of failing — fail so the readiness retry rides it out
              // rather than asserting against an empty stream.
              Effect.flatMap((rows) =>
                rows.length > 0
                  ? Effect.succeed(rows)
                  : Effect.fail(new Error("Worker not ready: empty stream")),
              ),
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
                Counter: Cloudflare.DurableObject("Counter"),
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
              Counter: Cloudflare.DurableObject("Counter"),
            },
          });
          const consumer = yield* Cloudflare.Worker("consumer-worker", {
            script: consumerWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter", {
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
                DO_A: Cloudflare.DurableObject("DO_A"),
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
                DO_A: Cloudflare.DurableObject("DO_A", {
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
                DO_A: Cloudflare.DurableObject("DO_A", {
                  className: "DO_A_v2",
                }),
                DO_B: Cloudflare.DurableObject("DO_B"),
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
                DO_B: Cloudflare.DurableObject("DO_B"),
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

// Reproduces #763: a Worker's precreate stub must declare Durable Object
// classes that exist only as env *bindings* — an async worker has no
// Effect-native exports, so before the fix the stub declared no DO classes at
// all. A resource caught in a dependency cycle with the worker resolves
// `worker.durableObjectNamespaces` against that stub (not the final reconcile
// output), so a binding-only class had no namespace id there and the deploy
// failed with "Worker did not expose Durable Object namespace <class>" on
// every fresh stage's FIRST deploy (reruns found the script already existing
// and passed — which is why this must run on a scratch stack, not a shared
// beforeAll deploy).
//
// The cycle here mirrors the worker<->container shape from the issue (a bare
// `Cloudflare.DurableObject` fronting a Container, where the container binds
// the DO's namespace id and the worker binds the container) without needing a
// Docker build: the consumer worker binds the host's `Counter` namespace id,
// and the host binds the consumer's name back.
test.provider(
  "precreate stub exposes binding-only durable object namespaces to cycle peers",
  (scratch) =>
    Effect.gen(function* () {
      const deployed = yield* scratch.deploy(
        Effect.gen(function* () {
          // `Counter` lives only in the inline script + env binding — it is
          // never an Effect-native export.
          const host = yield* Cloudflare.Worker("host-worker", {
            script: hostWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter"),
            },
          });

          const consumer = yield* Cloudflare.Worker("consumer-worker", {
            script: `export default {
  async fetch(request, env) {
    return Response.json({ namespaceId: env.COUNTER_NS });
  },
};
`,
          });

          // consumer -> host: resolve the DO namespace id, exactly how a
          // Container application binds `durableObjects.namespaceId`. The
          // throw fires when the precreate stub omits the class — failing the
          // deploy the same way the container cycle in #763 did.
          yield* consumer.bind("counter-namespace", {
            bindings: [
              {
                type: "plain_text",
                name: "COUNTER_NS",
                text: host.durableObjectNamespaces.pipe(
                  Output.map((namespaces) => {
                    const id = namespaces.Counter;
                    if (!id) {
                      throw new Error(
                        "Worker did not expose Durable Object namespace Counter.",
                      );
                    }
                    return id;
                  }),
                ),
              },
            ],
          });

          // host -> consumer: closes the cycle so both workers are SCC
          // members and rendezvous on each other's precreate stubs.
          yield* host.bind("consumer-name", {
            bindings: [
              {
                type: "plain_text",
                name: "CONSUMER_NAME",
                text: consumer.workerName,
              },
            ],
          });

          return { host, consumer };
        }),
      );

      // The namespace id created for the precreate stub must survive into the
      // final reconcile output...
      const finalNamespaceId = deployed.host.durableObjectNamespaces.Counter;
      expect(finalNamespaceId).toBeDefined();

      // ...and be the same id the consumer resolved from the stub and
      // deployed into its live environment.
      const body = yield* fetchJsonReady<{ namespaceId: string }>(
        deployed.consumer.url!,
      );
      expect(body.namespaceId).toBe(finalNamespaceId);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Adopt a Durable Object class that already exists on a worker created
// *outside* Alchemy (raw Cloudflare API here, standing in for Wrangler or the
// dashboard). The worker carries no `alchemy:*` ownership tags and no
// `alchemy:do:` logical-id→class mapping, so `read` returns `Unowned` and the
// takeover requires `adopt(true)`. The matching `Counter` class must be reused
// — if `putWorker` instead asked Cloudflare to create it as a *new* class the
// migration would fail with "class already exists". This is the documented
// limitation: on the first (adopting) deploy the binding's class name must
// match the existing class; renames only work once Alchemy owns the worker.
test.provider(
  "adopts a durable object class created outside alchemy",
  (scratch) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // Phase 1: provision a worker + `Counter` DO class straight through the
      // Cloudflare API — no Alchemy involvement, so none of our tags. The
      // name is deterministic (never Date.now()/random); a crashed run can
      // leave the worker behind, and `putScript` would then reject the
      // `newSqliteClasses` migration ("class already exists"), so purge any
      // leftover first.
      const physicalName = "alchemy-test-do-adopt";

      yield* workers
        .deleteScript({ accountId, scriptName: physicalName, force: true })
        .pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));

      yield* workers.putScript({
        accountId,
        scriptName: physicalName,
        metadata: {
          mainModule: "main.js",
          bindings: [
            {
              type: "durable_object_namespace",
              name: "Counter",
              className: "Counter",
            },
          ],
          migrations: {
            newSqliteClasses: ["Counter"],
          },
          // Match Alchemy's default compatibility date so adoption is a
          // pure class-reuse with no compat-date churn. Old dates predate
          // `DurableObjectNamespace.getByName`, which `hostWorkerScript`
          // relies on.
          compatibilityDate: "2026-03-17",
        },
        files: [
          new File([hostWorkerScript], "main.js", {
            type: "application/javascript+module",
          }),
        ],
      });

      // Phase 2: deploy an async Alchemy Worker (inline script) over the same
      // physical name with a matching `Counter` binding, opting in to the
      // takeover via `adopt(true)`.
      const adopted = yield* scratch
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("AdoptDO", {
              name: physicalName,
              script: hostWorkerScript,
              env: {
                Counter: Cloudflare.DurableObject("Counter"),
              },
            });
          }),
        )
        .pipe(adopt(true));

      expect(adopted.workerName).toBe(physicalName);
      // The existing class was adopted (and resolved to a namespace id),
      // not recreated.
      expect(adopted.durableObjectNamespaces.Counter).toBeDefined();

      // The adopted DO is functional end-to-end: increment round-trips
      // through the reused `Counter` class.
      yield* fetchJsonReady<{ ok: boolean }>(`${adopted.url}/reset`);
      const first = yield* fetchJsonReady<{ value: number }>(
        `${adopted.url}/increment`,
      );
      expect(first.value).toBe(1);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// #799: moving a Durable Object class from one Worker to another is
// *declared*: the new host names the former host with `transferredFrom` —
// here by Worker *logical id*, resolved to the actual script via alchemy's
// ownership tags (`alchemy:id:` + stack + stage) among scripts observed to
// host the class. Worker-a's deploy ships Cloudflare's data-preserving
// `transferred_classes` migration; worker-b's deploy converges on its own
// (no `deleted_classes` for a class that moved away).
//
//   v1 — worker-b hosts `Counter` locally; write data into the namespace
//   v2 — worker-a hosts `Counter` with `transferredFrom: "worker-b"`;
//        worker-b re-binds it cross-script. The stored data must survive
//        the move, reachable from both.
//   v3 — redeploy of the same shape is inert (no re-transfer; the
//        declaration stays in the code).
test.provider(
  "durable object host move declared by worker logical id preserves data",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();

      const v1 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            b: yield* Cloudflare.Worker("worker-b", {
              script: hostWorkerScript,
              env: {
                Counter: Cloudflare.DurableObject("Counter"),
              },
            }),
          };
        }),
      );

      // Write data while worker-b hosts the namespace.
      yield* fetchJsonReady<{ ok: boolean }>(`${v1.b.url}/reset`);
      const written = yield* fetchJsonReady<{ value: number }>(
        `${v1.b.url}/increment`,
      );
      expect(written.value).toBe(1);

      const moved = Effect.gen(function* () {
        const a = yield* Cloudflare.Worker("worker-a", {
          script: hostWorkerScript,
          env: {
            Counter: Cloudflare.DurableObject("Counter", {
              // The former host's Worker *logical id* — resolved to its
              // physical script via alchemy's ownership tags.
              transferredFrom: "worker-b",
            }),
          },
        });
        const b = yield* Cloudflare.Worker("worker-b", {
          script: consumerWorkerScript,
          env: {
            Counter: Cloudflare.DurableObject("Counter", {
              scriptName: a.workerName,
            }),
          },
        });
        return { a, b };
      });

      const v2 = yield* scratch.deploy(moved);

      // The namespace moved to worker-a with its data intact...
      const viaA = yield* fetchJsonReady<{ value: number }>(`${v2.a.url}/get`);
      expect(viaA.value).toBe(1);

      // ...and worker-b reaches the same objects through the cross-script
      // binding.
      const viaB = yield* fetchJsonReady<{ value: number }>(
        `${v2.b.url}/increment`,
      );
      expect(viaB.value).toBe(2);

      // Redeploying the same shape is inert: the class now lives on
      // worker-a (tracked by its alchemy:do tag), so the standing
      // declaration must not re-emit a transfer migration. Data intact.
      const v3 = yield* scratch.deploy(moved);
      const afterRedeploy = yield* fetchJsonReady<{ value: number }>(
        `${v3.a.url}/get`,
      );
      expect(afterRedeploy.value).toBe(2);

      // ...and once the move has landed everywhere, the declaration can be
      // removed entirely: the class is anchored by its alchemy:do tag, so
      // dropping `transferredFrom` emits no migration and touches no data.
      const v4 = yield* scratch.deploy(
        Effect.gen(function* () {
          const a = yield* Cloudflare.Worker("worker-a", {
            script: hostWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter"),
            },
          });
          const b = yield* Cloudflare.Worker("worker-b", {
            script: consumerWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter", {
                scriptName: a.workerName,
              }),
            },
          });
          return { a, b };
        }),
      );
      const afterRemoval = yield* fetchJsonReady<{ value: number }>(
        `${v4.a.url}/get`,
      );
      expect(afterRemoval.value).toBe(2);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// #799: `transferredFrom` also accepts the former host's *physical script
// name* — the form required for cross-stack moves, where the new host
// deploys from a different plan entirely (modeled here with raw-string
// script names on a pre-existing worker).
test.provider(
  "transferredFrom by physical script name transfers the namespace",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();

      // v1: worker-b hosts the class; worker-a exists but has no DO yet —
      // deploying it now is what makes its physical name knowable as a raw
      // string in v2 (the cross-stack shape).
      const v1 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            a: yield* Cloudflare.Worker("worker-a", {
              script: `export default { fetch() { return new Response("plain"); } };`,
            }),
            b: yield* Cloudflare.Worker("worker-b", {
              script: hostWorkerScript,
              env: {
                Counter: Cloudflare.DurableObject("Counter"),
              },
            }),
          };
        }),
      );

      yield* fetchJsonReady<{ ok: boolean }>(`${v1.b.url}/reset`);
      const written = yield* fetchJsonReady<{ value: number }>(
        `${v1.b.url}/increment`,
      );
      expect(written.value).toBe(1);

      const aScriptName = v1.a.workerName;
      const bScriptName = v1.b.workerName;

      const v2 = yield* scratch.deploy(
        Effect.gen(function* () {
          const a = yield* Cloudflare.Worker("worker-a", {
            script: hostWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter", {
                // Thunk form — evaluated lazily at plan time and
                // normalized to the plain script name.
                transferredFrom: () => bScriptName,
              }),
            },
          });
          const b = yield* Cloudflare.Worker("worker-b", {
            script: consumerWorkerScript,
            env: {
              // Service binding orders worker-b after worker-a (the raw
              // string scriptName below carries no dependency edge).
              A: a,
              Counter: Cloudflare.DurableObject("Counter", {
                scriptName: aScriptName,
              }),
            },
          });
          return { a, b };
        }),
      );

      const viaA = yield* fetchJsonReady<{ value: number }>(`${v2.a.url}/get`);
      expect(viaA.value).toBe(1);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// #799 (safety interlock): a host move WITHOUT `transferredFrom` must fail
// loudly before the former host uploads anything — moves are never
// inferred, the namespace (and its data) still lives on worker-b, and
// deleting the class would destroy it. The error names the exact
// declaration to add.
test.provider(
  "undeclared host move fails with DurableObjectTransferRequired",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();

      const v1 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            a: yield* Cloudflare.Worker("worker-a", {
              script: `export default { fetch() { return new Response("plain"); } };`,
            }),
            b: yield* Cloudflare.Worker("worker-b", {
              script: hostWorkerScript,
              env: {
                Counter: Cloudflare.DurableObject("Counter"),
              },
            }),
          };
        }),
      );

      // Data exists on worker-b's namespace — this is what the interlock
      // protects.
      yield* fetchJsonReady<{ ok: boolean }>(`${v1.b.url}/reset`);
      yield* fetchJsonReady<{ value: number }>(`${v1.b.url}/increment`);

      const aScriptName = v1.a.workerName;

      const error = yield* scratch
        .deploy(
          Effect.gen(function* () {
            const a = yield* Cloudflare.Worker("worker-a", {
              script: hostWorkerScript,
              env: {
                // Fresh, empty namespace for the same class name — the
                // move is not declared, so nothing transfers.
                Counter: Cloudflare.DurableObject("Counter"),
              },
            });
            const b = yield* Cloudflare.Worker("worker-b", {
              script: consumerWorkerScript,
              env: {
                Counter: Cloudflare.DurableObject("Counter", {
                  scriptName: aScriptName,
                }),
              },
            });
            return { a, b };
          }),
        )
        .pipe(Effect.flip);

      expect(error._tag).toEqual("DurableObjectTransferRequired");

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// #799: the documented *pure move* — the former host drops the DO entirely,
// keeping no cross-script reference — done as two deploys. Phase 1 adds the
// class to worker-a, declaring the former host by **Worker resource
// reference** (`transferredFrom: b`, normalized at plan time to worker-b's
// logical id — no dependency edge on b); worker-b is untouched. Phase 2
// removes the DO from worker-b, whose deploy observes the class already
// transferred away and skips the delete.
test.provider(
  "two-deploy pure move with a Worker resource reference",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();

      const v1 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            b: yield* Cloudflare.Worker("worker-b", {
              script: hostWorkerScript,
              env: {
                Counter: Cloudflare.DurableObject("Counter"),
              },
            }),
          };
        }),
      );

      yield* fetchJsonReady<{ ok: boolean }>(`${v1.b.url}/reset`);
      const written = yield* fetchJsonReady<{ value: number }>(
        `${v1.b.url}/increment`,
      );
      expect(written.value).toBe(1);

      // Phase 1: worker-a takes the class, naming the former host by
      // resource reference. worker-b's declaration is unchanged (noop).
      const v2 = yield* scratch.deploy(
        Effect.gen(function* () {
          const b = yield* Cloudflare.Worker("worker-b", {
            script: hostWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter"),
            },
          });
          const a = yield* Cloudflare.Worker("worker-a", {
            script: hostWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter", {
                transferredFrom: b,
              }),
            },
          });
          return { a, b };
        }),
      );

      // The namespace moved to worker-a with its data intact.
      const viaA = yield* fetchJsonReady<{ value: number }>(`${v2.a.url}/get`);
      expect(viaA.value).toBe(1);

      // Phase 2: worker-b drops the DO entirely. Its deploy observes the
      // class already lives on worker-a and emits no delete migration.
      const v3 = yield* scratch.deploy(
        Effect.gen(function* () {
          const b = yield* Cloudflare.Worker("worker-b", {
            script: `export default { fetch() { return new Response("plain"); } };`,
          });
          const a = yield* Cloudflare.Worker("worker-a", {
            script: hostWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter", {
                transferredFrom: b,
              }),
            },
          });
          return { a, b };
        }),
      );

      const afterRemoval = yield* fetchJsonReady<{ value: number }>(
        `${v3.a.url}/increment`,
      );
      expect(afterRemoval.value).toBe(2);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// Reproduces #811: one script tag per DO binding blew Cloudflare's 10-tag
// limit at 7+ Durable Objects (3 ownership tags + 1 migration tag + N DO
// tags). The logical-id→class mapping is now packed into `alchemy:dos:`
// tags, so a worker with 20 DOs — double the count that used to consume the
// entire tag budget — deploys fine and the whole tag set stays within the
// limit. The second deploy renames a class and drops another to prove
// migrations are still driven by the packed mapping.
test.provider(
  "worker with 20 durable objects deploys within the 10-tag limit",
  (scratch) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const ids = Array.from({ length: 20 }, (_, i) => `DO_${i}`);
      const makeScript = (classes: string[], version: string) =>
        `import { DurableObject } from "cloudflare:workers";
${classes.map((c) => `export class ${c} extends DurableObject {}`).join("\n")}
export default { async fetch() { return new Response("${version}"); } };
`;

      const v1 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: makeScript(
                ids.map((_, i) => `Class${i}`),
                "v1",
              ),
              env: Object.fromEntries(
                ids.map((id, i) => [
                  id,
                  Cloudflare.DurableObject(id, { className: `Class${i}` }),
                ]),
              ),
            }),
          };
        }),
      );
      expect(yield* fetchReady(v1.worker.url!, "v1")).toBe("v1");

      const tags = yield* getWorkerTags(v1.worker.workerName, accountId);
      expect(tags.length).toBeLessThanOrEqual(10);
      expect(tags.filter((t) => t.startsWith("alchemy:dos:"))).toHaveLength(1);
      expect(tags.filter((t) => t.startsWith("alchemy:do:"))).toHaveLength(0);

      // Rename Class0 → Class0V2 (same binding id) and delete DO_19 — both
      // migrations resolve their previous class through the packed tag.
      const v2 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: makeScript(
                [
                  "Class0V2",
                  ...ids.slice(1, 19).map((_, i) => `Class${i + 1}`),
                ],
                "v2",
              ),
              env: Object.fromEntries(
                ids.slice(0, 19).map((id, i) => [
                  id,
                  Cloudflare.DurableObject(id, {
                    className: i === 0 ? "Class0V2" : `Class${i}`,
                  }),
                ]),
              ),
            }),
          };
        }),
      );
      expect(yield* fetchReady(v2.worker.url!, "v2")).toBe("v2");

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

// Roll-forward from the legacy tag format: a worker last deployed by an
// older alchemy carries one `alchemy:do:{logicalId}:{className}` tag per DO.
// Simulate that by rewriting the live script tags to the legacy format
// out-of-band, then redeploy with a class rename — reconcile must parse the
// legacy tags to resolve the previous class, and the deploy rewrites the
// mapping in the packed format.
test.provider(
  "rolls forward from legacy per-DO alchemy:do: tags",
  (scratch) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const v1 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: `import { DurableObject } from "cloudflare:workers";
export class CounterClass extends DurableObject {}
export class MeterClass extends DurableObject {}
export default { async fetch() { return new Response("v1"); } };
`,
              env: {
                Counter: Cloudflare.DurableObject("Counter", {
                  className: "CounterClass",
                }),
                Meter: Cloudflare.DurableObject("Meter", {
                  className: "MeterClass",
                }),
              },
            }),
          };
        }),
      );
      expect(yield* fetchReady(v1.worker.url!, "v1")).toBe("v1");
      const scriptName = v1.worker.workerName;

      // Rewrite the tags the way alchemy <= beta.62 wrote them: one
      // `alchemy:do:` tag per binding, no packed tag.
      const deployedTags = yield* getWorkerTags(scriptName, accountId);
      yield* workers.patchScriptScriptAndVersionSetting({
        accountId,
        scriptName,
        settings: {
          tags: [
            ...deployedTags.filter((t) => !t.startsWith("alchemy:dos:")),
            "alchemy:do:Counter:CounterClass",
            "alchemy:do:Meter:MeterClass",
          ],
        },
      });

      // Redeploy with a rename; the previous class must be resolved from the
      // legacy tags for the migration to succeed.
      const v2 = yield* scratch.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("worker", {
              script: `import { DurableObject } from "cloudflare:workers";
export class CounterClassV2 extends DurableObject {}
export class MeterClass extends DurableObject {}
export default { async fetch() { return new Response("v2"); } };
`,
              env: {
                Counter: Cloudflare.DurableObject("Counter", {
                  className: "CounterClassV2",
                }),
                Meter: Cloudflare.DurableObject("Meter", {
                  className: "MeterClass",
                }),
              },
            }),
          };
        }),
      );
      expect(yield* fetchReady(v2.worker.url!, "v2")).toBe("v2");

      // The deploy rewrote the mapping in the packed format.
      const rolledForward = yield* getWorkerTags(scriptName, accountId);
      expect(
        rolledForward.filter((t) => t.startsWith("alchemy:dos:")),
      ).toHaveLength(1);
      expect(
        rolledForward.filter((t) => t.startsWith("alchemy:do:")),
      ).toHaveLength(0);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

// #799 (idempotence): a standing `transferredFrom` declaration must never do
// anything destructive after its job is done.
//
//   v1 — a FRESH stage deployed directly in the final topology, declaration
//        present: no listed source hosts the class, so worker-a creates a
//        fresh namespace. Same-class namespaces owned by other stacks and
//        stages on the account must not match the declaration.
//   v2 — worker-b later hosts its OWN Durable Object under the same name and
//        class (the isolated-twins pattern): a fresh, separate namespace.
//   v3 — worker-a redeploys (forced update) with the now-stale declaration
//        while that same-name namespace exists on worker-b: the class is
//        already anchored to worker-a by its DO tag, so the stale
//        declaration must not steal worker-b's namespace or emit any
//        migration. Distinct counter values prove both namespaces survive
//        untouched.
test.provider(
  "standing transferredFrom is inert on fresh stages and never steals a same-name namespace",
  (scratch) =>
    Effect.gen(function* () {
      yield* scratch.destroy();

      // Fresh stage, final topology, declaration present from day one.
      const v1 = yield* scratch.deploy(
        Effect.gen(function* () {
          const a = yield* Cloudflare.Worker("worker-a", {
            script: hostWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter", {
                transferredFrom: "worker-b",
              }),
            },
          });
          const b = yield* Cloudflare.Worker("worker-b", {
            script: consumerWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter", {
                scriptName: a.workerName,
              }),
            },
          });
          return { a, b };
        }),
      );

      // Fresh namespace on worker-a; give it a distinctly non-zero count.
      // (`/increment` is not idempotent and readiness retries can re-run
      // it, so assertions use the idempotent `/get` instead of increment
      // return values.)
      yield* fetchJsonReady<{ ok: boolean }>(`${v1.a.url}/reset`);
      yield* fetchJsonReady<{ value: number }>(`${v1.a.url}/increment`);
      yield* fetchJsonReady<{ value: number }>(`${v1.a.url}/increment`);
      const aBefore = (yield* fetchJsonReady<{ value: number }>(
        `${v1.a.url}/get`,
      )).value;
      expect(aBefore).toBeGreaterThanOrEqual(2);

      // worker-b now hosts its OWN same-name Counter — an isolated twin.
      const v2 = yield* scratch.deploy(
        Effect.gen(function* () {
          const a = yield* Cloudflare.Worker("worker-a", {
            script: hostWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter", {
                transferredFrom: "worker-b",
              }),
            },
          });
          const b = yield* Cloudflare.Worker("worker-b", {
            script: hostWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter"),
            },
          });
          return { a, b };
        }),
      );

      // The twin starts empty — its own namespace, not worker-a's. b's
      // edge may briefly serve the previous (cross-script) version, whose
      // /get reads worker-a's non-zero count, so poll until the fresh
      // version answers with the twin's empty count.
      yield* fetchJsonReady<{ value: number }>(`${v2.b.url}/get`).pipe(
        Effect.flatMap((r) =>
          r.value === 0
            ? Effect.void
            : Effect.fail(new Error(`stale: twin sees ${r.value}`)),
        ),
        Effect.retry({ schedule: readinessSchedule, times: readinessRetries }),
      );

      // Force a real reconcile of worker-a with the stale declaration while
      // the twin exists. The class is tag-anchored to worker-a, so no
      // migration may be emitted and neither namespace may change.
      const v3 = yield* scratch.deploy(
        Effect.gen(function* () {
          const a = yield* Cloudflare.Worker("worker-a", {
            script: hostWorkerScript,
            env: {
              FORCE_UPDATE: "1",
              Counter: Cloudflare.DurableObject("Counter", {
                transferredFrom: "worker-b",
              }),
            },
          });
          const b = yield* Cloudflare.Worker("worker-b", {
            script: hostWorkerScript,
            env: {
              Counter: Cloudflare.DurableObject("Counter"),
            },
          });
          return { a, b };
        }),
      );

      const aAfter = yield* fetchJsonReady<{ value: number }>(
        `${v3.a.url}/get`,
      );
      expect(aAfter.value).toBe(aBefore);
      // worker-b was a noop in v3, but its v2 upload was only moments ago —
      // an edge metal can still serve the v1 (cross-script) version, whose
      // /get reads worker-a's non-zero counter. Poll until the twin's own
      // empty namespace answers: a genuinely stolen/deleted namespace never
      // reads 0, so the bounded retry still fails in the regression case.
      const twinAfter = yield* fetchJsonReady<{ value: number }>(
        `${v3.b.url}/get`,
      ).pipe(
        Effect.flatMap((r) =>
          r.value === 0
            ? Effect.succeed(r)
            : Effect.fail(new Error(`stale: twin sees ${r.value}`)),
        ),
        Effect.retry({ schedule: readinessSchedule, times: readinessRetries }),
      );
      expect(twinAfter.value).toBe(0);

      yield* scratch.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command (see
// MakeOptions.sidecar in Test/Core.ts).
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        // Cap the backoff: an uncapped exponential over 10 recurs sums to
        // ~8.5 minutes and turns a persistent non-200 into an apparent hang.
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * Under `alchemy dev` the KV Namespace resource is emulated by the local
 * provider (a `dev:` id, no cloud API calls) and the worker's `kv_namespace`
 * binding is lowered onto the local workerd KV simulator. This exercises the
 * full local roundtrip: put / get / list / delete through the native `env`
 * binding.
 */
test.provider(
  "KV namespace binding round-trips against the local simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const kv = yield* Cloudflare.KV.Namespace("LocalKV");
          const worker = yield* Cloudflare.Worker("kv-local-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/kv-local-worker.ts",
            ),
            env: { KV: kv },
          });
          return { kv, worker };
        }),
      );

      // The local provider fabricates a `dev:` id — proof no cloud call ran
      // — and the worker serves from the local dev proxy.
      expect(deployed.kv.namespaceId).toMatch(/^dev:/);
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const body = (yield* getJsonReady(
        `${deployed.worker.url}/roundtrip`,
      )) as {
        value: string;
        value2: string;
        metadata: { hello: string };
        keys: string[];
        afterDelete: string | null;
      };
      expect(body.value).toBe("value1");
      expect(body.value2).toBe("value2");
      expect(body.metadata).toEqual({ hello: "world" });
      expect(body.keys.sort()).toEqual(["key1", "key2"]);
      expect(body.afterDelete).toBeNull();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * The `*Local` KV capability layers reach the local simulator through an
 * ephemeral workerd gateway that emulates the KV REST API over the native
 * binding. An Action seeds (put/get/getWithMetadata/list/delete) a `dev:`
 * namespace, and the worker's native binding then reads the same simulator
 * storage — proving Node-side capability clients and worker bindings share
 * one local data plane.
 */
test.provider(
  "ReadWriteNamespaceLocal Action seeds the local simulator in dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* Cloudflare.KV.Namespace("ActionSeededKV");

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const client = yield* Cloudflare.KV.ReadWriteNamespace(ns);
              return Effect.fn(function* () {
                yield* client.put("seeded", "from-action", {
                  metadata: { source: "action" },
                });
                yield* client.put("other", "value");
                const value = yield* client.get("seeded");
                const withMetadata = yield* client.getWithMetadata("seeded");
                const list = yield* client.list();
                yield* client.delete("other");
                const afterDelete = yield* client.get("other");
                return {
                  value,
                  metadata: withMetadata.metadata,
                  keys: list.keys.map((k) => k.name),
                  afterDelete,
                };
              });
            }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceLocal)),
          );
          const seeded = yield* Seed({});

          const worker = yield* Cloudflare.Worker("kv-action-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/kv-local-worker.ts",
            ),
            env: { KV: ns },
          });
          return { ns, worker, seeded };
        }),
      );

      expect(deployed.ns.namespaceId).toMatch(/^dev:/);
      expect(deployed.seeded.value).toBe("from-action");
      expect(deployed.seeded.metadata).toEqual({ source: "action" });
      expect(deployed.seeded.keys.sort()).toEqual(["other", "seeded"]);
      expect(deployed.seeded.afterDelete).toBeNull();

      // The worker's native binding reads the same simulator storage the
      // Action's gateway wrote to.
      const body = (yield* getJsonReady(
        `${deployed.worker.url}/get?key=seeded`,
      )) as { value: string | null };
      expect(body.value).toBe("from-action");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * `Alchemy.remote()` opts a resource OUT of local emulation: even under
 * `alchemy dev` the namespace is created on real Cloudflare (live provider)
 * and the worker's binding proxies to it remotely, while a sibling default
 * namespace in the same stack stays fully local. Out-of-band reads through
 * the cloud API prove the worker's writes landed in the real namespace.
 */
test.provider(
  "Alchemy.remote() namespace runs live in dev alongside a local one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const localKv = yield* Cloudflare.KV.Namespace("MixedLocalKV");
          const liveKv = yield* Cloudflare.KV.Namespace("MixedLiveKV").pipe(
            Alchemy.remote(),
          );
          const worker = yield* Cloudflare.Worker("kv-mixed-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/kv-local-worker.ts",
            ),
            env: { KV: localKv, KV_LIVE: liveKv },
          });
          return { localKv, liveKv, worker };
        }),
      );

      // The default namespace is emulated; the remote() one is real.
      expect(deployed.localKv.namespaceId).toMatch(/^dev:/);
      expect(deployed.liveKv.namespaceId).not.toMatch(/^dev:/);

      // Both bindings round-trip through the same locally-served worker.
      const local = (yield* getJsonReady(
        `${deployed.worker.url}/roundtrip`,
      )) as { value: string };
      expect(local.value).toBe("value1");

      const live = (yield* getJsonReady(
        `${deployed.worker.url}/roundtrip?binding=KV_LIVE`,
      )) as { value: string; value2: string };
      expect(live.value).toBe("value1");
      expect(live.value2).toBe("value2");

      // Out-of-band: the worker's write is visible through the cloud API —
      // the remote-proxied binding really hit the live namespace.
      const { accountId } = yield* yield* CloudflareEnvironment;
      const value = yield* kv
        .getNamespaceValue({
          accountId,
          namespaceId: deployed.liveKv.namespaceId,
          keyName: "key2",
        })
        .pipe(
          Effect.flatMap((res) =>
            Effect.tryPromise(() =>
              new Response(
                Stream.toReadableStream(res.body) as BodyInit,
              ).text(),
            ),
          ),
        );
      expect(value).toBe("value2");

      yield* stack.destroy();

      // The live namespace was deleted from the cloud on destroy (its state
      // row is stamped live, so the live provider handles the delete even
      // in a dev run).
      const gone = yield* kv
        .getNamespace({
          accountId,
          namespaceId: deployed.liveKv.namespaceId,
        })
        .pipe(
          Effect.as(false),
          Effect.catchTag("NamespaceNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

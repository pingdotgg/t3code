import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import { Action } from "alchemy/Action";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command (see
// MakeOptions.sidecar in Test/Core.ts).
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

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
          Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("2 seconds")]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

test.provider(
  "Instant local binding supports CRUD, rejects metadata, and lists beyond 1,000 keys",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (title: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const ns = yield* Cloudflare.KV.InstantNamespace("Config", { title });
            const worker = yield* Cloudflare.Worker("instant-local", {
              main: pathe.resolve(import.meta.dirname, "fixtures/kv-instant-local-worker.ts"),
              env: { KV: ns },
            });
            return { ns, worker };
          }),
        );
      const initial = yield* deploy("initial");
      expect(initial.ns.namespaceId).toMatch(/^dev:kv-instant:/);
      const result = yield* getJsonReady(`${initial.worker.url}/roundtrip`);
      expect(result).toEqual({
        value: "hello",
        metadata: null,
        metadataRejected: true,
        longKeyRejected: true,
        count: 1001,
        complete: true,
        afterDelete: null,
      });
      const updated = yield* deploy("renamed");
      expect(updated.ns.namespaceId).toBe(initial.ns.namespaceId);
      expect(updated.ns.title).toBe("renamed");
      expect(yield* getJsonReady(`${updated.worker.url}/get?key=config:0`)).toEqual({ value: "1" });
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000, tags: ["provider:cloudflare", "provider:cloudflare:kv", "local"] },
);

test.provider(
  "Instant ReadWriteNamespaceLocal Action enforces key and metadata rules and single-page listing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* Cloudflare.KV.InstantNamespace("ActionSeededKV");

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const client = yield* Cloudflare.KV.ReadWriteNamespace(ns);
              return Effect.fn(function* () {
                yield* client.put("seeded", "from-action");
                yield* client.put("other", "value");
                const value = yield* client.get("seeded");
                const list = yield* client.list();
                yield* client.delete("other");
                const afterDelete = yield* client.get("other");
                const keyError = yield* client.put("é".repeat(151), "value").pipe(Effect.flip);
                const metadataError = yield* client
                  .put("metadata", "value", {
                    // @ts-expect-error Also verify rejection for untyped JavaScript callers.
                    metadata: { unsupported: true },
                  })
                  .pipe(Effect.flip);
                yield* client.put("page:one", "value");
                yield* client.put("page:two", "value");
                const all = yield* client.list({
                  prefix: "page:",
                  // @ts-expect-error Native callers may still send a page size; Instant ignores it.
                  limit: 1,
                });
                return {
                  value,
                  keys: list.keys.map((k) => k.name),
                  afterDelete,
                  keyError: keyError.message,
                  metadataError: metadataError.message,
                  count: all.keys.length,
                  complete: all.list_complete,
                };
              });
            }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceLocal)),
          );
          const seeded = yield* Seed({});

          const worker = yield* Cloudflare.Worker("kv-action-worker", {
            main: pathe.resolve(import.meta.dirname, "fixtures/kv-instant-local-worker.ts"),
            env: { KV: ns },
          });
          return { ns, worker, seeded };
        }),
      );

      expect(deployed.ns.namespaceId).toMatch(/^dev:kv-instant:/);
      expect(deployed.seeded.value).toBe("from-action");
      expect(deployed.seeded.keys.sort()).toEqual(["other", "seeded"]);
      expect(deployed.seeded.afterDelete).toBeNull();
      expect(deployed.seeded.keyError).toContain("300 bytes");
      expect(deployed.seeded.metadataError).toContain("does not support metadata");
      expect(deployed.seeded.count).toBe(2);
      expect(deployed.seeded.complete).toBe(true);

      // The worker's native binding reads the same simulator storage the
      // Action's gateway wrote to.
      const body = (yield* getJsonReady(`${deployed.worker.url}/get?key=seeded`)) as {
        value: string | null;
      };
      expect(body.value).toBe("from-action");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:kv", "provider:cloudflare:worker", "local"],
    timeout: 120_000,
  },
);

// Requires private beta access and the cost opt-in even when the stack is local.
test.provider(
  "Alchemy.remote opts InstantNamespace out of local emulation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const ns = yield* stack.deploy(
        Cloudflare.KV.InstantNamespace("Remote").pipe(Alchemy.remote()),
      );
      expect(ns.namespaceId.startsWith("dev:")).toBe(false);
      yield* stack.destroy();
    }),
  { retry: 0, timeout: 120_000, tags: ["provider:cloudflare", "provider:cloudflare:kv", "live"] },
);

test.provider(
  "switching between classic and Instant replaces local storage in both directions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const classic = yield* stack.deploy(Cloudflare.KV.Namespace("Config", { title: "config" }));
      const instant = yield* stack.deploy(
        Cloudflare.KV.InstantNamespace("Config", { title: "config" }),
      );
      expect(instant.namespaceId).not.toBe(classic.namespaceId);
      expect(instant.namespaceId).toMatch(/^dev:kv-instant:/);
      expect(instant.mode).toBe("instant");
      const unchanged = yield* stack.deploy(
        Cloudflare.KV.InstantNamespace("Config", { title: "config" }),
      );
      expect(unchanged.namespaceId).toBe(instant.namespaceId);
      const restored = yield* stack.deploy(Cloudflare.KV.Namespace("Config", { title: "config" }));
      expect(restored.namespaceId).not.toBe(instant.namespaceId);
      expect(restored.namespaceId.startsWith("dev:kv-instant:")).toBe(false);
      const stable = yield* stack.deploy(Cloudflare.KV.Namespace("Config", { title: "config" }));
      expect(stable.namespaceId).toBe(restored.namespaceId);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000, tags: ["provider:cloudflare", "provider:cloudflare:kv", "local"] },
);

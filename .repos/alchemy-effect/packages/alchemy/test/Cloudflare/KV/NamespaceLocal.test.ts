import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Binding a KV namespace inside an Action via `ReadWriteNamespaceLocal` — the
// local (current-credentials) implementation of the `ReadWriteNamespace`
// binding. Exercises the client (put/get/list/delete) and the accessor
// mechanism (`yield* namespace.namespaceId` resolved at apply time).
test.provider(
  "ReadWriteNamespaceLocal: seed and read a namespace from an Action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const namespace = yield* Cloudflare.KV.Namespace("SeedNamespace");

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const kv = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
              // Accessor — resolved at apply time against the tracker.
              const namespaceId = yield* namespace.namespaceId;

              return Effect.fn(function* () {
                yield* kv.put("greeting", "hello world");

                // KV is eventually consistent — retry the read-back until the
                // value propagates (bounded so the test fails fast).
                const value = yield* kv.get("greeting").pipe(
                  Effect.flatMap((v) =>
                    v === "hello world"
                      ? Effect.succeed(v)
                      : Effect.fail("not yet propagated" as const),
                  ),
                  Effect.retry({
                    schedule: Schedule.spaced("1 second"),
                    times: 10,
                  }),
                  Effect.orElseSucceed(() => null),
                );

                const listed = yield* kv.list();
                const names = listed.keys.map((k) => k.name);

                yield* kv.delete("greeting");

                const afterDelete = yield* kv.get("greeting").pipe(
                  Effect.flatMap((v) =>
                    v === null
                      ? Effect.succeed(v)
                      : Effect.fail("not yet deleted" as const),
                  ),
                  Effect.retry({
                    schedule: Schedule.spaced("1 second"),
                    times: 10,
                  }),
                  Effect.orElseSucceed(() => "still present" as string | null),
                );

                return {
                  namespaceId: yield* namespaceId,
                  value,
                  names,
                  afterDelete,
                };
              });
            }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceLocal)),
          );

          return yield* Seed({});
        }),
      );

      expect(out.namespaceId).toBeTruthy();
      expect(out.value).toBe("hello world");
      expect(out.names).toContain("greeting");
      expect(out.afterDelete).toBeNull();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

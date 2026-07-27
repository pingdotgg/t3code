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

// R2 is eventually consistent — a freshly written object can read back `null`
// for a moment. Bounded spaced retry so a real failure surfaces fast.
const readBack = Schedule.max([
  Schedule.spaced("1 second"),
  Schedule.recurs(15),
]);

// Binding an R2 bucket inside an Action via `ReadWriteBucketLocal` — the local
// (current-credentials) implementation of the `ReadWriteBucket` binding.
// Exercises the client (put/get/list/delete) and the accessor mechanism
// (`yield* bucket.bucketName` resolved at apply time).
test.provider(
  "ReadWriteBucketLocal: seed and read a bucket from an Action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2.Bucket("SeedBucket");

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const r2 = yield* Cloudflare.R2.ReadWriteBucket(bucket);
              // Accessor — resolved at apply time against the tracker.
              const bucketName = yield* bucket.bucketName;

              return Effect.fn(function* () {
                yield* r2.put("hello.txt", "Hello, World!").pipe(Effect.orDie);
                yield* r2.put("greeting/hi.txt", "hi").pipe(Effect.orDie);

                // Read back with bounded retry (eventual consistency).
                const value = yield* r2.get("hello.txt").pipe(
                  Effect.flatMap((o) =>
                    o ? o.text() : Effect.succeed<string | null>(null),
                  ),
                  Effect.orDie,
                  Effect.repeat({
                    schedule: readBack,
                    until: (v) => v !== null,
                  }),
                );

                const listed = yield* r2.list().pipe(Effect.orDie);
                const keys = listed.objects.map((o) => o.key).sort();

                const head = yield* r2.head("hello.txt").pipe(Effect.orDie);

                yield* r2.delete("hello.txt").pipe(Effect.orDie);
                yield* r2.delete("greeting/hi.txt").pipe(Effect.orDie);

                const afterDelete = yield* r2.head("hello.txt").pipe(
                  Effect.orDie,
                  Effect.repeat({
                    schedule: readBack,
                    until: (o) => o === null,
                  }),
                );

                return {
                  bucketName: yield* bucketName,
                  value,
                  keys,
                  headExists: head !== null,
                  deleted: afterDelete === null,
                };
              });
            }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketLocal)),
          );

          return yield* Seed({});
        }),
      );

      expect(out.bucketName).toBeTruthy();
      expect(out.value).toBe("Hello, World!");
      expect(out.keys).toEqual(["greeting/hi.txt", "hello.txt"]);
      expect(out.headExists).toBe(true);
      expect(out.deleted).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "ReadBucket, WriteBucket, and ReadWriteBucket clients",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("Files", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* bucket.bucketName;
              const reader = yield* GCP.Storage.ReadBucket(bucket);
              const writer = yield* GCP.Storage.WriteBucket(bucket);
              const both = yield* GCP.Storage.ReadWriteBucket(bucket);
              return Effect.fn(function* () {
                const missing = yield* reader.get("docs/a.txt");
                const missingHead = yield* reader.head("docs/a.txt");
                yield* writer.put("docs/a.txt", "alpha", {
                  contentType: "text/plain",
                });
                yield* both.put("docs/b.txt", new TextEncoder().encode("beta"));
                yield* both.put("other/c.txt", "gamma");
                const a = yield* reader.get("docs/a.txt");
                const head = yield* reader.head("docs/a.txt");
                const listed = yield* both.list({ prefix: "docs/" });
                const grouped = yield* reader.list({ delimiter: "/" });
                yield* writer.delete("docs/a.txt");
                yield* writer.delete("never-existed.txt");
                const afterDelete = yield* both.get("docs/a.txt");
                return {
                  missing: missing === undefined,
                  missingHead: missingHead === undefined,
                  a: a && new TextDecoder().decode(a.body),
                  contentType: head?.contentType,
                  listed: listed.objects.map((object) => object.name).sort(),
                  prefixes: grouped.prefixes.sort(),
                  afterDelete: afterDelete === undefined,
                };
              });
            }).pipe(
              Effect.provide(GCP.Storage.ReadBucketHttp),
              Effect.provide(GCP.Storage.WriteBucketHttp),
              Effect.provide(GCP.Storage.ReadWriteBucketHttp),
            ),
          );
          return { probe: yield* Probe({}) };
        }),
      );

      expect(out.probe).toEqual({
        missing: true,
        missingHead: true,
        a: "alpha",
        contentType: "text/plain",
        listed: ["docs/a.txt", "docs/b.txt"],
        prefixes: ["docs/", "other/"],
        afterDelete: true,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:storage", "live"], timeout: 180_000 },
);

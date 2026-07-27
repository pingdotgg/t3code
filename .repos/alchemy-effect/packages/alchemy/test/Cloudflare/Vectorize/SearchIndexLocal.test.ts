import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Vectorize requires dimensions in [32, 1536]; use the minimum. Two
// deterministic, well-separated 32-d vectors so the nearest neighbor of the
// query vector (v1) is unambiguously "1".
const DIMENSIONS = 32;
const v1 = Array.from({ length: DIMENSIONS }, (_, i) => (i + 1) / 100);
const v2 = Array.from({ length: DIMENSIONS }, (_, i) => 1 - (i + 1) / 100);

// Binding a Vectorize index inside an Action via `SearchIndexLocal` — the local
// (current-credentials) implementation of the `SearchIndex` binding. Exercises
// the binding client (upsert/query/getByIds) over the Vectorize HTTP API and
// the accessor mechanism (`yield* index.indexName` resolved at apply time).
//
// Vectorize mutations are async / eventually consistent, so after the upsert we
// poll `query` on a bounded schedule until the seeded vector is returnable.
test.provider(
  "SearchIndexLocal: seed and query an index from an Action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const index = yield* Cloudflare.Vectorize.Index("SeedIndex", {
            dimensions: DIMENSIONS,
            metric: "cosine",
          });

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const vec = yield* Cloudflare.Vectorize.SearchIndex(index);
              // Accessor — resolved at apply time against the tracker.
              const indexName = yield* index.indexName;

              return Effect.fn(function* () {
                const vectors: runtime.VectorizeVector[] = [
                  { id: "1", values: v1 },
                  { id: "2", values: v2 },
                ];

                const mutation = yield* vec.upsert(vectors);

                // Vectorize processes mutations asynchronously. Poll the query
                // until the seeded vector is returnable (bounded — fail fast if
                // provisioning is slower than the schedule allows).
                const matches = yield* vec
                  .query(v1, {
                    topK: 2,
                    returnValues: true,
                  })
                  .pipe(
                    Effect.repeat({
                      schedule: Schedule.spaced("3 seconds"),
                      until: (m) => m.matches.some((x) => x.id === "1"),
                      times: 20,
                    }),
                  );

                const fetched = yield* vec.getByIds(["1"]);

                return {
                  indexName: yield* indexName,
                  mutationId: mutation.mutationId,
                  topId: matches.matches[0]?.id,
                  matchIds: matches.matches.map((m) => m.id),
                  fetchedIds: fetched.map((v) => v.id),
                };
              });
            }).pipe(Effect.provide(Cloudflare.Vectorize.SearchIndexLocal)),
          );

          return yield* Seed({});
        }),
      );

      expect(out.indexName).toBeTruthy();
      expect(out.mutationId).toBeTruthy();
      // Nearest neighbor of the first vector is itself.
      expect(out.topId).toBe("1");
      expect(out.matchIds).toContain("1");
      expect(out.fetchedIds).toContain("1");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

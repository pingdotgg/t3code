import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { poll } from "@/Util/poll.ts";
import { waitForMetadata } from "./Readiness.ts";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Bounded typed wait for a parent VectorizeIndex to actually disappear from
// Cloudflare after a delete/replace. Index deletes are quick; allow eight
// retries before surfacing the last observed state as a `PredicateFailed`.
const waitForIndexGone = (accountId: string, indexName: string) =>
  poll({
    description: `parent index ${indexName} is gone`,
    effect: vectorize.getIndex({ accountId, indexName }).pipe(
      Effect.timeout("5 seconds"),
      Effect.as(false),
      Effect.catchTag(["NotFound", "Gone"], () => Effect.succeed(true)),
    ),
    predicate: (gone) => gone,
    schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(8)]),
  });

describe.skipIf(!!process.env.FAST)(
  "Cloudflare.Vectorize.MetadataIndex",
  { tags: ["provider:cloudflare", "provider:cloudflare:vectorize", "live"] },
  () => {
    test.provider(
      "create and delete a metadata index",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const { index, meta } = yield* stack.deploy(
            Effect.gen(function* () {
              const index = yield* Cloudflare.Vectorize.Index("ParentIdx", {
                dimensions: 32,
                metric: "cosine",
              });
              const meta = yield* Cloudflare.Vectorize.MetadataIndex(
                "MetaIdx",
                {
                  indexName: index.indexName,
                  propertyName: "category",
                  indexType: "string",
                },
              );
              return { index, meta };
            }),
          );

          expect(meta.propertyName).toBe("category");
          expect(meta.indexType).toBe("string");
          expect(meta.indexName).toBe(index.indexName);

          // The metadata index appears in the parent's list once Cloudflare
          // processes the async mutation.
          const entries = yield* waitForMetadata(accountId, index.indexName, [
            meta,
          ]);
          expect(
            entries
              .find((e) => e.propertyName === "category")
              ?.indexType?.toLowerCase(),
          ).toBe("string");

          yield* stack.destroy();

          // Both parent and metadata index are gone.
          const after = yield* listMetadataIndexes(accountId, index.indexName);
          expect(after.length).toBe(0);
        }).pipe(
          Effect.ensuring(
            stack.destroy().pipe(Effect.orDie).pipe(Effect.ignore),
          ),
          logLevel,
        ),
      { timeout: 210_000 },
    );

    test.provider(
      "multiple metadata indexes on the same parent coexist",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const { index, category, price } = yield* stack.deploy(
            Effect.gen(function* () {
              const index = yield* Cloudflare.Vectorize.Index("MultiParent", {
                dimensions: 32,
                metric: "cosine",
              });
              const category = yield* Cloudflare.Vectorize.MetadataIndex(
                "CategoryMeta",
                {
                  indexName: index.indexName,
                  propertyName: "category",
                  indexType: "string",
                },
              );
              const price = yield* Cloudflare.Vectorize.MetadataIndex(
                "PriceMeta",
                {
                  indexName: index.indexName,
                  propertyName: "price",
                  indexType: "number",
                },
              );
              return { index, category, price };
            }),
          );
          const entries = yield* waitForMetadata(accountId, index.indexName, [
            category,
            price,
          ]);
          expect(
            entries
              .find((e) => e.propertyName === "category")
              ?.indexType?.toLowerCase(),
          ).toBe("string");
          expect(
            entries
              .find((e) => e.propertyName === "price")
              ?.indexType?.toLowerCase(),
          ).toBe("number");

          yield* stack.destroy();
        }).pipe(
          // Guarantee teardown even if a poll/assertion fails or the test is
          // interrupted by a timeout — the scratch stack's state is in-memory
          // only, so a body that throws before the trailing `destroy()` would
          // otherwise leak the parent + metadata indexes with no next-run
          // cleanup.
          Effect.ensuring(
            stack.destroy().pipe(Effect.orDie).pipe(Effect.ignore),
          ),
          logLevel,
        ),
      { timeout: 210_000 },
    );

    test.provider(
      "replacing the parent index also replaces the metadata index",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          // Initial deploy with dimensions=32.
          const { index: oldIndex } = yield* stack.deploy(
            Effect.gen(function* () {
              const index = yield* Cloudflare.Vectorize.Index("ReplaceParent", {
                dimensions: 32,
                metric: "cosine",
              });
              yield* Cloudflare.Vectorize.MetadataIndex("ReplaceMeta", {
                indexName: index.indexName,
                propertyName: "tag",
                indexType: "string",
              });
              return { index };
            }),
          );
          // Replacement must also work while the old metadata mutation is pending.

          // Re-deploy with different dimensions — the parent replaces, which
          // also replaces the metadata index on the new parent.
          const { index: newIndex, meta: newMeta } = yield* stack.deploy(
            Effect.gen(function* () {
              const index = yield* Cloudflare.Vectorize.Index("ReplaceParent", {
                dimensions: 64,
                metric: "cosine",
              });
              const meta = yield* Cloudflare.Vectorize.MetadataIndex(
                "ReplaceMeta",
                {
                  indexName: index.indexName,
                  propertyName: "tag",
                  indexType: "string",
                },
              );
              return { index, meta };
            }),
          );

          expect(newIndex.indexName).not.toBe(oldIndex.indexName);
          expect(newMeta.indexName).toBe(newIndex.indexName);

          // Old parent is gone — bounded typed wait for the replacement's
          // delete of the old index to settle.
          const oldGone = yield* waitForIndexGone(
            accountId,
            oldIndex.indexName,
          );
          expect(oldGone).toBe(true);

          // The new parent has the metadata index.
          yield* waitForMetadata(accountId, newIndex.indexName, [newMeta]);

          yield* stack.destroy();
        }).pipe(
          Effect.ensuring(
            stack.destroy().pipe(Effect.orDie).pipe(Effect.ignore),
          ),
          logLevel,
        ),
      { timeout: 210_000 },
    );

    test.provider(
      "list enumerates the deployed metadata index",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { index, meta } = yield* stack.deploy(
            Effect.gen(function* () {
              const index = yield* Cloudflare.Vectorize.Index("ListParent", {
                dimensions: 32,
                metric: "cosine",
              });
              const meta = yield* Cloudflare.Vectorize.MetadataIndex(
                "ListMeta",
                {
                  indexName: index.indexName,
                  propertyName: "category",
                  indexType: "string",
                },
              );
              return { index, meta };
            }),
          );

          const provider = yield* Provider.findProvider(
            Cloudflare.Vectorize.MetadataIndex,
          );

          const { accountId } = yield* yield* CloudflareEnvironment;
          yield* waitForMetadata(accountId, index.indexName, [meta]);
          const all = yield* provider.list().pipe(Effect.timeout("20 seconds"));

          const entry = all.find(
            (x) =>
              x.indexName === index.indexName && x.propertyName === "category",
          );
          expect(entry?.indexType).toBe("string");
          expect(entry?.accountId).toBeDefined();

          yield* stack.destroy();
        }).pipe(
          Effect.ensuring(
            stack.destroy().pipe(Effect.orDie).pipe(Effect.ignore),
          ),
          logLevel,
        ),
      { timeout: 210_000 },
    );

    test.provider(
      "destroy is idempotent when the parent index was deleted out-of-band",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const { index } = yield* stack.deploy(
            Effect.gen(function* () {
              const index = yield* Cloudflare.Vectorize.Index("OobParent", {
                dimensions: 32,
                metric: "cosine",
              });
              yield* Cloudflare.Vectorize.MetadataIndex("OobMeta", {
                indexName: index.indexName,
                propertyName: "ns",
                indexType: "string",
              });
              return { index };
            }),
          );
          // Simulate Cloudflare's cascading delete: drop the parent directly.
          // On Cloudflare's side this also removes the metadata index.
          // Deletion must work even while the metadata mutation is pending;
          // waiting for query visibility is not a prerequisite for teardown.
          yield* vectorize.deleteIndex({
            accountId,
            indexName: index.indexName,
          });

          // Bounded typed wait for the out-of-band delete to actually settle
          // before exercising the idempotent `destroy` path.
          const gone = yield* waitForIndexGone(accountId, index.indexName);
          expect(gone).toBe(true);

          // The metadata index provider's delete tolerates 404/410 from the
          // missing parent, so `destroy` succeeds without erroring.
          yield* stack.destroy();
        }).pipe(
          Effect.ensuring(
            stack.destroy().pipe(Effect.orDie).pipe(Effect.ignore),
          ),
          logLevel,
        ),
      { timeout: 210_000 },
    );
  },
);

const listMetadataIndexes = Effect.fn(function* (
  accountId: string,
  indexName: string,
) {
  return yield* vectorize
    .listIndexMetadataIndexes({ accountId, indexName })
    .pipe(
      Effect.timeout("5 seconds"),
      Effect.map((res) => res.metadataIndexes ?? []),
      Effect.catchTag(["NotFound", "Gone"], () =>
        // Parent index gone — treat as "no metadata indexes".
        Effect.succeed([]),
      ),
    );
});

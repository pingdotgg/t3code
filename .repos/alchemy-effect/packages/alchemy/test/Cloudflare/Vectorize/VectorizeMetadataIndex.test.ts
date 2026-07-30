import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { poll } from "@/Util/poll.ts";
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

// Vectorize metadata-index visibility is a slow, *variable* async mutation on
// Cloudflare's side: a freshly-created index takes ~70-115s to surface in the
// `metadata_index/list` response in isolation, but under a FULL concurrent
// `./test/Cloudflare` run the mutation is materially slower and can exceed
// ~165s. Cap the poll so a genuine regression (the index never materializes)
// still fails fast as a `PredicateFailed` — at ~240s instead of running into
// the opaque vitest timeout — while leaving enough headroom to absorb
// concurrent-load latency; the per-test timeouts below exceed this cap.
const metaIndexPoll = Schedule.max([
  Schedule.spaced("5 seconds"),
  Schedule.recurs(48),
]);

// The "coexist" case materializes TWO metadata indexes (category + price) on a
// single parent and waits for BOTH to surface. Under a full concurrent
// `./test/Cloudflare` run two sequential materializations can exceed the shared
// ~240s `metaIndexPoll` cap, so give this case a wider — but still bounded —
// poll (~330s). A genuine regression (an index that never materializes) still
// fails fast as a `PredicateFailed`; the per-test timeout below exceeds this
// cap so a healthy-but-slow run never races the opaque vitest timeout.
const multiMetaIndexPoll = Schedule.max([
  Schedule.spaced("5 seconds"),
  Schedule.recurs(66),
]);

// Bounded typed wait for a parent VectorizeIndex to actually disappear from
// Cloudflare after a delete/replace. Index deletes are quick, so a short
// (~30s) bound is plenty; a regression surfaces as a `PredicateFailed`.
const waitForIndexGone = (accountId: string, indexName: string) =>
  poll({
    description: `parent index ${indexName} is gone`,
    effect: vectorize.getIndex({ accountId, indexName }).pipe(
      Effect.as(false),
      Effect.catchTag(["NotFound", "Gone"], () => Effect.succeed(true)),
    ),
    predicate: (gone) => gone,
    schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(15)]),
  });

describe.skipIf(!!process.env.FAST)(
  "Cloudflare.Vectorize.MetadataIndex",
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
          // processes the async mutation — slow and variable under full
          // concurrent load, so use the wider capped poll.
          const entries = yield* poll({
            description: "metadata index exists with propertyName=category",
            effect: listMetadataIndexes(accountId, index.indexName),
            predicate: (entries) =>
              entries.some((e) => e.propertyName === "category"),
            schedule: metaIndexPoll,
          });
          expect(
            entries.find((e) => e.propertyName === "category")?.indexType,
          ).toBe("String");

          yield* stack.destroy();

          // Both parent and metadata index are gone.
          const after = yield* listMetadataIndexes(accountId, index.indexName);
          expect(after.length).toBe(0);
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      // The single metadata-index materialization can take up to the ~240s
      // poll ceiling under concurrent load — give headroom above the cap so a
      // healthy-but-slow run never races the vitest timeout.
      { timeout: 300_000 },
    );

    test.provider(
      "multiple metadata indexes on the same parent coexist",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const { index } = yield* stack.deploy(
            Effect.gen(function* () {
              const index = yield* Cloudflare.Vectorize.Index("MultiParent", {
                dimensions: 32,
                metric: "cosine",
              });
              yield* Cloudflare.Vectorize.MetadataIndex("CategoryMeta", {
                indexName: index.indexName,
                propertyName: "category",
                indexType: "string",
              });
              yield* Cloudflare.Vectorize.MetadataIndex("PriceMeta", {
                indexName: index.indexName,
                propertyName: "price",
                indexType: "number",
              });
              return { index };
            }),
          );
          const entries = yield* poll({
            description: "metadata index includes category and price",
            effect: listMetadataIndexes(accountId, index.indexName),
            predicate: (entries) =>
              entries.some((e) => e.propertyName === "category") &&
              entries.some((e) => e.propertyName === "price"),
            schedule: multiMetaIndexPoll,
          });
          expect(
            entries.find((e) => e.propertyName === "category")?.indexType,
          ).toBe("String");
          expect(
            entries.find((e) => e.propertyName === "price")?.indexType,
          ).toBe("Number");

          yield* stack.destroy();
        }).pipe(
          // Guarantee teardown even if a poll/assertion fails or the test is
          // interrupted by a timeout — the scratch stack's state is in-memory
          // only, so a body that throws before the trailing `destroy()` would
          // otherwise leak the parent + metadata indexes with no next-run
          // cleanup.
          Effect.ensuring(stack.destroy().pipe(Effect.ignore)),
          logLevel,
        ),
      // TWO sequential metadata-index materializations on one parent, capped at
      // the wider ~330s `multiMetaIndexPoll` ceiling under full concurrent load
      // — give the test headroom above that cap (plus create/destroy overhead)
      // so a healthy-but-slow run never races the vitest timeout. The poll cap
      // still makes a real regression fail fast.
      { timeout: 420_000 },
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
          yield* poll({
            description: "metadata index exists with propertyName=tag",
            effect: listMetadataIndexes(accountId, oldIndex.indexName),
            predicate: (entries) =>
              entries.some((e) => e.propertyName === "tag"),
            schedule: metaIndexPoll,
          });

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
          yield* poll({
            description: "metadata index exists with propertyName=tag",
            effect: listMetadataIndexes(accountId, newIndex.indexName),
            predicate: (entries) =>
              entries.some((e) => e.propertyName === "tag"),
            schedule: metaIndexPoll,
          });

          yield* stack.destroy();
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      // Two sequential metadata-index materializations plus a parent
      // replacement (delete old + create new) and a bounded gone-wait — give
      // this genuinely slow create+replace+poll lifecycle real headroom above
      // the two poll caps (2 x ~240s) + the ~30s gone-wait so a healthy run
      // never races the timeout. Still bounded so a real regression fails fast.
      { timeout: 600_000 },
    );

    test.provider(
      "list enumerates the deployed metadata index",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { index } = yield* stack.deploy(
            Effect.gen(function* () {
              const index = yield* Cloudflare.Vectorize.Index("ListParent", {
                dimensions: 32,
                metric: "cosine",
              });
              yield* Cloudflare.Vectorize.MetadataIndex("ListMeta", {
                indexName: index.indexName,
                propertyName: "category",
                indexType: "string",
              });
              return { index };
            }),
          );

          const provider = yield* Provider.findProvider(
            Cloudflare.Vectorize.MetadataIndex,
          );

          // Cloudflare processes the create as an async mutation, so the entry
          // appears in list() once the mutation is applied — slow and variable
          // under full concurrent load, so use the wider capped poll.
          const all = yield* poll({
            description: "list() includes the deployed metadata index",
            effect: provider.list(),
            predicate: (all) =>
              all.some(
                (x) =>
                  x.indexName === index.indexName &&
                  x.propertyName === "category",
              ),
            schedule: metaIndexPoll,
          });

          const entry = all.find(
            (x) =>
              x.indexName === index.indexName && x.propertyName === "category",
          );
          expect(entry?.indexType).toBe("string");
          expect(entry?.accountId).toBeDefined();

          yield* stack.destroy();
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      // The single metadata-index materialization can take up to the ~240s
      // poll ceiling under concurrent load — give headroom above the cap.
      { timeout: 300_000 },
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
          yield* poll({
            description: "metadata index exists with propertyName=ns",
            effect: listMetadataIndexes(accountId, index.indexName),
            predicate: (entries) =>
              entries.some((e) => e.propertyName === "ns"),
            schedule: metaIndexPoll,
          });

          // Simulate Cloudflare's cascading delete: drop the parent directly.
          // On Cloudflare's side this also removes the metadata index.
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
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      // One metadata-index materialization (capped at ~240s under concurrent
      // load) plus an out-of-band delete + gone-wait — keep headroom above the
      // poll ceiling so a healthy-but-slow run never races the vitest timeout.
      { timeout: 300_000 },
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
      Effect.map((res) => res.metadataIndexes ?? []),
      Effect.catchTag(["NotFound", "Gone"], () =>
        // Parent index gone — treat as "no metadata indexes".
        Effect.succeed([]),
      ),
    );
});

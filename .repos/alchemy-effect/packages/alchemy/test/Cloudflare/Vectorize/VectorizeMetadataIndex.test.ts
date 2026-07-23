import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import { poll } from "@/Util/poll.ts";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete a metadata index", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const { index, meta } = yield* stack.deploy(
      Effect.gen(function* () {
        const index = yield* Cloudflare.VectorizeIndex("ParentIdx", {
          dimensions: 32,
          metric: "cosine",
        });
        const meta = yield* Cloudflare.VectorizeMetadataIndex("MetaIdx", {
          indexName: index.indexName,
          propertyName: "category",
          indexType: "string",
        });
        return { index, meta };
      }),
    );

    expect(meta.propertyName).toBe("category");
    expect(meta.indexType).toBe("string");
    expect(meta.indexName).toBe(index.indexName);

    // The metadata index appears in the parent's list once Cloudflare
    // processes the async mutation.
    const entries = yield* poll({
      description: "metadata index exists with propertyName=category",
      effect: listMetadataIndexes(accountId, index.indexName),
      predicate: (entries) =>
        entries.some((e) => e.propertyName === "category"),
    });
    expect(entries.find((e) => e.propertyName === "category")?.indexType).toBe(
      "String",
    );

    yield* stack.destroy();

    // Both parent and metadata index are gone.
    const after = yield* listMetadataIndexes(accountId, index.indexName);
    expect(after.length).toBe(0);
  }).pipe(logLevel),
);

test.provider("multiple metadata indexes on the same parent coexist", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const { index } = yield* stack.deploy(
      Effect.gen(function* () {
        const index = yield* Cloudflare.VectorizeIndex("MultiParent", {
          dimensions: 32,
          metric: "cosine",
        });
        yield* Cloudflare.VectorizeMetadataIndex("CategoryMeta", {
          indexName: index.indexName,
          propertyName: "category",
          indexType: "string",
        });
        yield* Cloudflare.VectorizeMetadataIndex("PriceMeta", {
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
    });
    expect(entries.find((e) => e.propertyName === "category")?.indexType).toBe(
      "String",
    );
    expect(entries.find((e) => e.propertyName === "price")?.indexType).toBe(
      "Number",
    );

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "replacing the parent index also replaces the metadata index",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Initial deploy with dimensions=32.
      const { index: oldIndex } = yield* stack.deploy(
        Effect.gen(function* () {
          const index = yield* Cloudflare.VectorizeIndex("ReplaceParent", {
            dimensions: 32,
            metric: "cosine",
          });
          yield* Cloudflare.VectorizeMetadataIndex("ReplaceMeta", {
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
        predicate: (entries) => entries.some((e) => e.propertyName === "tag"),
      });

      // Re-deploy with different dimensions — the parent replaces, which
      // also replaces the metadata index on the new parent.
      const { index: newIndex, meta: newMeta } = yield* stack.deploy(
        Effect.gen(function* () {
          const index = yield* Cloudflare.VectorizeIndex("ReplaceParent", {
            dimensions: 64,
            metric: "cosine",
          });
          const meta = yield* Cloudflare.VectorizeMetadataIndex("ReplaceMeta", {
            indexName: index.indexName,
            propertyName: "tag",
            indexType: "string",
          });
          return { index, meta };
        }),
      );

      expect(newIndex.indexName).not.toBe(oldIndex.indexName);
      expect(newMeta.indexName).toBe(newIndex.indexName);

      // Old parent is gone.
      const oldGone = yield* vectorize
        .getIndex({ accountId, indexName: oldIndex.indexName })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag(["NotFound", "Gone"], () => Effect.succeed(true)),
        );
      expect(oldGone).toBe(true);

      // The new parent has the metadata index.
      yield* poll({
        description: "metadata index exists with propertyName=tag",
        effect: listMetadataIndexes(accountId, newIndex.indexName),
        predicate: (entries) => entries.some((e) => e.propertyName === "tag"),
      });

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "destroy is idempotent when the parent index was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const { index } = yield* stack.deploy(
        Effect.gen(function* () {
          const index = yield* Cloudflare.VectorizeIndex("OobParent", {
            dimensions: 32,
            metric: "cosine",
          });
          yield* Cloudflare.VectorizeMetadataIndex("OobMeta", {
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
        predicate: (entries) => entries.some((e) => e.propertyName === "ns"),
      });

      // Simulate Cloudflare's cascading delete: drop the parent directly.
      // On Cloudflare's side this also removes the metadata index.
      yield* vectorize.deleteIndex({
        accountId,
        indexName: index.indexName,
      });

      // The metadata index provider's delete tolerates 404/410 from the
      // missing parent, so `destroy` succeeds without erroring.
      yield* stack.destroy();
    }).pipe(logLevel),
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

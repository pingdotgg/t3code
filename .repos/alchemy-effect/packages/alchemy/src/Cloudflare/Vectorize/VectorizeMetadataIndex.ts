import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import * as Effect from "effect/Effect";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type MetadataIndexType = "string" | "number" | "boolean";

export type VectorizeMetadataIndexProps = {
  /**
   * Name of the parent Vectorize index. Pass `index.indexName` from a
   * `VectorizeIndex` to track the dependency. Changing the parent index
   * triggers a replacement.
   */
  indexName: string;
  /**
   * The metadata property to index. Filter expressions in `query` use this
   * name (e.g. `{ category: { $eq: "books" } }`). Cannot be changed after
   * creation — updating triggers a replacement.
   */
  propertyName: string;
  /**
   * The type of metadata values stored under `propertyName`. Cannot be
   * changed after creation — updating triggers a replacement.
   */
  indexType: MetadataIndexType;
};

export type VectorizeMetadataIndexAttributes = {
  propertyName: string;
  indexType: MetadataIndexType;
  indexName: string;
  accountId: string;
  mutationId: string | undefined;
};

export type VectorizeMetadataIndex = Resource<
  "Cloudflare.VectorizeMetadataIndex",
  VectorizeMetadataIndexProps,
  VectorizeMetadataIndexAttributes,
  never,
  Providers
>;

/**
 * A metadata index on a Cloudflare Vectorize index.
 *
 * Metadata indexes enable filtering query results by metadata properties.
 * Without a metadata index on a property, that property cannot be used in
 * the `filter` of a `query()` call.
 *
 * A metadata index is identified by its parent index and `propertyName` and
 * is immutable — changing the property name, type, or parent index triggers
 * a replacement.
 *
 * @section Creating a Metadata Index
 * @example Index a string metadata property
 * ```typescript
 * const index = yield* Cloudflare.VectorizeIndex("my-index", {
 *   dimensions: 768,
 *   metric: "cosine",
 * });
 *
 * yield* Cloudflare.VectorizeMetadataIndex("CategoryMetaIndex", {
 *   indexName: index.indexName,
 *   propertyName: "category",
 *   indexType: "string",
 * });
 * ```
 *
 * @example Index a numeric metadata property
 * ```typescript
 * yield* Cloudflare.VectorizeMetadataIndex("PriceMetaIndex", {
 *   indexName: index.indexName,
 *   propertyName: "price",
 *   indexType: "number",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/vectorize/reference/metadata-filtering/
 */
export const VectorizeMetadataIndex = Resource<VectorizeMetadataIndex>(
  "Cloudflare.VectorizeMetadataIndex",
);

export const VectorizeMetadataIndexProvider = () =>
  Provider.effect(
    VectorizeMetadataIndex,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createMetadataIndex = yield* vectorize.createIndexMetadataIndex;
      const deleteMetadataIndex = yield* vectorize.deleteIndexMetadataIndex;
      const listMetadataIndexes = yield* vectorize.listIndexMetadataIndexes;

      const findExisting = (
        acct: string,
        indexName: string,
        propertyName: string,
      ) =>
        listMetadataIndexes({
          accountId: acct,
          indexName,
        }).pipe(
          Effect.map((res) => {
            const index = res.metadataIndexes?.find(
              (m) => m.propertyName === propertyName,
            );
            return index
              ? {
                  propertyName: index.propertyName,
                  indexType:
                    index.indexType?.toLowerCase() as MetadataIndexType,
                }
              : undefined;
          }),
          Effect.catchTag(["NotFound", "Gone"], () =>
            Effect.succeed(undefined),
          ),
        );

      return {
        stables: ["propertyName", "indexName", "accountId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const newIndexName = news.indexName;
          const oldIndexName = output?.indexName ?? olds.indexName;
          if (
            (oldIndexName ?? newIndexName) !== newIndexName ||
            (olds.propertyName ?? news.propertyName) !== news.propertyName ||
            (olds.indexType ?? news.indexType) !== news.indexType
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const acct = output?.accountId ?? accountId;
          const indexName = output?.indexName ?? olds?.indexName;
          const propertyName = output?.propertyName ?? olds?.propertyName;
          if (!indexName || !propertyName) return undefined;
          const existing = yield* findExisting(acct, indexName, propertyName);
          if (!existing?.propertyName || !existing.indexType) return undefined;
          return {
            propertyName: existing.propertyName,
            indexType: existing.indexType,
            indexName,
            accountId: acct,
            mutationId: output?.mutationId,
          };
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const acct = output?.accountId ?? accountId;
          const indexName = news.indexName;

          // Observe — list metadata indexes on the parent and look for one
          // matching propertyName.
          const existing = yield* findExisting(
            acct,
            indexName,
            news.propertyName,
          );

          // Ensure — create if missing. Cloudflare returns 409 Conflict on
          // duplicate; tolerate the race by reusing the prior mutationId.
          let mutationId = output?.mutationId;
          if (!existing) {
            const created = yield* createMetadataIndex({
              accountId: acct,
              indexName,
              propertyName: news.propertyName,
              indexType: news.indexType,
            }).pipe(
              Effect.catchTag("MetadataIndexAlreadyExists", () =>
                Effect.succeed({ mutationId: output?.mutationId }),
              ),
            );
            mutationId = created.mutationId ?? undefined;
          }

          return {
            propertyName: news.propertyName,
            indexType: news.indexType,
            indexName,
            accountId: acct,
            mutationId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteMetadataIndex({
            accountId: output.accountId,
            indexName: output.indexName,
            propertyName: output.propertyName,
          }).pipe(
            Effect.catchTag(
              ["NotFound", "Gone", "MetadataIndexNotFound"],
              () => Effect.void,
            ),
          );
        }),
      };
    }),
  );

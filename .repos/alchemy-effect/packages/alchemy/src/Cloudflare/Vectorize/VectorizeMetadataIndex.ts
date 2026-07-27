import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type MetadataIndexType = "string" | "number" | "boolean";

export type MetadataIndexProps = {
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

export type MetadataIndexAttributes = {
  propertyName: string;
  indexType: MetadataIndexType;
  indexName: string;
  accountId: string;
  mutationId: string | undefined;
};

export type MetadataIndex = Resource<
  "Cloudflare.VectorizeMetadataIndex",
  MetadataIndexProps,
  MetadataIndexAttributes,
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
 * @resource
 * @product Vectorize
 * @category AI
 * @section Creating a Metadata Index
 * @example Index a string metadata property
 * ```typescript
 * const index = yield* Cloudflare.Vectorize.Index("my-index", {
 *   dimensions: 768,
 *   metric: "cosine",
 * });
 *
 * yield* Cloudflare.Vectorize.MetadataIndex("CategoryMetaIndex", {
 *   indexName: index.indexName,
 *   propertyName: "category",
 *   indexType: "string",
 * });
 * ```
 *
 * @example Index a numeric metadata property
 * ```typescript
 * yield* Cloudflare.Vectorize.MetadataIndex("PriceMetaIndex", {
 *   indexName: index.indexName,
 *   propertyName: "price",
 *   indexType: "number",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/vectorize/reference/metadata-filtering/
 */
export const MetadataIndex = Resource<MetadataIndex>(
  "Cloudflare.VectorizeMetadataIndex",
);

export const MetadataIndexProvider = () =>
  Provider.succeed(MetadataIndex, {
    stables: ["propertyName", "indexName", "accountId"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
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
      const { accountId } = yield* yield* CloudflareEnvironment;
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
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const indexName = news.indexName;

      // Observe — list metadata indexes on the parent and look for one
      // matching propertyName.
      const existing = yield* findExisting(acct, indexName, news.propertyName);

      // Ensure — create if missing. Cloudflare returns 409 Conflict on
      // duplicate; tolerate the race by reusing the prior mutationId.
      let mutationId = output?.mutationId;
      if (!existing) {
        const created = yield* vectorize
          .createIndexMetadataIndex({
            accountId: acct,
            indexName,
            propertyName: news.propertyName,
            indexType: news.indexType,
          })
          .pipe(
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
      yield* vectorize
        .deleteIndexMetadataIndex({
          accountId: output.accountId,
          indexName: output.indexName,
          propertyName: output.propertyName,
        })
        .pipe(
          Effect.catchTag(
            ["NotFound", "Gone", "MetadataIndexNotFound"],
            () => Effect.void,
          ),
        );
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // Parent fan-out: metadata indexes are sub-resources of a Vectorize
      // index. Enumerate every parent index (account-scoped, paginated),
      // then list metadata indexes per index with bounded concurrency.
      const indexNames = yield* vectorize.listIndexes.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .map((index) => index.name)
              .filter((name): name is string => name != null),
          ),
        ),
        // A parent index deleted by a concurrent operation mid-enumeration
        // can fail the account-scoped pagination with "index deleted" (typed
        // as Gone) — skip the whole enumeration rather than throw.
        Effect.catchTag(["NotFound", "Gone"], () =>
          Effect.succeed<string[]>([]),
        ),
      );

      const rows = yield* Effect.forEach(
        indexNames,
        (indexName) =>
          vectorize.listIndexMetadataIndexes({ accountId, indexName }).pipe(
            Effect.map((res) =>
              (res.metadataIndexes ?? []).flatMap(
                (m): MetadataIndexAttributes[] => {
                  if (m.propertyName == null || m.indexType == null) {
                    return [];
                  }
                  return [
                    {
                      propertyName: m.propertyName,
                      indexType: m.indexType.toLowerCase() as MetadataIndexType,
                      indexName,
                      accountId,
                      mutationId: undefined,
                    },
                  ];
                },
              ),
            ),
            // Parent index removed between enumeration and read; skip it.
            Effect.catchTag(["NotFound", "Gone"], () =>
              Effect.succeed<MetadataIndexAttributes[]>([]),
            ),
          ),
        { concurrency: 10 },
      );

      return rows.flat();
    }),
  });

const findExisting = (acct: string, indexName: string, propertyName: string) =>
  vectorize
    .listIndexMetadataIndexes({
      accountId: acct,
      indexName,
    })
    .pipe(
      Effect.map((res) => {
        const index = res.metadataIndexes?.find(
          (m) => m.propertyName === propertyName,
        );
        return index
          ? {
              propertyName: index.propertyName,
              indexType: index.indexType?.toLowerCase() as MetadataIndexType,
            }
          : undefined;
      }),
      Effect.catchTag(["NotFound", "Gone"], () => Effect.succeed(undefined)),
    );

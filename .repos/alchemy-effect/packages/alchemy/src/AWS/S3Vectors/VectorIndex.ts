import * as s3vectors from "@distilled.cloud/aws/s3vectors";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface IndexProps {
  /**
   * Name of the vector bucket that holds this index. Pass
   * `bucket.vectorBucketName` from a {@link VectorBucket}.
   *
   * Changing it replaces the index.
   */
  vectorBucketName: string;
  /**
   * Name of the index (3-63 chars, lowercase). If omitted, a unique name is
   * generated from the app, stage, and logical id.
   *
   * Changing the name replaces the index.
   * @default ${app}-${stage}-${id}
   */
  indexName?: string;
  /**
   * The data type of the vectors stored in this index. Immutable — changing
   * it replaces the index.
   * @default "float32"
   */
  dataType?: "float32";
  /**
   * The number of dimensions of the vectors stored in this index. Immutable —
   * changing it replaces the index.
   */
  dimension: number;
  /**
   * The distance metric used for similarity queries. Immutable — changing it
   * replaces the index.
   */
  distanceMetric: "euclidean" | "cosine";
  /**
   * Metadata keys that are stored but NOT filterable at query time. Immutable
   * — changing it replaces the index.
   */
  nonFilterableMetadataKeys?: string[];
  /**
   * Tags to apply to the index. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Index extends Resource<
  "AWS.S3Vectors.Index",
  IndexProps,
  {
    /**
     * Name of the vector bucket containing the index.
     */
    vectorBucketName: string;
    /**
     * Name of the index.
     */
    indexName: string;
    /**
     * ARN of the index.
     */
    indexArn: string;
  },
  never,
  Providers
> {}

/**
 * A vector index inside an S3 Vectors {@link VectorBucket} — stores vectors of
 * a fixed dimension and answers similarity queries under a distance metric.
 *
 * The index shape (data type, dimension, distance metric, non-filterable
 * metadata keys) is fixed at create time; changing any of them replaces the
 * index.
 *
 * @resource
 * @section Creating an Index
 * @example Cosine-Similarity Index
 * ```typescript
 * import * as S3Vectors from "alchemy/AWS/S3Vectors";
 *
 * const bucket = yield* S3Vectors.VectorBucket("Embeddings", {});
 * const index = yield* S3Vectors.Index("Docs", {
 *   vectorBucketName: bucket.vectorBucketName,
 *   dimension: 1024,
 *   distanceMetric: "cosine",
 * });
 * ```
 */
export const Index = Resource<Index>("AWS.S3Vectors.Index");

const shapeKey = (props: IndexProps) =>
  JSON.stringify({
    dataType: props.dataType ?? "float32",
    dimension: props.dimension,
    distanceMetric: props.distanceMetric,
    nonFilterableMetadataKeys: [
      ...(props.nonFilterableMetadataKeys ?? []),
    ].sort(),
  });

export const IndexProvider = () =>
  Provider.effect(
    Index,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<IndexProps, "indexName">,
      ) {
        return (
          props.indexName ??
          (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase()
        );
      });

      const observe = (vectorBucketName: string, indexName: string) =>
        s3vectors.getIndex({ vectorBucketName, indexName }).pipe(
          Effect.map((r) => r.index),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );

      const observedTags = (resourceArn: string) =>
        s3vectors.listTagsForResource({ resourceArn }).pipe(
          Effect.map(
            (r) =>
              Object.fromEntries(
                Object.entries(r.tags ?? {}).filter(([, v]) => v !== undefined),
              ) as Record<string, string>,
          ),
          Effect.catchTag("NotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      return Index.Provider.of({
        stables: ["vectorBucketName", "indexName", "indexArn"],
        // Indexes are keyed by a parent vector bucket; global enumeration would
        // require fanning out over every bucket. Return empty — the engine
        // reads owned indexes via read() using the cached output identity.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const vectorBucketName =
            output?.vectorBucketName ?? olds?.vectorBucketName;
          if (vectorBucketName === undefined) return undefined;
          const name = output?.indexName ?? (yield* createName(id, olds ?? {}));
          const found = yield* observe(vectorBucketName, name);
          if (!found) return undefined;
          const attrs = {
            vectorBucketName: found.vectorBucketName,
            indexName: found.indexName,
            indexArn: found.indexArn,
          };
          const tags = yield* observedTags(found.indexArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            olds?.vectorBucketName !== undefined &&
            olds.vectorBucketName !== news.vectorBucketName
          ) {
            return { action: "replace" } as const;
          }
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) return { action: "replace" } as const;
          // The index shape is immutable — any change replaces.
          if (olds !== undefined && shapeKey(olds) !== shapeKey(news)) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update (tags only)
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const vectorBucketName = news.vectorBucketName;
          const name = output?.indexName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let live = yield* observe(vectorBucketName, name);

          // 2. ENSURE — create when missing; a concurrent create surfaces as
          //    ConflictException, which we treat as a race and re-observe.
          if (live === undefined) {
            yield* s3vectors
              .createIndex({
                vectorBucketName,
                indexName: name,
                dataType: news.dataType ?? "float32",
                dimension: news.dimension,
                distanceMetric: news.distanceMetric,
                metadataConfiguration: news.nonFilterableMetadataKeys
                  ? {
                      nonFilterableMetadataKeys: news.nonFilterableMetadataKeys,
                    }
                  : undefined,
                tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            live = yield* observe(vectorBucketName, name);
          }

          const indexArn = live?.indexArn ?? output?.indexArn;

          // 3. SYNC TAGS — diff against OBSERVED cloud tags.
          if (indexArn !== undefined) {
            const currentTags = yield* observedTags(indexArn);
            const { upsert, removed } = diffTags(currentTags, desiredTags);
            if (upsert.length > 0) {
              yield* s3vectors.tagResource({
                resourceArn: indexArn,
                tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              });
            }
            if (removed.length > 0) {
              yield* s3vectors.untagResource({
                resourceArn: indexArn,
                tagKeys: removed,
              });
            }
          }

          yield* session.note(name);
          return { vectorBucketName, indexName: name, indexArn: indexArn! };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* s3vectors
            .deleteIndex({
              vectorBucketName: output.vectorBucketName,
              indexName: output.indexName,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );

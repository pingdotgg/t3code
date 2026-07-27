import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.VectorizeIndex" as const;
type TypeId = typeof TypeId;

export type DistanceMetric = "cosine" | "euclidean" | "dot-product";

export type Preset =
  | "@cf/baai/bge-small-en-v1.5"
  | "@cf/baai/bge-base-en-v1.5"
  | "@cf/baai/bge-large-en-v1.5"
  | "openai/text-embedding-ada-002"
  | "cohere/embed-multilingual-v2.0"
  // Keep the union open so new Cloudflare presets aren't blocked by stale types.
  | (string & {});

const DEFAULT_METRIC: DistanceMetric = "cosine";

export type IndexProps = {
  /**
   * Name of the index. If omitted, a unique name will be generated.
   * Must be lowercase alphanumeric with hyphens. Changing it triggers a
   * replacement.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Number of dimensions for each vector stored in the index. Required
   * unless `preset` is provided. Cannot be changed after creation —
   * updating this property triggers a replacement.
   */
  dimensions?: number;
  /**
   * Distance metric used for similarity search. Cannot be changed after
   * creation — updating this property triggers a replacement.
   * @default "cosine"
   */
  metric?: DistanceMetric;
  /**
   * A managed embedding model preset that fixes `dimensions` and `metric`
   * to match the named model. Mutually exclusive with `dimensions`/`metric`.
   * Cannot be changed after creation — updating this triggers a replacement.
   */
  preset?: Preset;
  /**
   * Human-readable description of the index. Vectorize has no update API,
   * so changing the description triggers a replacement.
   */
  description?: string;
};

export type IndexAttributes = {
  indexName: string;
  dimensions: number | undefined;
  metric: DistanceMetric | undefined;
  description: string | undefined;
  accountId: string;
  createdOn: string | undefined;
  modifiedOn: string | undefined;
};

export type Index = Resource<
  TypeId,
  IndexProps,
  IndexAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Vectorize index for storing and querying vector embeddings.
 *
 * Vectorize is a globally distributed vector database. Create an index as a
 * resource, then bind it to a Worker to insert, upsert, and query vectors.
 *
 * A Vectorize index is identified by its name and is immutable: its
 * dimensions, metric, preset, and description are all fixed at creation.
 * Changing any of them triggers a replacement.
 * @resource
 * @product Vectorize
 * @category AI
 * @section Creating an Index
 * @example Index with explicit dimensions and metric
 * ```typescript
 * const index = yield* Cloudflare.Vectorize.Index("my-index", {
 *   dimensions: 768,
 *   metric: "cosine",
 * });
 * ```
 *
 * @example Index from a managed embedding model preset
 * A preset fixes the dimensions and metric to match the named model.
 * ```typescript
 * const index = yield* Cloudflare.Vectorize.Index("my-index", {
 *   preset: "@cf/baai/bge-base-en-v1.5",
 * });
 * ```
 *
 * @example Index with a description
 * ```typescript
 * const index = yield* Cloudflare.Vectorize.Index("my-index", {
 *   dimensions: 1536,
 *   metric: "euclidean",
 *   description: "Product catalog embeddings",
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Querying an index inside a Worker
 * ```typescript
 * const index = yield* Cloudflare.Vectorize.SearchIndex(MyIndex);
 *
 * // Insert vectors
 * yield* index.upsert([
 *   { id: "1", values: [0.1, 0.2, 0.3], metadata: { title: "doc" } },
 * ]);
 *
 * // Query the nearest neighbors
 * const matches = yield* index.query([0.1, 0.2, 0.3], { topK: 5 });
 * ```
 *
 * @see https://developers.cloudflare.com/vectorize/
 */
export const Index = Resource<Index>(TypeId);

/**
 * Returns true if the given value is a Vectorize Index resource.
 */
export const isIndex = (value: unknown): value is Index =>
  isResourceOfType(value, TypeId);

export const IndexProvider = () =>
  Provider.succeed(Index, {
    stables: ["indexName", "accountId"],
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const oldName =
        output?.indexName ?? (yield* createIndexName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = news.name ?? oldName;
      if (
        oldName !== name ||
        (news.preset ?? undefined) !== (olds.preset ?? undefined) ||
        (news.dimensions ?? undefined) !== (olds.dimensions ?? undefined) ||
        (news.metric ?? DEFAULT_METRIC) !== (olds.metric ?? DEFAULT_METRIC) ||
        (news.description ?? undefined) !== (olds.description ?? undefined)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const name =
        output?.indexName ?? (yield* createIndexName(id, olds?.name));
      return yield* vectorize
        .getIndex({ accountId: acct, indexName: name })
        .pipe(
          Effect.map((index) => toAttributes(index, name, acct)),
          Effect.catchTag(["NotFound", "Gone"], () =>
            Effect.succeed(undefined),
          ),
        );
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Prefer the deployed name: regenerating would target a different
      // index if the generator's output for this id ever drifts.
      const indexName =
        output?.indexName ?? (yield* createIndexName(id, news.name));

      // Observe — read the live index by name. The name is the stable
      // identifier; fall back through a NotFound to the create path so
      // we recover from out-of-band deletes or partial state-persistence.
      let observed = yield* vectorize
        .getIndex({
          accountId,
          indexName,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Gone"], () =>
            Effect.succeed(undefined),
          ),
        );

      // Ensure — create if missing. Cloudflare returns 409 Conflict when
      // an index with the same name already exists; tolerate the race by
      // re-reading it.
      if (!observed) {
        observed = yield* vectorize
          .createIndex({
            accountId,
            name: indexName,
            config: buildConfig(news),
            description: news.description,
          })
          .pipe(
            Effect.catchTag("IndexAlreadyExists", () =>
              vectorize.getIndex({ accountId, indexName }),
            ),
          );
      }

      return toAttributes(observed, indexName, accountId);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* vectorize
        .deleteIndex({
          accountId: output.accountId,
          indexName: output.indexName,
        })
        .pipe(Effect.catchTag(["NotFound", "Gone"], () => Effect.void));
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* vectorize.listIndexes.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .filter(
                (
                  index,
                ): index is (typeof page.result)[number] & {
                  name: string;
                } => index.name != null,
              )
              .map((index) => toAttributes(index, index.name, accountId)),
          ),
        ),
      );
    }),
  });

const toAttributes = (
  index: vectorize.GetIndexResponse | vectorize.CreateIndexResponse,
  name: string,
  accountId: string,
): IndexAttributes => ({
  indexName: index.name ?? name,
  dimensions: index.config?.dimensions,
  // Distilled widened generated string enums to open unions (`string & {}`).
  metric: index.config?.metric as DistanceMetric | undefined,
  description: index.description ?? undefined,
  accountId,
  createdOn: index.createdOn ?? undefined,
  modifiedOn: index.modifiedOn ?? undefined,
});

const createIndexName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const buildConfig = (
  news: IndexProps,
): vectorize.CreateIndexRequest["config"] =>
  news.preset !== undefined
    ? // `Preset` is intentionally open (`| (string & {})`) so
      // new Cloudflare presets aren't blocked by stale types. The
      // distilled type is the strict-at-release-time union; cast
      // through for the API call.
      ({
        preset: news.preset as never,
      } as vectorize.CreateIndexRequest["config"])
    : {
        dimensions: news.dimensions!,
        metric: news.metric ?? DEFAULT_METRIC,
      };

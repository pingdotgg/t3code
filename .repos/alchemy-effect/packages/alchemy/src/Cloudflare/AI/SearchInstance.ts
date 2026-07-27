import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.AI.Search" as const;
type TypeId = typeof TypeId;

/**
 * The kind of data source an AI Search instance indexes.
 */
export type SearchInstanceSourceType = "r2" | "web-crawler";

/**
 * Generation model used to answer AI Search queries.
 */
export type Model = Exclude<
  NonNullable<aisearch.CreateInstanceRequest["aiSearchModel"]>,
  ""
>;

/**
 * Embedding model used to vectorize indexed content. Cannot be changed
 * after creation (it defines the vector space).
 */
export type EmbeddingModel = Exclude<
  NonNullable<aisearch.CreateInstanceRequest["embeddingModel"]>,
  ""
>;

/**
 * Reranking model applied to retrieved results.
 */
export type RerankingModel = "@cf/baai/bge-reranker-base";

/**
 * Data-source specific indexing parameters (R2 prefix / include / exclude
 * filters, or web-crawler options).
 */
export type SourceParams = NonNullable<
  aisearch.CreateInstanceRequest["sourceParams"]
>;

/**
 * Controls which storage backends are used during indexing.
 */
export type IndexMethod = NonNullable<
  aisearch.CreateInstanceRequest["indexMethod"]
>;

/**
 * Keyword indexing options.
 */
export type IndexingOptions = NonNullable<
  aisearch.CreateInstanceRequest["indexingOptions"]
>;

/**
 * Custom metadata fields extracted at indexing time.
 */
export type CustomMetadata = NonNullable<
  aisearch.CreateInstanceRequest["customMetadata"]
>;

/**
 * Retrieval-time options (boosting and keyword match mode).
 */
export type RetrievalOptions = NonNullable<
  aisearch.CreateInstanceRequest["retrievalOptions"]
>;

/**
 * Public REST endpoint configuration for the instance.
 */
export type PublicEndpointParams = NonNullable<
  aisearch.CreateInstanceRequest["publicEndpointParams"]
>;

/**
 * Similarity-cache threshold preset.
 */
export type CacheThreshold =
  | "super_strict_match"
  | "close_enough"
  | "flexible_friend"
  | "anything_goes";

export type SearchInstanceProps = {
  /**
   * SearchInstance identifier (the AI Search "name" shown in the dashboard).
   * Lowercase alphanumeric, hyphens, and underscores. If omitted, a unique
   * id is generated from the app, stage, and logical ID. Changing it
   * triggers a replacement.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  instanceId?: string;
  /**
   * Namespace this instance belongs to. AI Search instances are
   * namespace-scoped; omitting this places the instance in the
   * account-provided `default` namespace. Pass a `SearchNamespace`'s
   * `name` output to group instances under a custom namespace (which also
   * orders this instance after that namespace on deploy and before it on
   * destroy). The namespace is immutable — changing it triggers a
   * replacement.
   * @default "default"
   */
  namespace?: string;
  /**
   * Data source kind: `r2` indexes objects in an R2 bucket, `web-crawler`
   * crawls a seed URL. Changing it triggers a replacement.
   * @default "r2"
   */
  type?: SearchInstanceSourceType;
  /**
   * Data source: the R2 bucket name (for `type: "r2"`) or the crawl seed
   * URL (for `type: "web-crawler"`). Changing it triggers a replacement —
   * the index must be rebuilt from scratch.
   */
  source: string;
  /**
   * Source-specific indexing parameters (R2 prefix / include / exclude
   * filters, web-crawler crawl and parse options).
   */
  sourceParams?: SourceParams;
  /**
   * Id of the AI Search service token used to access the data source on
   * sync. When omitted, Cloudflare provisions one automatically.
   */
  tokenId?: string;
  /**
   * AI Gateway to route model inference calls through.
   */
  aiGatewayId?: string;
  /**
   * Embedding model used to vectorize content. Cannot be changed after
   * creation — updating this property triggers a replacement.
   * @default service default
   */
  embeddingModel?: EmbeddingModel;
  /**
   * Generation model used to answer AI Search queries.
   * @default service default
   */
  aiSearchModel?: Model;
  /**
   * Whether to rewrite the user query before retrieval.
   * @default false
   */
  rewriteQuery?: boolean;
  /**
   * Model used to rewrite queries when `rewriteQuery` is enabled.
   */
  rewriteModel?: Model;
  /**
   * Whether custom chunking settings are applied during indexing.
   */
  chunk?: boolean;
  /**
   * Chunk size (in tokens) used when splitting documents for indexing.
   * Only affects future indexing runs.
   */
  chunkSize?: number;
  /**
   * Overlap between consecutive chunks, as a percentage (0–30). Only
   * affects future indexing runs.
   */
  chunkOverlap?: number;
  /**
   * Controls which storage backends are used during indexing. Defaults to
   * vector-only.
   */
  indexMethod?: IndexMethod;
  /**
   * Keyword indexing options (tokenizer selection).
   */
  indexingOptions?: IndexingOptions;
  /**
   * Custom metadata fields extracted at indexing time.
   */
  customMetadata?: CustomMetadata;
  /**
   * Whether the similarity cache is enabled.
   * @default false
   */
  cache?: boolean;
  /**
   * Similarity-cache match strictness preset.
   */
  cacheThreshold?: CacheThreshold;
  /**
   * Cache entry TTL in seconds. Allowed values: 600, 1800, 3600, 7200,
   * 21600, 43200, 86400, 172800, 259200, 518400.
   */
  cacheTtl?: number;
  /**
   * Whether retrieved results are reranked before generation.
   * @default false
   */
  reranking?: boolean;
  /**
   * Model used for reranking when `reranking` is enabled.
   */
  rerankingModel?: RerankingModel;
  /**
   * Retrieval-time options (boosting and keyword match mode).
   */
  retrievalOptions?: RetrievalOptions;
  /**
   * How vector and keyword results are fused: `max` or `rrf`
   * (reciprocal rank fusion).
   */
  fusionMethod?: "max" | "rrf";
  /**
   * Maximum number of results returned by retrieval.
   */
  maxNumResults?: number;
  /**
   * Minimum similarity score for a result to be returned.
   */
  scoreThreshold?: number;
  /**
   * Public REST endpoint configuration (search / chat-completions / MCP).
   */
  publicEndpointParams?: PublicEndpointParams;
  /**
   * Interval between automatic syncs, in seconds. Allowed values: 900,
   * 1800, 3600, 7200, 14400, 21600, 43200, 86400.
   */
  syncInterval?: number;
  /**
   * Kick off an initial indexing job right after the instance is first
   * created, instead of waiting for the first scheduled sync. The job is
   * triggered best-effort and not awaited — the deploy does not block on
   * indexing, which can take much longer than a provisioning step should.
   * Has no effect on updates or when no `source` is configured.
   * @default false
   */
  indexOnCreate?: boolean;
};

export type SearchInstanceAttributes = {
  /**
   * AI Search instance id. Lowercase alphanumeric, hyphens, underscores.
   */
  instanceId: string;
  /**
   * The Cloudflare account the instance belongs to.
   */
  accountId: string;
  /**
   * Namespace the instance belongs to (`default` when unspecified).
   */
  namespace: string;
  /**
   * Data source kind (`r2` or `web-crawler`).
   */
  type: SearchInstanceSourceType;
  /**
   * Data source (R2 bucket name or crawl seed URL).
   */
  source: string | undefined;
  /**
   * Id of the AI Search service token used to access the data source.
   */
  tokenId: string | undefined;
  /**
   * AI Gateway inference calls are routed through.
   */
  aiGatewayId: string | undefined;
  /**
   * Embedding model used to vectorize content.
   */
  embeddingModel: string | undefined;
  /**
   * Generation model used to answer queries.
   */
  aiSearchModel: string | undefined;
  /**
   * Current instance status (indexing is asynchronous).
   */
  status: string | undefined;
  /**
   * Whether the instance is paused.
   */
  paused: boolean | undefined;
  /**
   * Id of the public REST endpoint, when enabled.
   */
  publicEndpointId: string | undefined;
  /**
   * When the instance was created.
   */
  createdAt: string | undefined;
  /**
   * When the instance was last modified.
   */
  modifiedAt: string | undefined;
};

export type SearchInstance = Resource<
  TypeId,
  SearchInstanceProps,
  SearchInstanceAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare.AI. Search (formerly AutoRAG) instance — a fully managed
 * retrieval-augmented generation pipeline over your own data.
 *
 * An instance continuously indexes a data source (an R2 bucket or a web
 * crawl), embeds it into a managed Vectorize index, and answers search and
 * chat queries against it. Creation returns immediately; the initial
 * indexing run happens asynchronously.
 *
 * The instance `instanceId`, `namespace`, `type`, `source`, and
 * `embeddingModel` are fixed at creation — changing any of them triggers a
 * replacement. Everything else (models, chunking, caching, reranking,
 * public endpoint, sync interval) is mutable in place.
 *
 * For the common R2 case, prefer the {@link Search} construct, which also
 * mints the service token the indexer needs to read your bucket. Use this
 * low-level resource directly when you manage the token yourself, share one
 * token across instances, or group instances under a {@link SearchNamespace}.
 *
 * @resource
 * @product AI Search
 * @category AI
 * @section Creating a SearchInstance
 * @example R2-backed instance
 * An R2 source needs a service token to read the bucket. Either pass a
 * `tokenId` (see {@link SearchToken}) or let the {@link Search}
 * construct provision one for you.
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("docs", {});
 * const instance = yield* Cloudflare.AI.SearchInstance("docs-search", {
 *   source: bucket.bucketName,
 *   tokenId: serviceToken.id,
 * });
 * ```
 *
 * @example Tuned retrieval settings
 * ```typescript
 * const instance = yield* Cloudflare.AI.SearchInstance("docs-search", {
 *   source: bucket.bucketName,
 *   aiSearchModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *   chunkSize: 512,
 *   chunkOverlap: 64,
 *   maxNumResults: 20,
 *   cache: true,
 *   cacheThreshold: "close_enough",
 * });
 * ```
 *
 * @section R2 source options
 * For an `r2` source, `sourceParams` filters which objects are indexed (all
 * fields optional):
 * - `prefix` — only index keys under this prefix.
 * - `includeItems` / `excludeItems` — micromatch glob patterns (`*` within a
 *   path segment, `**` across segments; max 10 each). Only objects matching an
 *   `includeItems` pattern are indexed; `excludeItems` takes precedence.
 * - `r2Jurisdiction` — R2 data-residency jurisdiction of the source bucket.
 * @example Index only part of a bucket
 * ```typescript
 * const instance = yield* Cloudflare.AI.SearchInstance("docs-search", {
 *   source: bucket.bucketName,
 *   tokenId: serviceToken.id,
 *   sourceParams: {
 *     prefix: "docs/",
 *     includeItems: ["/docs/**"],
 *     excludeItems: ["/docs/drafts/**"],
 *   },
 * });
 * ```
 *
 * @section Web-crawler source options
 * `sourceParams.webCrawler` tunes how a `web-crawler` source is fetched,
 * parsed, and stored. All fields are optional.
 *
 * `parseType` selects how pages are discovered:
 * - `"sitemap"` (Cloudflare default) — read `<seed>/sitemap.xml` (discovered
 *   via `robots.txt`) and index the URLs it lists.
 * - `"crawl"` — start at `source` and follow links.
 * - `"feed-rss"` — treat the seed as an RSS / Atom feed.
 *
 * `crawlOptions` controls link discovery (mainly for `parseType: "crawl"`):
 * - `depth` — how many links deep to follow from the seed.
 * - `includeSubdomains` — also crawl subdomains of the seed host.
 * - `includeExternalLinks` — follow links off the seed host.
 * - `maxAge` — skip re-fetching pages younger than this (seconds).
 * - `source` — where links come from: `"all"`, `"sitemaps"`, or `"links"`.
 *
 * `parseOptions` controls how each page is parsed:
 * - `useBrowserRendering` — render JS in a headless browser before parsing.
 * - `includeImages` — index image content.
 * - `specificSitemaps` — explicit sitemap URLs to read (for `"sitemap"`).
 * - `contentSelector` — `{ path, selector }[]` CSS selectors scoping which
 *   part of a page is indexed per URL path.
 * - `includeHeaders` — extra request headers sent while crawling.
 *
 * `storeOptions` overrides where crawled content is stored — Cloudflare
 * provisions managed storage by default:
 * - `storageId` — R2 bucket name to store crawl output in.
 * - `storageType` — `"r2"`.
 * - `r2Jurisdiction` — R2 data-residency jurisdiction for the store bucket.
 * @example Basic web-crawler instance
 * ```typescript
 * const instance = yield* Cloudflare.AI.SearchInstance("site-search", {
 *   type: "web-crawler",
 *   source: "https://example.com",
 *   sourceParams: { webCrawler: { parseType: "crawl" } },
 * });
 * ```
 * @example Fully-configured crawl
 * ```typescript
 * const instance = yield* Cloudflare.AI.SearchInstance("site-search", {
 *   type: "web-crawler",
 *   source: "https://example.com",
 *   sourceParams: {
 *     webCrawler: {
 *       parseType: "crawl",
 *       crawlOptions: {
 *         depth: 3,
 *         includeSubdomains: true,
 *         includeExternalLinks: false,
 *         maxAge: 86_400,
 *         source: "all",
 *       },
 *       parseOptions: {
 *         useBrowserRendering: true,
 *         includeImages: false,
 *         contentSelector: [{ path: "/docs", selector: "main" }],
 *       },
 *     },
 *   },
 * });
 * ```
 * @example Sitemap and RSS sources
 * ```typescript
 * // Index the URLs listed in one or more sitemaps (the default parse mode).
 * const fromSitemap = yield* Cloudflare.AI.SearchInstance("sitemap-search", {
 *   type: "web-crawler",
 *   source: "https://example.com",
 *   sourceParams: {
 *     webCrawler: {
 *       parseType: "sitemap",
 *       parseOptions: { specificSitemaps: ["https://example.com/sitemap.xml"] },
 *     },
 *   },
 * });
 *
 * // Treat the seed as an RSS / Atom feed.
 * const fromFeed = yield* Cloudflare.AI.SearchInstance("feed-search", {
 *   type: "web-crawler",
 *   source: "https://example.com/feed.xml",
 *   sourceParams: { webCrawler: { parseType: "feed-rss" } },
 * });
 * ```
 * @example Store crawl output in a specific R2 bucket
 * ```typescript
 * const instance = yield* Cloudflare.AI.SearchInstance("site-search", {
 *   type: "web-crawler",
 *   source: "https://example.com",
 *   sourceParams: {
 *     webCrawler: {
 *       parseType: "crawl",
 *       storeOptions: { storageId: "my-crawl-bucket", storageType: "r2" },
 *     },
 *   },
 * });
 * ```
 *
 * @section Grouping under a namespace
 * SearchInstances live in a namespace (the account-provided `default` when
 * unspecified). Pass a {@link SearchNamespace}'s `name` to group related
 * instances — the engine then orders this instance after the namespace on
 * deploy. The namespace is immutable; changing it replaces the instance.
 * @example Place the instance in a custom namespace
 * ```typescript
 * const ns = yield* Cloudflare.AI.SearchNamespace("docs-ns", {});
 * const instance = yield* Cloudflare.AI.SearchInstance("docs-search", {
 *   source: bucket.bucketName,
 *   namespace: ns.name,
 * });
 * ```
 *
 * @section Binding to an Effect Worker
 * Bind the instance during the Worker's init phase with
 * `Cloudflare.AI.QuerySearch(instance)`, which attaches the
 * single-instance `ai_search` binding and returns an Effect-native client
 * whose `search` / `chatCompletions` methods return `Effect`s. Provide
 * {@link QuerySearchBinding} in the Worker's runtime layer.
 * @example Effect Worker that answers from AI Search
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const bucket = yield* Cloudflare.R2.Bucket("docs", {});
 *     const instance = yield* Cloudflare.AI.SearchInstance("docs-search", {
 *       source: bucket.bucketName,
 *     });
 *     const search = yield* Cloudflare.AI.QuerySearch(instance);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const query = new URL(request.url).searchParams.get("q") ?? "";
 *         const answer = yield* search.chatCompletions({
 *           messages: [{ role: "user", content: query }],
 *         });
 *         return yield* HttpServerResponse.json(answer);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.AI.QuerySearchBinding)),
 * ) {}
 * ```
 *
 * @section Binding to an Async Worker
 * For a vanilla `async fetch` Worker, pass the instance under `Worker.env`.
 * The engine attaches the same `ai_search` binding and `InferEnv` types
 * `env.SEARCH` as the runtime `SearchInstance` handle.
 * @example Async Worker via `env`
 * ```typescript
 * export const Api = Cloudflare.Worker("api", {
 *   main: "./worker.ts",
 *   env: { SEARCH: search },
 * });
 * export type ApiEnv = Cloudflare.InferEnv<typeof Api>;
 *
 * // worker.ts
 * export default {
 *   async fetch(request: Request, env: ApiEnv): Promise<Response> {
 *     const query = new URL(request.url).searchParams.get("q") ?? "";
 *     return Response.json(
 *       await env.SEARCH.chatCompletions({
 *         messages: [{ role: "user", content: query }],
 *       }),
 *     );
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/ai-search/
 */
export const SearchInstance = Resource<SearchInstance>(TypeId, {
  aliases: ["Cloudflare.AiSearch.Instance"],
});

/**
 * Returns true if the given value is a SearchInstance resource.
 */
export const isSearchInstance = (value: unknown): value is SearchInstance =>
  isResourceOfType(value, TypeId);

export const SearchInstanceProvider = () =>
  Provider.succeed(SearchInstance, {
    stables: [
      "instanceId",
      "accountId",
      "namespace",
      "type",
      "embeddingModel",
      "createdAt",
    ],
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The namespace is immutable on the Cloudflare side (it is the API
      // path) — moving an instance between namespaces is a replacement. The
      // new instance lives at a different path, so create-before-delete is
      // always safe here regardless of whether the id is pinned.
      const newNamespace = resolveNamespace(news.namespace);
      const oldNamespace = resolveNamespace(
        output?.namespace ?? olds.namespace,
      );
      if (newNamespace !== oldNamespace) {
        return { action: "replace" } as const;
      }
      // The instance id is its identity — renaming is a replacement.
      const oldId =
        output?.instanceId ?? (yield* createInstanceId(id, olds.instanceId));
      // Auto-generated ids are engine-owned: the deployed id stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided instanceId can force a replace.
      const newId = news.instanceId ?? oldId;
      if (newId !== oldId) {
        return { action: "replace" } as const;
      }
      // When the user pinned an explicit `instanceId`, the replacement's
      // create would collide with the still-existing old instance — the
      // old one must be deleted first. Generated ids get a fresh suffix
      // from the new SearchInstance ID, so create-before-delete is safe there.
      const replace = {
        action: "replace",
        deleteFirst: news.instanceId !== undefined || undefined,
      } as const;
      // The data-source kind and location are fixed at creation; changing
      // either requires re-indexing from scratch (a replacement).
      if ((news.type ?? "r2") !== (output?.type ?? olds.type ?? "r2")) {
        return replace;
      }
      const oldSource = output?.source ?? olds.source;
      if (oldSource !== undefined && news.source !== oldSource) {
        return replace;
      }
      // The embedding model defines the vector space and is immutable.
      const oldEmbedding =
        normalize(output?.embeddingModel) ?? olds.embeddingModel;
      if (
        news.embeddingModel !== undefined &&
        oldEmbedding !== undefined &&
        news.embeddingModel !== oldEmbedding
      ) {
        return replace;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const namespace = resolveNamespace(output?.namespace ?? olds?.namespace);
      // The id is deterministic (explicit prop or generated from the
      // logical id + instance id), so a cold read (lost state) resolves
      // the same identifier as the original create did.
      const instanceId =
        output?.instanceId ?? (yield* createInstanceId(id, olds?.instanceId));
      const observed = yield* getInstance(acct, namespace, instanceId);
      return observed ? toAttributes(observed, acct, namespace) : undefined;
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // SearchInstances are namespace-scoped, so enumerate every namespace
      // (always including the account-provided `default`) and fan out a
      // paginated instance list per namespace.
      const namespaces = yield* aisearch.listNamespaces
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((ns) => ns.name),
            ),
          ),
        );
      const allNamespaces = Array.from(new Set(["default", ...namespaces]));
      const rows = yield* Effect.forEach(
        allNamespaces,
        (namespace) =>
          aisearch.listNamespaceInstances
            .pages({ accountId, name: namespace })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? []).map((instance) =>
                    toAttributes(instance, accountId, namespace),
                  ),
                ),
              ),
              // A namespace deleted between list and fan-out is simply empty.
              Effect.catchTag("NamespaceNotFound", () => Effect.succeed([])),
            ),
        { concurrency: 5 },
      );
      return rows.flat();
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const namespace = resolveNamespace(news.namespace);
      const instanceId =
        output?.instanceId ?? (yield* createInstanceId(id, news.instanceId));

      // Observe — `output.instanceId` is a cache, not a guarantee: a NotFound
      // falls through to "missing" and we recreate.
      let observed = yield* getInstance(acct, namespace, instanceId);

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete): create with the
        // full desired body. If Cloudflare rejects the request because
        // the instance already exists (a race), fall through to the
        // sync path against the observed instance.
        const ensured = yield* aisearch
          .createNamespaceInstance({
            accountId: acct,
            name: namespace,
            id: instanceId,
            type: news.type ?? "r2",
            ...toMutableBody(news),
          })
          .pipe(
            retryTokenPropagation,
            Effect.map((created) => ({
              created: true as const,
              instance: created as ObservedInstance,
            })),
            Effect.catchTag("InstanceAlreadyExists", (originalError) =>
              Effect.gen(function* () {
                const existing = yield* getInstance(
                  acct,
                  namespace,
                  instanceId,
                );
                if (!existing) return yield* Effect.fail(originalError);
                return { created: false as const, instance: existing };
              }),
            ),
          );
        if (ensured.created) {
          // Optionally kick off the initial index instead of waiting for
          // the first scheduled sync. Best-effort and NOT awaited for
          // completion — the deploy must not block on indexing (the
          // scheduled sync is the backstop if this transiently fails).
          if ((news.indexOnCreate ?? false) && news.source !== undefined) {
            yield* aisearch
              .createNamespaceInstanceJob({
                accountId: acct,
                name: namespace,
                id: instanceId,
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    "AI Search initial index job failed to start; the scheduled sync will index instead.",
                    error,
                  ),
                ),
              );
          }
          // Indexing itself starts asynchronously; we deliberately do NOT
          // wait for the first sync to finish.
          return toAttributes(ensured.instance, acct, namespace);
        }
        observed = ensured.instance;
      }

      // Sync — diff observed cloud state against the desired mutable
      // config; skip the PUT entirely on a no-op. Only fields the user
      // actually set participate in the diff; for the rest the observed
      // value is preserved in the full PUT body.
      const desired = toMutableBody(news);
      const observedRecord = observed as unknown as Record<string, unknown>;
      const dirty = Object.entries(desired).some(
        ([key, value]) =>
          // Cloudflare's read projection always returns `tokenId: null`
          // (the association is write-only), so it can never be diffed
          // against desired — excluding it avoids perpetual false drift.
          // It still rides along in the create body and in any update PUT
          // triggered by other fields.
          key !== "tokenId" &&
          value !== undefined &&
          !deepEqual(normalize(observedRecord[key]), normalize(value), {
            stripNullish: true,
          }),
      );
      if (!dirty) {
        return toAttributes(observed, acct, namespace);
      }

      const updated = yield* aisearch
        .updateNamespaceInstance({
          accountId: acct,
          name: namespace,
          id: instanceId,
          ...preserveObserved(observed),
          ...defined(desired),
        })
        .pipe(retryTokenPropagation);
      return toAttributes(updated, acct, namespace);
    }),
    delete: Effect.fn(function* ({ output }) {
      // The managed Vectorize index is torn down asynchronously; a missing
      // instance or namespace (already deleted) is success.
      yield* aisearch
        .deleteNamespaceInstance({
          accountId: output.accountId,
          name: output.namespace,
          id: output.instanceId,
        })
        .pipe(
          Effect.catchTag(
            ["AiSearchInstanceNotFound", "NamespaceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });

/**
 * Ride out the two eventual-consistency windows Cloudflare opens when an
 * instance's source is (re)validated at create/update time:
 *
 *   - `InvalidTokenCredentials` (code 7012, message
 *     `ai_search_instance_invalid_token`): on a greenfield create Cloudflare
 *     auto-provisions an R2 service token for the instance to read its source
 *     bucket, and validates it eventually-consistently.
 *   - `MissingSitemap` (400, message `missing_sitemap`): a `web-crawler`
 *     source is fetched synchronously at validation time. A freshly-deployed
 *     seed (e.g. a brand-new `workers.dev` URL) is reachable from the test's
 *     own vantage well before Cloudflare's crawler infrastructure can fetch
 *     it, so the first validation can spuriously report no content.
 *
 * Both settle within a bounded window; a genuinely invalid token or
 * unreachable/empty seed still fails once the retries are exhausted.
 */
const retryTokenPropagation = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) =>
        e._tag === "InvalidTokenCredentials" || e._tag === "MissingSitemap",
      // A full-body update PUT re-sends `source`, which makes Cloudflare
      // re-validate the (write-only, auto-provisioned) R2 service token and
      // re-fetch a web-crawler seed — opening a fresh propagation window each
      // time. The window stretches under full-suite parallel load (token
      // propagation across the edge contends with every other test's calls),
      // so the budget is generous (~2 min). Crucially the per-attempt delay is
      // *capped* at 6s (`either` takes the min of the two schedules): an
      // uncapped exponential balloons to ~38s gaps by attempt 10, so it polls
      // sparsely and detects a settled token tens of seconds late. Capped
      // polling detects within 6s of propagation completing while still
      // covering a long total window.
      schedule: Schedule.min([
        Schedule.exponential("1 second", 1.5),
        Schedule.spaced("6 seconds"),
      ]),
      times: 22,
    }),
  );

type ObservedInstance = aisearch.ReadNamespaceInstanceResponse;

/**
 * Resolve the namespace name an instance lives in, defaulting to the
 * account-provided `default` namespace.
 */
const resolveNamespace = (namespace: string | undefined): string =>
  namespace ?? "default";

/**
 * Read an instance by id within its namespace, mapping "gone" to
 * `undefined` — either the instance is missing (`AiSearchInstanceNotFound`,
 * code 7002) or its whole namespace is (`NamespaceNotFound`, code 7063).
 */
const getInstance = (accountId: string, namespace: string, id: string) =>
  aisearch
    .readNamespaceInstance({ accountId, name: namespace, id })
    .pipe(
      Effect.catchTag(["AiSearchInstanceNotFound", "NamespaceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const createInstanceId = (id: string, instanceId: string | undefined) =>
  Effect.gen(function* () {
    return instanceId ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

/**
 * Cloudflare returns `null` (and sometimes `""` for model enums) for
 * unconfigured optional fields; desired-state shapes leave them
 * `undefined`. Collapse both to `undefined` for diffing.
 */
const normalize = <T>(value: T | "" | null | undefined): T | undefined =>
  value === "" || value == null ? undefined : value;

type MutableBody = ReturnType<typeof toMutableBody>;

/**
 * The mutable slice of the desired state, shaped for the create/update
 * request bodies. Immutable props (`id`, `type`) are handled separately.
 */
const toMutableBody = (news: SearchInstanceProps) => ({
  source: news.source as string,
  sourceParams: news.sourceParams,
  tokenId: news.tokenId as string | undefined,
  aiGatewayId: news.aiGatewayId as string | undefined,
  embeddingModel: news.embeddingModel,
  aiSearchModel: news.aiSearchModel,
  rewriteQuery: news.rewriteQuery,
  rewriteModel: news.rewriteModel,
  chunk: news.chunk,
  chunkSize: news.chunkSize,
  chunkOverlap: news.chunkOverlap,
  indexMethod: news.indexMethod,
  indexingOptions: news.indexingOptions,
  customMetadata: news.customMetadata,
  cache: news.cache,
  cacheThreshold: news.cacheThreshold,
  cacheTtl: news.cacheTtl,
  reranking: news.reranking,
  rerankingModel: news.rerankingModel,
  retrievalOptions: news.retrievalOptions,
  fusionMethod: news.fusionMethod,
  maxNumResults: news.maxNumResults,
  scoreThreshold: news.scoreThreshold,
  publicEndpointParams: news.publicEndpointParams,
  syncInterval: news.syncInterval,
});

/**
 * The update API is a PUT — fields the user did not set are preserved by
 * sending the observed values back. Observed `null`s are omitted (the
 * field was never configured).
 */
const preserveObserved = (observed: ObservedInstance) =>
  defined({
    source: normalize(observed.source),
    sourceParams: normalize(observed.sourceParams),
    tokenId: normalize(observed.tokenId),
    aiGatewayId: normalize(observed.aiGatewayId),
    embeddingModel: normalize(observed.embeddingModel),
    aiSearchModel: normalize(observed.aiSearchModel),
    rewriteQuery: normalize(observed.rewriteQuery),
    rewriteModel: normalize(observed.rewriteModel),
    chunkSize: normalize(observed.chunkSize),
    chunkOverlap: normalize(observed.chunkOverlap),
    indexMethod: normalize(observed.indexMethod),
    indexingOptions: normalize(observed.indexingOptions),
    customMetadata: normalize(observed.customMetadata),
    cache: normalize(observed.cache),
    cacheThreshold: normalize(observed.cacheThreshold),
    cacheTtl: normalize(observed.cacheTtl),
    reranking: normalize(observed.reranking),
    rerankingModel: normalize(observed.rerankingModel),
    retrievalOptions: normalize(observed.retrievalOptions),
    fusionMethod: normalize(observed.fusionMethod),
    maxNumResults: normalize(observed.maxNumResults),
    scoreThreshold: normalize(observed.scoreThreshold),
    publicEndpointParams: normalize(observed.publicEndpointParams),
    syncInterval: normalize(observed.syncInterval),
  }) as Partial<MutableBody>;

/** Strip `undefined` entries so they don't override spread order. */
const defined = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;

/**
 * The instance fields `read` projects, common to the create / read /
 * update / list-item response shapes (all optional but `id`). Decoupling
 * from the exact distilled response unions lets the namespace-scoped list
 * items — which carry a reduced field set — flow through unchanged.
 */
type SearchInstanceLike = {
  id: string;
  type?: string | null;
  source?: string | null;
  tokenId?: string | null;
  aiGatewayId?: string | null;
  embeddingModel?: string | null;
  aiSearchModel?: string | null;
  status?: string | null;
  paused?: boolean | null;
  publicEndpointId?: string | null;
  createdAt?: string | null;
  modifiedAt?: string | null;
};

const toAttributes = (
  instance: SearchInstanceLike,
  accountId: string,
  namespace: string,
): SearchInstanceAttributes => ({
  instanceId: instance.id,
  accountId,
  namespace,
  // Distilled widens generated string enums to open unions.
  type: (normalize(instance.type) ?? "r2") as SearchInstanceSourceType,
  source: normalize(instance.source),
  tokenId: normalize(instance.tokenId),
  aiGatewayId: normalize(instance.aiGatewayId),
  embeddingModel: normalize(instance.embeddingModel),
  aiSearchModel: normalize(instance.aiSearchModel),
  status: normalize(instance.status),
  paused: instance.paused ?? undefined,
  publicEndpointId: normalize(instance.publicEndpointId),
  createdAt: normalize(instance.createdAt),
  modifiedAt: normalize(instance.modifiedAt),
});

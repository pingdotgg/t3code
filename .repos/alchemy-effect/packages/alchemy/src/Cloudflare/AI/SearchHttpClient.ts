import type * as runtime from "@cloudflare/workers-types";
import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Credentials } from "../Credentials.ts";
import { SearchError, type QuerySearchClient } from "./QuerySearch.ts";
import type { QuerySearchNamespaceClient } from "./QuerySearchNamespace.ts";

// Shared HTTP scaffolding for the AI Search `*Local` binding layers. NOT
// re-exported from `index.ts` — only the per-level `*Local` layers are public.
//
// The `ai_search` / `ai_search_namespace` Worker bindings proxy the same AI
// Search REST API that distilled wraps, so the whole data plane
// (`search` / `chatCompletions` / `info` / `stats` / `list`) is reachable over
// HTTP with the current credentials — no Worker host, no native binding.
//
// The one wrinkle: distilled decodes responses to **camelCase**, while the
// binding client contract types come from `@cloudflare/workers-types` and are
// the **snake_case** wire shape. These adapters translate both directions
// (mirroring the D1 `*Local` shim), passing user-controlled maps
// (`item.metadata`, retrieval `filters`) through untouched.

/**
 * Injectable auth shared by a future Http (scoped-token) impl and the Local
 * (current-credentials) impl. `authorize` discharges the
 * `Credentials | HttpClient` requirement of a distilled op; `accountId` is the
 * Cloudflare account the ops run against.
 */
export interface SearchAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E>;
  accountId: string;
}

const u = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const run = <A, E>(
  auth: SearchAuth,
  eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
): Effect.Effect<A, SearchError, RuntimeContext> =>
  auth.authorize(eff).pipe(
    Effect.mapError((cause) => {
      const message =
        cause instanceof Error
          ? cause.message
          : typeof (cause as { message?: unknown } | undefined)?.message ===
              "string"
            ? (cause as { message: string }).message
            : "AI Search HTTP error";
      return new SearchError({ message, cause });
    }),
  );

// ── response mappers (distilled camelCase -> runtime snake_case) ─────────────

type ChunkIn = aisearch.SearchNamespaceInstanceResponse["chunks"][number];

const mapChunk = (
  c: ChunkIn,
): runtime.AiSearchSearchResponse["chunks"][number] => ({
  id: c.id,
  type: c.type,
  score: c.score,
  text: c.text,
  item: {
    key: c.item?.key ?? "",
    timestamp: u(c.item?.timestamp),
    metadata: u(c.item?.metadata) as Record<string, unknown> | undefined,
  },
  scoring_details: c.scoringDetails
    ? {
        keyword_score: u(c.scoringDetails.keywordScore),
        vector_score: u(c.scoringDetails.vectorScore),
        keyword_rank: u(c.scoringDetails.keywordRank),
        vector_rank: u(c.scoringDetails.vectorRank),
        reranking_score: u(c.scoringDetails.rerankingScore),
        fusion_method: u(c.scoringDetails.fusionMethod) as
          | "rrf"
          | "max"
          | undefined,
      }
    : undefined,
});

const mapSearch = (
  r: aisearch.SearchNamespaceInstanceResponse,
): runtime.AiSearchSearchResponse => ({
  search_query: r.searchQuery ?? "",
  chunks: r.chunks.map(mapChunk),
});

const mapChat = (
  r: aisearch.ChatCompletionsNamespaceInstanceResponse,
): runtime.AiSearchChatCompletionsResponse => ({
  id: u(r.id),
  object: u(r.object),
  model: u(r.model),
  choices: r.choices.map((choice) => ({
    index: u(choice.index),
    message: {
      role: choice.message.role as
        | "system"
        | "developer"
        | "user"
        | "assistant"
        | "tool",
      content:
        typeof choice.message.content === "string"
          ? choice.message.content
          : choice.message.content == null
            ? null
            : JSON.stringify(choice.message.content),
    },
  })),
  chunks: r.chunks.map(mapChunk),
});

const mapStats = (
  r: aisearch.StatsNamespaceInstanceResponse,
): runtime.AiSearchStatsResponse => ({
  queued: u(r.queued),
  running: u(r.running),
  completed: u(r.completed),
  error: u(r.error),
  skipped: u(r.skipped),
  outdated: u(r.outdated),
  last_activity: u(r.lastActivity),
  engine: r.engine
    ? {
        vectorize: r.engine.vectorize
          ? {
              vectorsCount: r.engine.vectorize.vectorsCount,
              dimensions: r.engine.vectorize.dimensions,
            }
          : undefined,
        r2: r.engine.r2
          ? {
              payloadSizeBytes: r.engine.r2.payloadSizeBytes,
              metadataSizeBytes: r.engine.r2.metadataSizeBytes,
              objectCount: r.engine.r2.objectCount,
            }
          : undefined,
      }
    : undefined,
});

const mapInfo = (
  r: aisearch.ReadNamespaceInstanceResponse,
): runtime.AiSearchInstanceInfo => ({
  id: r.id,
  type: u(r.type) as runtime.AiSearchInstanceInfo["type"],
  source: u(r.source),
  source_params: u(r.sourceParams),
  paused: u(r.paused),
  status: u(r.status),
  namespace: u(r.namespace),
  created_at: u(r.createdAt),
  modified_at: u(r.modifiedAt),
  token_id: u(r.tokenId),
  ai_gateway_id: u(r.aiGatewayId),
  rewrite_query: u(r.rewriteQuery),
  reranking: u(r.reranking),
  embedding_model: u(r.embeddingModel),
  ai_search_model: u(r.aiSearchModel),
  rewrite_model: u(r.rewriteModel),
  reranking_model: u(r.rerankingModel),
  hybrid_search_enabled: u(r.hybridSearchEnabled),
  index_method: r.indexMethod
    ? { vector: r.indexMethod.vector, keyword: r.indexMethod.keyword }
    : undefined,
  fusion_method: u(r.fusionMethod) as "max" | "rrf" | undefined,
  indexing_options: r.indexingOptions
    ? {
        keyword_tokenizer: u(r.indexingOptions.keywordTokenizer) as
          | "porter"
          | "trigram"
          | undefined,
      }
    : undefined,
  retrieval_options: r.retrievalOptions
    ? {
        keyword_match_mode: u(r.retrievalOptions.keywordMatchMode) as
          | "and"
          | "or"
          | undefined,
        boost_by: u(r.retrievalOptions.boostBy)?.map((b) => ({
          field: b.field,
          direction: u(b.direction) as
            | "asc"
            | "desc"
            | "exists"
            | "not_exists"
            | undefined,
        })),
      }
    : undefined,
  chunk_size: u(r.chunkSize),
  chunk_overlap: u(r.chunkOverlap),
  score_threshold: u(r.scoreThreshold),
  max_num_results: u(r.maxNumResults),
  cache: u(r.cache),
  cache_threshold: u(
    r.cacheThreshold,
  ) as runtime.AiSearchInstanceInfo["cache_threshold"],
  custom_metadata: u(r.customMetadata)?.map((m) => ({
    field_name: m.fieldName,
    data_type: m.dataType as "text" | "number" | "boolean" | "datetime",
  })),
  sync_interval: u(
    r.syncInterval,
  ) as runtime.AiSearchInstanceInfo["sync_interval"],
  metadata: u(r.metadata) as Record<string, unknown> | undefined,
});

const mapList = (
  result: aisearch.ReadNamespaceInstanceResponse[],
): runtime.AiSearchListResponse => ({
  result: result.map(mapInfo),
});

const mapMulti = (
  r: aisearch.SearchNamespaceResponse,
): runtime.AiSearchMultiSearchResponse => ({
  search_query: r.searchQuery ?? "",
  chunks: r.chunks.map((c) => ({ ...mapChunk(c), instance_id: c.instanceId })),
  errors: u(r.errors)?.map((e) => ({
    instance_id: e.instanceId,
    message: e.message,
  })),
});

// ── request mappers (runtime snake_case -> distilled camelCase) ──────────────

const mapMessages = (messages: runtime.AiSearchMessage[]) =>
  messages.map((m) => ({
    role: m.role as "system" | "developer" | "user" | "assistant" | "tool",
    content:
      typeof m.content === "string" || m.content == null
        ? m.content
        : (m.content as unknown[]).map((part) => {
            const p = part as Record<string, unknown>;
            if ("image_url" in p || "imageUrl" in p) {
              const img = (p.image_url ?? p.imageUrl) as { url: string };
              return { type: "image_url" as const, imageUrl: { url: img.url } };
            }
            return { type: "text" as const, text: p.text as string };
          }),
  }));

const mapOptions = (o: runtime.AiSearchOptions | undefined) => {
  if (!o) return undefined;
  return {
    cache: o.cache
      ? { enabled: o.cache.enabled, cacheThreshold: o.cache.cache_threshold }
      : undefined,
    queryRewrite: o.query_rewrite
      ? {
          enabled: o.query_rewrite.enabled,
          model: o.query_rewrite.model,
          rewritePrompt: o.query_rewrite.rewrite_prompt,
        }
      : undefined,
    reranking: o.reranking
      ? {
          enabled: o.reranking.enabled,
          model: o.reranking.model,
          matchThreshold: o.reranking.match_threshold,
        }
      : undefined,
    retrieval: o.retrieval
      ? {
          retrievalType: o.retrieval.retrieval_type,
          fusionMethod: o.retrieval.fusion_method,
          keywordMatchMode: o.retrieval.keyword_match_mode,
          matchThreshold: o.retrieval.match_threshold,
          maxNumResults: o.retrieval.max_num_results,
          contextExpansion: o.retrieval.context_expansion,
          returnOnFailure: o.retrieval.return_on_failure,
          // `filters` is a Vectorize metadata filter over user-defined fields —
          // pass through untouched.
          filters: o.retrieval.filters as Record<string, unknown> | undefined,
          boostBy: o.retrieval.boost_by,
        }
      : undefined,
  };
};

// ── client builders ──────────────────────────────────────────────────────────

/** Effect resolving `{ name (namespace), id (instanceId) }` at apply time. */
export type InstanceRef = Effect.Effect<{ name: string; id: string }>;

/** Effect resolving the namespace `name` at apply time. */
export type NamespaceRef = Effect.Effect<string>;

const dieRaw = (kind: string): Effect.Effect<never> =>
  Effect.die(
    new Error(
      `The AI Search ${kind} *Local binding runs over the HTTP API; the raw native runtime binding is only available inside a deployed Worker.`,
    ),
  );

/**
 * Build a single-instance {@link QuerySearchClient} over the HTTP API. `ref`
 * resolves the `{ namespace, instanceId }` at apply time.
 */
export const makeLocalSearchClient = (
  auth: SearchAuth,
  ref: InstanceRef,
): QuerySearchClient => {
  const withRef = <A, E>(
    fn: (r: {
      name: string;
      id: string;
    }) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.flatMap(ref, (r) => run(auth, fn(r)));

  return {
    raw: dieRaw("instance"),
    search: (params) =>
      withRef((r) =>
        aisearch.searchNamespaceInstance({
          accountId: auth.accountId,
          name: r.name,
          id: r.id,
          ...("query" in params && params.query !== undefined
            ? { query: params.query }
            : { messages: mapMessages(params.messages ?? []) }),
          aiSearchOptions: mapOptions(params.ai_search_options),
        } as aisearch.SearchNamespaceInstanceRequest),
      ).pipe(Effect.map(mapSearch)),
    chatCompletions: (params) =>
      withRef((r) =>
        aisearch.chatCompletionsNamespaceInstance({
          accountId: auth.accountId,
          name: r.name,
          id: r.id,
          messages: mapMessages(params.messages),
          aiSearchOptions: mapOptions(params.ai_search_options),
        } as aisearch.ChatCompletionsNamespaceInstanceRequest),
      ).pipe(Effect.map(mapChat)),
    info: () =>
      withRef((r) =>
        aisearch.readNamespaceInstance({
          accountId: auth.accountId,
          name: r.name,
          id: r.id,
        }),
      ).pipe(Effect.map(mapInfo)),
    stats: () =>
      withRef((r) =>
        aisearch.statsNamespaceInstance({
          accountId: auth.accountId,
          name: r.name,
          id: r.id,
        }),
      ).pipe(Effect.map(mapStats)),
  } satisfies QuerySearchClient;
};

/**
 * Build a namespace {@link QuerySearchNamespaceClient} over the HTTP API.
 * `.get(instanceName)` scopes a single-instance client to `(namespace,
 * instanceName)`.
 */
export const makeLocalSearchNamespaceClient = (
  auth: SearchAuth,
  ref: NamespaceRef,
): QuerySearchNamespaceClient => ({
  raw: dieRaw("namespace"),
  get: (instanceName) =>
    makeLocalSearchClient(
      auth,
      Effect.map(ref, (name) => ({ name, id: instanceName })),
    ),
  list: (params) =>
    Effect.flatMap(ref, (name) =>
      run(
        auth,
        Stream.runCollect(
          aisearch.listNamespaceInstances.pages({
            accountId: auth.accountId,
            name,
            perPage: params?.per_page,
            orderBy: params?.order_by,
            orderByDirection: params?.order_by_direction,
            search: params?.search,
          }),
        ),
      ),
    ).pipe(
      Effect.map((chunk) =>
        mapList(
          Array.from(chunk).flatMap(
            (page) =>
              (page.result ??
                []) as unknown as aisearch.ReadNamespaceInstanceResponse[],
          ),
        ),
      ),
    ),
  search: (params) =>
    Effect.flatMap(ref, (name) =>
      run(
        auth,
        aisearch.searchNamespace({
          accountId: auth.accountId,
          name,
          aiSearchOptions: {
            instanceIds: params.ai_search_options.instance_ids,
            ...mapOptions(params.ai_search_options),
          },
          ...("query" in params && params.query !== undefined
            ? { query: params.query }
            : { messages: mapMessages(params.messages ?? []) }),
        } as aisearch.SearchNamespaceRequest),
      ),
    ).pipe(Effect.map(mapMulti)),
});

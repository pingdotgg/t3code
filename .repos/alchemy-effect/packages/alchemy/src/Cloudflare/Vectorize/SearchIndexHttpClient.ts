import type * as runtime from "@cloudflare/workers-types";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { Credentials } from "../Credentials.ts";
import type { SearchIndexClient } from "./SearchIndex.ts";

// Shared HTTP scaffolding for the Vectorize `SearchIndex` binding. NOT
// re-exported from `index.ts` — only the contract and the impl layers are
// public. A future token-scoped `SearchIndexHttp` layer reuses this builder
// with an auth minted from an `AccountApiToken`; `SearchIndexLocal` builds the
// auth from the ambient current-credentials context.

/**
 * Injectable auth shared by the Local (current-credentials) impl and a future
 * Http (scoped-token) impl. `authorize` discharges the
 * `Credentials | HttpClient` requirement of a distilled op; `accountId` is the
 * Cloudflare account the ops run against.
 */
export interface SearchIndexAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E>;
  accountId: string;
}

/**
 * Build a {@link SearchIndexClient} over the Vectorize HTTP API.
 *
 * `indexName` is an Effect so the resolution stays deferred to each call —
 * inside an Action it resolves through the apply-time RuntimeContext. The
 * credentials are provided ONLY around the distilled op (via `auth.authorize`),
 * never around the name accessor, matching the D1 / KV Local variants. `orDie`
 * mirrors the native binding, whose client methods surface transport failures
 * as defects.
 *
 * Two methods have no Cloudflare HTTP equivalent and `Effect.die`:
 * - `raw` — there is no HTTP-backed `runtime.Vectorize` object to hand back.
 * - `queryById` — the HTTP query endpoint only accepts a raw vector, not an id.
 */
export const makeHttpSearchIndexClient = (
  auth: SearchIndexAuth,
  indexName: Effect.Effect<string>,
): SearchIndexClient => {
  const { accountId } = auth;
  const local = <A, E>(
    fn: (
      name: string,
    ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ): Effect.Effect<A> =>
    Effect.flatMap(indexName, (name) => auth.authorize(fn(name))).pipe(
      Effect.orDie,
    );

  return {
    raw: Effect.die(
      new Error(
        "SearchIndex over HTTP: `raw` is not available — use a native Worker binding (SearchIndexBinding) for direct access.",
      ),
    ),
    describe: () =>
      local((name) =>
        vectorize
          .infoIndex({ accountId, indexName: name })
          .pipe(Effect.map(toIndexInfo)),
      ),
    query: (vector, options) =>
      local((name) =>
        vectorize
          .queryIndex({
            accountId,
            indexName: name,
            vector: Array.from(vector),
            topK: options?.topK,
            returnValues: options?.returnValues,
            returnMetadata: toReturnMetadata(options?.returnMetadata),
            filter: options?.filter,
          })
          .pipe(Effect.map(toMatches)),
      ),
    queryById: () =>
      Effect.die(
        new Error(
          "SearchIndex over HTTP: `queryById` is not supported — the HTTP query endpoint only accepts a raw query vector. Fetch the vector with `getByIds` and pass its values to `query`.",
        ),
      ),
    insert: (vectors) =>
      local((name) =>
        vectorize
          .insertIndex({
            accountId,
            indexName: name,
            body: toNdjsonBlob(vectors),
          })
          .pipe(Effect.map(toMutation)),
      ),
    upsert: (vectors) =>
      local((name) =>
        vectorize
          .upsertIndex({
            accountId,
            indexName: name,
            body: toNdjsonBlob(vectors),
          })
          .pipe(Effect.map(toMutation)),
      ),
    deleteByIds: (ids) =>
      local((name) =>
        vectorize
          .deleteByIdsIndex({ accountId, indexName: name, ids })
          .pipe(Effect.map(toMutation)),
      ),
    getByIds: (ids) =>
      local((name) =>
        vectorize
          .getByIdsIndex({ accountId, indexName: name, ids })
          .pipe(
            Effect.map((result) => (result ?? []) as runtime.VectorizeVector[]),
          ),
      ),
  } satisfies SearchIndexClient;
};

// ── shape adapters (runtime types <-> distilled HTTP types) ─────────────────

/**
 * Serialize vectors to an ndjson Blob — the raw `application/x-ndjson` request
 * body of the Vectorize v2 insert/upsert endpoints.
 */
const toNdjsonBlob = (vectors: runtime.VectorizeVector[]): Blob =>
  new Blob([toNdjson(vectors)]);

/** Serialize vectors to ndjson — one JSON vector per line. */
const toNdjson = (vectors: runtime.VectorizeVector[]): string =>
  vectors
    .map((v) =>
      JSON.stringify({
        id: v.id,
        // A `VectorFloatArray` (Float32Array) would `JSON.stringify` to an
        // object, not an array — normalize to a plain number array.
        values: Array.from(v.values),
        ...(v.namespace !== undefined ? { namespace: v.namespace } : {}),
        ...(v.metadata !== undefined ? { metadata: v.metadata } : {}),
      }),
    )
    .join("\n");

const toReturnMetadata = (
  value: runtime.VectorizeQueryOptions["returnMetadata"],
): "none" | "indexed" | "all" | undefined =>
  value === undefined
    ? undefined
    : typeof value === "boolean"
      ? value
        ? "all"
        : "none"
      : value;

const toMutation = (r: {
  mutationId?: string | null;
}): runtime.VectorizeAsyncMutation => ({ mutationId: r.mutationId ?? "" });

const toIndexInfo = (
  r: vectorize.InfoIndexResponse,
): runtime.VectorizeIndexInfo =>
  ({
    vectorCount: r.vectorCount ?? 0,
    dimensions: r.dimensions ?? 0,
    processedUpToDatetime: r.processedUpToDatetime ?? undefined,
    processedUpToMutation: r.processedUpToMutation ?? undefined,
  }) as unknown as runtime.VectorizeIndexInfo;

const toMatches = (r: vectorize.QueryIndexResponse): runtime.VectorizeMatches =>
  ({
    count: r.count ?? r.matches?.length ?? 0,
    matches: (r.matches ?? []).map((m) => ({
      id: m.id ?? "",
      score: m.score ?? 0,
      ...(m.values != null ? { values: m.values } : {}),
      ...(m.namespace != null ? { namespace: m.namespace } : {}),
      ...(m.metadata != null ? { metadata: m.metadata } : {}),
    })),
  }) as unknown as runtime.VectorizeMatches;

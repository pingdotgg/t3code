import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Vectorize index created at deploy time and bound to the worker via
 * `Cloudflare.VectorizeConnection.bind(...)`. A metadata index on the
 * `kind` property is also provisioned so that filtered queries can use
 * it. The handlers exercise the Effect-native Vectorize client surface:
 *
 *   POST /upsert         — `index.upsert([...])`
 *   GET  /describe       — `index.describe()`
 *   GET  /query          — `index.query(vector, { topK })`
 *   GET  /query-filtered — `index.query(vector, { filter: { kind: ... } })`
 *   GET  /get            — `index.getByIds([...])`
 */
const DIMENSIONS = 32;

/** Builds a deterministic `DIMENSIONS`-length vector seeded by the first values. */
const vector = (...seed: number[]): number[] =>
  Array.from({ length: DIMENSIONS }, (_, i) => seed[i] ?? (i % 10) / 10);

export const TestIndex = Cloudflare.VectorizeIndex("VectorizeWorkerIndex", {
  dimensions: DIMENSIONS,
  metric: "cosine",
});

export default class VectorizeWorker extends Cloudflare.Worker<VectorizeWorker>()(
  "VectorizeEffectWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const index = yield* TestIndex;
    // Metadata indexes must exist before vectors are inserted for them to
    // be queryable — declaring it here puts it in the stack so the deploy
    // creates it before the test hits /upsert.
    yield* Cloudflare.VectorizeMetadataIndex("VectorizeWorkerKindMetaIndex", {
      indexName: index.indexName,
      propertyName: "kind",
      indexType: "string",
    });
    const vec = yield* Cloudflare.VectorizeIndex.bind(index);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && url.pathname === "/upsert") {
          const mutation = yield* vec.upsert([
            {
              id: "a",
              values: vector(0.1, 0.2, 0.3),
              metadata: { kind: "first" },
            },
            {
              id: "b",
              values: vector(0.9, 0.8, 0.7),
              metadata: { kind: "second" },
            },
            {
              id: "c",
              values: vector(0.4, 0.5, 0.6),
              metadata: { kind: "third" },
            },
          ]);
          return yield* HttpServerResponse.json({
            mutationId: mutation.mutationId,
          });
        }

        if (request.method === "GET" && url.pathname === "/describe") {
          const info = yield* vec.describe();
          return yield* HttpServerResponse.json({
            dimensions: info.dimensions,
            vectorCount: info.vectorCount,
          });
        }

        if (request.method === "GET" && url.pathname === "/query") {
          const matches = yield* vec.query(vector(0.1, 0.2, 0.3), {
            topK: 3,
            returnMetadata: "all",
          });
          return yield* HttpServerResponse.json({
            count: matches.count,
            ids: matches.matches.map((m) => m.id),
          });
        }

        if (request.method === "GET" && url.pathname === "/query-filtered") {
          const matches = yield* vec.query(vector(0.1, 0.2, 0.3), {
            topK: 3,
            returnMetadata: "all",
            filter: { kind: { $eq: "second" } },
          });
          return yield* HttpServerResponse.json({
            count: matches.count,
            ids: matches.matches.map((m) => m.id),
            kinds: matches.matches.map(
              (m) => (m.metadata as { kind?: string } | undefined)?.kind,
            ),
          });
        }

        if (request.method === "GET" && url.pathname === "/get") {
          const vectors = yield* vec.getByIds(["a", "b"]);
          return yield* HttpServerResponse.json({
            ids: vectors.map((v) => v.id).sort(),
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.VectorizeIndexBindingLive)),
) {}

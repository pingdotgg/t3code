import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ensureMetaIndex, TestIndex } from "./index-resource.ts";
import { seedVectors, vector } from "./vectors.ts";

const LABEL = "effect";

/**
 * Effect-native Worker style: `Cloudflare.Vectorize.SearchIndex(index)` during
 * init attaches the native `vectorize` binding to this Worker and resolves to
 * the Effect-flavored client (`upsert`, `describe`, `query`, `getByIds`).
 *
 *   POST /upsert         — `index.upsert([...])`
 *   GET  /describe       — `index.describe()`
 *   GET  /query          — `index.query(vector, { topK })`
 *   GET  /query-filtered — `index.query(vector, { filter: { kind: ... } })`
 *   GET  /get            — `index.getByIds([...])`
 */
export default class VectorizeEffectWorker extends Cloudflare.Worker<VectorizeEffectWorker>()(
  "VectorizeEffectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const index = yield* TestIndex;
    const vec = yield* Cloudflare.Vectorize.SearchIndex(index);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && url.pathname === "/upsert") {
          const mutation = yield* vec.upsert(seedVectors(LABEL));
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
            topK: 20,
            returnMetadata: "all",
          });
          // Restrict to this worker's own vectors so the shared index doesn't
          // leak the async worker's data into the assertions.
          const mine = matches.matches.filter((m) =>
            m.id.startsWith(`${LABEL}-`),
          );
          return yield* HttpServerResponse.json({
            count: mine.length,
            ids: mine.map((m) => m.id),
          });
        }

        if (request.method === "GET" && url.pathname === "/query-filtered") {
          const matches = yield* vec.query(vector(0.1, 0.2, 0.3), {
            topK: 3,
            returnMetadata: "all",
            filter: { kind: { $eq: "second" } },
          });
          const mine = matches.matches.filter((m) =>
            m.id.startsWith(`${LABEL}-`),
          );
          return yield* HttpServerResponse.json({
            count: mine.length,
            ids: mine.map((m) => m.id),
            kinds: mine.map(
              (m) => (m.metadata as { kind?: string } | undefined)?.kind,
            ),
          });
        }

        if (request.method === "GET" && url.pathname === "/get") {
          const vectors = yield* vec.getByIds([`${LABEL}-a`, `${LABEL}-b`]);
          return yield* HttpServerResponse.json({
            ids: vectors.map((v) => v.id).sort(),
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Vectorize.SearchIndexBinding)),
) {}

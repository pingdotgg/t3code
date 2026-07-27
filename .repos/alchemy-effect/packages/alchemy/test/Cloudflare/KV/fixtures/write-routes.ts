import type { WriteNamespaceClient } from "@/Cloudflare/KV/WriteNamespace.ts";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Shared write-side routes exercised by both the binding and HTTP fixtures so
 * every method of {@link WriteNamespaceClient} is driven over `fetch`:
 *
 * - `PUT /put?key=` — `put(key, body)`.
 * - `PUT /put-meta?key=` — `put(key, body, { metadata, expirationTtl })`.
 * - `DELETE /del?key=` — `delete(key)`.
 *
 * Returns `undefined` when the path is not a write route so the caller can
 * fall through (used by the read-write fixtures).
 */
export const writeRoutes = (
  kv: WriteNamespaceClient,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    if (request.method === "PUT" && url.pathname === "/put") {
      const key = url.searchParams.get("key") ?? "";
      const body = yield* request.text;
      yield* kv.put(key, body).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (request.method === "PUT" && url.pathname === "/put-meta") {
      const key = url.searchParams.get("key") ?? "";
      const body = yield* request.text;
      // `expirationTtl` must be ≥ 60s; metadata round-trips via getWithMetadata.
      yield* kv
        .put(key, body, { metadata: { tag: "meta" }, expirationTtl: 3600 })
        .pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (request.method === "DELETE" && url.pathname === "/del") {
      const key = url.searchParams.get("key") ?? "";
      yield* kv.delete(key).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    return undefined;
  });

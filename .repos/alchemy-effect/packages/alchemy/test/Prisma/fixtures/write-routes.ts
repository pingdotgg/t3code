import type { WriteBucketClient } from "@/Prisma/WriteBucket.ts";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Shared write-side routes so every method of {@link WriteBucketClient} is
 * driven over `fetch`:
 *
 * - `PUT /put?key=` — `put(key, body)` (returns the object key to prove the
 *   call resolved a `BucketObject`). `contentType`, `metaKey` and `metaValue`
 *   travel as query params and are passed through as `PutOptions`, so the
 *   read side can observe them.
 * - `DELETE /del?key=` — `delete(key)` (single).
 * - `DELETE /del-many?keys=a,b,c` — `delete(keys)` (batch). Keys travel as a
 *   comma-separated query param rather than a request body because DELETE
 *   bodies are unreliable across `fetch`.
 * - `GET /presign-put?key=` — `presignPut(key)`.
 *
 * Returns `undefined` when the path is not a write route so the caller can
 * fall through (used by the read-write fixtures).
 */
export const writeRoutes = (
  store: WriteBucketClient,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    if (request.method === "PUT" && url.pathname === "/put") {
      const key = url.searchParams.get("key") ?? "";
      const metaKey = url.searchParams.get("metaKey");
      const body = yield* request.text;
      const object = yield* store
        .put(key, body, {
          contentType: url.searchParams.get("contentType") ?? undefined,
          metadata: metaKey
            ? { [metaKey]: url.searchParams.get("metaValue") ?? "" }
            : undefined,
        })
        .pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true, key: object.key });
    }
    if (request.method === "DELETE" && url.pathname === "/del") {
      const key = url.searchParams.get("key") ?? "";
      yield* store.delete(key).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (request.method === "DELETE" && url.pathname === "/del-many") {
      const keys = (url.searchParams.get("keys") ?? "")
        .split(",")
        .filter((k) => k.length > 0);
      yield* store.delete(keys).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    // The app mints the URL from its bound credentials and hands it back; the
    // test then uploads to that URL directly, carrying no credentials of its
    // own.
    if (request.method === "GET" && url.pathname === "/presign-put") {
      const key = url.searchParams.get("key") ?? "";
      const expiresIn = url.searchParams.get("expiresIn");
      const contentType = url.searchParams.get("contentType");
      const presigned = yield* store
        .presignPut(key, {
          expiresIn: expiresIn ? Number(expiresIn) : undefined,
          contentType: contentType ?? undefined,
        })
        .pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ url: presigned });
    }
    return undefined;
  });

import type { WriteBucketClient } from "@/Cloudflare/R2/WriteBucket.ts";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Shared write-side routes exercised by both the binding and HTTP fixtures so
 * every (HTTP-supported) method of {@link WriteBucketClient} is driven over
 * `fetch`:
 *
 * - `PUT /put?key=` — `put(key, body)` (returns the object key to prove the
 *   call resolved an `R2Object`).
 * - `DELETE /del?key=` — `delete(key)` (single).
 * - `DELETE /del-many?keys=a,b,c` — `delete(keys)` (batch). Keys travel as a
 *   comma-separated query param rather than a request body because DELETE
 *   bodies are unreliable across `fetch`/the CF edge.
 *
 * Returns `undefined` when the path is not a write route so the caller can
 * fall through (used by the read-write fixtures).
 */
export const writeRoutes = (
  r2: WriteBucketClient,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
) =>
  Effect.gen(function* () {
    if (request.method === "PUT" && url.pathname === "/put") {
      const key = url.searchParams.get("key") ?? "";
      const body = yield* request.text;
      const object = yield* r2.put(key, body).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({
        ok: true,
        key: object?.key ?? key,
      });
    }
    if (request.method === "DELETE" && url.pathname === "/del") {
      const key = url.searchParams.get("key") ?? "";
      yield* r2.delete(key).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (request.method === "DELETE" && url.pathname === "/del-many") {
      const keys = (url.searchParams.get("keys") ?? "")
        .split(",")
        .filter((k) => k.length > 0);
      yield* r2.delete(keys).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    // Multipart upload (native binding only — the HTTP client `Effect.die`s
    // these). R2 requires every part except the last to be ≥ 5 MiB, so the
    // first part is exactly 5 MiB and the tail is a tiny final part. The
    // worker generates the bytes internally so the test payload stays small.
    if (request.method === "POST" && url.pathname === "/mpu") {
      const key = url.searchParams.get("key") ?? "";
      const part = new Uint8Array(5 * 1024 * 1024).fill(65);
      const upload = yield* r2.createMultipartUpload(key).pipe(Effect.orDie);
      const p1 = yield* upload.uploadPart(1, part).pipe(Effect.orDie);
      const p2 = yield* upload.uploadPart(2, "tail").pipe(Effect.orDie);
      const object = yield* upload.complete([p1, p2]).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true, size: object.size });
    }
    if (request.method === "POST" && url.pathname === "/mpu-abort") {
      const key = url.searchParams.get("key") ?? "";
      const part = new Uint8Array(5 * 1024 * 1024).fill(66);
      const upload = yield* r2.createMultipartUpload(key).pipe(Effect.orDie);
      yield* upload.uploadPart(1, part).pipe(Effect.orDie);
      yield* upload.abort().pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/mpu-resume") {
      const key = url.searchParams.get("key") ?? "";
      const part = new Uint8Array(5 * 1024 * 1024).fill(67);
      const created = yield* r2.createMultipartUpload(key).pipe(Effect.orDie);
      const upload = yield* r2
        .resumeMultipartUpload(key, created.uploadId)
        .pipe(Effect.orDie);
      const p1 = yield* upload.uploadPart(1, part).pipe(Effect.orDie);
      const p2 = yield* upload.uploadPart(2, "tail").pipe(Effect.orDie);
      const object = yield* upload.complete([p1, p2]).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ ok: true, size: object.size });
    }
    return undefined;
  });

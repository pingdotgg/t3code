import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { PresignError } from "./BucketTypes.ts";

export interface PresignGetObjectRequest {
  /**
   * Key of the object to mint a presigned download URL for.
   */
  key: string;
  /**
   * Number of seconds the URL remains valid (at most 7 days).
   * @default 900
   */
  expiresIn?: number;
  /**
   * `Content-Type` the object is served with, signed into the URL as a
   * `response-content-type` override. The downloader sends nothing extra.
   */
  contentType?: string;
  /**
   * `Content-Disposition` the object is served with (e.g.
   * `attachment; filename="report.pdf"`), signed into the URL as a
   * `response-content-disposition` override.
   */
  contentDisposition?: string;
}

/**
 * Mint presigned download (GET) URLs for objects in an R2 {@link Bucket}, so
 * a browser or any HTTP client can read an object without credentials or a
 * Worker in the request path.
 *
 * Presigning is a pure SigV4 computation against R2's S3-compatible API — no
 * request is made. When deployed, the binding mints a scoped account API
 * token (`Workers R2 Storage Read`) and derives R2 S3 credentials from it;
 * the URLs point at `https://{accountId}.r2.cloudflarestorage.com`.
 *
 * Under `alchemy dev`, a locally-emulated bucket is served on the Worker's
 * local S3 endpoint (`{worker url}/cdn-cgi/local/r2/s3`) and the minted URLs
 * point there — the same code runs unchanged in both modes.
 *
 * ### Presigning Download URLs
 * **Example:** Mint a presigned GET URL
 * ```typescript
 * const presignGet = yield* Cloudflare.R2.PresignGetObject(bucket);
 * const url = yield* presignGet({ key: "reports/2026-09.pdf" });
 * // hand `url` to a browser — it can GET the object without credentials
 * ```
 *
 * **Example:** Force a download with a short-lived URL
 * ```typescript
 * const url = yield* presignGet({
 *   key: "reports/2026-09.pdf",
 *   expiresIn: 60,
 *   contentDisposition: 'attachment; filename="report.pdf"',
 * });
 * ```
 *
 * **Example:** Provide the implementation on a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const presignGet = yield* Cloudflare.R2.PresignGetObject(Files);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const url = yield* presignGet({ key: "hello.txt" });
 *         return HttpServerResponse.redirect(url);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.R2.PresignGetObjectToken)),
 * ) {}
 * ```
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export interface PresignGetObject extends Binding.Service<
  PresignGetObject,
  "Cloudflare.R2.PresignGetObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PresignGetObjectRequest,
    ) => Effect.Effect<string, PresignError, RuntimeContext>
  >
> {}

export const PresignGetObject = Binding.Service<PresignGetObject>(
  "Cloudflare.R2.PresignGetObject",
);

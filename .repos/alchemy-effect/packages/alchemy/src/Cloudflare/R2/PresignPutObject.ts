import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { PresignError } from "./BucketTypes.ts";

export interface PresignPutObjectRequest {
  /**
   * Key of the object to mint a presigned upload URL for.
   */
  key: string;
  /**
   * Number of seconds the URL remains valid (at most 7 days).
   * @default 900
   */
  expiresIn?: number;
  /**
   * `Content-Type` signed into the URL. The uploader must send exactly this
   * `Content-Type` header or R2 rejects the upload with a signature
   * mismatch. Omit to leave the Content-Type unconstrained.
   */
  contentType?: string;
}

/**
 * Mint presigned upload (PUT) URLs for objects in an R2 {@link Bucket}, so a
 * browser can upload directly to R2 without credentials and without routing
 * the body through a Worker.
 *
 * Presigning is a pure SigV4 computation against R2's S3-compatible API — no
 * request is made. When deployed, the binding mints a scoped account API
 * token (`Workers R2 Storage Write`) and derives R2 S3 credentials from it;
 * the URLs point at `https://{accountId}.r2.cloudflarestorage.com`.
 *
 * Under `alchemy dev`, a locally-emulated bucket is served on the Worker's
 * local S3 endpoint (`{worker url}/cdn-cgi/local/r2/s3`) and the minted URLs
 * point there — the same code runs unchanged in both modes, and objects
 * uploaded locally are visible to every local binding of the bucket.
 *
 * Browser uploads to a deployed bucket also need a matching CORS rule on the
 * {@link Bucket} (`cors` prop). The local endpoint always allows
 * cross-origin requests.
 *
 * ### Presigning Upload URLs
 * **Example:** Mint a presigned PUT URL
 * ```typescript
 * const presignPut = yield* Cloudflare.R2.PresignPutObject(bucket);
 * const url = yield* presignPut({ key: "uploads/avatar.png" });
 * // the browser uploads with: fetch(url, { method: "PUT", body: file })
 * ```
 *
 * **Example:** Pin the uploaded Content-Type
 * ```typescript
 * const url = yield* presignPut({
 *   key: "uploads/avatar.png",
 *   expiresIn: 300, // valid for 5 minutes
 *   contentType: "image/png", // uploader must send Content-Type: image/png
 * });
 * ```
 *
 * **Example:** Allow browser uploads from a web app
 * ```typescript
 * const Uploads = Cloudflare.R2.Bucket("Uploads", {
 *   cors: [
 *     {
 *       allowedMethods: ["PUT"],
 *       allowedOrigins: ["https://app.example.com"],
 *       allowedHeaders: ["content-type"],
 *     },
 *   ],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const presignPut = yield* Cloudflare.R2.PresignPutObject(Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const url = yield* presignPut({ key: crypto.randomUUID() });
 *         return yield* HttpServerResponse.json({ url });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.R2.PresignPutObjectToken)),
 * ) {}
 * ```
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export interface PresignPutObject extends Binding.Service<
  PresignPutObject,
  "Cloudflare.R2.PresignPutObject",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PresignPutObjectRequest,
    ) => Effect.Effect<string, PresignError, RuntimeContext>
  >
> {}

export const PresignPutObject = Binding.Service<PresignPutObject>(
  "Cloudflare.R2.PresignPutObject",
);

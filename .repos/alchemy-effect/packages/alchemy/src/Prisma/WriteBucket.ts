import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import { makeBucketBinding } from "./BucketBinding.ts";
import type {
  BucketCredentials,
  BucketBody,
  BucketError,
  BucketObject,
  PresignPutOptions,
  PutOptions,
} from "./BucketTypes.ts";
import {
  makeBucketAccess,
  objectFrom,
  toBucketError,
  type BucketAccess,
} from "./Internal/BucketClient.ts";

export interface WriteBucket extends Binding.Service<
  WriteBucket,
  "Prisma.WriteBucket",
  (bucket: Bucket) => Effect.Effect<WriteBucketClient>
> {}

/**
 * Write-only client for a Prisma Object Store bucket. It deliberately exposes
 * no read operations — see the role caveat on {@link WriteBucketBinding}.
 */
export interface WriteBucketClient {
  /**
   * Store an object, replacing any object already under the key.
   */
  put(
    key: string,
    value: BucketBody,
    options?: PutOptions,
  ): Effect.Effect<BucketObject, BucketError, RuntimeContext>;
  /**
   * Delete one key or a list of keys. Deleting a key that does not exist
   * succeeds.
   */
  delete(
    keys: string | string[],
  ): Effect.Effect<void, BucketError, RuntimeContext>;
  /**
   * Mint a presigned upload URL, so a browser can write the object without
   * credentials. Pure client-side SigV4 — no request is made to the store.
   *
   * When `contentType` is set the uploader must send exactly that
   * `Content-Type`, because it is signed into the URL.
   */
  presignPut(
    key: string,
    options?: PresignPutOptions,
  ): Effect.Effect<string, BucketError, RuntimeContext>;
}

/**
 * Bind a Prisma Object Store {@link Bucket} to a Prisma Compute app, AWS
 * Lambda Function, or Cloudflare Worker with write access, and obtain the
 * typed runtime client.
 *
 * Binding creates a `Prisma.BucketAccessKey` for the bucket and carries its S3
 * credentials into the host environment, so the caller never handles a
 * credential themselves.
 *
 * Provide {@link WriteBucketBinding} on the host implementation.
 *
 * **Role caveat.** Prisma bucket keys carry one of two coarse roles, `read`
 * and `read_write`; there is no write-only role. This binding therefore mints
 * a `read_write` key, and the credential it puts in the host environment can
 * also read. The write-only contract is enforced client-side —
 * {@link WriteBucketClient} exposes no read operations — and becomes a
 * server-side boundary if Prisma grows a write-only role.
 *
 * ### Binding a Bucket
 * **Example:** Write objects from Prisma Compute
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   { project, main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const uploads = yield* Prisma.WriteBucket(bucket);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* uploads.put("reports/2026.json", JSON.stringify({ ok: true }), {
 *           contentType: "application/json",
 *         });
 *         return yield* HttpServerResponse.empty({ status: 204 });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.WriteBucketBinding)),
 * );
 * ```
 *
 * @binding
 */
export const WriteBucket = Binding.Service<WriteBucket>("Prisma.WriteBucket");

/**
 * Build the write operations over an already-resolved transport. Shared with
 * {@link ReadWriteBucket} so both levels run the same code.
 */
export const writeBucketOperations = (
  access: BucketAccess,
): WriteBucketClient => ({
  put: (key: string, value: BucketBody, options?: PutOptions) =>
    access.bucketName.pipe(
      Effect.flatMap((Bucket) =>
        access.authorize(
          S3.putObject({
            Bucket,
            Key: key,
            Body: value,
            ContentType: options?.contentType,
            ContentLength: options?.contentLength,
            CacheControl: options?.cacheControl,
            ContentDisposition: options?.contentDisposition,
            ContentEncoding: options?.contentEncoding,
            Metadata: options?.metadata,
          }),
        ),
      ),
      Effect.map((response) =>
        objectFrom(key, {
          ETag: response.ETag,
          ContentLength: options?.contentLength,
          ContentType: options?.contentType,
          Metadata: options?.metadata,
        }),
      ),
      Effect.mapError(toBucketError),
    ),
  // Deletes are issued one key at a time rather than through the batch
  // `DeleteObjects` operation, whose signed-payload digest requirement is not
  // uniformly supported by S3-compatible stores.
  delete: (keys: string | string[]) =>
    access.bucketName.pipe(
      Effect.flatMap((Bucket) =>
        Effect.forEach(
          typeof keys === "string" ? [keys] : keys,
          (key) => access.authorize(S3.deleteObject({ Bucket, Key: key })),
          { concurrency: 16, discard: true },
        ),
      ),
      Effect.mapError(toBucketError),
    ),
  presignPut: (key: string, options?: PresignPutOptions) =>
    access.presign({
      method: "PUT",
      key,
      expiresIn: options?.expiresIn,
      contentType: options?.contentType,
    }),
});

/**
 * Build a write-only bucket client from a bound bucket key's credentials.
 */
export const makeWriteBucketClient = (
  credentials: BucketCredentials,
): WriteBucketClient => writeBucketOperations(makeBucketAccess(credentials));

/**
 * Implementation layer for {@link WriteBucket}. Provide it on the host
 * Function/Worker Effect:
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const uploads = yield* Prisma.WriteBucket(bucket);
 *   // ...
 * }).pipe(Effect.provide(Prisma.WriteBucketBinding))
 * ```
 *
 * Prisma bucket keys carry one of two coarse roles, `read` and `read_write`;
 * there is no write-only role, so this binding mints a `read_write` key and
 * the credential it carries into the host can also read. The write-only
 * contract is enforced client-side by {@link WriteBucketClient}, which exposes
 * no read operations, and becomes a server-side boundary if Prisma grows a
 * write-only role.
 */
export const WriteBucketBinding = Layer.effect(
  WriteBucket,
  makeBucketBinding({
    capability: "Write",
    role: "read_write",
    makeClient: makeWriteBucketClient,
  }),
);

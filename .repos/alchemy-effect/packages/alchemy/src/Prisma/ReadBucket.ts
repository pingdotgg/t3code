import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import { makeBucketBinding } from "./BucketBinding.ts";
import type {
  BucketCredentials,
  BucketError,
  BucketObject,
  BucketObjectBody,
  GetOptions,
  ListOptions,
  ListResult,
  PresignGetOptions,
} from "./BucketTypes.ts";
import {
  makeBucketAccess,
  objectBodyFrom,
  objectFrom,
  objectFromListEntry,
  rangeHeader,
  toBucketError,
  type BucketAccess,
} from "./Internal/BucketClient.ts";

export interface ReadBucket extends Binding.Service<
  ReadBucket,
  "Prisma.ReadBucket",
  (bucket: Bucket) => Effect.Effect<ReadBucketClient>
> {}

/**
 * Read-only client for a Prisma Object Store bucket. It deliberately exposes
 * no write operations — see the role caveat on {@link ReadBucketBinding}.
 */
export interface ReadBucketClient {
  /**
   * Read an object's metadata without downloading it. Resolves `null` when the
   * key does not exist.
   */
  head(
    key: string,
  ): Effect.Effect<BucketObject | null, BucketError, RuntimeContext>;
  /**
   * Read an object and its body. Resolves `null` when the key does not exist.
   */
  get(
    key: string,
    options?: GetOptions,
  ): Effect.Effect<BucketObjectBody | null, BucketError, RuntimeContext>;
  /**
   * List one page of objects in the bucket.
   */
  list(
    options?: ListOptions,
  ): Effect.Effect<ListResult, BucketError, RuntimeContext>;
  /**
   * Mint a presigned download URL, so a browser can read the object without
   * credentials. Pure client-side SigV4 — no request is made to the store.
   */
  presignGet(
    key: string,
    options?: PresignGetOptions,
  ): Effect.Effect<string, BucketError, RuntimeContext>;
}

/**
 * Bind a Prisma Object Store {@link Bucket} to a Prisma Compute app, AWS
 * Lambda Function, or Cloudflare Worker with read-only access, and obtain the
 * typed runtime client.
 *
 * Binding creates a read-scoped `Prisma.BucketAccessKey` for the bucket and carries
 * its S3 credentials into the host environment, so the caller never handles a
 * credential themselves.
 *
 * Provide {@link ReadBucketBinding} on the host implementation.
 *
 * Prisma bucket keys carry one of two coarse roles, `read` and `read_write`.
 * This binding mints the `read` one, so the credential it puts in the host
 * environment cannot write, and {@link ReadBucketClient} exposes no write
 * operations either.
 *
 * ### Binding a Bucket
 * **Example:** Read objects from Prisma Compute
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   { project, main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const uploads = yield* Prisma.ReadBucket(bucket);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const object = yield* uploads.get("reports/2026.json");
 *         return yield* HttpServerResponse.json(
 *           object === null ? null : yield* object.json(),
 *         );
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ReadBucketBinding)),
 * );
 * ```
 *
 * @binding
 */
export const ReadBucket = Binding.Service<ReadBucket>("Prisma.ReadBucket");

/**
 * Build the read operations over an already-resolved transport. Shared with
 * {@link ReadWriteBucket} so both levels run the same code.
 */
export const readBucketOperations = (
  access: BucketAccess,
): ReadBucketClient => ({
  head: (key: string) =>
    access.bucketName.pipe(
      Effect.flatMap((Bucket) =>
        access.authorize(S3.headObject({ Bucket, Key: key })),
      ),
      Effect.map((response) => objectFrom(key, response)),
      // A missing key is absence, not a failure — mirror the native bucket
      // clients that resolve `null`.
      Effect.catchTag("NotFound", () => Effect.succeed(null)),
      Effect.mapError(toBucketError),
    ),
  get: (key: string, options?: GetOptions) =>
    access.bucketName.pipe(
      Effect.flatMap((Bucket) =>
        access.authorize(
          S3.getObject({
            Bucket,
            Key: key,
            Range: rangeHeader(options?.range),
          }),
        ),
      ),
      Effect.map((response) => objectBodyFrom(key, response)),
      Effect.catchTag("NoSuchKey", () => Effect.succeed(null)),
      Effect.mapError(toBucketError),
    ),
  list: (options?: ListOptions) =>
    access.bucketName.pipe(
      Effect.flatMap((Bucket) =>
        access.authorize(
          S3.listObjectsV2({
            Bucket,
            Prefix: options?.prefix,
            Delimiter: options?.delimiter,
            ContinuationToken: options?.cursor,
            MaxKeys: options?.limit,
            StartAfter: options?.startAfter,
          }),
        ),
      ),
      Effect.map((response): ListResult => {
        const objects = (response.Contents ?? []).map(objectFromListEntry);
        const delimitedPrefixes = (response.CommonPrefixes ?? []).flatMap(
          (prefix) => (prefix.Prefix === undefined ? [] : [prefix.Prefix]),
        );
        return response.IsTruncated && response.NextContinuationToken
          ? {
              objects,
              delimitedPrefixes,
              truncated: true,
              cursor: response.NextContinuationToken,
            }
          : { objects, delimitedPrefixes, truncated: false };
      }),
      Effect.mapError(toBucketError),
    ),
  presignGet: (key: string, options?: PresignGetOptions) =>
    access.presign({
      method: "GET",
      key,
      expiresIn: options?.expiresIn,
      responseContentType: options?.contentType,
    }),
});

/**
 * Build a read-only bucket client from a bound bucket key's credentials.
 */
export const makeReadBucketClient = (
  credentials: BucketCredentials,
): ReadBucketClient => readBucketOperations(makeBucketAccess(credentials));

/**
 * Implementation layer for {@link ReadBucket}. Provide it on the host
 * Function/Worker Effect:
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const uploads = yield* Prisma.ReadBucket(bucket);
 *   // ...
 * }).pipe(Effect.provide(Prisma.ReadBucketBinding))
 * ```
 *
 * Prisma bucket keys have only `read` and `read_write` roles, and this binding
 * mints the `read` one, so the credential it carries into the host cannot
 * write.
 */
export const ReadBucketBinding = Layer.effect(
  ReadBucket,
  makeBucketBinding({
    capability: "Read",
    role: "read",
    makeClient: makeReadBucketClient,
  }),
);

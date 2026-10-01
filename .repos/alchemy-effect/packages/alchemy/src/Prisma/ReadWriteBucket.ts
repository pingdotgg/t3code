import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { Bucket } from "./Bucket.ts";
import { makeBucketBinding } from "./BucketBinding.ts";
import type { BucketCredentials } from "./BucketTypes.ts";
import { makeBucketAccess } from "./Internal/BucketClient.ts";
import { readBucketOperations, type ReadBucketClient } from "./ReadBucket.ts";
import {
  writeBucketOperations,
  type WriteBucketClient,
} from "./WriteBucket.ts";

export interface ReadWriteBucket extends Binding.Service<
  ReadWriteBucket,
  "Prisma.ReadWriteBucket",
  (bucket: Bucket) => Effect.Effect<ReadWriteBucketClient>
> {}

/**
 * Full-access client for a Prisma Object Store bucket: every operation of
 * {@link ReadBucketClient} and {@link WriteBucketClient}.
 */
export interface ReadWriteBucketClient
  extends ReadBucketClient, WriteBucketClient {}

/**
 * Bind a Prisma Object Store {@link Bucket} to a Prisma Compute app, AWS
 * Lambda Function, or Cloudflare Worker with read and write access, and obtain
 * the typed runtime client.
 *
 * Binding creates a read-write `Prisma.BucketAccessKey` for the bucket and carries
 * its S3 credentials into the host environment, so the caller never handles a
 * credential themselves.
 *
 * Provide {@link ReadWriteBucketBinding} on the host implementation.
 *
 * Use {@link ReadBucket} instead where read-only access is enough: Prisma
 * bucket keys have a `read` role, so that binding's credential genuinely
 * cannot write.
 *
 * ### Binding a Bucket
 * **Example:** Read and write objects from Prisma Compute
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   { project, main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const uploads = yield* Prisma.ReadWriteBucket(bucket);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* uploads.put("hits", "1");
 *         const object = yield* uploads.get("hits");
 *         return yield* HttpServerResponse.text(
 *           object === null ? "" : yield* object.text(),
 *         );
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ReadWriteBucketBinding)),
 * );
 * ```
 *
 * @binding
 */
export const ReadWriteBucket = Binding.Service<ReadWriteBucket>(
  "Prisma.ReadWriteBucket",
);

/**
 * Build a read-write bucket client from a bound bucket key's credentials.
 */
export const makeReadWriteBucketClient = (
  credentials: BucketCredentials,
): ReadWriteBucketClient => {
  const access = makeBucketAccess(credentials);
  return {
    ...readBucketOperations(access),
    ...writeBucketOperations(access),
  };
};

/**
 * Implementation layer for {@link ReadWriteBucket}. Provide it on the host
 * Function/Worker Effect:
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const uploads = yield* Prisma.ReadWriteBucket(bucket);
 *   // ...
 * }).pipe(Effect.provide(Prisma.ReadWriteBucketBinding))
 * ```
 */
export const ReadWriteBucketBinding = Layer.effect(
  ReadWriteBucket,
  makeBucketBinding({
    capability: "ReadWrite",
    role: "read_write",
    makeClient: makeReadWriteBucketClient,
  }),
);

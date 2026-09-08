import * as Effect from "effect/Effect";
import type { Bucket } from "./Bucket.ts";
import { BucketAccessKey } from "./BucketAccessKey.ts";
import type { BucketCredentials } from "./BucketTypes.ts";
import type { BucketKeyRole } from "./Types.ts";

/**
 * Access level a bucket binding grants. The three levels are separate binding
 * services so a Function can ask for the least privilege it needs; see the
 * role caveat on {@link makeBucketBinding}.
 */
export type BucketCapability = "Read" | "Write" | "ReadWrite";

/**
 * Logical ID of the {@link BucketAccessKey} a bucket binding creates on the
 * caller's behalf.
 *
 * Derived from the bucket and the access level only — deliberately not from
 * the host. The deployed bundle re-runs the same composition code with no host
 * resolved, and it has to arrive at the same identity, or the runtime half
 * would look for credentials under a different name than the deploy-time half
 * wrote them. Two hosts binding the same bucket at the same level therefore
 * share one key, which is the intended outcome: the credentials are identical.
 */
export const bucketAccessKeyLogicalId = (
  bucket: Pick<Bucket, "LogicalId">,
  capability: BucketCapability,
) => `${bucket.LogicalId}${capability}BucketAccessKey`;

/**
 * Shared scaffolding for the Prisma bucket bindings.
 *
 * NOT exported from `index.ts` — the capability modules (`ReadBucket.ts`,
 * `WriteBucket.ts`, `ReadWriteBucket.ts`) are each a thin
 * `Layer.effect(Cap, makeBucketBinding({ … }))` over this builder;
 * `makeClient` receives the resolved credential accessors and knows nothing
 * about where they came from.
 *
 * Binding a bucket creates a {@link BucketAccessKey} for it — the logical ID
 * is derived from the bucket and the access level (see
 * {@link bucketAccessKeyLogicalId}), so repeated binds reconcile onto the same
 * key instead of minting a new credential every deploy. The key's outputs are
 * bound to the host by yielding them, so any host with a runtime context
 * carries them automatically; `Redacted` values survive the round-trip.
 *
 * **Role caveat.** Prisma bucket access keys carry one of two coarse roles,
 * `read` and `read_write`; there is no write-only role. A `Read` binding mints
 * a `read` key and is genuinely scoped, but a `Write` binding mints a
 * `read_write` key, so its credential can also read. The split between `Write`
 * and `ReadWrite` is therefore a forward contract enforced client-side — the
 * `Write` client exposes no read operations — and it becomes an enforced
 * server-side boundary if Prisma grows a write-only role.
 */
export const makeBucketBinding = <Client>(options: {
  /** Access level this binding grants; part of the key identity. */
  capability: BucketCapability;
  /** Role to mint the bucket access key with. */
  role: BucketKeyRole;
  /** Build the runtime client from the resolved credential accessors. */
  makeClient: (credentials: BucketCredentials) => Client;
}) =>
  Effect.gen(function* () {
    const Key = yield* BucketAccessKey;

    return Effect.fn(function* (bucket: Bucket) {
      const key = yield* Key(
        bucketAccessKeyLogicalId(bucket, options.capability),
        { bucket, role: options.role },
      );
      return options.makeClient({
        endpoint: yield* key.endpoint,
        bucketName: yield* key.bucketName,
        accessKeyId: yield* key.accessKeyId,
        secretAccessKey: yield* key.secretAccessKey,
      });
    });
  });

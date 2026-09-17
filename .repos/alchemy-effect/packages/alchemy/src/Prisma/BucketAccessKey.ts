import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import {
  attrOrRedactedString,
  attrOrString,
  devId,
  devProvider,
} from "./Internal/DevStub.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import type { Bucket } from "./Bucket.ts";
import {
  PrismaClient,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import { physicalInstanceName } from "./Internal/EnvName.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveBucketId,
  unresolvedBucketIdOf,
} from "./Refs.ts";
import type { BucketKey as ApiBucketKey, BucketKeyRole } from "./Types.ts";

export interface BucketAccessKeyProps {
  /**
   * Bucket ID or `bucket.bucketId` output this key grants access to.
   */
  bucket: string | Bucket;
  /**
   * Human-readable key name prefix. Alchemy appends the resource instance
   * identity so an interrupted create can be recovered by name instead of
   * minting a second, unenumerable key.
   *
   * @default the resource's logical ID
   */
  name?: string;
  /**
   * Access role for the key: `"read"` or `"read_write"`.
   */
  role: BucketKeyRole;
}

export interface BucketAccessKey extends Resource<
  "Prisma.BucketAccessKey",
  BucketAccessKeyProps,
  {
    /**
     * Prisma bucket key ID.
     */
    bucketAccessKeyId: string;
    /**
     * Bucket ID the key belongs to, persisted so deletion can address both
     * path parameters.
     */
    bucketId: string;
    /**
     * S3 access key ID.
     */
    accessKeyId: string;
    /**
     * S3 secret access key, redacted in state. Prisma returns it exactly
     * once at creation and never again, so the persisted state is the
     * authoritative copy.
     */
    secretAccessKey: Redacted.Redacted<string>;
    /**
     * S3-compatible endpoint URL for the bucket's region.
     */
    endpoint: string;
    /**
     * Provider-side S3 bucket name (e.g. `user-<id>`). S3 clients must use
     * this as the bucket name, not the display name chosen on the bucket.
     */
    bucketName: string;
  },
  never,
  Providers
> {}

/**
 * An access key for a Prisma Object Store bucket, yielding S3 credentials.
 *
 * Prisma returns the secret access key only in the create response, so
 * Alchemy stores it as a `Redacted` value and treats persisted state as
 * authoritative: once created, the secret is never re-read from the API.
 * Changing the bucket, name, or role replaces the key with fresh
 * credentials.
 *
 * ### Creating a Bucket Access Key
 * **Example:** Read-write credentials for a bucket
 * ```typescript
 * const key = yield* Prisma.BucketAccessKey("uploads-key", {
 *   bucket,
 *   role: "read_write",
 * });
 * ```
 *
 * ### Binding to Platforms
 * **Example:** Pass S3 credentials to Compute env
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   env: {
 *     S3_ENDPOINT: key.endpoint,
 *     S3_BUCKET: key.bucketName,
 *     S3_ACCESS_KEY_ID: key.accessKeyId,
 *     S3_SECRET_ACCESS_KEY: key.secretAccessKey,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const BucketAccessKey = Resource<BucketAccessKey>(
  "Prisma.BucketAccessKey",
);

const BUCKET_ACCESS_KEY_STABLES = [
  "bucketAccessKeyId",
  "bucketId",
  "accessKeyId",
  "secretAccessKey",
  "endpoint",
  "bucketName",
] satisfies Extract<keyof BucketAccessKey["Attributes"], string>[];

/**
 * Raised when more than one key on a bucket carries the deterministic name
 * of a single resource instance, so no key can be recovered unambiguously.
 */
export class AmbiguousBucketAccessKeyError extends Data.TaggedError(
  "AmbiguousBucketAccessKeyError",
)<{
  bucketId: string;
  name: string;
  count: number;
  message: string;
}> {}

const listKeys = (client: PrismaManagementClient, bucketId: string) =>
  client
    .listBucketKeys(bucketId, { limit: 100 })
    .pipe(Effect.catchIf(isNotFound, () => Effect.succeed([])));

const uniqueKeyNamed = (
  client: PrismaManagementClient,
  bucketId: string,
  expectedName: string,
) =>
  listKeys(client, bucketId).pipe(
    Effect.flatMap((keys) => {
      const matches = keys.filter(
        (key: ApiBucketKey) => key.name === expectedName,
      );
      return matches.length > 1
        ? Effect.fail(
            new AmbiguousBucketAccessKeyError({
              bucketId,
              name: expectedName,
              count: matches.length,
              message: `Prisma bucket '${bucketId}' has ${matches.length} keys named '${expectedName}'; refusing to select one arbitrarily`,
            }),
          )
        : Effect.succeed(matches[0]);
    }),
  );

const ProviderLive = () =>
  Provider.effect(
    BucketAccessKey,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: BUCKET_ACCESS_KEY_STABLES,
        // Bucket keys cannot be listed account-wide, and bucket deletion
        // revokes them server-side, so nuke has nothing to enumerate here.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.bucketAccessKeyId)) {
            return { action: "update" } as const;
          }
          const oldBucketId =
            output?.bucketId ?? unresolvedBucketIdOf(olds.bucket);
          const newBucketId = isResolved(news.bucket)
            ? unresolvedBucketIdOf(news.bucket)
            : undefined;
          if (concreteIdsChanged(oldBucketId, newBucketId)) {
            return { action: "replace" } as const;
          }
          // A key's name and role are fixed at creation, so changes replace
          // the key and mint fresh credentials.
          if (isResolved(news.role) && news.role !== olds.role) {
            return { action: "replace" } as const;
          }
          if (
            isResolved(news.name) &&
            news.name !== undefined &&
            news.name !== olds.name
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          // The secret access key can never be re-read from the API, so the
          // persisted state stays authoritative for credentials; the list
          // endpoint only confirms the key still exists.
          if (!output || isPrismaDevId(output.bucketAccessKeyId)) return output;
          const keys = yield* listKeys(client, output.bucketId);
          return keys.some(
            (key: ApiBucketKey) => key.id === output.bucketAccessKeyId,
          )
            ? output
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          const persisted =
            output && !isPrismaDevId(output.bucketAccessKeyId)
              ? output
              : undefined;
          if (persisted) {
            // Prisma returns the secret exactly once, at creation. Persisted
            // state is authoritative afterwards — but only while the key
            // still exists; a revoked key falls through to mint fresh
            // credentials.
            const keys = yield* listKeys(client, persisted.bucketId);
            if (
              keys.some(
                (key: ApiBucketKey) => key.id === persisted.bucketAccessKeyId,
              )
            ) {
              return persisted;
            }
          }
          const bucketId = yield* resolveBucketId(news.bucket);
          const expectedName = physicalInstanceName(
            news.name ?? id,
            instanceId,
          );
          // A crash after create but before state persist leaves a key under
          // the deterministic name whose secret was never persisted and can
          // never be recovered. Revoke it and mint a fresh key rather than
          // leaking an unusable credential.
          const orphan = yield* uniqueKeyNamed(client, bucketId, expectedName);
          if (orphan) {
            yield* client
              .deleteBucketKey(bucketId, orphan.id)
              .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          }
          const created = yield* client.createBucketKey(bucketId, {
            name: expectedName,
            role: news.role,
          });
          return {
            bucketAccessKeyId: created.id,
            bucketId,
            accessKeyId: created.accessKeyId,
            secretAccessKey: Redacted.make(created.secretAccessKey),
            endpoint: created.endpoint,
            bucketName: created.bucketName,
          } satisfies BucketAccessKey["Attributes"];
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.bucketAccessKeyId)) return;
          // Bucket deletion revokes remaining keys server-side, so the key
          // may already be gone when the bucket was destroyed first.
          yield* client
            .deleteBucketKey(output.bucketId, output.bucketAccessKeyId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(
    BucketAccessKey,
    BUCKET_ACCESS_KEY_STABLES,
    ({ id, news, output }) => ({
      bucketAccessKeyId: devId("bucket-access-key", id),
      bucketId: attrOrString(news.bucket, "bucketId") ?? devId("bucket", id),
      accessKeyId: devId("access-key", id),
      // Keep the fabricated secret stable across dev reconciles, mirroring
      // the reveal-once live behavior where persisted state is authoritative.
      secretAccessKey:
        attrOrRedactedString(output, "secretAccessKey") ??
        Redacted.make(devId("secret-access-key", id)),
      endpoint: "http://localhost",
      bucketName: `dev-${id}`,
    }),
  );

export const BucketAccessKeyProvider = () =>
  ProviderLayer.dual(BucketAccessKey, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });

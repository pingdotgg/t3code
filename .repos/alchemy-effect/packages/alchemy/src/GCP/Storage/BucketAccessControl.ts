import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { DeleteNotConfirmed } from "../Errors.ts";
import type { Providers } from "../Providers.ts";
import {
  isUserManagedAclEntity,
  listAlchemyBuckets,
  normalizeEntity,
  normalizeRole,
} from "./internal.ts";

export type BucketAccessControlProps = {
  /**
   * Name of the bucket this ACL entry is attached to. Immutable —
   * changing it replaces the entry.
   */
  bucketName: string;
  /**
   * Principal granted the role. Forms include `user-{email}`,
   * `group-{email}`, `domain-{domain}`, `allUsers`, and
   * `allAuthenticatedUsers`. Immutable — changing it replaces the entry.
   */
  entity: string;
  /**
   * Access permission for the entity (`OWNER`, `WRITER`, or `READER`).
   */
  role: string;
};

export type BucketAccessControl = Resource<
  "GCP.Storage.BucketAccessControl",
  BucketAccessControlProps,
  {
    /** Parent bucket name. */
    bucketName: string;
    /** Principal granted the role. */
    entity: string;
    /** Access permission (`OWNER`, `WRITER`, or `READER`). */
    role: string;
    /** Server-assigned ACL id. */
    id: string | undefined;
    /** Domain associated with the entity, if any. */
    domain: string | undefined;
    /** Email associated with the entity, if any. */
    email: string | undefined;
    /** Numeric entity id, if any. */
    entityId: string | undefined;
    /** HTTP etag. */
    etag: string | undefined;
    /** GCS self-link. */
    selfLink: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Storage bucket ACL entry.
 *
 * Fine-grained ACLs are identity `(bucket, entity)`. Role is mutable;
 * changing `bucketName` or `entity` replaces the entry. Entries have no
 * labels field, so `list` / `pnpm nuke:gcp` discover them by enumerating
 * alchemy-labeled buckets and skipping project-team defaults.
 *
 * Uniform bucket-level access buckets do not support bucket ACLs.
 *
 * ### Creating a Bucket ACL
 * **Example:** Grant a service account writer access
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("assets", {
 *   forceDestroy: true,
 * });
 * const acl = yield* GCP.Storage.BucketAccessControl("writer", {
 *   bucketName: bucket.bucketName,
 *   entity: "user-app@project.iam.gserviceaccount.com",
 *   role: "WRITER",
 * });
 * ```
 *
 * **Example:** Update the role
 * ```typescript
 * const acl = yield* GCP.Storage.BucketAccessControl("writer", {
 *   bucketName: bucket.bucketName,
 *   entity: "user-app@project.iam.gserviceaccount.com",
 *   role: "READER",
 * });
 * ```
 *
 * @resource
 * @category Storage
 */
export const BucketAccessControl = Resource<BucketAccessControl>(
  "GCP.Storage.BucketAccessControl",
);

export class BucketAccessControlNotResolved extends Data.TaggedError(
  "GCP.Storage.BucketAccessControlNotResolved",
)<{
  bucketName: string;
  entity: string;
}> {}

const toAttrs = (acl: storage.BucketAccessControl, bucketName: string) => ({
  bucketName: acl.bucket ?? bucketName,
  entity: acl.entity ?? "",
  role: acl.role ?? "",
  id: acl.id,
  domain: acl.domain,
  email: acl.email,
  entityId: acl.entityId,
  etag: acl.etag,
  selfLink: acl.selfLink,
});

const getByEntity = (bucketName: string, entity: string) =>
  storage
    .getBucketAccessControls({ bucket: bucketName, entity })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOnBucket = (bucketName: string) =>
  storage.listBucketAccessControls({ bucket: bucketName }).pipe(
    Effect.map((page) => page.items ?? []),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as storage.BucketAccessControl[]),
    ),
  );

const waitUntilGone = (bucketName: string, entity: string) =>
  getByEntity(bucketName, entity).pipe(
    Effect.map((existing) =>
      existing === undefined ? ("gone" as const) : ("found" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 30,
    }),
    Effect.flatMap((status): Effect.Effect<void, DeleteNotConfirmed> =>
      status === "gone"
        ? Effect.void
        : Effect.fail(
            new DeleteNotConfirmed({ resource: `${bucketName}/acl/${entity}` }),
          ),
    ),
  );

export const BucketAccessControlProvider = () =>
  Provider.succeed(BucketAccessControl, {
    stables: ["bucketName", "entity", "id", "selfLink"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousBucket = olds?.bucketName ?? output?.bucketName;
      const previousEntity = olds?.entity ?? output?.entity;
      if (previousBucket !== undefined && news.bucketName !== previousBucket) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (
        previousEntity !== undefined &&
        normalizeEntity(news.entity) !== normalizeEntity(previousEntity)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const bucketName = olds?.bucketName ?? output?.bucketName;
      const entity = olds?.entity ?? output?.entity;
      if (!bucketName || !entity) return undefined;
      const existing = yield* getByEntity(bucketName, entity);
      if (existing === undefined) return undefined;
      return toAttrs(existing, bucketName);
    }),

    list: () =>
      Effect.gen(function* () {
        const buckets = yield* listAlchemyBuckets();
        const pages = yield* Effect.forEach(
          buckets,
          (bucket) => {
            const bucketName = bucket.name;
            // Legacy ACL APIs reject uniform bucket-level access buckets.
            if (
              !bucketName ||
              bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled ===
                true
            ) {
              return Effect.succeed(
                [] as Array<BucketAccessControl["Attributes"]>,
              );
            }
            return listOnBucket(bucketName).pipe(
              Effect.map((items) =>
                items
                  .filter((item) => isUserManagedAclEntity(item.entity))
                  .map((item) => toAttrs(item, bucketName)),
              ),
            );
          },
          { concurrency: 8 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const bucketName = news.bucketName;
      const entity = normalizeEntity(news.entity);
      const role = normalizeRole(news.role);

      let current =
        output?.entity !== undefined
          ? yield* getByEntity(
              output.bucketName ?? bucketName,
              normalizeEntity(output.entity),
            )
          : undefined;
      if (current === undefined) {
        current = yield* getByEntity(bucketName, entity);
      }

      if (current === undefined) {
        const created = yield* storage
          .insertBucketAccessControls({
            bucket: bucketName,
            body: { entity, role },
          })
          .pipe(
            Effect.catchTag("Conflict", () => getByEntity(bucketName, entity)),
          );
        current = created ?? undefined;
      }

      if (current === undefined || !current.entity) {
        return yield* new BucketAccessControlNotResolved({
          bucketName,
          entity,
        });
      }

      if (normalizeRole(current.role ?? "") !== role) {
        current = yield* storage.patchBucketAccessControls({
          bucket: bucketName,
          entity,
          body: { entity, role },
        });
      }

      return toAttrs(current, bucketName);
    }),

    delete: Effect.fn(function* ({ output }) {
      const bucketName = output.bucketName;
      const entity = output.entity;
      if (!bucketName || !entity) return;
      yield* storage
        .deleteBucketAccessControls({ bucket: bucketName, entity })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(bucketName, entity);
    }),
  });

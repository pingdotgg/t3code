import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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

export type ObjectAccessControlProps = {
  /**
   * Name of the bucket that contains the object. Immutable — changing it
   * replaces the entry.
   */
  bucketName: string;
  /**
   * Object name this ACL entry is attached to. Immutable — changing it
   * replaces the entry.
   */
  object: string;
  /**
   * Principal granted the role. Forms include `user-{email}`,
   * `group-{email}`, `domain-{domain}`, `allUsers`, and
   * `allAuthenticatedUsers`. Immutable — changing it replaces the entry.
   */
  entity: string;
  /**
   * Access permission for the entity (`OWNER` or `READER`).
   */
  role: string;
  /**
   * Object generation. When omitted, the live generation is used.
   * Immutable — changing it replaces the entry.
   */
  generation?: string;
};

export type ObjectAccessControl = Resource<
  "GCP.Storage.ObjectAccessControl",
  ObjectAccessControlProps,
  {
    /** Parent bucket name. */
    bucketName: string;
    /** Object name. */
    object: string;
    /** Principal granted the role. */
    entity: string;
    /** Access permission (`OWNER` or `READER`). */
    role: string;
    /** Object generation, if the entry is generation-scoped. */
    generation: string | undefined;
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
 * A Cloud Storage object ACL entry.
 *
 * Fine-grained object ACLs are identity `(bucket, object, entity)`. Role
 * is mutable; changing `bucketName`, `object`, or `entity` replaces the
 * entry. Entries have no labels field, so `list` / `pnpm nuke:gcp`
 * discover them by enumerating objects in alchemy-labeled buckets and
 * skipping project-team and numeric-owner defaults.
 *
 * Uniform bucket-level access buckets do not support object ACLs.
 *
 * ### Creating an Object ACL
 * **Example:** Grant a service account reader access
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("assets", {
 *   forceDestroy: true,
 * });
 * const acl = yield* GCP.Storage.ObjectAccessControl("reader", {
 *   bucketName: bucket.bucketName,
 *   object: "hello.txt",
 *   entity: "user-app@project.iam.gserviceaccount.com",
 *   role: "READER",
 * });
 * ```
 *
 * **Example:** Update the role
 * ```typescript
 * const acl = yield* GCP.Storage.ObjectAccessControl("reader", {
 *   bucketName: bucket.bucketName,
 *   object: "hello.txt",
 *   entity: "user-app@project.iam.gserviceaccount.com",
 *   role: "OWNER",
 * });
 * ```
 *
 * @resource
 * @category Storage
 */
export const ObjectAccessControl = Resource<ObjectAccessControl>(
  "GCP.Storage.ObjectAccessControl",
);

export class ObjectAccessControlNotResolved extends Data.TaggedError(
  "GCP.Storage.ObjectAccessControlNotResolved",
)<{
  bucketName: string;
  object: string;
  entity: string;
}> {}

const toAttrs = (
  acl: storage.ObjectAccessControl,
  bucketName: string,
  object: string,
) => ({
  bucketName: acl.bucket ?? bucketName,
  object: acl.object ?? object,
  entity: acl.entity ?? "",
  role: acl.role ?? "",
  generation: acl.generation,
  id: acl.id,
  domain: acl.domain,
  email: acl.email,
  entityId: acl.entityId,
  etag: acl.etag,
  selfLink: acl.selfLink,
});

const getByEntity = (
  bucketName: string,
  object: string,
  entity: string,
  generation?: string,
) =>
  storage
    .getObjectAccessControls({
      bucket: bucketName,
      object,
      entity,
      generation,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOnObject = (bucketName: string, object: string) =>
  storage.listObjectAccessControls({ bucket: bucketName, object }).pipe(
    Effect.map((page) => page.items ?? []),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as storage.ObjectAccessControl[]),
    ),
  );

const listObjectsOnBucket = (bucketName: string) =>
  storage.listObjects.items({ bucket: bucketName, maxResults: 1000 }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as storage.Storage_Object[]),
    ),
  );

const waitUntilGone = (
  bucketName: string,
  object: string,
  entity: string,
  generation?: string,
) =>
  getByEntity(bucketName, object, entity, generation).pipe(
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
            new DeleteNotConfirmed({
              resource: `${bucketName}/o/${object}/acl/${entity}`,
            }),
          ),
    ),
  );

export const ObjectAccessControlProvider = () =>
  Provider.succeed(ObjectAccessControl, {
    stables: ["bucketName", "object", "entity", "generation", "id", "selfLink"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousBucket = olds?.bucketName ?? output?.bucketName;
      const previousObject = olds?.object ?? output?.object;
      const previousEntity = olds?.entity ?? output?.entity;
      const previousGeneration = olds?.generation ?? output?.generation;
      if (previousBucket !== undefined && news.bucketName !== previousBucket) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (previousObject !== undefined && news.object !== previousObject) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (
        previousEntity !== undefined &&
        normalizeEntity(news.entity) !== normalizeEntity(previousEntity)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (
        news.generation !== undefined &&
        previousGeneration !== undefined &&
        news.generation !== previousGeneration
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const bucketName = olds?.bucketName ?? output?.bucketName;
      const object = olds?.object ?? output?.object;
      const entity = olds?.entity ?? output?.entity;
      if (!bucketName || !object || !entity) return undefined;
      const generation = olds?.generation ?? output?.generation;
      const existing = yield* getByEntity(
        bucketName,
        object,
        entity,
        generation,
      );
      if (existing === undefined) return undefined;
      return toAttrs(existing, bucketName, object);
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
                [] as Array<ObjectAccessControl["Attributes"]>,
              );
            }
            return listObjectsOnBucket(bucketName).pipe(
              Effect.flatMap((objects) =>
                Effect.forEach(
                  objects,
                  (object) => {
                    const objectName = object.name;
                    if (!objectName) {
                      return Effect.succeed(
                        [] as Array<ObjectAccessControl["Attributes"]>,
                      );
                    }
                    return listOnObject(bucketName, objectName).pipe(
                      Effect.map((items) =>
                        items
                          .filter((item) => isUserManagedAclEntity(item.entity))
                          .map((item) => toAttrs(item, bucketName, objectName)),
                      ),
                    );
                  },
                  { concurrency: 8 },
                ),
              ),
              Effect.map((nested) => nested.flat()),
            );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const bucketName = news.bucketName;
      const object = news.object;
      const entity = normalizeEntity(news.entity);
      const role = normalizeRole(news.role);
      const generation = news.generation;

      let current =
        output?.entity !== undefined && output.object !== undefined
          ? yield* getByEntity(
              output.bucketName ?? bucketName,
              output.object,
              normalizeEntity(output.entity),
              output.generation,
            )
          : undefined;
      if (current === undefined) {
        current = yield* getByEntity(bucketName, object, entity, generation);
      }

      if (current === undefined) {
        const created = yield* storage
          .insertObjectAccessControls({
            bucket: bucketName,
            object,
            generation,
            body: { entity, role },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByEntity(bucketName, object, entity, generation),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined || !current.entity) {
        return yield* new ObjectAccessControlNotResolved({
          bucketName,
          object,
          entity,
        });
      }

      if (normalizeRole(current.role ?? "") !== role) {
        current = yield* storage.patchObjectAccessControls({
          bucket: bucketName,
          object,
          entity,
          generation,
          body: { entity, role },
        });
      }

      return toAttrs(current, bucketName, object);
    }),

    delete: Effect.fn(function* ({ output }) {
      const bucketName = output.bucketName;
      const object = output.object;
      const entity = output.entity;
      if (!bucketName || !object || !entity) return;
      const removed = yield* storage
        .deleteObjectAccessControls({
          bucket: bucketName,
          object,
          entity,
          generation: output.generation,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          // GCS refuses to drop the last OWNER ACL on an object.
          Effect.catchTag("ObjectOwnerAclRequired", () =>
            Effect.succeed(false),
          ),
        );
      if (removed) {
        yield* waitUntilGone(bucketName, object, entity, output.generation);
      }
    }),
  });

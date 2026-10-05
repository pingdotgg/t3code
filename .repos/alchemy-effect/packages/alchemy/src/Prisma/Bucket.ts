import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import {
  DEV_TIMESTAMP,
  attrOrString,
  devId,
  devProvider,
} from "./Internal/DevStub.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import {
  type GetBucketsResponse,
  deleteBucket,
  getBuckets,
  getBucket,
  createBucket,
} from "@distilled.cloud/prisma/management";
import { Retry } from "@distilled.cloud/prisma";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type { ObservedBucket } from "./Internal/Observed.ts";
import { PrismaPaginationError } from "./Internal/Pagination.ts";

export interface BucketProps {
  /**
   * Project ID or `project.projectId` output that owns this bucket.
   */
  project: string | Project;
  /**
   * Bucket display name. Prisma generates a name when omitted. The display
   * name is not the provider-side S3 bucket name — S3 clients must use the
   * `bucketName` attribute of `Prisma.BucketAccessKey`.
   */
  name?: string;
  /**
   * Branch ID to scope the bucket to, e.g. for per-branch preview storage.
   */
  branchId?: string;
}

export interface Bucket extends Resource<
  "Prisma.Bucket",
  BucketProps,
  {
    /**
     * Prisma bucket ID.
     */
    bucketId: string;
    /**
     * Bucket display name. Not the provider-side S3 bucket name; S3 clients
     * must use the `bucketName` attribute of `Prisma.BucketAccessKey`.
     */
    name: string;
    /**
     * Project ID that owns the bucket.
     */
    projectId: string;
    /**
     * ISO timestamp when the bucket was created.
     */
    createdAt: string;
  },
  never,
  Providers
> {}

/**
 * A Prisma Object Store bucket inside a Prisma project.
 *
 * Project, name, and branch changes replace the bucket because the
 * Management API has no bucket update operation. Destroying this resource
 * deletes the bucket, its objects, and any remaining access keys — the
 * Management API cascades the deletion server-side.
 *
 * ### Creating a Bucket
 * **Example:** Bucket in a project
 * ```typescript
 * const bucket = yield* Prisma.Bucket("uploads", {
 *   project,
 *   name: "uploads",
 * });
 * ```
 *
 * ### Accessing a Bucket
 * **Example:** S3 credentials for a bucket
 * ```typescript
 * const key = yield* Prisma.BucketAccessKey("uploads-key", {
 *   bucket,
 *   role: "read_write",
 * });
 * ```
 *
 * @resource
 * @product Bucket
 */
export const Bucket = Resource<Bucket>("Prisma.Bucket");

/**
 * The bucket the provider observed belongs to a different project than the
 * one requested or persisted. Convergence and deletion both refuse rather
 * than acting on a bucket that is not the one this resource manages.
 */
export class BucketProjectMismatchError extends Data.TaggedError(
  "BucketProjectMismatchError",
)<{
  bucketId: string;
  actualProjectId: string;
  expectedProjectId: string;
  message: string;
}> {}

const attrsFrom = (bucket: ObservedBucket): Bucket["Attributes"] => ({
  bucketId: bucket.id,
  name: bucket.name,
  projectId: bucket.project.id,
  createdAt: bucket.createdAt,
});

// Distilled emits the cursor-paginated list operations as plain ops, so
// callers walk `pagination` themselves (see `src/Neon/Project.ts`).
const listBuckets = () =>
  Effect.gen(function* () {
    const buckets: GetBucketsResponse["data"][number][] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getBuckets(cursor === undefined ? {} : { cursor });
      buckets.push(...page.data);
      const nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
      if (nextCursor === null) {
        return yield* Effect.fail(
          new PrismaPaginationError({
            message:
              "Invalid Prisma Management API pagination response from getBuckets: hasMore was true without a non-empty nextCursor",
          }),
        );
      }
      cursor = nextCursor;
    }
    return buckets;
  });

const ProviderLive = () =>
  Provider.effect(
    Bucket,
    Effect.gen(function* () {
      return {
        stables: ["bucketId"],
        list: () =>
          listBuckets().pipe(Effect.map((buckets) => buckets.map(attrsFrom))),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.bucketId)) {
            return { action: "update" } as const;
          }
          const oldProjectId =
            output?.projectId ?? unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          if (concreteIdsChanged(oldProjectId, newProjectId)) {
            return { action: "replace" } as const;
          }
          // Buckets have no update operation, so branch and name changes
          // replace the bucket (and its contents) rather than converging.
          if (
            isResolved(news.branchId) &&
            (news.branchId ?? undefined) !== (olds.branchId ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          if (
            isResolved(news.name) &&
            news.name !== undefined &&
            news.name !== (output?.name ?? olds.name)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          const bucketId = isPrismaDevId(output?.bucketId)
            ? undefined
            : output?.bucketId;
          if (!bucketId) return undefined;
          const bucket = yield* getBucket({ bucketId }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          return bucket ? attrsFrom(bucket) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const projectId = yield* resolveProjectId(news.project);
          const bucketId = isPrismaDevId(output?.bucketId)
            ? undefined
            : output?.bucketId;
          const observed = bucketId
            ? yield* getBucket({ bucketId }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : undefined;
          if (observed) {
            if (observed.project.id !== projectId) {
              return yield* new BucketProjectMismatchError({
                bucketId: observed.id,
                actualProjectId: observed.project.id,
                expectedProjectId: projectId,
                message: `Prisma bucket '${observed.id}' belongs to project '${observed.project.id}', not requested project '${projectId}'. Refusing to claim convergence; replace the bucket.`,
              });
            }
            return attrsFrom(observed);
          }
          const created = yield* createBucket({
            projectId,
            ...(news.name === undefined ? {} : { name: news.name }),
            ...(news.branchId === undefined || news.branchId === null
              ? {}
              : { branchId: news.branchId }),
          }).pipe(
            // A replayed create would make a second bucket; the retry policy
            // cannot see the request, so opt out explicitly.
            Retry.none,
            Effect.map((response) => response.data),
          );
          return attrsFrom(created);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.bucketId)) return;
          const bucket = yield* getBucket({
            bucketId: output.bucketId,
          }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (!bucket) return;
          if (bucket.project.id !== output.projectId) {
            return yield* new BucketProjectMismatchError({
              bucketId: bucket.id,
              actualProjectId: bucket.project.id,
              expectedProjectId: output.projectId,
              message: `Prisma bucket '${bucket.id}' no longer matches persisted project '${output.projectId}'. Refusing to delete a mismatched bucket.`,
            });
          }
          // Deletion cascades server-side: the Management API removes the
          // bucket together with its objects and any remaining keys.
          yield* deleteBucket({
            bucketId: output.bucketId,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(Bucket, ["bucketId"], ({ id, news }) => ({
    bucketId: devId("bucket", id),
    name: news.name ?? id,
    projectId: attrOrString(news.project, "projectId") ?? devId("project", id),
    createdAt: DEV_TIMESTAMP,
  }));

export const BucketProvider = () =>
  ProviderLayer.dual(Bucket, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });

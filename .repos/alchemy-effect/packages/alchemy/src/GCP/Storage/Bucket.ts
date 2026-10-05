import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type BucketProps = {
  /**
   * Globally-unique bucket name. If omitted, a unique name is generated from
   * the stack, stage, and logical id. Must be 3-63 characters, lowercase,
   * and DNS compatible.
   */
  bucketName?: string;
  /**
   * Location of the bucket (`US`, `EU`, `US-CENTRAL1`, …). Immutable —
   * changing it replaces the bucket.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Default storage class for new objects.
   * @default "STANDARD"
   */
  storageClass?: string;
  /**
   * Whether object versioning is enabled.
   * @default false
   */
  versioning?: boolean;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Delete all objects (and versions) before destroying the bucket.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Enable uniform bucket-level access. Required for managed folders.
   * Hierarchical namespace implies this is enabled. Fine-grained ACLs
   * cannot be used when this is true.
   * @default false
   */
  uniformBucketLevelAccess?: boolean;
  /**
   * Enable hierarchical namespace (first-class folders). Immutable —
   * must be set at create time; changing it replaces the bucket.
   * Implies uniform bucket-level access.
   * @default false
   */
  hierarchicalNamespace?: boolean;
  /**
   * Static website configuration. Cloud Storage applies it when the bucket
   * is served through a CNAME or an external HTTPS load balancer (backend
   * bucket) — not on `storage.googleapis.com/{bucket}/…` path-style URLs.
   * Omitting it removes the configuration.
   */
  website?: BucketWebsite;
};

export interface BucketWebsite {
  /**
   * Object suffix appended to directory-style requests, e.g. `index.html`
   * so `/docs/` serves `docs/index.html`.
   */
  mainPageSuffix?: string;
  /** Object served (with status 404) when a requested object is missing. */
  notFoundPage?: string;
}

export type Bucket = Resource<
  "GCP.Storage.Bucket",
  BucketProps,
  {
    /** Globally unique bucket name. */
    bucketName: string;
    /** Location of the bucket. */
    location: string;
    /** Location type (`region`, `multi-region`, `dual-region`). */
    locationType: string | undefined;
    /** Default storage class. */
    storageClass: string | undefined;
    /** Whether object versioning is enabled. */
    versioning: boolean;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** GCS self-link. */
    selfLink: string | undefined;
    /** Numeric project that owns the bucket. */
    projectNumber: string | undefined;
    /** RFC3339 creation timestamp. */
    timeCreated: string | undefined;
    /** Whether uniform bucket-level access is enabled. */
    uniformBucketLevelAccess: boolean;
    /** Whether hierarchical namespace is enabled. */
    hierarchicalNamespace: boolean;
    /** Static website configuration, if set. */
    website: BucketWebsite | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Storage bucket.
 *
 * ### Creating a Bucket
 * **Example:** Generated name
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("assets", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * **Example:** Explicit name, location, and labels
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("assets", {
 *   bucketName: "my-app-assets",
 *   location: "US-CENTRAL1",
 *   storageClass: "STANDARD",
 *   versioning: true,
 *   labels: { env: "prod" },
 *   forceDestroy: true,
 * });
 * ```
 *
 * **Example:** Hierarchical namespace (folders)
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("tree", {
 *   hierarchicalNamespace: true,
 *   uniformBucketLevelAccess: true,
 *   forceDestroy: true,
 * });
 * ```
 *
 * **Example:** Static website bucket with public read
 * ```typescript
 * const site = yield* GCP.Storage.Bucket("site", {
 *   uniformBucketLevelAccess: true,
 *   website: { mainPageSuffix: "index.html", notFoundPage: "404.html" },
 *   forceDestroy: true,
 * });
 * yield* GCP.IAM.Member("PublicRead", {
 *   kind: "storage.bucket",
 *   name: site.bucketName,
 *   role: "roles/storage.objectViewer",
 *   member: "allUsers",
 * });
 * ```
 *
 * ### Updating a Bucket
 * **Example:** Change labels
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("assets", {
 *   forceDestroy: true,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Binding from a Function
 * **Example:** PutObject from Cloud Run
 * ```typescript
 * export class Api extends GCP.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const bucket = yield* GCP.Storage.Bucket("assets", { forceDestroy: true });
 *     const putObject = yield* GCP.Storage.PutObject(bucket);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* putObject({ name: "hello.txt", body: "Hello!" }).pipe(
 *           Effect.orDie,
 *         );
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(Effect.provide([GCP.Storage.PutObjectHttp])),
 * ) {}
 * ```
 *
 * ### Destroying a Bucket
 * **Example:** Empty then delete
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("assets", {
 *   forceDestroy: true,
 * });
 * ```
 * `forceDestroy: true` deletes objects before the bucket. `alchemy destroy` waits until the bucket is gone.
 *
 * @resource
 * @category Storage
 */
export const Bucket = Resource<Bucket>("GCP.Storage.Bucket");

export class BucketNotResolved extends Data.TaggedError(
  "GCP.Storage.BucketNotResolved",
)<{
  bucketName: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }))
    );
  });

const toAttrs = (bucket: storage.Bucket) => ({
  bucketName: bucket.name ?? bucket.id ?? "",
  location: bucket.location ?? "",
  locationType: bucket.locationType,
  storageClass: bucket.storageClass,
  versioning: bucket.versioning?.enabled === true,
  labels: userLabels(bucket.labels),
  selfLink: bucket.selfLink,
  projectNumber: bucket.projectNumber,
  timeCreated: bucket.timeCreated,
  uniformBucketLevelAccess:
    bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled === true,
  hierarchicalNamespace: bucket.hierarchicalNamespace?.enabled === true,
  website: toWebsite(bucket.website),
});

const toWebsite = (
  website: storage.BucketWebsite | undefined,
): BucketWebsite | undefined =>
  website === undefined ||
  (website.mainPageSuffix === undefined && website.notFoundPage === undefined)
    ? undefined
    : {
        mainPageSuffix: website.mainPageSuffix,
        notFoundPage: website.notFoundPage,
      };

const getByName = (bucketName: string) =>
  storage
    .getBuckets({ bucket: bucketName, projection: "full" })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const emptyBucket = (bucketName: string) =>
  storage.listObjects
    .items({ bucket: bucketName, versions: true, maxResults: 1000 })
    .pipe(
      Stream.runCollect,
      Effect.flatMap((chunk) =>
        Effect.forEach(
          chunk,
          (object) =>
            object.name
              ? storage
                  .deleteObjects({
                    bucket: bucketName,
                    object: object.name,
                    generation: object.generation,
                  })
                  .pipe(Effect.catchTag("NotFound", () => Effect.void))
              : Effect.void,
          { concurrency: 8 },
        ),
      ),
      Effect.catchTag("NotFound", () => Effect.void),
    );

const emptyFolders = (bucketName: string) =>
  storage.listFolders.items({ bucket: bucketName, pageSize: 1000 }).pipe(
    Stream.runCollect,
    Effect.flatMap((chunk) => {
      const folders = Array.from(chunk)
        .map((folder) => folder.name)
        .filter((name): name is string => !!name)
        .sort((left, right) => right.length - left.length);
      return Effect.forEach(
        folders,
        (folder) =>
          storage
            .deleteFolders({ bucket: bucketName, folder })
            .pipe(Effect.catchTag("NotFound", () => Effect.void)),
        { concurrency: 1 },
      );
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );

const emptyManagedFolders = (bucketName: string) =>
  storage.listManagedFolders.items({ bucket: bucketName, pageSize: 1000 }).pipe(
    Stream.runCollect,
    Effect.flatMap((chunk) => {
      const folders = Array.from(chunk)
        .map((folder) => folder.name)
        .filter((name): name is string => !!name)
        .sort((left, right) => right.length - left.length);
      return Effect.forEach(
        folders,
        (managedFolder) =>
          storage
            .deleteManagedFolders({
              bucket: bucketName,
              managedFolder,
              allowNonEmpty: true,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void)),
        { concurrency: 1 },
      );
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );

export const BucketProvider = () =>
  Provider.succeed(Bucket, {
    stables: [
      "bucketName",
      "location",
      "locationType",
      "projectNumber",
      "timeCreated",
      "selfLink",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      // Bucket names are immutable: a new name is a new bucket, and the
      // old one must be deleted rather than left behind.
      const recordedName = output?.bucketName ?? olds?.bucketName;
      if (
        news.bucketName !== undefined &&
        recordedName !== undefined &&
        news.bucketName !== recordedName
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previous = olds?.location ?? output?.location;
      const next = news.location;
      if (
        previous !== undefined &&
        next !== undefined &&
        previous.toUpperCase() !== next.toUpperCase()
      ) {
        const previousName = olds?.bucketName ?? output?.bucketName;
        const nextName = news.bucketName ?? previousName;
        return {
          action: "replace" as const,
          deleteFirst: nextName !== undefined && nextName === previousName,
        };
      }
      const previousHns =
        olds?.hierarchicalNamespace ?? output?.hierarchicalNamespace;
      const nextHns = news.hierarchicalNamespace === true;
      if (previousHns !== undefined && previousHns !== nextHns) {
        const previousName = olds?.bucketName ?? output?.bucketName;
        const nextName = news.bucketName ?? previousName;
        return {
          action: "replace" as const,
          deleteFirst: nextName !== undefined && nextName === previousName,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const bucketName = yield* toName(
        id,
        olds?.bucketName,
        output?.bucketName,
      );
      const existing = yield* getByName(bucketName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* storage.listBuckets
          .items({ project: env.project, projection: "full" })
          .pipe(
            Stream.filter((bucket) =>
              Object.keys(bucket.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map(toAttrs),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const bucketName = yield* toName(id, news.bucketName, output?.bucketName);
      const location =
        news.location ?? output?.location ?? env.region.toUpperCase();
      const storageClass = news.storageClass ?? "STANDARD";
      const versioning = news.versioning === true;
      const hierarchicalNamespace = news.hierarchicalNamespace === true;
      const uniformBucketLevelAccess =
        news.uniformBucketLevelAccess === true || hierarchicalNamespace;
      const configureIam =
        news.uniformBucketLevelAccess !== undefined || hierarchicalNamespace;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredWebsite = toWebsite(news.website);

      let current = yield* getByName(bucketName);

      if (current === undefined) {
        const created = yield* storage
          .insertBuckets({
            project: env.project,
            projection: "full",
            body: {
              name: bucketName,
              location,
              storageClass,
              versioning: { enabled: versioning },
              labels: desiredLabels,
              hierarchicalNamespace: hierarchicalNamespace
                ? { enabled: true }
                : undefined,
              website: desiredWebsite,
              iamConfiguration: configureIam
                ? {
                    uniformBucketLevelAccess: {
                      enabled: uniformBucketLevelAccess,
                    },
                  }
                : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(bucketName)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BucketNotResolved({ bucketName });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const storageClassChanged =
        (current.storageClass ?? "STANDARD") !== storageClass;
      const versioningChanged =
        (current.versioning?.enabled === true) !== versioning;
      const ublChanged =
        configureIam &&
        (current.iamConfiguration?.uniformBucketLevelAccess?.enabled ===
          true) !==
          uniformBucketLevelAccess;
      const observedWebsite = toWebsite(current.website);
      const websiteChanged =
        observedWebsite?.mainPageSuffix !== desiredWebsite?.mainPageSuffix ||
        observedWebsite?.notFoundPage !== desiredWebsite?.notFoundPage;

      if (
        labelsChanged ||
        storageClassChanged ||
        versioningChanged ||
        ublChanged ||
        websiteChanged
      ) {
        const nextLabels: Record<string, string | null> = { ...desiredLabels };
        for (const key of removed) {
          nextLabels[key] = null;
        }
        current = yield* storage.patchBuckets({
          bucket: bucketName,
          projection: "full",
          body: {
            storageClass,
            versioning: { enabled: versioning },
            labels: nextLabels as unknown as Record<string, string>,
            iamConfiguration: ublChanged
              ? {
                  uniformBucketLevelAccess: {
                    enabled: uniformBucketLevelAccess,
                  },
                }
              : undefined,
            // PATCH merges nested objects and clears a field only when it
            // is sent as JSON null.
            website: websiteChanged
              ? ((desiredWebsite === undefined
                  ? null
                  : {
                      mainPageSuffix: desiredWebsite.mainPageSuffix ?? null,
                      notFoundPage: desiredWebsite.notFoundPage ?? null,
                    }) as unknown as storage.BucketWebsite)
              : undefined,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const mayEmpty = olds.forceDestroy === true || force === true;
      const empty = Effect.gen(function* () {
        yield* emptyBucket(output.bucketName);
        if (output.hierarchicalNamespace) {
          yield* emptyFolders(output.bucketName);
        }
        if (output.uniformBucketLevelAccess) {
          yield* emptyManagedFolders(output.bucketName);
        }
      });
      // A writer that is still running (e.g. a Dataflow job staging temp
      // files) can add objects between the empty and the delete, which fails
      // with 409 "not empty"; with forceDestroy, empty again and retry.
      yield* Effect.gen(function* () {
        if (mayEmpty) yield* empty;
        yield* storage
          .deleteBuckets({ bucket: output.bucketName })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }).pipe(
        Effect.retry({
          while: (error) => mayEmpty && error._tag === "Conflict",
          times: 6,
          schedule: Schedule.spaced("10 seconds"),
        }),
      );
    }),
  });

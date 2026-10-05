import * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  normalizeRegion,
  parseDescription,
  runRegionOp,
  sameJson,
  toPhysicalName,
} from "./internal.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type RegionBackendBucketProps = {
  /**
   * Name of the backend bucket. If omitted, a unique RFC1035 name is
   * generated from the stack, stage, and logical id. Changing this
   * replaces the resource.
   */
  name?: string;
  /**
   * Region the backend bucket lives in. Immutable — changing it replaces
   * the resource. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Cloud Storage bucket this backend serves. The bucket must already
   * exist in the same project.
   */
  bucketName: string;
  /**
   * Optional textual description. Alchemy ownership is stamped into the
   * stored description; this field is the user-facing portion.
   */
  description?: string;
  /**
   * Enable Cloud CDN for this backend bucket. Cannot be true when
   * `loadBalancingScheme` is `INTERNAL_MANAGED`.
   * @default false
   */
  enableCdn?: boolean;
  /**
   * Compress text responses using Brotli or gzip based on
   * `Accept-Encoding`.
   */
  compressionMode?: "AUTOMATIC" | "DISABLED";
  /**
   * Headers the Application Load Balancer should add to proxied
   * responses, e.g. `"X-Frame-Options: DENY"`.
   */
  customResponseHeaders?: string[];
  /**
   * Load balancing scheme. Regional backend buckets require this field;
   * Alchemy defaults it to `EXTERNAL_MANAGED`. Changing this replaces
   * the resource.
   * @default "EXTERNAL_MANAGED"
   */
  loadBalancingScheme?: "EXTERNAL_MANAGED" | "INTERNAL_MANAGED";
  /**
   * Cloud CDN policy. Only applied when set; omitted values leave the
   * observed policy in place.
   */
  cdnPolicy?: compute.BackendBucketCdnPolicy;
};

export type RegionBackendBucket = Resource<
  "GCP.Compute.RegionBackendBucket",
  RegionBackendBucketProps,
  {
    /** RFC1035 resource name. */
    name: string;
    /** Cloud Storage bucket name. */
    bucketName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User-facing description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Whether Cloud CDN is enabled. */
    enableCdn: boolean;
    /** Compression mode, if set. */
    compressionMode: string | undefined;
    /** Response headers added by the load balancer. */
    customResponseHeaders: string[];
    /** Load balancing scheme, if set. */
    loadBalancingScheme: string | undefined;
    /** Cloud CDN policy, if configured. */
    cdnPolicy: compute.BackendBucketCdnPolicy | undefined;
    /** Server-defined resource URL. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Server-assigned numeric id. */
    id: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine backend bucket that fronts a Cloud Storage
 * bucket for HTTP(S) load balancing.
 *
 * Compute Engine backend buckets have no labels field, so Alchemy
 * stamps ownership into the description (`[alchemy alchemy-stack=…
 * alchemy-stage=… alchemy-id=…]`) so `list` / `pnpm nuke:gcp` can find
 * them.
 *
 * ### Creating a Region Backend Bucket
 * **Example:** Generated name in front of a Storage bucket
 * ```typescript
 * const assets = yield* GCP.Storage.Bucket("assets", {
 *   forceDestroy: true,
 * });
 * const backend = yield* GCP.Compute.RegionBackendBucket("cdn", {
 *   bucketName: assets.bucketName,
 *   description: "static assets",
 * });
 * ```
 *
 * **Example:** Explicit name with Cloud CDN
 * ```typescript
 * const backend = yield* GCP.Compute.RegionBackendBucket("cdn", {
 *   name: "app-static",
 *   region: "us-central1",
 *   bucketName: assets.bucketName,
 *   enableCdn: true,
 *   compressionMode: "AUTOMATIC",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionBackendBucket = Resource<RegionBackendBucket>(
  "GCP.Compute.RegionBackendBucket",
);

export class RegionBackendBucketNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionBackendBucketNotResolved",
)<{
  name: string;
  region: string;
}> {}

const DEFAULT_LOAD_BALANCING_SCHEME = "EXTERNAL_MANAGED" as const;

const sameList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean => sameJson(left ?? [], right ?? []);

const normalizeCdnPolicy = (
  policy: compute.BackendBucketCdnPolicy | undefined,
): compute.BackendBucketCdnPolicy | undefined => {
  if (policy === undefined) return undefined;
  const { signedUrlKeyNames: _signed, ...rest } = policy;
  return rest;
};

const toAttrs = (
  bucket: compute.BackendBucket,
  project: string,
): RegionBackendBucket["Attributes"] => {
  const parsed = parseDescription(bucket.description);
  return {
    name: bucket.name ?? lastSegment(bucket.selfLink),
    bucketName: bucket.bucketName ?? "",
    project,
    region: lastSegment(bucket.region).toLowerCase(),
    description: parsed.description,
    enableCdn: bucket.enableCdn === true,
    compressionMode: bucket.compressionMode,
    customResponseHeaders: bucket.customResponseHeaders ?? [],
    loadBalancingScheme: bucket.loadBalancingScheme,
    cdnPolicy: bucket.cdnPolicy,
    selfLink: bucket.selfLink,
    creationTimestamp: bucket.creationTimestamp,
    id: bucket.id,
  };
};

const getByName = (project: string, region: string, name: string) =>
  compute
    .getRegionBackendBuckets({ project, region, backendBucket: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, region: string, name: string) =>
  getByName(project, region, name).pipe(
    Effect.flatMap((bucket) =>
      bucket !== undefined
        ? Effect.succeed(bucket)
        : Effect.fail(new RegionBackendBucketNotResolved({ name, region })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.RegionBackendBucketNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const RegionBackendBucketProvider = () =>
  Provider.succeed(RegionBackendBucket, {
    stables: [
      "name",
      "project",
      "region",
      "selfLink",
      "creationTimestamp",
      "id",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds?.name ?? output?.name;
      const nextName = news.name ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? (previousRegion || env.region),
        env.region,
      );
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const regionChanged =
        previousRegion.length > 0 && previousRegion !== nextRegion;
      const previousScheme =
        olds?.loadBalancingScheme ?? output?.loadBalancingScheme;
      const schemeChanged =
        news.loadBalancingScheme !== undefined &&
        (previousScheme ?? "") !== news.loadBalancingScheme;
      if (nameChanged || regionChanged || schemeChanged) {
        return {
          action: "replace" as const,
          deleteFirst:
            !nameChanged || nextName === undefined || nextName === previousName,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name = yield* toPhysicalName(
        id,
        olds?.name,
        output?.name,
        "backend",
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListBackendBuckets
          .pages({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.runCollect,
            Effect.catchTag("NotFound", () => Effect.succeed([] as never[])),
          );
        return Array.from(
          pages as readonly compute.BackendBucketAggregatedList[],
        ).flatMap((page) =>
          Object.entries(page.items ?? {}).flatMap(([scope, scoped]) => {
            if (!scope.startsWith("regions/")) return [];
            return (scoped?.backendBuckets ?? [])
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project));
          }),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const name = yield* toPhysicalName(
        id,
        news.name,
        output?.name,
        "backend",
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const enableCdn = news.enableCdn === true;
      const desiredHeaders = news.customResponseHeaders ?? [];

      let current = yield* getByName(env.project, region, name);

      if (current === undefined) {
        const insertBody: compute.BackendBucket = {
          name,
          bucketName: news.bucketName,
          description: desiredDescription,
          enableCdn,
          loadBalancingScheme:
            news.loadBalancingScheme ?? DEFAULT_LOAD_BALANCING_SCHEME,
        };
        if (
          news.compressionMode !== undefined &&
          (news.loadBalancingScheme ?? DEFAULT_LOAD_BALANCING_SCHEME) !==
            "EXTERNAL_MANAGED"
        ) {
          insertBody.compressionMode = news.compressionMode;
        }
        if (
          desiredHeaders.length > 0 &&
          (news.loadBalancingScheme ?? DEFAULT_LOAD_BALANCING_SCHEME) !==
            "EXTERNAL_MANAGED"
        ) {
          insertBody.customResponseHeaders = desiredHeaders;
        }
        if (news.cdnPolicy !== undefined) {
          insertBody.cdnPolicy = news.cdnPolicy;
        }
        yield* runRegionOp(
          env.project,
          region,
          compute.insertRegionBackendBuckets({
            project: env.project,
            region,
            body: insertBody,
          }),
          { ignoreAlreadyExists: true },
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = yield* awaitResource(env.project, region, name);
      }

      if (current === undefined) {
        return yield* new RegionBackendBucketNotResolved({ name, region });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const bucketChanged = (current.bucketName ?? "") !== news.bucketName;
      const cdnChanged = (current.enableCdn === true) !== enableCdn;
      const compressionChanged =
        news.compressionMode !== undefined &&
        (current.compressionMode ?? "") !== news.compressionMode;
      const headersChanged = !sameList(
        current.customResponseHeaders,
        desiredHeaders,
      );
      const policyChanged =
        news.cdnPolicy !== undefined &&
        !sameJson(
          normalizeCdnPolicy(current.cdnPolicy),
          normalizeCdnPolicy(news.cdnPolicy),
        );

      if (
        descriptionChanged ||
        bucketChanged ||
        cdnChanged ||
        compressionChanged ||
        headersChanged ||
        policyChanged
      ) {
        const patchBody: compute.BackendBucket = {
          bucketName: news.bucketName,
          description: desiredDescription,
          enableCdn,
        };
        if (
          news.compressionMode !== undefined &&
          (news.loadBalancingScheme ?? DEFAULT_LOAD_BALANCING_SCHEME) !==
            "EXTERNAL_MANAGED"
        ) {
          patchBody.compressionMode = news.compressionMode;
        }
        if (
          desiredHeaders.length > 0 &&
          (news.loadBalancingScheme ?? DEFAULT_LOAD_BALANCING_SCHEME) !==
            "EXTERNAL_MANAGED"
        ) {
          patchBody.customResponseHeaders = desiredHeaders;
        }
        if (news.cdnPolicy !== undefined) {
          patchBody.cdnPolicy = news.cdnPolicy;
        }
        yield* runRegionOp(
          env.project,
          region,
          compute.patchRegionBackendBuckets({
            project: env.project,
            region,
            backendBucket: name,
            body: patchBody,
          }),
        );
        current = (yield* getByName(env.project, region, name)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      yield* runRegionOp(
        env.project,
        region,
        compute.deleteRegionBackendBuckets({
          project: env.project,
          region,
          backendBucket: output.name,
        }),
        { ignoreNotFound: true },
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    }),
  });

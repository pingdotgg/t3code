import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type * as Cloudflare from "../Providers.ts";
import * as Zone from "../Zone/index.ts";
import { R2BucketBinding } from "./R2BucketBinding.ts";

export const isR2Bucket = (value: unknown): value is R2Bucket =>
  typeof value === "object" && (value as any)?.Type === "Cloudflare.R2Bucket";

export type R2BucketName = string;

export type R2BucketCustomDomainZone = Zone.ZoneReference;

export type R2BucketCustomDomain = {
  /**
   * Custom domain name to attach to the bucket.
   */
  name: string;
  /**
   * Zone that contains the custom domain. If omitted, the zone is inferred
   * from `domain`. Pass a zone ID string, a hostname in the zone, or any object
   * with a `zoneId` attribute such as `Cloudflare.Zone`.
   */
  zone?: R2BucketCustomDomainZone;
  /**
   * Whether public bucket access is enabled at this custom domain.
   * @default true
   */
  enabled?: boolean;
  /**
   * Allowlist of TLS ciphers in BoringSSL format.
   */
  ciphers?: string[];
  /**
   * Minimum TLS version accepted by the custom domain.
   * @default "1.0"
   */
  minTLS?: "1.0" | "1.1" | "1.2" | "1.3";
};

export type R2BucketLifecycleCondition =
  | {
      type: "Age";
      /**
       * Maximum age of an object, in seconds, before the rule's action applies.
       */
      maxAge: number;
    }
  | {
      type: "Date";
      /**
       * Absolute date (ISO 8601) at which the rule's action applies.
       */
      date: string;
    };

export type R2BucketLifecycleRule = {
  /**
   * Unique identifier for the rule within the bucket.
   */
  id: string;
  /**
   * Whether the rule is enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Object key prefix the rule applies to. Use `""` (or omit) to match all
   * objects in the bucket.
   * @default ""
   */
  prefix?: string;
  /**
   * Abort incomplete multipart uploads after the configured age.
   */
  abortMultipartUploadsTransition?: {
    condition?: { type: "Age"; maxAge: number };
  };
  /**
   * Delete matching objects after the configured age or on a specific date.
   */
  deleteObjectsTransition?: {
    condition?: R2BucketLifecycleCondition;
  };
  /**
   * Transition matching objects to a different storage class. Cloudflare R2
   * only supports transitioning to `InfrequentAccess` today.
   */
  storageClassTransitions?: {
    condition: R2BucketLifecycleCondition;
    storageClass: "InfrequentAccess";
  }[];
};

export type R2BucketProps = {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Storage class for newly uploaded objects.
   * @default "Standard"
   */
  storageClass?: R2Bucket.StorageClass;
  /**
   * Jurisdiction where objects in this bucket are guaranteed to be stored.
   * @default "default"
   */
  jurisdiction?: R2Bucket.Jurisdiction;
  /**
   * Location hint for the bucket.
   */
  locationHint?: R2Bucket.Location;
  /**
   * Custom domains to attach to the bucket. Pass an empty array (or omit)
   * to remove all custom domains.
   */
  domains?: R2BucketCustomDomain[];
  /**
   * Object lifecycle rules applied to the bucket. Pass an empty array (or
   * omit) to clear all lifecycle rules. See the Cloudflare R2 docs for
   * supported transitions.
   */
  lifecycleRules?: R2BucketLifecycleRule[];
};

export type R2Bucket = Resource<
  "Cloudflare.R2Bucket",
  R2BucketProps,
  {
    bucketName: R2BucketName;
    storageClass: R2Bucket.StorageClass;
    jurisdiction: R2Bucket.Jurisdiction;
    location: R2Bucket.Location | undefined;
    accountId: string;
    domains: R2Bucket.CustomDomain[];
    lifecycleRules: R2Bucket.LifecycleRule[];
  },
  never,
  Cloudflare.Providers
>;

/**
 * A Cloudflare R2 object storage bucket with S3-compatible API.
 *
 * R2 provides zero-egress-fee object storage. Create a bucket as a resource,
 * then bind it to a Worker to read and write objects at runtime.
 *
 * @section Creating a Bucket
 * @example Basic R2 bucket
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket");
 * ```
 *
 * @example Bucket with location hint
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   locationHint: "wnam",
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Reading and writing objects
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket.bind(MyBucket);
 *
 * // Write an object
 * yield* bucket.put("hello.txt", "Hello, World!");
 *
 * // Read an object
 * const object = yield* bucket.get("hello.txt");
 * if (object) {
 *   const text = yield* object.text();
 * }
 * ```
 *
 * @example Streaming upload with content length
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket.bind(MyBucket);
 *
 * yield* bucket.put("upload.bin", request.stream, {
 *   contentLength: Number(request.headers["content-length"] ?? 0),
 * });
 * ```
 *
 * @section Custom Domains
 *
 * Attach one or more custom domains to serve bucket objects from a hostname
 * you control. The domain's zone must already exist in your Cloudflare
 * account; the zone is inferred from the hostname when omitted, or you can
 * pass a `Cloudflare.Zone` resource, a zone ID, or any hostname inside the
 * zone via the `zone` field.
 *
 * @example Single custom domain
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   domains: [{ name: "assets.example.com" }],
 * });
 * ```
 *
 * @example Multiple custom domains
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   domains: [
 *     { name: "assets.example.com" },
 *     { name: "static.example.com" },
 *   ],
 * });
 * ```
 *
 * @example Disable a custom domain without removing it
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   domains: [{ name: "assets.example.com", enabled: false }],
 * });
 * ```
 *
 * @example Custom domain with explicit zone and TLS settings
 * ```typescript
 * const zone = yield* Cloudflare.Zone("ExampleZone", {
 *   name: "example.com",
 * });
 *
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   domains: [
 *     {
 *       name: "assets.example.com",
 *       zone,
 *       minTLS: "1.2",
 *     },
 *   ],
 * });
 * ```
 *
 * @section Object Lifecycle Rules
 *
 * Configure lifecycle rules to automatically delete objects, abort
 * incomplete multipart uploads, or transition objects to InfrequentAccess
 * storage. Pass an empty array (or omit) to clear all rules. See the
 * [Cloudflare R2 docs](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
 * for details and limits (max 1000 rules per bucket).
 *
 * @example Delete objects 30 days after upload
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   lifecycleRules: [
 *     {
 *       id: "expire-old-objects",
 *       deleteObjectsTransition: {
 *         condition: { type: "Age", maxAge: 60 * 60 * 24 * 30 },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @example Transition to InfrequentAccess after 60 days, delete after 365
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   lifecycleRules: [
 *     {
 *       id: "archive-then-delete",
 *       prefix: "logs/",
 *       storageClassTransitions: [
 *         {
 *           condition: { type: "Age", maxAge: 60 * 60 * 24 * 60 },
 *           storageClass: "InfrequentAccess",
 *         },
 *       ],
 *       deleteObjectsTransition: {
 *         condition: { type: "Age", maxAge: 60 * 60 * 24 * 365 },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @example Abort incomplete multipart uploads after 7 days
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("MyBucket", {
 *   lifecycleRules: [
 *     {
 *       id: "abort-stale-uploads",
 *       abortMultipartUploadsTransition: {
 *         condition: { type: "Age", maxAge: 60 * 60 * 24 * 7 },
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export const R2Bucket = Resource<R2Bucket>("Cloudflare.R2Bucket")({
  bind: R2BucketBinding.bind,
});

export declare namespace R2Bucket {
  export type StorageClass = "Standard" | "InfrequentAccess";
  export type Jurisdiction = "default" | "eu" | "fedramp";
  export type Location = "apac" | "eeur" | "enam" | "weur" | "wnam" | "oc";
  export type LifecycleRule = {
    id: string;
    enabled: boolean;
    prefix: string;
    abortMultipartUploadsTransition:
      | { condition: { type: "Age"; maxAge: number } | undefined }
      | undefined;
    deleteObjectsTransition:
      | { condition: R2BucketLifecycleCondition | undefined }
      | undefined;
    storageClassTransitions:
      | {
          condition: R2BucketLifecycleCondition;
          storageClass: "InfrequentAccess";
        }[]
      | undefined;
  };
  export type CustomDomain = {
    domain: string;
    zoneId: string | undefined;
    enabled: boolean;
    ciphers: string[] | undefined;
    minTLS: "1.0" | "1.1" | "1.2" | "1.3" | undefined;
    status:
      | {
          ownership:
            | "pending"
            | "active"
            | "deactivated"
            | "blocked"
            | "error"
            | "unknown";
          ssl:
            | "initializing"
            | "pending"
            | "active"
            | "deactivated"
            | "error"
            | "unknown";
        }
      | undefined;
  };
}

export const R2BucketProvider = () =>
  Provider.effect(
    R2Bucket,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createBucket = yield* r2.createBucket;
      const patchBucket = yield* r2.patchBucket;
      const deleteBucket = yield* r2.deleteBucket;
      const getBucket = yield* r2.getBucket;
      const deleteObjects = yield* r2.deleteObjects;
      const listBucketDomainCustoms = yield* r2.listBucketDomainCustoms;
      const createBucketDomainCustom = yield* r2.createBucketDomainCustom;
      const updateBucketDomainCustom = yield* r2.updateBucketDomainCustom;
      const deleteBucketDomainCustom = yield* r2.deleteBucketDomainCustom;
      const getBucketLifecycle = yield* r2.getBucketLifecycle;
      const putBucketLifecycle = yield* r2.putBucketLifecycle;

      const emptyBucket = (
        bucketName: string,
        jurisdiction: R2Bucket.Jurisdiction,
      ) =>
        r2.listObjects
          .items({
            accountId,
            bucketName,
            cfR2Jurisdiction: jurisdiction,
            perPage: 1000,
          })
          .pipe(
            Stream.filter(
              (o): o is typeof o & { key: string } =>
                typeof o.key === "string" && o.key !== "",
            ),
            Stream.map((o) => o.key),
            Stream.runForEachArray((chunk) =>
              deleteObjects({
                accountId,
                bucketName,
                cfR2Jurisdiction: jurisdiction,
                body: [...chunk],
              }),
            ),
            Effect.catchTag("NoSuchBucket", () => Effect.void),
          );

      const createBucketName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return (yield* createPhysicalName({
            id,
            maxLength: 63,
          })).toLowerCase();
        });

      const normalizeLocation = (
        location: string | undefined | null,
      ): R2Bucket.Location | undefined => {
        if (!location) return undefined;
        return location.toLowerCase() as R2Bucket.Location;
      };

      const listCustomDomains = (
        bucketName: string,
        jurisdiction: R2Bucket.Jurisdiction,
      ) =>
        listBucketDomainCustoms({
          accountId,
          bucketName,
          jurisdiction,
        }).pipe(
          Effect.retry({
            while: isNoSuchBucket,
            schedule: r2BucketEndpointConsistencySchedule,
          }),
          Effect.map((response) =>
            response.domains.map(toCustomDomainAttributes),
          ),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
        );

      const reconcileCustomDomains = (
        bucketName: string,
        jurisdiction: R2Bucket.Jurisdiction,
        desired: R2BucketCustomDomain[],
        previous: R2Bucket.CustomDomain[],
      ) =>
        Effect.gen(function* () {
          const observed = yield* listCustomDomains(bucketName, jurisdiction);
          if (!observed) {
            return yield* Effect.fail(
              new Error(
                `Cannot reconcile custom domains for missing R2 bucket "${bucketName}"`,
              ),
            );
          }
          const observedByDomain = new Map(
            observed.map((domain) => [domain.domain, domain]),
          );
          const desiredDomains = new Set(desired.map((domain) => domain.name));

          // Remove domains that are no longer desired. Domains that keep the
          // same hostname but move zones are intentionally skipped here and
          // handled in the per-domain flow below.
          yield* Effect.forEach(
            previous,
            (previousDomain) =>
              desiredDomains.has(previousDomain.domain)
                ? Effect.void
                : deleteBucketDomainCustom({
                    accountId,
                    bucketName,
                    domain: previousDomain.domain,
                    jurisdiction,
                  }).pipe(
                    Effect.catchIf(
                      isMissingCustomDomainOrBucket,
                      () => Effect.void,
                    ),
                  ),
            { concurrency: "unbounded" },
          );

          const applied = yield* Effect.forEach(
            desired,
            (domain) =>
              Effect.gen(function* () {
                const zoneId = yield* Zone.resolveZoneId({
                  accountId,
                  zone: domain.zone,
                  hostname: domain.name,
                });
                const observedDomain = observedByDomain.get(domain.name);

                if (
                  observedDomain &&
                  sameCustomDomainConfig(observedDomain, domain, zoneId)
                ) {
                  return observedDomain;
                }

                if (observedDomain && observedDomain.zoneId !== zoneId) {
                  // Cloudflare does not mutate the zone for an existing custom
                  // domain. This is not a duplicate of the stale-domain prune
                  // above: the hostname is still desired, so that prune skips it
                  // and this branch deletes only to recreate it in the new zone.
                  yield* deleteBucketDomainCustom({
                    accountId,
                    bucketName,
                    domain: domain.name,
                    jurisdiction,
                  }).pipe(
                    Effect.catchIf(
                      isMissingCustomDomainOrBucket,
                      () => Effect.void,
                    ),
                  );
                }

                if (!observedDomain || observedDomain.zoneId !== zoneId) {
                  const created = yield* createBucketDomainCustom({
                    accountId,
                    bucketName,
                    jurisdiction,
                    domain: domain.name,
                    enabled: domain.enabled ?? true,
                    zoneId,
                    ciphers: domain.ciphers,
                    minTLS: domain.minTLS,
                  }).pipe(
                    Effect.retry({
                      while: isNoSuchBucket,
                      schedule: r2BucketEndpointConsistencySchedule,
                    }),
                    Effect.retry({
                      while: isDomainInUseConflict,
                      schedule: r2CustomDomainConflictSchedule,
                    }),
                  );
                  return toCustomDomainAttributes({ ...created, zoneId });
                }

                const updated = yield* updateBucketDomainCustom({
                  accountId,
                  bucketName,
                  domain: domain.name,
                  jurisdiction,
                  enabled: domain.enabled ?? true,
                  ciphers: domain.ciphers,
                  minTLS: domain.minTLS,
                }).pipe(
                  Effect.retry({
                    while: isNoSuchBucket,
                    schedule: r2BucketEndpointConsistencySchedule,
                  }),
                );
                return toCustomDomainAttributes({
                  ...updated,
                  enabled: updated.enabled ?? domain.enabled ?? true,
                  zoneId,
                });
              }),
            { concurrency: "unbounded" },
          );

          return applied.sort((a, b) => a.domain.localeCompare(b.domain));
        });

      const reconcileLifecycleRules = (
        bucketName: string,
        jurisdiction: R2Bucket.Jurisdiction,
        desired: R2BucketLifecycleRule[],
      ) =>
        Effect.gen(function* () {
          const observed = yield* getBucketLifecycle({
            accountId,
            bucketName,
            jurisdiction,
          }).pipe(
            Effect.retry({
              while: isNoSuchBucket,
              schedule: r2BucketEndpointConsistencySchedule,
            }),
          );

          const observedRules = (observed.rules ?? []).map(toLifecycleRule);
          const desiredRules = desired.map(normalizeLifecycleRule);

          if (deepEqual(observedRules, desiredRules)) {
            return desiredRules;
          }

          yield* putBucketLifecycle({
            accountId,
            bucketName,
            jurisdiction,
            rules: desired.map(toLifecyclePutPayload),
          }).pipe(
            Effect.retry({
              while: isNoSuchBucket,
              schedule: r2BucketEndpointConsistencySchedule,
            }),
          );

          return desiredRules;
        });

      return {
        stables: ["bucketName", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          const name = yield* createBucketName(id, news.name);
          const oldName = output?.bucketName
            ? output.bucketName
            : yield* createBucketName(id, olds.name);
          const oldJurisdiction =
            output?.jurisdiction ?? olds.jurisdiction ?? "default";
          const oldStorageClass =
            output?.storageClass ?? olds.storageClass ?? "Standard";
          if (
            (output?.accountId ?? accountId) !== accountId ||
            oldName !== name ||
            oldJurisdiction !== (news.jurisdiction ?? "default") ||
            olds.locationHint !== news.locationHint
          ) {
            return { action: "replace" } as const;
          }
          if (oldStorageClass !== (news.storageClass ?? "Standard")) {
            return {
              action: "update",
              stables: oldName === name ? ["bucketName"] : undefined,
            } as const;
          }
          if (!deepEqual(olds.domains, news.domains)) {
            return { action: "update" } as const;
          }
          if (!deepEqual(olds.lifecycleRules, news.lifecycleRules)) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const name = yield* createBucketName(id, news.name);
          const acct = output?.accountId ?? accountId;
          const jurisdiction =
            output?.jurisdiction ?? news.jurisdiction ?? "default";

          // Observe — fetch the bucket. R2 reports a deleted bucket as
          // `NoSuchBucket`; tolerate that so the reconciler falls
          // through to the create path.
          let observed = yield* getBucket({
            accountId: acct,
            bucketName: name,
            jurisdiction,
          }).pipe(
            Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
          );

          // Ensure — create if missing. R2 reports a concurrent create
          // (or partial state-persistence failure) as
          // `BucketAlreadyExists`; tolerate by re-fetching the bucket.
          if (!observed) {
            observed = yield* createBucket({
              accountId: acct,
              name,
              storageClass: news.storageClass,
              jurisdiction: news.jurisdiction,
              locationHint: news.locationHint,
            }).pipe(
              Effect.catchTag("BucketAlreadyExists", () =>
                getBucket({
                  accountId: acct,
                  bucketName: name,
                  jurisdiction: news.jurisdiction,
                }),
              ),
            );
          }

          // Sync — storage class is the only mutable property; location
          // and jurisdiction are immutable (the diff function flags those
          // as `replace`). Only patch when the desired class drifts from
          // observed to avoid unnecessary API calls.
          const desiredStorageClass = news.storageClass ?? "Standard";
          const observedStorageClass = observed.storageClass ?? "Standard";
          if (observedStorageClass !== desiredStorageClass) {
            observed = yield* patchBucket({
              accountId: acct,
              bucketName: observed.name!,
              storageClass: desiredStorageClass,
              jurisdiction: observed.jurisdiction ?? jurisdiction,
            });
          }

          const attrs = {
            bucketName: observed.name!,
            // Distilled widened generated string enums to open unions.
            storageClass: (observed.storageClass ??
              "Standard") as R2Bucket.StorageClass,
            jurisdiction: (observed.jurisdiction ??
              "default") as R2Bucket.Jurisdiction,
            location: normalizeLocation(observed.location),
            accountId: acct,
          };

          const domains = yield* reconcileCustomDomains(
            attrs.bucketName,
            attrs.jurisdiction,
            news.domains ?? [],
            output?.domains ?? [],
          );

          const lifecycleRules = yield* reconcileLifecycleRules(
            attrs.bucketName,
            attrs.jurisdiction,
            news.lifecycleRules ?? [],
          );

          return {
            ...attrs,
            domains,
            lifecycleRules,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          for (const domain of output.domains ?? []) {
            yield* deleteBucketDomainCustom({
              accountId: output.accountId,
              bucketName: output.bucketName,
              domain: domain.domain,
              jurisdiction: output.jurisdiction,
            }).pipe(
              Effect.catchIf(isMissingCustomDomainOrBucket, () => Effect.void),
            );
          }
          yield* emptyBucket(output.bucketName, output.jurisdiction);
          yield* deleteBucket({
            accountId: output.accountId,
            bucketName: output.bucketName,
            jurisdiction: output.jurisdiction,
          }).pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const name =
            output?.bucketName ?? (yield* createBucketName(id, olds?.name));
          const acct = output?.accountId ?? accountId;
          return yield* getBucket({
            accountId: acct,
            bucketName: name,
            jurisdiction: output?.jurisdiction ?? olds?.jurisdiction,
          }).pipe(
            Effect.map((bucket) => ({
              bucketName: bucket.name!,
              // Distilled widened generated string enums to open unions.
              storageClass: (bucket.storageClass ??
                "Standard") as R2Bucket.StorageClass,
              jurisdiction: (bucket.jurisdiction ??
                "default") as R2Bucket.Jurisdiction,
              location: normalizeLocation(bucket.location),
              accountId: acct,
              domains: output?.domains ?? [],
              lifecycleRules: output?.lifecycleRules ?? [],
            })),
            Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );

// R2 can make a newly-created bucket visible to `getBucket` before its
// sub-resource endpoints (custom domains, lifecycle) accept it. Retry only
// that narrow `NoSuchBucket` lag here; not-found sub-resources are still
// treated as terminal for idempotent deletes.
const r2BucketEndpointConsistencySchedule = Schedule.exponential(100).pipe(
  Schedule.both(Schedule.recurs(5)),
);

// Distilled widened generated string enums to open unions (`string & {}`); the
// API only ever returns the known variants, narrowed in `toCustomDomainAttributes`.
type CustomDomainResponse = {
  domain: string;
  zoneId?: string | null;
  enabled?: boolean | null;
  ciphers?: string[] | null;
  minTLS?: string | null;
  status?: { ownership: string; ssl: string } | null;
};

const toCustomDomainAttributes = (
  domain: CustomDomainResponse,
): R2Bucket.CustomDomain => ({
  domain: domain.domain,
  zoneId: domain.zoneId ?? undefined,
  enabled: domain.enabled ?? true,
  ciphers: domain.ciphers ?? undefined,
  minTLS: (domain.minTLS ?? undefined) as R2Bucket.CustomDomain["minTLS"],
  status: (domain.status ?? undefined) as R2Bucket.CustomDomain["status"],
});

const sameCustomDomainConfig = (
  observed: R2Bucket.CustomDomain | undefined,
  desired: R2BucketCustomDomain,
  zoneId: string,
): boolean =>
  observed !== undefined &&
  observed.zoneId === zoneId &&
  observed.enabled === (desired.enabled ?? true) &&
  deepEqual(observed.ciphers, desired.ciphers) &&
  observed.minTLS === desired.minTLS;

const isMissingCustomDomainOrBucket = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (("status" in error && (error as { status: unknown }).status === 404) ||
    ("_tag" in error &&
      ((error as { _tag: unknown })._tag === "DomainNotFound" ||
        (error as { _tag: unknown })._tag === "NoSuchBucket")));

type LifecycleRuleResponse = NonNullable<
  r2.GetBucketLifecycleResponse["rules"]
>[number];

const toLifecycleRule = (
  rule: LifecycleRuleResponse,
): R2Bucket.LifecycleRule => ({
  id: rule.id,
  enabled: rule.enabled,
  prefix: rule.conditions.prefix ?? "",
  abortMultipartUploadsTransition: rule.abortMultipartUploadsTransition
    ? { condition: rule.abortMultipartUploadsTransition.condition ?? undefined }
    : undefined,
  deleteObjectsTransition: rule.deleteObjectsTransition
    ? { condition: rule.deleteObjectsTransition.condition ?? undefined }
    : undefined,
  storageClassTransitions: rule.storageClassTransitions ?? undefined,
});

const normalizeLifecycleRule = (
  rule: R2BucketLifecycleRule,
): R2Bucket.LifecycleRule => ({
  id: rule.id,
  enabled: rule.enabled ?? true,
  prefix: rule.prefix ?? "",
  abortMultipartUploadsTransition: rule.abortMultipartUploadsTransition
    ? { condition: rule.abortMultipartUploadsTransition.condition }
    : undefined,
  deleteObjectsTransition: rule.deleteObjectsTransition
    ? { condition: rule.deleteObjectsTransition.condition }
    : undefined,
  storageClassTransitions: rule.storageClassTransitions,
});

const toLifecyclePutPayload = (
  rule: R2BucketLifecycleRule,
): NonNullable<r2.PutBucketLifecycleRequest["rules"]>[number] => ({
  id: rule.id,
  enabled: rule.enabled ?? true,
  conditions: { prefix: rule.prefix ?? "" },
  abortMultipartUploadsTransition: rule.abortMultipartUploadsTransition,
  deleteObjectsTransition: rule.deleteObjectsTransition,
  storageClassTransitions: rule.storageClassTransitions,
});

const isNoSuchBucket = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { _tag: unknown })._tag === "NoSuchBucket";

// Cloudflare keys a custom domain to a single bucket at the zone level. After a
// domain is deleted, re-attaching the same hostname can transiently 409 with
// "Domain already in use" until the prior association is fully released. Treat
// that narrow conflict as eventual consistency and retry it on create.
const isDomainInUseConflict = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { _tag: unknown })._tag === "Conflict" &&
  "message" in error &&
  typeof (error as { message: unknown }).message === "string" &&
  (error as { message: string }).message.toLowerCase().includes("in use");

// Releasing a custom domain after delete can lag a few seconds, so give the
// conflict a longer, bounded budget than the bucket-endpoint lag above.
const r2CustomDomainConflictSchedule = Schedule.spaced("2 seconds").pipe(
  Schedule.both(Schedule.recurs(8)),
);

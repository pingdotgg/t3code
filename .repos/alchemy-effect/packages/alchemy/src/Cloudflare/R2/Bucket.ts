import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { deepEqual, isResolved } from "../../Diff.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { generateLocalId } from "../LocalRuntime.ts";
import type * as Cloudflare from "../Providers.ts";
import * as Zone from "../Zone/index.ts";

export const isBucket = (value: any): value is Bucket =>
  isResourceOfType(value, "Cloudflare.R2.Bucket");

export type BucketName = string;

export type BucketCustomDomainZone = Zone.Reference;

export type BucketCustomDomain = {
  /**
   * Custom domain name to attach to the bucket.
   */
  name: string;
  /**
   * Zone that contains the custom domain. If omitted, the zone is inferred
   * from `domain`. Pass a zone ID string, a hostname in the zone, or any object
   * with a `zoneId` attribute such as `Cloudflare.Zone.Zone`.
   */
  zone?: BucketCustomDomainZone;
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

export type BucketLifecycleCondition =
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

export type BucketLifecycleRule = {
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
    condition?: BucketLifecycleCondition;
  };
  /**
   * Transition matching objects to a different storage class. Cloudflare R2
   * only supports transitioning to `InfrequentAccess` today.
   */
  storageClassTransitions?: {
    condition: BucketLifecycleCondition;
    storageClass: "InfrequentAccess";
  }[];
};

export type BucketCorsRule = {
  /**
   * Optional label for this rule, shown in the Cloudflare dashboard. Not
   * used to correlate rules across updates — the CORS configuration is
   * always replaced as a whole.
   */
  id?: string;
  /**
   * HTTP methods browsers are allowed to use in cross-origin requests.
   */
  allowedMethods: ("GET" | "PUT" | "POST" | "DELETE" | "HEAD")[];
  /**
   * Origins allowed to make cross-origin requests, e.g.
   * `"https://example.com"`. Use `"*"` to allow any origin.
   */
  allowedOrigins: string[];
  /**
   * Request headers browsers are allowed to send, e.g. `"range"` for
   * range reads. If omitted, only simple headers are allowed.
   */
  allowedHeaders?: string[];
  /**
   * Response headers the browser is allowed to expose to the requesting
   * JavaScript, e.g. `"etag"` or `"content-range"`.
   */
  exposeHeaders?: string[];
  /**
   * How long (in seconds) browsers may cache CORS preflight responses.
   * Browsers may cap this at 2 hours or less, even if 86400 is specified.
   */
  maxAgeSeconds?: number;
};

export type BucketProps = {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Storage class for newly uploaded objects.
   * @default "Standard"
   */
  storageClass?: Bucket.StorageClass;
  /**
   * Jurisdiction where objects in this bucket are guaranteed to be stored.
   * @default "default"
   */
  jurisdiction?: Bucket.Jurisdiction;
  /**
   * Location hint for the bucket.
   */
  locationHint?: Bucket.Location;
  /**
   * Custom domains to attach to the bucket. Pass an empty array (or omit)
   * to remove all custom domains.
   */
  domains?: BucketCustomDomain[];
  /**
   * Whether the bucket is publicly readable at Cloudflare's managed
   * `r2.dev` domain. Cloudflare's default is off; omit or pass `false`
   * to disable it.
   *
   * Once enabled, the hostname is reported on `publicDomain`. This
   * endpoint is rate-limited and intended for non-production use — use
   * `domains` for production public access.
   *
   * @default false
   */
  publicAccess?: boolean;
  /**
   * Object lifecycle rules applied to the bucket. Pass an empty array (or
   * omit) to clear all lifecycle rules. See the Cloudflare R2 docs for
   * supported transitions.
   */
  lifecycleRules?: BucketLifecycleRule[];
  /**
   * CORS rules applied to the bucket, controlling which cross-origin
   * browser requests are allowed against the bucket's public or S3 API
   * endpoints. Pass an empty array (or omit) to remove the CORS
   * configuration.
   */
  cors?: BucketCorsRule[];
  /**
   * Allow alchemy to delete every object in the bucket when the bucket
   * itself is deleted.
   *
   * R2 refuses to delete a bucket that still has objects in it — that
   * refusal is the last line of defense for your data, so alchemy does not
   * bypass it by default: destroying a non-empty bucket fails with
   * `BucketNotEmpty` and both the bucket and its objects survive. Set this
   * to `true` for buckets whose contents are disposable (caches, previews,
   * test fixtures).
   *
   * `alchemy unsafe nuke` empties buckets regardless, since it is an
   * explicitly operator-confirmed account teardown.
   *
   * @default false
   */
  forceDestroy?: boolean;
};

export type Bucket = Resource<
  "Cloudflare.R2.Bucket",
  BucketProps,
  {
    bucketName: BucketName;
    storageClass: Bucket.StorageClass;
    jurisdiction: Bucket.Jurisdiction;
    location: Bucket.Location | undefined;
    accountId: string;
    domains: Bucket.CustomDomain[];
    lifecycleRules: Bucket.LifecycleRule[];
    cors: Bucket.CorsRule[];
    /**
     * Hostname of the bucket's Cloudflare-managed `r2.dev` domain.
     * Set only while `publicAccess` is enabled; `undefined` when
     * disabled (the domain still exists but serves 401).
     */
    publicDomain: string | undefined;
  },
  never,
  Cloudflare.Providers
>;

/**
 * A Cloudflare R2 object storage bucket with S3-compatible API.
 *
 * R2 provides zero-egress-fee object storage. Create a bucket as a resource,
 * then bind it to a Worker to read and write objects at runtime.
 * ### Creating a Bucket
 * **Example:** Basic R2 bucket
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket");
 * ```
 *
 * **Example:** Bucket with location hint
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
 *   locationHint: "wnam",
 * });
 * ```
 *
 * ### Binding to a Worker
 * **Example:** Reading and writing objects
 * ```typescript
 * const bucket = yield* Cloudflare.R2.ReadWriteBucket(MyBucket);
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
 * **Example:** Streaming upload with content length
 * ```typescript
 * const bucket = yield* Cloudflare.R2.ReadWriteBucket(MyBucket);
 *
 * yield* bucket.put("upload.bin", request.stream, {
 *   contentLength: Number(request.headers["content-length"] ?? 0),
 * });
 * ```
 *
 * ### Custom Domains
 *
 * Attach one or more custom domains to serve bucket objects from a hostname
 * you control. The domain's zone must already exist in your Cloudflare
 * account; the zone is inferred from the hostname when omitted, or you can
 * pass a `Cloudflare.Zone.Zone` resource, a zone ID, or any hostname inside the
 * zone via the `zone` field.
 *
 * **Example:** Single custom domain
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
 *   domains: [{ name: "assets.example.com" }],
 * });
 * ```
 *
 * **Example:** Multiple custom domains
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
 *   domains: [
 *     { name: "assets.example.com" },
 *     { name: "static.example.com" },
 *   ],
 * });
 * ```
 *
 * **Example:** Disable a custom domain without removing it
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
 *   domains: [{ name: "assets.example.com", enabled: false }],
 * });
 * ```
 *
 * **Example:** Custom domain with explicit zone and TLS settings
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("ExampleZone", {
 *   name: "example.com",
 * });
 *
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
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
 * ### Public Development URL
 *
 * Enable Cloudflare's managed `r2.dev` domain so objects are publicly
 * readable without attaching a custom domain. The hostname is reported
 * on `publicDomain`. This endpoint is rate-limited and intended for
 * non-production use — use `domains` for production public access.
 *
 * **Example:** Enable public access at r2.dev
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
 *   publicAccess: true,
 * });
 * // objects are at https://${bucket.publicDomain}/<key>
 * ```
 *
 * **Example:** Disable public access
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
 *   publicAccess: false,
 * });
 * ```
 *
 * ### Object Lifecycle Rules
 *
 * Configure lifecycle rules to automatically delete objects, abort
 * incomplete multipart uploads, or transition objects to InfrequentAccess
 * storage. Pass an empty array (or omit) to clear all rules. See the
 * [Cloudflare R2 docs](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
 * for details and limits (max 1000 rules per bucket).
 *
 * **Example:** Delete objects 30 days after upload
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
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
 * **Example:** Transition to InfrequentAccess after 60 days, delete after 365
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
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
 * **Example:** Abort incomplete multipart uploads after 7 days
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
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
 *
 * ### CORS
 *
 * Configure CORS rules so browsers can make cross-origin requests against
 * the bucket's public (custom domain / r2.dev) or S3 API endpoints. Pass an
 * empty array (or omit) to remove the CORS configuration. See the
 * [Cloudflare R2 docs](https://developers.cloudflare.com/r2/buckets/cors/)
 * for details.
 *
 * **Example:** Allow cross-origin reads from any origin
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
 *   cors: [
 *     {
 *       allowedMethods: ["GET", "HEAD"],
 *       allowedOrigins: ["*"],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Browser range reads (e.g. PMTiles map tiles)
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
 *   domains: [{ name: "tiles.example.com" }],
 *   cors: [
 *     {
 *       allowedMethods: ["GET", "HEAD"],
 *       allowedOrigins: ["https://map.example.com"],
 *       allowedHeaders: ["range", "if-match"],
 *       exposeHeaders: ["etag", "content-range"],
 *       maxAgeSeconds: 3600,
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Allow uploads from a web app
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("MyBucket", {
 *   cors: [
 *     {
 *       allowedMethods: ["GET", "PUT", "POST"],
 *       allowedOrigins: ["https://app.example.com"],
 *       allowedHeaders: ["content-type"],
 *       exposeHeaders: ["etag"],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Deleting a Bucket
 *
 * R2 refuses to delete a bucket that still has objects in it, and alchemy
 * does not bypass that refusal: destroying a non-empty bucket fails with
 * `BucketNotEmpty` and both the bucket and its objects survive. Opt into
 * emptying the bucket first with `forceDestroy` for buckets whose contents
 * are disposable.
 *
 * **Example:** Empty the bucket on destroy
 * ```typescript
 * const cache = yield* Cloudflare.R2.Bucket("Cache", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * **Example:** Keep the bucket even when the stack goes away
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const uploads = yield* Cloudflare.R2.Bucket("Uploads").pipe(
 *   RemovalPolicy.retain(),
 * );
 * ```
 *
 * @resource
 * @product R2
 * @category Storage & Databases
 */
export const Bucket = Resource<Bucket>("Cloudflare.R2.Bucket", {
  aliases: ["Cloudflare.R2Bucket"],
});

export declare namespace Bucket {
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
      | { condition: BucketLifecycleCondition | undefined }
      | undefined;
    storageClassTransitions:
      | {
          condition: BucketLifecycleCondition;
          storageClass: "InfrequentAccess";
        }[]
      | undefined;
  };
  export type CorsRule = {
    id: string | undefined;
    allowedMethods: ("GET" | "PUT" | "POST" | "DELETE" | "HEAD")[];
    allowedOrigins: string[];
    allowedHeaders: string[] | undefined;
    exposeHeaders: string[] | undefined;
    maxAgeSeconds: number | undefined;
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

export const ProviderLive = () =>
  Provider.effect(
    Bucket,
    Effect.gen(function* () {
      const emptyBucket = Effect.fn(function* (
        bucketName: string,
        jurisdiction: Bucket.Jurisdiction,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        return yield* r2.listObjects
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
              r2.deleteObjects({
                accountId,
                bucketName,
                cfR2Jurisdiction: jurisdiction,
                body: [...chunk],
              }),
            ),
            Effect.catchTag("NoSuchBucket", () => Effect.void),
          );
      });

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
      ): Bucket.Location | undefined => {
        if (!location) return undefined;
        return location.toLowerCase() as Bucket.Location;
      };

      const listCustomDomains = Effect.fn(function* (
        bucketName: string,
        jurisdiction: Bucket.Jurisdiction,
        // `NoSuchBucket` after a *create* is endpoint-consistency lag worth
        // retrying. During *enumeration* (`list`), a bucket that 404s is one a
        // parallel suite just deleted — it's genuinely gone, so retrying the
        // consistency schedule only burns ~3s per churned bucket and is what
        // pushes an account-wide `list` past its timeout. Default to retrying
        // (the reconcile path); opt out for enumeration.
        options?: { retryMissing?: boolean },
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fetch = r2.listBucketDomainCustoms({
          accountId,
          bucketName,
          jurisdiction,
        });
        return yield* (
          options?.retryMissing === false
            ? fetch
            : fetch.pipe(
                Effect.retry({
                  while: (e) => e._tag === "NoSuchBucket",
                  schedule: r2BucketEndpointConsistencySchedule,
                }),
              )
        ).pipe(
          Effect.map((response) =>
            response.domains.map(toCustomDomainAttributes),
          ),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
        );
      });

      const reconcileCustomDomains = (
        bucketName: string,
        jurisdiction: Bucket.Jurisdiction,
        desired: BucketCustomDomain[],
        previous: Bucket.CustomDomain[],
      ) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
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
                : r2
                    .deleteBucketDomainCustom({
                      accountId,
                      bucketName,
                      domain: previousDomain.domain,
                      jurisdiction,
                    })
                    .pipe(
                      Effect.catchTag(
                        ["DomainNotFound", "NoSuchBucket"],
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
                  yield* r2
                    .deleteBucketDomainCustom({
                      accountId,
                      bucketName,
                      domain: domain.name,
                      jurisdiction,
                    })
                    .pipe(
                      Effect.catchTag(
                        ["DomainNotFound", "NoSuchBucket"],
                        () => Effect.void,
                      ),
                    );
                }

                if (!observedDomain || observedDomain.zoneId !== zoneId) {
                  const created = yield* r2
                    .createBucketDomainCustom({
                      accountId,
                      bucketName,
                      jurisdiction,
                      domain: domain.name,
                      enabled: domain.enabled ?? true,
                      zoneId,
                      ciphers: domain.ciphers,
                      minTLS: domain.minTLS,
                    })
                    .pipe(
                      Effect.retry({
                        while: (e) => e._tag === "NoSuchBucket",
                        schedule: r2BucketEndpointConsistencySchedule,
                      }),
                      Effect.retry({
                        while: (e) => e._tag === "CustomDomainInUse",
                        schedule: r2CustomDomainConflictSchedule,
                      }),
                    );
                  return toCustomDomainAttributes({ ...created, zoneId });
                }

                const updated = yield* r2
                  .updateBucketDomainCustom({
                    accountId,
                    bucketName,
                    domain: domain.name,
                    jurisdiction,
                    enabled: domain.enabled ?? true,
                    ciphers: domain.ciphers,
                    minTLS: domain.minTLS,
                  })
                  .pipe(
                    Effect.retry({
                      while: (e) => e._tag === "NoSuchBucket",
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

      const listManagedDomain = Effect.fn(function* (
        bucketName: string,
        jurisdiction: Bucket.Jurisdiction,
        options?: { retryMissing?: boolean },
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fetch = r2.listBucketDomainManageds({
          accountId,
          bucketName,
          jurisdiction,
        });
        return yield* (
          options?.retryMissing === false
            ? fetch
            : fetch.pipe(
                Effect.retry({
                  while: (e) => e._tag === "NoSuchBucket",
                  schedule: r2BucketEndpointConsistencySchedule,
                }),
              )
        ).pipe(
          // The hostname exists whether or not public access is on; a
          // disabled domain serves 401, so only report it while enabled.
          Effect.map((response) =>
            response.enabled ? response.domain : undefined,
          ),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
        );
      });

      const reconcileManagedDomain = (
        bucketName: string,
        jurisdiction: Bucket.Jurisdiction,
        desired: boolean,
      ) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const observed = yield* r2
            .listBucketDomainManageds({
              accountId,
              bucketName,
              jurisdiction,
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "NoSuchBucket",
                schedule: r2BucketEndpointConsistencySchedule,
              }),
            );

          if (observed.enabled === desired) {
            return desired ? observed.domain : undefined;
          }

          const updated = yield* r2
            .putBucketDomainManaged({
              accountId,
              bucketName,
              enabled: desired,
              jurisdiction,
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "NoSuchBucket",
                schedule: r2BucketEndpointConsistencySchedule,
              }),
            );

          return updated.enabled ? updated.domain : undefined;
        });

      // R2's `listBuckets` is not modelled as paginated by distilled and its
      // response omits a continuation cursor, so paginate exhaustively with the
      // `startAfter` query param: keep fetching full pages (capped at 1000)
      // until a short page signals the end.
      const listBucketsInJurisdiction = (
        accountId: string,
        jurisdiction: Bucket.Jurisdiction,
      ) =>
        Effect.gen(function* () {
          const all: {
            name: string;
            jurisdiction: Bucket.Jurisdiction;
            storageClass: Bucket.StorageClass;
            location: Bucket.Location | undefined;
          }[] = [];
          let startAfter: string | undefined = undefined;
          const perPage = 1000;
          for (;;) {
            const response: r2.ListBucketsResponse = yield* r2.listBuckets({
              accountId,
              jurisdiction,
              perPage,
              startAfter,
            });
            const raw = response.buckets ?? [];
            const page = raw.filter(
              (b): b is typeof b & { name: string } =>
                typeof b.name === "string" && b.name !== "",
            );
            for (const b of page) {
              all.push({
                name: b.name,
                jurisdiction: (b.jurisdiction ??
                  jurisdiction) as Bucket.Jurisdiction,
                storageClass: (b.storageClass ??
                  "Standard") as Bucket.StorageClass,
                location: normalizeLocation(b.location),
              });
            }
            // Terminate on the RAW page length — the filtered length can be
            // shorter on a full page (nameless entries), which would end the
            // walk early and silently drop the remaining buckets.
            if (raw.length < perPage || page.length === 0) break;
            startAfter = page[page.length - 1].name;
          }
          return all;
        });

      const reconcileLifecycleRules = (
        bucketName: string,
        jurisdiction: Bucket.Jurisdiction,
        desired: BucketLifecycleRule[],
      ) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const observed = yield* r2
            .getBucketLifecycle({
              accountId,
              bucketName,
              jurisdiction,
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "NoSuchBucket",
                schedule: r2BucketEndpointConsistencySchedule,
              }),
            );

          const observedRules = (observed.rules ?? []).map(toLifecycleRule);
          const desiredRules = desired.map(normalizeLifecycleRule);

          if (deepEqual(observedRules, desiredRules)) {
            return desiredRules;
          }

          yield* r2
            .putBucketLifecycle({
              accountId,
              bucketName,
              jurisdiction,
              rules: desired.map(toLifecyclePutPayload),
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "NoSuchBucket",
                schedule: r2BucketEndpointConsistencySchedule,
              }),
            );

          return desiredRules;
        });

      const reconcileCorsRules = (
        bucketName: string,
        jurisdiction: Bucket.Jurisdiction,
        desired: BucketCorsRule[],
      ) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const observed = yield* r2
            .getBucketCors({
              accountId,
              bucketName,
              jurisdiction,
            })
            .pipe(
              Effect.map((response) => (response.rules ?? []).map(toCorsRule)),
              // A bucket with no CORS configuration is a typed error, not an
              // empty rule list — normalize it to [] for the diff below.
              Effect.catchTag("NoCorsConfiguration", () =>
                Effect.succeed([] as Bucket.CorsRule[]),
              ),
              Effect.retry({
                while: (e) => e._tag === "NoSuchBucket",
                schedule: r2BucketEndpointConsistencySchedule,
              }),
            );

          const desiredRules = desired.map(normalizeCorsRule);

          if (deepEqual(observed, desiredRules)) {
            return desiredRules;
          }

          if (desiredRules.length === 0) {
            yield* r2
              .deleteBucketCors({
                accountId,
                bucketName,
                jurisdiction,
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "NoSuchBucket",
                  schedule: r2BucketEndpointConsistencySchedule,
                }),
              );
            return desiredRules;
          }

          yield* r2
            .putBucketCors({
              accountId,
              bucketName,
              jurisdiction,
              rules: desired.map(toCorsPutPayload),
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "NoSuchBucket",
                schedule: r2BucketEndpointConsistencySchedule,
              }),
            );

          return desiredRules;
        });

      return {
        stables: ["bucketName", "accountId"],
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* yield* CloudflareEnvironment;
            // R2 buckets are account-scoped but partitioned by jurisdiction, so
            // enumerate each jurisdiction. Accounts not entitled to a given
            // jurisdiction (e.g. `fedramp`) reject the route — treat as empty.
            const jurisdictions: Bucket.Jurisdiction[] = [
              "default",
              "eu",
              "fedramp",
            ];
            const perJurisdiction = yield* Effect.forEach(
              jurisdictions,
              (jurisdiction) =>
                listBucketsInJurisdiction(accountId, jurisdiction).pipe(
                  // An account not entitled to a jurisdiction rejects the list
                  // route with `Forbidden` ("Access Denied") or `InvalidRoute`
                  // — there are simply no buckets there, so treat as empty.
                  // @ts-expect-error
                  Effect.catchTag(["InvalidRoute", "Forbidden"], () =>
                    Effect.succeed([]),
                  ),
                ),
              { concurrency: jurisdictions.length },
            );
            const buckets = perJurisdiction.flat();

            // Hydrate each bucket into the exact `read` Attributes shape so the
            // result is directly usable by `delete` (which needs `domains` to
            // tear down custom domains).
            return yield* Effect.forEach(
              buckets,
              (bucket) =>
                Effect.gen(function* () {
                  // The hydration reads are independent — issue them
                  // concurrently so each bucket costs one round-trip of wall
                  // clock instead of four (a large leaked-bucket census can
                  // otherwise blow the nuke scan's per-provider timeout).
                  const [domains, lifecycleRules, cors, publicDomain] =
                    yield* Effect.all(
                      [
                        listCustomDomains(bucket.name, bucket.jurisdiction, {
                          retryMissing: false,
                        }).pipe(Effect.map((d) => d ?? [])),
                        r2
                          .getBucketLifecycle({
                            accountId,
                            bucketName: bucket.name,
                            jurisdiction: bucket.jurisdiction,
                          })
                          .pipe(
                            Effect.map((observed) =>
                              (observed.rules ?? []).map(toLifecycleRule),
                            ),
                            Effect.catchTag("NoSuchBucket", () =>
                              Effect.succeed([] as Bucket.LifecycleRule[]),
                            ),
                          ),
                        r2
                          .getBucketCors({
                            accountId,
                            bucketName: bucket.name,
                            jurisdiction: bucket.jurisdiction,
                          })
                          .pipe(
                            Effect.map((observed) =>
                              (observed.rules ?? []).map(toCorsRule),
                            ),
                            Effect.catchTag(
                              ["NoSuchBucket", "NoCorsConfiguration"],
                              () => Effect.succeed([] as Bucket.CorsRule[]),
                            ),
                          ),
                        listManagedDomain(bucket.name, bucket.jurisdiction, {
                          retryMissing: false,
                        }),
                      ] as const,
                      { concurrency: 4 },
                    );
                  return {
                    bucketName: bucket.name,
                    storageClass: bucket.storageClass,
                    jurisdiction: bucket.jurisdiction,
                    location: bucket.location,
                    accountId,
                    domains,
                    lifecycleRules,
                    cors,
                    publicDomain,
                  };
                }).pipe(
                  // The custom-domain endpoint intermittently 500s ("Failed to
                  // access or modify the bucket policy"), and some buckets 500
                  // PERSISTENTLY. The blanket Cloudflare retry policy already
                  // retries each call's transient blips; don't stack another
                  // retry here (the budgets multiply into minutes per bucket).
                  // A bucket that still 500s must not abort the account-wide
                  // enumeration (nuke would then see ZERO buckets) — degrade
                  // it to an un-hydrated shape; delete can still tear the
                  // bucket down.
                  Effect.catchTag("InternalServerError", () =>
                    Effect.succeed({
                      bucketName: bucket.name,
                      storageClass: bucket.storageClass,
                      jurisdiction: bucket.jurisdiction,
                      location: bucket.location,
                      accountId,
                      domains: [] as Bucket.CustomDomain[],
                      lifecycleRules: [] as Bucket.LifecycleRule[],
                      cors: [] as Bucket.CorsRule[],
                      publicDomain: undefined,
                    }),
                  ),
                ),
              { concurrency: 10 },
            );
          }),
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          const { accountId } = yield* yield* CloudflareEnvironment;
          const oldName =
            output?.bucketName ?? (yield* createBucketName(id, olds.name));
          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id
          // differently today. Only an explicit user-provided name can
          // force a replace.
          const name = news.name ?? oldName;
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
              // `accountId` is always stable across an update (a name/account
              // change is a `replace`); keep it now that `diff.stables`
              // overrides `provider.stables` rather than merging with it.
              stables:
                oldName === name ? ["bucketName", "accountId"] : ["accountId"],
            } as const;
          }
          if (!deepEqual(olds.domains, news.domains)) {
            return { action: "update" } as const;
          }
          if (!deepEqual(olds.lifecycleRules, news.lifecycleRules)) {
            return { action: "update" } as const;
          }
          if (!deepEqual(olds.cors, news.cors)) {
            return { action: "update" } as const;
          }
          if ((olds.publicAccess ?? false) !== (news.publicAccess ?? false)) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          // Prefer the deployed name: regenerating would target a different
          // bucket if the generator's output for this id ever drifts.
          const name =
            output?.bucketName ?? (yield* createBucketName(id, news.name));
          const acct = output?.accountId ?? accountId;
          const jurisdiction =
            output?.jurisdiction ?? news.jurisdiction ?? "default";

          // Observe — fetch the bucket. R2 reports a deleted bucket as
          // `NoSuchBucket`; tolerate that so the reconciler falls
          // through to the create path.
          let observed = yield* r2
            .getBucket({
              accountId: acct,
              bucketName: name,
              jurisdiction,
            })
            .pipe(
              Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
            );

          // Ensure — create if missing. R2 reports a concurrent create
          // (or partial state-persistence failure) as
          // `BucketAlreadyExists`; tolerate by re-fetching the bucket.
          if (!observed) {
            observed = yield* r2
              .createBucket({
                accountId: acct,
                name,
                storageClass: news.storageClass,
                jurisdiction: news.jurisdiction,
                locationHint: news.locationHint,
              })
              .pipe(
                Effect.catchTag("BucketAlreadyExists", () =>
                  r2
                    .getBucket({
                      accountId: acct,
                      bucketName: name,
                      jurisdiction: news.jurisdiction,
                    })
                    .pipe(
                      // The create lost a race, but the winning create may not
                      // be readable yet — ride out the consistency lag.
                      Effect.retry({
                        while: (e) => e._tag === "NoSuchBucket",
                        schedule: r2BucketEndpointConsistencySchedule,
                      }),
                    ),
                ),
              );
          }

          // Sync — storage class is the only mutable bucket property
          // (location and jurisdiction are immutable; the diff flags those
          // as `replace`). PATCH carries the class in the
          // `cf-r2-storage-class` header. Address the bucket by the
          // RESOLVED name, never `observed.name` — a response missing the
          // name would collapse the URI to the collection path, which the
          // control plane rejects with `PATCH not supported for requested
          // URI`. Only patch when the desired class drifts from observed.
          const desiredStorageClass = news.storageClass ?? "Standard";
          const observedStorageClass = observed.storageClass ?? "Standard";
          if (observedStorageClass !== desiredStorageClass) {
            observed = yield* r2
              .patchBucket({
                accountId: acct,
                bucketName: name,
                storageClass: desiredStorageClass,
                jurisdiction: observed.jurisdiction ?? jurisdiction,
              })
              .pipe(
                // The patch endpoint can briefly 404 a freshly-created bucket
                // even after `getBucket` already sees it.
                Effect.retry({
                  while: (e) => e._tag === "NoSuchBucket",
                  schedule: r2BucketEndpointConsistencySchedule,
                }),
              );
          }

          const attrs = {
            bucketName: observed.name ?? name,
            // Distilled widened generated string enums to open unions.
            storageClass: (observed.storageClass ??
              "Standard") as Bucket.StorageClass,
            jurisdiction: (observed.jurisdiction ??
              "default") as Bucket.Jurisdiction,
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

          const cors = yield* reconcileCorsRules(
            attrs.bucketName,
            attrs.jurisdiction,
            news.cors ?? [],
          );

          const publicDomain = yield* reconcileManagedDomain(
            attrs.bucketName,
            attrs.jurisdiction,
            news.publicAccess ?? false,
          );

          return {
            ...attrs,
            domains,
            lifecycleRules,
            cors,
            publicDomain,
          };
        }),
        delete: Effect.fn(function* ({ olds = {}, output, force }) {
          yield* Effect.all(
            (output.domains ?? []).map((domain) =>
              r2
                .deleteBucketDomainCustom({
                  accountId: output.accountId,
                  bucketName: output.bucketName,
                  domain: domain.domain,
                  jurisdiction: output.jurisdiction,
                })
                .pipe(
                  Effect.catchTag(
                    ["DomainNotFound", "NoSuchBucket"],
                    () => Effect.void,
                  ),
                ),
            ),
            { concurrency: "unbounded" },
          );

          // Whether we may destroy the bucket's CONTENTS.
          // - `olds.forceDestroy` — the user opted in on the resource props.
          // - `force` — set only by `alchemy unsafe nuke`, an explicitly
          //   operator-confirmed account teardown. Nuke enumerates buckets
          //   straight from the cloud (its `olds` is Attributes, not Props),
          //   so `forceDestroy` is never present there.
          //
          // Without either, the objects are left alone and R2's own refusal
          // to delete a non-empty bucket (`BucketNotEmpty`) stands — that
          // refusal is the data protection users rely on, and emptying the
          // bucket to get past it is how a stack teardown turns into
          // irreversible data loss (#1248).
          const destroyContents = olds.forceDestroy === true || force === true;
          if (destroyContents) {
            yield* emptyBucket(output.bucketName, output.jurisdiction);
          }
          const deleteBucket = r2
            .deleteBucket({
              accountId: output.accountId,
              bucketName: output.bucketName,
              jurisdiction: output.jurisdiction,
            })
            .pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
          if (!destroyContents) {
            return yield* deleteBucket;
          }
          // A writer that outlives the emptying pass (a Durable Object's
          // alarm finishing a job while the stack tears down) can land an
          // object between the sweep and the delete: re-empty and retry,
          // bounded. Incomplete multipart uploads also hold a bucket; those
          // only a lifecycle rule clears, and the refusal then stands.
          yield* deleteBucket.pipe(
            Effect.catchTag("BucketNotEmpty", (error) =>
              Effect.sleep("2 seconds").pipe(
                Effect.andThen(
                  emptyBucket(output.bucketName, output.jurisdiction),
                ),
                Effect.andThen(Effect.fail(error)),
              ),
            ),
            Effect.retry({
              while: (error) => error._tag === "BucketNotEmpty",
              times: 5,
            }),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const name =
            output?.bucketName ?? (yield* createBucketName(id, olds?.name));
          const acct = output?.accountId ?? accountId;
          return yield* r2
            .getBucket({
              accountId: acct,
              bucketName: name,
              jurisdiction: output?.jurisdiction ?? olds?.jurisdiction,
            })
            .pipe(
              Effect.map((bucket) => ({
                bucketName: bucket.name!,
                // Distilled widened generated string enums to open unions.
                storageClass: (bucket.storageClass ??
                  "Standard") as Bucket.StorageClass,
                jurisdiction: (bucket.jurisdiction ??
                  "default") as Bucket.Jurisdiction,
                location: normalizeLocation(bucket.location),
                accountId: acct,
                domains: output?.domains ?? [],
                lifecycleRules: output?.lifecycleRules ?? [],
                cors: output?.cors ?? [],
                publicDomain: output?.publicDomain,
              })),
              Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
            );
        }),
      };
    }),
  );

/**
 * Local (dev) provider — the bucket is purely virtual: a `dev:`-prefixed
 * bucket name keyed into the local workerd R2 simulator (data under
 * `.alchemy/local/r2`). `toRuntimeBinding` lowers an `r2_bucket` binding
 * whose bucket name is `dev:`-prefixed onto the local R2 service. R2 has no
 * opaque id — the name IS the identity — so the `dev:` marker rides on the
 * name (a `:` can never appear in a real R2 bucket name).
 *
 * Custom domains, lifecycle rules, CORS, and the managed r2.dev domain
 * are deploy-side concerns with no local behavior; the local attributes
 * report them empty.
 */
export const ProviderLocal = () =>
  Provider.succeed(Bucket, {
    stables: ["accountId"],
    diff: Effect.fn(function* ({ news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!output?.bucketName) return { action: "update" } as const;
      if (!isResolved(news)) return undefined;
      if (output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      // Fall through to the engine's default prop diff.
    }),
    read: Effect.fn(function* ({ output }) {
      // Purely virtual — the persisted state row is the source of truth.
      return output ?? undefined;
    }),
    reconcile: Effect.fn(function* ({ news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return {
        bucketName: output?.bucketName ?? generateLocalId(),
        storageClass: (news.storageClass ?? "Standard") as Bucket.StorageClass,
        jurisdiction: (news.jurisdiction ?? "default") as Bucket.Jurisdiction,
        location: undefined,
        accountId: output?.accountId ?? accountId,
        domains: [],
        lifecycleRules: [],
        cors: [],
        publicDomain: undefined,
      };
    }),
    delete: Effect.fn(function* () {
      // The simulator's on-disk data is keyed by the dev name; dropping the
      // state row is enough — orphaned blobs are reclaimed with `.alchemy`.
    }),
  });

export const BucketProvider = () =>
  ProviderLayer.dual(Bucket, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });

// R2 can make a newly-created bucket visible to `getBucket` before its
// sub-resource endpoints (custom domains, lifecycle) accept it. Retry only
// that narrow `NoSuchBucket` lag here; not-found sub-resources are still
// treated as terminal for idempotent deletes.
const r2BucketEndpointConsistencySchedule = Schedule.max([
  Schedule.exponential(100),
  Schedule.recurs(5),
]);

// R2 sub-resource reads (notably the custom-domain endpoint, which touches the
// bucket's public-access policy) can return a transient 500 ("Failed to access
// or modify the bucket policy"). Ride out the blip with a short bounded retry.
const r2TransientServerErrorSchedule = Schedule.max([
  Schedule.exponential("500 millis"),
  Schedule.recurs(6),
]);

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
): Bucket.CustomDomain => ({
  domain: domain.domain,
  zoneId: domain.zoneId ?? undefined,
  enabled: domain.enabled ?? true,
  ciphers: domain.ciphers ?? undefined,
  minTLS: (domain.minTLS ?? undefined) as Bucket.CustomDomain["minTLS"],
  status: (domain.status ?? undefined) as Bucket.CustomDomain["status"],
});

const sameCustomDomainConfig = (
  observed: Bucket.CustomDomain | undefined,
  desired: BucketCustomDomain,
  zoneId: string,
): boolean =>
  observed !== undefined &&
  observed.zoneId === zoneId &&
  observed.enabled === (desired.enabled ?? true) &&
  deepEqual(observed.ciphers, desired.ciphers) &&
  observed.minTLS === desired.minTLS;

type LifecycleRuleResponse = NonNullable<
  r2.GetBucketLifecycleResponse["rules"]
>[number];

const toLifecycleRule = (
  rule: LifecycleRuleResponse,
): Bucket.LifecycleRule => ({
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
  rule: BucketLifecycleRule,
): Bucket.LifecycleRule => ({
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

type CorsRuleResponse = NonNullable<r2.GetBucketCorsResponse["rules"]>[number];

const toCorsRule = (rule: CorsRuleResponse): Bucket.CorsRule => ({
  id: rule.id ?? undefined,
  // Distilled widened generated string enums to open unions.
  allowedMethods: rule.allowed.methods as Bucket.CorsRule["allowedMethods"],
  allowedOrigins: rule.allowed.origins,
  allowedHeaders: rule.allowed.headers ?? undefined,
  exposeHeaders: rule.exposeHeaders ?? undefined,
  maxAgeSeconds: rule.maxAgeSeconds ?? undefined,
});

const normalizeCorsRule = (rule: BucketCorsRule): Bucket.CorsRule => ({
  id: rule.id,
  allowedMethods: rule.allowedMethods,
  allowedOrigins: rule.allowedOrigins,
  allowedHeaders: rule.allowedHeaders,
  exposeHeaders: rule.exposeHeaders,
  maxAgeSeconds: rule.maxAgeSeconds,
});

const toCorsPutPayload = (
  rule: BucketCorsRule,
): NonNullable<r2.PutBucketCorsRequest["rules"]>[number] => ({
  id: rule.id,
  allowed: {
    methods: rule.allowedMethods,
    origins: rule.allowedOrigins,
    headers: rule.allowedHeaders,
  },
  exposeHeaders: rule.exposeHeaders,
  maxAgeSeconds: rule.maxAgeSeconds,
});

const toLifecyclePutPayload = (
  rule: BucketLifecycleRule,
): NonNullable<r2.PutBucketLifecycleRequest["rules"]>[number] => ({
  id: rule.id,
  enabled: rule.enabled ?? true,
  conditions: { prefix: rule.prefix ?? "" },
  abortMultipartUploadsTransition: rule.abortMultipartUploadsTransition,
  deleteObjectsTransition: rule.deleteObjectsTransition,
  storageClassTransitions: rule.storageClassTransitions,
});

// Cloudflare keys a custom domain to a single bucket at the zone level. After a
// domain is deleted, re-attaching the same hostname can transiently 409 with
// "Domain already in use" (typed as `CustomDomainInUse`) until the prior
// association is fully released. Treat that narrow conflict as eventual
// consistency and retry it on create. Releasing a custom domain after delete
// can lag a few seconds, so give the conflict a longer, bounded budget than
// the bucket-endpoint lag above.
const r2CustomDomainConflictSchedule = Schedule.max([
  Schedule.spaced("2 seconds"),
  Schedule.recurs(8),
]);

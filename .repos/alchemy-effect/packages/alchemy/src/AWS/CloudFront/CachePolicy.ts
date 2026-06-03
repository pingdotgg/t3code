import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface CachePolicyProps {
  /**
   * Name of the cache policy. If omitted, a deterministic name is generated.
   *
   * Names must be unique per AWS account. Changing the name triggers
   * a replacement.
   */
  name?: string;
  /**
   * Optional comment describing the policy.
   */
  comment?: string;
  /**
   * Minimum amount of time, in seconds, that objects stay in the cache.
   */
  minTTL: number;
  /**
   * Default amount of time, in seconds, that objects stay in the cache when
   * the origin does not send `Cache-Control` or `Expires` headers.
   */
  defaultTTL?: number;
  /**
   * Maximum amount of time, in seconds, that objects stay in the cache.
   */
  maxTTL?: number;
  /**
   * Controls which request values become part of the cache key and which
   * additional headers/cookies/query strings CloudFront forwards to the origin.
   */
  parametersInCacheKeyAndForwardedToOrigin?: cloudfront.ParametersInCacheKeyAndForwardedToOrigin;
}

export interface CachePolicy extends Resource<
  "AWS.CloudFront.CachePolicy",
  CachePolicyProps,
  {
    /**
     * CloudFront-assigned cache policy identifier.
     */
    cachePolicyId: string;
    /**
     * Name of the cache policy.
     */
    name: string;
    /**
     * Most recent entity tag for update/delete operations.
     */
    etag: string | undefined;
    /**
     * Current comment on the policy.
     */
    comment: string | undefined;
    /**
     * Current minimum TTL.
     */
    minTTL: number;
    /**
     * Current default TTL.
     */
    defaultTTL: number | undefined;
    /**
     * Current maximum TTL.
     */
    maxTTL: number | undefined;
    /**
     * Current cache-key/forwarded-value configuration.
     */
    parametersInCacheKeyAndForwardedToOrigin:
      | cloudfront.ParametersInCacheKeyAndForwardedToOrigin
      | undefined;
  },
  never,
  Providers
> {}

/**
 * A CloudFront cache policy.
 *
 * Cache policies determine the values CloudFront includes in the cache key,
 * the headers, cookies and query strings it forwards to the origin, and the
 * TTL bounds for cached responses. Policies are referenced by ID on a
 * Distribution's default behavior or per-path cache behaviors.
 *
 * For AWS-managed policies (CachingOptimized, CachingDisabled,
 * AllViewerExceptHostHeader) reference them by ID via the constants in
 * {@link ManagedPolicies} instead of creating a custom policy.
 *
 * @section Creating Cache Policies
 * @example Cache by query string and Authorization header
 * ```typescript
 * const cachePolicy = yield* CachePolicy("ApiCachePolicy", {
 *   comment: "Cache GETs by query string + Authorization",
 *   minTTL: 0,
 *   defaultTTL: 60,
 *   maxTTL: 3600,
 *   parametersInCacheKeyAndForwardedToOrigin: {
 *     EnableAcceptEncodingGzip: true,
 *     EnableAcceptEncodingBrotli: true,
 *     HeadersConfig: {
 *       HeaderBehavior: "whitelist",
 *       Headers: { Quantity: 1, Items: ["Authorization"] },
 *     },
 *     CookiesConfig: { CookieBehavior: "none" },
 *     QueryStringsConfig: { QueryStringBehavior: "all" },
 *   },
 * });
 * ```
 */
export const CachePolicy = Resource<CachePolicy>("AWS.CloudFront.CachePolicy");

export const CachePolicyProvider = () =>
  Provider.effect(
    CachePolicy,
    Effect.gen(function* () {
      const getById = Effect.fn(function* (id: string) {
        const config = yield* cloudfront
          .getCachePolicyConfig({ Id: id })
          .pipe(
            Effect.catchTag("NoSuchCachePolicy", () =>
              Effect.succeed(undefined),
            ),
          );
        if (!config?.CachePolicyConfig) return undefined;
        return { config: config.CachePolicyConfig, etag: config.ETag };
      });

      const getByName = Effect.fn(function* (name: string) {
        const listed = yield* cloudfront.listCachePolicies({ Type: "custom" });
        const summary = listed.CachePolicyList?.Items?.find(
          (item) => item.CachePolicy?.CachePolicyConfig?.Name === name,
        );
        if (!summary?.CachePolicy?.Id) return undefined;
        return yield* getById(summary.CachePolicy.Id).pipe(
          Effect.map((found) =>
            found ? { id: summary.CachePolicy.Id, ...found } : undefined,
          ),
        );
      });

      const buildConfig = (
        name: string,
        props: CachePolicyProps,
      ): cloudfront.CachePolicyConfig => ({
        Name: name,
        Comment: props.comment,
        MinTTL: props.minTTL,
        DefaultTTL: props.defaultTTL,
        MaxTTL: props.maxTTL,
        ParametersInCacheKeyAndForwardedToOrigin:
          props.parametersInCacheKeyAndForwardedToOrigin,
      });

      const toAttrs = (
        id: string,
        config: cloudfront.CachePolicyConfig,
        etag: string | undefined,
      ) => ({
        cachePolicyId: id,
        name: config.Name,
        etag,
        comment: config.Comment,
        minTTL: config.MinTTL,
        defaultTTL: config.DefaultTTL,
        maxTTL: config.MaxTTL,
        parametersInCacheKeyAndForwardedToOrigin:
          config.ParametersInCacheKeyAndForwardedToOrigin,
      });

      return {
        stables: ["cachePolicyId"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* createName(id, olds ?? {})) !==
            (yield* createName(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.cachePolicyId) {
            const found = yield* getById(output.cachePolicyId);
            if (found)
              return toAttrs(output.cachePolicyId, found.config, found.etag);
          }
          const name = yield* createName(id, olds ?? {});
          const found = yield* getByName(name);
          if (!found) return undefined;
          return toAttrs(found.id, found.config, found.etag);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);

          // Observe — locate the policy by id (cached on `output`) or by
          // name. Trust observed cloud state, not stale `olds`.
          let observed = output?.cachePolicyId
            ? yield* getById(output.cachePolicyId).pipe(
                Effect.map((found) =>
                  found ? { id: output.cachePolicyId, ...found } : undefined,
                ),
              )
            : undefined;
          if (!observed) {
            observed = yield* getByName(name);
          }

          // Ensure — create the policy if it's missing. Tolerate
          // `CachePolicyAlreadyExists` as a race with a peer reconciler:
          // re-read by name and continue with the sync path.
          if (!observed) {
            const created = yield* cloudfront
              .createCachePolicy({
                CachePolicyConfig: buildConfig(name, news),
              })
              .pipe(
                Effect.catchTag("CachePolicyAlreadyExists", () =>
                  getByName(name).pipe(
                    Effect.flatMap((existing) =>
                      existing
                        ? Effect.succeed({
                            CachePolicy: {
                              Id: existing.id,
                              LastModifiedTime: new Date(),
                              CachePolicyConfig: existing.config,
                            },
                            ETag: existing.etag,
                            Location: undefined,
                          })
                        : Effect.fail(
                            new Error(
                              `Cache policy '${name}' already exists but could not be recovered`,
                            ),
                          ),
                    ),
                  ),
                ),
              );
            if (!created.CachePolicy?.Id) {
              return yield* Effect.fail(
                new Error("createCachePolicy returned no identifier"),
              );
            }
            yield* session.note(created.CachePolicy.Id);
            return toAttrs(
              created.CachePolicy.Id,
              created.CachePolicy.CachePolicyConfig,
              created.ETag,
            );
          }

          // Sync — diff observed config against desired and patch via
          // `updateCachePolicy` with the freshly observed ETag.
          const desired = buildConfig(observed.config.Name, news);
          const updated = yield* cloudfront.updateCachePolicy({
            Id: observed.id,
            IfMatch: observed.etag,
            CachePolicyConfig: desired,
          });
          if (!updated.CachePolicy?.Id) {
            return yield* Effect.fail(
              new Error("updateCachePolicy returned no identifier"),
            );
          }
          yield* session.note(observed.id);
          return toAttrs(
            updated.CachePolicy.Id,
            updated.CachePolicy.CachePolicyConfig,
            updated.ETag,
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          const current = yield* getById(output.cachePolicyId);
          if (!current) return;
          yield* cloudfront
            .deleteCachePolicy({
              Id: output.cachePolicyId,
              IfMatch: current.etag,
            })
            .pipe(Effect.catchTag("NoSuchCachePolicy", () => Effect.void));
        }),
      };
    }),
  );

const createName = (id: string, props: CachePolicyProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 128, lowercase: true });

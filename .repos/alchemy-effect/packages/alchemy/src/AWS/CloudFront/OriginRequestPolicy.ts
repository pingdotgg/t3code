import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface OriginRequestPolicyProps {
  /**
   * Name of the origin request policy. If omitted, a deterministic name is
   * generated. Names must be unique per AWS account. Changing the name
   * triggers a replacement.
   */
  name?: string;
  /**
   * Optional comment describing the policy.
   */
  comment?: string;
  /**
   * Headers to forward to the origin (in addition to the cache key).
   */
  headersConfig: cloudfront.OriginRequestPolicyHeadersConfig;
  /**
   * Cookies to forward to the origin (in addition to the cache key).
   */
  cookiesConfig: cloudfront.OriginRequestPolicyCookiesConfig;
  /**
   * Query strings to forward to the origin (in addition to the cache key).
   */
  queryStringsConfig: cloudfront.OriginRequestPolicyQueryStringsConfig;
}

export interface OriginRequestPolicy extends Resource<
  "AWS.CloudFront.OriginRequestPolicy",
  OriginRequestPolicyProps,
  {
    /**
     * CloudFront-assigned origin request policy identifier.
     */
    originRequestPolicyId: string;
    /**
     * Name of the origin request policy.
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
     * Current headers configuration.
     */
    headersConfig: cloudfront.OriginRequestPolicyHeadersConfig;
    /**
     * Current cookies configuration.
     */
    cookiesConfig: cloudfront.OriginRequestPolicyCookiesConfig;
    /**
     * Current query strings configuration.
     */
    queryStringsConfig: cloudfront.OriginRequestPolicyQueryStringsConfig;
  },
  never,
  Providers
> {}

/**
 * A CloudFront origin request policy.
 *
 * Origin request policies control which values from the viewer request (in
 * addition to those used in the cache key) CloudFront includes when sending
 * a request to the origin. They are referenced by ID on a Distribution's
 * default behavior or per-path cache behaviors.
 *
 * @section Creating Origin Request Policies
 * @example Forward all viewer headers and cookies
 * ```typescript
 * const originRequestPolicy = yield* OriginRequestPolicy("AppOriginRequest", {
 *   comment: "Forward auth + locale",
 *   headersConfig: {
 *     HeaderBehavior: "whitelist",
 *     Headers: { Quantity: 2, Items: ["Authorization", "Accept-Language"] },
 *   },
 *   cookiesConfig: { CookieBehavior: "all" },
 *   queryStringsConfig: { QueryStringBehavior: "all" },
 * });
 * ```
 */
export const OriginRequestPolicy = Resource<OriginRequestPolicy>(
  "AWS.CloudFront.OriginRequestPolicy",
);

export const OriginRequestPolicyProvider = () =>
  Provider.effect(
    OriginRequestPolicy,
    Effect.gen(function* () {
      const getById = Effect.fn(function* (id: string) {
        const config = yield* cloudfront
          .getOriginRequestPolicyConfig({ Id: id })
          .pipe(
            Effect.catchTag("NoSuchOriginRequestPolicy", () =>
              Effect.succeed(undefined),
            ),
          );
        if (!config?.OriginRequestPolicyConfig) return undefined;
        return { config: config.OriginRequestPolicyConfig, etag: config.ETag };
      });

      const getByName = Effect.fn(function* (name: string) {
        const listed = yield* cloudfront.listOriginRequestPolicies({
          Type: "custom",
        });
        const summary = listed.OriginRequestPolicyList?.Items?.find(
          (item) =>
            item.OriginRequestPolicy?.OriginRequestPolicyConfig?.Name === name,
        );
        if (!summary?.OriginRequestPolicy?.Id) return undefined;
        return yield* getById(summary.OriginRequestPolicy.Id).pipe(
          Effect.map((found) =>
            found
              ? { id: summary.OriginRequestPolicy.Id, ...found }
              : undefined,
          ),
        );
      });

      const buildConfig = (
        name: string,
        props: OriginRequestPolicyProps,
      ): cloudfront.OriginRequestPolicyConfig => ({
        Name: name,
        Comment: props.comment,
        HeadersConfig: props.headersConfig,
        CookiesConfig: props.cookiesConfig,
        QueryStringsConfig: props.queryStringsConfig,
      });

      const toAttrs = (
        id: string,
        config: cloudfront.OriginRequestPolicyConfig,
        etag: string | undefined,
      ) => ({
        originRequestPolicyId: id,
        name: config.Name,
        etag,
        comment: config.Comment,
        headersConfig: config.HeadersConfig,
        cookiesConfig: config.CookiesConfig,
        queryStringsConfig: config.QueryStringsConfig,
      });

      return {
        stables: ["originRequestPolicyId"],
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
          if (output?.originRequestPolicyId) {
            const found = yield* getById(output.originRequestPolicyId);
            if (found) {
              return toAttrs(
                output.originRequestPolicyId,
                found.config,
                found.etag,
              );
            }
          }
          const name = yield* createName(id, olds ?? {});
          const found = yield* getByName(name);
          if (!found) return undefined;
          return toAttrs(found.id, found.config, found.etag);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);

          // Observe — locate the policy by id (cached on `output`) or
          // by name. Trust observed cloud state, not stale `olds`.
          let observed = output?.originRequestPolicyId
            ? yield* getById(output.originRequestPolicyId).pipe(
                Effect.map((found) =>
                  found
                    ? { id: output.originRequestPolicyId, ...found }
                    : undefined,
                ),
              )
            : undefined;
          if (!observed) {
            observed = yield* getByName(name);
          }

          // Ensure — create the policy if it's missing. Tolerate
          // `OriginRequestPolicyAlreadyExists` (race with a peer
          // reconciler).
          if (!observed) {
            const created = yield* cloudfront
              .createOriginRequestPolicy({
                OriginRequestPolicyConfig: buildConfig(name, news),
              })
              .pipe(
                Effect.catchTag("OriginRequestPolicyAlreadyExists", () =>
                  getByName(name).pipe(
                    Effect.flatMap((existing) =>
                      existing
                        ? Effect.succeed({
                            OriginRequestPolicy: {
                              Id: existing.id,
                              LastModifiedTime: new Date(),
                              OriginRequestPolicyConfig: existing.config,
                            },
                            ETag: existing.etag,
                            Location: undefined,
                          })
                        : Effect.fail(
                            new Error(
                              `Origin request policy '${name}' already exists but could not be recovered`,
                            ),
                          ),
                    ),
                  ),
                ),
              );
            if (!created.OriginRequestPolicy?.Id) {
              return yield* Effect.fail(
                new Error("createOriginRequestPolicy returned no identifier"),
              );
            }
            yield* session.note(created.OriginRequestPolicy.Id);
            return toAttrs(
              created.OriginRequestPolicy.Id,
              created.OriginRequestPolicy.OriginRequestPolicyConfig,
              created.ETag,
            );
          }

          // Sync — patch the observed config to the desired state. The
          // freshly observed ETag handles optimistic concurrency.
          const updated = yield* cloudfront.updateOriginRequestPolicy({
            Id: observed.id,
            IfMatch: observed.etag,
            OriginRequestPolicyConfig: buildConfig(observed.config.Name, news),
          });
          if (!updated.OriginRequestPolicy?.Id) {
            return yield* Effect.fail(
              new Error("updateOriginRequestPolicy returned no identifier"),
            );
          }
          yield* session.note(observed.id);
          return toAttrs(
            updated.OriginRequestPolicy.Id,
            updated.OriginRequestPolicy.OriginRequestPolicyConfig,
            updated.ETag,
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          const current = yield* getById(output.originRequestPolicyId);
          if (!current) return;
          yield* cloudfront
            .deleteOriginRequestPolicy({
              Id: output.originRequestPolicyId,
              IfMatch: current.etag,
            })
            .pipe(
              Effect.catchTag("NoSuchOriginRequestPolicy", () => Effect.void),
            );
        }),
      };
    }),
  );

const createName = (id: string, props: OriginRequestPolicyProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 128, lowercase: true });

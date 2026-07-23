import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ResponseHeadersPolicyProps {
  /**
   * Name of the response headers policy. If omitted, a deterministic name is
   * generated. Names must be unique per AWS account. Changing the name
   * triggers a replacement.
   */
  name?: string;
  /**
   * Optional comment describing the policy.
   */
  comment?: string;
  /**
   * CORS configuration applied to viewer responses.
   */
  corsConfig?: cloudfront.ResponseHeadersPolicyCorsConfig;
  /**
   * Standard security headers (HSTS, X-Frame-Options, etc.) added to
   * viewer responses.
   */
  securityHeadersConfig?: cloudfront.ResponseHeadersPolicySecurityHeadersConfig;
  /**
   * Server-Timing header configuration for measuring CloudFront performance.
   */
  serverTimingHeadersConfig?: cloudfront.ResponseHeadersPolicyServerTimingHeadersConfig;
  /**
   * Custom headers to add to viewer responses.
   */
  customHeadersConfig?: cloudfront.ResponseHeadersPolicyCustomHeadersConfig;
  /**
   * Headers to remove from viewer responses.
   */
  removeHeadersConfig?: cloudfront.ResponseHeadersPolicyRemoveHeadersConfig;
}

export interface ResponseHeadersPolicy extends Resource<
  "AWS.CloudFront.ResponseHeadersPolicy",
  ResponseHeadersPolicyProps,
  {
    /**
     * CloudFront-assigned response headers policy identifier.
     */
    responseHeadersPolicyId: string;
    /**
     * Name of the response headers policy.
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
     * Current CORS configuration.
     */
    corsConfig: cloudfront.ResponseHeadersPolicyCorsConfig | undefined;
    /**
     * Current security headers configuration.
     */
    securityHeadersConfig:
      | cloudfront.ResponseHeadersPolicySecurityHeadersConfig
      | undefined;
    /**
     * Current Server-Timing configuration.
     */
    serverTimingHeadersConfig:
      | cloudfront.ResponseHeadersPolicyServerTimingHeadersConfig
      | undefined;
    /**
     * Current custom headers configuration.
     */
    customHeadersConfig:
      | cloudfront.ResponseHeadersPolicyCustomHeadersConfig
      | undefined;
    /**
     * Current remove-headers configuration.
     */
    removeHeadersConfig:
      | cloudfront.ResponseHeadersPolicyRemoveHeadersConfig
      | undefined;
  },
  never,
  Providers
> {}

/**
 * A CloudFront response headers policy.
 *
 * Response headers policies add or remove headers in viewer responses,
 * including CORS, standard security headers (HSTS, X-Frame-Options,
 * X-Content-Type-Options, Referrer-Policy, etc.), Server-Timing, custom
 * headers and explicit header removal. They are referenced by ID on a
 * Distribution's default behavior or per-path cache behaviors.
 *
 * @section Creating Response Headers Policies
 * @example Standard security + CORS
 * ```typescript
 * const responseHeadersPolicy = yield* ResponseHeadersPolicy("AppResponseHeaders", {
 *   comment: "Default app security + CORS",
 *   corsConfig: {
 *     AccessControlAllowOrigins: { Quantity: 1, Items: ["https://app.example.com"] },
 *     AccessControlAllowMethods: { Quantity: 2, Items: ["GET", "OPTIONS"] },
 *     AccessControlAllowHeaders: { Quantity: 1, Items: ["Authorization"] },
 *     AccessControlAllowCredentials: false,
 *     OriginOverride: true,
 *   },
 *   securityHeadersConfig: {
 *     StrictTransportSecurity: {
 *       AccessControlMaxAgeSec: 31536000,
 *       IncludeSubdomains: true,
 *       Preload: true,
 *       Override: true,
 *     },
 *     ContentTypeOptions: { Override: true },
 *     FrameOptions: { FrameOption: "DENY", Override: true },
 *     ReferrerPolicy: { ReferrerPolicy: "no-referrer", Override: true },
 *   },
 * });
 * ```
 */
export const ResponseHeadersPolicy = Resource<ResponseHeadersPolicy>(
  "AWS.CloudFront.ResponseHeadersPolicy",
);

export const ResponseHeadersPolicyProvider = () =>
  Provider.effect(
    ResponseHeadersPolicy,
    Effect.gen(function* () {
      const getById = Effect.fn(function* (id: string) {
        const config = yield* cloudfront
          .getResponseHeadersPolicyConfig({ Id: id })
          .pipe(
            Effect.catchTag("NoSuchResponseHeadersPolicy", () =>
              Effect.succeed(undefined),
            ),
          );
        if (!config?.ResponseHeadersPolicyConfig) return undefined;
        return {
          config: config.ResponseHeadersPolicyConfig,
          etag: config.ETag,
        };
      });

      const getByName = Effect.fn(function* (name: string) {
        const listed = yield* cloudfront.listResponseHeadersPolicies({
          Type: "custom",
        });
        const summary = listed.ResponseHeadersPolicyList?.Items?.find(
          (item) =>
            item.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig?.Name ===
            name,
        );
        if (!summary?.ResponseHeadersPolicy?.Id) return undefined;
        return yield* getById(summary.ResponseHeadersPolicy.Id).pipe(
          Effect.map((found) =>
            found
              ? { id: summary.ResponseHeadersPolicy.Id, ...found }
              : undefined,
          ),
        );
      });

      const buildConfig = (
        name: string,
        props: ResponseHeadersPolicyProps,
      ): cloudfront.ResponseHeadersPolicyConfig => ({
        Name: name,
        Comment: props.comment,
        CorsConfig: props.corsConfig,
        SecurityHeadersConfig: props.securityHeadersConfig,
        ServerTimingHeadersConfig: props.serverTimingHeadersConfig,
        CustomHeadersConfig: props.customHeadersConfig,
        RemoveHeadersConfig: props.removeHeadersConfig,
      });

      const toAttrs = (
        id: string,
        config: cloudfront.ResponseHeadersPolicyConfig,
        etag: string | undefined,
      ) => ({
        responseHeadersPolicyId: id,
        name: config.Name,
        etag,
        comment: config.Comment,
        corsConfig: config.CorsConfig,
        securityHeadersConfig: config.SecurityHeadersConfig,
        serverTimingHeadersConfig: config.ServerTimingHeadersConfig,
        customHeadersConfig: config.CustomHeadersConfig,
        removeHeadersConfig: config.RemoveHeadersConfig,
      });

      return {
        stables: ["responseHeadersPolicyId"],
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
          if (output?.responseHeadersPolicyId) {
            const found = yield* getById(output.responseHeadersPolicyId);
            if (found) {
              return toAttrs(
                output.responseHeadersPolicyId,
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
          let observed = output?.responseHeadersPolicyId
            ? yield* getById(output.responseHeadersPolicyId).pipe(
                Effect.map((found) =>
                  found
                    ? { id: output.responseHeadersPolicyId, ...found }
                    : undefined,
                ),
              )
            : undefined;
          if (!observed) {
            observed = yield* getByName(name);
          }

          // Ensure — create the policy if it's missing. Tolerate
          // `ResponseHeadersPolicyAlreadyExists` (race with a peer
          // reconciler).
          if (!observed) {
            const created = yield* cloudfront
              .createResponseHeadersPolicy({
                ResponseHeadersPolicyConfig: buildConfig(name, news),
              })
              .pipe(
                Effect.catchTag("ResponseHeadersPolicyAlreadyExists", () =>
                  getByName(name).pipe(
                    Effect.flatMap((existing) =>
                      existing
                        ? Effect.succeed({
                            ResponseHeadersPolicy: {
                              Id: existing.id,
                              LastModifiedTime: new Date(),
                              ResponseHeadersPolicyConfig: existing.config,
                            },
                            ETag: existing.etag,
                            Location: undefined,
                          })
                        : Effect.fail(
                            new Error(
                              `Response headers policy '${name}' already exists but could not be recovered`,
                            ),
                          ),
                    ),
                  ),
                ),
              );
            if (!created.ResponseHeadersPolicy?.Id) {
              return yield* Effect.fail(
                new Error("createResponseHeadersPolicy returned no identifier"),
              );
            }
            yield* session.note(created.ResponseHeadersPolicy.Id);
            return toAttrs(
              created.ResponseHeadersPolicy.Id,
              created.ResponseHeadersPolicy.ResponseHeadersPolicyConfig,
              created.ETag,
            );
          }

          // Sync — patch the observed config to the desired state. The
          // freshly observed ETag handles optimistic concurrency.
          const updated = yield* cloudfront.updateResponseHeadersPolicy({
            Id: observed.id,
            IfMatch: observed.etag,
            ResponseHeadersPolicyConfig: buildConfig(
              observed.config.Name,
              news,
            ),
          });
          if (!updated.ResponseHeadersPolicy?.Id) {
            return yield* Effect.fail(
              new Error("updateResponseHeadersPolicy returned no identifier"),
            );
          }
          yield* session.note(observed.id);
          return toAttrs(
            updated.ResponseHeadersPolicy.Id,
            updated.ResponseHeadersPolicy.ResponseHeadersPolicyConfig,
            updated.ETag,
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          const current = yield* getById(output.responseHeadersPolicyId);
          if (!current) return;
          yield* cloudfront
            .deleteResponseHeadersPolicy({
              Id: output.responseHeadersPolicyId,
              IfMatch: current.etag,
            })
            .pipe(
              Effect.catchTag("NoSuchResponseHeadersPolicy", () => Effect.void),
            );
        }),
      };
    }),
  );

const createName = (id: string, props: ResponseHeadersPolicyProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 128, lowercase: true });

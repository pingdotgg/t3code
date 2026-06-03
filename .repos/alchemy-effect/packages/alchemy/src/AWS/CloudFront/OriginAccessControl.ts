import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface OriginAccessControlProps {
  /**
   * Name of the origin access control. If omitted, a deterministic name is generated.
   */
  name?: string;
  /**
   * Optional description of the origin access control.
   */
  description?: string;
  /**
   * The origin type this OAC signs for.
   * @default "s3"
   */
  originType?: cloudfront.OriginAccessControlOriginTypes;
  /**
   * How CloudFront should apply signing.
   * @default "always"
   */
  signingBehavior?: cloudfront.OriginAccessControlSigningBehaviors;
  /**
   * Signing protocol used by CloudFront.
   * @default "sigv4"
   */
  signingProtocol?: cloudfront.OriginAccessControlSigningProtocols;
}

export interface OriginAccessControl extends Resource<
  "AWS.CloudFront.OriginAccessControl",
  OriginAccessControlProps,
  {
    /**
     * CloudFront-assigned OAC identifier.
     */
    originAccessControlId: string;
    /**
     * Name of the OAC.
     */
    name: string;
    /**
     * Current description of the OAC.
     */
    description: string | undefined;
    /**
     * Origin type configured for the OAC.
     */
    originType: cloudfront.OriginAccessControlOriginTypes;
    /**
     * Signing behavior configured for the OAC.
     */
    signingBehavior: cloudfront.OriginAccessControlSigningBehaviors;
    /**
     * Signing protocol configured for the OAC.
     */
    signingProtocol: cloudfront.OriginAccessControlSigningProtocols;
    /**
     * Most recent entity tag for update/delete operations.
     */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A CloudFront Origin Access Control for private origins.
 *
 * `OriginAccessControl` is the recommended CloudFront access model for private
 * S3 origins and newer signed-origin integrations.
 *
 * @section Creating Origin Access Controls
 * @example S3 Origin Access Control
 * ```typescript
 * const oac = yield* OriginAccessControl("SiteOriginAccess", {
 *   originType: "s3",
 * });
 * ```
 */
export const OriginAccessControl = Resource<OriginAccessControl>(
  "AWS.CloudFront.OriginAccessControl",
);

export const OriginAccessControlProvider = () =>
  Provider.effect(
    OriginAccessControl,
    Effect.gen(function* () {
      const getByName = Effect.fn(function* (name: string) {
        const listed = yield* cloudfront.listOriginAccessControls({});
        const summary =
          listed.OriginAccessControlList?.Items?.find(
            (item) => item.Name === name,
          ) ?? undefined;
        if (!summary?.Id) {
          return undefined;
        }
        const config = yield* cloudfront.getOriginAccessControlConfig({
          Id: summary.Id,
        });
        return {
          OriginAccessControl: {
            Id: summary.Id,
            OriginAccessControlConfig: config.OriginAccessControlConfig,
          },
          ETag: config.ETag,
        };
      });

      const getCurrent = Effect.fn(function* (
        output: OriginAccessControl["Attributes"] | undefined,
      ) {
        if (!output?.originAccessControlId) {
          return undefined;
        }
        const config = yield* cloudfront
          .getOriginAccessControlConfig({
            Id: output.originAccessControlId,
          })
          .pipe(
            Effect.catchTag("NoSuchOriginAccessControl", () =>
              Effect.succeed(undefined),
            ),
          );

        if (!config?.OriginAccessControlConfig) {
          return undefined;
        }

        return {
          OriginAccessControl: {
            Id: output.originAccessControlId,
            OriginAccessControlConfig: config.OriginAccessControlConfig,
          },
          ETag: config.ETag,
        };
      });

      return {
        stables: ["originAccessControlId"],
        diff: Effect.fn(function* ({ id, olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          if (
            (yield* createName(id, olds ?? {})) !==
            (yield* createName(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const existing =
            (yield* getCurrent(output)) ??
            (yield* getByName(yield* createName(id, olds ?? {})));

          if (!existing?.OriginAccessControl?.Id) {
            return undefined;
          }

          return toAttrs(
            existing.OriginAccessControl,
            existing.ETag,
            yield* createName(id, olds ?? {}),
          );
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);

          // Observe — locate the OAC by id (cached on `output`) or by
          // name. Trust observed cloud state, not stale `olds`.
          const observed =
            (yield* getCurrent(output)) ?? (yield* getByName(name));

          // Ensure — create the OAC if it's missing. Tolerate
          // `OriginAccessControlAlreadyExists` (race with a peer
          // reconciler).
          if (!observed?.OriginAccessControl?.Id) {
            const created = yield* cloudfront
              .createOriginAccessControl({
                OriginAccessControlConfig: {
                  Name: name,
                  Description: news.description,
                  OriginAccessControlOriginType: news.originType ?? "s3",
                  SigningBehavior: news.signingBehavior ?? "always",
                  SigningProtocol: news.signingProtocol ?? "sigv4",
                },
              })
              .pipe(
                Effect.catchTag("OriginAccessControlAlreadyExists", () =>
                  getByName(name).pipe(
                    Effect.flatMap((existing) =>
                      existing
                        ? Effect.succeed(existing)
                        : Effect.fail(
                            new Error(
                              `Origin access control '${name}' already exists but could not be recovered`,
                            ),
                          ),
                    ),
                  ),
                ),
              );

            if (!created.OriginAccessControl?.Id) {
              return yield* Effect.fail(
                new Error("createOriginAccessControl returned no identifier"),
              );
            }

            yield* session.note(created.OriginAccessControl.Id);
            return toAttrs(created.OriginAccessControl, created.ETag, name);
          }

          // Sync — patch the observed config to the desired state. The
          // freshly observed ETag handles optimistic concurrency.
          const observedConfig =
            observed.OriginAccessControl.OriginAccessControlConfig;
          const updated = yield* cloudfront.updateOriginAccessControl({
            Id: observed.OriginAccessControl.Id,
            IfMatch: observed.ETag,
            OriginAccessControlConfig: {
              Name: observedConfig?.Name ?? name,
              Description: news.description,
              OriginAccessControlOriginType:
                news.originType ??
                observedConfig?.OriginAccessControlOriginType ??
                "s3",
              SigningBehavior:
                news.signingBehavior ??
                observedConfig?.SigningBehavior ??
                "always",
              SigningProtocol:
                news.signingProtocol ??
                observedConfig?.SigningProtocol ??
                "sigv4",
            },
          });

          if (!updated.OriginAccessControl?.Id) {
            return yield* Effect.fail(
              new Error("updateOriginAccessControl returned no identifier"),
            );
          }

          yield* session.note(observed.OriginAccessControl.Id);
          return toAttrs(
            updated.OriginAccessControl,
            updated.ETag,
            observedConfig?.Name ?? name,
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* cloudfront
            .deleteOriginAccessControl({
              Id: output.originAccessControlId,
              IfMatch: output.etag,
            })
            .pipe(
              Effect.catchTag("NoSuchOriginAccessControl", () => Effect.void),
            );
        }),
      };
    }),
  );

const createName = (id: string, props: OriginAccessControlProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 64,
        lowercase: true,
      });

const toAttrs = (
  oac: cloudfront.OriginAccessControl,
  etag: string | undefined,
  fallbackName: string,
) => ({
  originAccessControlId: oac.Id,
  name: oac.OriginAccessControlConfig?.Name ?? fallbackName,
  description: oac.OriginAccessControlConfig?.Description,
  originType:
    oac.OriginAccessControlConfig?.OriginAccessControlOriginType ?? "s3",
  signingBehavior: oac.OriginAccessControlConfig?.SigningBehavior ?? "always",
  signingProtocol: oac.OriginAccessControlConfig?.SigningProtocol ?? "sigv4",
  etag,
});

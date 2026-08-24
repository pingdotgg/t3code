import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource as AlchemyResource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ResourceProps {
  /**
   * ARN of the S3 location to register with Lake Formation (e.g.
   * `arn:aws:s3:::my-bucket` or `arn:aws:s3:::my-bucket/prefix`). Changing it
   * replaces the registration.
   */
  resourceArn: string;
  /**
   * IAM role Lake Formation uses to vend credentials for the location. When
   * omitted, the `AWSServiceRoleForLakeFormationDataAccess` service-linked
   * role is used (and created on first registration).
   */
  roleArn?: string;
  /**
   * Register using the Lake Formation service-linked role. Only meaningful
   * when `roleArn` is omitted.
   * @default true when `roleArn` is omitted
   */
  useServiceLinkedRole?: boolean;
  /**
   * Whether to register the location with federation (Redshift data sharing).
   * @default false
   */
  withFederation?: boolean;
  /**
   * Allow both Lake Formation permissions and IAM/S3 policies to govern
   * access to the location (hybrid access mode).
   * @default false
   */
  hybridAccessEnabled?: boolean;
}

export interface Resource extends AlchemyResource<
  "AWS.LakeFormation.Resource",
  ResourceProps,
  {
    resourceArn: string;
    roleArn: string | undefined;
    withFederation: boolean | undefined;
    hybridAccessEnabled: boolean | undefined;
  },
  {},
  Providers
> {}

/**
 * Registers an S3 location as managed by AWS Lake Formation, so Lake
 * Formation can vend temporary credentials for data stored there
 * (`DATA_LOCATION_ACCESS` grants, governed tables, etc.).
 *
 * @resource
 * @section Registering Locations
 * @example Register a Bucket with the Service-Linked Role
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const bucket = yield* AWS.S3.Bucket("DataLake", {});
 * const location = yield* AWS.LakeFormation.Resource("DataLakeLocation", {
 *   resourceArn: bucket.bucketArn,
 * });
 * ```
 *
 * @example Register with a Custom Data-Access Role
 * ```typescript
 * const location = yield* AWS.LakeFormation.Resource("DataLakeLocation", {
 *   resourceArn: bucket.bucketArn,
 *   roleArn: dataAccessRole.roleArn,
 *   hybridAccessEnabled: true,
 * });
 * ```
 */
export const Resource = AlchemyResource<Resource>("AWS.LakeFormation.Resource");

export const ResourceProvider = () =>
  Provider.effect(
    Resource,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (resourceArn: string) {
        return yield* lf.describeResource({ ResourceArn: resourceArn }).pipe(
          Effect.map((r) => r.ResourceInfo),
          Effect.catchTag("EntityNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      return Resource.Provider.of({
        stables: ["resourceArn"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* lf.listResources
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.ResourceInfoList ?? [])
              .filter((info) => info.ResourceArn !== undefined)
              .map((info) => ({
                resourceArn: info.ResourceArn!,
                roleArn: info.RoleArn,
                withFederation: info.WithFederation,
                hybridAccessEnabled: info.HybridAccessEnabled,
              }));
          }),

        read: Effect.fn(function* ({ olds, output }) {
          const resourceArn = output?.resourceArn ?? olds?.resourceArn;
          if (resourceArn === undefined) return undefined;
          const info = yield* observe(resourceArn);
          if (info === undefined) return undefined;
          // Registrations are not taggable, so ownership cannot be verified —
          // return the attributes directly.
          return {
            resourceArn,
            roleArn: info.RoleArn,
            withFederation: info.WithFederation,
            hybridAccessEnabled: info.HybridAccessEnabled,
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.resourceArn !== olds.resourceArn) {
            return { action: "replace" } as const;
          }
          // roleArn / withFederation / hybridAccessEnabled → update
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const resourceArn = news.resourceArn;
          const register = lf.registerResource({
            ResourceArn: resourceArn,
            UseServiceLinkedRole:
              news.roleArn !== undefined
                ? undefined
                : (news.useServiceLinkedRole ?? true),
            RoleArn: news.roleArn,
            WithFederation: news.withFederation,
            HybridAccessEnabled: news.hybridAccessEnabled,
          });

          // 1. OBSERVE
          let info = yield* observe(resourceArn);

          // 2. ENSURE
          if (info === undefined) {
            yield* register.pipe(
              Effect.catchTag("AlreadyExistsException", () => Effect.void),
            );
            info = yield* observe(resourceArn);
          } else {
            // 3. SYNC — role and registration flags, observed vs desired.
            const desiredRole = news.roleArn;
            const roleDrift =
              desiredRole !== undefined && desiredRole !== info.RoleArn;
            const hybridDrift =
              news.hybridAccessEnabled !== undefined &&
              news.hybridAccessEnabled !== (info.HybridAccessEnabled ?? false);
            const federationDrift =
              news.withFederation !== undefined &&
              news.withFederation !== (info.WithFederation ?? false);
            if (roleDrift || hybridDrift || federationDrift) {
              const slrManaged =
                info.RoleArn?.includes(
                  "/aws-service-role/lakeformation.amazonaws.com/",
                ) ?? false;
              if (slrManaged) {
                // UpdateResource rejects registrations held by the
                // service-linked role ("Resource managed by Service Linked
                // Role") — recreate the registration in place instead.
                yield* lf.deregisterResource({ ResourceArn: resourceArn }).pipe(
                  Effect.catchTag("EntityNotFoundException", () => Effect.void),
                  // spurious error on the last SLR location — the
                  // deregistration still succeeds (see delete below)
                  Effect.catchTag(
                    "LastServiceLinkedRoleRegistration",
                    () => Effect.void,
                  ),
                );
                yield* register;
              } else {
                const updateRole = desiredRole ?? info.RoleArn;
                if (updateRole !== undefined) {
                  yield* lf.updateResource({
                    ResourceArn: resourceArn,
                    RoleArn: updateRole,
                    WithFederation: news.withFederation,
                    HybridAccessEnabled: news.hybridAccessEnabled,
                  });
                }
              }
              info = yield* observe(resourceArn);
            }
          }

          yield* session.note(resourceArn);
          return {
            resourceArn,
            roleArn: info?.RoleArn,
            withFederation: info?.WithFederation,
            hybridAccessEnabled: info?.HybridAccessEnabled,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* lf
            .deregisterResource({ ResourceArn: output.resourceArn })
            .pipe(
              Effect.catchTag("EntityNotFoundException", () => Effect.void),
              // Deregistering the LAST location registered with the
              // service-linked role returns "Must manually delete
              // service-linked role to deregister last S3 location" even
              // though the registration IS removed (verified live). Verify
              // and only re-fail if the registration is still present.
              Effect.catchTag("LastServiceLinkedRoleRegistration", (error) =>
                lf.describeResource({ ResourceArn: output.resourceArn }).pipe(
                  Effect.flatMap(() => Effect.fail(error)),
                  Effect.catchTag("EntityNotFoundException", () => Effect.void),
                ),
              ),
            );
        }),
      });
    }),
  );

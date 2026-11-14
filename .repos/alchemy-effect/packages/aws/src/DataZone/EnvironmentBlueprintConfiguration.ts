import * as datazone from "@distilled.cloud/aws/datazone";
import * as lf from "@distilled.cloud/aws/lakeformation";
import { Region } from "@distilled.cloud/aws/Region";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { RegionID } from "../Region.ts";

/**
 * Lake Formation provisioning configuration for a blueprint.
 */
export interface BlueprintLakeFormationConfiguration {
  /** The ARN of the role used to register S3 locations with Lake Formation. */
  locationRegistrationRole?: string;
  /** S3 locations to exclude from Lake Formation registration. */
  locationRegistrationExcludeS3Locations?: string[];
}

/**
 * A provisioning configuration attached to a blueprint configuration.
 */
export interface BlueprintProvisioningConfiguration {
  /** Lake Formation settings applied when the blueprint provisions environments. */
  lakeFormationConfiguration: BlueprintLakeFormationConfiguration;
}

export interface EnvironmentBlueprintConfigurationProps {
  /**
   * The identifier of the {@link Domain} to configure the blueprint in.
   * Accepts a domain's `domainId` output. Changing it triggers a
   * replacement.
   */
  domainId: string;
  /**
   * The managed environment blueprint to configure — a blueprint name
   * (e.g. `"DefaultDataLake"`, `"DefaultDataWarehouse"`) or a raw blueprint
   * identifier. Changing it triggers a replacement.
   */
  environmentBlueprint: string;
  /**
   * The regions in which environments may be created from this blueprint.
   */
  enabledRegions: string[];
  /**
   * The ARN of the role DataZone uses to provision environment resources
   * (CloudFormation stacks) from this blueprint.
   */
  provisioningRoleArn?: string;
  /**
   * The ARN of the role DataZone uses to manage access grants to
   * environment resources (e.g. Lake Formation permissions).
   */
  manageAccessRoleArn?: string;
  /**
   * The ARN of a permission boundary policy to apply to environment roles
   * created from this blueprint.
   */
  environmentRolePermissionBoundary?: string;
  /**
   * Region-scoped provisioning parameters, keyed by region then parameter
   * name (e.g. `{ "us-west-2": { S3Location: "s3://bucket" } }`).
   */
  regionalParameters?: Record<string, Record<string, string>>;
  /**
   * Global provisioning parameters applied in every enabled region.
   */
  globalParameters?: Record<string, string>;
  /**
   * Additional provisioning configurations (e.g. Lake Formation location
   * registration).
   */
  provisioningConfigurations?: BlueprintProvisioningConfiguration[];
}

export interface EnvironmentBlueprintConfiguration extends Resource<
  "AWS.DataZone.EnvironmentBlueprintConfiguration",
  EnvironmentBlueprintConfigurationProps,
  {
    /** The identifier of the domain the configuration lives in. */
    domainId: string;
    /** The identifier of the configured environment blueprint. */
    environmentBlueprintId: string;
    /** The name of the configured environment blueprint. */
    environmentBlueprintName: string;
    /** The regions in which the blueprint is enabled. */
    enabledRegions: string[];
    /** The ARN of the provisioning role. */
    provisioningRoleArn: string | undefined;
    /** The ARN of the manage-access role. */
    manageAccessRoleArn: string | undefined;
    /**
     * Lake Formation administrator entries this configuration is responsible
     * for: the provisioning and manage-access roles, per enabled region,
     * wherever the role was not already an administrator. DataZone makes both
     * roles administrators when it deploys an environment; delete removes
     * these entries again.
     */
    lakeFormationAdmins?: LakeFormationAdminEntry[];
  }
> {}

/**
 * The account/domain configuration of an Amazon DataZone environment
 * blueprint — enables a managed blueprint (like `DefaultDataLake`) in
 * specific regions with the IAM roles DataZone should provision with.
 *
 * The blueprint itself is an AWS-managed definition; this resource owns only
 * its per-domain configuration (a `PUT`-style singleton keyed by domain +
 * blueprint).
 *
 * ### Configuring Blueprints
 * **Example:** Enable the DefaultDataLake Blueprint
 * ```typescript
 * import * as DataZone from "@alchemy.run/aws/DataZone";
 *
 * const config = yield* DataZone.EnvironmentBlueprintConfiguration(
 *   "datalake",
 *   {
 *     domainId: domain.domainId,
 *     environmentBlueprint: "DefaultDataLake",
 *     enabledRegions: ["us-west-2"],
 *     provisioningRoleArn: provisioningRole.roleArn,
 *     manageAccessRoleArn: manageAccessRole.roleArn,
 *     regionalParameters: {
 *       "us-west-2": { S3Location: "s3://my-datalake-bucket" },
 *     },
 *   },
 * );
 * ```
 *
 * **Example:** Blueprint with Lake Formation Provisioning
 * ```typescript
 * const config = yield* DataZone.EnvironmentBlueprintConfiguration(
 *   "datalake",
 *   {
 *     domainId: domain.domainId,
 *     environmentBlueprint: "DefaultDataLake",
 *     enabledRegions: ["us-west-2"],
 *     provisioningRoleArn: provisioningRole.roleArn,
 *     provisioningConfigurations: [
 *       {
 *         lakeFormationConfiguration: {
 *           locationRegistrationRole: registrationRole.roleArn,
 *         },
 *       },
 *     ],
 *   },
 * );
 * ```
 *
 * @resource
 */
export const EnvironmentBlueprintConfiguration = Resource<EnvironmentBlueprintConfiguration>(
  "AWS.DataZone.EnvironmentBlueprintConfiguration",
);

/** No blueprint with the requested name or id exists in the domain. */
export class EnvironmentBlueprintNotFound extends Data.TaggedError(
  "AWS.DataZone.EnvironmentBlueprintNotFound",
)<{
  readonly domainId: string;
  readonly environmentBlueprint: string;
}> {}

/**
 * Freshly created IAM roles are eventually consistent; the PUT can
 * transiently reject a provisioning/manage-access role it cannot yet assume.
 * Wrapped in an explicitly-typed helper so the `Effect.retry` conditional
 * return type does not leak into declaration emit (see PATTERNS §7).
 */
const retryWhileRoleAssumeFails = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      (e._tag === "ValidationException" || e._tag === "AccessDeniedException") &&
      "message" in e &&
      typeof e.message === "string" &&
      (e.message.toLowerCase().includes("role") || e.message.toLowerCase().includes("assume")),
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

/** A Lake Formation administrator entry in one region's catalog. */
export interface LakeFormationAdminEntry {
  /** The administrator principal (an IAM role ARN). */
  principal: string;
  /** The region whose Data Catalog lists the administrator. */
  region: string;
}

/** Run a Lake Formation call against a specific region's catalog. */
const inRegion = (region: string) =>
  Effect.provideService(Region, Effect.succeed(region as RegionID));

const isLakeFormationAdmin = Effect.fn(function* (roleArn: string, region: string) {
  const { DataLakeSettings: settings } = yield* lf.getDataLakeSettings({}).pipe(inRegion(region));
  return (settings?.DataLakeAdmins ?? []).some((p) => p.DataLakePrincipalIdentifier === roleArn);
});

/**
 * Remove `roleArn` from the region's Lake Formation administrators. Left
 * behind, the entry dangles once the role is deleted and Lake Formation
 * rejects every later administrator write in the region as an invalid
 * principal.
 */
const removeLakeFormationAdmin = Effect.fn(function* (roleArn: string, region: string) {
  const { DataLakeSettings: settings = {} } = yield* lf
    .getDataLakeSettings({})
    .pipe(inRegion(region));
  const admins = settings.DataLakeAdmins ?? [];
  if (!admins.some((p) => p.DataLakePrincipalIdentifier === roleArn)) return;
  yield* lf
    .putDataLakeSettings({
      DataLakeSettings: {
        ...settings,
        DataLakeAdmins: admins.filter((p) => p.DataLakePrincipalIdentifier !== roleArn),
      },
    })
    .pipe(inRegion(region));
});

export const EnvironmentBlueprintConfigurationProvider = () =>
  Provider.effect(
    EnvironmentBlueprintConfiguration,
    Effect.gen(function* () {
      // Resolve a blueprint name-or-id to its { id, name } within the domain.
      const resolveBlueprint = Effect.fn(function* (domainId: string, nameOrId: string) {
        const match = yield* datazone.listEnvironmentBlueprints
          .items({
            domainIdentifier: domainId,
            managed: true,
          })
          .pipe(
            Stream.filter((b) => b.name === nameOrId || b.id === nameOrId),
            Stream.runHead,
            Effect.map((head) => (head._tag === "Some" ? head.value : undefined)),
          );
        if (match === undefined) {
          return yield* new EnvironmentBlueprintNotFound({
            domainId,
            environmentBlueprint: nameOrId,
          });
        }
        return { id: match.id, name: match.name };
      });

      // A deleted configuration — or one inside a deleted domain — is
      // reported as AccessDeniedException, NOT ResourceNotFoundException:
      // DataZone evaluates domain-scoped authorization before existence.
      // Both mean "absent".
      const getConfigurationOrUndefined = Effect.fn(function* (
        domainId: string,
        blueprintId: string,
      ) {
        return yield* datazone
          .getEnvironmentBlueprintConfiguration({
            domainIdentifier: domainId,
            environmentBlueprintIdentifier: blueprintId,
          })
          .pipe(
            Effect.catchTags({
              ResourceNotFoundException: () => Effect.undefined,
              AccessDeniedException: () => Effect.undefined,
            }),
          );
      });

      return EnvironmentBlueprintConfiguration.Provider.of({
        stables: ["domainId", "environmentBlueprintId"],

        // Configurations are keyed by their parent domain — there is no
        // account-level enumeration without a domain identifier.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const domainId = output?.domainId ?? olds?.domainId;
          if (domainId === undefined) return undefined;
          const blueprint = output?.environmentBlueprintId
            ? {
                id: output.environmentBlueprintId,
                name: output.environmentBlueprintName,
              }
            : olds?.environmentBlueprint
              ? yield* resolveBlueprint(domainId, olds.environmentBlueprint).pipe(
                  Effect.catchTags({
                    "AWS.DataZone.EnvironmentBlueprintNotFound": () => Effect.undefined,
                    // the domain itself may already be gone (reported as
                    // NotFound or as AccessDenied — auth precedes existence)
                    ResourceNotFoundException: () => Effect.undefined,
                    AccessDeniedException: () => Effect.undefined,
                  }),
                )
              : undefined;
          if (blueprint === undefined) return undefined;
          const config = yield* getConfigurationOrUndefined(domainId, blueprint.id);
          // An un-configured blueprint returns an empty configuration shell —
          // treat "no enabled regions and no roles" as absent.
          if (
            config === undefined ||
            ((config.enabledRegions ?? []).length === 0 &&
              config.provisioningRoleArn === undefined &&
              config.manageAccessRoleArn === undefined)
          ) {
            return undefined;
          }
          // Blueprint configurations have no tags — ownership is tracked
          // purely by identity.
          return {
            domainId: config.domainId,
            environmentBlueprintId: config.environmentBlueprintId,
            environmentBlueprintName: blueprint.name,
            enabledRegions: [...(config.enabledRegions ?? [])],
            provisioningRoleArn: config.provisioningRoleArn,
            manageAccessRoleArn: config.manageAccessRoleArn,
            lakeFormationAdmins: output?.lakeFormationAdmins,
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds === undefined) return undefined;
          if (olds.domainId !== news.domainId) {
            return { action: "replace" } as const;
          }
          if (olds.environmentBlueprint !== news.environmentBlueprint) {
            return { action: "replace" } as const;
          }
          // regions, roles, and parameters converge via the idempotent PUT.
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const domainId = news.domainId;
          const blueprint = output?.environmentBlueprintId
            ? {
                id: output.environmentBlueprintId,
                name: output.environmentBlueprintName,
              }
            : yield* resolveBlueprint(domainId, news.environmentBlueprint);

          // The (role, region) administrator entries DataZone may add for
          // this configuration.
          const roles = [news.provisioningRoleArn, news.manageAccessRoleArn].filter(
            (role): role is string => role !== undefined,
          );
          const candidates = roles.flatMap((principal) =>
            news.enabledRegions.map((region) => ({ principal, region })),
          );
          const same = (a: LakeFormationAdminEntry) => (b: LakeFormationAdminEntry) =>
            a.principal === b.principal && a.region === b.region;
          const previous = output?.lakeFormationAdmins ?? [];

          // Release entries for roles or regions no longer configured.
          for (const entry of previous.filter((e) => !candidates.some(same(e)))) {
            yield* removeLakeFormationAdmin(entry.principal, entry.region);
          }

          // Observe, before DataZone can add it, where each role is not yet an
          // administrator — those entries are ours to remove.
          const lakeFormationAdmins = yield* Effect.filter(candidates, (entry) =>
            previous.some(same(entry))
              ? Effect.succeed(true)
              : isLakeFormationAdmin(entry.principal, entry.region).pipe(
                  Effect.map((admin) => !admin),
                ),
          );

          // PutEnvironmentBlueprintConfiguration is a true upsert — one call
          // converges greenfield, update, and adoption alike.
          const config = yield* retryWhileRoleAssumeFails(
            datazone.putEnvironmentBlueprintConfiguration({
              domainIdentifier: domainId,
              environmentBlueprintIdentifier: blueprint.id,
              enabledRegions: news.enabledRegions,
              provisioningRoleArn: news.provisioningRoleArn,
              manageAccessRoleArn: news.manageAccessRoleArn,
              environmentRolePermissionBoundary: news.environmentRolePermissionBoundary,
              regionalParameters: news.regionalParameters,
              globalParameters: news.globalParameters,
              provisioningConfigurations: news.provisioningConfigurations,
            }),
          );

          yield* session.note(`${blueprint.name} (${blueprint.id})`);
          return {
            domainId: config.domainId,
            environmentBlueprintId: config.environmentBlueprintId,
            environmentBlueprintName: blueprint.name,
            enabledRegions: [...(config.enabledRegions ?? news.enabledRegions)],
            provisioningRoleArn: config.provisioningRoleArn,
            manageAccessRoleArn: config.manageAccessRoleArn,
            lakeFormationAdmins,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* datazone
            .deleteEnvironmentBlueprintConfiguration({
              domainIdentifier: output.domainId,
              environmentBlueprintIdentifier: output.environmentBlueprintId,
            })
            .pipe(
              // Environments created from the configuration may still be
              // deleting; DataZone refuses until they are gone.
              Effect.retry({
                while: (e) => e._tag === "EnvironmentBlueprintConfigurationInUse",
                schedule: Schedule.spaced("5 seconds"),
                times: 24,
              }),
              Effect.catchTags({
                ResourceNotFoundException: () => Effect.void,
                // deleting a configuration whose domain is already gone
                // surfaces as AccessDenied — auth is checked before existence.
                AccessDeniedException: () => Effect.void,
              }),
            );
          for (const entry of output.lakeFormationAdmins ?? []) {
            yield* removeLakeFormationAdmin(entry.principal, entry.region);
          }
        }),
      });
    }),
  );

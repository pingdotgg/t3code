import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  configurationProfileArn,
  readAppConfigTags,
  syncAppConfigTags,
} from "./internal.ts";

/**
 * A validator run against configuration data before it is deployed.
 */
export interface ConfigurationValidator {
  /** Validator kind. */
  type: "JSON_SCHEMA" | "LAMBDA";
  /**
   * For `JSON_SCHEMA`, the JSON Schema document. For `LAMBDA`, the ARN of the
   * validating Lambda function.
   */
  content: string;
}

export interface ConfigurationProfileProps {
  /**
   * ID of the application this profile belongs to. Changing it replaces the
   * profile.
   */
  applicationId: string;
  /**
   * Name of the configuration profile. Must be 1-64 characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces the
   * profile.
   */
  configurationProfileName?: string;
  /**
   * URI of the configuration source. Use `"hosted"` for the AppConfig hosted
   * configuration store, or an S3 URI (`s3://bucket/key`), SSM parameter/
   * document name, Secrets Manager secret, or CodePipeline pipeline ARN.
   * Immutable — changing it replaces the profile.
   * @default "hosted"
   */
  locationUri?: string;
  /**
   * Description of the configuration profile.
   */
  description?: string;
  /**
   * ARN of an IAM role AppConfig assumes to fetch configuration from a
   * non-hosted source (S3, SSM, Secrets Manager). Not required for `"hosted"`.
   */
  retrievalRoleArn?: string;
  /**
   * Validators run against the configuration data before deployment.
   */
  validators?: ConfigurationValidator[];
  /**
   * Configuration profile type. `"AWS.Freeform"` for free-form configuration
   * or `"AWS.AppConfig.FeatureFlags"` for feature flags. Immutable — changing
   * it replaces the profile.
   * @default "AWS.Freeform"
   */
  type?: string;
  /**
   * Customer-managed KMS key ARN/id used to encrypt the configuration data.
   */
  kmsKeyIdentifier?: string;
  /**
   * User-defined tags for the configuration profile.
   */
  tags?: Record<string, string>;
}

export interface ConfigurationProfile extends Resource<
  "AWS.AppConfig.ConfigurationProfile",
  ConfigurationProfileProps,
  {
    configurationProfileId: string;
    configurationProfileName: string;
    applicationId: string;
    locationUri: string;
    configurationProfileArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS AppConfig configuration profile — describes where the configuration
 * data lives (the AppConfig hosted store, S3, SSM, Secrets Manager, or
 * CodePipeline) and how to validate it.
 *
 * @resource
 * @section Creating a Configuration Profile
 * @example Hosted Configuration Profile
 * ```typescript
 * const profile = yield* AppConfig.ConfigurationProfile("Settings", {
 *   applicationId: app.applicationId,
 *   locationUri: "hosted",
 * });
 * ```
 *
 * @example S3-sourced Profile with a JSON Schema Validator
 * ```typescript
 * const profile = yield* AppConfig.ConfigurationProfile("Settings", {
 *   applicationId: app.applicationId,
 *   locationUri: "s3://my-bucket/config.json",
 *   retrievalRoleArn: role.roleArn,
 *   validators: [{ type: "JSON_SCHEMA", content: schemaJson }],
 * });
 * ```
 */
export const ConfigurationProfile = Resource<ConfigurationProfile>(
  "AWS.AppConfig.ConfigurationProfile",
);

const toWireValidators = (
  validators: ConfigurationValidator[] | undefined,
): appconfig.Validator[] | undefined =>
  validators?.map((v) => ({ Type: v.type, Content: v.content }));

export const ConfigurationProfileProvider = () =>
  Provider.effect(
    ConfigurationProfile,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ConfigurationProfileProps>) =>
        props.configurationProfileName
          ? Effect.succeed(props.configurationProfileName)
          : createPhysicalName({ id, maxLength: 64 });

      const readProfile = Effect.fn(function* (
        applicationId: string,
        configurationProfileId: string,
      ) {
        return yield* appconfig
          .getConfigurationProfile({
            ApplicationId: applicationId,
            ConfigurationProfileId: configurationProfileId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const findByName = Effect.fn(function* (
        applicationId: string,
        name: string,
      ) {
        const profiles = yield* appconfig.listConfigurationProfiles
          .pages({ ApplicationId: applicationId })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Items ?? []),
            ),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed([] as appconfig.ConfigurationProfileSummary[]),
            ),
          );
        const summary = profiles.find((p) => p.Name === name);
        if (summary?.Id === undefined) return undefined;
        return yield* readProfile(applicationId, summary.Id);
      });

      return {
        stables: [
          "configurationProfileId",
          "configurationProfileName",
          "applicationId",
          "locationUri",
          "configurationProfileArn",
        ],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if ((olds?.applicationId ?? undefined) !== news?.applicationId) {
            return { action: "replace" } as const;
          }
          // LocationUri and Type are create-only.
          if (
            (olds?.locationUri ?? "hosted") !== (news?.locationUri ?? "hosted")
          ) {
            return { action: "replace" } as const;
          }
          if (
            (olds?.type ?? "AWS.Freeform") !== (news?.type ?? "AWS.Freeform")
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const applicationId = output?.applicationId ?? olds?.applicationId;
          if (applicationId === undefined) return undefined;
          const profile = output?.configurationProfileId
            ? yield* readProfile(applicationId, output.configurationProfileId)
            : yield* findByName(applicationId, yield* toName(id, olds ?? {}));
          if (profile?.Id === undefined) return undefined;
          const arn = configurationProfileArn(
            region,
            accountId,
            applicationId,
            profile.Id,
          );
          const attrs = {
            configurationProfileId: profile.Id,
            configurationProfileName: profile.Name!,
            applicationId,
            locationUri: profile.LocationUri ?? "hosted",
            configurationProfileArn: arn,
          };
          const tags = yield* readAppConfigTags(arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const applicationId = news.applicationId;
          const name =
            output?.configurationProfileName ?? (yield* toName(id, news));
          const locationUri = news.locationUri ?? "hosted";
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe.
          let observed = output?.configurationProfileId
            ? yield* readProfile(applicationId, output.configurationProfileId)
            : undefined;
          if (observed === undefined) {
            observed = yield* findByName(applicationId, name);
          }

          // 2. Ensure.
          if (observed?.Id === undefined) {
            observed = yield* appconfig.createConfigurationProfile({
              ApplicationId: applicationId,
              Name: name,
              LocationUri: locationUri,
              Description: news.description,
              RetrievalRoleArn: news.retrievalRoleArn,
              Validators: toWireValidators(news.validators),
              Type: news.type,
              KmsKeyIdentifier: news.kmsKeyIdentifier,
              Tags: desiredTags,
            });
          } else {
            // 3. Sync — description, retrieval role, validators, and KMS key
            // are mutable in place.
            observed = yield* appconfig.updateConfigurationProfile({
              ApplicationId: applicationId,
              ConfigurationProfileId: observed.Id,
              Description: news.description,
              RetrievalRoleArn: news.retrievalRoleArn,
              Validators: toWireValidators(news.validators),
              KmsKeyIdentifier: news.kmsKeyIdentifier,
            });
          }

          const arn = configurationProfileArn(
            region,
            accountId,
            applicationId,
            observed.Id!,
          );

          // 3b. Sync tags.
          yield* syncAppConfigTags(arn, desiredTags);

          yield* session.note(name);
          return {
            configurationProfileId: observed.Id!,
            configurationProfileName: observed.Name ?? name,
            applicationId,
            locationUri: observed.LocationUri ?? locationUri,
            configurationProfileArn: arn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Hosted configuration versions block profile deletion, and
          // runtime writers (the CreateHostedConfigurationVersion binding)
          // can add versions the engine never tracked — delete whatever
          // versions remain before deleting the profile.
          const versions = yield* appconfig.listHostedConfigurationVersions
            .pages({
              ApplicationId: output.applicationId,
              ConfigurationProfileId: output.configurationProfileId,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.Items ?? []),
              ),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed([]),
              ),
            );
          for (const version of versions) {
            if (version.VersionNumber !== undefined) {
              yield* appconfig
                .deleteHostedConfigurationVersion({
                  ApplicationId: output.applicationId,
                  ConfigurationProfileId: output.configurationProfileId,
                  VersionNumber: version.VersionNumber,
                })
                .pipe(
                  Effect.catchTag(
                    "ResourceNotFoundException",
                    () => Effect.void,
                  ),
                );
            }
          }
          yield* appconfig
            .deleteConfigurationProfile({
              ApplicationId: output.applicationId,
              ConfigurationProfileId: output.configurationProfileId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        // Configuration profiles are keyed under their parent application, so
        // enumeration walks every application and lists its profiles. An
        // application cannot be deleted while profiles exist under it, so
        // nuke needs these enumerated as first-class resources.
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const apps = yield* appconfig.listApplications.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.Items ?? []),
              ),
            );
            const results: {
              configurationProfileId: string;
              configurationProfileName: string;
              applicationId: string;
              locationUri: string;
              configurationProfileArn: string;
            }[] = [];
            for (const app of apps) {
              if (app.Id === undefined) continue;
              const profiles = yield* appconfig.listConfigurationProfiles
                .pages({ ApplicationId: app.Id })
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((page) => page.Items ?? []),
                  ),
                  // The application may be deleted between the two calls.
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(
                      [] as appconfig.ConfigurationProfileSummary[],
                    ),
                  ),
                );
              for (const profile of profiles) {
                if (profile.Id === undefined || profile.Name === undefined) {
                  continue;
                }
                results.push({
                  configurationProfileId: profile.Id,
                  configurationProfileName: profile.Name,
                  applicationId: app.Id,
                  locationUri: profile.LocationUri ?? "hosted",
                  configurationProfileArn: configurationProfileArn(
                    region,
                    accountId,
                    app.Id,
                    profile.Id,
                  ),
                });
              }
            }
            return results;
          }),
      };
    }),
  );

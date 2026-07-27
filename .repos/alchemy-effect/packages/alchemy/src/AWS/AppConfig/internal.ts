import * as appconfig from "@distilled.cloud/aws/appconfig";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Build the ARN of an AppConfig application from its identity.
 * `arn:aws:appconfig:{region}:{account}:application/{appId}`
 */
export const applicationArn = (
  region: string,
  accountId: string,
  applicationId: string,
): string =>
  `arn:aws:appconfig:${region}:${accountId}:application/${applicationId}`;

/**
 * Build the ARN of an AppConfig environment.
 * `arn:aws:appconfig:{region}:{account}:application/{appId}/environment/{envId}`
 */
export const environmentArn = (
  region: string,
  accountId: string,
  applicationId: string,
  environmentId: string,
): string =>
  `arn:aws:appconfig:${region}:${accountId}:application/${applicationId}/environment/${environmentId}`;

/**
 * Build the ARN of an AppConfig configuration profile.
 * `arn:aws:appconfig:{region}:{account}:application/{appId}/configurationprofile/{id}`
 */
export const configurationProfileArn = (
  region: string,
  accountId: string,
  applicationId: string,
  configurationProfileId: string,
): string =>
  `arn:aws:appconfig:${region}:${accountId}:application/${applicationId}/configurationprofile/${configurationProfileId}`;

/**
 * Build the ARN of an AppConfig deployment strategy.
 * `arn:aws:appconfig:{region}:{account}:deploymentstrategy/{id}`
 */
export const deploymentStrategyArn = (
  region: string,
  accountId: string,
  deploymentStrategyId: string,
): string =>
  `arn:aws:appconfig:${region}:${accountId}:deploymentstrategy/${deploymentStrategyId}`;

/**
 * Data-plane resource ARN used by appconfigdata (StartConfigurationSession /
 * GetLatestConfiguration). Note the segment is `configuration`, not
 * `configurationprofile`.
 * `arn:aws:appconfig:{region}:{account}:application/{appId}/environment/{envId}/configuration/{profileId}`
 */
export const configurationDataArn = (
  region: string,
  accountId: string,
  applicationId: string,
  environmentId: string,
  configurationProfileId: string,
): string =>
  `arn:aws:appconfig:${region}:${accountId}:application/${applicationId}/environment/${environmentId}/configuration/${configurationProfileId}`;

/**
 * Build the ARN of an AppConfig extension association.
 * `arn:aws:appconfig:{region}:{account}:extensionassociation/{id}`
 */
export const extensionAssociationArn = (
  region: string,
  accountId: string,
  extensionAssociationId: string,
): string =>
  `arn:aws:appconfig:${region}:${accountId}:extensionassociation/${extensionAssociationId}`;

/** Drop undefined values from an AppConfig tag map. */
export const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * Read the observed tags of an AppConfig resource. Tag reads are best-effort —
 * a failure (e.g. a race with deletion) reports no tags.
 */
export const readAppConfigTags = Effect.fn(function* (arn: string) {
  const response = yield* appconfig
    .listTagsForResource({ ResourceArn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.Tags);
});

/**
 * Sync tags on an AppConfig resource: diff the OBSERVED cloud tags against the
 * desired set and apply only the delta.
 */
export const syncAppConfigTags = Effect.fn(function* (
  arn: string,
  desiredTags: Record<string, string>,
) {
  const observedTags = yield* readAppConfigTags(arn);
  const { removed, upsert } = diffTags(observedTags, desiredTags);
  if (upsert.length > 0) {
    yield* appconfig.tagResource({
      ResourceArn: arn,
      Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* appconfig.untagResource({ ResourceArn: arn, TagKeys: removed });
  }
});

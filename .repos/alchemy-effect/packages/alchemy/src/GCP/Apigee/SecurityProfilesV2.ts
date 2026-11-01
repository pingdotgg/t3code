import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  orgParent,
  organizationFromName,
  sameJson,
  toResourceId,
} from "./names.ts";
import {
  createInternalLabels,
  encodeOwnership,
  hasAlchemyLabels,
  hasOwnershipMarker,
  parseOwnership,
} from "./ownership.ts";

const MAX_NAME_LENGTH = 63;

export type ProfileAssessmentConfig = {
  /**
   * Weight of this assessment.
   */
  weight?:
    | apigee.GoogleCloudApigeeV1SecurityProfileV2ProfileAssessmentConfigWeightEnum
    | (string & {});
  /**
   * API Hub gateway types to include.
   */
  include?: Array<
    | apigee.GoogleCloudApigeeV1SecurityProfileV2ProfileAssessmentConfigApiHubGatewayTypeArrayGatewayTypesItemEnum
    | (string & {})
  >;
};

export type SecurityProfilesV2Props = {
  /**
   * Apigee organization id. Defaults to the current GCP project id.
   * Immutable — changing it replaces the profile.
   */
  organization?: string;
  /**
   * Profile id (the `{profile}` segment of
   * `organizations/{org}/securityProfilesV2/{profile}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the profile.
   */
  securityProfileV2Id?: string;
  /**
   * Human-readable description. Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes. Profiles have no
   * labels field.
   */
  description?: string;
  /**
   * Risk assessment type.
   * @default "APIGEE"
   */
  riskAssessmentType?:
    | apigee.GoogleCloudApigeeV1SecurityProfileV2RiskAssessmentTypeEnum
    | (string & {});
  /**
   * Configuration for each assessment, keyed by assessment id.
   * @default `{ authorization: { weight: "MODERATE" }, threat: { weight: "MODERATE" } }`
   */
  profileAssessmentConfigs?: Record<string, ProfileAssessmentConfig>;
};

export type SecurityProfilesV2 = Resource<
  "GCP.Apigee.SecurityProfilesV2",
  SecurityProfilesV2Props,
  {
    /** Full resource name `organizations/{org}/securityProfilesV2/{profile}`. */
    name: string;
    /** Profile id (last path segment). */
    securityProfileV2Id: string;
    /** Apigee organization id. */
    organization: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Risk assessment type. */
    riskAssessmentType: string | undefined;
    /** Assessment configuration map. */
    profileAssessmentConfigs: Record<string, ProfileAssessmentConfig>;
    /** Whether this profile is Google-defined. */
    googleDefined: boolean | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Advanced API Security profile (risk assessment v2).
 *
 * Profiles have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Google-defined profiles are ignored by
 * `list`. Name and organization are identity — changing them replaces
 * the profile. Description and assessment configs update in place.
 *
 * ### Creating a Profile
 * **Example:** Generated name with default assessments
 * ```typescript
 * const profile = yield* GCP.Apigee.SecurityProfilesV2("Baseline", {});
 * ```
 *
 * **Example:** Named profile with explicit weights
 * ```typescript
 * const profile = yield* GCP.Apigee.SecurityProfilesV2("Baseline", {
 *   securityProfileV2Id: "app-baseline",
 *   description: "production scoring",
 *   profileAssessmentConfigs: {
 *     authorization: { weight: "MAJOR" },
 *     threat: { weight: "MODERATE" },
 *     cors: { weight: "MINOR" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const SecurityProfilesV2 = Resource<SecurityProfilesV2>(
  "GCP.Apigee.SecurityProfilesV2",
);

export class SecurityProfilesV2NotResolved extends Data.TaggedError(
  "GCP.Apigee.SecurityProfilesV2NotResolved",
)<{
  name: string;
}> {}

const DEFAULT_ASSESSMENTS: Record<string, ProfileAssessmentConfig> = {
  authorization: { weight: "MODERATE" },
  threat: { weight: "MODERATE" },
};

const resourceName = (organization: string, profileId: string) =>
  `${orgParent(organization)}/securityProfilesV2/${profileId}`;

const profileIdOf = (profile: apigee.GoogleCloudApigeeV1SecurityProfileV2) =>
  lastSegment(profile.name ?? "");

const configsOf = (
  configs:
    | apigee.GoogleCloudApigeeV1SecurityProfileV2ProfileAssessmentConfigMap
    | Record<string, ProfileAssessmentConfig>
    | undefined,
): Record<string, ProfileAssessmentConfig> => {
  const result: Record<string, ProfileAssessmentConfig> = {};
  for (const [key, value] of Object.entries(configs ?? {})) {
    if (value === undefined) continue;
    result[key] = {
      weight: value.weight,
      include: value.include?.gatewayTypes
        ? [...value.include.gatewayTypes]
        : "include" in value && Array.isArray(value.include)
          ? [...value.include]
          : undefined,
    };
  }
  return result;
};

const toApiConfigs = (
  configs: Record<string, ProfileAssessmentConfig>,
): apigee.GoogleCloudApigeeV1SecurityProfileV2ProfileAssessmentConfigMap => {
  const result: apigee.GoogleCloudApigeeV1SecurityProfileV2ProfileAssessmentConfigMap =
    {};
  for (const [key, value] of Object.entries(configs)) {
    result[key] = {
      weight: value.weight,
      include:
        value.include !== undefined
          ? { gatewayTypes: value.include }
          : undefined,
    };
  }
  return result;
};

const toAttrs = (
  profile: apigee.GoogleCloudApigeeV1SecurityProfileV2,
  organization: string,
) => {
  const securityProfileV2Id = profileIdOf(profile);
  const name = profile.name?.includes("/")
    ? profile.name
    : resourceName(organization, securityProfileV2Id);
  const parsed = parseOwnership(profile.description);
  return {
    name,
    securityProfileV2Id,
    organization: organizationFromName(name) ?? organization,
    description: parsed.text,
    riskAssessmentType: profile.riskAssessmentType,
    profileAssessmentConfigs: configsOf(profile.profileAssessmentConfigs),
    googleDefined: profile.googleDefined,
    createTime: profile.createTime,
    updateTime: profile.updateTime,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsSecurityProfilesV2({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const toBody = (
  news: SecurityProfilesV2Props,
  description: string,
): apigee.GoogleCloudApigeeV1SecurityProfileV2 => ({
  description,
  riskAssessmentType: news.riskAssessmentType,
  profileAssessmentConfigs: toApiConfigs(
    news.profileAssessmentConfigs ?? DEFAULT_ASSESSMENTS,
  ),
});

export const SecurityProfilesV2Provider = () =>
  Provider.succeed(SecurityProfilesV2, {
    stables: ["name", "securityProfileV2Id", "organization", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.securityProfileV2Id ?? output?.securityProfileV2Id;
      const previousOrg = olds?.organization ?? output?.organization;
      if (
        (previousId !== undefined &&
          news.securityProfileV2Id !== undefined &&
          news.securityProfileV2Id !== previousId) ||
        (previousOrg !== undefined &&
          news.organization !== undefined &&
          news.organization !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        organizationFromName(output?.name) ?? olds?.organization ?? env.project;
      const securityProfileV2Id = yield* toResourceId(
        id,
        olds?.securityProfileV2Id,
        output?.securityProfileV2Id,
        MAX_NAME_LENGTH,
      );
      const name =
        output?.name ?? resourceName(organization, securityProfileV2Id);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* apigee.listOrganizationsSecurityProfilesV2
          .pages({
            parent: orgParent(env.project),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.securityProfilesV2 ?? []),
            ),
            Stream.filter(
              (profile) =>
                profile.googleDefined !== true &&
                hasOwnershipMarker(profile.description),
            ),
            Stream.map((profile) => toAttrs(profile, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed([] as SecurityProfilesV2["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        news.organization ?? output?.organization ?? env.project;
      const securityProfileV2Id = yield* toResourceId(
        id,
        news.securityProfileV2Id,
        output?.securityProfileV2Id,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organization, securityProfileV2Id);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const desiredConfigs = configsOf(
        news.profileAssessmentConfigs ?? DEFAULT_ASSESSMENTS,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsSecurityProfilesV2({
            parent: orgParent(organization),
            securityProfileV2Id,
            body: toBody(news, desiredDescription),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SecurityProfilesV2NotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const configsChanged = !sameJson(
        configsOf(current.profileAssessmentConfigs),
        desiredConfigs,
      );
      const typeChanged =
        news.riskAssessmentType !== undefined &&
        (current.riskAssessmentType ?? "") !== news.riskAssessmentType;

      const updateMask = [
        descriptionChanged ? "description" : undefined,
        configsChanged ? "profileAssessmentConfigs" : undefined,
        typeChanged ? "riskAssessmentType" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* apigee.patchOrganizationsSecurityProfilesV2({
          name: current.name?.includes("/") ? current.name : name,
          updateMask: updateMask.join(","),
          body: toBody(news, desiredDescription),
        });
      }

      return toAttrs(current, organization);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsSecurityProfilesV2({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });

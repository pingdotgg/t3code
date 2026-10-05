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

export type ProfileConfigCategory = {
  /** Include mediation scoring. */
  mediation?: boolean;
  /** Include abuse scoring. */
  abuse?: boolean;
  /** Include authorization scoring. */
  authorization?: boolean;
  /** Include mTLS scoring. */
  mtls?: boolean;
  /** Include CORS scoring. */
  cors?: boolean;
  /** Include threat-protection scoring. */
  threat?: boolean;
};

export type ProfileConfig = {
  /** Scoring categories enabled on this profile. */
  categories?: ProfileConfigCategory[];
};

export type ScoringConfig = {
  /** Description of the scoring config. */
  description?: string;
  /** Path of the component config used for scoring. */
  scorePath?: string;
  /** Title of the config. */
  title?: string;
};

export type SecurityProfileProps = {
  /**
   * Apigee organization id. Defaults to the current GCP project id.
   * Immutable — changing it replaces the profile.
   */
  organization?: string;
  /**
   * Profile id (the `{profile}` segment of
   * `organizations/{org}/securityProfiles/{profile}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * 1–63 characters matching `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`.
   * Immutable — changing it replaces the profile.
   */
  securityProfileId?: string;
  /**
   * Human-readable description. Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes. Profiles have no
   * labels field.
   */
  description?: string;
  /**
   * Deprecated display name.
   */
  displayName?: string;
  /**
   * Profile configuration used to compute the security score.
   * @default `{ categories: [{ authorization: true, threat: true }] }`
   */
  profileConfig?: ProfileConfig;
  /**
   * Scoring configs in this revision.
   */
  scoringConfigs?: ScoringConfig[];
};

export type SecurityProfile = Resource<
  "GCP.Apigee.SecurityProfile",
  SecurityProfileProps,
  {
    /** Full resource name `organizations/{org}/securityProfiles/{profile}`. */
    name: string;
    /** Profile id (last path segment). */
    securityProfileId: string;
    /** Apigee organization id. */
    organization: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Deprecated display name. */
    displayName: string | undefined;
    /** Profile configuration. */
    profileConfig: ProfileConfig | undefined;
    /** Scoring configs. */
    scoringConfigs: ScoringConfig[];
    /** Attached environments. */
    environments: Array<{
      environment: string | undefined;
      attachTime: string | undefined;
    }>;
    /** Minimum score this profile can generate. */
    minScore: number | undefined;
    /** Maximum score this profile can generate. */
    maxScore: number | undefined;
    /** Revision id. */
    revisionId: string | undefined;
    /** Revision create time. */
    revisionCreateTime: string | undefined;
    /** Revision update time. */
    revisionUpdateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Advanced API Security profile (v1).
 *
 * Profiles have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Name and organization are identity —
 * changing them replaces the profile. Description and profile config
 * update in place (each update creates a new revision).
 *
 * ### Creating a Profile
 * **Example:** Generated name with authorization and threat categories
 * ```typescript
 * const profile = yield* GCP.Apigee.SecurityProfile("Baseline", {
 *   profileConfig: {
 *     categories: [{ authorization: true, threat: true }],
 *   },
 * });
 * ```
 *
 * **Example:** Named profile
 * ```typescript
 * const profile = yield* GCP.Apigee.SecurityProfile("Baseline", {
 *   securityProfileId: "app-baseline",
 *   description: "default scoring",
 *   profileConfig: {
 *     categories: [{ authorization: true, cors: true, threat: true }],
 *   },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const SecurityProfile = Resource<SecurityProfile>(
  "GCP.Apigee.SecurityProfile",
);

export class SecurityProfileNotResolved extends Data.TaggedError(
  "GCP.Apigee.SecurityProfileNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_PROFILE_CONFIG: ProfileConfig = {
  categories: [{ authorization: true, threat: true }],
};

const resourceName = (organization: string, profileId: string) =>
  `${orgParent(organization)}/securityProfiles/${profileId}`;

const profileIdOf = (profile: apigee.GoogleCloudApigeeV1SecurityProfile) =>
  lastSegment(profile.name ?? "");

const flag = (value: unknown) => value !== undefined && value !== false;

const categoryOf = (
  category:
    | apigee.GoogleCloudApigeeV1ProfileConfigCategory
    | ProfileConfigCategory,
): ProfileConfigCategory => ({
  mediation: flag(category.mediation) ? true : undefined,
  abuse: flag(category.abuse) ? true : undefined,
  authorization: flag(category.authorization) ? true : undefined,
  mtls: flag(category.mtls) ? true : undefined,
  cors: flag(category.cors) ? true : undefined,
  threat: flag(category.threat) ? true : undefined,
});

const profileConfigOf = (
  config: apigee.GoogleCloudApigeeV1ProfileConfig | ProfileConfig | undefined,
): ProfileConfig => ({
  categories: (
    config?.categories ??
    DEFAULT_PROFILE_CONFIG.categories ??
    []
  ).map(categoryOf),
});

const toApiCategory = (
  category: ProfileConfigCategory,
): apigee.GoogleCloudApigeeV1ProfileConfigCategory => ({
  mediation: category.mediation === true ? {} : undefined,
  abuse: category.abuse === true ? {} : undefined,
  authorization: category.authorization === true ? {} : undefined,
  mtls: category.mtls === true ? {} : undefined,
  cors: category.cors === true ? {} : undefined,
  threat: category.threat === true ? {} : undefined,
});

const toAttrs = (
  profile: apigee.GoogleCloudApigeeV1SecurityProfile,
  organization: string,
) => {
  const securityProfileId = profileIdOf(profile);
  const name = profile.name?.includes("/")
    ? profile.name
    : resourceName(organization, securityProfileId);
  const parsed = parseOwnership(profile.description);
  return {
    name,
    securityProfileId,
    organization: organizationFromName(name) ?? organization,
    description: parsed.text,
    displayName: profile.displayName,
    profileConfig: profile.profileConfig
      ? profileConfigOf(profile.profileConfig)
      : undefined,
    scoringConfigs: (profile.scoringConfigs ?? []).map((config) => ({
      description: config.description,
      scorePath: config.scorePath,
      title: config.title,
    })),
    environments: (profile.environments ?? []).map((environment) => ({
      environment: environment.environment,
      attachTime: environment.attachTime,
    })),
    minScore: profile.minScore,
    maxScore: profile.maxScore,
    revisionId: profile.revisionId,
    revisionCreateTime: profile.revisionCreateTime,
    revisionUpdateTime: profile.revisionUpdateTime,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsSecurityProfiles({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const toBody = (
  news: SecurityProfileProps,
  description: string,
): apigee.GoogleCloudApigeeV1SecurityProfile => {
  const config = profileConfigOf(news.profileConfig ?? DEFAULT_PROFILE_CONFIG);
  return {
    description,
    displayName: news.displayName,
    profileConfig: {
      categories: (config.categories ?? []).map(toApiCategory),
    },
    scoringConfigs: news.scoringConfigs,
  };
};

export const SecurityProfileProvider = () =>
  Provider.succeed(SecurityProfile, {
    stables: ["name", "securityProfileId", "organization"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.securityProfileId ?? output?.securityProfileId;
      const previousOrg = olds?.organization ?? output?.organization;
      if (
        (previousId !== undefined &&
          news.securityProfileId !== undefined &&
          news.securityProfileId !== previousId) ||
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
      const securityProfileId = yield* toResourceId(
        id,
        olds?.securityProfileId,
        output?.securityProfileId,
        MAX_NAME_LENGTH,
      );
      const name =
        output?.name ?? resourceName(organization, securityProfileId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization);
      const { labels } = parseOwnership(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* apigee.listOrganizationsSecurityProfiles
          .pages({
            parent: orgParent(env.project),
            pageSize: 50,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.securityProfiles ?? []),
            ),
            Stream.filter((profile) => hasOwnershipMarker(profile.description)),
            Stream.map((profile) => toAttrs(profile, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed([] as SecurityProfile["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        news.organization ?? output?.organization ?? env.project;
      const securityProfileId = yield* toResourceId(
        id,
        news.securityProfileId,
        output?.securityProfileId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organization, securityProfileId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeOwnership(ownership, news.description);
      const desiredConfig = profileConfigOf(
        news.profileConfig ?? DEFAULT_PROFILE_CONFIG,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsSecurityProfiles({
            parent: orgParent(organization),
            securityProfileId,
            body: toBody(news, desiredDescription),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SecurityProfileNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const displayChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const configChanged = !sameJson(
        profileConfigOf(current.profileConfig),
        desiredConfig,
      );
      const scoringChanged = !sameJson(
        current.scoringConfigs ?? [],
        news.scoringConfigs ?? current.scoringConfigs ?? [],
      );

      const updateMask = [
        descriptionChanged ? "description" : undefined,
        displayChanged ? "displayName" : undefined,
        configChanged ? "profileConfig" : undefined,
        scoringChanged ? "scoringConfigs" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* apigee.patchOrganizationsSecurityProfiles({
          name: current.name?.includes("/") ? current.name : name,
          updateMask: updateMask.join(","),
          body: toBody(news, desiredDescription),
        });
      }

      return toAttrs(current, organization);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsSecurityProfiles({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });

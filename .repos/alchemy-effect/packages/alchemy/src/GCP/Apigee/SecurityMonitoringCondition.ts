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

const MAX_NAME_LENGTH = 59;
const ALCHEMY_ID_PREFIX = "alc-";

export type MonitoredResource = {
  /** Resource id (API proxy id or API Hub deployment id). */
  name: string;
  /** Resource type. */
  type:
    | apigee.GoogleCloudApigeeV1BatchComputeSecurityAssessmentResultsRequestResourceArrayResourceTypeEnum
    | (string & {});
};

export type SecurityMonitoringConditionProps = {
  /**
   * Apigee organization id. Defaults to the current GCP project id.
   * Immutable — changing it replaces the condition.
   */
  organization?: string;
  /**
   * Condition id (the `{security_monitoring_condition}` segment of
   * `organizations/{org}/securityMonitoringConditions/{id}`). If
   * omitted, a unique `alc-` prefixed name is generated. 4–63
   * characters, lowercase letters and hyphens. Immutable — changing it
   * replaces the condition.
   */
  securityMonitoringConditionId?: string;
  /**
   * Security profile id or full name this condition scores against.
   * Required.
   */
  profile: string;
  /**
   * Risk assessment type.
   * @default "APIGEE"
   */
  riskAssessmentType?:
    | apigee.GoogleCloudApigeeV1SecurityMonitoringConditionRiskAssessmentTypeEnum
    | (string & {});
  /**
   * Environment scope when `riskAssessmentType` is `APIGEE`.
   */
  scope?: string;
  /**
   * API Hub gateway when `riskAssessmentType` is `API_HUB`
   * (`projects/{project}/locations/{location}/plugins/{plugin}/instances/{instance}`).
   */
  apiHubGateway?: string;
  /**
   * When true, include every resource under `scope`. Mutually exclusive
   * with `include`.
   * @default false
   */
  includeAllResources?: boolean;
  /**
   * Explicit resources to include. Mutually exclusive with
   * `includeAllResources`.
   */
  include?: MonitoredResource[];
};

export type SecurityMonitoringCondition = Resource<
  "GCP.Apigee.SecurityMonitoringCondition",
  SecurityMonitoringConditionProps,
  {
    /** Full resource name `organizations/{org}/securityMonitoringConditions/{id}`. */
    name: string;
    /** Condition id (last path segment). */
    securityMonitoringConditionId: string;
    /** Apigee organization id. */
    organization: string;
    /** Security profile id. */
    profile: string;
    /** Risk assessment type. */
    riskAssessmentType: string | undefined;
    /** Environment scope. */
    scope: string | undefined;
    /** API Hub gateway, if set. */
    apiHubGateway: string | undefined;
    /** Whether all resources under scope are included. */
    includeAllResources: boolean;
    /** Explicit included resources. */
    include: MonitoredResource[];
    /** Total deployed resources in scope. */
    totalDeployedResources: number | undefined;
    /** Total monitored resources. */
    totalMonitoredResources: number | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Advanced API Security monitoring condition (risk assessment v2).
 *
 * Conditions have no labels or description. Generated ids are prefixed
 * `alc-` so `list` / nuke can distinguish Alchemy rows from
 * Google-defined conditions. Organization and id are identity —
 * changing them replaces the condition. Profile, scope, include, and
 * include-all update in place.
 *
 * ### Creating a Condition
 * **Example:** Monitor every proxy in an environment
 * ```typescript
 * const profile = yield* GCP.Apigee.SecurityProfilesV2("Default", {});
 * const condition = yield* GCP.Apigee.SecurityMonitoringCondition("Eval", {
 *   profile: profile.name,
 *   scope: "eval",
 *   includeAllResources: true,
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const SecurityMonitoringCondition =
  Resource<SecurityMonitoringCondition>(
    "GCP.Apigee.SecurityMonitoringCondition",
  );

export class SecurityMonitoringConditionNotResolved extends Data.TaggedError(
  "GCP.Apigee.SecurityMonitoringConditionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, conditionId: string) =>
  `${orgParent(organization)}/securityMonitoringConditions/${conditionId}`;

const conditionIdOf = (
  condition: apigee.GoogleCloudApigeeV1SecurityMonitoringCondition,
) => lastSegment(condition.name ?? "");

const toConditionId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* toResourceId(
      id,
      undefined,
      undefined,
      MAX_NAME_LENGTH,
    );
    return generated.startsWith(ALCHEMY_ID_PREFIX)
      ? generated
      : `${ALCHEMY_ID_PREFIX}${generated}`.slice(0, 63);
  });

const isAlchemyId = (conditionId: string) =>
  conditionId.startsWith(ALCHEMY_ID_PREFIX);

const includeOf = (
  include:
    | apigee.GoogleCloudApigeeV1BatchComputeSecurityAssessmentResultsRequestResourceArray
    | undefined,
): MonitoredResource[] =>
  (include?.resources ?? []).flatMap((resource) =>
    resource.name !== undefined && resource.type !== undefined
      ? [{ name: resource.name, type: resource.type }]
      : [],
  );

const toAttrs = (
  condition: apigee.GoogleCloudApigeeV1SecurityMonitoringCondition,
  organization: string,
) => {
  const securityMonitoringConditionId = conditionIdOf(condition);
  const name = condition.name?.includes("/")
    ? condition.name
    : resourceName(organization, securityMonitoringConditionId);
  return {
    name,
    securityMonitoringConditionId,
    organization: organizationFromName(name) ?? organization,
    profile: condition.profile ?? "",
    riskAssessmentType: condition.riskAssessmentType,
    scope: condition.scope,
    apiHubGateway: condition.apiHubGateway,
    includeAllResources: condition.includeAllResources !== undefined,
    include: includeOf(condition.include),
    totalDeployedResources: condition.totalDeployedResources,
    totalMonitoredResources: condition.totalMonitoredResources,
    createTime: condition.createTime,
    updateTime: condition.updateTime,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsSecurityMonitoringConditions({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const toBody = (
  news: SecurityMonitoringConditionProps,
): apigee.GoogleCloudApigeeV1SecurityMonitoringCondition => ({
  profile: news.profile,
  riskAssessmentType: news.riskAssessmentType,
  scope: news.scope,
  apiHubGateway: news.apiHubGateway,
  includeAllResources: news.includeAllResources === true ? {} : undefined,
  include:
    news.includeAllResources === true
      ? undefined
      : news.include !== undefined
        ? { resources: news.include }
        : undefined,
});

export const SecurityMonitoringConditionProvider = () =>
  Provider.succeed(SecurityMonitoringCondition, {
    stables: [
      "name",
      "securityMonitoringConditionId",
      "organization",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.securityMonitoringConditionId ??
        output?.securityMonitoringConditionId;
      const previousOrg = olds?.organization ?? output?.organization;
      if (
        (previousId !== undefined &&
          news.securityMonitoringConditionId !== undefined &&
          news.securityMonitoringConditionId !== previousId) ||
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
      const securityMonitoringConditionId = yield* toConditionId(
        id,
        olds?.securityMonitoringConditionId,
        output?.securityMonitoringConditionId,
      );
      const name =
        output?.name ??
        resourceName(organization, securityMonitoringConditionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization);
      return isAlchemyId(attrs.securityMonitoringConditionId) ||
        (olds?.securityMonitoringConditionId !== undefined &&
          olds.securityMonitoringConditionId ===
            attrs.securityMonitoringConditionId)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* apigee.listOrganizationsSecurityMonitoringConditions
          .pages({
            parent: orgParent(env.project),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.securityMonitoringConditions ?? []),
            ),
            Stream.filter((condition) => isAlchemyId(conditionIdOf(condition))),
            Stream.map((condition) => toAttrs(condition, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed([] as SecurityMonitoringCondition["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        news.organization ?? output?.organization ?? env.project;
      const securityMonitoringConditionId = yield* toConditionId(
        id,
        news.securityMonitoringConditionId,
        output?.securityMonitoringConditionId,
      );
      const name = resourceName(organization, securityMonitoringConditionId);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsSecurityMonitoringConditions({
            parent: orgParent(organization),
            securityMonitoringConditionId,
            body: toBody(news),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SecurityMonitoringConditionNotResolved({ name });
      }

      const desiredIncludeAll = news.includeAllResources === true;
      const observedIncludeAll = current.includeAllResources !== undefined;
      const profileChanged = (current.profile ?? "") !== news.profile;
      const scopeChanged = (current.scope ?? "") !== (news.scope ?? "");
      const gatewayChanged =
        (current.apiHubGateway ?? "") !== (news.apiHubGateway ?? "");
      const includeAllChanged = desiredIncludeAll !== observedIncludeAll;
      const includeChanged = !sameJson(
        includeOf(current.include),
        news.include ?? [],
      );
      const typeChanged =
        (current.riskAssessmentType ?? "") !==
        (news.riskAssessmentType ?? current.riskAssessmentType ?? "");

      const updateMask = [
        profileChanged ? "profile" : undefined,
        scopeChanged ? "scope" : undefined,
        gatewayChanged ? "apiHubGateway" : undefined,
        includeAllChanged ? "include_all_resources" : undefined,
        includeChanged ? "include" : undefined,
        typeChanged ? "riskAssessmentType" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* apigee.patchOrganizationsSecurityMonitoringConditions({
          name: current.name?.includes("/") ? current.name : name,
          updateMask: updateMask.join(","),
          body: toBody(news),
        });
      }

      return toAttrs(current, organization);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsSecurityMonitoringConditions({
          name: output.name,
        })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });

import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  listOrganizations,
  normalizeLocation,
  organizationParent,
  parseResourceName,
  ResourceNotResolved,
  resolveOrganization,
  sameJson,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./operations.ts";

const DEFAULT_TYPE =
  "THREAT_PREVENTION" satisfies networksecurity.SecurityProfileTypeEnum;

export type OrganizationsSecurityProfileType =
  | networksecurity.SecurityProfileTypeEnum
  | (string & {});

export type OrganizationsAntivirusOverride = {
  /** Protocol to match (`HTTP`, `SMTP`, …). */
  protocol?: string;
  /** Threat action (`ALLOW`, `ALERT`, `DENY`, `DEFAULT_ACTION`). */
  action?: string;
};

export type OrganizationsSeverityOverride = {
  /** Severity (`INFORMATIONAL`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`). */
  severity?: string;
  /** Threat action (`ALLOW`, `ALERT`, `DENY`, `DEFAULT_ACTION`). */
  action?: string;
};

export type OrganizationsThreatOverride = {
  /** Vendor-specific threat id. */
  threatId?: string;
  /** Threat type (output-only on the wire). */
  type?: string;
  /** Threat action (`ALLOW`, `ALERT`, `DENY`, `DEFAULT_ACTION`). */
  action?: string;
};

export type OrganizationsThreatPreventionProfile = {
  /** Antivirus action overrides per protocol. */
  antivirusOverrides?: OrganizationsAntivirusOverride[];
  /** Action overrides by severity. */
  severityOverrides?: OrganizationsSeverityOverride[];
  /** Action overrides by threat id. */
  threatOverrides?: OrganizationsThreatOverride[];
};

export type OrganizationsCustomMirroringProfile = {
  /** Target MirroringEndpointGroup resource name. Immutable. */
  mirroringEndpointGroup?: string;
};

export type OrganizationsUrlFilter = {
  /** Action (`ALLOW` or `DENY`). */
  filteringAction?: string;
  /** URL match strings. */
  urls?: string[];
  /** Unique priority within the profile. Lower is higher priority. */
  priority?: number;
};

export type OrganizationsUrlFilteringProfile = {
  /** URL filters. */
  urlFilters?: OrganizationsUrlFilter[];
};

export type OrganizationsCustomInterceptProfile = {
  /** Target InterceptEndpointGroup resource name. Immutable. */
  interceptEndpointGroup?: string;
};

export type OrganizationsSecurityProfileProps = {
  /**
   * Security profile id. If omitted, a unique RFC1035 name is generated
   * from the stack, stage, and logical id. Immutable — changing it
   * replaces the profile.
   */
  securityProfileId?: string;
  /**
   * Organization id or `organizations/{organization}`. If omitted,
   * Alchemy uses `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager parent. Immutable — changing it replaces the profile.
   */
  organization?: string;
  /**
   * Location. Security profiles live in `global`. Immutable — changing
   * it replaces the profile.
   * @default "global"
   */
  location?: string;
  /**
   * Profile type. Immutable — changing it replaces the profile.
   * @default "THREAT_PREVENTION"
   */
  type?: OrganizationsSecurityProfileType;
  /**
   * Threat prevention configuration. Used when `type` is
   * `THREAT_PREVENTION`.
   */
  threatPreventionProfile?: OrganizationsThreatPreventionProfile;
  /**
   * Packet mirroring configuration. Used when `type` is
   * `CUSTOM_MIRRORING`. Immutable.
   */
  customMirroringProfile?: OrganizationsCustomMirroringProfile;
  /**
   * URL filtering configuration. Used when `type` is `URL_FILTERING`.
   */
  urlFilteringProfile?: OrganizationsUrlFilteringProfile;
  /**
   * Packet intercept configuration. Used when `type` is
   * `CUSTOM_INTERCEPT`. Immutable.
   */
  customInterceptProfile?: OrganizationsCustomInterceptProfile;
  /**
   * Human-readable description (max 512 characters).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type OrganizationsSecurityProfile = Resource<
  "GCP.NetworkSecurity.OrganizationsSecurityProfile",
  OrganizationsSecurityProfileProps,
  {
    /** Full resource name `organizations/{organization}/locations/{location}/securityProfiles/{securityProfile}`. */
    name: string;
    /** Security profile id (last path segment). */
    securityProfileId: string;
    /** Organization id. */
    organization: string;
    /** Location id. */
    location: string;
    /** Profile type. */
    type: string;
    /** Threat prevention configuration, if set. */
    threatPreventionProfile: OrganizationsThreatPreventionProfile | undefined;
    /** Packet mirroring configuration, if set. */
    customMirroringProfile: OrganizationsCustomMirroringProfile | undefined;
    /** URL filtering configuration, if set. */
    urlFilteringProfile: OrganizationsUrlFilteringProfile | undefined;
    /** Packet intercept configuration, if set. */
    customInterceptProfile: OrganizationsCustomInterceptProfile | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-computed checksum. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An organization-scoped Network Security profile (threat prevention,
 * URL filtering, custom mirroring, or custom intercept).
 *
 * Changing `securityProfileId`, `organization`, `location`, `type`, or
 * the immutable nested mirroring/intercept targets replaces the profile.
 * Description, labels, and threat-prevention or URL-filter config update
 * in place.
 *
 * ### Creating a Security Profile
 * **Example:** Threat prevention
 * ```typescript
 * const profile = yield* GCP.NetworkSecurity.OrganizationsSecurityProfile(
 *   "Threats",
 *   {
 *     type: "THREAT_PREVENTION",
 *     threatPreventionProfile: {
 *       severityOverrides: [{ severity: "INFORMATIONAL", action: "ALERT" }],
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const OrganizationsSecurityProfile =
  Resource<OrganizationsSecurityProfile>(
    "GCP.NetworkSecurity.OrganizationsSecurityProfile",
  );

const resourceName = (
  organization: string,
  location: string,
  securityProfileId: string,
) =>
  `organizations/${organization}/locations/${location}/securityProfiles/${securityProfileId}`;

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_TYPE).toUpperCase();

const toThreatPrevention = (
  profile: networksecurity.ThreatPreventionProfile | undefined,
): OrganizationsThreatPreventionProfile | undefined => {
  if (profile === undefined) return undefined;
  return {
    antivirusOverrides: profile.antivirusOverrides,
    severityOverrides: profile.severityOverrides,
    threatOverrides: profile.threatOverrides,
  };
};

const toAttrs = (profile: networksecurity.SecurityProfile) => {
  const name = profile.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    securityProfileId: parsed.id,
    organization: parsed.parentId,
    location: parsed.location,
    type: profile.type ?? DEFAULT_TYPE,
    threatPreventionProfile: toThreatPrevention(
      profile.threatPreventionProfile,
    ),
    customMirroringProfile: profile.customMirroringProfile,
    urlFilteringProfile: profile.urlFilteringProfile,
    customInterceptProfile: profile.customInterceptProfile,
    description: profile.description,
    labels: userLabels(profile.labels),
    etag: profile.etag,
    createTime: profile.createTime,
    updateTime: profile.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getOrganizationsLocationsSecurityProfiles({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (organization: string) =>
  networksecurity.listOrganizationsLocationsSecurityProfiles
    .pages({
      parent: organizationParent(organization, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.securityProfiles ?? []),
      ),
      Stream.filter((profile) =>
        Object.keys(profile.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map(toAttrs),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const desiredThreatPrevention = (
  news: OrganizationsSecurityProfileProps,
  type: string,
): OrganizationsThreatPreventionProfile | undefined => {
  if (type !== "THREAT_PREVENTION") return undefined;
  return news.threatPreventionProfile ?? {};
};

export const OrganizationsSecurityProfileProvider = () =>
  Provider.succeed(OrganizationsSecurityProfile, {
    stables: [
      "name",
      "securityProfileId",
      "organization",
      "location",
      "type",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.securityProfileId ?? output?.securityProfileId;
      const nextId = news.securityProfileId ?? previousId;
      const previousOrg = olds?.organization ?? output?.organization;
      const nextOrg = news.organization ?? previousOrg;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousType = typeOf(olds?.type ?? output?.type);
      const nextType = typeOf(news.type ?? olds?.type ?? output?.type);
      const previousMirror =
        olds?.customMirroringProfile?.mirroringEndpointGroup ??
        output?.customMirroringProfile?.mirroringEndpointGroup;
      const nextMirror =
        news.customMirroringProfile?.mirroringEndpointGroup ?? previousMirror;
      const previousIntercept =
        olds?.customInterceptProfile?.interceptEndpointGroup ??
        output?.customInterceptProfile?.interceptEndpointGroup;
      const nextIntercept =
        news.customInterceptProfile?.interceptEndpointGroup ??
        previousIntercept;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousOrg !== undefined &&
          nextOrg !== undefined &&
          nextOrg !== previousOrg) ||
        previousLocation !== nextLocation ||
        previousType !== nextType ||
        previousMirror !== nextMirror ||
        previousIntercept !== nextIntercept;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousOrg === nextOrg &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const securityProfileId = yield* toPhysicalId(
        id,
        olds?.securityProfileId,
        output?.securityProfileId,
        "secprofile",
      );
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      ).pipe(
        Effect.catchTag("GCP.NetworkSecurity.OrganizationRequired", () =>
          Effect.succeed(output?.organization ?? ""),
        ),
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        (organization.length > 0
          ? resourceName(organization, location, securityProfileId)
          : "");
      if (name.length === 0) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const orgs = yield* listOrganizations(env.project);
        const listed: OrganizationsSecurityProfile["Attributes"][] = [];
        for (const organization of orgs) {
          listed.push(...(yield* listOwned(organization)));
        }
        return listed;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const securityProfileId = yield* toPhysicalId(
        id,
        news.securityProfileId,
        output?.securityProfileId,
        "secprofile",
      );
      const organization = yield* resolveOrganization(
        news.organization ?? output?.organization,
        output?.organization,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(organization, location, securityProfileId);
      const type = typeOf(news.type);
      const threatPreventionProfile = desiredThreatPrevention(news, type);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createOrganizationsLocationsSecurityProfiles({
            parent: organizationParent(organization, location),
            securityProfileId,
            body: {
              type,
              description: news.description,
              labels: desiredLabels,
              threatPreventionProfile,
              customMirroringProfile: news.customMirroringProfile,
              urlFilteringProfile: news.urlFilteringProfile,
              customInterceptProfile: news.customInterceptProfile,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const threatChanged =
        type === "THREAT_PREVENTION" &&
        !sameJson(
          toThreatPrevention(current.threatPreventionProfile) ?? {},
          threatPreventionProfile ?? {},
        );
      const urlChanged =
        type === "URL_FILTERING" &&
        !sameJson(current.urlFilteringProfile, news.urlFilteringProfile);

      if (labelsChanged || descriptionChanged || threatChanged || urlChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          threatChanged ? "threatPreventionProfile" : undefined,
          urlChanged ? "urlFilteringProfile" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* networksecurity.patchOrganizationsLocationsSecurityProfiles({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              threatPreventionProfile,
              urlFilteringProfile: news.urlFilteringProfile,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteOrganizationsLocationsSecurityProfiles({
          name: output.name,
          etag: output.etag,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });

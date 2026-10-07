import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Data from "effect/Data";
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
  DEFAULT_LOCATION,
  normalizeLocation,
  parentOf,
  parseResourceName,
  resourceName,
  toId,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";
import { sameJson } from "./ownership.ts";

const COLLECTION = "securityProfiles";
const DEFAULT_TYPE = "THREAT_PREVENTION";

export type SecurityProfileType =
  | "THREAT_PREVENTION"
  | "CUSTOM_MIRRORING"
  | "CUSTOM_INTERCEPT"
  | "URL_FILTERING"
  | (string & {});

export type AntivirusOverride = {
  /** Protocol to match (`HTTP`, `SMTP`, `FTP`, …). */
  protocol?: networksecurity.AntivirusOverrideProtocolEnum | (string & {});
  /** Threat action override (`ALLOW`, `ALERT`, `DENY`, …). */
  action?: networksecurity.AntivirusOverrideActionEnum | (string & {});
};

export type SeverityOverride = {
  /** Severity level to match (`INFORMATIONAL`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`). */
  severity?: networksecurity.SeverityOverrideSeverityEnum | (string & {});
  /** Threat action override (`ALLOW`, `ALERT`, `DENY`, …). */
  action?: networksecurity.SeverityOverrideActionEnum | (string & {});
};

export type ThreatOverride = {
  /** Vendor-specific threat id to override. */
  threatId?: string;
  /** Threat action override (`ALLOW`, `ALERT`, `DENY`, …). */
  action?: networksecurity.ThreatOverrideActionEnum | (string & {});
};

export type ThreatPreventionProfile = {
  /** Antivirus action overrides per protocol. */
  antivirusOverrides?: AntivirusOverride[];
  /** Action overrides by severity. */
  severityOverrides?: SeverityOverride[];
  /** Action overrides by threat id. Wins over a matching severity override. */
  threatOverrides?: ThreatOverride[];
};

export type CustomMirroringProfile = {
  /**
   * Target MirroringEndpointGroup. Immutable — changing it replaces the
   * profile.
   */
  mirroringEndpointGroup?: string;
};

export type CustomInterceptProfile = {
  /**
   * Target InterceptEndpointGroup. Immutable — changing it replaces the
   * profile.
   */
  interceptEndpointGroup?: string;
};

export type UrlFilter = {
  /** Action taken when this filter matches (`ALLOW` or `DENY`). */
  filteringAction?:
    | networksecurity.UrlFilterFilteringActionEnum
    | (string & {});
  /** URL strings that must match for this filter to apply. */
  urls?: string[];
  /**
   * Priority within the profile. Lower integers are higher priority.
   * Must be unique within a URL Filtering Profile.
   */
  priority?: number;
};

export type UrlFilteringProfile = {
  /** Filtering configs, each defining an action for some URL match. */
  urlFilters?: UrlFilter[];
};

export type SecurityProfileProps = {
  /**
   * SecurityProfile id (the `{securityProfile}` segment of
   * `projects/{project}/locations/{location}/securityProfiles/{securityProfile}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, letters, numbers, hyphens, and
   * underscores, and must not start with a number. Immutable — changing
   * it replaces the profile.
   */
  securityProfileId?: string;
  /**
   * Location. Security profiles live in `global`. Immutable — changing
   * it replaces the profile.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description (max 512 characters).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Single ProfileType this resource configures. Inferred from nested
   * profile blocks when omitted. Immutable — changing it replaces the
   * profile.
   * @default "THREAT_PREVENTION"
   */
  type?: SecurityProfileType;
  /**
   * Threat-prevention configuration. Used when `type` is
   * `THREAT_PREVENTION`.
   */
  threatPreventionProfile?: ThreatPreventionProfile;
  /**
   * Out-of-band packet mirroring configuration. Used when `type` is
   * `CUSTOM_MIRRORING`. Immutable nested target — changing
   * `mirroringEndpointGroup` replaces the profile.
   */
  customMirroringProfile?: CustomMirroringProfile;
  /**
   * In-band intercept configuration. Used when `type` is
   * `CUSTOM_INTERCEPT`. Immutable nested target — changing
   * `interceptEndpointGroup` replaces the profile.
   */
  customInterceptProfile?: CustomInterceptProfile;
  /**
   * URL filtering configuration. Used when `type` is `URL_FILTERING`.
   */
  urlFilteringProfile?: UrlFilteringProfile;
};

export type SecurityProfile = Resource<
  "GCP.NetworkSecurity.SecurityProfile",
  SecurityProfileProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/securityProfiles/{securityProfile}`. */
    name: string;
    /** SecurityProfile id (last path segment). */
    securityProfileId: string;
    /** Project id. */
    project: string;
    /** Location id. Typically `"global"`. */
    location: string;
    /** Configured profile type. */
    type: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Threat-prevention configuration, if this is a THREAT_PREVENTION profile. */
    threatPreventionProfile: ThreatPreventionProfile | undefined;
    /** Custom mirroring configuration, if this is a CUSTOM_MIRRORING profile. */
    customMirroringProfile: CustomMirroringProfile | undefined;
    /** Custom intercept configuration, if this is a CUSTOM_INTERCEPT profile. */
    customInterceptProfile: CustomInterceptProfile | undefined;
    /** URL filtering configuration, if this is a URL_FILTERING profile. */
    urlFilteringProfile: UrlFilteringProfile | undefined;
    /** Server-computed checksum used on update and delete. */
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
 * A Network Security SecurityProfile — the behavior for one ProfileType
 * (threat prevention, URL filtering, custom mirroring, or custom
 * intercept).
 *
 * Changing `securityProfileId`, `location`, `type`, or an immutable
 * nested target (`mirroringEndpointGroup` / `interceptEndpointGroup`)
 * replaces the profile. Description, labels, and the mutable nested
 * profile configuration update in place.
 *
 * ### Creating a SecurityProfile
 * **Example:** Threat prevention with a severity override
 * ```typescript
 * const profile = yield* GCP.NetworkSecurity.SecurityProfile("Threat", {
 *   type: "THREAT_PREVENTION",
 *   threatPreventionProfile: {
 *     severityOverrides: [{ severity: "HIGH", action: "ALERT" }],
 *   },
 * });
 * ```
 *
 * **Example:** Named profile with labels
 * ```typescript
 * const profile = yield* GCP.NetworkSecurity.SecurityProfile("Threat", {
 *   securityProfileId: "app-threat",
 *   description: "prod threat prevention",
 *   labels: { env: "prod" },
 *   type: "THREAT_PREVENTION",
 * });
 * ```
 *
 * ### Updating a SecurityProfile
 * **Example:** Change severity overrides
 * ```typescript
 * const profile = yield* GCP.NetworkSecurity.SecurityProfile("Threat", {
 *   securityProfileId: "app-threat",
 *   type: "THREAT_PREVENTION",
 *   description: "prod threat prevention v2",
 *   labels: { env: "prod", role: "ngfw" },
 *   threatPreventionProfile: {
 *     severityOverrides: [{ severity: "CRITICAL", action: "DENY" }],
 *   },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const SecurityProfile = Resource<SecurityProfile>(
  "GCP.NetworkSecurity.SecurityProfile",
);

export class SecurityProfileNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.SecurityProfileNotResolved",
)<{
  name: string;
}> {}

export class SecurityProfileStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.SecurityProfileStillExists",
)<{
  name: string;
}> {}

const typeOf = (
  props: {
    type?: string;
    threatPreventionProfile?: ThreatPreventionProfile;
    customMirroringProfile?: CustomMirroringProfile;
    customInterceptProfile?: CustomInterceptProfile;
    urlFilteringProfile?: UrlFilteringProfile;
  },
  fallback: string = DEFAULT_TYPE,
): string => {
  if (props.type !== undefined && props.type !== "PROFILE_TYPE_UNSPECIFIED") {
    return props.type;
  }
  if ((props.customMirroringProfile?.mirroringEndpointGroup ?? "") !== "") {
    return "CUSTOM_MIRRORING";
  }
  if ((props.customInterceptProfile?.interceptEndpointGroup ?? "") !== "") {
    return "CUSTOM_INTERCEPT";
  }
  if ((props.urlFilteringProfile?.urlFilters?.length ?? 0) > 0) {
    return "URL_FILTERING";
  }
  if (props.threatPreventionProfile !== undefined) {
    return "THREAT_PREVENTION";
  }
  return fallback;
};

const toThreatPrevention = (
  value:
    | networksecurity.ThreatPreventionProfile
    | ThreatPreventionProfile
    | undefined,
): ThreatPreventionProfile | undefined => {
  if (value === undefined) return undefined;
  return {
    antivirusOverrides: (value.antivirusOverrides ?? []).map((entry) => ({
      protocol: entry.protocol,
      action: entry.action,
    })),
    severityOverrides: (value.severityOverrides ?? []).map((entry) => ({
      severity: entry.severity,
      action: entry.action,
    })),
    threatOverrides: (value.threatOverrides ?? []).map((entry) => ({
      threatId: entry.threatId,
      action: entry.action,
    })),
  };
};

const toUrlFiltering = (
  value: networksecurity.UrlFilteringProfile | UrlFilteringProfile | undefined,
): UrlFilteringProfile | undefined => {
  if (value === undefined) return undefined;
  return {
    urlFilters: (value.urlFilters ?? []).map((entry) => ({
      filteringAction: entry.filteringAction,
      urls: entry.urls,
      priority: entry.priority,
    })),
  };
};

const toAttrs = (profile: networksecurity.SecurityProfile, project: string) => {
  const name = profile.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    securityProfileId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    type: profile.type,
    description: profile.description,
    labels: userLabels(profile.labels),
    threatPreventionProfile: toThreatPrevention(
      profile.threatPreventionProfile,
    ),
    customMirroringProfile: profile.customMirroringProfile
      ? {
          mirroringEndpointGroup:
            profile.customMirroringProfile.mirroringEndpointGroup,
        }
      : undefined,
    customInterceptProfile: profile.customInterceptProfile
      ? {
          interceptEndpointGroup:
            profile.customInterceptProfile.interceptEndpointGroup,
        }
      : undefined,
    urlFilteringProfile: toUrlFiltering(profile.urlFilteringProfile),
    etag: profile.etag,
    createTime: profile.createTime,
    updateTime: profile.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsSecurityProfiles({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((profile) =>
      profile
        ? Effect.succeed(profile)
        : Effect.fail(new SecurityProfileNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.SecurityProfileNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((profile) =>
      profile === undefined
        ? Effect.void
        : Effect.fail(new SecurityProfileStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.SecurityProfileStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsSecurityProfiles
    .pages({
      parent: parentOf(project, "-"),
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
      Stream.map((profile) => toAttrs(profile, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toCreateBody = (
  news: SecurityProfileProps,
  type: string,
  desiredLabels: Record<string, string>,
): networksecurity.SecurityProfile => {
  const body: networksecurity.SecurityProfile = {
    description: news.description,
    labels: desiredLabels,
    type,
  };
  if (type === "THREAT_PREVENTION") {
    body.threatPreventionProfile =
      toThreatPrevention(news.threatPreventionProfile) ?? {};
  } else if (type === "CUSTOM_MIRRORING") {
    body.customMirroringProfile = {
      mirroringEndpointGroup:
        news.customMirroringProfile?.mirroringEndpointGroup,
    };
  } else if (type === "CUSTOM_INTERCEPT") {
    body.customInterceptProfile = {
      interceptEndpointGroup:
        news.customInterceptProfile?.interceptEndpointGroup,
    };
  } else if (type === "URL_FILTERING") {
    body.urlFilteringProfile = toUrlFiltering(news.urlFilteringProfile) ?? {};
  }
  return body;
};

const immutableChanged = (
  news: SecurityProfileProps,
  olds: Partial<SecurityProfileProps> | undefined,
  output: SecurityProfile["Attributes"] | undefined,
) => {
  const previousType = typeOf(
    {
      type: olds?.type ?? output?.type,
      threatPreventionProfile:
        olds?.threatPreventionProfile ?? output?.threatPreventionProfile,
      customMirroringProfile:
        olds?.customMirroringProfile ?? output?.customMirroringProfile,
      customInterceptProfile:
        olds?.customInterceptProfile ?? output?.customInterceptProfile,
      urlFilteringProfile:
        olds?.urlFilteringProfile ?? output?.urlFilteringProfile,
    },
    output?.type ?? DEFAULT_TYPE,
  );
  const nextType = typeOf(news, previousType);
  if (nextType !== previousType) return true;
  if (nextType === "CUSTOM_MIRRORING") {
    const previous =
      olds?.customMirroringProfile?.mirroringEndpointGroup ??
      output?.customMirroringProfile?.mirroringEndpointGroup ??
      "";
    const next =
      news.customMirroringProfile?.mirroringEndpointGroup ?? previous;
    if (next !== previous) return true;
  }
  if (nextType === "CUSTOM_INTERCEPT") {
    const previous =
      olds?.customInterceptProfile?.interceptEndpointGroup ??
      output?.customInterceptProfile?.interceptEndpointGroup ??
      "";
    const next =
      news.customInterceptProfile?.interceptEndpointGroup ?? previous;
    if (next !== previous) return true;
  }
  return false;
};

export const SecurityProfileProvider = () =>
  Provider.succeed(SecurityProfile, {
    stables: [
      "name",
      "securityProfileId",
      "project",
      "location",
      "type",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.securityProfileId ?? output?.securityProfileId;
      const nextId = news.securityProfileId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        immutableChanged(news, olds, output)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const securityProfileId = yield* toId(
        id,
        olds?.securityProfileId,
        output?.securityProfileId,
        "secprofile",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, securityProfileId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const securityProfileId = yield* toId(
        id,
        news.securityProfileId,
        output?.securityProfileId,
        "secprofile",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const type = typeOf(news, output?.type ?? DEFAULT_TYPE);
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        securityProfileId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsSecurityProfiles({
            parent: parentOf(env.project, location),
            securityProfileId,
            body: toCreateBody(news, type, desiredLabels),
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
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new SecurityProfileNotResolved({ name });
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
          toThreatPrevention(news.threatPreventionProfile) ?? {},
        );
      const urlChanged =
        type === "URL_FILTERING" &&
        !sameJson(
          toUrlFiltering(current.urlFilteringProfile) ?? {},
          toUrlFiltering(news.urlFilteringProfile) ?? {},
        );

      if (labelsChanged || descriptionChanged || threatChanged || urlChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          threatChanged ? "threatPreventionProfile" : undefined,
          urlChanged ? "urlFilteringProfile" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation =
          yield* networksecurity.patchProjectsLocationsSecurityProfiles({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
              threatPreventionProfile:
                type === "THREAT_PREVENTION"
                  ? (toThreatPrevention(news.threatPreventionProfile) ?? {})
                  : undefined,
              urlFilteringProfile:
                type === "URL_FILTERING"
                  ? (toUrlFiltering(news.urlFilteringProfile) ?? {})
                  : undefined,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsSecurityProfiles({
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
      yield* waitUntilGone(output.name);
    }),
  });

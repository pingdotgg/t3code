import * as monitoring from "@distilled.cloud/gcp/monitoring_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_DISPLAY_NAME_LENGTH = 512;
const DEFAULT_TIMEOUT = "10s";
const DEFAULT_PERIOD = "600s";
const DEFAULT_HOST = "example.com";
const DEFAULT_PATH = "/";
const DEFAULT_SSL_PORT = 443;
const DEFAULT_HTTP_PORT = 80;
const DEFAULT_RESOURCE_TYPE = "uptime_url";

export type BasicAuthentication = {
  /** Username for HTTP basic auth. */
  username?: string;
  /** Password for HTTP basic auth. */
  password?: string;
};

export type PingConfig = {
  /** Number of ICMP pings to send with the check (max 3). */
  pingsCount?: number;
};

export type ResponseStatusCode = {
  /** Exact HTTP status code to accept. */
  statusValue?: number;
  /** HTTP status class to accept (`STATUS_CLASS_2XX`, …). */
  statusClass?: string;
};

export type HttpCheck = {
  /**
   * Request path. Combined with the monitored-resource host.
   * @default "/"
   */
  path?: string;
  /**
   * TCP port. Defaults to 443 when `useSsl` is true, otherwise 80.
   */
  port?: number;
  /**
   * When true, probe over HTTPS.
   * @default true
   */
  useSsl?: boolean;
  /**
   * When true, validate the SSL certificate. Only applies when `useSsl`
   * is true.
   * @default true
   */
  validateSsl?: boolean;
  /** HTTP method. Defaults to GET. */
  requestMethod?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** When true, encrypt stored header values. */
  maskHeaders?: boolean;
  /** HTTP basic authentication. */
  authInfo?: BasicAuthentication;
  /** Attach an OIDC token from the Monitoring service agent. */
  serviceAgentAuthentication?: { type?: string };
  /** Content-Type for POST checks. */
  contentType?: string;
  /** Custom Content-Type when `contentType` is `USER_PROVIDED`. */
  customContentType?: string;
  /** POST body. Ignored for GET. */
  body?: string;
  /** ICMP pings sent alongside the HTTP probe. */
  pingConfig?: PingConfig;
  /** Accepted HTTP status codes. Empty means 2xx. */
  acceptedResponseStatusCodes?: ResponseStatusCode[];
};

export type TcpCheck = {
  /** TCP port to probe. Required for TCP checks. */
  port?: number;
  /** ICMP pings sent alongside the TCP probe. */
  pingConfig?: PingConfig;
};

export type JsonPathMatcher = {
  /** JSONPath into the response body. */
  jsonPath?: string;
  /** Match type (`EXACT_MATCH` or `REGEX_MATCH`). */
  jsonMatcher?: string;
};

export type ContentMatcher = {
  /** String, regex, or JSON value to match. */
  content?: string;
  /** Matcher (`CONTAINS_STRING`, `MATCHES_REGEX`, …). */
  matcher?: string;
  /** JSONPath matcher, used with `MATCHES_JSON_PATH`. */
  jsonPathMatcher?: JsonPathMatcher;
};

export type MonitoredResource = {
  /**
   * Monitored resource type (`uptime_url`, `gce_instance`, `gae_app`,
   * `k8s_service`, `cloud_run_revision`, …).
   */
  type?: string;
  /**
   * Resource labels. For `uptime_url`, set `host` (and optionally
   * `project_id`).
   */
  labels?: Record<string, string>;
};

export type ResourceGroup = {
  /** Group id (not the full resource name). */
  groupId?: string;
  /** Member resource type (`INSTANCE` or `AWS_ELB_LOAD_BALANCER`). */
  resourceType?: string;
};

export type SyntheticMonitorTarget = {
  /** Cloud Functions v2 target. */
  cloudFunctionV2?: { name?: string };
};

export type UptimeCheckConfigProps = {
  /**
   * Human-readable display name. If omitted, a unique name is generated
   * from the stack, stage, and logical id.
   */
  displayName?: string;
  /**
   * Probe timeout. Must be between 1s and 60s.
   * @default "10s"
   */
  timeout?: string;
  /**
   * How often the check runs. Supported values: `60s`, `300s`, `600s`,
   * `900s`.
   * @default "600s"
   */
  period?: string;
  /**
   * HTTP/HTTPS probe. Defaults to HTTPS against `example.com` when no
   * other target is set.
   */
  httpCheck?: HttpCheck;
  /**
   * TCP probe. Mutually exclusive with `httpCheck` and
   * `syntheticMonitor`.
   */
  tcpCheck?: TcpCheck;
  /**
   * Synthetic monitor (Cloud Functions v2) target.
   */
  syntheticMonitor?: SyntheticMonitorTarget;
  /**
   * Monitored resource. Defaults to `uptime_url` with host
   * `example.com` for HTTP/TCP checks.
   */
  monitoredResource?: MonitoredResource;
  /**
   * Resource group instead of a single monitored resource.
   */
  resourceGroup?: ResourceGroup;
  /**
   * Content matchers. Only the first entry is used by the API.
   */
  contentMatchers?: ContentMatcher[];
  /**
   * Regions to probe from. Omitted runs from every available region.
   * When set, enough regions must be listed to cover at least 3
   * locations.
   */
  selectedRegions?: string[];
  /**
   * Checker type (`STATIC_IP_CHECKERS` or `VPC_CHECKERS`).
   */
  checkerType?: string;
  /**
   * When true, the check exists but does not run.
   * @default false
   */
  disabled?: boolean;
  /**
   * When true, failed probes are written to Cloud Logging.
   * @default false
   */
  logCheckFailures?: boolean;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type UptimeCheckConfig = Resource<
  "GCP.Monitoring.UptimeCheckConfig",
  UptimeCheckConfigProps,
  {
    /** Full resource name `projects/{project}/uptimeCheckConfigs/{config}`. */
    name: string;
    /** Server-assigned config id (last path segment). */
    uptimeCheckConfigId: string;
    /** Project id. */
    project: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** Probe timeout. */
    timeout: string | undefined;
    /** Check period. */
    period: string | undefined;
    /** HTTP/HTTPS probe, if set. */
    httpCheck: HttpCheck | undefined;
    /** TCP probe, if set. */
    tcpCheck: TcpCheck | undefined;
    /** Synthetic monitor target, if set. */
    syntheticMonitor: SyntheticMonitorTarget | undefined;
    /** Monitored resource, if set. */
    monitoredResource: MonitoredResource | undefined;
    /** Resource group, if set. */
    resourceGroup: ResourceGroup | undefined;
    /** Content matchers. */
    contentMatchers: ContentMatcher[];
    /** Regions the check runs from. */
    selectedRegions: ReadonlyArray<string>;
    /** Checker type. */
    checkerType: string | undefined;
    /** Whether the check is disabled. */
    disabled: boolean;
    /** Whether failed probes are logged. */
    logCheckFailures: boolean;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Cloud Monitoring uptime check — an HTTP, HTTPS, TCP, or synthetic
 * probe that measures availability.
 *
 * Config ids are assigned by the API. Alchemy stamps ownership into
 * `userLabels` so `list` / `pnpm nuke:gcp` can find them. Display name,
 * period, timeout, HTTP/TCP settings, matchers, regions, and labels
 * update in place.
 *
 * ### Creating a Check
 * **Example:** HTTPS probe of example.com
 * ```typescript
 * const check = yield* GCP.Monitoring.UptimeCheckConfig("Homepage", {
 *   httpCheck: { path: "/", useSsl: true, validateSsl: true },
 *   monitoredResource: {
 *     type: "uptime_url",
 *     labels: { host: "example.com" },
 *   },
 * });
 * ```
 *
 * **Example:** Generated name with labels
 * ```typescript
 * const check = yield* GCP.Monitoring.UptimeCheckConfig("Homepage", {
 *   timeout: "10s",
 *   period: "600s",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Check
 * **Example:** Change path and period
 * ```typescript
 * const check = yield* GCP.Monitoring.UptimeCheckConfig("Homepage", {
 *   period: "300s",
 *   httpCheck: { path: "/health", useSsl: true, validateSsl: true },
 *   monitoredResource: {
 *     type: "uptime_url",
 *     labels: { host: "example.com" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Monitoring
 */
export const UptimeCheckConfig = Resource<UptimeCheckConfig>(
  "GCP.Monitoring.UptimeCheckConfig",
);

export class UptimeCheckConfigNotResolved extends Data.TaggedError(
  "GCP.Monitoring.UptimeCheckConfigNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const parentOf = (project: string) => `projects/${project}`;

const userFacingLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

const subsetEqual = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) {
      return false;
    }
    return desired.every((item, index) => subsetEqual(observed[index], item));
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    const current = observed as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) => value === undefined || subsetEqual(current[key], value),
    );
  }
  return observed === desired;
};

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].sort();

const toDisplayName = (
  id: string,
  displayName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      displayName ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_DISPLAY_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const hasExplicitTarget = (news: UptimeCheckConfigProps) =>
  news.httpCheck !== undefined ||
  news.tcpCheck !== undefined ||
  news.syntheticMonitor !== undefined;

const defaultHttpCheck = (): HttpCheck => ({
  path: DEFAULT_PATH,
  port: DEFAULT_SSL_PORT,
  useSsl: true,
  validateSsl: true,
});

const defaultMonitoredResource = (project: string): MonitoredResource => ({
  type: DEFAULT_RESOURCE_TYPE,
  labels: { project_id: project, host: DEFAULT_HOST },
});

const desiredHttpCheck = (
  news: UptimeCheckConfigProps,
): HttpCheck | undefined => {
  if (news.tcpCheck !== undefined || news.syntheticMonitor !== undefined) {
    return news.httpCheck;
  }
  const check =
    news.httpCheck ??
    (hasExplicitTarget(news) ? undefined : defaultHttpCheck());
  if (check === undefined) return undefined;
  const useSsl = check.useSsl !== false;
  return {
    ...check,
    path: check.path && check.path.length > 0 ? check.path : DEFAULT_PATH,
    useSsl,
    validateSsl: useSsl ? check.validateSsl !== false : false,
    port: check.port ?? (useSsl ? DEFAULT_SSL_PORT : DEFAULT_HTTP_PORT),
  };
};

const desiredMonitoredResource = (
  news: UptimeCheckConfigProps,
  project: string,
): MonitoredResource | undefined => {
  if (news.syntheticMonitor !== undefined) return news.monitoredResource;
  if (news.resourceGroup !== undefined) return news.monitoredResource;
  const resource = news.monitoredResource ?? defaultMonitoredResource(project);
  const labels = {
    ...(resource.labels ?? {}),
  };
  if (labels.project_id === undefined) labels.project_id = project;
  if (
    labels.host === undefined &&
    (resource.type ?? DEFAULT_RESOURCE_TYPE) === DEFAULT_RESOURCE_TYPE
  ) {
    labels.host = DEFAULT_HOST;
  }
  return {
    type: resource.type ?? DEFAULT_RESOURCE_TYPE,
    labels,
  };
};

const toHttpCheck = (
  check: monitoring.HttpCheck | undefined,
): HttpCheck | undefined => {
  if (check === undefined) return undefined;
  const useSsl = check.useSsl !== false;
  const headers = tagRecord(check.headers);
  return {
    path: check.path && check.path.length > 0 ? check.path : DEFAULT_PATH,
    port: check.port ?? (useSsl ? DEFAULT_SSL_PORT : DEFAULT_HTTP_PORT),
    useSsl,
    validateSsl: useSsl ? check.validateSsl !== false : false,
    requestMethod:
      check.requestMethod && check.requestMethod !== "METHOD_UNSPECIFIED"
        ? check.requestMethod
        : undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    maskHeaders: check.maskHeaders === true ? true : undefined,
    authInfo: check.authInfo,
    serviceAgentAuthentication: check.serviceAgentAuthentication,
    contentType:
      check.contentType && check.contentType !== "TYPE_UNSPECIFIED"
        ? check.contentType
        : undefined,
    customContentType: check.customContentType,
    body: check.body,
    pingConfig: check.pingConfig,
    acceptedResponseStatusCodes: check.acceptedResponseStatusCodes,
  };
};

const toMonitoredResource = (
  resource: monitoring.MonitoredResource | undefined,
): MonitoredResource | undefined => {
  if (resource === undefined) return undefined;
  return {
    type: resource.type,
    labels: tagRecord(resource.labels),
  };
};

const toAttrs = (config: monitoring.UptimeCheckConfig, project: string) => {
  const name = config.name ?? "";
  return {
    name,
    uptimeCheckConfigId: lastSegment(name),
    project,
    displayName: config.displayName,
    timeout: config.timeout,
    period: config.period,
    httpCheck: toHttpCheck(config.httpCheck),
    tcpCheck: config.tcpCheck,
    syntheticMonitor: config.syntheticMonitor,
    monitoredResource: toMonitoredResource(config.monitoredResource),
    resourceGroup: config.resourceGroup,
    contentMatchers: config.contentMatchers ?? [],
    selectedRegions: config.selectedRegions ?? [],
    checkerType: config.checkerType,
    disabled: config.disabled === true,
    logCheckFailures: config.logCheckFailures === true,
    labels: userFacingLabels(config.userLabels),
  };
};

const getByName = (name: string) =>
  monitoring
    .getProjectsUptimeCheckConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  monitoring.listProjectsUptimeCheckConfigs
    .pages({
      parent: parentOf(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.uptimeCheckConfigs ?? []),
      ),
      Stream.filter((config) =>
        Object.keys(config.userLabels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((config) => toAttrs(config, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (project: string, id: string) =>
  Effect.gen(function* () {
    const owned = yield* monitoring.listProjectsUptimeCheckConfigs
      .pages({
        parent: parentOf(project),
        pageSize: 1000,
      })
      .pipe(
        Stream.flatMap((page) =>
          Stream.fromIterable(page.uptimeCheckConfigs ?? []),
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      );
    for (const config of owned) {
      if (yield* hasAlchemyLabels(id, tagRecord(config.userLabels))) {
        return config;
      }
    }
    return undefined;
  });

const observe = (project: string, id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name !== undefined) {
      const existing = yield* getByName(name);
      if (existing !== undefined) return existing;
    }
    return yield* findOwned(project, id);
  });

const toApiHttpCheck = (
  check: HttpCheck | undefined,
): monitoring.HttpCheck | undefined => {
  if (check === undefined) return undefined;
  return {
    path: check.path,
    port: check.port,
    useSsl: check.useSsl,
    validateSsl: check.validateSsl,
    requestMethod: check.requestMethod,
    headers: check.headers,
    maskHeaders: check.maskHeaders,
    authInfo: check.authInfo,
    serviceAgentAuthentication: check.serviceAgentAuthentication,
    contentType: check.contentType,
    customContentType: check.customContentType,
    body: check.body,
    pingConfig: check.pingConfig,
    acceptedResponseStatusCodes: check.acceptedResponseStatusCodes,
  };
};

const toApiMonitoredResource = (
  resource: MonitoredResource | undefined,
): monitoring.MonitoredResource | undefined => {
  if (resource === undefined) return undefined;
  return {
    type: resource.type,
    labels: resource.labels,
  };
};

export const UptimeCheckConfigProvider = () =>
  Provider.succeed(UptimeCheckConfig, {
    stables: ["name", "uptimeCheckConfigId", "project"],

    read: Effect.fn(function* ({ id, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* observe(env.project, id, output?.name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.userLabels)))
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
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const timeout = news.timeout ?? DEFAULT_TIMEOUT;
      const period = news.period ?? DEFAULT_PERIOD;
      const httpCheck = desiredHttpCheck(news);
      const monitoredResource = desiredMonitoredResource(news, env.project);
      const desiredDisabled = news.disabled === true;
      const desiredLogFailures = news.logCheckFailures === true;

      const body: monitoring.UptimeCheckConfig = {
        displayName,
        timeout,
        period,
        userLabels: desiredLabels,
        httpCheck: toApiHttpCheck(httpCheck),
        tcpCheck: news.tcpCheck,
        syntheticMonitor: news.syntheticMonitor,
        monitoredResource: toApiMonitoredResource(monitoredResource),
        resourceGroup: news.resourceGroup,
        contentMatchers: news.contentMatchers,
        selectedRegions: news.selectedRegions,
        checkerType: news.checkerType,
        disabled: desiredDisabled ? true : undefined,
        logCheckFailures: desiredLogFailures ? true : undefined,
      };

      let current = yield* observe(env.project, id, output?.name);

      if (current === undefined) {
        const created = yield* monitoring
          .createProjectsUptimeCheckConfigs({
            parent: parentOf(env.project),
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(env.project, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UptimeCheckConfigNotResolved({
          name: output?.name ?? displayName,
        });
      }

      const name = current.name ?? output?.name ?? "";
      const observedLabels = tagRecord(current.userLabels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const timeoutChanged = (current.timeout ?? "") !== timeout;
      const periodChanged = (current.period ?? DEFAULT_PERIOD) !== period;
      const httpChanged =
        httpCheck !== undefined &&
        !subsetEqual(toHttpCheck(current.httpCheck), httpCheck);
      const tcpChanged =
        news.tcpCheck !== undefined &&
        !subsetEqual(current.tcpCheck, news.tcpCheck);
      const syntheticChanged =
        news.syntheticMonitor !== undefined &&
        !subsetEqual(current.syntheticMonitor, news.syntheticMonitor);
      const resourceChanged =
        monitoredResource !== undefined &&
        !subsetEqual(
          toMonitoredResource(current.monitoredResource),
          monitoredResource,
        );
      const groupChanged =
        news.resourceGroup !== undefined &&
        !jsonEqual(current.resourceGroup, news.resourceGroup);
      const matchersChanged =
        news.contentMatchers !== undefined &&
        !jsonEqual(current.contentMatchers ?? [], news.contentMatchers);
      const regionsChanged =
        news.selectedRegions !== undefined &&
        !jsonEqual(
          sorted(current.selectedRegions),
          sorted(news.selectedRegions),
        );
      const checkerChanged =
        news.checkerType !== undefined &&
        (current.checkerType ?? "") !== news.checkerType;
      const disabledChanged = (current.disabled === true) !== desiredDisabled;
      const logChanged =
        (current.logCheckFailures === true) !== desiredLogFailures;

      const updateMask = [
        displayNameChanged ? "display_name" : undefined,
        timeoutChanged ? "timeout" : undefined,
        periodChanged ? "period" : undefined,
        labelsChanged ? "user_labels" : undefined,
        httpChanged ? "http_check" : undefined,
        tcpChanged ? "tcp_check" : undefined,
        syntheticChanged ? "synthetic_monitor" : undefined,
        resourceChanged ? "monitored_resource" : undefined,
        groupChanged ? "resource_group" : undefined,
        matchersChanged ? "content_matchers" : undefined,
        regionsChanged ? "selected_regions" : undefined,
        checkerChanged ? "checker_type" : undefined,
        disabledChanged ? "disabled" : undefined,
        logChanged ? "log_check_failures" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* monitoring.patchProjectsUptimeCheckConfigs({
          name,
          updateMask: updateMask.join(","),
          body: { ...body, name },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* monitoring
        .deleteProjectsUptimeCheckConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

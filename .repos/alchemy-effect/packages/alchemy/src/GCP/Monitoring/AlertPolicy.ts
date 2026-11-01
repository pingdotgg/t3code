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
import { compactStringMap } from "./ownership.ts";

const MAX_DISPLAY_NAME_LENGTH = 512;
const DEFAULT_COMBINER = "OR";

export type AlertPolicyCombiner =
  | "AND"
  | "OR"
  | "AND_WITH_MATCHING_RESOURCE"
  | (string & {});

export type AlertPolicySeverity =
  | "CRITICAL"
  | "ERROR"
  | "WARNING"
  | (string & {});

export type Aggregation = {
  /**
   * Alignment window (for example `"60s"`). Required when a per-series
   * aligner other than `ALIGN_NONE` is set. Minimum 60 seconds.
   */
  alignmentPeriod?: string;
  /**
   * Per-series aligner (`ALIGN_MEAN`, `ALIGN_RATE`, `ALIGN_MAX`, …).
   */
  perSeriesAligner?: string;
  /**
   * Cross-series reducer (`REDUCE_MEAN`, `REDUCE_SUM`, …).
   */
  crossSeriesReducer?: string;
  /**
   * Fields to preserve when reducing. `resource.type` is always kept.
   */
  groupByFields?: string[];
};

export type Trigger = {
  /** Absolute number of time series that must fail. */
  count?: number;
  /** Percentage of time series that must fail. */
  percent?: number;
};

export type ForecastOptions = {
  /**
   * How far ahead to forecast a threshold violation (1h–60h).
   */
  forecastHorizon?: string;
};

export type MetricThreshold = {
  /**
   * Monitoring filter identifying the time series (must include metric
   * type and resource type).
   */
  filter?: string;
  /**
   * Alignments applied in order to the time series selected by `filter`.
   */
  aggregations?: Aggregation[];
  /**
   * Denominator filter when comparing a ratio against the threshold.
   */
  denominatorFilter?: string;
  /**
   * Alignments applied to the denominator time series.
   */
  denominatorAggregations?: Aggregation[];
  /**
   * Comparison (`COMPARISON_GT` or `COMPARISON_LT`).
   */
  comparison?: string;
  /**
   * Threshold the time series is compared against.
   */
  thresholdValue?: number;
  /**
   * How long the series must violate the threshold. Must be a multiple
   * of 60 seconds.
   */
  duration?: string;
  /**
   * How many (or what percent of) series must fail. Defaults to count 1.
   */
  trigger?: Trigger;
  /**
   * Behavior when data stops arriving (`EVALUATION_MISSING_DATA_INACTIVE`,
   * `EVALUATION_MISSING_DATA_ACTIVE`, `EVALUATION_MISSING_DATA_NO_OP`).
   */
  evaluationMissingData?: string;
  /**
   * When set, the condition forecasts whether the series will violate
   * the threshold within `forecastHorizon`.
   */
  forecastOptions?: ForecastOptions;
};

export type MetricAbsence = {
  /**
   * Monitoring filter identifying the time series.
   */
  filter?: string;
  /**
   * Alignments applied in order.
   */
  aggregations?: Aggregation[];
  /**
   * How long the series must fail to report data. Minimum 120 seconds.
   */
  duration?: string;
  /**
   * How many (or what percent of) series must fail. Defaults to count 1.
   */
  trigger?: Trigger;
};

export type LogMatch = {
  /**
   * Advanced logs filter. Only logs in the scoping project are evaluated.
   */
  filter?: string;
  /**
   * Map from label key to an extractor expression.
   */
  labelExtractors?: Record<string, string>;
};

export type MonitoringQueryLanguageCondition = {
  /** MQL query that outputs a boolean stream. */
  query?: string;
  /**
   * How long the series must violate the condition. Multiple of 60s.
   */
  duration?: string;
  /**
   * Behavior when data stops arriving.
   */
  evaluationMissingData?: string;
  /** How many (or what percent of) series must fail. */
  trigger?: Trigger;
};

export type PrometheusQueryLanguageCondition = {
  /** PromQL expression. Required. */
  query?: string;
  /** How long the expression must be true before firing. */
  duration?: string;
  /** Evaluation interval. Multiple of 30 seconds. Defaults to 30s. */
  evaluationInterval?: string;
  /** Labels added to or overwriting the PromQL result. */
  labels?: Record<string, string>;
  /** Rule group name from the originating Prometheus config. */
  ruleGroup?: string;
  /** Alerting rule name from the originating Prometheus config. */
  alertRule?: string;
  /**
   * When true, skip metric-existence validation so policies can be
   * created before the metric exists.
   */
  disableMetricValidation?: boolean;
};

export type SqlCondition = {
  /** Log Analytics GoogleSQL query. */
  query?: string;
  /** Run every N minutes (5–1440). */
  minutes?: { periodicity?: number };
  /** Run every N hours (1–48). */
  hourly?: { periodicity?: number; minuteOffset?: number };
  /** Run every N days (1–31). */
  daily?: {
    periodicity?: number;
    executionTime?: {
      hours?: number;
      minutes?: number;
      seconds?: number;
      nanos?: number;
    };
  };
  /** Compare the result row count against a threshold. */
  rowCountTest?: { comparison?: string; threshold?: string };
  /** Test a boolean column. */
  booleanTest?: { column?: string };
};

export type AlertCondition = {
  /**
   * Short name shown in dashboards and incidents. Unique within the
   * policy.
   */
  displayName: string;
  /**
   * Server-assigned condition name. Omit on create. On update, Alchemy
   * preserves observed names so GCP does not recreate conditions.
   */
  name?: string;
  /** Compare a time series against a threshold. */
  conditionThreshold?: MetricThreshold;
  /** Fire when a time series stops reporting data. */
  conditionAbsent?: MetricAbsence;
  /** Fire when a log entry matches `filter`. Exclusive of other kinds. */
  conditionMatchedLog?: LogMatch;
  /** MQL boolean-stream condition. */
  conditionMonitoringQueryLanguage?: MonitoringQueryLanguageCondition;
  /** PromQL alerting rule. */
  conditionPrometheusQueryLanguage?: PrometheusQueryLanguageCondition;
  /** Log Analytics SQL condition. */
  conditionSql?: SqlCondition;
};

export type DocumentationLink = {
  /** Short link title (max 63 characters). */
  displayName?: string;
  /** URL. May include alert template variables. */
  url?: string;
};

export type Documentation = {
  /** Body included in notifications. Markdown. Max 8192 characters. */
  content?: string;
  /**
   * MIME type of `content`.
   * @default "text/markdown"
   */
  mimeType?: string;
  /** Notification subject line. */
  subject?: string;
  /** Up to 3 documentation links. */
  links?: DocumentationLink[];
};

export type AlertStrategy = {
  /** Close open incidents after this much missing data. */
  autoClose?: string;
  /** Log-based policies only. At most one notification per period. */
  notificationRateLimit?: { period?: string };
  /**
   * When to notify (`OPENED`, `CLOSED`). Log-based policies are always
   * `OPENED`.
   */
  notificationPrompts?: string[];
  /** Per-channel reminder settings. */
  notificationChannelStrategy?: {
    renotifyInterval?: string;
    notificationChannelNames?: string[];
  }[];
};

export type AlertPolicyProps = {
  /**
   * Human-readable display name. If omitted, a unique name is generated
   * from the stack, stage, and logical id. Limited to 512 Unicode
   * characters.
   */
  displayName?: string;
  /**
   * How to combine conditions when more than one is set.
   * @default "OR"
   */
  combiner?: AlertPolicyCombiner;
  /**
   * Conditions that open an incident. A policy has 1–6 conditions.
   */
  conditions: AlertCondition[];
  /**
   * Notification channel resource names
   * (`projects/{project}/notificationChannels/{channel}`).
   */
  notificationChannels?: string[];
  /**
   * Markdown documentation included in notifications and incidents.
   */
  documentation?: Documentation;
  /**
   * Whether the policy is evaluated.
   * @default true
   */
  enabled?: boolean;
  /**
   * Incident severity shown in the console and notifications.
   */
  severity?: AlertPolicySeverity;
  /**
   * Notification strategy (auto-close, rate limits, prompts).
   */
  alertStrategy?: AlertStrategy;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type AlertPolicy = Resource<
  "GCP.Monitoring.AlertPolicy",
  AlertPolicyProps,
  {
    /** Full resource name `projects/{project}/alertPolicies/{policy}`. */
    name: string;
    /** Server-assigned policy id (last path segment). */
    alertPolicyId: string;
    /** Project id. */
    project: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** Combiner used when the policy has multiple conditions. */
    combiner: string | undefined;
    /** Conditions currently configured. */
    conditions: AlertCondition[];
    /** Notification channel resource names. */
    notificationChannels: ReadonlyArray<string>;
    /** Documentation included in notifications, if set. */
    documentation: Documentation | undefined;
    /** Whether the policy is evaluated. */
    enabled: boolean;
    /** Incident severity, if set. */
    severity: string | undefined;
    /** Notification strategy, if set. */
    alertStrategy: AlertStrategy | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Cloud Monitoring alerting policy — conditions that open incidents
 * and optional notification channels.
 *
 * Policy ids are assigned by the API. Alchemy stamps ownership into
 * `userLabels` so `list` / `pnpm nuke:gcp` can find them. Display name,
 * combiner, conditions, channels, documentation, enabled, severity,
 * strategy, and labels update in place.
 *
 * ### Creating a Policy
 * **Example:** CPU threshold without a notification channel
 * ```typescript
 * const policy = yield* GCP.Monitoring.AlertPolicy("CpuHigh", {
 *   combiner: "OR",
 *   conditions: [
 *     {
 *       displayName: "CPU > 90%",
 *       conditionThreshold: {
 *         filter:
 *           'resource.type = "gce_instance" AND metric.type = "compute.googleapis.com/instance/cpu/utilization"',
 *         comparison: "COMPARISON_GT",
 *         thresholdValue: 0.9,
 *         duration: "60s",
 *         aggregations: [
 *           { alignmentPeriod: "60s", perSeriesAligner: "ALIGN_MEAN" },
 *         ],
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Policy that emails a channel
 * ```typescript
 * const channel = yield* GCP.Monitoring.NotificationChannel("Oncall", {
 *   type: "email",
 *   labels: { email_address: "oncall@example.com" },
 * });
 * const policy = yield* GCP.Monitoring.AlertPolicy("CpuHigh", {
 *   conditions: [
 *     {
 *       displayName: "CPU > 90%",
 *       conditionThreshold: {
 *         filter:
 *           'resource.type = "gce_instance" AND metric.type = "compute.googleapis.com/instance/cpu/utilization"',
 *         comparison: "COMPARISON_GT",
 *         thresholdValue: 0.9,
 *         duration: "60s",
 *       },
 *     },
 *   ],
 *   notificationChannels: [channel.name],
 * });
 * ```
 *
 * ### Updating a Policy
 * **Example:** Lower the threshold and disable the policy
 * ```typescript
 * const policy = yield* GCP.Monitoring.AlertPolicy("CpuHigh", {
 *   combiner: "OR",
 *   enabled: false,
 *   conditions: [
 *     {
 *       displayName: "CPU > 50%",
 *       conditionThreshold: {
 *         filter:
 *           'resource.type = "gce_instance" AND metric.type = "compute.googleapis.com/instance/cpu/utilization"',
 *         comparison: "COMPARISON_GT",
 *         thresholdValue: 0.5,
 *         duration: "60s",
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Monitoring
 */
export const AlertPolicy = Resource<AlertPolicy>("GCP.Monitoring.AlertPolicy");

export class AlertPolicyNotResolved extends Data.TaggedError(
  "GCP.Monitoring.AlertPolicyNotResolved",
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

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].sort();

const withoutName = (condition: AlertCondition | monitoring.Condition) => {
  const { name: _name, ...rest } = condition;
  return rest;
};

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

const toLogMatch = (
  value: monitoring.LogMatch | undefined,
): LogMatch | undefined => {
  if (value === undefined) return undefined;
  return {
    filter: value.filter,
    labelExtractors: compactStringMap(value.labelExtractors),
  };
};

const toPrometheusQueryLanguageCondition = (
  value: monitoring.PrometheusQueryLanguageCondition | undefined,
): PrometheusQueryLanguageCondition | undefined => {
  if (value === undefined) return undefined;
  return {
    query: value.query,
    duration: value.duration,
    evaluationInterval: value.evaluationInterval,
    labels: compactStringMap(value.labels),
    ruleGroup: value.ruleGroup,
    alertRule: value.alertRule,
    disableMetricValidation: value.disableMetricValidation,
  };
};

const toCondition = (condition: monitoring.Condition): AlertCondition => ({
  displayName: condition.displayName ?? "",
  name: condition.name,
  conditionThreshold: condition.conditionThreshold,
  conditionAbsent: condition.conditionAbsent,
  conditionMatchedLog: toLogMatch(condition.conditionMatchedLog),
  conditionMonitoringQueryLanguage: condition.conditionMonitoringQueryLanguage,
  conditionPrometheusQueryLanguage: toPrometheusQueryLanguageCondition(
    condition.conditionPrometheusQueryLanguage,
  ),
  conditionSql: condition.conditionSql,
});

const toDocumentation = (
  documentation: monitoring.Documentation | undefined,
): Documentation | undefined => {
  if (documentation === undefined) return undefined;
  return {
    content: documentation.content,
    mimeType: documentation.mimeType,
    subject: documentation.subject,
    links: documentation.links,
  };
};

const toAlertStrategy = (
  strategy: monitoring.AlertStrategy | undefined,
): AlertStrategy | undefined => {
  if (strategy === undefined) return undefined;
  return {
    autoClose: strategy.autoClose,
    notificationRateLimit: strategy.notificationRateLimit,
    notificationPrompts: strategy.notificationPrompts,
    notificationChannelStrategy: strategy.notificationChannelStrategy,
  };
};

const toAttrs = (policy: monitoring.AlertPolicy, project: string) => {
  const name = policy.name ?? "";
  return {
    name,
    alertPolicyId: lastSegment(name),
    project,
    displayName: policy.displayName,
    combiner: policy.combiner,
    conditions: (policy.conditions ?? []).map(toCondition),
    notificationChannels: policy.notificationChannels ?? [],
    documentation: toDocumentation(policy.documentation),
    enabled: policy.enabled !== false,
    severity: policy.severity,
    alertStrategy: toAlertStrategy(policy.alertStrategy),
    labels: userFacingLabels(policy.userLabels),
  };
};

const toApiCondition = (condition: AlertCondition): monitoring.Condition => ({
  displayName: condition.displayName,
  name: condition.name,
  conditionThreshold: condition.conditionThreshold,
  conditionAbsent: condition.conditionAbsent,
  conditionMatchedLog: condition.conditionMatchedLog,
  conditionMonitoringQueryLanguage: condition.conditionMonitoringQueryLanguage,
  conditionPrometheusQueryLanguage: condition.conditionPrometheusQueryLanguage,
  conditionSql: condition.conditionSql as monitoring.SqlCondition | undefined,
});

const withConditionNames = (
  desired: readonly AlertCondition[],
  observed: readonly monitoring.Condition[] | undefined,
): monitoring.Condition[] => {
  const unused = [...(observed ?? [])];
  return desired.map((condition, index) => {
    if (condition.name !== undefined) return toApiCondition(condition);
    const byDisplay = unused.findIndex(
      (item) => item.displayName === condition.displayName,
    );
    const matchIndex =
      byDisplay >= 0 ? byDisplay : index < unused.length ? index : -1;
    const match = matchIndex >= 0 ? unused.splice(matchIndex, 1)[0] : undefined;
    return { ...toApiCondition(condition), name: match?.name };
  });
};

const getByName = (name: string) =>
  monitoring
    .getProjectsAlertPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  monitoring.listProjectsAlertPolicies
    .pages({
      name: parentOf(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.alertPolicies ?? [])),
      Stream.filter((policy) =>
        Object.keys(policy.userLabels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((policy) => toAttrs(policy, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (project: string, id: string) =>
  Effect.gen(function* () {
    const owned = yield* monitoring.listProjectsAlertPolicies
      .pages({
        name: parentOf(project),
        pageSize: 1000,
      })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.alertPolicies ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      );
    for (const policy of owned) {
      if (yield* hasAlchemyLabels(id, tagRecord(policy.userLabels))) {
        return policy;
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

export const AlertPolicyProvider = () =>
  Provider.succeed(AlertPolicy, {
    stables: ["name", "alertPolicyId", "project"],

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
      const combiner = news.combiner ?? DEFAULT_COMBINER;
      const desiredEnabled = news.enabled !== false;
      const desiredChannels = news.notificationChannels ?? [];

      let current = yield* observe(env.project, id, output?.name);

      const conditions = withConditionNames(
        news.conditions,
        current?.conditions,
      );
      const body: monitoring.AlertPolicy = {
        displayName,
        combiner,
        enabled: desiredEnabled,
        userLabels: desiredLabels,
        conditions,
        notificationChannels: desiredChannels,
        documentation: news.documentation,
        alertStrategy: news.alertStrategy as
          | monitoring.AlertStrategy
          | undefined,
        severity: news.severity,
      };

      if (current === undefined) {
        const created = yield* monitoring
          .createProjectsAlertPolicies({
            name: parentOf(env.project),
            body: {
              ...body,
              conditions: news.conditions.map((condition) =>
                toApiCondition({ ...condition, name: undefined }),
              ),
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(env.project, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AlertPolicyNotResolved({
          name: output?.name ?? displayName,
        });
      }

      const name = current.name ?? output?.name ?? "";
      const observedLabels = tagRecord(current.userLabels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const combinerChanged =
        (current.combiner ?? DEFAULT_COMBINER) !== combiner;
      const enabledChanged = (current.enabled !== false) !== desiredEnabled;
      const channelsChanged = !jsonEqual(
        sorted(current.notificationChannels),
        sorted(desiredChannels),
      );
      const conditionsChanged = !jsonEqual(
        (current.conditions ?? []).map(withoutName),
        conditions.map(withoutName),
      );
      const documentationChanged =
        news.documentation !== undefined &&
        !jsonEqual(
          toDocumentation(current.documentation) ?? null,
          news.documentation,
        );
      const strategyChanged =
        news.alertStrategy !== undefined &&
        !jsonEqual(
          toAlertStrategy(current.alertStrategy) ?? null,
          news.alertStrategy,
        );
      const severityChanged =
        news.severity !== undefined &&
        (current.severity ?? "") !== news.severity;

      const updateMask = [
        displayNameChanged ? "display_name" : undefined,
        combinerChanged ? "combiner" : undefined,
        enabledChanged ? "enabled" : undefined,
        labelsChanged ? "user_labels" : undefined,
        channelsChanged ? "notification_channels" : undefined,
        conditionsChanged ? "conditions" : undefined,
        documentationChanged ? "documentation" : undefined,
        strategyChanged ? "alert_strategy" : undefined,
        severityChanged ? "severity" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* monitoring.patchProjectsAlertPolicies({
          name,
          updateMask: updateMask.join(","),
          body: {
            ...body,
            name,
            conditions: withConditionNames(news.conditions, current.conditions),
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* monitoring
        .deleteProjectsAlertPolicies({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 100;
const DEFAULT_METRIC_KIND = "DELTA";
const DEFAULT_VALUE_TYPE = "INT64";

export interface MetricLabel {
  /**
   * Label key. Must match a key in `labelExtractors` when extractors are
   * set.
   */
  key: string;
  /**
   * Human-readable description of the label.
   */
  description?: string;
  /**
   * Label value type.
   * @default "STRING"
   */
  valueType?: "STRING" | "BOOL" | "INT64";
}

export interface MetricDescriptorProps {
  /**
   * Whether the metric records instantaneous values or changes.
   * Immutable after create — changing it replaces the metric.
   * @default "DELTA"
   */
  metricKind?: "GAUGE" | "DELTA" | "CUMULATIVE";
  /**
   * Measurement type. Immutable after create — changing it replaces the
   * metric. `DISTRIBUTION` requires `valueExtractor` and `bucketOptions`.
   * @default "INT64"
   */
  valueType?: "BOOL" | "INT64" | "DOUBLE" | "STRING" | "DISTRIBUTION" | "MONEY";
  /**
   * Unit of the metric value (e.g. `"1"`, `"s"`, `"By"`).
   * @default "1"
   */
  unit?: string;
  /**
   * Concise display name shown in Monitoring.
   */
  displayName?: string;
  /**
   * Time-series labels. New labels may be added; existing keys cannot be
   * renamed or have their value type changed.
   */
  labels?: MetricLabel[];
}

export interface LinearBuckets {
  /** Number of finite buckets. Must be greater than 0. */
  numFiniteBuckets?: number;
  /** Width of each finite bucket. Must be greater than 0. */
  width?: number;
  /** Lower bound of the first finite bucket. */
  offset?: number;
}

export interface ExponentialBuckets {
  /** Number of finite buckets. Must be greater than 0. */
  numFiniteBuckets?: number;
  /** Growth factor between buckets. Must be greater than 1. */
  growthFactor?: number;
  /** Scale of the first bucket. Must be greater than 0. */
  scale?: number;
}

export interface ExplicitBuckets {
  /** Monotonically increasing bucket bounds. */
  bounds?: number[];
}

export interface MetricBucketOptions {
  /** Linear histogram buckets. */
  linearBuckets?: LinearBuckets;
  /** Exponential histogram buckets. */
  exponentialBuckets?: ExponentialBuckets;
  /** Explicit histogram bucket bounds. */
  explicitBuckets?: ExplicitBuckets;
}

export type MetricProps = {
  /**
   * Client-assigned metric id (`METRIC_ID` in
   * `projects/{project}/metrics/{METRIC_ID}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Max 100 characters;
   * letters, digits, and `_-. ,+!*'()%/`. Cannot start with `/`. Changing
   * it replaces the metric.
   */
  metricId?: string;
  /**
   * Advanced logs filter used to match log entries. Required. Max 20,000
   * characters.
   */
  filter: string;
  /**
   * Human-readable description. Cloud Logging metrics have no labels, so
   * Alchemy ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`)
   * is stored in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * When true, the metric exists but does not generate time series.
   * @default false
   */
  disabled?: boolean;
  /**
   * Extractor used by distribution metrics (`EXTRACT(field)` or
   * `REGEXP_EXTRACT(field, regex)`).
   */
  valueExtractor?: string;
  /**
   * Map from metric-descriptor label key to an extractor expression.
   */
  labelExtractors?: Record<string, string>;
  /**
   * Log bucket that owns this metric
   * (`projects/{project}/locations/{location}/buckets/{bucket}`). Empty
   * means a non-bucket logs-based metric.
   */
  bucketName?: string;
  /**
   * Metric descriptor. Defaults to a `DELTA`/`INT64` counter. `metricKind`
   * and `valueType` are immutable after create.
   */
  metricDescriptor?: MetricDescriptorProps;
  /**
   * Histogram bucket boundaries. Required when `valueType` is
   * `DISTRIBUTION`.
   */
  bucketOptions?: MetricBucketOptions;
};

export type Metric = Resource<
  "GCP.Logging.Metric",
  MetricProps,
  {
    /** Full resource name `projects/{project}/metrics/{metricId}`. */
    name: string;
    /** Client-assigned metric id. */
    metricId: string;
    /** Project id. */
    project: string;
    /** Logs filter. */
    filter: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether the metric is disabled. */
    disabled: boolean;
    /** Distribution value extractor, if set. */
    valueExtractor: string | undefined;
    /** Label extractor map. */
    labelExtractors: Record<string, string>;
    /** Owning log bucket, if this is a bucket metric. */
    bucketName: string | undefined;
    /** Observed metric descriptor. */
    metricDescriptor: MetricDescriptorProps | undefined;
    /** Histogram bucket options, if set. */
    bucketOptions: MetricBucketOptions | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging logs-based metric.
 *
 * Cloud Logging metrics have no resource labels. Alchemy stamps ownership
 * into the description (`[alchemy alchemy-stack=… alchemy-stage=…
 * alchemy-id=…]`) so `list` / `pnpm nuke:gcp` can find them.
 *
 * `metricId`, `metricDescriptor.metricKind`, and
 * `metricDescriptor.valueType` are immutable — changing them replaces the
 * metric.
 *
 * ### Creating a Metric
 * **Example:** Generated name, error counter
 * ```typescript
 * const errors = yield* GCP.Logging.Metric("Errors", {
 *   filter: "severity>=ERROR",
 *   description: "count error log entries",
 * });
 * ```
 *
 * **Example:** Explicit id, disabled counter
 * ```typescript
 * const warnings = yield* GCP.Logging.Metric("Warnings", {
 *   metricId: "app-warnings",
 *   filter: "severity>=WARNING",
 *   description: "count warning log entries",
 *   disabled: true,
 * });
 * ```
 *
 * ### Distribution Metrics
 * **Example:** Histogram of a numeric payload field
 * ```typescript
 * const latency = yield* GCP.Logging.Metric("Latency", {
 *   filter: "jsonPayload.latency > 0",
 *   valueExtractor: "EXTRACT(jsonPayload.latency)",
 *   metricDescriptor: {
 *     metricKind: "DELTA",
 *     valueType: "DISTRIBUTION",
 *   },
 *   bucketOptions: {
 *     exponentialBuckets: {
 *       numFiniteBuckets: 8,
 *       growthFactor: 2,
 *       scale: 1,
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const Metric = Resource<Metric>("GCP.Logging.Metric");

export class MetricNotResolved extends Data.TaggedError(
  "GCP.Logging.MetricNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const resourceName = (project: string, metricId: string) =>
  `projects/${project}/metrics/${metricId}`;

const metricIdOf = (metric: logging.LogMetric) => {
  const raw = metric.name ?? metric.resourceName ?? "";
  return raw.startsWith("projects/") ? lastSegment(raw) : raw;
};

const toId = (id: string, metricId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      metricId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toLabels = (
  labels: logging.LabelDescriptorList | undefined,
): MetricLabel[] =>
  (labels ?? []).flatMap((label) =>
    label.key
      ? [
          {
            key: label.key,
            description: label.description,
            valueType: label.valueType as MetricLabel["valueType"],
          },
        ]
      : [],
  );

const toDescriptor = (
  descriptor: logging.MetricDescriptor | undefined,
): MetricDescriptorProps | undefined => {
  if (descriptor === undefined) return undefined;
  const labels = toLabels(descriptor.labels);
  return {
    metricKind: descriptor.metricKind as MetricDescriptorProps["metricKind"],
    valueType: descriptor.valueType as MetricDescriptorProps["valueType"],
    unit: descriptor.unit,
    displayName: descriptor.displayName,
    labels: labels.length > 0 ? labels : undefined,
  };
};

const toBucketOptions = (
  options: logging.BucketOptions | undefined,
): MetricBucketOptions | undefined => {
  if (options === undefined) return undefined;
  if (
    options.linearBuckets === undefined &&
    options.exponentialBuckets === undefined &&
    options.explicitBuckets === undefined
  ) {
    return undefined;
  }
  return {
    linearBuckets: options.linearBuckets,
    exponentialBuckets: options.exponentialBuckets,
    explicitBuckets: options.explicitBuckets,
  };
};

const toAttrs = (metric: logging.LogMetric, project: string) => {
  const metricId = metricIdOf(metric);
  const parsed = parseDescription(metric.description);
  return {
    name: metric.resourceName ?? resourceName(project, metricId),
    metricId,
    project,
    filter: metric.filter ?? "",
    description: parsed.description,
    disabled: metric.disabled === true,
    valueExtractor: metric.valueExtractor,
    labelExtractors: tagRecord(metric.labelExtractors),
    bucketName: metric.bucketName,
    metricDescriptor: toDescriptor(metric.metricDescriptor),
    bucketOptions: toBucketOptions(metric.bucketOptions),
    createTime: metric.createTime,
    updateTime: metric.updateTime,
  };
};

const recordsEqual = (
  left: Record<string, string>,
  right: Record<string, string>,
) => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key],
    )
  );
};

const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const canonLabels = (labels: MetricLabel[] | undefined) =>
  [...(labels ?? [])]
    .map((label) => ({
      key: label.key,
      description: label.description ?? "",
      valueType: (label.valueType ?? "STRING").toUpperCase(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

const descriptorChanged = (
  observed: logging.MetricDescriptor | undefined,
  desired: MetricDescriptorProps | undefined,
) => {
  if (desired === undefined) return false;
  if (
    desired.metricKind !== undefined &&
    (observed?.metricKind ?? DEFAULT_METRIC_KIND).toUpperCase() !==
      desired.metricKind.toUpperCase()
  ) {
    return true;
  }
  if (
    desired.valueType !== undefined &&
    (observed?.valueType ?? DEFAULT_VALUE_TYPE).toUpperCase() !==
      desired.valueType.toUpperCase()
  ) {
    return true;
  }
  if (desired.unit !== undefined && (observed?.unit ?? "1") !== desired.unit) {
    return true;
  }
  if (
    desired.displayName !== undefined &&
    (observed?.displayName ?? "") !== desired.displayName
  ) {
    return true;
  }
  if (desired.labels !== undefined) {
    return !jsonEqual(
      canonLabels(toLabels(observed?.labels)),
      canonLabels(desired.labels),
    );
  }
  return false;
};

const toWritableDescriptor = (
  descriptor: MetricDescriptorProps | logging.MetricDescriptor | undefined,
): logging.MetricDescriptor | undefined => {
  if (descriptor === undefined) return undefined;
  const labels = descriptor.labels as logging.LabelDescriptorList | undefined;
  const body: logging.MetricDescriptor = {
    metricKind: descriptor.metricKind,
    valueType: descriptor.valueType,
    unit: descriptor.unit,
    displayName: descriptor.displayName,
    labels: labels && labels.length > 0 ? labels : undefined,
  };
  if (
    body.metricKind === undefined &&
    body.valueType === undefined &&
    body.unit === undefined &&
    body.displayName === undefined &&
    body.labels === undefined
  ) {
    return undefined;
  }
  return body;
};

const toBody = (
  metricId: string,
  news: MetricProps,
  ownership: Record<string, string>,
  current?: logging.LogMetric,
): logging.LogMetric => ({
  name: metricId,
  filter: news.filter,
  description: encodeDescription(ownership, news.description),
  disabled: news.disabled === true,
  valueExtractor: news.valueExtractor,
  labelExtractors: news.labelExtractors,
  bucketName: news.bucketName,
  bucketOptions: news.bucketOptions,
  metricDescriptor: toWritableDescriptor(
    news.metricDescriptor ?? current?.metricDescriptor,
  ),
});

const getByName = (metricName: string) =>
  logging
    .getProjectsMetrics({ metricName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const MetricProvider = () =>
  Provider.succeed(Metric, {
    stables: ["name", "metricId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.metricId ?? output?.metricId;
      const nextId = news.metricId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        news.metricId !== undefined &&
        previousId !== news.metricId;

      const previousKind = (
        olds?.metricDescriptor?.metricKind ??
        output?.metricDescriptor?.metricKind
      )?.toUpperCase();
      const nextKind = news.metricDescriptor?.metricKind?.toUpperCase();
      const kindChanged =
        nextKind !== undefined &&
        previousKind !== undefined &&
        nextKind !== previousKind;

      const previousType = (
        olds?.metricDescriptor?.valueType ?? output?.metricDescriptor?.valueType
      )?.toUpperCase();
      const nextType = news.metricDescriptor?.valueType?.toUpperCase();
      const typeChanged =
        nextType !== undefined &&
        previousType !== undefined &&
        nextType !== previousType;

      if (!idChanged && !kindChanged && !typeChanged) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          !idChanged && previousId !== undefined && nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const metricId = yield* toId(id, olds?.metricId, output?.metricId);
      const name = output?.name ?? resourceName(env.project, metricId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(
        id,
        parseDescription(existing.description).labels,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* logging.listProjectsMetrics
          .pages({
            parent: `projects/${env.project}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.metrics ?? [])),
            Stream.filter((metric) => hasOwnershipMarker(metric.description)),
            Stream.map((metric) => toAttrs(metric, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const metricId = yield* toId(id, news.metricId, output?.metricId);
      const metricName = resourceName(env.project, metricId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredDisabled = news.disabled === true;
      const desiredExtractors = tagRecord(news.labelExtractors);

      let current = yield* getByName(output?.name ?? metricName);

      if (current === undefined) {
        const created = yield* logging
          .createProjectsMetrics({
            parent: `projects/${env.project}`,
            body: toBody(metricId, news, ownership),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(metricName)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new MetricNotResolved({ name: metricName });
      }

      const needsUpdate =
        (current.description ?? "") !== desiredDescription ||
        (current.filter ?? "") !== news.filter ||
        (current.disabled === true) !== desiredDisabled ||
        (current.valueExtractor ?? "") !== (news.valueExtractor ?? "") ||
        !recordsEqual(tagRecord(current.labelExtractors), desiredExtractors) ||
        (current.bucketName ?? "") !== (news.bucketName ?? "") ||
        !jsonEqual(
          toBucketOptions(current.bucketOptions) ?? null,
          news.bucketOptions ?? null,
        ) ||
        descriptorChanged(current.metricDescriptor, news.metricDescriptor);

      if (needsUpdate) {
        current = yield* logging.updateProjectsMetrics({
          metricName,
          body: toBody(metricId, news, ownership, current),
        });
      }

      const latest =
        (yield* getByName(current.resourceName ?? metricName)) ?? current;
      return toAttrs(latest, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteProjectsMetrics({ metricName: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

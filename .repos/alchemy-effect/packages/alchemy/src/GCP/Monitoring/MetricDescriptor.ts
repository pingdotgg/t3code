import * as monitoring from "@distilled.cloud/gcp/monitoring_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  jsonEqual,
  parentOf,
  parseMarker,
} from "./ownership.ts";

const MAX_TYPE_LENGTH = 100;
const CUSTOM_PREFIX = "custom.googleapis.com/";
const DEFAULT_METRIC_KIND = "GAUGE";
const DEFAULT_VALUE_TYPE = "DOUBLE";
const DEFAULT_UNIT = "1";

export type MetricKind = "GAUGE" | "DELTA" | "CUMULATIVE" | (string & {});

export type MetricValueType =
  | "BOOL"
  | "INT64"
  | "DOUBLE"
  | "STRING"
  | "DISTRIBUTION"
  | "MONEY"
  | (string & {});

export type MetricLabelDescriptor = {
  /**
   * Label key. Must match `[a-zA-Z][a-zA-Z0-9_]*` and be at most 100
   * characters.
   */
  key?: string;
  /** Human-readable description of the label. */
  description?: string;
  /**
   * Label value type.
   * @default "STRING"
   */
  valueType?: "STRING" | "BOOL" | "INT64" | (string & {});
};

export type MetricDescriptorMetadata = {
  /** Sampling period of written data points (for example `"60s"`). */
  samplePeriod?: string;
  /** Ingest delay after which points are guaranteed available. */
  ingestDelay?: string;
  /** Hierarchy levels that emit this metric (`PROJECT`, `FOLDER`, …). */
  timeSeriesResourceHierarchyLevel?: string[];
  /** Deprecated launch stage; prefer the top-level `launchStage`. */
  launchStage?: string;
};

export type MetricDescriptorProps = {
  /**
   * Metric type, including DNS prefix (for example
   * `custom.googleapis.com/invoice/paid/amount`). If omitted, a unique
   * `custom.googleapis.com/` type is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the descriptor.
   */
  type?: string;
  /**
   * Whether the metric records a point-in-time value or a change.
   * Custom metrics support `GAUGE` and `CUMULATIVE` (`DELTA` is
   * rejected). Immutable after create — changing it replaces the
   * descriptor.
   * @default "GAUGE"
   */
  metricKind?: MetricKind;
  /**
   * Measurement type. Immutable after create — changing it replaces
   * the descriptor.
   * @default "DOUBLE"
   */
  valueType?: MetricValueType;
  /**
   * Unit of the stored value (`"1"`, `"s"`, `"By"`, …).
   * @default "1"
   */
  unit?: string;
  /**
   * Concise display name shown in Monitoring UIs.
   */
  displayName?: string;
  /**
   * Detailed description. Metric descriptors have no resource labels,
   * so Alchemy stamps ownership into this field for `list` / nuke.
   */
  description?: string;
  /**
   * Time-series labels. New keys may be added; existing keys cannot be
   * removed or have their value type changed without replacing the
   * descriptor.
   */
  labels?: MetricLabelDescriptor[];
  /**
   * Optional launch stage of the metric definition.
   */
  launchStage?: string;
  /**
   * Optional usage metadata (sample period, ingest delay).
   */
  metadata?: MetricDescriptorMetadata;
};

export type MetricDescriptor = Resource<
  "GCP.Monitoring.MetricDescriptor",
  MetricDescriptorProps,
  {
    /** Full resource name `projects/{project}/metricDescriptors/{type}`. */
    name: string;
    /** Metric type, including DNS prefix. */
    type: string;
    /** Project id. */
    project: string;
    /** Metric kind (`GAUGE`, `DELTA`, `CUMULATIVE`). */
    metricKind: string | undefined;
    /** Value type (`DOUBLE`, `INT64`, …). */
    valueType: string | undefined;
    /** Unit of the stored value. */
    unit: string | undefined;
    /** Concise display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Time-series label descriptors. */
    labels: MetricLabelDescriptor[];
    /** Launch stage, if set. */
    launchStage: string | undefined;
    /** Usage metadata, if set. */
    metadata: MetricDescriptorMetadata | undefined;
    /** Compatible monitored resource types, if the API reports them. */
    monitoredResourceTypes: ReadonlyArray<string>;
  },
  never,
  Providers
>;

/**
 * A Cloud Monitoring metric descriptor — the schema for a custom or
 * external metric type.
 *
 * Descriptors have no resource labels. Alchemy stamps ownership into
 * `description` (`[alchemy alchemy-stack=… alchemy-stage=…
 * alchemy-id=…]`) so `list` / `pnpm nuke:gcp` can find them. `type`,
 * `metricKind`, and `valueType` are immutable — changing them replaces
 * the descriptor. Display name, description, unit, metadata, and added
 * labels update in place via create-as-upsert.
 *
 * ### Creating a Descriptor
 * **Example:** Generated custom gauge
 * ```typescript
 * const metric = yield* GCP.Monitoring.MetricDescriptor("Paid", {
 *   displayName: "Invoice paid amount",
 *   description: "amount collected per invoice",
 * });
 * ```
 *
 * **Example:** Explicit type, kind, and labels
 * ```typescript
 * const metric = yield* GCP.Monitoring.MetricDescriptor("Paid", {
 *   type: "custom.googleapis.com/invoice/paid/amount",
 *   metricKind: "DELTA",
 *   valueType: "INT64",
 *   unit: "1",
 *   labels: [{ key: "currency", valueType: "STRING" }],
 * });
 * ```
 *
 * ### Updating a Descriptor
 * **Example:** Change the display name and unit
 * ```typescript
 * const metric = yield* GCP.Monitoring.MetricDescriptor("Paid", {
 *   displayName: "Invoice paid (cents)",
 *   unit: "1",
 *   description: "amount collected per invoice in cents",
 * });
 * ```
 *
 * @resource
 * @category Monitoring
 */
export const MetricDescriptor = Resource<MetricDescriptor>(
  "GCP.Monitoring.MetricDescriptor",
);

export class MetricDescriptorNotResolved extends Data.TaggedError(
  "GCP.Monitoring.MetricDescriptorNotResolved",
)<{
  name: string;
}> {}

const METRIC_DESCRIPTORS = "/metricDescriptors/";

const typeOf = (descriptor: monitoring.MetricDescriptor) => {
  if (descriptor.type !== undefined && descriptor.type.length > 0) {
    return descriptor.type;
  }
  const name = descriptor.name ?? "";
  const at = name.indexOf(METRIC_DESCRIPTORS);
  return at >= 0 ? name.slice(at + METRIC_DESCRIPTORS.length) : name;
};

const resourceName = (project: string, type: string) =>
  `projects/${project}/metricDescriptors/${type}`;

const qualifyType = (type: string) =>
  type.includes(".googleapis.com/")
    ? type
    : `${CUSTOM_PREFIX}${type.replace(/^\/+/, "")}`;

const toType = (id: string, type: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (type !== undefined) return qualifyType(type);
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_TYPE_LENGTH,
      lowercase: true,
      delimiter: "_",
    });
    const metricName = generated.replace(/-/g, "_").replace(/_+/g, "_");
    const named = /^[a-z]/.test(metricName) ? metricName : `m_${metricName}`;
    return qualifyType(named);
  });

const toLabels = (
  labels: monitoring.LabelDescriptorList | undefined,
): MetricLabelDescriptor[] =>
  (labels ?? []).flatMap((label) =>
    label.key
      ? [
          {
            key: label.key,
            description: label.description,
            valueType: label.valueType,
          },
        ]
      : [],
  );

const toMetadata = (
  metadata: monitoring.MetricDescriptorMetadata | undefined,
): MetricDescriptorMetadata | undefined => {
  if (metadata === undefined) return undefined;
  return {
    samplePeriod: metadata.samplePeriod,
    ingestDelay: metadata.ingestDelay,
    timeSeriesResourceHierarchyLevel: metadata.timeSeriesResourceHierarchyLevel,
    launchStage: metadata.launchStage,
  };
};

const toAttrs = (descriptor: monitoring.MetricDescriptor, project: string) => {
  const type = typeOf(descriptor);
  const parsed = parseMarker(descriptor.description);
  return {
    name: descriptor.name?.includes(METRIC_DESCRIPTORS)
      ? descriptor.name
      : resourceName(project, type),
    type,
    project,
    metricKind: descriptor.metricKind,
    valueType: descriptor.valueType,
    unit: descriptor.unit,
    displayName: descriptor.displayName,
    description: parsed.rest,
    labels: toLabels(descriptor.labels),
    launchStage: descriptor.launchStage,
    metadata: toMetadata(descriptor.metadata),
    monitoredResourceTypes: descriptor.monitoredResourceTypes ?? [],
  };
};

const canonLabels = (labels: MetricLabelDescriptor[] | undefined) =>
  [...(labels ?? [])]
    .map((label) => ({
      key: label.key ?? "",
      description: label.description ?? "",
      valueType: (label.valueType ?? "STRING").toUpperCase(),
    }))
    .filter((label) => label.key.length > 0)
    .sort((left, right) => left.key.localeCompare(right.key));

const labelsRemoved = (
  observed: MetricLabelDescriptor[],
  desired: MetricLabelDescriptor[] | undefined,
) => {
  if (desired === undefined) return false;
  const next = new Set(canonLabels(desired).map((label) => label.key));
  return canonLabels(observed).some((label) => !next.has(label.key));
};

const toBody = (
  type: string,
  news: MetricDescriptorProps,
  ownership: Record<string, string>,
): monitoring.MetricDescriptor => ({
  type,
  metricKind: news.metricKind ?? DEFAULT_METRIC_KIND,
  valueType: news.valueType ?? DEFAULT_VALUE_TYPE,
  unit: news.unit ?? DEFAULT_UNIT,
  displayName: news.displayName,
  description: encodeDescription(ownership, news.description),
  labels: news.labels as monitoring.LabelDescriptorList | undefined,
  launchStage: news.launchStage,
  metadata: news.metadata as monitoring.MetricDescriptorMetadata | undefined,
});

const getByName = (name: string) =>
  monitoring
    .getProjectsMetricDescriptors({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilSynced = (
  name: string,
  desired: { displayName?: string; description: string },
) =>
  getByName(name).pipe(
    Effect.flatMap((value) => {
      if (value === undefined) {
        return Effect.fail(new MetricDescriptorNotResolved({ name }));
      }
      const displayOk =
        desired.displayName === undefined ||
        (value.displayName ?? "") === desired.displayName;
      const descriptionOk = (value.description ?? "") === desired.description;
      return displayOk && descriptionOk
        ? Effect.succeed(value)
        : Effect.fail(new MetricDescriptorNotResolved({ name }));
    }),
    // Descriptor writes take up to a minute to become readable.
    Effect.retry({
      times: 30,
      schedule: Schedule.spaced("2 seconds"),
      while: (error) =>
        error._tag === "GCP.Monitoring.MetricDescriptorNotResolved",
    }),
  );

const listCustom = (project: string) =>
  monitoring.listProjectsMetricDescriptors
    .pages({
      name: parentOf(project),
      pageSize: 1000,
      filter: `metric.type = starts_with("${CUSTOM_PREFIX}")`,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.metricDescriptors ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as monitoring.MetricDescriptor[]),
      ),
    );

const listOwned = (project: string) =>
  Effect.gen(function* () {
    const descriptors = yield* listCustom(project);
    return descriptors
      .filter((descriptor) => hasOwnershipMarker(descriptor.description))
      .map((descriptor) => toAttrs(descriptor, project));
  });

const findOwned = (project: string, id: string) =>
  Effect.gen(function* () {
    const descriptors = yield* listCustom(project);
    for (const descriptor of descriptors) {
      if (
        yield* hasAlchemyLabels(id, parseMarker(descriptor.description).labels)
      ) {
        return descriptor;
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

export const MetricDescriptorProvider = () =>
  Provider.succeed(MetricDescriptor, {
    stables: ["name", "type", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousType = olds?.type ?? output?.type;
      const typeChanged =
        news.type !== undefined &&
        previousType !== undefined &&
        qualifyType(news.type) !== previousType;

      const previousKind = (
        olds?.metricKind ?? output?.metricKind
      )?.toUpperCase();
      const nextKind = news.metricKind?.toUpperCase();
      const kindChanged =
        nextKind !== undefined &&
        previousKind !== undefined &&
        nextKind !== previousKind;

      const previousValue = (
        olds?.valueType ?? output?.valueType
      )?.toUpperCase();
      const nextValue = news.valueType?.toUpperCase();
      const valueChanged =
        nextValue !== undefined &&
        previousValue !== undefined &&
        nextValue !== previousValue;

      const removed = labelsRemoved(output?.labels ?? [], news.labels);

      if (!typeChanged && !kindChanged && !valueChanged && !removed) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst: !typeChanged,
      };
    }),

    read: Effect.fn(function* ({ id, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* observe(env.project, id, output?.name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(
        id,
        parseMarker(existing.description).labels,
      ))
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
      const type = yield* toType(id, news.type, output?.type);
      const name = resourceName(env.project, type);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredKind = (
        news.metricKind ?? DEFAULT_METRIC_KIND
      ).toUpperCase();
      const desiredValue = (news.valueType ?? DEFAULT_VALUE_TYPE).toUpperCase();
      const desiredUnit = news.unit ?? DEFAULT_UNIT;

      let current = yield* observe(env.project, id, output?.name ?? name);

      const upsert = () =>
        monitoring
          .createProjectsMetricDescriptors({
            name: parentOf(env.project),
            body: toBody(type, news, ownership),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));

      if (current === undefined) {
        current = (yield* upsert()) ?? undefined;
      }

      if (current === undefined) {
        return yield* new MetricDescriptorNotResolved({ name });
      }

      const observedLabels = toLabels(current.labels);
      const needsUpdate =
        (current.displayName ?? "") !== (news.displayName ?? "") ||
        (current.description ?? "") !== desiredDescription ||
        (current.unit ?? DEFAULT_UNIT) !== desiredUnit ||
        (current.metricKind ?? "").toUpperCase() !== desiredKind ||
        (current.valueType ?? "").toUpperCase() !== desiredValue ||
        (news.launchStage !== undefined &&
          (current.launchStage ?? "") !== news.launchStage) ||
        (news.metadata !== undefined &&
          !jsonEqual(toMetadata(current.metadata) ?? null, news.metadata)) ||
        (news.labels !== undefined &&
          !jsonEqual(canonLabels(observedLabels), canonLabels(news.labels)));

      if (needsUpdate) {
        current = (yield* upsert()) ?? current;
      }

      const latest = yield* waitUntilSynced(
        current.name?.includes(METRIC_DESCRIPTORS) ? current.name : name,
        {
          displayName: news.displayName,
          description: desiredDescription,
        },
      );
      return toAttrs(latest, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* monitoring
        .deleteProjectsMetricDescriptors({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

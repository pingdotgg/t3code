import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitZoneOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_ZONE = "us-central1-a";
const DEFAULT_COOL_DOWN_SEC = 60;
const DEFAULT_MIN_REPLICAS = 0;
const DEFAULT_MODE = "ON";
const DEFAULT_CPU_TARGET = 0.6;
const MAX_NAME_LENGTH = 63;

export type AutoscalingPolicyCpuUtilizationProps = {
  /**
   * Target average CPU utilization in `(0, 1]`.
   * @default 0.6
   */
  utilizationTarget?: number;
  /**
   * Predictive CPU scaling (`NONE` or `OPTIMIZE_AVAILABILITY`).
   * @default "NONE"
   */
  predictiveMethod?: "NONE" | "OPTIMIZE_AVAILABILITY" | (string & {});
};

export type AutoscalingPolicyLoadBalancingUtilizationProps = {
  /**
   * Target backend-capacity utilization as a fraction.
   * @default 0.8
   */
  utilizationTarget?: number;
};

export type AutoscalingPolicyCustomMetricUtilizationProps = {
  /** Stackdriver metric type (INT64 or DOUBLE, non-negative). */
  metric?: string;
  /** Monitoring filter selecting the TimeSeries to scale on. */
  filter?: string;
  /** Target value of the metric. */
  utilizationTarget?: number;
  /** How the target is expressed (`GAUGE`, `DELTA_PER_SECOND`, `DELTA_PER_MINUTE`). */
  utilizationTargetType?: "DELTA_PER_MINUTE" | "DELTA_PER_SECOND" | "GAUGE";
  /** Per-instance share of a per-group metric. */
  singleInstanceAssignment?: number;
};

export type AutoscalingPolicyScaleInControlProps = {
  /** Max replicas that may be removed in one scale-in step. */
  maxScaledInReplicas?: {
    /** Absolute replica count. */
    fixed?: number;
    /** Percentage of current size (`0`–`100`). */
    percent?: number;
  };
  /** Lookback window in seconds for scale-in recommendations. */
  timeWindowSec?: number;
};

export type AutoscalingPolicyScalingScheduleProps = {
  /** Extended cron expression for when this schedule is active. */
  schedule?: string;
  /** Duration of each run, in seconds (minimum `300`). */
  durationSec?: number;
  /** Minimum replicas while this schedule is active. */
  minRequiredReplicas?: number;
  /** IANA time zone (e.g. `America/Los_Angeles`). @default "UTC" */
  timeZone?: string;
  /** Optional description. */
  description?: string;
  /** When true, the schedule is ignored. @default false */
  disabled?: boolean;
};

export type AutoscalingPolicyProps = {
  /**
   * Maximum number of instances the autoscaler may scale out to. Required.
   */
  maxNumReplicas: number;
  /**
   * Minimum number of instances the autoscaler may scale in to.
   * @default 0
   */
  minNumReplicas?: number;
  /**
   * Initialization period in seconds before metrics are trusted.
   * @default 60
   */
  coolDownPeriodSec?: number;
  /**
   * Stabilization period in seconds before scale-in.
   */
  stabilizationPeriodSec?: number;
  /**
   * Operating mode.
   * @default "ON"
   */
  mode?: "OFF" | "ON" | "ONLY_SCALE_OUT" | "ONLY_UP" | (string & {});
  /**
   * CPU utilization signal. When no signal is set, GCP defaults to
   * CPU `0.6`.
   */
  cpuUtilization?: AutoscalingPolicyCpuUtilizationProps;
  /** Load-balancing utilization signal. */
  loadBalancingUtilization?: AutoscalingPolicyLoadBalancingUtilizationProps;
  /** Custom Cloud Monitoring metric signals. */
  customMetricUtilizations?: AutoscalingPolicyCustomMetricUtilizationProps[];
  /** Throttle abrupt scale-in. */
  scaleInControl?: AutoscalingPolicyScaleInControlProps;
  /** Named scaling schedules (up to 128). */
  scalingSchedules?: Record<string, AutoscalingPolicyScalingScheduleProps>;
};

export type AutoscalerProps = {
  /**
   * Autoscaler name (RFC1035, 1-63 characters). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Changing the name
   * replaces the autoscaler.
   */
  autoscalerName?: string;
  /**
   * Zone of the managed instance group (e.g. `us-central1-a`). Immutable —
   * changing it replaces the autoscaler.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * URL or name of the zonal managed instance group to scale
   * (`projects/{project}/zones/{zone}/instanceGroupManagers/{name}`).
   */
  target: string;
  /**
   * Optional description. Compute autoscalers have no labels field, so
   * Alchemy ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`)
   * and user labels are stored in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * User labels. Encoded into the description marker alongside Alchemy
   * ownership labels (the API has no `labels` field).
   */
  labels?: Record<string, string>;
  /**
   * Autoscaling policy. `maxNumReplicas` is required; other fields take
   * GCP defaults when omitted.
   */
  autoscalingPolicy: AutoscalingPolicyProps;
};

export type Autoscaler = Resource<
  "GCP.Compute.Autoscaler",
  AutoscalerProps,
  {
    /** Autoscaler name. */
    autoscalerName: string;
    /** Server-assigned numeric id. */
    autoscalerId: string | undefined;
    /** Project id. */
    project: string;
    /** Zone short name (`us-central1-a`). */
    zone: string;
    /** Target managed instance group URL. */
    target: string;
    /** User-facing description (ownership marker stripped). */
    description: string | undefined;
    /** User labels decoded from the description marker. */
    labels: Record<string, string>;
    /** Autoscaling policy currently applied. */
    autoscalingPolicy: compute.AutoscalingPolicy | undefined;
    /** Server-reported status (`PENDING`, `ACTIVE`, `ERROR`, `DELETING`). */
    status: string | undefined;
    /** Human-readable status details. */
    statusDetails: ReadonlyArray<compute.AutoscalerStatusDetails>;
    /** Recommended MIG size, if the autoscaler has produced one. */
    recommendedSize: number | undefined;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal Compute Engine autoscaler for a managed instance group.
 *
 * Changing `autoscalerName` or `zone` replaces the autoscaler. Policy,
 * target, description, and labels update in place via `autoscalers.patch`.
 * Compute Engine has no labels on this resource, so Alchemy stamps
 * ownership into the description (`[alchemy alchemy-stack=…
 * alchemy-stage=… alchemy-id=…]`) so `list` / `pnpm nuke:gcp` can find
 * them.
 *
 * ### Creating an Autoscaler
 * **Example:** CPU policy with generated name
 * ```typescript
 * const scaler = yield* GCP.Compute.Autoscaler("Web", {
 *   target: mig.selfLink,
 *   autoscalingPolicy: {
 *     minNumReplicas: 1,
 *     maxNumReplicas: 5,
 *     coolDownPeriodSec: 60,
 *     cpuUtilization: { utilizationTarget: 0.6 },
 *   },
 * });
 * ```
 *
 * **Example:** Named autoscaler, labels, and OFF mode
 * ```typescript
 * const scaler = yield* GCP.Compute.Autoscaler("Web", {
 *   autoscalerName: "web-scaler",
 *   zone: "us-central1-a",
 *   target: "web-mig",
 *   description: "scale the web MIG",
 *   labels: { env: "prod" },
 *   autoscalingPolicy: {
 *     minNumReplicas: 0,
 *     maxNumReplicas: 3,
 *     mode: "OFF",
 *     cpuUtilization: { utilizationTarget: 0.5 },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const Autoscaler = Resource<Autoscaler>("GCP.Compute.Autoscaler");

export class AutoscalerNotResolved extends Data.TaggedError(
  "GCP.Compute.AutoscalerNotResolved",
)<{
  autoscalerName: string;
  zone: string;
}> {}

export class AutoscalerStillExists extends Data.TaggedError(
  "GCP.Compute.AutoscalerStillExists",
)<{
  autoscalerName: string;
  zone: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? value;
};

const rfc1035Name = (name: string) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) {
    next = `a${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  return next.length > 0 ? next : "autoscaler";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return rfc1035Name(
      name ??
        existing ??
        (yield* createPhysicalName({
          id,
          maxLength: MAX_NAME_LENGTH,
          lowercase: true,
        })),
    );
  });

const toTargetUrl = (project: string, zone: string, target: string) =>
  target.includes("/")
    ? target
    : `projects/${project}/zones/${zone}/instanceGroupManagers/${target}`;

const encodeDescription = (
  user: string | undefined,
  labels: Record<string, string>,
): string => {
  const packed = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const marker = `[alchemy ${packed}]`;
  const trimmed = user?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

const parseDescription = (
  description: string | undefined,
): { labels: Record<string, string>; user: string | undefined } => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, user: description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, user: description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description
    .slice(end + 1)
    .replace(/^\n/, "")
    .trim();
  return {
    labels,
    user: rest.length > 0 ? rest : undefined,
  };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (autoscaler: compute.Autoscaler, project: string) => {
  const decoded = parseDescription(autoscaler.description);
  return {
    autoscalerName: autoscaler.name ?? lastSegment(autoscaler.selfLink),
    autoscalerId: autoscaler.id,
    project,
    zone: lastSegment(autoscaler.zone) || DEFAULT_ZONE,
    target: autoscaler.target ?? "",
    description: decoded.user,
    labels: userLabels(decoded.labels),
    autoscalingPolicy: autoscaler.autoscalingPolicy,
    status: autoscaler.status,
    statusDetails: autoscaler.statusDetails ?? [],
    recommendedSize: autoscaler.recommendedSize,
    selfLink: autoscaler.selfLink,
    creationTimestamp: autoscaler.creationTimestamp,
  };
};

const hasSignal = (policy: AutoscalingPolicyProps) =>
  policy.cpuUtilization !== undefined ||
  policy.loadBalancingUtilization !== undefined ||
  (policy.customMetricUtilizations?.length ?? 0) > 0;

const desiredPolicy = (
  policy: AutoscalingPolicyProps,
): compute.AutoscalingPolicy => ({
  maxNumReplicas: policy.maxNumReplicas,
  minNumReplicas: policy.minNumReplicas ?? DEFAULT_MIN_REPLICAS,
  coolDownPeriodSec: policy.coolDownPeriodSec ?? DEFAULT_COOL_DOWN_SEC,
  stabilizationPeriodSec: policy.stabilizationPeriodSec,
  mode: policy.mode ?? DEFAULT_MODE,
  cpuUtilization:
    policy.cpuUtilization ??
    (hasSignal(policy) ? undefined : { utilizationTarget: DEFAULT_CPU_TARGET }),
  loadBalancingUtilization: policy.loadBalancingUtilization,
  customMetricUtilizations: policy.customMetricUtilizations,
  scaleInControl: policy.scaleInControl,
  scalingSchedules: policy.scalingSchedules,
});

const sortedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortedValue(entry)]),
    );
  }
  return value;
};

const canonCpu = (cpu: compute.AutoscalingPolicyCpuUtilization | undefined) => {
  if (cpu === undefined) return undefined;
  const predictive =
    cpu.predictiveMethod === undefined || cpu.predictiveMethod === "NONE"
      ? undefined
      : cpu.predictiveMethod;
  return {
    utilizationTarget: cpu.utilizationTarget,
    predictiveMethod: predictive,
  };
};

const canonPolicy = (policy: compute.AutoscalingPolicy | undefined) => {
  if (policy === undefined) return undefined;
  return sortedValue({
    maxNumReplicas: policy.maxNumReplicas,
    minNumReplicas: policy.minNumReplicas ?? DEFAULT_MIN_REPLICAS,
    coolDownPeriodSec: policy.coolDownPeriodSec ?? DEFAULT_COOL_DOWN_SEC,
    stabilizationPeriodSec: policy.stabilizationPeriodSec,
    mode: policy.mode ?? DEFAULT_MODE,
    cpuUtilization: canonCpu(policy.cpuUtilization),
    loadBalancingUtilization: policy.loadBalancingUtilization
      ? { utilizationTarget: policy.loadBalancingUtilization.utilizationTarget }
      : undefined,
    customMetricUtilizations: (policy.customMetricUtilizations ?? []).map(
      (metric) => ({
        metric: metric.metric,
        filter: metric.filter,
        utilizationTarget: metric.utilizationTarget,
        utilizationTargetType: metric.utilizationTargetType,
        singleInstanceAssignment: metric.singleInstanceAssignment,
      }),
    ),
    scaleInControl: policy.scaleInControl
      ? {
          maxScaledInReplicas: policy.scaleInControl.maxScaledInReplicas
            ? {
                fixed: policy.scaleInControl.maxScaledInReplicas.fixed,
                percent: policy.scaleInControl.maxScaledInReplicas.percent,
              }
            : undefined,
          timeWindowSec: policy.scaleInControl.timeWindowSec,
        }
      : undefined,
    scalingSchedules: policy.scalingSchedules,
  });
};

const samePolicy = (
  observed: compute.AutoscalingPolicy | undefined,
  desired: compute.AutoscalingPolicy,
) =>
  JSON.stringify(canonPolicy(observed)) ===
  JSON.stringify(canonPolicy(desired));

const getByName = (project: string, zone: string, autoscaler: string) =>
  compute
    .getAutoscalers({ project, zone, autoscaler })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitPresent = (project: string, zone: string, autoscalerName: string) =>
  getByName(project, zone, autoscalerName).pipe(
    Effect.flatMap((autoscaler) =>
      autoscaler === undefined
        ? Effect.fail(new AutoscalerNotResolved({ autoscalerName, zone }))
        : Effect.succeed(autoscaler),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.AutoscalerNotResolved",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
    Effect.catchTag("GCP.Compute.AutoscalerNotResolved", () =>
      Effect.succeed(undefined),
    ),
  );

const waitGone = (project: string, zone: string, autoscalerName: string) =>
  getByName(project, zone, autoscalerName).pipe(
    Effect.flatMap((autoscaler) =>
      autoscaler === undefined
        ? Effect.void
        : Effect.fail(new AutoscalerStillExists({ autoscalerName, zone })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.AutoscalerStillExists",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const AutoscalerProvider = () =>
  Provider.succeed(Autoscaler, {
    stables: [
      "autoscalerName",
      "autoscalerId",
      "project",
      "zone",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.autoscalerName ?? output?.autoscalerName;
      const nextName = news.autoscalerName ?? previousName;
      const previousZone = lastSegment(olds?.zone ?? output?.zone);
      const nextZone = lastSegment(news.zone ?? DEFAULT_ZONE);
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const zoneChanged = previousZone.length > 0 && previousZone !== nextZone;
      if (!nameChanged && !zoneChanged) {
        return undefined;
      }
      return {
        action: "replace" as const,
        // A MIG can only have one autoscaler; always delete the old row first.
        deleteFirst: true,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const autoscalerName = yield* toName(
        id,
        olds?.autoscalerName,
        output?.autoscalerName,
      );
      const zone = lastSegment(olds?.zone ?? output?.zone ?? DEFAULT_ZONE);
      const existing = yield* getByName(env.project, zone, autoscalerName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListAutoscalers
          .pages({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.autoscalers ?? [])
              .filter(
                (autoscaler) =>
                  (autoscaler.zone ?? "").length > 0 &&
                  hasOwnershipMarker(autoscaler.description),
              )
              .map((autoscaler) => toAttrs(autoscaler, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const autoscalerName = yield* toName(
        id,
        news.autoscalerName,
        output?.autoscalerName,
      );
      const zone = lastSegment(news.zone ?? output?.zone ?? DEFAULT_ZONE);
      const target = toTargetUrl(env.project, zone, news.target);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const description = encodeDescription(news.description, desiredLabels);
      const policy = desiredPolicy(news.autoscalingPolicy);

      let current = yield* getByName(env.project, zone, autoscalerName);

      if (current === undefined) {
        yield* compute
          .insertAutoscalers({
            project: env.project,
            zone,
            body: {
              name: autoscalerName,
              target,
              description,
              autoscalingPolicy: policy,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
            Effect.flatMap((operation) =>
              operation === undefined
                ? Effect.void
                : waitZoneOperation(env.project, zone, operation, {
                    ignore: ["RESOURCE_ALREADY_EXISTS"],
                  }).pipe(Effect.asVoid),
            ),
          );
        current = yield* waitPresent(env.project, zone, autoscalerName);
      }

      if (current === undefined) {
        return yield* new AutoscalerNotResolved({ autoscalerName, zone });
      }

      const descriptionChanged = (current.description ?? "") !== description;
      const policyChanged = !samePolicy(current.autoscalingPolicy, policy);
      const targetChanged =
        lastSegment(current.target) !== lastSegment(target) &&
        (current.target ?? "") !== target;

      if (descriptionChanged || policyChanged || targetChanged) {
        yield* compute
          .patchAutoscalers({
            project: env.project,
            zone,
            autoscaler: autoscalerName,
            body: {
              name: autoscalerName,
              target,
              description,
              autoscalingPolicy: policy,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitZoneOperation(env.project, zone, operation),
            ),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );
        current =
          (yield* getByName(env.project, zone, autoscalerName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* compute
        .deleteAutoscalers({
          project: output.project,
          zone: output.zone,
          autoscaler: output.autoscalerName,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.flatMap((operation) =>
            operation === undefined
              ? Effect.void
              : waitZoneOperation(output.project, output.zone, operation, {
                  ignore: ["RESOURCE_NOT_FOUND"],
                }).pipe(Effect.asVoid),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 5,
            schedule: Schedule.spaced("1 second"),
          }),
        );
      yield* waitGone(output.project, output.zone, output.autoscalerName);
    }),
  });

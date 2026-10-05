import * as monitoring from "@distilled.cloud/gcp/monitoring_v3";
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
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  jsonEqual,
  lastSegment,
  parentOf,
  toEmptyObject,
} from "./ownership.ts";

const MAX_SLO_ID_LENGTH = 63;
const DEFAULT_ROLLING_PERIOD = "86400s";

export type LatencyCriteria = {
  /** Requests at or below this latency count as good. */
  threshold?: string;
};

export type BasicSli = {
  /** Locations this SLI applies to. Omitted means all. */
  location?: string[];
  /** Availability SLI (successful request count). */
  availability?: Record<string, never>;
  /** Latency SLI against `threshold`. */
  latency?: LatencyCriteria;
  /** RPC methods this SLI applies to. Omitted means all. */
  method?: string[];
  /** API versions this SLI applies to. Omitted means all. */
  version?: string[];
};

export type ValueRange = {
  /** Inclusive maximum. Omit (or use Infinity) for an open upper bound. */
  max?: number;
  /** Inclusive minimum. Omit (or use -Infinity) for an open lower bound. */
  min?: number;
};

export type MetricRange = {
  /** Range of values considered good. */
  range?: ValueRange;
  /** Monitoring filter selecting a GAUGE INT64 or DOUBLE time series. */
  timeSeries?: string;
};

export type DistributionCut = {
  /** Range of distribution bucket values considered good. */
  range?: ValueRange;
  /**
   * Monitoring filter selecting a DISTRIBUTION DELTA or CUMULATIVE
   * time series.
   */
  distributionFilter?: string;
};

export type TimeSeriesRatio = {
  /** Filter quantifying good service. */
  goodServiceFilter?: string;
  /** Filter quantifying bad service. */
  badServiceFilter?: string;
  /** Filter quantifying total demanded service. */
  totalServiceFilter?: string;
};

export type RequestBasedSli = {
  /** Good service is the count of distribution values in `range`. */
  distributionCut?: DistributionCut;
  /** Good / total ratio from a pair of time series. */
  goodTotalRatio?: TimeSeriesRatio;
};

export type PerformanceThreshold = {
  /** Window is good when performance is at least this fraction. */
  threshold?: number;
  /** Request-based SLI used to judge the window. */
  performance?: RequestBasedSli;
  /** Basic SLI used to judge the window. */
  basicSliPerformance?: BasicSli;
};

export type WindowsBasedSli = {
  /**
   * Window duration. Must be an integer fraction of a day and at least
   * 60s.
   */
  windowPeriod?: string;
  /** Window is good when the summed metric is in `range`. */
  metricSumInRange?: MetricRange;
  /** BOOL time series; the window is good if any true value appears. */
  goodBadMetricFilter?: string;
  /** Window is good when performance is above `threshold`. */
  goodTotalRatioThreshold?: PerformanceThreshold;
  /** Window is good when the mean metric is in `range`. */
  metricMeanInRange?: MetricRange;
};

export type ServiceLevelIndicator = {
  /** Basic SLI on a well-known service type. */
  basicSli?: BasicSli;
  /** Windows-based SLI. */
  windowsBased?: WindowsBasedSli;
  /** Request-based SLI. */
  requestBased?: RequestBasedSli;
};

export type CalendarPeriod =
  | "DAY"
  | "WEEK"
  | "FORTNIGHT"
  | "MONTH"
  | (string & {});

export type ServicesServiceLevelObjectiveProps = {
  /**
   * Parent service resource name
   * (`projects/{project}/services/{service}`) or service id. Immutable
   * — changing it replaces the SLO.
   */
  service: string;
  /**
   * SLO id (the last path segment). If omitted, a unique id is
   * generated from the stack, stage, and logical id. Must match
   * `[a-zA-Z0-9-_:.]`. Immutable — changing it replaces the SLO.
   */
  serviceLevelObjectiveId?: string;
  /**
   * Human-readable display name. If omitted, the SLO id is used.
   */
  displayName?: string;
  /**
   * Fraction of service that must be good (`0 < goal <= 0.9999`).
   */
  goal: number;
  /**
   * Rolling window (for example `"86400s"`). Mutually exclusive with
   * `calendarPeriod`. Defaults to `"86400s"` when neither is set.
   */
  rollingPeriod?: string;
  /**
   * Calendar period (`DAY`, `WEEK`, `FORTNIGHT`, `MONTH`). Mutually
   * exclusive with `rollingPeriod`.
   */
  calendarPeriod?: CalendarPeriod;
  /**
   * Service-level indicator defining good service.
   */
  serviceLevelIndicator: ServiceLevelIndicator;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ServicesServiceLevelObjective = Resource<
  "GCP.Monitoring.ServicesServiceLevelObjective",
  ServicesServiceLevelObjectiveProps,
  {
    /** Full resource name `projects/{project}/services/{service}/serviceLevelObjectives/{slo}`. */
    name: string;
    /** SLO id (last path segment). */
    serviceLevelObjectiveId: string;
    /** Parent service resource name. */
    service: string;
    /** Parent service id. */
    serviceId: string;
    /** Project id. */
    project: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** Target good-service fraction. */
    goal: number;
    /** Rolling window, if this SLO is rolling. */
    rollingPeriod: string | undefined;
    /** Calendar period, if this SLO is calendar-based. */
    calendarPeriod: string | undefined;
    /** Service-level indicator. */
    serviceLevelIndicator: ServiceLevelIndicator | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Cloud Monitoring service-level objective under a Monitoring
 * Service.
 *
 * Alchemy stamps ownership into `userLabels` so `list` /
 * `pnpm nuke:gcp` can find them. Changing `service` or
 * `serviceLevelObjectiveId` replaces the SLO. Goal, period, SLI,
 * display name, and labels update in place.
 *
 * ### Creating an SLO
 * **Example:** Rolling request-latency SLO on a custom service
 * ```typescript
 * const checkout = yield* GCP.Monitoring.Service("Checkout", {});
 * const slo = yield* GCP.Monitoring.ServicesServiceLevelObjective(
 *   "Latency",
 *   {
 *     service: checkout.name,
 *     goal: 0.99,
 *     rollingPeriod: "86400s",
 *     serviceLevelIndicator: {
 *       requestBased: {
 *         distributionCut: {
 *           distributionFilter:
 *             'metric.type="serviceruntime.googleapis.com/api/request_latencies" AND resource.type="consumed_api"',
 *           range: { max: 500 },
 *         },
 *       },
 *     },
 *   },
 * );
 * ```
 *
 * ### Updating an SLO
 * **Example:** Lower the goal and switch to a calendar month
 * ```typescript
 * const slo = yield* GCP.Monitoring.ServicesServiceLevelObjective(
 *   "Latency",
 *   {
 *     service: checkout.name,
 *     goal: 0.95,
 *     calendarPeriod: "MONTH",
 *     serviceLevelIndicator: {
 *       requestBased: {
 *         distributionCut: {
 *           distributionFilter:
 *             'metric.type="serviceruntime.googleapis.com/api/request_latencies" AND resource.type="consumed_api"',
 *           range: { max: 500 },
 *         },
 *       },
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category Monitoring
 */
export const ServicesServiceLevelObjective =
  Resource<ServicesServiceLevelObjective>(
    "GCP.Monitoring.ServicesServiceLevelObjective",
  );

export class ServicesServiceLevelObjectiveNotResolved extends Data.TaggedError(
  "GCP.Monitoring.ServicesServiceLevelObjectiveNotResolved",
)<{
  name: string;
}> {}

const SERVICES = "/services/";

const parseSloName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const projectsAt = parts.lastIndexOf("projects");
  const servicesAt = parts.lastIndexOf("services");
  const slosAt = parts.lastIndexOf("serviceLevelObjectives");
  const project =
    projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "";
  const serviceId =
    servicesAt >= 0 && parts[servicesAt + 1] ? parts[servicesAt + 1]! : "";
  const service =
    servicesAt >= 0 ? parts.slice(0, servicesAt + 2).join("/") : "";
  const serviceLevelObjectiveId =
    slosAt >= 0 && parts[slosAt + 1] ? parts[slosAt + 1]! : lastSegment(name);
  return { project, service, serviceId, serviceLevelObjectiveId };
};

const resolveService = (project: string, service: string) => {
  if (service.includes("/")) return service;
  return `${parentOf(project)}/services/${service}`;
};

const resourceName = (service: string, sloId: string) =>
  `${service}/serviceLevelObjectives/${sloId}`;

const userFacingLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, sloId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (sloId !== undefined) return sloId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_SLO_ID_LENGTH,
      lowercase: true,
    });
    return generated.replace(/-+$/g, "").slice(0, MAX_SLO_ID_LENGTH);
  });

const toBasicSli = (
  sli: monitoring.BasicSli | undefined,
): BasicSli | undefined => {
  if (sli === undefined) return undefined;
  return {
    location: sli.location,
    availability: toEmptyObject(sli.availability),
    latency: sli.latency,
    method: sli.method,
    version: sli.version,
  };
};

const toPerformanceThreshold = (
  value: monitoring.PerformanceThreshold | undefined,
): PerformanceThreshold | undefined => {
  if (value === undefined) return undefined;
  return {
    threshold: value.threshold,
    performance: value.performance,
    basicSliPerformance: toBasicSli(value.basicSliPerformance),
  };
};

const toWindowsBasedSli = (
  sli: monitoring.WindowsBasedSli | undefined,
): WindowsBasedSli | undefined => {
  if (sli === undefined) return undefined;
  return {
    windowPeriod: sli.windowPeriod,
    metricSumInRange: sli.metricSumInRange,
    goodBadMetricFilter: sli.goodBadMetricFilter,
    goodTotalRatioThreshold: toPerformanceThreshold(
      sli.goodTotalRatioThreshold,
    ),
    metricMeanInRange: sli.metricMeanInRange,
  };
};

const toSli = (
  sli: monitoring.ServiceLevelIndicator | undefined,
): ServiceLevelIndicator | undefined => {
  if (sli === undefined) return undefined;
  return {
    basicSli: toBasicSli(sli.basicSli),
    windowsBased: toWindowsBasedSli(sli.windowsBased),
    requestBased: sli.requestBased,
  };
};

const toAttrs = (slo: monitoring.ServiceLevelObjective, project: string) => {
  const name = slo.name ?? "";
  const parsed = parseSloName(name);
  return {
    name,
    serviceLevelObjectiveId: parsed.serviceLevelObjectiveId,
    service: parsed.service,
    serviceId: parsed.serviceId,
    project: parsed.project || project,
    displayName: slo.displayName,
    goal: slo.goal ?? 0,
    rollingPeriod: slo.rollingPeriod,
    calendarPeriod: slo.calendarPeriod,
    serviceLevelIndicator: toSli(slo.serviceLevelIndicator),
    labels: userFacingLabels(slo.userLabels),
  };
};

const periodBody = (
  news: ServicesServiceLevelObjectiveProps,
): Pick<
  monitoring.ServiceLevelObjective,
  "rollingPeriod" | "calendarPeriod"
> =>
  news.calendarPeriod !== undefined
    ? { calendarPeriod: news.calendarPeriod }
    : { rollingPeriod: news.rollingPeriod ?? DEFAULT_ROLLING_PERIOD };

const toBody = (
  news: ServicesServiceLevelObjectiveProps,
  displayName: string,
  desiredLabels: Record<string, string>,
): monitoring.ServiceLevelObjective => ({
  displayName,
  goal: news.goal,
  ...periodBody(news),
  serviceLevelIndicator: news.serviceLevelIndicator as
    | monitoring.ServiceLevelIndicator
    | undefined,
  userLabels: desiredLabels,
});

const getByName = (name: string) =>
  monitoring
    .getServicesServiceLevelObjectives({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listSlos = (parent: string) =>
  monitoring.listServicesServiceLevelObjectives
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.serviceLevelObjectives ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as monitoring.ServiceLevelObjective[]),
      ),
    );

const listServices = (project: string) =>
  monitoring.listServices
    .pages({
      parent: parentOf(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.services ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const listOwned = (project: string) =>
  Effect.gen(function* () {
    const services = yield* monitoring.listServices
      .pages({
        parent: parentOf(project),
        pageSize: 1000,
        filter: 'identifier_case = "CUSTOM"',
      })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.services ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      );
    const nested = yield* Effect.forEach(
      services,
      (service) =>
        service.name !== undefined
          ? listSlos(service.name)
          : Effect.succeed([] as monitoring.ServiceLevelObjective[]),
      { concurrency: 5 },
    );
    return nested
      .flat()
      .filter((slo) =>
        Object.keys(slo.userLabels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      )
      .map((slo) => toAttrs(slo, project));
  });

const findOwned = (project: string, id: string, service: string | undefined) =>
  Effect.gen(function* () {
    const parents =
      service !== undefined
        ? [service]
        : (yield* listServices(project)).flatMap((item) =>
            item.name !== undefined ? [item.name] : [],
          );
    for (const parent of parents) {
      const slos = yield* listSlos(parent);
      for (const slo of slos) {
        if (yield* hasAlchemyLabels(id, tagRecord(slo.userLabels))) {
          return slo;
        }
      }
    }
    return undefined;
  });

const observe = (
  project: string,
  id: string,
  name: string | undefined,
  service: string | undefined,
) =>
  Effect.gen(function* () {
    if (name !== undefined) {
      const existing = yield* getByName(name);
      if (existing !== undefined) return existing;
    }
    return yield* findOwned(project, id, service);
  });

export const ServicesServiceLevelObjectiveProvider = () =>
  Provider.succeed(ServicesServiceLevelObjective, {
    stables: [
      "name",
      "serviceLevelObjectiveId",
      "service",
      "serviceId",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.serviceLevelObjectiveId ?? output?.serviceLevelObjectiveId;
      const idChanged =
        news.serviceLevelObjectiveId !== undefined &&
        previousId !== undefined &&
        news.serviceLevelObjectiveId !== previousId;
      const previousService = olds?.service ?? output?.service;
      const nextService = news.service;
      const serviceChanged =
        previousService !== undefined &&
        nextService !== previousService &&
        !previousService.endsWith(`/${nextService}`) &&
        !nextService.endsWith(
          `/${previousService.split(SERVICES).pop() ?? ""}`,
        );
      if (!idChanged && !serviceChanged) return undefined;
      return {
        action: "replace" as const,
        deleteFirst: !idChanged,
      };
    }),

    read: Effect.fn(function* ({ id, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* observe(
        env.project,
        id,
        output?.name,
        output?.service,
      );
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
      const service = resolveService(env.project, news.service);
      const sloId = yield* toId(
        id,
        news.serviceLevelObjectiveId,
        output?.serviceLevelObjectiveId,
      );
      const name = resourceName(service, sloId);
      const displayName = news.displayName ?? sloId;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredPeriod = periodBody(news);

      let current = yield* observe(
        env.project,
        id,
        output?.name ?? name,
        service,
      );

      const body = toBody(news, displayName, desiredLabels);

      if (current === undefined) {
        const created = yield* monitoring
          .createServicesServiceLevelObjectives({
            parent: service,
            serviceLevelObjectiveId: sloId,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByName(name).pipe(
                Effect.flatMap((existing) =>
                  existing !== undefined
                    ? Effect.succeed(existing)
                    : findOwned(env.project, id, service),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ServicesServiceLevelObjectiveNotResolved({ name });
      }

      const resource = current.name ?? name;
      const observedLabels = tagRecord(current.userLabels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const goalChanged = (current.goal ?? 0) !== news.goal;
      const rollingChanged =
        (current.rollingPeriod ?? "") !== (desiredPeriod.rollingPeriod ?? "");
      const calendarChanged =
        (current.calendarPeriod ?? "") !== (desiredPeriod.calendarPeriod ?? "");
      const sliChanged = !jsonEqual(
        toSli(current.serviceLevelIndicator) ?? null,
        news.serviceLevelIndicator,
      );

      const updateMask = [
        displayNameChanged ? "display_name" : undefined,
        labelsChanged ? "user_labels" : undefined,
        goalChanged ? "goal" : undefined,
        rollingChanged ? "rolling_period" : undefined,
        calendarChanged ? "calendar_period" : undefined,
        sliChanged ? "service_level_indicator" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* monitoring.patchServicesServiceLevelObjectives({
          name: resource,
          updateMask: updateMask.join(","),
          body: {
            ...body,
            name: resource,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* monitoring
        .deleteServicesServiceLevelObjectives({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

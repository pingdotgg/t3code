import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  AiPlatformNotResolved,
  AiPlatformStillExists,
  collectPages,
  encodeDisplayName,
  hasDisplayNameOwnership,
  jsonEqual,
  locationParent,
  normalizeLocation,
  ownedById,
  parseDisplayName,
  parseResourceName,
} from "./shared.ts";

const COLLECTION = "onlineEvaluators";

export type OnlineEvaluatorRandomSampling = {
  /** Percentage of traces to sample (`1`–`100`). */
  percentage?: number;
};

export type OnlineEvaluatorConfig = {
  /** Random sampling method. */
  randomSampling?: OnlineEvaluatorRandomSampling;
  /** Max evaluations per 10-minute run (`"0"` is unbounded). */
  maxEvaluatedSamplesPerRun?: string;
};

export type MetricSource = {
  /** Registered metric resource name. */
  metricResourceName?: string;
};

export type CloudObservability = {
  /** OpenTelemetry semantic convention version (e.g. `"1.39.0"`). */
  openTelemetry?: { semconvVersion?: string };
  /** Log view used to query logs. */
  logView?: string;
  /** Trace view used to query traces. */
  traceView?: string;
};

export type OnlineEvaluatorProps = {
  /**
   * Vertex AI location. Immutable — changing it replaces the evaluator.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable name (max 63 characters). OnlineEvaluator has no
   * labels field, so Alchemy ownership is stored in a compact `[alc …]`
   * displayName prefix for `list` / nuke.
   */
  displayName?: string;
  /**
   * Agent resource the evaluator scores. Immutable.
   */
  agentResource: string;
  /**
   * Metric sources (max 25). At least one is required.
   */
  metricSources: MetricSource[];
  /**
   * Sampling configuration. Defaults to 10% random sampling.
   */
  config?: OnlineEvaluatorConfig;
  /**
   * Cloud Observability (Trace / Logging) data source.
   */
  cloudObservability?: CloudObservability;
};

export type OnlineEvaluator = Resource<
  "GCP.AIPlatform.OnlineEvaluator",
  OnlineEvaluatorProps,
  {
    /** Full resource name. */
    name: string;
    /** Evaluator id (last path segment). */
    onlineEvaluatorId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Agent resource being evaluated. */
    agentResource: string | undefined;
    /** Server-reported state (`ACTIVE`, `SUSPENDED`, `FAILED`, …). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Online Evaluator — periodically scores agent traces against
 * registered metrics.
 *
 * OnlineEvaluator has no labels, so Alchemy stamps ownership into the
 * display name. Changing `location` or `agentResource` replaces the
 * evaluator. Display name, config, and metric sources update in place.
 *
 * ### Creating an Online Evaluator
 * **Example:** Sample 10% of traces
 * ```typescript
 * const evaluator = yield* GCP.AIPlatform.OnlineEvaluator("Quality", {
 *   agentResource: engine.name,
 *   metricSources: [{ metricResourceName: metric.name }],
 *   config: { randomSampling: { percentage: 10 } },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const OnlineEvaluator = Resource<OnlineEvaluator>(
  "GCP.AIPlatform.OnlineEvaluator",
);

export class OnlineEvaluatorNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.OnlineEvaluatorNotResolved",
)<{
  name: string;
}> {}

const defaultConfig = (
  config: OnlineEvaluatorConfig | undefined,
): aiplatform.GoogleCloudAiplatformV1OnlineEvaluatorConfig => ({
  randomSampling: {
    percentage: config?.randomSampling?.percentage ?? 10,
  },
  maxEvaluatedSamplesPerRun: config?.maxEvaluatedSamplesPerRun,
});

const toAttrs = (
  evaluator: aiplatform.GoogleCloudAiplatformV1OnlineEvaluator,
  project: string,
) => {
  const name = evaluator.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  const display = parseDisplayName(evaluator.displayName);
  return {
    name,
    onlineEvaluatorId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: display.displayName,
    agentResource: evaluator.agentResource,
    state: evaluator.state,
    createTime: evaluator.createTime,
    updateTime: evaluator.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsOnlineEvaluators({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (
        evaluator,
      ): evaluator is aiplatform.GoogleCloudAiplatformV1OnlineEvaluator =>
        evaluator !== undefined,
      () => new AiPlatformNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.NotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (evaluator) => evaluator === undefined,
      () => new AiPlatformStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.StillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const findOwned = (parent: string, id: string) =>
  Effect.gen(function* () {
    const pages = yield* collectPages(
      aiplatform.listProjectsLocationsOnlineEvaluators.pages({
        parent,
        pageSize: 100,
      }),
    ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
    const evaluators = pages.flatMap((page) => page.onlineEvaluators ?? []);
    for (const evaluator of evaluators) {
      const parsed = parseDisplayName(evaluator.displayName);
      if (yield* ownedById(id, parsed.labels)) {
        return evaluator;
      }
    }
    return undefined;
  });

export const OnlineEvaluatorProvider = () =>
  Provider.succeed(OnlineEvaluator, {
    stables: [
      "name",
      "onlineEvaluatorId",
      "project",
      "location",
      "agentResource",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const agentChanged =
        news.agentResource !==
        (olds?.agentResource ?? output?.agentResource ?? news.agentResource);
      const replace =
        previousLocation !== nextLocation ||
        (olds !== undefined && agentChanged);
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst: previousLocation === nextLocation,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : yield* findOwned(parent, id);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseDisplayName(existing.displayName);
      return (yield* hasAlchemyLabels(id, parsed.labels)) ||
        (yield* ownedById(id, parsed.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = (yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            collectPages(
              aiplatform.listProjectsLocationsOnlineEvaluators.pages({
                parent: locationParent(env.project, location),
                pageSize: 100,
              }),
            ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([]))),
        )).flat();
        return pages.flatMap((page) =>
          (page.onlineEvaluators ?? [])
            .filter((evaluator) =>
              hasDisplayNameOwnership(evaluator.displayName),
            )
            .map((evaluator) => toAttrs(evaluator, env.project)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const internal = yield* createInternalLabels(id);
      const displayName = encodeDisplayName(internal, news.displayName);
      const config = defaultConfig(news.config);

      let current =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : yield* findOwned(parent, id);

      if (current === undefined) {
        const created =
          yield* aiplatform.createProjectsLocationsOnlineEvaluators({
            parent,
            body: {
              displayName,
              agentResource: news.agentResource,
              metricSources: news.metricSources,
              config,
              cloudObservability: news.cloudObservability,
            },
          });
        yield* waitForOperation(created, { alreadyExistsOk: true });
        const createdName = resourceNameFromOperation(created);
        current =
          createdName !== undefined
            ? yield* waitUntilExists(createdName)
            : yield* findOwned(parent, id);
      }

      if (current === undefined || current.name === undefined) {
        return yield* new OnlineEvaluatorNotResolved({
          name: output?.name ?? parent,
        });
      }

      const observedName = current.name;
      const observedDisplay = parseDisplayName(current.displayName);
      const displayChanged =
        (observedDisplay.displayName ?? "") !== (news.displayName ?? "");
      const configChanged = !jsonEqual(current.config, config);
      const metricsChanged = !jsonEqual(
        current.metricSources,
        news.metricSources,
      );

      if (displayChanged || configChanged || metricsChanged) {
        const updateMask = [
          displayChanged ? "display_name" : undefined,
          configChanged ? "config" : undefined,
          metricsChanged ? "metric_sources" : undefined,
        ].filter((field): field is string => field !== undefined);
        const patched =
          yield* aiplatform.patchProjectsLocationsOnlineEvaluators({
            name: observedName,
            updateMask: updateMask.join(","),
            body: {
              name: observedName,
              displayName,
              config,
              metricSources: news.metricSources,
            },
          });
        yield* waitForOperation(patched);
        current = yield* getByName(observedName);
      }

      if (current === undefined) {
        return yield* new OnlineEvaluatorNotResolved({ name: observedName });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsOnlineEvaluators({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });

import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
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
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";
import {
  hasAlchemyLabelMap,
  normalizeLocation,
  parseResourceName,
  toPhysicalRfc1035,
  userLabels,
} from "./helpers.ts";

const MAX_NAME_LENGTH = 63;

export type EvaluationRunProps = {
  /**
   * Evaluation run id (the `{evaluation_run}` segment). Assigned by
   * Vertex on create. Provide to target an existing run.
   */
  evaluationRunId?: string;
  /**
   * Region. Immutable — changing it replaces the run.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Defaults to a generated id when omitted. Immutable.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Arbitrary caller metadata.
   */
  metadata?: unknown;
  /**
   * Data source (an Evaluation Set name or a BigQuery request set).
   * Immutable.
   */
  dataSource: aiplatform.GoogleCloudAiplatformV1EvaluationRunDataSource;
  /**
   * Candidate-to-inference config map. Immutable.
   */
  inferenceConfigs?: Record<
    string,
    aiplatform.GoogleCloudAiplatformV1EvaluationRunInferenceConfig
  >;
  /**
   * Metrics, rubric, and output configuration. Immutable.
   */
  evaluationConfig?: aiplatform.GoogleCloudAiplatformV1EvaluationRunEvaluationConfig;
};

export type EvaluationRun = Resource<
  "GCP.AIPlatform.EvaluationRun",
  EvaluationRunProps,
  {
    /** Full resource name. */
    name: string;
    /** Evaluation run id (last path segment). */
    evaluationRunId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Run state. */
    state:
      | aiplatform.GoogleCloudAiplatformV1EvaluationRunStateEnum
      | (string & {})
      | undefined;
    /** Data source. */
    dataSource:
      | aiplatform.GoogleCloudAiplatformV1EvaluationRunDataSource
      | undefined;
    /** Inference configs. */
    inferenceConfigs:
      | aiplatform.GoogleCloudAiplatformV1EvaluationRunInferenceConfigMap
      | undefined;
    /** Evaluation config. */
    evaluationConfig:
      | aiplatform.GoogleCloudAiplatformV1EvaluationRunEvaluationConfig
      | undefined;
    /** Snapshot evaluation set. */
    evaluationSetSnapshot: string | undefined;
    /** Results when the run succeeded. */
    evaluationResults:
      | aiplatform.GoogleCloudAiplatformV1EvaluationResults
      | undefined;
    /** Caller metadata. */
    metadata: unknown;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Error when FAILED or CANCELLED. */
    error: aiplatform.GoogleRpcStatus | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 completion timestamp. */
    completionTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Evaluation Run — one execution of metrics over a set of
 * evaluation items or a BigQuery request set.
 *
 * Vertex assigns the resource id. Creating a run starts evaluation. There
 * is no update API: changing location, display name, data source, or
 * config replaces the run.
 *
 * ### Creating an Evaluation Run
 * **Example:** Run metrics over an evaluation set
 * ```typescript
 * const run = yield* GCP.AIPlatform.EvaluationRun("Quality", {
 *   dataSource: { evaluationSet: evaluationSet.name },
 *   evaluationConfig: {
 *     metrics: [
 *       {
 *         metric: "instruction_following_v1",
 *         predefinedMetricSpec: { metricSpecName: "instruction_following_v1" },
 *       },
 *     ],
 *   },
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const EvaluationRun = Resource<EvaluationRun>(
  "GCP.AIPlatform.EvaluationRun",
);

export class EvaluationRunNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.EvaluationRunNotResolved",
)<{
  name: string;
}> {}

export class EvaluationRunStillExists extends Data.TaggedError(
  "GCP.AIPlatform.EvaluationRunStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, runId: string) =>
  `projects/${project}/locations/${location}/evaluationRuns/${runId}`;

const toAttrs = (
  run: aiplatform.GoogleCloudAiplatformV1EvaluationRun,
  project: string,
) => {
  const name = run.name ?? "";
  const parsed = parseResourceName(name, "evaluationRuns");
  return {
    name,
    evaluationRunId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: run.displayName,
    state: run.state,
    dataSource: run.dataSource,
    inferenceConfigs: run.inferenceConfigs,
    evaluationConfig: run.evaluationConfig,
    evaluationSetSnapshot: run.evaluationSetSnapshot,
    evaluationResults: run.evaluationResults,
    metadata: run.metadata,
    labels: userLabels(run.labels),
    error: run.error,
    createTime: run.createTime,
    completionTime: run.completionTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsEvaluationRuns({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, location = "-") =>
  aiplatform.listProjectsLocationsEvaluationRuns
    .pages({
      parent: `projects/${project}/locations/${location}`,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.evaluationRuns ?? [])),
      Stream.filter((run) => hasAlchemyLabelMap(run.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (id: string, project: string, location?: string) =>
  Effect.gen(function* () {
    const runs = yield* listOwned(project, location);
    for (const run of runs) {
      if (yield* hasAlchemyLabels(id, tagRecord(run.labels))) {
        return run;
      }
    }
    return undefined;
  });

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((run) =>
      run === undefined
        ? Effect.void
        : Effect.fail(new EvaluationRunStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.EvaluationRunStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const EvaluationRunProvider = () =>
  Provider.succeed(EvaluationRun, {
    stables: ["name", "evaluationRunId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.evaluationRunId ?? output?.evaluationRunId;
      const nextId = news.evaluationRunId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const previousDisplay = olds?.displayName ?? output?.displayName ?? "";
      const nextDisplay = news.displayName ?? previousDisplay;
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (news.displayName !== undefined && nextDisplay !== previousDisplay);
      if (!replace) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const runId = olds?.evaluationRunId ?? output?.evaluationRunId;
      const name =
        output?.name ??
        (runId ? resourceName(env.project, location, runId) : undefined);
      const existing = name
        ? yield* getByName(name)
        : yield* findOwned(id, env.project, location);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const runs = yield* listOwned(env.project);
        return runs.map((run) => toAttrs(run, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const runId = news.evaluationRunId ?? output?.evaluationRunId;
      const name =
        output?.name ??
        (runId ? resourceName(env.project, location, runId) : undefined);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName =
        news.displayName ??
        (yield* toPhysicalRfc1035(id, undefined, undefined, MAX_NAME_LENGTH));

      let current = name
        ? yield* getByName(name)
        : yield* findOwned(id, env.project, location);

      if (current === undefined) {
        current = yield* aiplatform
          .createProjectsLocationsEvaluationRuns({
            parent: `projects/${env.project}/locations/${location}`,
            body: {
              displayName,
              dataSource: news.dataSource,
              inferenceConfigs: news.inferenceConfigs,
              evaluationConfig: news.evaluationConfig,
              metadata: news.metadata,
              labels: desiredLabels,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, env.project, location),
            ),
          );
      }

      if (current === undefined) {
        return yield* new EvaluationRunNotResolved({
          name: name ?? displayName,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      // A running evaluation blocks the delete with BadRequest "There are
      // other operations running on the EvaluationRun" until it finishes
      // (cancel is unimplemented: HTTP 501).
      const operation = yield* aiplatform
        .deleteProjectsLocationsEvaluationRuns({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" || error._tag === "BadRequest",
            times: 24,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });

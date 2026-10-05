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
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  alchemyIdFilter,
  createInternalLabels,
  hasAlchemyPrefix,
  listLocations,
  locationOf,
  lastSegment,
  normalizeLocation,
  projectOf,
  stableJson,
  toDisplayName,
  toLabels,
  userLabels,
} from "./names.ts";
import { isJobTerminal } from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type HyperparameterTuningJobProps = {
  /**
   * Vertex AI location. Immutable — changing it replaces the job.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 128 Unicode characters). Generated from the stack,
   * stage, and logical id when omitted.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Desired total number of Trials.
   */
  maxTrialCount: number;
  /**
   * Desired number of Trials to run in parallel.
   */
  parallelTrialCount: number;
  /**
   * Number of failed Trials before the job fails. `0` lets Vertex decide.
   */
  maxFailedTrialCount?: number;
  /**
   * Study configuration (metrics and parameters).
   */
  studySpec: aiplatform.GoogleCloudAiplatformV1StudySpec;
  /**
   * Spec of the CustomJob backing each Trial.
   */
  trialJobSpec: aiplatform.GoogleCloudAiplatformV1CustomJobSpec;
  /**
   * Customer-managed encryption key. Immutable.
   */
  encryptionSpec?: aiplatform.GoogleCloudAiplatformV1EncryptionSpec;
};

export type HyperparameterTuningJob = Resource<
  "GCP.AIPlatform.HyperparameterTuningJob",
  HyperparameterTuningJobProps,
  {
    /** Full resource name. */
    name: string;
    /** Job id (last path segment). */
    hyperparameterTuningJobId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Job state. */
    state: string | undefined;
    /** Desired total trial count. */
    maxTrialCount: number | undefined;
    /** Parallel trial count. */
    parallelTrialCount: number | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI HyperparameterTuningJob that runs CustomJobs for each trial.
 *
 * The API assigns the job id. There is no update method — changing display
 * name, labels, trial counts, or specs replaces the job. Delete cancels a
 * running job first.
 *
 * ### Creating a HyperparameterTuningJob
 * **Example:** Maximize accuracy
 * ```typescript
 * const job = yield* GCP.AIPlatform.HyperparameterTuningJob("Tune", {
 *   maxTrialCount: 2,
 *   parallelTrialCount: 1,
 *   studySpec: {
 *     metrics: [{ metricId: "accuracy", goal: "MAXIMIZE" }],
 *     parameters: [{
 *       parameterId: "lr",
 *       doubleValueSpec: { minValue: 0.001, maxValue: 0.1 },
 *     }],
 *   },
 *   trialJobSpec: {
 *     workerPoolSpecs: [{
 *       machineSpec: { machineType: "n1-standard-4" },
 *       replicaCount: "1",
 *       containerSpec: { imageUri: "gcr.io/cloud-aiplatform/training/tf-cpu.2-8:latest" },
 *     }],
 *   },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const HyperparameterTuningJob = Resource<HyperparameterTuningJob>(
  "GCP.AIPlatform.HyperparameterTuningJob",
);

export class HyperparameterTuningJobNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.HyperparameterTuningJobNotResolved",
)<{
  name: string;
}> {}

export class HyperparameterTuningJobStillExists extends Data.TaggedError(
  "GCP.AIPlatform.HyperparameterTuningJobStillExists",
)<{
  name: string;
}> {}

const toAttrs = (
  job: aiplatform.GoogleCloudAiplatformV1HyperparameterTuningJob,
  project: string,
) => {
  const name = job.name ?? "";
  return {
    name,
    hyperparameterTuningJobId: lastSegment(name),
    project: projectOf(name, project),
    location: locationOf(name),
    displayName: job.displayName,
    labels: userLabels(job.labels),
    state: job.state,
    maxTrialCount: job.maxTrialCount,
    parallelTrialCount: job.parallelTrialCount,
    createTime: job.createTime,
    startTime: job.startTime,
    endTime: job.endTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsHyperparameterTuningJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listPage = (parent: string, filter?: string) =>
  aiplatform.listProjectsLocationsHyperparameterTuningJobs
    .pages({ parent, pageSize: 100, filter })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap(
          (page) => page.hyperparameterTuningJobs ?? [],
        ),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed(
          [] as aiplatform.GoogleCloudAiplatformV1HyperparameterTuningJob[],
        ),
      ),
    );

const findOwned = (
  project: string,
  location: string,
  labels: Record<string, string>,
) =>
  listPage(
    `projects/${project}/locations/${location}`,
    alchemyIdFilter(labels),
  ).pipe(
    Effect.map(
      (items) =>
        items.find((item) => hasAlchemyPrefix(item.labels)) ?? undefined,
    ),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (job) => job === undefined,
      () => new HyperparameterTuningJobStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.HyperparameterTuningJobStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const HyperparameterTuningJobProvider = () =>
  Provider.succeed(HyperparameterTuningJob, {
    stables: [
      "name",
      "hyperparameterTuningJobId",
      "project",
      "location",
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
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousDisplay = olds?.displayName ?? output?.displayName;
      const displayChanged =
        news.displayName !== undefined &&
        previousDisplay !== undefined &&
        news.displayName !== previousDisplay;
      const previousMax = olds?.maxTrialCount ?? output?.maxTrialCount;
      const previousParallel =
        olds?.parallelTrialCount ?? output?.parallelTrialCount;
      const specsChanged =
        (olds !== undefined &&
          stableJson(olds.studySpec) !== stableJson(news.studySpec)) ||
        (olds !== undefined &&
          stableJson(olds.trialJobSpec) !== stableJson(news.trialJobSpec));
      if (
        previousLocation !== nextLocation ||
        displayChanged ||
        (previousMax !== undefined && news.maxTrialCount !== previousMax) ||
        (previousParallel !== undefined &&
          news.parallelTrialCount !== previousParallel) ||
        specsChanged
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const ownership = yield* createInternalLabels(id);
      const existing =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ?? (yield* findOwned(env.project, location, ownership));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            listPage(`projects/${env.project}/locations/${location}`),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((job) => hasAlchemyPrefix(job.labels))
          .map((job) => toAttrs(job, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ??
        (yield* findOwned(env.project, location, desiredLabels));

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsHyperparameterTuningJobs({
            parent: `projects/${env.project}/locations/${location}`,
            body: {
              displayName,
              labels: desiredLabels,
              maxTrialCount: news.maxTrialCount,
              parallelTrialCount: news.parallelTrialCount,
              maxFailedTrialCount: news.maxFailedTrialCount,
              studySpec: news.studySpec,
              trialJobSpec: news.trialJobSpec,
              encryptionSpec: news.encryptionSpec,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current =
          created ?? (yield* findOwned(env.project, location, desiredLabels));
      }

      if (current === undefined || current.name === undefined) {
        return yield* new HyperparameterTuningJobNotResolved({
          name: output?.name ?? `${location}/hyperparameterTuningJobs`,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* aiplatform
        .cancelProjectsLocationsHyperparameterTuningJobs({
          name: output.name,
          body: {},
        })
        .pipe(
          Effect.catchTag(
            ["NotFound", "BadRequest", "Conflict"],
            () => Effect.void,
          ),
        );
      // Running jobs reject deletes; wait for the cancel to land.
      yield* getByName(output.name).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("4 seconds"),
          until: (job) => job === undefined || isJobTerminal(job.state),
          times: 45,
        }),
      );
      const operation = yield* aiplatform
        .deleteProjectsLocationsHyperparameterTuningJobs({
          name: output.name,
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

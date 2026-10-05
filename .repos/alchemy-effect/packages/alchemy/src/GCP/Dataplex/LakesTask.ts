import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
import { waitForOperation } from "./operations.ts";
import {
  DataplexNotResolved,
  expandParent,
  fingerprint,
  hasAlchemyLabelMap,
  isPendingState,
  listChildResources,
  listLakes,
  listTasks,
  normalizeLocation,
  parseResourceName,
  replaceIfChanged,
  toPhysicalRfc1035,
  userLabels,
} from "./shared.ts";

const DEFAULT_TRIGGER = "ON_DEMAND";

export type TaskTriggerSpec = {
  /**
   * Trigger type. Immutable — changing it replaces the task.
   * @default "ON_DEMAND"
   */
  type?: dataplex.GoogleCloudDataplexV1TaskTriggerSpecTypeEnum | (string & {});
  /** First run after this RFC3339 timestamp. */
  startTime?: string;
  /** Temporarily disable RECURRING execution. */
  disabled?: boolean;
  /** Retry attempts before aborting. */
  maxRetries?: number;
  /** Cron schedule. Required for `RECURRING`. */
  schedule?: string;
};

export type TaskExecutionSpec = {
  /** Arguments interpolated before passing to the driver. */
  args?: Record<string, string>;
  /**
   * Service account used to execute the task. If omitted, the project
   * Compute Engine default service account is used.
   */
  serviceAccount?: string;
  /** Project in which jobs run. Defaults to the lake project. */
  project?: string;
  /** Maximum job duration (e.g. `"3600s"`). */
  maxJobExecutionLifetime?: string;
  /** Cloud KMS key used to encrypt job data. */
  kmsKey?: string;
};

export type TaskInfrastructureSpec = {
  /** Dataproc Serverless executor counts. */
  batch?: {
    executorsCount?: number;
    maxExecutorsCount?: number;
  };
  /** Container image runtime. */
  containerImage?: {
    image?: string;
    javaJars?: string[];
    pythonPackages?: string[];
    properties?: Record<string, string>;
  };
  /** VPC network used to run the job. */
  vpcNetwork?: {
    network?: string;
    subNetwork?: string;
    networkTags?: string[];
  };
};

export type TaskSparkConfig = {
  /** Cloud Storage URI of the jar containing the main class. */
  mainJarFileUri?: string;
  /** Driver main class. */
  mainClass?: string;
  /** Cloud Storage URI of the main Python file. */
  pythonScriptFile?: string;
  /** Cloud Storage URI of a SQL query file. */
  sqlScriptFile?: string;
  /** Inline SQL query text. */
  sqlScript?: string;
  /** Working-directory files. */
  fileUris?: string[];
  /** Archives extracted into the working directory. */
  archiveUris?: string[];
  /** Infrastructure used to run the Spark job. */
  infrastructureSpec?: TaskInfrastructureSpec;
};

export type TaskNotebookConfig = {
  /** Path to the input notebook. */
  notebook: string;
  /** Infrastructure used to run the notebook. */
  infrastructureSpec?: TaskInfrastructureSpec;
  /** Working-directory files. */
  fileUris?: string[];
  /** Archives extracted into the working directory. */
  archiveUris?: string[];
};

export type LakesTaskProps = {
  /**
   * Parent lake. Full name
   * `projects/{project}/locations/{location}/lakes/{lake}` or the lake id
   * (combined with `location`). Immutable — changing it replaces the task.
   */
  lake: string;
  /**
   * Region used when `lake` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Task id. Immutable — changing it replaces the task.
   */
  taskId?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * How often and when the task runs.
   * @default { type: "ON_DEMAND" }
   */
  triggerSpec?: TaskTriggerSpec;
  /**
   * How the task is executed (service account, args, encryption).
   */
  executionSpec?: TaskExecutionSpec;
  /**
   * Spark workload. Mutually exclusive with `notebook`.
   */
  spark?: TaskSparkConfig;
  /**
   * Notebook workload. Mutually exclusive with `spark`.
   */
  notebook?: TaskNotebookConfig;
};

export type LakesTask = Resource<
  "GCP.Dataplex.LakesTask",
  LakesTaskProps,
  {
    /** Full resource name `.../lakes/{lake}/tasks/{task}`. */
    name: string;
    /** Task id. */
    taskId: string;
    /** Parent lake resource name. */
    lake: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Description. */
    description: string | undefined;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Trigger type. */
    triggerType: string | undefined;
    /** Execution service account. */
    serviceAccount: string | undefined;
    /** Lifecycle state. */
    state: string | undefined;
    /** Server-assigned uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex lake task — a Spark or notebook job scheduled against a lake.
 *
 * Changing `lake`, `taskId`, `location`, or trigger type replaces the
 * task. Description, labels, execution spec, and Spark/notebook config
 * update in place.
 *
 * ### Creating a Task
 * **Example:** On-demand Spark SQL
 * ```typescript
 * const task = yield* GCP.Dataplex.LakesTask("SelectOne", {
 *   lake: lake.name,
 *   executionSpec: { serviceAccount },
 *   spark: { sqlScript: "SELECT 1" },
 * });
 * ```
 *
 * **Example:** Recurring notebook
 * ```typescript
 * const task = yield* GCP.Dataplex.LakesTask("Nightly", {
 *   lake: lake.name,
 *   triggerSpec: { type: "RECURRING", schedule: "0 2 * * *" },
 *   executionSpec: { serviceAccount },
 *   notebook: { notebook: "gs://bucket/job.ipynb" },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const LakesTask = Resource<LakesTask>("GCP.Dataplex.LakesTask");

export class LakesTaskNotResolved extends Data.TaggedError(
  "GCP.Dataplex.LakesTaskNotResolved",
)<{
  name: string;
}> {}

export class LakesTaskStillExists extends Data.TaggedError(
  "GCP.Dataplex.LakesTaskStillExists",
)<{
  name: string;
}> {}

const lakeOf = (lake: string, project: string, location: string) =>
  expandParent(lake, project, location, "lakes");

const resourceName = (lake: string, taskId: string) =>
  `${lake}/tasks/${taskId}`;

const triggerBody = (
  spec: TaskTriggerSpec | undefined,
): dataplex.GoogleCloudDataplexV1TaskTriggerSpec => ({
  type: (spec?.type ?? DEFAULT_TRIGGER).toUpperCase(),
  startTime: spec?.startTime,
  disabled: spec?.disabled,
  maxRetries: spec?.maxRetries,
  schedule: spec?.schedule,
});

const executionBody = (
  spec: TaskExecutionSpec | undefined,
): dataplex.GoogleCloudDataplexV1TaskExecutionSpec => ({
  args: spec?.args,
  serviceAccount: spec?.serviceAccount,
  project: spec?.project,
  maxJobExecutionLifetime: spec?.maxJobExecutionLifetime,
  kmsKey: spec?.kmsKey,
});

const toAttrs = (task: dataplex.GoogleCloudDataplexV1Task, project: string) => {
  const name = task.name ?? "";
  const parsed = parseResourceName(name, "tasks");
  return {
    name,
    taskId: parsed.id,
    lake: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    description: task.description,
    displayName: task.displayName,
    labels: userLabels(task.labels),
    triggerType: task.triggerSpec?.type,
    serviceAccount: task.executionSpec?.serviceAccount,
    state: task.state,
    uid: task.uid,
    createTime: task.createTime,
    updateTime: task.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : dataplex
        .getProjectsLocationsLakesTasks({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (task): task is dataplex.GoogleCloudDataplexV1Task => task !== undefined,
      () => new LakesTaskNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (task) => !isPendingState(task.state),
      () => new DataplexNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Dataplex.LakesTaskNotResolved" ||
        error._tag === "GCP.Dataplex.NotResolved" ||
        error._tag === "TooManyRequests",
      times: 10,
      schedule: Schedule.spaced("10 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((task) =>
      task === undefined
        ? Effect.void
        : Effect.fail(new LakesTaskStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataplex.LakesTaskStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const LakesTaskProvider = () =>
  Provider.succeed(LakesTask, {
    stables: [
      "name",
      "taskId",
      "lake",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.taskId ?? output?.taskId;
      const nextId = news.taskId ?? previousId;
      const previousLake = olds?.lake ?? output?.lake;
      const nextLake = news.lake ?? previousLake;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousTrigger = (
        olds?.triggerSpec?.type ??
        output?.triggerType ??
        DEFAULT_TRIGGER
      ).toUpperCase();
      const nextTrigger = (
        news.triggerSpec?.type ?? previousTrigger
      ).toUpperCase();
      if (
        replaceIfChanged(previousId, nextId) ||
        replaceIfChanged(previousLake, nextLake) ||
        (output !== undefined && previousLocation !== nextLocation) ||
        previousTrigger !== nextTrigger
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousLake === nextLake &&
            previousLocation === nextLocation &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const lake = lakeOf(
        olds?.lake ?? output?.lake ?? "",
        env.project,
        location,
      );
      const taskId = yield* toPhysicalRfc1035(id, olds?.taskId, output?.taskId);
      const name = output?.name ?? resourceName(lake, taskId);
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
        const lakes = yield* listLakes(env.project, env.region);
        const tasks = yield* listChildResources(lakes, listTasks);
        return tasks
          .filter((task) => hasAlchemyLabelMap(task.labels))
          .map((task) => toAttrs(task, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const lake = lakeOf(news.lake, env.project, location);
      const taskId = yield* toPhysicalRfc1035(id, news.taskId, output?.taskId);
      const name = output?.name ?? resourceName(lake, taskId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const triggerSpec = triggerBody(news.triggerSpec);
      const executionSpec = executionBody(news.executionSpec);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsLakesTasks({
            parent: lake,
            taskId,
            body: {
              description: news.description,
              displayName: news.displayName,
              labels: desiredLabels,
              triggerSpec,
              executionSpec,
              spark: news.spark,
              notebook: news.notebook,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new LakesTaskNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const triggerChanged =
        fingerprint(current.triggerSpec) !== fingerprint(triggerSpec);
      const executionChanged =
        fingerprint(current.executionSpec) !== fingerprint(executionSpec);
      const sparkChanged =
        fingerprint(current.spark) !== fingerprint(news.spark);
      const notebookChanged =
        fingerprint(current.notebook) !== fingerprint(news.notebook);

      if (
        labelsChanged ||
        descriptionChanged ||
        displayNameChanged ||
        triggerChanged ||
        executionChanged ||
        sparkChanged ||
        notebookChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          displayNameChanged ? "display_name" : undefined,
          triggerChanged ? "trigger_spec" : undefined,
          executionChanged ? "execution_spec" : undefined,
          sparkChanged ? "spark" : undefined,
          notebookChanged ? "notebook" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation = yield* dataplex.patchProjectsLocationsLakesTasks({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            description: news.description,
            displayName: news.displayName,
            labels: desiredLabels,
            triggerSpec,
            executionSpec,
            spark: news.spark,
            notebook: news.notebook,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name || output.name.includes("//")) return;
      const operation = yield* dataplex
        .deleteProjectsLocationsLakesTasks({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });

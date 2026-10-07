import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  AiPlatformNotResolved,
  AiPlatformStillExists,
  collectPages,
  locationParent,
  normalizeLocation,
  parseResourceName,
  toPhysicalId,
  userLabels,
  type EncryptionSpec,
  type MachineSpec,
  type NetworkSpec,
  type PersistentDiskSpec,
} from "./shared.ts";

const COLLECTION = "notebookExecutionJobs";

export type DirectNotebookSource = {
  /** Base64-encoded contents of the input notebook. */
  content?: string;
};

export type GcsNotebookSource = {
  /** Cloud Storage URI of the ipynb (`gs://bucket/notebook.ipynb`). */
  uri?: string;
  /** Object generation to read. Unset reads the live object. */
  generation?: string;
};

export type DataformRepositorySource = {
  /** Dataform repository resource name. */
  dataformRepositoryResourceName?: string;
  /** Commit SHA. Unset reads HEAD. */
  commitSha?: string;
};

export type CustomEnvironmentSpec = {
  /** Machine spec for the execution job. */
  machineSpec?: MachineSpec;
  /** Network spec. */
  networkSpec?: NetworkSpec;
  /** Persistent disk attached to the job. */
  persistentDiskSpec?: PersistentDiskSpec;
};

export type NotebookExecutionJobProps = {
  /**
   * Job id. If omitted, a unique RFC1035 name is generated. Immutable —
   * changing it replaces the job (a new execution is started).
   */
  notebookExecutionJobId?: string;
  /**
   * Vertex AI location. Immutable — changing it replaces the job.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 128 UTF-8 characters). Defaults to the job id.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * NotebookRuntimeTemplate to source compute from.
   */
  notebookRuntimeTemplateResourceName?: string;
  /**
   * Custom compute configuration. Mutually exclusive with a template.
   */
  customEnvironmentSpec?: CustomEnvironmentSpec;
  /**
   * Inline notebook contents. Mutually exclusive with GCS / Dataform.
   */
  directNotebookSource?: DirectNotebookSource;
  /**
   * Cloud Storage notebook URI.
   */
  gcsNotebookSource?: GcsNotebookSource;
  /**
   * Dataform repository notebook source.
   */
  dataformRepositorySource?: DataformRepositorySource;
  /**
   * Cloud Storage location for results (`gs://bucket-name`).
   */
  gcsOutputUri?: string;
  /**
   * Service account the execution runs as.
   */
  serviceAccount?: string;
  /**
   * User email to run as (Colab runtimes only).
   */
  executionUser?: string;
  /**
   * Kernel name. Unset uses the default kernel.
   */
  kernelName?: string;
  /**
   * Max running time (e.g. `"86400s"`).
   */
  executionTimeout?: string;
  /**
   * Customer-managed encryption key.
   */
  encryptionSpec?: EncryptionSpec;
};

export type NotebookExecutionJob = Resource<
  "GCP.AIPlatform.NotebookExecutionJob",
  NotebookExecutionJobProps,
  {
    /** Full resource name. */
    name: string;
    /** Job id (last path segment). */
    notebookExecutionJobId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Job state (`JOB_STATE_RUNNING`, `JOB_STATE_SUCCEEDED`, …). */
    jobState: string | undefined;
    /** Cloud Storage output URI. */
    gcsOutputUri: string | undefined;
    /** NotebookRuntimeTemplate resource name, if used. */
    notebookRuntimeTemplateResourceName: string | undefined;
    /** Service account. */
    serviceAccount: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI notebook execution job — runs an ipynb once against a
 * runtime template or custom environment.
 *
 * There is no update API. Changing identity (`notebookExecutionJobId`,
 * `location`) or the notebook source replaces the job. Other fields are
 * create-time only.
 *
 * ### Creating a Job
 * **Example:** Execute a GCS notebook
 * ```typescript
 * const job = yield* GCP.AIPlatform.NotebookExecutionJob("Nightly", {
 *   notebookRuntimeTemplateResourceName: template.name,
 *   gcsNotebookSource: { uri: "gs://bucket/notebook.ipynb" },
 *   gcsOutputUri: "gs://bucket/output",
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const NotebookExecutionJob = Resource<NotebookExecutionJob>(
  "GCP.AIPlatform.NotebookExecutionJob",
);

export class NotebookExecutionJobNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.NotebookExecutionJobNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, id: string) =>
  `${locationParent(project, location)}/${COLLECTION}/${id}`;

const toAttrs = (
  job: aiplatform.GoogleCloudAiplatformV1NotebookExecutionJob,
  project: string,
) => {
  const name = job.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    notebookExecutionJobId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: job.displayName,
    labels: userLabels(job.labels),
    jobState: job.jobState,
    gcsOutputUri: job.gcsOutputUri,
    notebookRuntimeTemplateResourceName:
      job.notebookRuntimeTemplateResourceName,
    serviceAccount: job.serviceAccount,
    createTime: job.createTime,
    updateTime: job.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsNotebookExecutionJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (job): job is aiplatform.GoogleCloudAiplatformV1NotebookExecutionJob =>
        job !== undefined,
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
      (job) => job === undefined,
      () => new AiPlatformStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.StillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const NotebookExecutionJobProvider = () =>
  Provider.succeed(NotebookExecutionJob, {
    stables: [
      "name",
      "notebookExecutionJobId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.notebookExecutionJobId ?? output?.notebookExecutionJobId;
      const nextId = news.notebookExecutionJobId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const sourceChanged =
        (news.gcsNotebookSource?.uri ?? "") !==
          (olds?.gcsNotebookSource?.uri ?? "") ||
        (news.directNotebookSource?.content ?? "") !==
          (olds?.directNotebookSource?.content ?? "") ||
        (news.dataformRepositorySource?.dataformRepositoryResourceName ??
          "") !==
          (olds?.dataformRepositorySource?.dataformRepositoryResourceName ??
            "");
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (olds !== undefined && sourceChanged);
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toPhysicalId(
        id,
        olds?.notebookExecutionJobId,
        output?.notebookExecutionJobId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name = output?.name ?? resourceName(env.project, location, jobId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // Vertex AI replaces a job's labels with its runtime template's, so a
      // job at the generated (instance-unique) id is ours even when the
      // ownership labels name the template.
      const generated = olds?.notebookExecutionJobId === undefined;
      return generated ||
        (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
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
              aiplatform.listProjectsLocationsNotebookExecutionJobs.pages({
                parent: locationParent(env.project, location),
                pageSize: 100,
              }),
            ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([]))),
        )).flat();
        return pages.flatMap((page) =>
          (page.notebookExecutionJobs ?? [])
            .filter((job) =>
              Object.keys(job.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            )
            .map((job) => toAttrs(job, env.project)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toPhysicalId(
        id,
        news.notebookExecutionJobId,
        output?.notebookExecutionJobId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, jobId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsNotebookExecutionJobs({
            parent: locationParent(env.project, location),
            notebookExecutionJobId: jobId,
            body: {
              displayName: news.displayName ?? jobId,
              labels: desiredLabels,
              notebookRuntimeTemplateResourceName:
                news.notebookRuntimeTemplateResourceName,
              customEnvironmentSpec: news.customEnvironmentSpec,
              directNotebookSource: news.directNotebookSource,
              gcsNotebookSource: news.gcsNotebookSource,
              dataformRepositorySource: news.dataformRepositorySource,
              gcsOutputUri: news.gcsOutputUri,
              serviceAccount: news.serviceAccount,
              executionUser: news.executionUser,
              kernelName: news.kernelName,
              executionTimeout: news.executionTimeout,
              encryptionSpec: news.encryptionSpec,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        const createdName =
          resourceNameFromOperation(created ?? {}) ?? output?.name ?? name;
        current = yield* waitUntilExists(createdName);
      }

      if (current === undefined) {
        return yield* new NotebookExecutionJobNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsNotebookExecutionJobs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });

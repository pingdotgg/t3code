import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import type * as Bundle from "../../Bundle/Bundle.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  Platform,
  type Main,
  type PlatformProps,
  type PlatformServices,
} from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  createContainerRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "../../Server/Process.ts";
import type { Scope } from "effect/Scope";
import { tagRecord } from "../../Tags.ts";
import {
  destroyHostImageRepository,
  makeImageSource,
} from "../ArtifactRegistry/ImageSource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  type LongRunningOperation,
  waitForOperation as waitForLongRunningOperation,
} from "../Operation.ts";
import {
  retryActAs,
  type AppliedIamGrant,
  type GcpHostBinding,
} from "../Host.ts";
import {
  alchemyRuntimeEnv,
  isManagedServiceAccount,
  makeGcpBootstrap,
  mergeContainerEnv,
  releaseHostIdentity,
  resolveHostIdentity,
} from "../HostRuntime.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 49;

export type JobEnvVar = {
  /** Environment variable name. */
  name: string;
  /** Literal value. Mutually exclusive with `valueSource`. */
  value?: string;
  /** Value sourced from Secret Manager. */
  valueSource?: {
    secretKeyRef?: {
      /** Secret id or `projects/{project}/secrets/{secret}` name. */
      secret: string;
      /** Version (`latest`, integer, or alias). */
      version?: string;
    };
  };
};

export type JobContainer = {
  /** DNS_LABEL container name. */
  name?: string;
  /**
   * Container image in Artifact Registry, Container Registry, or Docker Hub.
   */
  image: string;
  /** Entrypoint. Image ENTRYPOINT is used when omitted. */
  command?: string[];
  /** Arguments to the entrypoint. Image CMD is used when omitted. */
  args?: string[];
  /** Environment variables. */
  env?: JobEnvVar[];
  /** Working directory inside the container. */
  workingDir?: string;
  /** CPU/memory limits (`cpu`, `memory`, `nvidia.com/gpu`). */
  resources?: {
    limits?: Record<string, string>;
    cpuIdle?: boolean;
    startupCpuBoost?: boolean;
  };
  /** Volume mounts. Names must match `volumes`. */
  volumeMounts?: Array<{
    name: string;
    mountPath: string;
    subPath?: string;
  }>;
};

export type JobVpcAccess = {
  /** Traffic VPC egress (`ALL_TRAFFIC`, `PRIVATE_RANGES_ONLY`). */
  egress?: string;
  /**
   * Serverless VPC Access connector
   * (`projects/{project}/locations/{location}/connectors/{connector}`).
   */
  connector?: string;
  /** Direct VPC egress network interfaces. */
  networkInterfaces?: Array<{
    network?: string;
    subnetwork?: string;
    tags?: string[];
  }>;
};

export type JobBinaryAuthorization = {
  /** Use the project's default Binary Authorization policy. */
  useDefault?: boolean;
  /** Breakglass justification. Requires `useDefault`. */
  breakglassJustification?: string;
  /** Policy path `projects/{project}/platforms/cloudRun/{policy}`. */
  policy?: string;
};

export type JobProps = PlatformProps & {
  /**
   * Job id (the `{job}` segment of
   * `projects/{project}/locations/{location}/jobs/{job}`). If omitted, a
   * unique RFC1035 name is generated. 1-49 characters, lowercase letter
   * first. Immutable — changing it replaces the job.
   */
  jobId?: string;
  /**
   * Region (`us-central1`, `europe-west1`, …). Immutable — changing it
   * replaces the job. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * User annotations. Cloud Run rejects `run.googleapis.com`,
   * `cloud.googleapis.com`, `serving.knative.dev`, and
   * `autoscaling.knative.dev` namespaces.
   */
  annotations?: Record<string, string>;
  /**
   * Launch stage (`GA`, `BETA`, `ALPHA`). Defaults to GA.
   */
  launchStage?: string;
  /**
   * Binary Authorization settings.
   */
  binaryAuthorization?: JobBinaryAuthorization;
  /**
   * Number of tasks the execution should run.
   * @default 1
   */
  taskCount?: number;
  /**
   * Maximum number of tasks to run in parallel. `0` uses the maximum.
   */
  parallelism?: number;
  /**
   * Labels applied to each execution created from this job.
   */
  executionLabels?: Record<string, string>;
  /**
   * Annotations applied to each execution created from this job.
   */
  executionAnnotations?: Record<string, string>;
  /**
   * Containers that run as each task. Required unless `main` is set.
   */
  containers?: JobContainer[];
  /**
   * Module entrypoint for an Effect-native job (typically
   * `import.meta.url`). Alchemy bundles the program, builds a container,
   * and runs it to completion. Bindings grant IAM onto the runtime SA.
   */
  main?: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * Additional environment variables for the Effect-native container.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for `main`.
   */
  build?: Bundle.BundleConfig;
  /**
   * Max time a task attempt may run (e.g. `"600s"`).
   * @default "600s"
   */
  timeout?: string;
  /**
   * Retries per task before the task is marked failed.
   * @default 3
   */
  maxRetries?: number;
  /**
   * Service account email used by the task. Defaults to the project's
   * Compute Engine default.
   */
  serviceAccount?: string;
  /**
   * Execution environment (`EXECUTION_ENVIRONMENT_GEN1` or
   * `EXECUTION_ENVIRONMENT_GEN2`).
   */
  executionEnvironment?: string;
  /**
   * Customer-managed encryption key
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   */
  encryptionKey?: string;
  /**
   * VPC Access configuration for the task.
   */
  vpcAccess?: JobVpcAccess;
};

export type Job = Resource<
  "GCP.Run.Job",
  JobProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/jobs/{job}`. */
    name: string;
    /** Job id (last path segment). */
    jobId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Server-assigned UUID. */
    uid: string | undefined;
    /** Monotonic generation. */
    generation: string | undefined;
    /** Whether Cloud Run is still reconciling the job. */
    reconciling: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Number of executions created for this job. */
    executionCount: number | undefined;
    /** Terminal condition state (`CONDITION_SUCCEEDED`, …). */
    terminalConditionState: string | undefined;
    /** Latest created execution name, if any. */
    latestCreatedExecutionName: string | undefined;
    /** Image of the first container. */
    image: string | undefined;
    /** Retries per task. */
    maxRetries: number | undefined;
    /** Task timeout. */
    timeout: string | undefined;
    /** Desired task count. */
    taskCount: number | undefined;
    /** Max parallelism. */
    parallelism: number | undefined;
    /** Task service account email. */
    serviceAccount: string | undefined;
    /** True when Alchemy minted the per-host runtime service account. */
    managedServiceAccount: boolean;
    /** IAM roles bindings granted to the runtime service account. */
    iamGrants: AppliedIamGrant[];
    /** Hash of the bundled `main` program and its bootstrap (Effect-native only). */
    codeHash: string | undefined;
  },
  GcpHostBinding,
  Providers
>;

export type JobRuntimeContext = HostRuntimeContext;
export type JobServices = Credentials | GcpEnvironment | ServerHost;
/**
 * Effect-native Job shape: a `run` entry that executes to completion
 * when the container starts, and/or a `fetch` HTTP handler.
 */
export type JobShape =
  | void
  | (Exclude<Main<JobServices>, void> & {
      run?: Effect.Effect<
        void,
        never,
        JobServices | PlatformServices | RuntimeContext | Scope
      >;
    });

/**
 * A Cloud Run Job — a container that runs to completion.
 *
 * Changing `jobId` or `location` replaces the job.
 *
 * ### Creating a Job
 * **Example:** Generated name
 * ```typescript
 * const job = yield* GCP.Run.Job("Migrate", {
 *   containers: [
 *     { image: "us-docker.pkg.dev/cloudrun/container/job:latest" },
 *   ],
 * });
 * ```
 *
 * **Example:** Explicit id, labels, and retries
 * ```typescript
 * const job = yield* GCP.Run.Job("Migrate", {
 *   jobId: "order-migrate",
 *   location: "us-central1",
 *   labels: { env: "prod" },
 *   maxRetries: 1,
 *   timeout: "120s",
 *   containers: [
 *     {
 *       image: "us-docker.pkg.dev/cloudrun/container/job:latest",
 *       env: [{ name: "STAGE", value: "prod" }],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Effect-native Job with bindings
 * **Example:** Drain a cache then exit
 * ```typescript
 * export class Warm extends GCP.Run.Job<Warm>()(
 *   "Warm",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const redis = yield* GCP.Redis.ReadWriteRedis(cache);
 *     return {
 *       run: redis.set("warmed", "1"),
 *     };
 *   }).pipe(Effect.provide(GCP.Redis.ReadWriteRedisHttp)),
 * ) {}
 * ```
 *
 * ### Running a Job
 * **Example:** Trigger an execution
 * ```typescript
 * const runJob = yield* GCP.Run.RunJob(job);
 * yield* runJob();
 * ```
 *
 * @resource
 * @category Run
 */
export const Job: Platform<Job, JobServices, JobShape, JobRuntimeContext> =
  Platform("GCP.Run.Job", {
    createRuntimeContext: createContainerRuntimeContext("GCP.Run.Job") as (
      id: string,
    ) => JobRuntimeContext,
  });

export class JobNotResolved extends Data.TaggedError("GCP.Run.JobNotResolved")<{
  name: string;
}> {}

export class JobNotReady extends Data.TaggedError("GCP.Run.JobNotReady")<{
  name: string;
  state: string;
  message: string;
}> {}

export class JobReconciling extends Data.TaggedError("GCP.Run.JobReconciling")<{
  name: string;
  state: string;
}> {}

export class JobStillExists extends Data.TaggedError("GCP.Run.JobStillExists")<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `j${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  return next.length > 0 ? next : "job";
};

const resourceName = (project: string, location: string, jobId: string) =>
  `projects/${project}/locations/${location}/jobs/${jobId}`;

const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const jobsAt = parts.lastIndexOf("jobs");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    jobId:
      jobsAt >= 0 && parts[jobsAt + 1] ? parts[jobsAt + 1]! : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(annotations);

const toId = (id: string, jobId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (jobId !== undefined) return jobId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const HOST_TYPE = "GCP.Run.Job";

const bootstrapFor = (news: JobProps) =>
  makeGcpBootstrap("CloudRunJob", news.handler ?? "default");

const toAttrs = (
  job: cloudrun.GoogleCloudRunV2Job,
  project: string,
  region: string,
  extras: { iamGrants?: AppliedIamGrant[]; codeHash?: string } = {},
): Job["Attributes"] => {
  const name = job.name ?? "";
  const parsed = parseName(name, region);
  const task = job.template?.template;
  const container = task?.containers?.[0];
  return {
    name,
    jobId: parsed.jobId,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(job.labels),
    annotations: userAnnotations(job.annotations),
    uid: job.uid,
    generation: job.generation,
    reconciling: job.reconciling === true,
    createTime: job.createTime,
    updateTime: job.updateTime,
    executionCount: job.executionCount,
    terminalConditionState: job.terminalCondition?.state,
    latestCreatedExecutionName: job.latestCreatedExecution?.name,
    image: container?.image,
    maxRetries: task?.maxRetries,
    timeout: task?.timeout,
    taskCount: job.template?.taskCount,
    parallelism: job.template?.parallelism,
    serviceAccount: task?.serviceAccount,
    managedServiceAccount: isManagedServiceAccount({
      project: parsed.project || project,
      hostType: HOST_TYPE,
      resourceName: name,
      serviceAccount: task?.serviceAccount,
    }),
    iamGrants: extras.iamGrants ?? [],
    codeHash: extras.codeHash,
  };
};

const getByName = (name: string) =>
  cloudrun
    .getProjectsLocationsJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toApiContainers = (
  containers: JobContainer[] | undefined,
): cloudrun.GoogleCloudRunV2ContainerList =>
  (containers ?? []).map((container) => ({
    name: container.name,
    image: container.image,
    command: container.command,
    args: container.args,
    env: container.env?.map((item) => ({
      name: item.name,
      value: item.value,
      valueSource: item.valueSource
        ? {
            secretKeyRef: item.valueSource.secretKeyRef
              ? {
                  secret: item.valueSource.secretKeyRef.secret,
                  version: item.valueSource.secretKeyRef.version,
                }
              : undefined,
          }
        : undefined,
    })),
    workingDir: container.workingDir,
    resources: container.resources
      ? {
          limits: container.resources.limits,
          cpuIdle: container.resources.cpuIdle,
          startupCpuBoost: container.resources.startupCpuBoost,
        }
      : undefined,
    volumeMounts: container.volumeMounts,
  }));

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, current) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return current;
  });

const normalizeDuration = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const match = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(value.trim());
  if (!match) return value;
  return `${Number(match[1])}s`;
};

const comparableEnv = (env: cloudrun.GoogleCloudRunV2EnvVarList | undefined) =>
  [...(env ?? [])]
    .map((item) => ({
      name: item.name ?? "",
      value: item.value ?? "",
      secret: item.valueSource?.secretKeyRef?.secret ?? "",
      version: item.valueSource?.secretKeyRef?.version ?? "",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

const comparableContainers = (containers: JobContainer[] | undefined) =>
  (containers ?? []).map((container) => ({
    name: container.name ?? "",
    image: container.image,
    command: container.command ?? [],
    args: container.args ?? [],
    env: comparableEnv(container.env),
    workingDir: container.workingDir ?? "",
    limits: container.resources?.limits
      ? tagRecord(container.resources.limits)
      : {},
  }));

const comparableObservedContainers = (
  containers: cloudrun.GoogleCloudRunV2ContainerList | undefined,
  desired: JobContainer[] | undefined,
) =>
  (containers ?? []).map((container, index) => {
    const user = desired?.[index];
    return {
      name: user?.name !== undefined ? (container.name ?? "") : "",
      image: container.image ?? "",
      command: container.command ?? [],
      args: container.args ?? [],
      env: comparableEnv(container.env),
      workingDir: container.workingDir ?? "",
      limits: user?.resources?.limits
        ? tagRecord(container.resources?.limits)
        : {},
    };
  });

const desiredTemplate = (
  news: JobProps,
  current: cloudrun.GoogleCloudRunV2Job | undefined,
): cloudrun.GoogleCloudRunV2ExecutionTemplate => {
  const exec = current?.template;
  const task = exec?.template;
  return {
    taskCount: news.taskCount ?? exec?.taskCount,
    parallelism: news.parallelism ?? exec?.parallelism,
    labels: news.executionLabels
      ? toLabels(news.executionLabels)
      : exec?.labels,
    annotations: news.executionAnnotations ?? exec?.annotations,
    template: {
      containers: toApiContainers(news.containers),
      timeout: news.timeout ?? task?.timeout,
      maxRetries: news.maxRetries ?? task?.maxRetries,
      serviceAccount: news.serviceAccount ?? task?.serviceAccount,
      executionEnvironment:
        news.executionEnvironment ?? task?.executionEnvironment,
      encryptionKey: news.encryptionKey ?? task?.encryptionKey,
      vpcAccess: news.vpcAccess ?? task?.vpcAccess,
      volumes: task?.volumes,
      gpuZonalRedundancyDisabled: task?.gpuZonalRedundancyDisabled,
      nodeSelector: task?.nodeSelector,
    },
  };
};

/** Waits on a Cloud Run long-running operation (revisions roll out in minutes). */
const waitForOperation = (
  operation: cloudrun.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean },
) =>
  waitForLongRunningOperation(
    operation,
    (name) => {
      const get = cloudrun.getProjectsLocationsOperations({ name });
      return options?.notFoundOk === true
        ? get.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<LongRunningOperation>({ name, done: true }),
            ),
          )
        : get.pipe(
            // A just-returned operation can briefly 404 on read.
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );
    },
    { budget: "10 minutes" },
  ).pipe(
    // google.rpc.Code NOT_FOUND: the resource was already gone.
    Effect.catchTag("GCP.OperationFailed", (error) =>
      options?.notFoundOk === true && error.code === 5
        ? Effect.succeed<LongRunningOperation>(operation)
        : Effect.fail(error),
    ),
  );

const isPendingJob = (job: cloudrun.GoogleCloudRunV2Job) => {
  const state = job.terminalCondition?.state ?? "";
  return (
    job.reconciling === true ||
    state === "CONDITION_PENDING" ||
    state === "CONDITION_RECONCILING" ||
    state === "" ||
    state === "STATE_UNSPECIFIED"
  );
};

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (job): job is cloudrun.GoogleCloudRunV2Job =>
        job !== undefined && job.deleteTime === undefined,
      () => new JobNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (job) => (job.terminalCondition?.state ?? "") !== "CONDITION_FAILED",
      (job) =>
        new JobNotReady({
          name,
          state: job.terminalCondition?.state ?? "",
          message: job.terminalCondition?.message ?? "job failed",
        }),
    ),
    Effect.filterOrFail(
      (job) => !isPendingJob(job),
      (job) =>
        new JobReconciling({
          name,
          state: job.terminalCondition?.state || "reconciling",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Run.JobReconciling" ||
        error._tag === "GCP.Run.JobNotResolved",
      times: 10,
      schedule: Schedule.spaced("4 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((job) =>
      job === undefined
        ? Effect.void
        : Effect.fail(new JobStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Run.JobStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const JobProvider = () =>
  Provider.succeed(Job, {
    stables: ["name", "jobId", "project", "location", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.jobId ?? output?.jobId;
      const nextId = news.jobId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );

      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;
      const locationChanged = previousLocation !== nextLocation;
      if (idChanged || locationChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      // A code-only change leaves the props untouched; hash the bundled
      // program (and bootstrap) so it still surfaces as an update.
      if (output !== undefined && news.main !== undefined) {
        const images = yield* makeImageSource;
        const hash = yield* images.hash({
          source: { main: news.main, handler: news.handler, build: news.build },
          isExternal: news.isExternal,
          bootstrap: bootstrapFor(news),
        });
        if (hash !== undefined && hash !== output.codeHash) {
          return { action: "update" as const };
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toId(id, olds?.jobId, output?.jobId);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name = output?.name ?? resourceName(env.project, location, jobId);
      const existing = yield* getByName(name);
      if (existing === undefined || existing.deleteTime !== undefined) {
        return undefined;
      }
      const attrs = toAttrs(existing, env.project, env.region, {
        iamGrants: output?.iamGrants,
        codeHash: output?.codeHash,
      });
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* cloudrun.listProjectsLocationsJobs
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.jobs ?? [])),
            Stream.filter(
              (job) =>
                job.deleteTime === undefined &&
                Object.keys(job.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
            ),
            Stream.map((job) => toAttrs(job, env.project, env.region)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toId(id, news.jobId, output?.jobId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, jobId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = userAnnotations(news.annotations);
      const identity = yield* resolveHostIdentity({
        project: env.project,
        hostType: HOST_TYPE,
        resourceName: name,
        userServiceAccount: news.serviceAccount,
        effectNative: news.main !== undefined,
        bindings: bindings as ResourceBinding<GcpHostBinding>[],
        output,
      });
      const serviceAccount = identity.serviceAccount;
      let containers = news.containers;
      let codeHash: string | undefined;
      if (news.main !== undefined) {
        const images = yield* makeImageSource;
        const image = yield* images
          .resolve({
            id,
            source: {
              main: news.main,
              handler: news.handler ?? "default",
              build: news.build,
            },
            repositoryName: rfc1035(`${jobId}-src`),
            location,
            isExternal: news.isExternal,
            bootstrap: bootstrapFor(news),
            session,
          })
          .pipe(Effect.onError(() => identity.cleanup));
        codeHash = image.codeHash;
        const container = news.containers?.[0];
        containers = [
          {
            ...container,
            image: image.imageUri,
            env: mergeContainerEnv(
              container?.env,
              identity.env,
              yield* alchemyRuntimeEnv,
              news.env,
            ),
          },
        ];
      } else {
        const runtimeEnv = { ...identity.env, ...news.env };
        if (Object.keys(runtimeEnv).length > 0 && containers) {
          containers = containers.map((container, index) =>
            index === 0
              ? {
                  ...container,
                  env: mergeContainerEnv(container.env, runtimeEnv),
                }
              : container,
          );
        }
      }
      const effectiveNews: JobProps = { ...news, containers, serviceAccount };

      let current = yield* getByName(name);
      if (current?.deleteTime !== undefined) {
        yield* waitUntilGone(name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* cloudrun
          .createProjectsLocationsJobs({
            parent: `projects/${env.project}/locations/${location}`,
            jobId,
            body: {
              labels: desiredLabels,
              annotations:
                Object.keys(desiredAnnotations).length > 0
                  ? desiredAnnotations
                  : undefined,
              launchStage: news.launchStage,
              binaryAuthorization: news.binaryAuthorization,
              template: desiredTemplate(effectiveNews, undefined),
            },
          })
          .pipe(
            retryActAs,
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
            Effect.onError(() => identity.cleanup),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new JobNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const annotationsChanged =
        news.annotations !== undefined &&
        stable(desiredAnnotations) !==
          stable(userAnnotations(current.annotations));
      const containersChanged =
        stable(comparableContainers(effectiveNews.containers)) !==
        stable(
          comparableObservedContainers(
            current.template?.template?.containers,
            effectiveNews.containers,
          ),
        );
      const timeoutChanged =
        news.timeout !== undefined &&
        normalizeDuration(news.timeout) !==
          normalizeDuration(current.template?.template?.timeout);
      const maxRetriesChanged =
        news.maxRetries !== undefined &&
        (current.template?.template?.maxRetries ?? 3) !== news.maxRetries;
      const taskCountChanged =
        news.taskCount !== undefined &&
        (current.template?.taskCount ?? 1) !== news.taskCount;
      const parallelismChanged =
        news.parallelism !== undefined &&
        (current.template?.parallelism ?? 0) !== news.parallelism;
      const serviceAccountChanged =
        (current.template?.template?.serviceAccount ?? "") !== serviceAccount;
      const executionEnvironmentChanged =
        news.executionEnvironment !== undefined &&
        (current.template?.template?.executionEnvironment ?? "") !==
          news.executionEnvironment;
      const encryptionKeyChanged =
        news.encryptionKey !== undefined &&
        (current.template?.template?.encryptionKey ?? "") !==
          news.encryptionKey;
      const vpcChanged =
        news.vpcAccess !== undefined &&
        stable(news.vpcAccess) !==
          stable(current.template?.template?.vpcAccess);
      const launchStageChanged =
        news.launchStage !== undefined &&
        (current.launchStage ?? "GA") !== news.launchStage;
      const binaryAuthorizationChanged =
        news.binaryAuthorization !== undefined &&
        stable(news.binaryAuthorization) !==
          stable(current.binaryAuthorization);
      const executionLabelsChanged =
        news.executionLabels !== undefined &&
        stable(toLabels(news.executionLabels)) !==
          stable(tagRecord(current.template?.labels));
      const executionAnnotationsChanged =
        news.executionAnnotations !== undefined &&
        stable(tagRecord(news.executionAnnotations)) !==
          stable(tagRecord(current.template?.annotations));

      if (
        labelsChanged ||
        annotationsChanged ||
        containersChanged ||
        timeoutChanged ||
        maxRetriesChanged ||
        taskCountChanged ||
        parallelismChanged ||
        serviceAccountChanged ||
        executionEnvironmentChanged ||
        encryptionKeyChanged ||
        vpcChanged ||
        launchStageChanged ||
        binaryAuthorizationChanged ||
        executionLabelsChanged ||
        executionAnnotationsChanged
      ) {
        const operation = yield* cloudrun.patchProjectsLocationsJobs({
          name,
          body: {
            name,
            labels: desiredLabels,
            annotations:
              news.annotations !== undefined
                ? desiredAnnotations
                : current.annotations,
            launchStage: news.launchStage ?? current.launchStage,
            binaryAuthorization:
              news.binaryAuthorization ?? current.binaryAuthorization,
            template: desiredTemplate(effectiveNews, current),
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new JobNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region, {
        iamGrants: identity.grants,
        codeHash,
      });
    }),

    delete: Effect.fn(function* ({ id, output }) {
      const operation = yield* cloudrun
        .deleteProjectsLocationsJobs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
      // Effect-native hosts build into a per-host repository on reconcile.
      yield* destroyHostImageRepository(
        id,
        output,
        rfc1035(`${output.jobId}-src`),
      );
      yield* releaseHostIdentity(output);
    }),
  });

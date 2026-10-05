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

const DEFAULT_IMAGE = "us-docker.pkg.dev/cloudrun/container/worker-pool";
const MAX_NAME_LENGTH = 49;

export type WorkerPoolEnvVar = {
  /** Environment variable name. */
  name?: string;
  /** Literal value. Mutually exclusive with `valueSource`. */
  value?: string;
  /** Secret Manager source for the value. */
  valueSource?: {
    secretKeyRef?: {
      secret?: string;
      version?: string;
    };
  };
};

export type WorkerPoolContainer = {
  /** DNS_LABEL container name. */
  name?: string;
  /**
   * Container image (Artifact Registry, GCR, or Docker Hub). Required
   * unless `template` is omitted, in which case the public Cloud Run
   * worker-pool image is used.
   */
  image?: string;
  /** Entrypoint. */
  command?: string[];
  /** Arguments to the entrypoint. */
  args?: string[];
  /** Environment variables. */
  env?: WorkerPoolEnvVar[];
  /** CPU / memory / GPU requirements. */
  resources?: {
    /** Resource limits. Keys: `cpu`, `memory`, `nvidia.com/gpu`. */
    limits?: Record<string, string>;
    /** Allocate CPU only during requests. */
    cpuIdle?: boolean;
    /** Boost CPU on startup to reduce cold starts. */
    startupCpuBoost?: boolean;
  };
  /** Working directory. */
  workingDir?: string;
  /** Volume mounts. Names must match `volumes`. */
  volumeMounts?: Array<{
    name: string;
    mountPath: string;
    subPath?: string;
  }>;
  /** Containers that must start before this one. */
  dependsOn?: string[];
};

export type WorkerPoolRevisionTemplate = {
  /** Containers that make up the revision. */
  containers?: WorkerPoolContainer[];
  /** Runtime service account email. Defaults to the project Compute SA. */
  serviceAccount?: string;
  /** Revision labels. */
  labels?: Record<string, string>;
  /** Revision annotations. */
  annotations?: Record<string, string>;
  /** Direct VPC egress / connector. */
  vpcAccess?: cloudrun.GoogleCloudRunV2VpcAccess;
  /** Volumes available to containers. */
  volumes?: cloudrun.GoogleCloudRunV2VolumeList;
  /** CMEK used to encrypt the container image. */
  encryptionKey?: string;
  /** Unique revision name. Generated from the worker pool name if omitted. */
  revision?: string;
  /** Node selector (e.g. GPU accelerator). */
  nodeSelector?: cloudrun.GoogleCloudRunV2NodeSelector;
  /** True if GPU zonal redundancy is disabled. */
  gpuZonalRedundancyDisabled?: boolean;
  /** Service mesh connectivity. */
  serviceMesh?: cloudrun.GoogleCloudRunV2ServiceMesh;
};

export type InstanceSplit = {
  /**
   * Allocation type (`INSTANCE_SPLIT_ALLOCATION_TYPE_LATEST` or
   * `INSTANCE_SPLIT_ALLOCATION_TYPE_REVISION`).
   */
  type?: string;
  /** Revision to assign instances to when allocating by revision. */
  revision?: string;
  /** Percent of instances (0–100). */
  percent?: number;
};

export type WorkerPoolScaling = {
  /** Total instances in manual scaling mode. */
  manualInstanceCount?: number;
};

export type WorkerPoolBinaryAuthorization = {
  /** Use the project's default Binary Authorization policy. */
  useDefault?: boolean;
  /** Breakglass justification. Requires `useDefault`. */
  breakglassJustification?: string;
  /** Policy path `projects/{project}/platforms/cloudRun/{policy}`. */
  policy?: string;
};

export type WorkerPoolProps = PlatformProps & {
  /**
   * Worker pool id (the `{workerPool}` segment of
   * `projects/{project}/locations/{location}/workerPools/{workerPool}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must begin with a letter, not end with a hyphen, and be
   * fewer than 50 characters. Immutable — changing it replaces the pool.
   */
  workerPoolId?: string;
  /**
   * Region (`us-central1`, `europe-west1`, …). Immutable — changing it
   * replaces the pool. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Unstructured annotations. Cloud Run rejects `run.googleapis.com` /
   * `cloud.googleapis.com` / Knative namespaces.
   */
  annotations?: Record<string, string>;
  /**
   * Human-readable description (max 512 characters).
   */
  description?: string;
  /**
   * Launch stage (`GA`, `BETA`, `ALPHA`). Defaults to GA.
   */
  launchStage?: string;
  /**
   * Binary Authorization settings.
   */
  binaryAuthorization?: WorkerPoolBinaryAuthorization;
  /**
   * Instance split. Empty / omitted sends 100% to the latest Ready
   * revision.
   */
  instanceSplits?: InstanceSplit[];
  /**
   * Worker-pool-level scaling (manual instance count).
   */
  scaling?: WorkerPoolScaling;
  /**
   * Revision template. If omitted, a single container runs the public
   * Cloud Run worker-pool image. The Effect-native `main` form fills
   * `image` for you.
   */
  template?: WorkerPoolRevisionTemplate;
  /**
   * Module entrypoint for an Effect-native worker pool (typically
   * `import.meta.url`). Alchemy bundles the program, builds a container,
   * and deploys the pool. Bindings attach env + IAM onto the runtime SA.
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
};

export type WorkerPool = Resource<
  "GCP.Run.WorkerPool",
  WorkerPoolProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/workerPools/{workerPool}`. */
    name: string;
    /** Worker pool id (last path segment). */
    workerPoolId: string;
    /** Project id. */
    project: string;
    /** Region (`us-central1`, …). */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Description. */
    description: string | undefined;
    /** Server-assigned UUID. */
    uid: string | undefined;
    /** Launch stage. */
    launchStage: string | undefined;
    /** Manual instance count. */
    manualInstanceCount: number | undefined;
    /** Latest created revision name. */
    latestCreatedRevision: string | undefined;
    /** Latest Ready revision name. */
    latestReadyRevision: string | undefined;
    /** Terminal condition state (`CONDITION_SUCCEEDED`, …). */
    terminalConditionState: string | undefined;
    /** True while Cloud Run is still reconciling the desired state. */
    reconciling: boolean;
    /** Observed generation. */
    generation: string | undefined;
    /** Image of the first container. */
    image: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Runtime service account email. */
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

export type WorkerPoolRuntimeContext = HostRuntimeContext;
export type WorkerPoolServices = Credentials | GcpEnvironment | ServerHost;
/**
 * Effect-native Worker Pool shape: a `run` entry that executes when
 * the container starts, and/or a `fetch` HTTP handler.
 */
export type WorkerPoolShape =
  | void
  | (Exclude<Main<WorkerPoolServices>, void> & {
      run?: Effect.Effect<
        void,
        never,
        WorkerPoolServices | PlatformServices | RuntimeContext | Scope
      >;
    });

/**
 * A Cloud Run worker pool (pull-based revision + instance split).
 *
 * Changing `workerPoolId` or `location` replaces the pool. Updates to
 * `template` create a new revision.
 *
 * ### Creating a Worker Pool
 * **Example:** Generated name, default worker image
 * ```typescript
 * const pool = yield* GCP.Run.WorkerPool("workers", {});
 * ```
 *
 * **Example:** Explicit id, image, env, and labels
 * ```typescript
 * const pool = yield* GCP.Run.WorkerPool("workers", {
 *   workerPoolId: "order-workers",
 *   location: "us-central1",
 *   description: "order pull workers",
 *   labels: { env: "prod" },
 *   scaling: { manualInstanceCount: 1 },
 *   template: {
 *     containers: [
 *       {
 *         image: "us-docker.pkg.dev/cloudrun/container/worker-pool",
 *         env: [{ name: "ENV", value: "prod" }],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Reading a Worker Pool
 * **Example:** Get the live worker pool
 * ```typescript
 * const getWorkerPool = yield* GCP.Run.GetWorkerPool(pool);
 * const live = yield* getWorkerPool();
 * ```
 *
 * ### Effect-native Worker Pool with bindings
 * **Example:** Pull workers with Memorystore
 * ```typescript
 * export class Workers extends GCP.Run.WorkerPool<Workers>()(
 *   "Workers",
 *   { main: import.meta.url, scaling: { manualInstanceCount: 1 } },
 *   Effect.gen(function* () {
 *     const redis = yield* GCP.Redis.ReadWriteRedis(cache);
 *     return {
 *       run: redis.set("worker", "up"),
 *     };
 *   }).pipe(Effect.provide(GCP.Redis.ReadWriteRedisHttp)),
 * ) {}
 * ```
 *
 * @resource
 * @category Run
 */
export const WorkerPool: Platform<
  WorkerPool,
  WorkerPoolServices,
  WorkerPoolShape,
  WorkerPoolRuntimeContext
> = Platform("GCP.Run.WorkerPool", {
  createRuntimeContext: createContainerRuntimeContext("GCP.Run.WorkerPool") as (
    id: string,
  ) => WorkerPoolRuntimeContext,
});

export class WorkerPoolNotResolved extends Data.TaggedError(
  "GCP.Run.WorkerPoolNotResolved",
)<{
  name: string;
}> {}

export class WorkerPoolNotReady extends Data.TaggedError(
  "GCP.Run.WorkerPoolNotReady",
)<{
  name: string;
  state: string;
  message: string;
}> {}

export class WorkerPoolReconciling extends Data.TaggedError(
  "GCP.Run.WorkerPoolReconciling",
)<{
  name: string;
  state: string;
}> {}

export class WorkerPoolStillExists extends Data.TaggedError(
  "GCP.Run.WorkerPoolStillExists",
)<{
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

const resourceName = (
  project: string,
  location: string,
  workerPoolId: string,
) => `projects/${project}/locations/${location}/workerPools/${workerPoolId}`;

const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const poolsAt = parts.lastIndexOf("workerPools");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    workerPoolId:
      poolsAt >= 0 && parts[poolsAt + 1]
        ? parts[poolsAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(annotations);

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

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `w${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  return next.length > 0 ? next : "workerpool";
};

const toId = (
  id: string,
  workerPoolId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (workerPoolId !== undefined) return workerPoolId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const desiredTemplate = (
  news: WorkerPoolProps,
): cloudrun.GoogleCloudRunV2WorkerPoolRevisionTemplate => {
  const template = news.template ?? {};
  return {
    ...template,
    containers: template.containers ?? [{ image: DEFAULT_IMAGE }],
  };
};

const envFingerprint = (env: cloudrun.GoogleCloudRunV2EnvVarList | undefined) =>
  JSON.stringify(
    [...(env ?? [])]
      .map((item) => ({
        name: item.name ?? "",
        value: item.value ?? "",
        secret: item.valueSource?.secretKeyRef?.secret ?? "",
        version: item.valueSource?.secretKeyRef?.version ?? "",
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );

const containerNeedsSync = (
  desired: cloudrun.GoogleCloudRunV2ContainerList | undefined,
  observed: cloudrun.GoogleCloudRunV2ContainerList | undefined,
) => {
  const want = desired ?? [];
  const have = observed ?? [];
  if (want.length !== have.length) return true;
  return want.some((container, index) => {
    const current = have[index];
    if (current === undefined) return true;
    if ((container.image ?? "") !== (current.image ?? "")) return true;
    if (
      container.command !== undefined &&
      JSON.stringify(container.command) !==
        JSON.stringify(current.command ?? [])
    ) {
      return true;
    }
    if (
      container.args !== undefined &&
      JSON.stringify(container.args) !== JSON.stringify(current.args ?? [])
    ) {
      return true;
    }
    if (
      container.workingDir !== undefined &&
      container.workingDir !== (current.workingDir ?? "")
    ) {
      return true;
    }
    if (
      container.env !== undefined &&
      envFingerprint(container.env) !== envFingerprint(current.env)
    ) {
      return true;
    }
    if (container.resources?.limits !== undefined) {
      const wantLimits = tagRecord(container.resources.limits);
      const haveLimits = tagRecord(current.resources?.limits);
      for (const [key, value] of Object.entries(wantLimits)) {
        if (haveLimits[key] !== value) return true;
      }
    }
    if (
      container.resources?.cpuIdle !== undefined &&
      container.resources.cpuIdle !== current.resources?.cpuIdle
    ) {
      return true;
    }
    if (
      container.resources?.startupCpuBoost !== undefined &&
      container.resources.startupCpuBoost !== current.resources?.startupCpuBoost
    ) {
      return true;
    }
    if (
      container.name !== undefined &&
      container.name !== (current.name ?? "")
    ) {
      return true;
    }
    if (
      container.volumeMounts !== undefined &&
      JSON.stringify(container.volumeMounts) !==
        JSON.stringify(current.volumeMounts ?? [])
    ) {
      return true;
    }
    if (
      container.dependsOn !== undefined &&
      JSON.stringify(container.dependsOn) !==
        JSON.stringify(current.dependsOn ?? [])
    ) {
      return true;
    }
    return false;
  });
};

const scalingFingerprint = (scaling: WorkerPoolScaling | undefined) =>
  JSON.stringify({
    manual: scaling?.manualInstanceCount ?? null,
  });

const instanceSplitFingerprint = (splits: InstanceSplit[] | undefined) =>
  JSON.stringify(
    (splits ?? []).map((split) => ({
      type: split.type ?? "",
      revision: split.revision ?? "",
      percent: split.percent ?? 0,
    })),
  );

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

const templateNeedsSync = (
  desired: cloudrun.GoogleCloudRunV2WorkerPoolRevisionTemplate,
  observed: cloudrun.GoogleCloudRunV2WorkerPoolRevisionTemplate | undefined,
) => {
  const current = observed ?? {};
  if (containerNeedsSync(desired.containers, current.containers)) {
    return true;
  }
  if (
    desired.serviceAccount !== undefined &&
    desired.serviceAccount !== (current.serviceAccount ?? "")
  ) {
    return true;
  }
  if (
    desired.encryptionKey !== undefined &&
    desired.encryptionKey !== (current.encryptionKey ?? "")
  ) {
    return true;
  }
  if (
    desired.revision !== undefined &&
    desired.revision !== (current.revision ?? "")
  ) {
    return true;
  }
  if (
    desired.gpuZonalRedundancyDisabled !== undefined &&
    desired.gpuZonalRedundancyDisabled !==
      (current.gpuZonalRedundancyDisabled === true)
  ) {
    return true;
  }
  if (
    desired.vpcAccess !== undefined &&
    stable(desired.vpcAccess) !== stable(current.vpcAccess ?? {})
  ) {
    return true;
  }
  if (
    desired.volumes !== undefined &&
    stable(desired.volumes) !== stable(current.volumes ?? [])
  ) {
    return true;
  }
  if (
    desired.nodeSelector !== undefined &&
    stable(desired.nodeSelector) !== stable(current.nodeSelector ?? {})
  ) {
    return true;
  }
  if (
    desired.serviceMesh !== undefined &&
    stable(desired.serviceMesh) !== stable(current.serviceMesh ?? {})
  ) {
    return true;
  }
  if (
    desired.labels !== undefined &&
    !recordsEqual(
      userAnnotations(desired.labels),
      userAnnotations(current.labels),
    )
  ) {
    return true;
  }
  if (
    desired.annotations !== undefined &&
    !recordsEqual(
      userAnnotations(desired.annotations),
      userAnnotations(current.annotations),
    )
  ) {
    return true;
  }
  return false;
};

const HOST_TYPE = "GCP.Run.WorkerPool";

// Worker pools have no ingress, so they run the one-shot/loop bootstrap
// (no HTTP server); a long-running `run` keeps the instance alive.
const bootstrapFor = (news: WorkerPoolProps) =>
  makeGcpBootstrap("CloudRunJob", news.handler ?? "default");

const toAttrs = (
  pool: cloudrun.GoogleCloudRunV2WorkerPool,
  project: string,
  region: string,
  extras: { iamGrants?: AppliedIamGrant[]; codeHash?: string } = {},
): WorkerPool["Attributes"] => {
  const name = pool.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    workerPoolId: parsed.workerPoolId,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(pool.labels),
    annotations: userAnnotations(pool.annotations),
    description: pool.description,
    uid: pool.uid,
    launchStage: pool.launchStage,
    manualInstanceCount: pool.scaling?.manualInstanceCount,
    latestCreatedRevision: pool.latestCreatedRevision,
    latestReadyRevision: pool.latestReadyRevision,
    terminalConditionState: pool.terminalCondition?.state,
    reconciling: pool.reconciling === true,
    generation: pool.generation,
    image: pool.template?.containers?.[0]?.image,
    createTime: pool.createTime,
    updateTime: pool.updateTime,
    serviceAccount: pool.template?.serviceAccount,
    managedServiceAccount: isManagedServiceAccount({
      project: parsed.project || project,
      hostType: HOST_TYPE,
      resourceName: name,
      serviceAccount: pool.template?.serviceAccount,
    }),
    iamGrants: extras.iamGrants ?? [],
    codeHash: extras.codeHash,
  };
};

const getByName = (name: string) =>
  cloudrun
    .getProjectsLocationsWorkerPools({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

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

const isPendingPool = (pool: cloudrun.GoogleCloudRunV2WorkerPool) => {
  const state = pool.terminalCondition?.state ?? "";
  return (
    pool.reconciling === true ||
    state === "CONDITION_PENDING" ||
    state === "CONDITION_RECONCILING" ||
    state === "" ||
    state === "STATE_UNSPECIFIED"
  );
};

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (pool): pool is cloudrun.GoogleCloudRunV2WorkerPool =>
        pool !== undefined && pool.deleteTime === undefined,
      () => new WorkerPoolNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (pool) => (pool.terminalCondition?.state ?? "") !== "CONDITION_FAILED",
      (pool) =>
        new WorkerPoolNotReady({
          name,
          state: pool.terminalCondition?.state ?? "",
          message: pool.terminalCondition?.message ?? "revision failed",
        }),
    ),
    Effect.filterOrFail(
      (pool) => !isPendingPool(pool),
      (pool) =>
        new WorkerPoolReconciling({
          name,
          state: pool.terminalCondition?.state || "reconciling",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Run.WorkerPoolReconciling" ||
        error._tag === "GCP.Run.WorkerPoolNotResolved",
      times: 10,
      schedule: Schedule.spaced("4 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((pool) =>
      pool === undefined
        ? Effect.void
        : Effect.fail(new WorkerPoolStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Run.WorkerPoolStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const toCreateBody = (
  news: WorkerPoolProps,
  labels: Record<string, string>,
  template: cloudrun.GoogleCloudRunV2WorkerPoolRevisionTemplate,
): cloudrun.GoogleCloudRunV2WorkerPool => ({
  labels,
  annotations: news.annotations,
  description: news.description,
  launchStage: news.launchStage,
  binaryAuthorization: news.binaryAuthorization,
  instanceSplits: news.instanceSplits,
  scaling: news.scaling,
  template,
});

const listAt = (project: string, location: string, region: string) =>
  cloudrun.listProjectsLocationsWorkerPools
    .pages({
      parent: `projects/${project}/locations/${location}`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.workerPools ?? [])),
      Stream.filter(
        (pool) =>
          pool.deleteTime === undefined &&
          Object.keys(pool.labels ?? {}).some((key) =>
            key.startsWith("alchemy-"),
          ),
      ),
      Stream.map((pool) => toAttrs(pool, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

export const WorkerPoolProvider = () =>
  Provider.succeed(WorkerPool, {
    stables: [
      "name",
      "workerPoolId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.workerPoolId ?? output?.workerPoolId;
      const nextId = news.workerPoolId ?? previousId;
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
      const workerPoolId = yield* toId(
        id,
        olds?.workerPoolId,
        output?.workerPoolId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, workerPoolId);
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
        // WorkerPools list rejects the `-` wildcard; Services/Jobs accept it.
        return yield* listAt(env.project, "-", env.region).pipe(
          Effect.catchTag("LocationWildcardUnsupported", () =>
            // `us-central1` was the default before `GCP.Region`; keep
            // listing it so older pools are still found.
            Effect.forEach(
              [...new Set([env.region, "us-central1"])],
              (location) => listAt(env.project, location, env.region),
            ).pipe(Effect.map((groups) => groups.flat())),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
      const env = yield* GcpEnvironment.current;
      const workerPoolId = yield* toId(
        id,
        news.workerPoolId,
        output?.workerPoolId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, workerPoolId);
      const parent = `projects/${env.project}/locations/${location}`;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations;
      const template = desiredTemplate(news);
      const identity = yield* resolveHostIdentity({
        project: env.project,
        hostType: HOST_TYPE,
        resourceName: name,
        userServiceAccount: template.serviceAccount,
        effectNative: news.main !== undefined,
        bindings: bindings as ResourceBinding<GcpHostBinding>[],
        output,
      });
      template.serviceAccount = identity.serviceAccount;
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
            repositoryName: rfc1035(`${workerPoolId}-src`),
            location,
            isExternal: news.isExternal,
            bootstrap: bootstrapFor(news),
            session,
          })
          .pipe(Effect.onError(() => identity.cleanup));
        codeHash = image.codeHash;
        const container = template.containers?.[0] ?? {};
        template.containers = [
          {
            ...container,
            image: image.imageUri,
            env: mergeContainerEnv(
              container.env,
              identity.env,
              yield* alchemyRuntimeEnv,
              news.env,
            ),
          },
        ];
      } else {
        const runtimeEnv = { ...identity.env, ...news.env };
        if (Object.keys(runtimeEnv).length > 0 && template.containers) {
          template.containers = template.containers.map((container, index) =>
            index === 0
              ? {
                  ...container,
                  env: mergeContainerEnv(container.env, runtimeEnv),
                }
              : container,
          );
        }
      }

      let current = yield* getByName(name);
      if (current?.deleteTime !== undefined) {
        yield* waitUntilGone(name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* cloudrun
          .createProjectsLocationsWorkerPools({
            parent,
            workerPoolId,
            body: toCreateBody(news, desiredLabels, template),
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
        return yield* new WorkerPoolNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const annotationsChanged =
        desiredAnnotations !== undefined &&
        !recordsEqual(
          userAnnotations(current.annotations),
          userAnnotations(desiredAnnotations),
        );
      const launchStageChanged =
        news.launchStage !== undefined &&
        (current.launchStage ?? "GA") !== news.launchStage;
      const binaryAuthorizationChanged =
        news.binaryAuthorization !== undefined &&
        stable(news.binaryAuthorization) !==
          stable(current.binaryAuthorization);
      const scalingChanged =
        news.scaling !== undefined &&
        scalingFingerprint(current.scaling) !==
          scalingFingerprint(news.scaling);
      const instanceSplitsChanged =
        news.instanceSplits !== undefined &&
        instanceSplitFingerprint(current.instanceSplits) !==
          instanceSplitFingerprint(news.instanceSplits);
      const templateChanged =
        news.template !== undefined &&
        templateNeedsSync(template, current.template);

      if (
        labelsChanged ||
        descriptionChanged ||
        annotationsChanged ||
        launchStageChanged ||
        binaryAuthorizationChanged ||
        scalingChanged ||
        instanceSplitsChanged ||
        templateChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          annotationsChanged ? "annotations" : undefined,
          launchStageChanged ? "launchStage" : undefined,
          binaryAuthorizationChanged ? "binaryAuthorization" : undefined,
          scalingChanged ? "scaling" : undefined,
          instanceSplitsChanged ? "instanceSplits" : undefined,
          templateChanged ? "template" : undefined,
        ].filter((field): field is string => field !== undefined);

        const patched = yield* cloudrun.patchProjectsLocationsWorkerPools({
          name,
          updateMask: updateMask.join(","),
          body: {
            name,
            labels: desiredLabels,
            description: news.description,
            annotations: desiredAnnotations,
            launchStage: news.launchStage,
            binaryAuthorization: news.binaryAuthorization,
            scaling: news.scaling,
            instanceSplits: news.instanceSplits,
            template,
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new WorkerPoolNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region, {
        iamGrants: identity.grants,
        codeHash,
      });
    }),

    delete: Effect.fn(function* ({ id, output }) {
      const operation = yield* cloudrun
        .deleteProjectsLocationsWorkerPools({ name: output.name })
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
      // Effect-native hosts build into a per-host repository on reconcile.
      yield* destroyHostImageRepository(
        id,
        output,
        rfc1035(`${output.workerPoolId}-src`),
      );
      yield* releaseHostIdentity(output);
    }),
  });

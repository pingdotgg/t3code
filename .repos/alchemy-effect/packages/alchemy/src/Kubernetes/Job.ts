import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import {
  Platform,
  type PlatformProps,
  type PlatformServices,
} from "../Platform.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  packEnvValue,
  unpackEnvValue,
  RuntimeContext,
} from "../RuntimeContext.ts";
import type { HostRuntimeContext } from "../Server/Process.ts";
import { Stack } from "../Stack.ts";
import { createInternalTags } from "../Tags.ts";
import * as Output from "../Output.ts";
import { sha256Object } from "../Util/sha256.ts";
import {
  findClusterAdapter,
  type IdentityState,
  type RegistryState,
  type WorkloadBindingContract,
  type WorkloadIdentityOptions,
  type WorkloadImageSource,
  type WorkloadServices,
} from "./ClusterAdapter.ts";
import {
  toConnection,
  type ClusterLike,
  type Connection,
} from "./Connection.ts";
import {
  connectCluster,
  deleteObjects,
  readObject,
  reconcileObjects,
  KubernetesApiError,
} from "./internal/client.ts";
import type {
  KubernetesObjectDefinition,
  KubernetesObjectRef,
} from "./internal/objects.ts";
import {
  collectBindingEnv,
  connectionIdentity,
  connectionOfOutput,
  deepMerge,
  imagePlatformOf,
  makeJobBootstrap,
  resolveWorkloadImage,
  tryConnectionOf,
  workloadImageHash,
} from "./internal/workload.ts";
import type { Providers } from "./Providers.ts";

export const isJob = (value: any): value is Job => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "Kubernetes.Job"
  );
};

export interface JobPropsBase extends PlatformProps {
  /**
   * Target cluster the job runs on. Pass a managed cluster resource (e.g.
   * `AWS.EKS.Cluster`), a `Kubernetes.KubeConfig(...)`, or a raw
   * `Kubernetes.Connection`.
   */
  cluster: ClusterLike;
  /**
   * Base name for the generated Job / ServiceAccount. If omitted, a
   * deterministic name is derived from the stack, stage, and logical id.
   */
  name?: string;
  /**
   * Kubernetes namespace to run in. The namespace must already exist.
   * @default "default"
   */
  namespace?: string;
  /**
   * Number of retries before the Job is marked failed (Kubernetes
   * `backoffLimit`).
   */
  backoffLimit?: number;
  /**
   * Cron schedule (standard 5-field cron, e.g. `"0 3 * * *"`). When set, a
   * Kubernetes `CronJob` is synthesized instead of a plain `Job`.
   */
  schedule?: string;
  /**
   * Restart policy for the job's pods.
   * @default "Never"
   */
  restartPolicy?: "Never" | "OnFailure";
  /**
   * Seconds after completion before the finished Job is garbage-collected
   * (Kubernetes `ttlSecondsAfterFinished`).
   */
  ttlSecondsAfterFinished?: number;
  /**
   * Container entrypoint override (Kubernetes `command`). Mostly useful with
   * `image` / `context` sources.
   */
  command?: string[];
  /**
   * Container arguments (Kubernetes `args`).
   */
  args?: string[];
  /**
   * Container CPU/memory requests + limits (Kubernetes resource quantities).
   */
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  /**
   * Additional environment variables for the container.
   */
  env?: Record<string, any>;
  /**
   * Container image build architecture.
   * @default "amd64"
   */
  architecture?: "amd64" | "arm64";
  /**
   * Deep-partial Kubernetes Pod template merged into the synthesized
   * template (objects merge recursively; arrays and primitives replace) —
   * a literal object in the shape of `PodTemplateSpec`, e.g.
   * `{ spec: { tolerations: [...], nodeSelector: {...} } }`.
   */
  podTemplate?: Record<string, unknown>;
  /**
   * Cloud-specific workload-identity options, consumed by the cluster
   * platform's identity adapter (on EKS: `{ managedPolicyArns: [...] }`
   * attaches extra managed policies to the generated pod-identity role).
   */
  identity?: WorkloadIdentityOptions;
  /**
   * Job / pod labels, merged over the generated `app.kubernetes.io/name`
   * label.
   */
  labels?: Record<string, string>;
  /**
   * User-defined tags applied to workload-owned cloud resources (identity
   * roles, image repositories).
   */
  tags?: Record<string, string>;
}

/** Bundle an inline Effect program (`main`) into a generated image. */
export interface BundledJobProps extends JobPropsBase {
  /**
   * Module entrypoint for the bundled program. This should typically be
   * `import.meta.url` from an inline Effect program.
   */
  main: string;
  /**
   * Environment image used as the generated Dockerfile's `FROM`; must be
   * able to run the bun runtime.
   * @default "oven/bun:1"
   */
  image?: string;
  /** Named export to load from `main`. @default "default" */
  handler?: string;
  /** Bundler configuration for the entrypoint. */
  build?: WorkloadImageSource["build"];
  /** Environment Dockerfile (path or inline content). */
  dockerfile?: WorkloadImageSource["dockerfile"];
  /** Build context for a path {@link dockerfile} environment. */
  context?: string;
}

/** Build the user's own Dockerfile (`context` + optional `dockerfile` path). */
export interface DockerfileJobProps extends JobPropsBase {
  /** Docker build context directory. */
  context?: string;
  /**
   * Path to the Dockerfile (relative to the cwd), or inline content.
   * @default `${context}/Dockerfile`
   */
  dockerfile?: WorkloadImageSource["dockerfile"];
}

/** Run a pre-built registry image. */
export interface ImageJobProps extends JobPropsBase {
  /**
   * A pre-built image reference, e.g. `ghcr.io/acme/migrator:v3`. On
   * clusters with a managed registry (EKS) the image is mirrored into it;
   * elsewhere the reference is used verbatim.
   */
  image: string;
}

export type JobProps = BundledJobProps | DockerfileJobProps | ImageJobProps;

export interface Job extends Resource<
  "Kubernetes.Job",
  JobProps,
  {
    /** The connection of the cluster the job runs on. */
    connection: Connection;
    /** The Kubernetes namespace the job's objects live in. */
    namespace: string;
    /** The Kubernetes kind synthesized for the workload (`Job`, or `CronJob` when `schedule` is set). */
    kind: "Job" | "CronJob";
    /** The name of the Kubernetes Job/CronJob object. */
    jobName: string;
    /** The cron schedule, when the workload is a CronJob. */
    schedule: string | undefined;
    /** The name of the service account the pods run as. */
    serviceAccountName: string;
    /** The URI of the container image the job runs. */
    imageUri: string;
    /**
     * Workload-identity state provisioned by the cluster platform's
     * adapter (on EKS: the pod-identity role + association).
     */
    identity: IdentityState | undefined;
    /**
     * Image-registry state provisioned by the cluster platform's adapter
     * (on EKS: the ECR repository).
     */
    registry: RegistryState | undefined;
    /** References to the Kubernetes objects created for the job. */
    kubernetesObjects: KubernetesObjectRef[];
    /** The content hash of the container image source. */
    code: {
      hash: string;
    };
  },
  WorkloadBindingContract,
  Providers
> {}

export type JobServices = WorkloadServices;

/**
 * The impl shape: `{ run, ...rpc }`. `run` executes to completion inside
 * the pod; the process exits when it returns.
 */
export type JobMain<InitServices = never> = void | {
  run?: Effect.Effect<
    void,
    never,
    InitServices | PlatformServices | RuntimeContext | Scope
  >;
};

export type JobShape = JobMain<JobServices>;

export interface JobRuntimeContext extends HostRuntimeContext {
  readonly Type: "Kubernetes.Job";
}

/**
 * Run-to-completion Kubernetes compute on any cluster — the Kubernetes
 * analog of `AWS.ECS.Task`.
 *
 * `Job` provisions a Kubernetes `Job` (or `CronJob` when `schedule` is
 * set) via server-side apply and a ServiceAccount, plus — through the
 * target cluster's platform adapter — workload identity and a container
 * image from exactly one of three sources flat on props: `main` (bundle an
 * inline Effect program whose impl returns `{ run }`), `context` (build
 * your own Dockerfile), or `image` (a pre-built registry reference). On
 * `AWS.EKS.Cluster` targets, bindings attach env vars to the pod and IAM
 * policy statements to a generated pod-identity role, exactly like
 * `Kubernetes.Deployment`.
 * ### Creating a Job
 * **Example:** Remote image (external — no Effect runtime in the container)
 * ```typescript
 * const migrate = yield* Kubernetes.Job("DbMigrate", {
 *   cluster,
 *   image: "ghcr.io/acme/migrator:v3",
 *   backoffLimit: 2,
 * });
 * ```
 *
 * **Example:** Inline Effect program with a DynamoDB binding (EKS)
 * ```typescript
 * const seed = yield* Kubernetes.Job(
 *   "SeedData",
 *   { cluster, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const putItem = yield* AWS.DynamoDB.PutItem(table);
 *     return {
 *       run: Effect.gen(function* () {
 *         yield* putItem({ Item: { id: { S: "seed" } } });
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.DynamoDB.PutItemHttp)),
 * );
 * ```
 *
 * **Example:** Tagged Effect program
 * ```typescript
 * export class Backfill extends Kubernetes.Job<Backfill, {
 *   progress: () => Effect.Effect<number>;
 * }>()("Backfill") {}
 *
 * export default Backfill.make(
 *   { cluster, main: import.meta.url, backoffLimit: 1 },
 *   Effect.gen(function* () {
 *     return {
 *       run: Effect.gen(function* () { }),
 *       progress: () => Effect.succeed(0),
 *     };
 *   }),
 * );
 * ```
 *
 * ### Bundling & Tree-shaking
 * `main` is bundled with rolldown at deploy time. Top-level calls in the
 * `effect`, `@effect/*`, `alchemy`, `@alchemy.run/*`, and
 * `@distilled.cloud/*` packages receive `#__PURE__` annotations by
 * default, so anything the job doesn't use from those packages is
 * tree-shaken out of the bundle. Any other package — including your own
 * app — is left untouched unless you list it explicitly.
 *
 * **Example:** Treat additional packages as pure
 * Pass package names (or picomatch globs) via `build.pure.packages` to
 * annotate them in addition to the defaults.
 * ```typescript
 * {
 *   main: import.meta.url,
 *   build: {
 *     pure: { packages: ["my-lib", "@my-scope/*"] },
 *   },
 * }
 * ```
 *
 * Listing a package annotates calls whose result is bound (variable
 * initializers, exports) — safe anywhere. If a listed package also
 * declares `"sideEffects": false` (or `[]`) in its `package.json`, that
 * combination opts it into full annotation: top-level calls whose result
 * is discarded (e.g. `router.on("/path", handler)` registrations) are
 * also marked pure and deleted under minification when unused. Only list
 * a `sideEffects: false` package if its modules really are free of
 * meaningful top-level side effects. The `effect`, `alchemy`, and
 * `@distilled.cloud` defaults declare exactly that, on purpose — their
 * modules are designed to be fully tree-shakeable.
 *
 * **Example:** Disable pure annotations
 * ```typescript
 * {
 *   main: import.meta.url,
 *   build: { pure: false },
 * }
 * ```
 *
 * ### Scheduling
 * **Example:** Nightly CronJob
 * ```typescript
 * const nightly = yield* Kubernetes.Job("NightlyBackfill", {
 *   cluster,
 *   main: import.meta.url,
 *   schedule: "0 3 * * *",
 * });
 * ```
 *
 * @resource
 */
export const Job: Platform<Job, JobServices, JobShape, JobRuntimeContext> =
  Platform("Kubernetes.Job", {
    aliases: ["AWS.EKS.Job"],
    createRuntimeContext: (id: string): JobRuntimeContext => {
      // A one-shot host context: `serve` (invoked by the Platform machinery
      // with the impl shape) registers the shape's `run` effect as the
      // program instead of an HTTP server, so the generated entry executes
      // it to completion and exits.
      const runners: Effect.Effect<void, never, any>[] = [];
      const env: Record<string, any> = {};
      const context: JobRuntimeContext = {
        Type: "Kubernetes.Job",
        id,
        env,
        set: (bindingId: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
            env[key] = output.pipe(Output.map(packEnvValue));
            return key;
          }),
        get: <T>(key: string) =>
          Effect.sync(() => unpackEnvValue<T>(process.env[key]) as T),
        run: (effect: Effect.Effect<void, never, any>) =>
          Effect.sync(() => {
            runners.push(effect);
          }),
        serve: ((_handler, options) =>
          Effect.sync(() => {
            const run = options?.shape?.run;
            if (Effect.isEffect(run)) {
              runners.push(run as Effect.Effect<void, never, any>);
            }
          })) as HostRuntimeContext["serve"],
        exports: Effect.sync(() => ({
          program: Effect.all(runners, { concurrency: "unbounded" }).pipe(
            Effect.asVoid,
          ),
        })),
      };
      return context;
    },
  });

const isNotFound = (error: unknown): error is KubernetesApiError =>
  error instanceof KubernetesApiError && error.statusCode === 404;

export const JobProvider = () =>
  Provider.effect(
    Job,
    Effect.gen(function* () {
      const stack = yield* Stack;

      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      const toBaseName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 200, lowercase: true }).pipe(
              Effect.map((name) => name.replaceAll(/[^a-z0-9-]/g, "-")),
            );

      return {
        stables: [
          "connection",
          "namespace",
          "serviceAccountName",
          "identity",
          "registry",
        ],
        // A Job's identity spans in-cluster Kubernetes objects plus
        // adapter-owned cloud resources — no single enumeration
        // reconstructs the composite, so enumeration is empty; `read`
        // refreshes known instances.
        list: () => Effect.succeed([] as Job["Attributes"][]),
        diff: Effect.fn(function* ({ olds = {} as JobProps, news, output }) {
          if (!isResolved(news)) return;
          const oldCluster = connectionIdentity(tryConnectionOf(olds.cluster));
          const newCluster = connectionIdentity(tryConnectionOf(news.cluster));
          if (
            oldCluster !== undefined &&
            newCluster !== undefined &&
            oldCluster !== newCluster
          ) {
            return { action: "replace" } as const;
          }
          if (
            oldCluster !== undefined &&
            (olds.namespace ?? "default") !== (news.namespace ?? "default")
          ) {
            return { action: "replace" } as const;
          }
          // Content drift (see Deployment).
          const connection = tryConnectionOf(news.cluster);
          if (output && connection) {
            const adapter = yield* findClusterAdapter(connection.auth.kind);
            const source = news as WorkloadImageSource;
            const hash = yield* workloadImageHash({
              adapter,
              source,
              platform: imagePlatformOf(news.architecture),
              isExternal: news.isExternal,
              bootstrap: (adapter.bootstrap?.job ?? makeJobBootstrap)(
                source.handler ?? "default",
              ),
            });
            if (hash !== undefined && hash !== output.code.hash) {
              return { action: "update" } as const;
            }
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const connection = connectionOfOutput(output);
          if (!connection) return undefined;
          const transport = yield* connectCluster(connection).pipe(
            Effect.catchTag("Kubernetes.ClusterNotFoundError", () =>
              Effect.succeed(undefined),
            ),
            // Transient unreachability must not read as "gone".
            Effect.catch(() => Effect.succeed("unreachable" as const)),
          );
          if (transport === undefined) return undefined;
          if (transport === "unreachable") return output;
          // The ServiceAccount is the stable existence anchor: one-shot Job
          // objects are content-addressed and may have been TTL-collected.
          const anchor = (output.kubernetesObjects ?? [])[0];
          if (!anchor) return output;
          const observed = yield* readObject({
            transport,
            object: anchor,
          }).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
            Effect.catch(() => Effect.succeed(output)),
          );
          if (observed === undefined) return undefined;
          return output;
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          bindings,
          output,
          session,
        }) {
          const connection = toConnection(news.cluster);
          const adapter = yield* findClusterAdapter(connection.auth.kind);
          const transport = yield* adapter.connect(connection);
          const namespace = news.namespace ?? "default";

          const baseName = yield* toBaseName(id, news);
          const serviceAccountName = output?.serviceAccountName ?? baseName;
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          const { env: bindingEnv, grantKeys } = collectBindingEnv(bindings);
          if (grantKeys.length > 0 && adapter.identity === undefined) {
            return yield* Effect.die(
              new Error(
                `'${id}': bindings carry cloud credential grants ` +
                  `(${grantKeys.join(", ")}) but this cluster's platform ` +
                  "has no workload-identity adapter. Target a managed " +
                  "cluster (e.g. AWS.EKS.Cluster) or bind through " +
                  "environment variables instead.",
              ),
            );
          }
          const identity = adapter.identity
            ? yield* adapter.identity.reconcile({
                id,
                connection,
                namespace,
                serviceAccount: serviceAccountName,
                bindings,
                options: news.identity,
                state:
                  (output?.identity as Record<string, unknown> | undefined) ??
                  (output as Record<string, unknown> | undefined),
                tags,
              })
            : undefined;

          // Resolve the container image (`main` | `context` | `image`).
          const source = news as WorkloadImageSource;
          const resolved = yield* resolveWorkloadImage({
            adapter,
            id,
            source,
            platform: imagePlatformOf(news.architecture),
            isExternal: news.isExternal,
            bootstrap: (adapter.bootstrap?.job ?? makeJobBootstrap)(
              source.handler ?? "default",
            ),
            tags,
            state:
              (output?.registry as Record<string, unknown> | undefined) ??
              (output as Record<string, unknown> | undefined),
            session,
          });

          // Synthesize the Kubernetes objects. The generated name label is
          // always present so selectors and Kueue-style extra labels
          // compose without erasing the workload's identity label.
          const labels = {
            "app.kubernetes.io/name": baseName,
            ...news.labels,
          };
          const containerEnv = {
            ...bindingEnv,
            ...identity?.env,
            ...alchemyEnv,
            ...news.env,
          };

          const serviceAccountObject: KubernetesObjectDefinition = {
            apiVersion: "v1",
            kind: "ServiceAccount",
            metadata: {
              name: serviceAccountName,
              namespace,
              labels,
              ...(identity?.serviceAccountAnnotations
                ? { annotations: identity.serviceAccountAnnotations }
                : {}),
            },
          };
          const podTemplate = deepMerge(
            {
              metadata: { labels },
              spec: {
                serviceAccountName,
                restartPolicy: news.restartPolicy ?? "Never",
                containers: [
                  {
                    name: baseName,
                    image: resolved.imageUri,
                    command: news.command,
                    args: news.args,
                    env: Object.entries(containerEnv).map(([name, value]) => ({
                      name,
                      value:
                        typeof value === "string"
                          ? value
                          : JSON.stringify(value),
                    })),
                    resources: news.resources,
                  },
                ],
              },
            },
            news.podTemplate,
          );
          const jobSpec = {
            backoffLimit: news.backoffLimit,
            ttlSecondsAfterFinished: news.ttlSecondsAfterFinished,
            template: podTemplate,
          };

          const kind: "Job" | "CronJob" = news.schedule ? "CronJob" : "Job";

          // A Kubernetes Job's pod template is immutable after creation, so
          // one-shot Jobs are content-addressed: the object name embeds a
          // hash of the spec, and a spec change applies a NEW Job (which
          // runs) while `reconcileObjects` deletes the previous one.
          // CronJobs are mutable and keep the stable base name.
          // Kubernetes rejects Job names over 63 characters (the API
          // stamps the name into the batch.kubernetes.io/job-name pod
          // label, and label values cap at 63) — truncate the base so the
          // content-address suffix always fits.
          const jobName = news.schedule
            ? baseName.slice(0, 52).replace(/-+$/, "")
            : `${baseName.slice(0, 54).replace(/-+$/, "")}-${(yield* sha256Object(jobSpec)).slice(0, 8)}`;

          const workloadObject: KubernetesObjectDefinition = news.schedule
            ? {
                apiVersion: "batch/v1",
                kind: "CronJob",
                metadata: { name: jobName, namespace, labels },
                spec: {
                  schedule: news.schedule,
                  jobTemplate: {
                    metadata: { labels },
                    spec: jobSpec,
                  },
                },
              }
            : {
                apiVersion: "batch/v1",
                kind: "Job",
                metadata: { name: jobName, namespace, labels },
                spec: jobSpec,
              };

          const desiredObjects = [serviceAccountObject, workloadObject];

          const kubernetesObjects = yield* reconcileObjects({
            transport,
            previousObjects: output?.kubernetesObjects ?? [],
            desiredObjects,
          });

          yield* session.note(
            `Applied Kubernetes ${kind} ${namespace}/${jobName}`,
          );

          return {
            connection,
            namespace,
            kind,
            jobName,
            schedule: news.schedule,
            serviceAccountName,
            imageUri: resolved.imageUri,
            identity: identity?.state,
            registry: resolved.state,
            kubernetesObjects,
            code: { hash: resolved.codeHash },
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const connection = connectionOfOutput(output);
          if (!connection) return;
          const adapter = yield* findClusterAdapter(connection.auth.kind);

          // Delete the in-cluster objects; skip when the cluster is gone
          // (cluster-scoped state dies with it) and still clean up the
          // adapter-owned cloud resources that outlive it.
          const transport = yield* adapter
            .connect(connection)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (transport && (output.kubernetesObjects ?? []).length > 0) {
            yield* deleteObjects({
              transport,
              objects: output.kubernetesObjects ?? [],
            }).pipe(Effect.catch(() => Effect.void));
          }

          if (adapter.identity) {
            yield* adapter.identity.delete({
              connection,
              state:
                (output.identity as Record<string, unknown> | undefined) ??
                (output as Record<string, unknown>),
            });
          }
          if (adapter.registry) {
            yield* adapter.registry.delete({
              state:
                (output.registry as Record<string, unknown> | undefined) ??
                (output as Record<string, unknown>),
            });
          }
        }),
      };
    }),
  );

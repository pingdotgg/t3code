import * as ecr from "@distilled.cloud/aws/ecr";
import * as eks from "@distilled.cloud/aws/eks";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  Platform,
  type PlatformProps,
  type PlatformServices,
} from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Self } from "../../Self.ts";
import { Resource } from "../../Resource.ts";
import {
  packEnvValue,
  unpackEnvValue,
  RuntimeContext,
} from "../../RuntimeContext.ts";
import type { HostRuntimeContext } from "../../Server/Process.ts";
import { Stack } from "../../Stack.ts";
import { createInternalTags } from "../../Tags.ts";
import * as Output from "../../Output.ts";
import { sha256Object } from "../../Util/sha256.ts";
import type { Credentials } from "../Credentials.ts";
import {
  computeStaticSourceHash,
  makeImageSource,
  type BundledImageSource,
  type DockerfileImageSource,
  type ImageSourceLike,
  type RegistryImageSource,
} from "../ECR/ImageSource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import {
  hyperpodNamespace,
  hyperpodNodeSelector,
  hyperpodWorkloadLabels,
  type HyperPodWorkloadProps,
} from "./HyperPod.ts";
import { reconcileObjects, deleteObjects } from "./internal/client.ts";
import type {
  KubernetesObjectDefinition,
  KubernetesObjectRef,
} from "./internal/objects.ts";
import {
  attachBindings,
  deepMerge,
  deleteAssociation,
  deletePodRole,
  ensureAssociation,
  ensurePodRole,
  toConnection,
  type ClusterConnectionProps,
} from "./internal/podIdentity.ts";

export const isJob = (value: any): value is Job => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "AWS.EKS.Job"
  );
};

export interface JobPropsBase extends PlatformProps {
  /**
   * Target EKS cluster the job runs on. Pass the `AWS.EKS.Cluster` resource;
   * the Job reads its `endpoint` / `certificateAuthorityData` to apply the
   * Kubernetes objects via server-side apply.
   */
  cluster: ClusterConnectionProps;
  /**
   * Base name for the generated Job / ServiceAccount / IAM role. If omitted,
   * the logical id is used.
   */
  name?: string;
  /**
   * Kubernetes namespace to run in. The namespace must already exist (Auto
   * Mode clusters ship a `default` namespace).
   * @default "default" (or `hyperpod-ns-<team>` when `hyperpod.quota` is set)
   */
  namespace?: string;
  /**
   * Run on SageMaker HyperPod nodes attached to this EKS cluster: pin to an
   * instance group, keep off unhealthy nodes, and optionally submit through
   * HyperPod task governance by passing the team's
   * `AWS.SageMaker.ComputeQuota` (which derives the namespace and Kueue
   * labels).
   */
  hyperpod?: HyperPodWorkloadProps;
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
   * Docker image build architecture. Auto Mode's default node pools are
   * `linux/amd64`; select `arm64` for Graviton node pools.
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
   * Managed policy ARNs attached to the generated pod-identity role in
   * addition to the inline policy synthesized from bindings.
   */
  roleManagedPolicyArns?: string[];
  /**
   * Job / pod labels.
   */
  labels?: Record<string, string>;
  /**
   * User-defined tags to apply to Job-owned AWS resources.
   */
  tags?: Record<string, string>;
}

/** Bundle an inline Effect program (`main`) into a generated image. */
export interface BundledJobProps extends JobPropsBase, BundledImageSource {}

/** Build the user's own Dockerfile (`context` + optional `dockerfile` path). */
export interface DockerfileJobProps
  extends JobPropsBase, DockerfileImageSource {}

/** Run a pre-built registry image (mirrored into ECR). */
export interface ImageJobProps extends JobPropsBase, RegistryImageSource {}

export type JobProps = BundledJobProps | DockerfileJobProps | ImageJobProps;

export interface Job extends Resource<
  "AWS.EKS.Job",
  JobProps,
  {
    /** The name of the EKS cluster the job runs on. */
    clusterName: string;
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
    /** The name of the ECR repository holding the image. */
    repositoryName: string;
    /** The URI of the ECR repository holding the image. */
    repositoryUri: string;
    /** The ARN of the IAM role pods assume via Pod Identity. */
    roleArn: string;
    /** The name of the IAM role pods assume via Pod Identity. */
    roleName: string;
    /** The ARN of the Pod Identity association binding the role. */
    associationArn: string;
    /** The ID of the Pod Identity association binding the role. */
    associationId: string;
    /** References to the Kubernetes objects created for the job. */
    kubernetesObjects: KubernetesObjectRef[];
    /** The content hash of the container image source. */
    code: {
      hash: string;
    };
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  },
  Providers
> {}

export type JobServices = Credentials | Region | AWSEnvironment;

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
  readonly Type: "AWS.EKS.Job";
}

/**
 * Run-to-completion Kubernetes compute on Amazon EKS — the Kubernetes analog
 * of `AWS.ECS.Task`.
 *
 * `Job` provisions a Kubernetes `Job` (or `CronJob` when `schedule` is set)
 * via server-side apply, a pod-identity IAM role + `PodIdentityAssociation`
 * and service account, and a container image from exactly one of three
 * sources flat on props: `main` (bundle an inline Effect program whose impl
 * returns `{ run }`), `context` (build your own Dockerfile), or `image` (a
 * registry reference, mirrored into ECR). Bindings attach env vars to the pod
 * and IAM policy statements to the pod-identity role, exactly like
 * `AWS.EKS.Deployment`.
 * @resource
 * @section Creating a Job
 * @example Remote image (external — no Effect runtime in the container)
 * ```typescript
 * const migrate = yield* AWS.EKS.Job("DbMigrate", {
 *   cluster,
 *   image: "ghcr.io/acme/migrator:v3",
 *   backoffLimit: 2,
 * });
 * ```
 *
 * @example Inline Effect program with a DynamoDB binding
 * ```typescript
 * const seed = yield* AWS.EKS.Job(
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
 * @example Tagged Effect program
 * ```typescript
 * export class Backfill extends AWS.EKS.Job<Backfill, {
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
 * @section Scheduling
 * @example Nightly CronJob
 * ```typescript
 * const nightly = yield* AWS.EKS.Job("NightlyBackfill", {
 *   cluster,
 *   main: import.meta.url,
 *   schedule: "0 3 * * *",
 * });
 * ```
 */
export const Job: Platform<Job, JobServices, JobShape, JobRuntimeContext> =
  Platform("AWS.EKS.Job", {
    createRuntimeContext: (id: string): JobRuntimeContext => {
      // A one-shot host context: `serve` (invoked by the Platform machinery
      // with the impl shape) registers the shape's `run` effect as the
      // program instead of an HTTP server, so the generated entry executes
      // it to completion and exits.
      const runners: Effect.Effect<void, never, any>[] = [];
      const env: Record<string, any> = {};
      const context: JobRuntimeContext = {
        Type: "AWS.EKS.Job",
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

/**
 * Generated container entry for an Effect-native EKS Job: resolves the
 * program's `run` effect, executes it to completion, and exits. No HTTP
 * server is started. Credentials use the full chain so EKS Pod Identity's
 * container-credentials endpoint resolves inside the pod.
 */
export const makeEksJobBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { BunServices } from "@effect/platform-bun";
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "alchemy/Runtime";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "@distilled.cloud/aws/Region";

import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

// Normalize the entrypoint export: an inline-effect class default export is
// an Effect resolving the platform instance, while the tagged form
// (X.make(props, impl)) exports a Layer providing the Self tag. Both fold
// into a Layer via makeEntrypointLayer (same pattern as the ECS/Lambda/
// Cloudflare Container bridges).
const tag = Context.Service("${Self.key}");
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

// Resolve the bundled program's registered one-shot runners (the shape's
// \`run\` effect and any host.run work) and execute them to completion.
const program = tag.pipe(
  Effect.flatMap((host) => host.RuntimeContext.exports),
  Effect.flatMap((exports) => exports.program),
  Effect.provide(
    layer.pipe(Layer.provideMerge(Layer.effect(
      Stack,
      Effect.all([
        Config.string("ALCHEMY_STACK_NAME"),
        Config.string("ALCHEMY_STAGE")
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    )),
      Layer.provideMerge(Credentials.fromChain()),
      Layer.provideMerge(Region.fromEnv()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env)
        )
      ),
    )
  ),
  Effect.scoped
);

console.log("EKS Job bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("EKS Job bootstrap failed:", err);
  process.exit(1);
});
// Run-to-completion semantics: exit 0 explicitly so lingering handles
// (sockets, timers) never keep the pod alive after the work is done.
process.exit(0);
`;

const imagePlatformOf = (architecture: "amd64" | "arm64" | undefined) =>
  architecture === "arm64" ? "linux/arm64" : "linux/amd64";

export const JobProvider = () =>
  Provider.effect(
    Job,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const imageSource = yield* makeImageSource;

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

      const createRoleName = (id: string) =>
        createPhysicalName({ id: `${id}-pod-role`, maxLength: 64 });

      const createPolicyName = (id: string) =>
        createPhysicalName({ id: `${id}-pod-policy`, maxLength: 128 });

      const createRepositoryName = (id: string) =>
        createPhysicalName({
          id: `${id}-repo`,
          maxLength: 256,
          lowercase: true,
        });

      return {
        stables: [
          "repositoryName",
          "repositoryUri",
          "roleArn",
          "roleName",
          "clusterName",
          "namespace",
          "serviceAccountName",
        ],
        // A Job's identity spans an ECR repo, a pod-identity IAM role, an EKS
        // pod-identity association, and in-cluster Kubernetes objects — no
        // single AWS enumeration reconstructs the composite, so enumeration
        // is empty; `read` refreshes known instances.
        list: () => Effect.succeed([] as Job["Attributes"][]),
        diff: Effect.fn(function* ({ olds = {} as JobProps, news, output }) {
          if (!isResolved(news)) return;
          if (
            olds.cluster?.clusterName &&
            olds.cluster.clusterName !== news.cluster?.clusterName
          ) {
            return { action: "replace" } as const;
          }
          const effectiveNamespace = (props: JobProps) =>
            props.namespace ?? hyperpodNamespace(props.hyperpod) ?? "default";
          if (
            olds.cluster?.clusterName !== undefined &&
            effectiveNamespace(olds) !== effectiveNamespace(news)
          ) {
            return { action: "replace" } as const;
          }
          // Content drift for `context`/`image` sources (see Deployment).
          if (output) {
            const hash = yield* computeStaticSourceHash(
              news as ImageSourceLike,
              imagePlatformOf(news.architecture),
            );
            if (hash !== undefined && hash !== output.code.hash) {
              return { action: "update" } as const;
            }
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const described = yield* eks
            .describePodIdentityAssociation({
              clusterName: output.clusterName,
              associationId: output.associationId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!described?.association?.associationArn) {
            return undefined;
          }
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
          const clusterName = news.cluster.clusterName;
          const namespace =
            news.namespace ?? hyperpodNamespace(news.hyperpod) ?? "default";

          const baseName = yield* toBaseName(id, news);
          const serviceAccountName = output?.serviceAccountName ?? baseName;
          const roleName = output?.roleName ?? (yield* createRoleName(id));
          const policyName = yield* createPolicyName(id);
          const repositoryName =
            output?.repositoryName ?? (yield* createRepositoryName(id));
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Ensure IAM role + inline policy from bindings.
          const roleArn =
            output?.roleArn ??
            (yield* ensurePodRole({
              id,
              roleName,
              managedPolicyArns: news.roleManagedPolicyArns,
            }));
          const bindingEnv = yield* attachBindings({
            roleName,
            policyName,
            bindings,
          });

          // Ensure the pod identity association wires the role to the SA.
          const { associationArn, associationId } = yield* ensureAssociation({
            id,
            clusterName,
            namespace,
            serviceAccount: serviceAccountName,
            roleArn,
          });

          // Resolve the container image (`main` | `context` | `image`).
          const source = news as ImageSourceLike;
          const resolved = yield* imageSource.resolve({
            id,
            source,
            repositoryName,
            repositoryUri:
              output?.repositoryUri && output.repositoryName === repositoryName
                ? output.repositoryUri
                : undefined,
            tags,
            platform: imagePlatformOf(news.architecture),
            isExternal: news.isExternal,
            bootstrap: makeEksJobBootstrap(source.handler ?? "default"),
            session,
          });

          // Synthesize the Kubernetes objects.
          const labels = {
            ...(news.labels ?? { "app.kubernetes.io/name": baseName }),
            ...hyperpodWorkloadLabels(news.hyperpod),
          };
          const containerEnv = {
            ...bindingEnv,
            ...alchemyEnv,
            ...news.env,
          };

          const serviceAccountObject: KubernetesObjectDefinition = {
            apiVersion: "v1",
            kind: "ServiceAccount",
            metadata: { name: serviceAccountName, namespace, labels },
          };
          const podTemplate = deepMerge(
            {
              metadata: { labels },
              spec: {
                serviceAccountName,
                nodeSelector: hyperpodNodeSelector(news.hyperpod),
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
            connection,
            previousObjects: output?.kubernetesObjects ?? [],
            desiredObjects,
          });

          yield* session.note(`Applied EKS ${kind} ${namespace}/${jobName}`);

          return {
            clusterName,
            namespace,
            kind,
            jobName,
            schedule: news.schedule,
            serviceAccountName,
            imageUri: resolved.imageUri,
            repositoryName: resolved.repositoryName,
            repositoryUri: resolved.repositoryUri,
            roleArn,
            roleName,
            associationArn,
            associationId,
            kubernetesObjects,
            code: { hash: resolved.codeHash },
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // If the cluster is gone or already DELETING (destroyed alongside
          // the Job), everything cluster-scoped (in-cluster objects, the pod
          // identity association) dies with it — skip those and only clean up
          // the resources that outlive the cluster (ECR repo, pod IAM role).
          const described = yield* eks
            .describeCluster({ name: output.clusterName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const cluster =
            described?.cluster && described.cluster.status !== "DELETING"
              ? described.cluster
              : undefined;

          // Delete the in-cluster objects (skip if the cluster is gone).
          if (
            (output.kubernetesObjects ?? []).length > 0 &&
            cluster?.endpoint &&
            cluster.certificateAuthority?.data
          ) {
            yield* deleteObjects({
              connection: {
                clusterName: output.clusterName,
                endpoint: cluster.endpoint,
                certificateAuthorityData: cluster.certificateAuthority.data,
              },
              objects: output.kubernetesObjects ?? [],
            }).pipe(Effect.catch(() => Effect.void));
          }

          if (cluster) {
            // The cluster may still transition to DELETING between the
            // describe above and this call — EKS then rejects with
            // `InvalidRequestException: Cluster is in invalid state` — the
            // association is being torn down with the cluster, so treat it
            // as already deleted.
            yield* deleteAssociation({
              clusterName: output.clusterName,
              associationId: output.associationId,
            }).pipe(
              Effect.catchTag("InvalidRequestException", () => Effect.void),
            );
          }

          yield* ecr
            .deleteRepository({
              repositoryName: output.repositoryName,
              force: true,
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
            );

          yield* deletePodRole(output.roleName);
        }),
      };
    }),
  );

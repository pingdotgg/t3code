import * as ecr from "@distilled.cloud/aws/ecr";
import * as eks from "@distilled.cloud/aws/eks";
import { Region } from "@distilled.cloud/aws/Region";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Self } from "../../Self.ts";
import { Resource } from "../../Resource.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost as ServerHostService,
} from "../../Server/Process.ts";
import { Stack } from "../../Stack.ts";
import { createInternalTags } from "../../Tags.ts";
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
  readObject,
  reconcileObjects,
  deleteObjects,
  type KubernetesClusterConnection,
} from "./internal/client.ts";
import {
  hyperpodNamespace,
  hyperpodNodeSelector,
  hyperpodWorkloadLabels,
  type HyperPodWorkloadProps,
} from "./HyperPod.ts";
import {
  toKubernetesObjectRef,
  type KubernetesObjectDefinition,
  type KubernetesObjectRef,
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

export const isDeployment = (value: any): value is Deployment => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "AWS.EKS.Deployment"
  );
};

export interface DeploymentPropsBase extends PlatformProps {
  /**
   * Target EKS cluster the workload is deployed onto. Pass the
   * `AWS.EKS.Cluster` resource; the Deployment reads its `endpoint` /
   * `certificateAuthorityData` to apply the Kubernetes objects via
   * server-side apply.
   */
  cluster: ClusterConnectionProps;
  /**
   * Base name for the generated Deployment / Service / ServiceAccount / IAM
   * role. If omitted, the logical id is used.
   */
  name?: string;
  /**
   * Kubernetes namespace to deploy into. The namespace must already exist
   * (Auto Mode clusters ship a `default` namespace).
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
   * HTTP port exposed by the container and the Service.
   * @default 3000
   */
  port?: number;
  /**
   * Replica count for the Deployment.
   * @default 1
   */
  replicas?: number;
  /**
   * Kubernetes Service type. `LoadBalancer` provisions a cloud load balancer
   * (an NLB on Auto Mode) and exposes its hostname as the Deployment `url`.
   * @default "LoadBalancer"
   */
  serviceType?: "ClusterIP" | "NodePort" | "LoadBalancer";
  /**
   * Annotations applied to the Service (e.g. NLB scheme / target-type hints).
   */
  serviceAnnotations?: Record<string, string>;
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
   * Deployment / pod labels. Also used as the Service selector.
   */
  labels?: Record<string, string>;
  /**
   * User-defined tags to apply to Deployment-owned AWS resources.
   */
  tags?: Record<string, string>;
}

/** Bundle an inline Effect program (`main`) into a generated image. */
export interface BundledDeploymentProps
  extends DeploymentPropsBase, BundledImageSource {}

/** Build the user's own Dockerfile (`context` + optional `dockerfile` path). */
export interface DockerfileDeploymentProps
  extends DeploymentPropsBase, DockerfileImageSource {}

/** Run a pre-built registry image (mirrored into ECR). */
export interface ImageDeploymentProps
  extends DeploymentPropsBase, RegistryImageSource {}

export type DeploymentProps =
  | BundledDeploymentProps
  | DockerfileDeploymentProps
  | ImageDeploymentProps;

export interface Deployment extends Resource<
  "AWS.EKS.Deployment",
  DeploymentProps,
  {
    /** The name of the EKS cluster the deployment runs on. */
    clusterName: string;
    /** The Kubernetes namespace the deployment's objects live in. */
    namespace: string;
    /** The name of the Kubernetes Deployment. */
    deploymentName: string;
    /** The name of the Kubernetes Service exposing the deployment. */
    serviceName: string;
    /** The name of the service account the pods run as. */
    serviceAccountName: string;
    /** The container port the server listens on. */
    port: number;
    /** The URI of the container image the deployment runs. */
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
    /**
     * The LoadBalancer URL (`http://<hostname>[:port]` — the NLB listens on
     * the Service `port`, so a non-80 port is part of the URL) when
     * `serviceType` is `LoadBalancer`, otherwise `undefined`. May be
     * `undefined` immediately after a create while the cloud load balancer
     * is still provisioning.
     */
    url: string | undefined;
    /** References to the Kubernetes objects created for the deployment. */
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

export type DeploymentServices =
  | Credentials
  | Region
  | ServerHostService
  | AWSEnvironment;

export type DeploymentShape = Main<DeploymentServices>;

export interface DeploymentRuntimeContext extends HostRuntimeContext {
  readonly Type: "AWS.EKS.Deployment";
}

/**
 * A replicated Kubernetes server on Amazon EKS — the Kubernetes analog of
 * `AWS.ECS.Service`.
 *
 * `Deployment` provisions a Kubernetes `Deployment` + `Service` (+
 * `ServiceAccount`) via server-side apply, a pod-identity IAM role +
 * `PodIdentityAssociation`, and a container image from exactly one of three
 * sources flat on props: `main` (bundle an inline Effect program), `context`
 * (build your own Dockerfile), or `image` (a registry reference, mirrored
 * into ECR). It accepts the same `{ env, policyStatements }` host binding
 * contract as `AWS.Lambda.Function` and `AWS.ECS.Task`: every AWS
 * `Binding.Service` (S3, DynamoDB, SQS, …) attaches env vars to the pod spec
 * and IAM policy statements to the pod-identity role, with credentials
 * flowing through the EKS Pod Identity container-credentials chain.
 * @resource
 * @section Creating a Deployment
 * @example Remote image (external — no Effect runtime in the container)
 * ```typescript
 * const nginx = yield* AWS.EKS.Deployment("Nginx", {
 *   cluster,
 *   image: "nginx:1.27",
 *   namespace: "default",
 *   replicas: 3,
 *   port: 80,
 *   serviceType: "LoadBalancer",
 * });
 * nginx.url;            // LB URL, e.g. "http://k8s-….elb.amazonaws.com"
 * nginx.deploymentName; // K8s-native attrs
 * ```
 *
 * @example Build your own Dockerfile
 * ```typescript
 * const legacy = yield* AWS.EKS.Deployment("LegacyApp", {
 *   cluster,
 *   context: "./legacy",
 *   replicas: 2,
 *   port: 8080,
 * });
 * ```
 *
 * @section Effect Servers
 * @example Inline Effect server with a DynamoDB binding
 * ```typescript
 * const api = yield* AWS.EKS.Deployment(
 *   "Api",
 *   { cluster, main: import.meta.url, port: 3000, replicas: 2 },
 *   Effect.gen(function* () {
 *     const putItem = yield* AWS.DynamoDB.PutItem(table);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* putItem({ Item: { id: { S: "1" } } });
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.DynamoDB.PutItemHttp)),
 * );
 * ```
 *
 * @example Tagged Effect server
 * ```typescript
 * export class Api extends AWS.EKS.Deployment<Api, {
 *   health: () => Effect.Effect<string>;
 * }>()("Api") {}
 *
 * export default Api.make(
 *   { cluster, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return HttpServerResponse.text("ok");
 *       }),
 *       health: () => Effect.succeed("ok"),
 *     };
 *   }),
 * );
 * ```
 *
 * @section Kubernetes Escape Hatch
 * @example Tune the synthesized pod template
 * ```typescript
 * const tuned = yield* AWS.EKS.Deployment("Api", {
 *   cluster,
 *   main: import.meta.url,
 *   port: 3000,
 *   podTemplate: {
 *     spec: {
 *       tolerations: [{ key: "gpu", operator: "Exists" }],
 *       nodeSelector: { pool: "arm" },
 *     },
 *   },
 * });
 * ```
 */
export const Deployment: Platform<
  Deployment,
  DeploymentServices,
  DeploymentShape,
  DeploymentRuntimeContext
> = Platform("AWS.EKS.Deployment", {
  createRuntimeContext: createHostRuntimeContext("AWS.EKS.Deployment") as (
    id: string,
  ) => DeploymentRuntimeContext,
});

class ServiceNotReady extends Data.TaggedError("EKS.ServiceNotReady")<{}> {}

// Bounded ~3 min wait for the cloud load balancer to publish its hostname
// (an Auto Mode NLB typically appears within 2–3 min of the Service apply).
const loadBalancerRetrySchedule = Schedule.max([
  Schedule.spaced("5 seconds"),
  Schedule.recurs(36),
]);

/**
 * Explicitly-typed pipeable retry for the LB-hostname wait. An inline
 * `Effect.retry` in the provider leaks `Retry.Return`'s conditional into
 * declaration emit and widens the provider layer to `unknown` R.
 */
const retryUntilServiceReady = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (error) => error instanceof ServiceNotReady,
    schedule: loadBalancerRetrySchedule,
  });

/**
 * Generated container entry for an Effect-native EKS server: resolves the
 * program's registered runners and serves the returned `{ fetch }` handler
 * on `PORT`. Credentials use the full chain so EKS Pod Identity's
 * container-credentials endpoint resolves inside the pod.
 */
export const makeEksServerBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
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

// Resolve the bundled program (the runners registered via host.run / serve)
// and run it with a Bun HTTP server bound to PORT, so a returned { fetch }
// handler is served and host.run loops stay alive. Credentials use the full
// chain so EKS Pod Identity's container-credentials endpoint
// (AWS_CONTAINER_CREDENTIALS_FULL_URI + token file) resolves inside the pod.
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
      Layer.provideMerge(BunHttpServer()),
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

console.log(\`EKS Deployment bootstrap starting on port \${process.env.PORT ?? 3000}...\`);
await Effect.runPromise(program).catch((err) => {
  console.error("EKS Deployment bootstrap failed:", err);
  process.exit(1);
});
`;

const imagePlatformOf = (architecture: "amd64" | "arm64" | undefined) =>
  architecture === "arm64" ? "linux/arm64" : "linux/amd64";

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
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

      // Read a LoadBalancer Service's assigned hostname (bounded wait).
      const waitForLoadBalancer = (
        connection: KubernetesClusterConnection,
        service: KubernetesObjectRef,
      ) =>
        readObject({ connection, object: service }).pipe(
          Effect.map((response) => {
            const ingress = (
              response as {
                status?: {
                  loadBalancer?: {
                    ingress?: { hostname?: string; ip?: string }[];
                  };
                };
              }
            )?.status?.loadBalancer?.ingress?.[0];
            return ingress?.hostname ?? ingress?.ip;
          }),
          Effect.flatMap((hostname) =>
            hostname
              ? Effect.succeed(hostname)
              : Effect.fail(new ServiceNotReady()),
          ),
          retryUntilServiceReady,
          Effect.catchTag("EKS.ServiceNotReady", () =>
            Effect.succeed(undefined),
          ),
        );

      return {
        stables: [
          "repositoryName",
          "repositoryUri",
          "roleArn",
          "roleName",
          "clusterName",
          "namespace",
          "serviceAccountName",
          "deploymentName",
          "serviceName",
        ],
        // A Deployment's identity spans an ECR repo, a pod-identity IAM role,
        // an EKS pod-identity association, and in-cluster Kubernetes objects.
        // There is no single AWS enumeration that faithfully reconstructs that
        // composite (the image hash and applied manifests live in-cluster), so
        // enumeration is intentionally empty — `read` (below) refreshes a
        // known instance from its persisted output.
        list: () => Effect.succeed([] as Deployment["Attributes"][]),
        diff: Effect.fn(function* ({
          olds = {} as DeploymentProps,
          news,
          output,
        }) {
          if (!isResolved(news)) return;
          // The pod-identity association keys on (cluster, namespace,
          // serviceAccount); a change to either forces a replacement. Only
          // compare when the old value is present so a first create (empty
          // `olds`) doesn't spuriously replace.
          if (
            olds.cluster?.clusterName &&
            olds.cluster.clusterName !== news.cluster?.clusterName
          ) {
            return { action: "replace" } as const;
          }
          const effectiveNamespace = (props: DeploymentProps) =>
            props.namespace ?? hyperpodNamespace(props.hyperpod) ?? "default";
          if (
            olds.cluster?.clusterName !== undefined &&
            effectiveNamespace(olds) !== effectiveNamespace(news)
          ) {
            return { action: "replace" } as const;
          }
          // Content drift for `context`/`image` sources: the props don't
          // change when files under the context do, so surface hash drift
          // as an update. `main` sources hash from the bundle output inside
          // reconcile.
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
          const port = news.port ?? 3000;
          const serviceType = news.serviceType ?? "LoadBalancer";

          const baseName =
            output?.deploymentName ?? (yield* toBaseName(id, news));
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

          // Resolve the container image from whichever source the props
          // declare (`main` | `context` | `image`), building/mirroring and
          // pushing into the deployment's ECR repository.
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
            port,
            isExternal: news.isExternal,
            bootstrap: makeEksServerBootstrap(source.handler ?? "default"),
            session,
          });

          // Synthesize the Kubernetes objects. Container env merges binding
          // env (Output-referenced resource attributes flow via the
          // RuntimeContext into `news.env`), alchemy env, and user env.
          // Unlike ECS/Fargate (whose agent injects `AWS_REGION`), EKS pods
          // get no region env var — inject it so the bootstrap's
          // `Region.fromEnv()` resolves inside the pod.
          const { region } = yield* AWSEnvironment.current;
          const labels = {
            ...(news.labels ?? { "app.kubernetes.io/name": baseName }),
            ...hyperpodWorkloadLabels(news.hyperpod),
          };
          const containerEnv = {
            ...bindingEnv,
            ...alchemyEnv,
            AWS_REGION: region,
            PORT: String(port),
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
                containers: [
                  {
                    name: baseName,
                    image: resolved.imageUri,
                    command: news.command,
                    args: news.args,
                    ports: [{ containerPort: port }],
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
          const deploymentObject: KubernetesObjectDefinition = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name: baseName, namespace, labels },
            spec: {
              replicas: news.replicas ?? 1,
              selector: { matchLabels: labels },
              template: podTemplate,
            },
          };
          // EKS Auto Mode's built-in load balancer controller only reconciles
          // `LoadBalancer` Services whose `spec.loadBalancerClass` is
          // `eks.amazonaws.com/nlb` (there is no in-tree cloud provider on
          // Auto Mode), and it defaults new NLBs to the *internal* scheme.
          // Detect the Auto Mode LB capability from the live cluster and
          // default to an internet-facing NLB so the returned `url` is
          // actually reachable. User `serviceAnnotations` always win.
          let loadBalancerClass: string | undefined;
          let serviceAnnotations = news.serviceAnnotations;
          if (serviceType === "LoadBalancer") {
            const described = yield* eks
              .describeCluster({ name: clusterName })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (
              described?.cluster?.kubernetesNetworkConfig?.elasticLoadBalancing
                ?.enabled
            ) {
              loadBalancerClass = "eks.amazonaws.com/nlb";
            }
            serviceAnnotations = {
              "service.beta.kubernetes.io/aws-load-balancer-scheme":
                "internet-facing",
              ...news.serviceAnnotations,
            };
          }
          const serviceObject: KubernetesObjectDefinition = {
            apiVersion: "v1",
            kind: "Service",
            metadata: {
              name: baseName,
              namespace,
              labels,
              annotations: serviceAnnotations,
            },
            spec: {
              type: serviceType,
              ...(loadBalancerClass !== undefined ? { loadBalancerClass } : {}),
              selector: labels,
              ports: [{ port, targetPort: port, protocol: "TCP" }],
            },
          };

          const desiredObjects = [
            serviceAccountObject,
            deploymentObject,
            serviceObject,
          ];

          const kubernetesObjects = yield* reconcileObjects({
            connection,
            previousObjects: output?.kubernetesObjects ?? [],
            desiredObjects,
          });

          yield* session.note(
            `Applied EKS Deployment ${namespace}/${baseName}`,
          );

          // Resolve the LoadBalancer URL if applicable. The NLB listener is
          // the Service `port` (Kubernetes maps `spec.ports[].port` 1:1 to
          // the cloud listener), so the URL carries the port unless it's 80
          // — mirroring `AWS.ECS.Service`'s url semantics.
          const hostname =
            serviceType === "LoadBalancer"
              ? yield* waitForLoadBalancer(
                  connection,
                  toKubernetesObjectRef(serviceObject),
                )
              : undefined;
          const url =
            hostname === undefined
              ? undefined
              : port === 80
                ? `http://${hostname}`
                : `http://${hostname}:${port}`;

          return {
            clusterName,
            namespace,
            deploymentName: baseName,
            serviceName: baseName,
            serviceAccountName,
            port,
            imageUri: resolved.imageUri,
            repositoryName: resolved.repositoryName,
            repositoryUri: resolved.repositoryUri,
            roleArn,
            roleName,
            associationArn,
            associationId,
            url,
            kubernetesObjects,
            code: { hash: resolved.codeHash },
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Re-describe the cluster for a fresh endpoint + CA (the Attributes
          // don't cache them). If the cluster is gone or already DELETING
          // (destroyed alongside the Deployment — e.g. a full-stack destroy
          // deletes both concurrently), everything cluster-scoped (in-cluster
          // objects, the pod identity association) dies with it — skip those
          // and only clean up the resources that outlive the cluster (ECR
          // repo, pod IAM role).
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

          // Delete the in-cluster objects. Tolerate any API failure so delete
          // stays idempotent.
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

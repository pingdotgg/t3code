import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost as ServerHostService,
} from "../Server/Process.ts";
import { Stack } from "../Stack.ts";
import { createInternalTags } from "../Tags.ts";
import {
  findClusterAdapter,
  type ClusterTransport,
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
import {
  toKubernetesObjectRef,
  type KubernetesObjectDefinition,
  type KubernetesObjectRef,
} from "./internal/objects.ts";
import {
  collectBindingEnv,
  connectionIdentity,
  connectionOfOutput,
  deepMerge,
  imagePlatformOf,
  makeServerBootstrap,
  resolveWorkloadImage,
  tryConnectionOf,
  workloadImageHash,
} from "./internal/workload.ts";
import { makeConnectionRegistry } from "./internal/registry.ts";
import type { Providers } from "./Providers.ts";

export const isDeployment = (value: any): value is Deployment => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "Kubernetes.Deployment"
  );
};

/**
 * The image-source props shared by the workload platforms. Exactly one of
 * `main` (bundle an inline Effect program), `context`/`dockerfile` (build
 * the user's own Dockerfile), or `image` (a pre-built registry reference).
 */
export interface DeploymentPropsBase extends PlatformProps {
  /**
   * Target cluster the workload is deployed onto: a cluster resource
   * (`Kubernetes.LocalCluster`, `AWS.EKS.Cluster`), a
   * `Kubernetes.KubeConfig(...)`, or a raw `Kubernetes.Connection`. The
   * connection supplies authentication and the registry `main` / `context`
   * images are pushed to.
   */
  cluster: ClusterLike;
  /**
   * Base name for the generated Deployment / Service / ServiceAccount. If
   * omitted, a deterministic name is derived from the stack, stage, and
   * logical id.
   */
  name?: string;
  /**
   * Kubernetes namespace to deploy into. The namespace must already exist.
   * @default "default"
   */
  namespace?: string;
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
   * Kubernetes Service type. `LoadBalancer` provisions the platform's
   * cloud load balancer and exposes its hostname as the Deployment `url`.
   * @default "LoadBalancer"
   */
  serviceType?: "ClusterIP" | "NodePort" | "LoadBalancer";
  /**
   * Annotations applied to the Service (e.g. load-balancer scheme /
   * target-type hints).
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
   * Container image build architecture.
   * @default the connection's `architecture`, else "amd64"
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
   * attaches extra managed policies to the generated pod-identity role; on
   * GKE: `{ gcpServiceAccount }` runs the pods as an existing Google
   * service account instead of the ServiceAccount's own principal).
   */
  identity?: WorkloadIdentityOptions;
  /**
   * Deployment / pod labels, merged over the generated
   * `app.kubernetes.io/name` label. Also used as the Service selector.
   */
  labels?: Record<string, string>;
  /**
   * User-defined tags applied to workload-owned cloud resources (identity
   * roles, image repositories).
   */
  tags?: Record<string, string>;
}

/** Bundle an inline Effect program (`main`) into a generated image. */
export interface BundledDeploymentProps extends DeploymentPropsBase {
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
export interface DockerfileDeploymentProps extends DeploymentPropsBase {
  /** Docker build context directory. */
  context?: string;
  /**
   * Path to the Dockerfile (relative to the cwd), or inline content.
   * @default `${context}/Dockerfile`
   */
  dockerfile?: WorkloadImageSource["dockerfile"];
}

/** Run a pre-built registry image. */
export interface ImageDeploymentProps extends DeploymentPropsBase {
  /**
   * A pre-built image reference, e.g. `nginx:1.27`, pulled by the nodes as
   * written. EKS clusters mirror it into ECR first.
   */
  image: string;
}

export type DeploymentProps =
  | BundledDeploymentProps
  | DockerfileDeploymentProps
  | ImageDeploymentProps;

export interface Deployment extends Resource<
  "Kubernetes.Deployment",
  DeploymentProps,
  {
    /** The connection of the cluster the deployment runs on. */
    connection: Connection;
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
    /**
     * Workload-identity state provisioned by the cluster platform's
     * adapter (on EKS: the pod-identity role + association; on GKE: the
     * Workload Identity principal and the IAM grants applied to it).
     */
    identity: IdentityState | undefined;
    /**
     * Image-registry state provisioned by the cluster platform's adapter
     * (on EKS: the ECR repository).
     */
    registry: RegistryState | undefined;
    /**
     * The LoadBalancer URL (`http://<hostname>[:port]` — the cloud load
     * balancer listens on the Service `port`, so a non-80 port is part of
     * the URL) when `serviceType` is `LoadBalancer`, otherwise
     * `undefined`. May be `undefined` immediately after a create while
     * the cloud load balancer is still provisioning.
     */
    url: string | undefined;
    /** References to the Kubernetes objects created for the deployment. */
    kubernetesObjects: KubernetesObjectRef[];
    /** The content hash of the container image source. */
    code: {
      hash: string;
    };
  },
  WorkloadBindingContract,
  Providers
> {}

export type DeploymentServices = ServerHostService | WorkloadServices;

export type DeploymentShape = Main<DeploymentServices>;

export interface DeploymentRuntimeContext extends HostRuntimeContext {
  readonly Type: "Kubernetes.Deployment";
}

/**
 * A replicated Kubernetes server on any cluster, running a container image
 * or an HTTP server written in Effect.
 *
 * `Deployment` provisions a Kubernetes `Deployment` + `Service` (+
 * `ServiceAccount`) via server-side apply, with the container image from
 * exactly one of three sources flat on props: `main` (bundle an inline
 * Effect program), `context` (build your own Dockerfile), or `image` (a
 * pre-built registry reference). `main` and `context` images are built on
 * the deploying machine and pushed to the connection's registry
 * (`Kubernetes.LocalCluster` includes one; EKS uses ECR; GKE uses
 * Artifact Registry). Bindings attach environment variables on any
 * cluster; cloud credential grants need a platform with workload identity.
 * On `AWS.EKS.Cluster` targets it accepts the `{ env, policyStatements }`
 * contract of `AWS.Lambda.Function`: IAM policy statements go to a
 * generated pod-identity role. On `GCP.Container.Cluster` targets it
 * accepts the `{ env, iam }` contract of `GCP.Run.Service`: IAM roles are
 * granted to the Kubernetes ServiceAccount's Workload Identity Federation
 * principal.
 * ### Creating a Deployment
 * **Example:** Run an image on a local cluster
 * ```typescript
 * const cluster = yield* Kubernetes.LocalCluster("Cluster", {
 *   name: "alchemy",
 * });
 *
 * const web = yield* Kubernetes.Deployment("Web", {
 *   cluster,
 *   image: "ghcr.io/stefanprodan/podinfo:6.15.0",
 *   replicas: 2,
 *   port: 9898,
 *   serviceType: "ClusterIP",
 * });
 * web.serviceName; // K8s-native attrs
 * ```
 *
 * **Example:** Any cluster via kubeconfig
 * ```typescript
 * const cluster = Kubernetes.KubeConfig({ context: "prod-east" });
 *
 * const nginx = yield* Kubernetes.Deployment("Nginx", {
 *   cluster,
 *   image: "nginx:1.27",
 *   replicas: 3,
 *   port: 80,
 *   serviceType: "LoadBalancer",
 * });
 * nginx.url; // the load balancer's address
 * ```
 *
 * **Example:** Build your own Dockerfile
 * ```typescript
 * const legacy = yield* Kubernetes.Deployment("LegacyApp", {
 *   cluster,
 *   context: "./legacy",
 *   replicas: 2,
 *   port: 8080,
 * });
 * ```
 *
 * ### Effect Servers
 * **Example:** Inline Effect server
 * ```typescript
 * const api = yield* Kubernetes.Deployment(
 *   "Api",
 *   { cluster, main: import.meta.url, port: 3000, replicas: 2 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }),
 * );
 * ```
 *
 * **Example:** Push to your own registry
 * ```typescript
 * const cluster = Kubernetes.KubeConfig({
 *   context: "prod-east",
 *   registry: { server: "ghcr.io/acme" },
 * });
 *
 * const api = yield* Kubernetes.Deployment(
 *   "Api",
 *   { cluster, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }),
 * );
 * ```
 *
 * **Example:** DynamoDB binding on EKS
 * ```typescript
 * const cluster = yield* AWS.EKS.Cluster("Cluster", { compute: "auto" });
 *
 * const api = yield* Kubernetes.Deployment(
 *   "Api",
 *   { cluster, main: import.meta.url, port: 3000 },
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
 * **Example:** Tagged Effect server
 * ```typescript
 * export class Api extends Kubernetes.Deployment<Api, {
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
 * ### Bundling & Tree-shaking
 * `main` is bundled with rolldown at deploy time. Unused code is
 * tree-shaken. `effect`, alchemy, and `@distilled.cloud` are marked
 * pure so unused parts prune more aggressively. Your app is not
 * marked pure.
 *
 * **Example:** Mark additional packages as pure
 * Only list packages with no top-level side effects.
 * ```typescript
 * {
 *   main: import.meta.url,
 *   build: {
 *     pure: { packages: ["my-lib", "@my-scope/*"] },
 *   },
 * }
 * ```
 *
 * **Example:** Turn it off
 * ```typescript
 * {
 *   main: import.meta.url,
 *   build: { pure: false },
 * }
 * ```
 *
 * ### Kubernetes Escape Hatch
 * **Example:** Tune the synthesized pod template
 * ```typescript
 * const tuned = yield* Kubernetes.Deployment("Api", {
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
 *
 * @resource
 * @product Workloads
 */
export const Deployment: Platform<
  Deployment,
  DeploymentServices,
  DeploymentShape,
  DeploymentRuntimeContext
> = Platform("Kubernetes.Deployment", {
  aliases: ["AWS.EKS.Deployment"],
  createRuntimeContext: createHostRuntimeContext("Kubernetes.Deployment") as (
    id: string,
  ) => DeploymentRuntimeContext,
});

class ServiceNotReady extends Data.TaggedError(
  "Kubernetes.ServiceNotReady",
)<{}> {}

// Bounded ~3 min wait for the cloud load balancer to publish its hostname
// (an EKS Auto Mode NLB typically appears within 2–3 min of the Service
// apply).
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

const isNotFound = (error: unknown): error is KubernetesApiError =>
  error instanceof KubernetesApiError && error.statusCode === 404;

class ServiceStillExists extends Data.TaggedError(
  "Kubernetes.ServiceStillExists",
)<{}> {}

/**
 * Bounded (~3 min) wait for a deleted Service to disappear, i.e. for the
 * cloud controller to tear down its load balancer and drop the finalizer.
 */
const waitForServiceGone = (
  transport: ClusterTransport,
  service: KubernetesObjectRef,
): Effect.Effect<void, unknown> =>
  Effect.retry(
    readObject({ transport, object: service }).pipe(
      Effect.flatMap(() => Effect.fail(new ServiceStillExists())),
      Effect.catchIf(isNotFound, () => Effect.void),
    ),
    {
      while: (error) => error instanceof ServiceStillExists,
      schedule: loadBalancerRetrySchedule,
    },
  );

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const connectionRegistry = yield* makeConnectionRegistry;

      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      // The base name doubles as the `app.kubernetes.io/name` label value
      // (and the Service name), both capped at 63 characters.
      const toBaseName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 63, lowercase: true }).pipe(
              Effect.map((name) => name.replaceAll(/[^a-z0-9-]/g, "-")),
            );

      // Read a LoadBalancer Service's assigned hostname (bounded wait).
      const waitForLoadBalancer = (
        transport: ClusterTransport,
        service: KubernetesObjectRef,
      ) =>
        readObject({ transport, object: service }).pipe(
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
          Effect.catchTag("Kubernetes.ServiceNotReady", () =>
            Effect.succeed(undefined),
          ),
        );

      return {
        stables: [
          "connection",
          "namespace",
          "serviceAccountName",
          "deploymentName",
          "serviceName",
          "identity",
          "registry",
        ],
        // A Deployment's identity spans in-cluster Kubernetes objects plus
        // adapter-owned cloud resources (identity role, image repository).
        // There is no single enumeration that faithfully reconstructs that
        // composite, so enumeration is intentionally empty — `read` (below)
        // refreshes a known instance from its persisted output.
        list: () => Effect.succeed([] as Deployment["Attributes"][]),
        diff: Effect.fn(function* ({
          olds = {} as DeploymentProps,
          news: input,
          output,
        }) {
          // `exports` carries the program's runtime Effects (never plain
          // data); everything else must be resolved to diff.
          const { exports: _exports, ...declared } = input as typeof input & {
            exports?: unknown;
          };
          if (!isResolved(declared)) return;
          const news = input as unknown as DeploymentProps;
          const oldCluster = connectionIdentity(tryConnectionOf(olds.cluster));
          const newCluster = connectionIdentity(tryConnectionOf(news.cluster));
          // Workload identity keys on (cluster, namespace, serviceAccount);
          // a change to either forces a replacement. Only compare when the
          // old value is present so a first create (empty `olds`) doesn't
          // spuriously replace.
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
          // Content drift: the props don't change when files under a build
          // context (or the bundled program) do, so surface hash drift as
          // an update.
          const connection = tryConnectionOf(news.cluster);
          if (output && connection) {
            const adapter = yield* findClusterAdapter(connection.auth.kind);
            const source = news as WorkloadImageSource;
            const hash = yield* workloadImageHash({
              adapter,
              connection,
              connectionRegistry,
              source,
              platform: imagePlatformOf(news.architecture, connection),
              port: news.port ?? 3000,
              isExternal: news.isExternal,
              bootstrap: (adapter.bootstrap?.server ?? makeServerBootstrap)(
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
            // Transient unreachability must not read as "gone" — keep the
            // persisted state and let reconcile converge.
            Effect.catch(() => Effect.succeed("unreachable" as const)),
          );
          if (transport === undefined) return undefined;
          if (transport === "unreachable") return output;
          // The ServiceAccount is the stable first object of the workload
          // (one-shot Job objects are content-addressed and may have been
          // TTL-collected, so they are not an existence signal).
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
          const port = news.port ?? 3000;
          const serviceType = news.serviceType ?? "LoadBalancer";

          const baseName =
            output?.deploymentName ?? (yield* toBaseName(id, news));
          const serviceAccountName = output?.serviceAccountName ?? baseName;
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Environment from bindings is collected generically; cloud
          // credential grants (any non-env binding channel) require the
          // cluster platform's identity adapter.
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

          // Resolve the container image from whichever source the props
          // declare (`main` | `context` | `image`) through the platform's
          // registry adapter (pre-built `image` refs pass through verbatim
          // on registry-less clusters).
          const source = news as WorkloadImageSource;
          const resolved = yield* resolveWorkloadImage({
            adapter,
            connection,
            connectionRegistry,
            id,
            source,
            platform: imagePlatformOf(news.architecture, connection),
            port,
            isExternal: news.isExternal,
            bootstrap: (adapter.bootstrap?.server ?? makeServerBootstrap)(
              source.handler ?? "default",
            ),
            tags,
            state:
              (output?.registry as Record<string, unknown> | undefined) ??
              (output as Record<string, unknown> | undefined),
            session,
          });

          // Synthesize the Kubernetes objects. Container env merges binding
          // env (Output-referenced resource attributes flow via the
          // RuntimeContext into `news.env`), adapter env (e.g. AWS_REGION on
          // EKS), alchemy env, and user env. The generated name label is
          // always present so the Service selector stays workload-unique
          // even when user labels are set.
          const labels = {
            "app.kubernetes.io/name": baseName,
            ...news.labels,
          };
          const containerEnv = {
            ...bindingEnv,
            ...identity?.env,
            ...alchemyEnv,
            PORT: String(port),
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
          // `LoadBalancer` Services need platform defaults on some managed
          // clouds (EKS Auto Mode only reconciles Services carrying its
          // `loadBalancerClass`, and defaults new NLBs to the internal
          // scheme) — ask the adapter. User `serviceAnnotations` always win.
          let loadBalancerClass: string | undefined;
          let serviceAnnotations = news.serviceAnnotations;
          if (serviceType === "LoadBalancer") {
            const defaults = adapter.loadBalancerDefaults
              ? yield* adapter.loadBalancerDefaults({ connection })
              : undefined;
            loadBalancerClass = defaults?.loadBalancerClass;
            serviceAnnotations = {
              ...defaults?.annotations,
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
            transport,
            previousObjects: output?.kubernetesObjects ?? [],
            desiredObjects,
          });

          yield* session.note(
            `Applied Kubernetes Deployment ${namespace}/${baseName}`,
          );

          // Resolve the LoadBalancer URL if applicable. The cloud listener
          // is the Service `port` (Kubernetes maps `spec.ports[].port` 1:1
          // to it), so the URL carries the port unless it's 80 — mirroring
          // `AWS.ECS.Service`'s url semantics.
          const hostname =
            serviceType === "LoadBalancer"
              ? yield* waitForLoadBalancer(
                  transport,
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
            connection,
            namespace,
            deploymentName: baseName,
            serviceName: baseName,
            serviceAccountName,
            port,
            imageUri: resolved.imageUri,
            identity: identity?.state,
            registry: resolved.state,
            url,
            kubernetesObjects,
            code: { hash: resolved.codeHash },
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const connection = connectionOfOutput(output);
          if (!connection) return;
          const adapter = yield* findClusterAdapter(connection.auth.kind);

          // Delete the in-cluster objects. If the cluster is gone (or
          // transiently unreachable) skip them — cluster-scoped state dies
          // with the cluster — and still clean up the adapter-owned cloud
          // resources that outlive it (image repository, identity role).
          const transport = yield* adapter
            .connect(connection)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (transport && (output.kubernetesObjects ?? []).length > 0) {
            yield* deleteObjects({
              transport,
              objects: output.kubernetesObjects ?? [],
            }).pipe(Effect.catch(() => Effect.void));
            // A LoadBalancer Service carries the cloud controller's cleanup
            // finalizer; wait for it so the cloud load balancer is gone
            // before the cluster (and its controller) can be deleted —
            // deleting the cluster first leaks the load balancer.
            yield* Effect.forEach(
              (output.kubernetesObjects ?? []).filter(
                (object) => object.kind === "Service",
              ),
              (service) =>
                waitForServiceGone(transport, service).pipe(
                  Effect.catch(() => Effect.void),
                ),
              { discard: true },
            );
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

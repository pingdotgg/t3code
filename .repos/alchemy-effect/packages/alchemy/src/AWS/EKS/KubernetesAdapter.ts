/**
 * The `aws-eks` {@link ClusterAdapter}: everything platform-specific about
 * running `Kubernetes.*` workloads on Amazon EKS.
 *
 * - **connect** — SigV4 bearer tokens (STS presign) against the cluster
 *   endpoint, re-describing the cluster when the connection doesn't carry
 *   endpoint/CA (or they've gone stale).
 * - **identity** — EKS Pod Identity: a generated IAM role +
 *   `PodIdentityAssociation`, with `policyStatements` host bindings landed
 *   as the role's inline policy.
 * - **registry** — a per-workload ECR repository; `main` programs are
 *   bundled, `context` Dockerfiles built, and `image` refs mirrored into
 *   it.
 * - **bootstrap** — generated container entries wiring the AWS credential
 *   chain so Pod Identity's container-credentials endpoint resolves inside
 *   the pod.
 * - **loadBalancerDefaults** — EKS Auto Mode's `loadBalancerClass` and the
 *   internet-facing NLB scheme.
 *
 * Registered by `AWS.providers()`; resolved dynamically by the
 * `Kubernetes.*` providers via the connection's `auth.kind`.
 */
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region, type RegionName } from "@distilled.cloud/aws/Region";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as eks from "@distilled.cloud/aws/eks";
import { AwsClient } from "aws4fetch";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import {
  ClusterAdapter,
  ClusterNotFoundError,
  type ClusterAdapterService,
  type ClusterTransport,
  type ImageRegistryResolveOptions,
  type WorkloadIdentityReconcileOptions,
} from "../../Kubernetes/ClusterAdapter.ts";
import type { Connection } from "../../Kubernetes/Connection.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Self } from "../../Self.ts";
import { AWSEnvironment } from "../Environment.ts";
import { makeImageSource, type ImageSourceLike } from "../ECR/ImageSource.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import {
  attachPolicyStatements,
  deleteAssociation,
  deletePodRole,
  ensureAssociation,
  ensurePodRole,
} from "./internal/podIdentity.ts";

declare module "../../Kubernetes/Connection.ts" {
  interface AuthRegistry {
    /**
     * Authenticate against an Amazon EKS cluster with SigV4 bearer tokens
     * minted from the ambient AWS credentials. Contributed by
     * `AWS.providers()` — `AWS.EKS.Cluster` attributes expose a ready-made
     * `connection` carrying this descriptor.
     */
    "aws-eks": {
      /** The EKS cluster name. */
      clusterName: string;
      /**
       * The cluster's region.
       * @default the ambient AWS region
       */
      region?: string;
    };
  }
}

declare module "../../Kubernetes/ClusterAdapter.ts" {
  interface IdentityStateRegistry {
    /** EKS Pod Identity: generated IAM role + association. */
    "aws-pod-identity": {
      /** The ARN of the IAM role pods assume via Pod Identity. */
      roleArn: string;
      /** The name of the IAM role pods assume via Pod Identity. */
      roleName: string;
      /** The ARN of the Pod Identity association binding the role. */
      associationArn: string;
      /** The ID of the Pod Identity association binding the role. */
      associationId: string;
    };
  }
  interface RegistryStateRegistry {
    /** The per-workload ECR repository holding the image. */
    "aws-ecr": {
      /** The name of the ECR repository holding the image. */
      repositoryName: string;
      /** The URI of the ECR repository holding the image. */
      repositoryUri: string;
    };
  }
  interface WorkloadIdentityOptions {
    /**
     * Managed policy ARNs attached to the generated pod-identity role in
     * addition to the inline policy synthesized from bindings (EKS only).
     */
    managedPolicyArns?: string[];
  }
  interface WorkloadBindingContract {
    /**
     * IAM policy statements landed on the workload's pod-identity role
     * (EKS only) — the same host-binding channel as `AWS.Lambda.Function`
     * and `AWS.ECS.Task`.
     */
    policyStatements?: PolicyStatement[];
  }
  interface WorkloadServicesRegistry {
    /** AWS credential-chain services ambient inside EKS workload pods. */
    aws: Credentials | Region | AWSEnvironment;
  }
}

/** Services the adapter's methods close over at layer build. */
type EksAdapterDeps =
  | Credentials
  | HttpClient
  | Region
  | AWSEnvironment
  | FileSystem.FileSystem
  | Path.Path;

/** Mint an EKS SigV4 bearer token (STS `GetCallerIdentity` presign). */
const mintEksToken = Effect.fn(function* (clusterName: string, region: string) {
  const credentials = yield* yield* Credentials;

  const client = new AwsClient({
    accessKeyId: Redacted.value(credentials.accessKeyId),
    secretAccessKey: Redacted.value(credentials.secretAccessKey),
    sessionToken: credentials.sessionToken
      ? Redacted.value(credentials.sessionToken)
      : undefined,
    service: "sts",
    region,
  });

  const presigned = yield* Effect.tryPromise(() =>
    client.sign(
      new Request(
        `https://sts.${region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15&X-Amz-Expires=60`,
        {
          headers: {
            "x-k8s-aws-id": clusterName,
          },
        },
      ),
      {
        aws: {
          signQuery: true,
          allHeaders: true,
        },
      },
    ),
  );

  return `k8s-aws-v1.${Buffer.from(presigned.url).toString("base64url")}`;
});

/**
 * Build a {@link ClusterTransport} for an EKS cluster from known
 * endpoint/CA. Captures the ambient AWS services so the per-request token
 * mint is self-contained — used by the adapter and by the
 * `AWS.EKS.Cluster` provider's own kubernetes-object binding channel.
 */
export const makeEksTransport = Effect.fn(function* (options: {
  clusterName: string;
  region?: string | undefined;
  endpoint: string;
  certificateAuthorityData: string;
}) {
  const context = yield* Effect.context<Credentials | AWSEnvironment>();
  const region = options.region ?? (yield* AWSEnvironment.current).region;
  return {
    endpoint: options.endpoint,
    certificateAuthorityData: options.certificateAuthorityData,
    headers: mintEksToken(options.clusterName, region).pipe(
      Effect.map((token) => ({ Authorization: `Bearer ${token}` })),
      Effect.provideContext(context),
    ),
  } satisfies ClusterTransport;
});

/**
 * The `Kubernetes.Connection` of an EKS cluster — stamped on
 * `AWS.EKS.Cluster` attributes so the cluster resource can be passed
 * directly as any `Kubernetes.*` workload's `cluster`.
 */
export const eksConnectionOf = (options: {
  clusterName: string;
  region: string;
  endpoint?: string | undefined;
  certificateAuthorityData?: string | undefined;
}): Connection => ({
  endpoint: options.endpoint,
  certificateAuthorityData: options.certificateAuthorityData,
  auth: {
    kind: "aws-eks",
    clusterName: options.clusterName,
    region: options.region,
  },
});

const narrowEksAuth = (connection: Connection) =>
  connection.auth.kind === "aws-eks"
    ? Effect.succeed(connection.auth)
    : Effect.die(
        new Error(
          `aws-eks adapter received auth kind '${connection.auth.kind}'`,
        ),
      );

/**
 * Provide a per-connection region override so a cluster in another region
 * than the ambient one describes correctly.
 */
const withRegion = (region: string | undefined) => {
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    region === undefined
      ? self
      : Effect.provideService(
          self,
          Region,
          Effect.succeed(region as RegionName),
        );
};

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
import { provideProcessTelemetry } from "alchemy/Telemetry";
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
  // Process-lifetime telemetry: built once into the root scope; exporters
  // batch on their intervals and flush when the scope closes on graceful
  // shutdown.
  Effect.flatMap((host) =>
    host.RuntimeContext.exports.pipe(
      Effect.flatMap((exports) => exports.program),
      provideProcessTelemetry(host.RuntimeContext),
    ),
  ),
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
import { provideProcessTelemetry } from "alchemy/Telemetry";
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

// Normalize the entrypoint export (see the server bootstrap).
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
  // Process-lifetime telemetry: built once into the root scope; exporters
  // batch on their intervals and flush when the scope closes as the
  // one-shot program completes.
  Effect.flatMap((host) =>
    host.RuntimeContext.exports.pipe(
      Effect.flatMap((exports) => exports.program),
      provideProcessTelemetry(host.RuntimeContext),
    ),
  ),
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

/**
 * The `aws-eks` cluster adapter layer. Provided (merged) by
 * `AWS.providers()` so the `Kubernetes.*` workload providers can resolve
 * it from the stack context.
 */
export const EksKubernetesAdapter = () =>
  Layer.effect(
    ClusterAdapter("aws-eks"),
    Effect.gen(function* () {
      const imageSource = yield* makeImageSource;
      const context = yield* Effect.context<EksAdapterDeps>();

      // Discharge the layer-captured AWS services; per-resource engine
      // services (InstanceId/Stack/Stage) stay ambient — they are provided
      // by the invoking lifecycle operation, never captured here.
      const withAws =
        (region: string | undefined) =>
        <A, E, R>(self: Effect.Effect<A, E, R>) =>
          Effect.provideContext(withRegion(region)(self), context);

      /** Describe the cluster; NotFound / DELETING → ClusterNotFoundError. */
      const describeLiveCluster = Effect.fn(function* (auth: {
        clusterName: string;
        region?: string | undefined;
      }) {
        const described = yield* eks
          .describeCluster({ name: auth.clusterName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
            withAws(auth.region),
          );
        const cluster = described?.cluster;
        if (!cluster || cluster.status === "DELETING") {
          return yield* Effect.fail(
            new ClusterNotFoundError({
              message: `EKS cluster '${auth.clusterName}' no longer exists`,
            }),
          );
        }
        return cluster;
      });

      const connect = Effect.fn(function* (connection: Connection) {
        const auth = yield* narrowEksAuth(connection);
        let endpoint = connection.endpoint;
        let certificateAuthorityData = connection.certificateAuthorityData;
        if (!endpoint || !certificateAuthorityData) {
          // Re-describe for a fresh endpoint + CA (persisted attributes
          // may predate them, and EKS can rotate the endpoint DNS on
          // recreate-with-same-name).
          const cluster = yield* describeLiveCluster(auth);
          endpoint = cluster.endpoint;
          certificateAuthorityData = cluster.certificateAuthority?.data;
          if (!endpoint || !certificateAuthorityData) {
            return yield* Effect.fail(
              new Error(
                `EKS cluster '${auth.clusterName}' has no endpoint or ` +
                  "certificate authority data yet (still creating?)",
              ),
            );
          }
        }
        return yield* makeEksTransport({
          clusterName: auth.clusterName,
          region: auth.region,
          endpoint,
          certificateAuthorityData,
        }).pipe(withAws(auth.region));
      });

      const identityReconcile = Effect.fn(function* (
        options: WorkloadIdentityReconcileOptions,
      ) {
        const auth = yield* narrowEksAuth(options.connection);
        return yield* Effect.gen(function* () {
          const state = options.state;
          const roleName =
            typeof state?.roleName === "string"
              ? state.roleName
              : yield* createRoleName(options.id);
          const policyName = yield* createPolicyName(options.id);

          // Ensure IAM role + inline policy from bindings.
          const roleArn =
            typeof state?.roleArn === "string"
              ? state.roleArn
              : yield* ensurePodRole({
                  id: options.id,
                  roleName,
                  managedPolicyArns: options.options?.managedPolicyArns,
                });
          yield* attachPolicyStatements({
            roleName,
            policyName,
            bindings: options.bindings,
          });

          // Ensure the pod identity association wires the role to the SA.
          const { associationArn, associationId } = yield* ensureAssociation({
            id: options.id,
            clusterName: auth.clusterName,
            namespace: options.namespace,
            serviceAccount: options.serviceAccount,
            roleArn,
          });

          // Unlike ECS/Fargate (whose agent injects `AWS_REGION`), EKS pods
          // get no region env var — inject it so the bootstrap's
          // `Region.fromEnv()` resolves inside the pod.
          const { region } = yield* AWSEnvironment.current;

          return {
            env: { AWS_REGION: auth.region ?? region },
            state: {
              kind: "aws-pod-identity" as const,
              roleArn,
              roleName,
              associationArn,
              associationId,
            },
          };
        }).pipe(withAws(auth.region));
      });

      const identityDelete = Effect.fn(function* (options: {
        connection: Connection | undefined;
        state: Record<string, unknown> | undefined;
      }) {
        const state = options.state;
        const auth =
          options.connection !== undefined
            ? yield* narrowEksAuth(options.connection)
            : undefined;
        yield* Effect.gen(function* () {
          // The association is cluster-scoped: skip it when the cluster is
          // gone or DELETING (it dies with the cluster; EKS also rejects
          // the delete with `InvalidRequestException: Cluster is in
          // invalid state` mid-teardown).
          if (auth !== undefined && typeof state?.associationId === "string") {
            const cluster = yield* describeLiveCluster(auth).pipe(
              Effect.catchTag("Kubernetes.ClusterNotFoundError", () =>
                Effect.succeed(undefined),
              ),
            );
            if (cluster) {
              yield* deleteAssociation({
                clusterName: auth.clusterName,
                associationId: state.associationId,
              }).pipe(
                Effect.catchTag("InvalidRequestException", () => Effect.void),
              );
            }
          }
          if (typeof state?.roleName === "string") {
            yield* deletePodRole(state.roleName);
          }
        }).pipe(withAws(auth?.region));
      });

      const registryResolve = Effect.fn(function* (
        options: ImageRegistryResolveOptions,
      ) {
        const state = options.state;
        const repositoryName =
          typeof state?.repositoryName === "string"
            ? state.repositoryName
            : // Physical-name generation reads the resource's ambient
              // InstanceId/Stack/Stage — do not shadow them with the
              // layer-captured context.
              yield* createRepositoryName(options.id);
        const repositoryUri =
          typeof state?.repositoryUri === "string" &&
          state.repositoryName === repositoryName
            ? state.repositoryUri
            : undefined;
        const resolved = yield* imageSource
          .resolve({
            id: options.id,
            source: options.source as ImageSourceLike,
            repositoryName,
            repositoryUri,
            tags: options.tags,
            platform: options.platform,
            port: options.port,
            isExternal: options.isExternal,
            bootstrap: options.bootstrap,
            session: options.session,
          })
          .pipe(Effect.provideContext(context));
        return {
          imageUri: resolved.imageUri,
          codeHash: resolved.codeHash,
          state: {
            kind: "aws-ecr" as const,
            repositoryName: resolved.repositoryName,
            repositoryUri: resolved.repositoryUri,
          },
        };
      });

      const registryHash = Effect.fn(function* (options: {
        source: ImageSourceLike;
        platform: string;
        port?: number | undefined;
        isExternal?: boolean | undefined;
        bootstrap: (importPath: string) => string;
      }) {
        return yield* imageSource
          .hash({
            source: options.source,
            platform: options.platform,
            port: options.port,
            isExternal: options.isExternal,
            bootstrap: options.bootstrap,
          })
          .pipe(Effect.provideContext(context));
      });

      const registryDelete = Effect.fn(function* (options: {
        state: Record<string, unknown> | undefined;
      }) {
        if (typeof options.state?.repositoryName !== "string") return;
        yield* ecr
          .deleteRepository({
            repositoryName: options.state.repositoryName,
            force: true,
          })
          .pipe(
            Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
            Effect.provideContext(context),
          );
      });

      const loadBalancerDefaults = Effect.fn(function* (options: {
        connection: Connection;
      }) {
        const auth = yield* narrowEksAuth(options.connection);
        // EKS Auto Mode's built-in load balancer controller only
        // reconciles `LoadBalancer` Services whose `spec.loadBalancerClass`
        // is `eks.amazonaws.com/nlb` (there is no in-tree cloud provider on
        // Auto Mode), and it defaults new NLBs to the *internal* scheme.
        // Detect the Auto Mode LB capability from the live cluster and
        // default to an internet-facing NLB so the returned `url` is
        // actually reachable.
        const cluster = yield* describeLiveCluster(auth).pipe(
          Effect.catchTag("Kubernetes.ClusterNotFoundError", () =>
            Effect.succeed(undefined),
          ),
        );
        return {
          loadBalancerClass: cluster?.kubernetesNetworkConfig
            ?.elasticLoadBalancing?.enabled
            ? "eks.amazonaws.com/nlb"
            : undefined,
          annotations: {
            "service.beta.kubernetes.io/aws-load-balancer-scheme":
              "internet-facing",
          },
        };
      });

      return {
        kind: "Kubernetes.ClusterAdapter" as const,
        connect,
        identity: {
          reconcile: identityReconcile,
          delete: identityDelete,
        },
        registry: {
          resolve: registryResolve,
          hash: registryHash,
          delete: registryDelete,
        },
        bootstrap: {
          server: makeEksServerBootstrap,
          job: makeEksJobBootstrap,
        },
        loadBalancerDefaults,
      } satisfies ClusterAdapterService;
    }),
  );

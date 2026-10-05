/**
 * The `gcp-gke` {@link ClusterAdapter}: everything platform-specific about
 * running `Kubernetes.*` workloads on Google Kubernetes Engine.
 *
 * - **connect** — Google OAuth bearer tokens against the cluster endpoint,
 *   re-getting the cluster when the connection doesn't carry endpoint/CA.
 * - **identity** — GKE Workload Identity Federation: every `iam` grant a
 *   GCP binding attaches to the workload is granted directly to the
 *   Kubernetes ServiceAccount's principal
 *   (`principal://iam.googleapis.com/projects/{number}/locations/global/workloadIdentityPools/{project}.svc.id.goog/subject/ns/{namespace}/sa/{ksa}`)
 *   — no Google service account involved. Applied grants are recorded in
 *   the identity state; grants no binding asks for any more are revoked on
 *   the next reconcile, and all of them on delete. With
 *   `identity.gcpServiceAccount`, the KSA is instead annotated with
 *   `iam.gke.io/gcp-service-account`, granted
 *   `roles/iam.workloadIdentityUser` on that GSA, and the binding grants
 *   go to the GSA. The cluster's `workloadIdentityConfig.workloadPool` is
 *   enabled by `GCP.Container.Cluster` (Autopilot enables it by default).
 * - **registry** — a per-workload Artifact Registry Docker repository;
 *   `main` programs are bundled, `context` Dockerfiles built, and `image`
 *   refs mirrored into it.
 * - **bootstrap** — generated container entries wiring the GCP credential
 *   chain so Workload Identity's GCE metadata server resolves inside the
 *   pod.
 * - **loadBalancerDefaults** — GKE backend-service based L4
 *   (`cloud.google.com/l4-rbs`).
 *
 * Registered by `GCP.providers()`; resolved dynamically by the
 * `Kubernetes.*` providers via the connection's `auth.kind`.
 */
import * as container from "@distilled.cloud/gcp/container_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type { HttpClient } from "effect/http/HttpClient";
import {
  ClusterAdapter,
  ClusterNotFoundError,
  type AdapterLifecycleServices,
  type ClusterAdapterService,
  type ClusterTransport,
  type ImageRegistryDeleteOptions,
  type ImageRegistryResolveOptions,
  type ImageRegistryResult,
  type WorkloadBindingContract,
  type WorkloadIdentityReconcileOptions,
} from "../../Kubernetes/ClusterAdapter.ts";
import type { Connection } from "../../Kubernetes/Connection.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { Self } from "../../Self.ts";
import {
  makeImageSource,
  type ImageSourceLike,
} from "../ArtifactRegistry/ImageSource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  projectNumber,
  revokeHostIam,
  syncHostIam,
  type AppliedIamGrant,
  type GcpIamGrant,
} from "../Host.ts";
import { revokeIamMembership, updateIamMembership } from "../IamPolicy.ts";

declare module "../../Kubernetes/Connection.ts" {
  interface AuthRegistry {
    /**
     * Authenticate against a GKE cluster with Google OAuth bearer tokens
     * minted from the ambient GCP credentials. Contributed by
     * `GCP.providers()` — `GCP.Container.Cluster` attributes expose a
     * ready-made `connection` carrying this descriptor.
     */
    "gcp-gke": {
      /** GKE cluster id (the `{cluster}` path segment). */
      clusterId: string;
      /** Zone or region (`us-central1-a`, `us-central1`, …). */
      location: string;
      /**
       * GCP project id.
       * @default the ambient GCP project
       */
      project?: string;
    };
  }
}

declare module "../../Kubernetes/ClusterAdapter.ts" {
  interface IdentityStateRegistry {
    /**
     * GKE Workload Identity Federation: binding grants are applied to the
     * Kubernetes ServiceAccount's principal (or to the GSA supplied via
     * `identity.gcpServiceAccount`).
     */
    "gcp-workload-identity": {
      /** Workload Identity pool (`{project}.svc.id.goog`). */
      workloadPool: string;
      /** Project the grants and workload pool belong to. */
      project?: string;
      /**
       * The IAM member binding grants were applied to — the KSA's
       * `principal://…` identifier, or `serviceAccount:{gsa}`.
       */
      member?: string;
      /** Grants applied to `member`, revoked once no binding asks for them. */
      iamGrants?: AppliedIamGrant[];
      /** Existing GSA email stamped on the KSA annotation, if any. */
      gcpServiceAccount?: string;
      /**
       * The KSA principal granted `roles/iam.workloadIdentityUser` on
       * `gcpServiceAccount`, if any.
       */
      impersonator?: string;
    };
  }
  interface RegistryStateRegistry {
    /** The per-workload Artifact Registry repository holding the image. */
    "gcp-artifact-registry": {
      /** Artifact Registry repository id. */
      repositoryName: string;
      /** Docker image prefix (`{loc}-docker.pkg.dev/{project}/{repo}/app`). */
      repositoryUri: string;
      /** Full resource name `projects/.../repositories/{repository}`. */
      name: string;
      /** Artifact Registry location (`us-central1`, …). */
      location: string;
    };
  }
  interface WorkloadIdentityOptions {
    /**
     * Existing Google service-account email the workload runs as (GKE
     * only). Alchemy annotates the Kubernetes ServiceAccount with
     * `iam.gke.io/gcp-service-account`, grants the KSA principal
     * `roles/iam.workloadIdentityUser` on the GSA, and lands binding
     * grants on the GSA. Omit it (the default) to grant bindings directly
     * to the KSA's Workload Identity Federation principal.
     */
    gcpServiceAccount?: string;
  }
  interface WorkloadBindingContract {
    /**
     * IAM grants landed on the workload's Workload Identity principal (GKE
     * only) — the same host-binding channel as `GCP.Run.Service` and
     * `GCP.Function`.
     */
    iam?: GcpIamGrant[];
  }
  interface WorkloadServicesRegistry {
    /** GCP credential-chain services ambient inside GKE workload pods. */
    gcp: Credentials | GcpEnvironment;
  }
}

/** Services the adapter's methods close over at layer build. */
type GkeAdapterDeps =
  | Credentials
  | GcpEnvironment
  | HttpClient
  | FileSystem.FileSystem
  | Path.Path
  // Hashing an unbundled Node image resolves installed packages.
  | ChildProcessSpawner;

const GSA_ANNOTATION = "iam.gke.io/gcp-service-account";

/** Zone `us-central1-a` → region `us-central1`; regions pass through. */
export const regionOfLocation = (location: string) => {
  const parts = location.split("-");
  const last = parts[parts.length - 1] ?? "";
  if (parts.length >= 3 && last.length === 1) {
    return parts.slice(0, -1).join("-");
  }
  return location;
};

export const apiServerEndpoint = (endpoint: string | undefined) => {
  if (endpoint === undefined || endpoint.length === 0) return undefined;
  return endpoint.startsWith("https://") || endpoint.startsWith("http://")
    ? endpoint
    : `https://${endpoint}`;
};

export const workloadPoolOf = (project: string) => `${project}.svc.id.goog`;

/**
 * The Workload Identity Federation principal of a Kubernetes
 * ServiceAccount — the IAM member GKE pods running as that KSA
 * authenticate as. Every cluster in the project shares the pool, so the
 * same `namespace`/`serviceAccount` pair is one identity project-wide.
 */
export const workloadIdentityPrincipal = (options: {
  projectNumber: string;
  project: string;
  namespace: string;
  serviceAccount: string;
}) =>
  `principal://iam.googleapis.com/projects/${options.projectNumber}` +
  `/locations/global/workloadIdentityPools/${workloadPoolOf(options.project)}` +
  `/subject/ns/${options.namespace}/sa/${options.serviceAccount}`;

const WORKLOAD_IDENTITY_USER = "roles/iam.workloadIdentityUser";

const gsaResourceName = (email: string) =>
  `projects/-/serviceAccounts/${email}`;

/** Binding channels a GKE workload can materialize. */
const GKE_BINDING_KEYS = new Set(["env", "iam"]);

/** Narrow persisted identity state (possibly a legacy shape). */
const identityStateOf = (state: Record<string, unknown> | undefined) => ({
  member: typeof state?.member === "string" ? state.member : undefined,
  iamGrants: Array.isArray(state?.iamGrants)
    ? (state.iamGrants as AppliedIamGrant[])
    : [],
  gcpServiceAccount:
    typeof state?.gcpServiceAccount === "string"
      ? state.gcpServiceAccount
      : undefined,
  impersonator:
    typeof state?.impersonator === "string" ? state.impersonator : undefined,
});

/**
 * Build a {@link ClusterTransport} for a GKE cluster from known
 * endpoint/CA. Captures the ambient GCP credentials so the per-request
 * token mint is self-contained — used by the adapter and by the
 * `GCP.Container.Cluster` provider's kubernetes-object binding channel.
 */
export const makeGkeTransport = Effect.fn(function* (options: {
  endpoint: string;
  certificateAuthorityData: string;
}) {
  const context = yield* Effect.context<Credentials>();
  return {
    endpoint: options.endpoint,
    certificateAuthorityData: options.certificateAuthorityData,
    headers: Effect.gen(function* () {
      const creds = yield* yield* Credentials;
      return {
        Authorization: `Bearer ${Redacted.value(creds.accessToken)}`,
      };
    }).pipe(Effect.provideContext(context)),
  } satisfies ClusterTransport;
});

/**
 * The `Kubernetes.Connection` of a GKE cluster — stamped on
 * `GCP.Container.Cluster` attributes so the cluster resource can be passed
 * directly as any `Kubernetes.*` workload's `cluster`.
 */
export const gkeConnectionOf = (options: {
  clusterId: string;
  location: string;
  project?: string | undefined;
  endpoint?: string | undefined;
  certificateAuthorityData?: string | undefined;
}): Connection => ({
  endpoint: apiServerEndpoint(options.endpoint) ?? options.endpoint,
  certificateAuthorityData: options.certificateAuthorityData,
  auth: {
    kind: "gcp-gke",
    clusterId: options.clusterId,
    location: options.location,
    project: options.project,
  },
});

const narrowGkeAuth = (connection: Connection) =>
  connection.auth.kind === "gcp-gke"
    ? Effect.succeed(connection.auth)
    : Effect.die(
        new Error(
          `gcp-gke adapter received auth kind '${connection.auth.kind}'`,
        ),
      );

const clusterResourceName = (
  project: string,
  location: string,
  clusterId: string,
) => `projects/${project}/locations/${location}/clusters/${clusterId}`;

const createRepositoryName = (id: string) =>
  createPhysicalName({
    id: `${id}-repo`,
    maxLength: 63,
    lowercase: true,
  });

/**
 * Generated container entry for an Effect-native GKE server: resolves the
 * program's registered runners and serves the returned `{ fetch }` handler
 * on `PORT`. Credentials use the GCP chain so Workload Identity's GCE
 * metadata server resolves inside the pod.
 */
export const makeGkeServerBootstrap =
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
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { fromChain, fromCredentials } from "alchemy/GCP";

import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

const tag = Context.Service("${Self.key}");
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

const program = tag.pipe(
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
        Config.String("ALCHEMY_STACK_NAME"),
        Config.String("ALCHEMY_STAGE")
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    )),
      Layer.provideMerge(fromCredentials()),
      Layer.provideMerge(fromChain()),
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

console.log(\`GKE Deployment bootstrap starting on port \${process.env.PORT ?? 3000}...\`);
await Effect.runPromise(program).catch((err) => {
  console.error("GKE Deployment bootstrap failed:", err);
  process.exit(1);
});
`;

/**
 * Generated container entry for an Effect-native GKE Job: resolves the
 * program's `run` effect, executes it to completion, and exits. Credentials
 * use the GCP chain so Workload Identity's GCE metadata server resolves
 * inside the pod.
 */
export const makeGkeJobBootstrap =
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
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { fromChain, fromCredentials } from "alchemy/GCP";

import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

const tag = Context.Service("${Self.key}");
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

const program = tag.pipe(
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
        Config.String("ALCHEMY_STACK_NAME"),
        Config.String("ALCHEMY_STAGE")
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    )),
      Layer.provideMerge(fromCredentials()),
      Layer.provideMerge(fromChain()),
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

console.log("GKE Job bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("GKE Job bootstrap failed:", err);
  process.exit(1);
});
process.exit(0);
`;

/**
 * The `gcp-gke` cluster adapter layer. Provided (merged) by
 * `GCP.providers()` so the `Kubernetes.*` workload providers can resolve
 * it from the stack context.
 */
export const GkeKubernetesAdapter = () =>
  Layer.effect(
    ClusterAdapter("gcp-gke"),
    Effect.gen(function* () {
      const imageSource = yield* makeImageSource;
      const context = yield* Effect.context<GkeAdapterDeps>();

      const withGcp = <A, E, R>(self: Effect.Effect<A, E, R>) =>
        Effect.provideContext(self, context);

      const getLiveCluster = Effect.fn(function* (auth: {
        clusterId: string;
        location: string;
        project?: string | undefined;
      }) {
        const cluster = yield* Effect.gen(function* () {
          const env = yield* GcpEnvironment.current;
          const project = auth.project ?? env.project;
          const name = clusterResourceName(
            project,
            auth.location,
            auth.clusterId,
          );
          return yield* container
            .getProjectsLocationsClusters({ name })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        }).pipe(withGcp);
        if (!cluster || cluster.status === "STOPPING") {
          return yield* Effect.fail(
            new ClusterNotFoundError({
              message: `GKE cluster '${auth.clusterId}' no longer exists`,
            }),
          );
        }
        return cluster;
      });

      const connect: ClusterAdapterService["connect"] = (connection) =>
        Effect.gen(function* () {
          const auth = yield* narrowGkeAuth(connection);
          let endpoint = apiServerEndpoint(connection.endpoint);
          let certificateAuthorityData = connection.certificateAuthorityData;
          if (!endpoint || !certificateAuthorityData) {
            const cluster = yield* getLiveCluster(auth);
            endpoint = apiServerEndpoint(cluster.endpoint);
            certificateAuthorityData = cluster.masterAuth?.clusterCaCertificate;
            if (!endpoint || !certificateAuthorityData) {
              return yield* Effect.fail(
                new Error(
                  `GKE cluster '${auth.clusterId}' has no endpoint or ` +
                    "certificate authority data yet (still creating?)",
                ),
              );
            }
          }
          return yield* makeGkeTransport({
            endpoint,
            certificateAuthorityData,
          });
        }).pipe(
          withGcp,
          Effect.mapError((error): ClusterNotFoundError | Error =>
            error instanceof ClusterNotFoundError || error instanceof Error
              ? error
              : new Error(String(error)),
          ),
        );

      const identityReconcile = Effect.fn(function* (
        options: WorkloadIdentityReconcileOptions,
      ) {
        const auth = yield* narrowGkeAuth(options.connection);
        const bindings = options.bindings.filter(
          (
            binding: ResourceBinding<WorkloadBindingContract> & {
              action?: string;
            },
          ) => binding.action !== "delete",
        );
        const unsupported = [
          ...new Set(
            bindings.flatMap((binding) =>
              Object.entries(binding.data ?? {})
                .filter(
                  ([key, value]) =>
                    value !== undefined && !GKE_BINDING_KEYS.has(key),
                )
                .map(([key]) => key),
            ),
          ),
        ];
        if (unsupported.length > 0) {
          return yield* Effect.die(
            new Error(
              `'${options.id}': bindings carry ${unsupported.join(", ")}, ` +
                "which GKE workloads cannot materialize (only env and " +
                "GCP `iam` grants).",
            ),
          );
        }
        return yield* Effect.gen(function* () {
          const env = yield* GcpEnvironment.current;
          const project = auth.project ?? env.project;
          const workloadPool = workloadPoolOf(project);
          const principal = workloadIdentityPrincipal({
            projectNumber: yield* projectNumber(project),
            project,
            namespace: options.namespace,
            serviceAccount: options.serviceAccount,
          });
          const gcpServiceAccount = options.options?.gcpServiceAccount;
          const member = gcpServiceAccount
            ? `serviceAccount:${gcpServiceAccount}`
            : principal;
          const previous = identityStateOf(options.state);

          // Let the KSA impersonate the user-supplied GSA.
          if (gcpServiceAccount) {
            yield* updateIamMembership({
              kind: "iam.serviceAccount",
              name: gsaResourceName(gcpServiceAccount),
              member: principal,
              add: [WORKLOAD_IDENTITY_USER],
            });
          }
          if (
            previous.gcpServiceAccount !== undefined &&
            previous.impersonator !== undefined &&
            (previous.gcpServiceAccount !== gcpServiceAccount ||
              previous.impersonator !== principal)
          ) {
            yield* revokeIamMembership({
              kind: "iam.serviceAccount",
              name: gsaResourceName(previous.gcpServiceAccount),
              member: previous.impersonator,
              roles: [WORKLOAD_IDENTITY_USER],
            });
          }

          // A renamed KSA / namespace or a GSA switch is a new member: its
          // predecessor loses everything it was granted.
          const sameMember = previous.member === member;
          if (previous.member !== undefined && !sameMember) {
            yield* revokeHostIam({
              serviceAccount: previous.member,
              grants: previous.iamGrants,
            });
          }
          const { grants } = yield* syncHostIam({
            project,
            serviceAccount: member,
            // The principal is shared by every cluster in the project, so
            // only grants this workload recorded are ever revoked.
            managed: false,
            bindings,
            previous: sameMember ? previous.iamGrants : undefined,
          });

          return {
            env: {
              GOOGLE_PROJECT_ID: project,
              GOOGLE_CLOUD_PROJECT: project,
            },
            serviceAccountAnnotations: gcpServiceAccount
              ? { [GSA_ANNOTATION]: gcpServiceAccount }
              : undefined,
            state: {
              kind: "gcp-workload-identity" as const,
              workloadPool,
              project,
              member,
              iamGrants: grants,
              gcpServiceAccount,
              impersonator: gcpServiceAccount ? principal : undefined,
            },
          };
        }).pipe(withGcp);
      });

      const identityDelete = Effect.fn(function* (options: {
        connection: Connection | undefined;
        state: Record<string, unknown> | undefined;
      }) {
        // Grants live on project / resource IAM policies, not on the
        // cluster, so they are revoked even when the cluster is gone. The
        // KSA itself dies with the workload's objects.
        const state = identityStateOf(options.state);
        yield* Effect.gen(function* () {
          if (state.member !== undefined) {
            yield* revokeHostIam({
              serviceAccount: state.member,
              grants: state.iamGrants,
            });
          }
          if (
            state.gcpServiceAccount !== undefined &&
            state.impersonator !== undefined
          ) {
            yield* revokeIamMembership({
              kind: "iam.serviceAccount",
              name: gsaResourceName(state.gcpServiceAccount),
              member: state.impersonator,
              roles: [WORKLOAD_IDENTITY_USER],
            });
          }
        }).pipe(withGcp);
      });

      const registryResolve = (
        options: ImageRegistryResolveOptions,
      ): Effect.Effect<ImageRegistryResult, any, AdapterLifecycleServices> =>
        Effect.gen(function* () {
          const state = options.state;
          const env = yield* GcpEnvironment.current;
          const location =
            typeof state?.location === "string" ? state.location : env.region;
          const repositoryName =
            typeof state?.repositoryName === "string"
              ? state.repositoryName
              : yield* createRepositoryName(options.id);
          const repositoryUri =
            typeof state?.repositoryUri === "string" &&
            state.repositoryName === repositoryName
              ? state.repositoryUri
              : undefined;
          const resolved = yield* imageSource.resolve({
            id: options.id,
            source: options.source as ImageSourceLike,
            repositoryName,
            repositoryUri,
            location,
            tags: options.tags,
            platform: options.platform,
            port: options.port,
            isExternal: options.isExternal,
            bootstrap: options.bootstrap,
            session: options.session,
          });
          return {
            imageUri: resolved.imageUri,
            codeHash: resolved.codeHash,
            state: {
              kind: "gcp-artifact-registry" as const,
              repositoryName: resolved.repositoryName,
              repositoryUri: resolved.repositoryUri,
              location,
              name:
                typeof state?.name === "string" &&
                state.repositoryName === repositoryName
                  ? state.name
                  : imageSource.resourceName(
                      env.project,
                      location,
                      resolved.repositoryName,
                    ),
            },
          } satisfies ImageRegistryResult;
        }).pipe(withGcp) as Effect.Effect<
          ImageRegistryResult,
          any,
          AdapterLifecycleServices
        >;

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
          .pipe(withGcp);
      });

      const registryDelete = (
        options: ImageRegistryDeleteOptions,
      ): Effect.Effect<void, any, AdapterLifecycleServices> =>
        Effect.gen(function* () {
          if (typeof options.state?.name !== "string") return;
          yield* imageSource.destroyRepository(options.state.name);
        }).pipe(withGcp) as Effect.Effect<void, any, AdapterLifecycleServices>;

      const loadBalancerDefaults = Effect.fn(function* (_options: {
        connection: Connection;
      }) {
        return {
          loadBalancerClass: undefined,
          annotations: {
            "cloud.google.com/l4-rbs": "enabled",
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
          server: makeGkeServerBootstrap,
          job: makeGkeJobBootstrap,
        },
        loadBalancerDefaults,
      } satisfies ClusterAdapterService;
    }),
  );

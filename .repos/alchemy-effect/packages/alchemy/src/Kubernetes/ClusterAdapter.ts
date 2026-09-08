/**
 * The extension seam between the cluster-agnostic `Kubernetes.*` workloads
 * and the platform a cluster runs on.
 *
 * A {@link ClusterAdapterService} is registered under a keyed Context tag —
 * `Kubernetes.ClusterAdapter/<auth kind>` — and resolved dynamically from
 * the ambient provider context by {@link findClusterAdapter}, mirroring how
 * resource providers are resolved by type. `Kubernetes.providers()` ships
 * the built-in adapters (`kubeconfig`, `token`, `client-cert`, `exec`);
 * cloud provider layers contribute theirs (`AWS.providers()` registers
 * `aws-eks`).
 *
 * An adapter owns everything platform-specific:
 *
 * - **connect** (required) — resolve the API server endpoint/CA and mint
 *   per-request auth headers.
 * - **identity** (optional) — provision workload identity for a namespace +
 *   service account and translate host bindings into cloud credentials
 *   (EKS Pod Identity; Azure Workload Identity would slot in here).
 * - **registry** (optional) — build/mirror container images into a managed
 *   registry the cluster can pull from (ECR on EKS).
 * - **bootstrap** (optional) — platform-specific generated container
 *   entries for Effect-native workloads (e.g. wiring the AWS credential
 *   chain for Pod Identity).
 * - **loadBalancerDefaults** (optional) — platform defaults for
 *   `LoadBalancer` Services (EKS Auto Mode's `loadBalancerClass` +
 *   internet-facing scheme).
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Bundle from "../Bundle/Bundle.ts";
import type { InstanceId } from "../InstanceId.ts";
import type { ResourceBinding } from "../Resource.ts";
import type { InlineDockerfile } from "../Docker/Dockerfile.ts";
import type { Stack } from "../Stack.ts";
import type { Stage } from "../Stage.ts";
import type { Connection } from "./Connection.ts";

/**
 * Per-resource engine services ambient inside every provider lifecycle
 * operation. Adapter methods run inside the workload providers' lifecycle
 * ops, so they may require these (physical-name generation needs the
 * resource's InstanceId + Stack + Stage) — everything else an adapter
 * needs is captured at its layer build.
 */
export type AdapterLifecycleServices = InstanceId | Stack | Stage;

/**
 * The target cluster no longer exists (definitively — e.g. the managed
 * control plane is deleted or deleting). Distinct from transient
 * unreachability: `read`/`delete` treat this as "everything in-cluster is
 * already gone".
 */
export class ClusterNotFoundError extends Data.TaggedError(
  "Kubernetes.ClusterNotFoundError",
)<{
  message: string;
}> {}

/**
 * A resolved transport to a cluster's API server. `headers` is an Effect
 * so short-lived tokens (EKS SigV4 presigns, exec plugin credentials) are
 * minted per request.
 */
export interface ClusterTransport {
  /** The API server endpoint URL. */
  endpoint: string;
  /** Base64-encoded PEM certificate authority bundle. */
  certificateAuthorityData?: string;
  /** Skip TLS verification (self-signed local clusters). */
  insecureSkipTlsVerify?: boolean;
  /** Mint the auth headers for one request. */
  headers: Effect.Effect<Record<string, string>, Error>;
  /** PEM client certificate credentials for mutual TLS. */
  clientCert?: { certificate: string; key: string };
}

/**
 * Workload identity state persisted on a workload's attributes, keyed by
 * adapter kind. Cloud providers extend it via module augmentation — AWS
 * registers:
 *
 * ```ts
 * declare module "../../Kubernetes/ClusterAdapter.ts" {
 *   interface IdentityStateRegistry {
 *     "aws-pod-identity": {
 *       roleArn: string;
 *       roleName: string;
 *       associationArn: string;
 *       associationId: string;
 *     };
 *   }
 * }
 * ```
 */
export interface IdentityStateRegistry {}

/** The discriminated identity-state union across all registered adapters. */
export type IdentityState = {
  [K in keyof IdentityStateRegistry]: {
    readonly kind: K;
  } & IdentityStateRegistry[K];
}[keyof IdentityStateRegistry];

/**
 * Image-registry state persisted on a workload's attributes, keyed by
 * adapter kind (AWS registers `"aws-ecr"` with the repository name/URI).
 */
export interface RegistryStateRegistry {}

/** The discriminated registry-state union across all registered adapters. */
export type RegistryState = {
  [K in keyof RegistryStateRegistry]: {
    readonly kind: K;
  } & RegistryStateRegistry[K];
}[keyof RegistryStateRegistry];

/**
 * Cloud-specific workload identity options, extended via module
 * augmentation (AWS adds `managedPolicyArns`).
 */
export interface WorkloadIdentityOptions {}

/**
 * The binding contract of `Kubernetes.Deployment` / `Kubernetes.Job`
 * hosts. The core contract is environment variables; cloud providers
 * augment it with their credential-grant channels (AWS adds
 * `policyStatements`), which the matching {@link ClusterAdapterService}'s
 * identity adapter materializes at deploy time.
 */
export interface WorkloadBindingContract {
  env?: Record<string, any>;
}

/**
 * Ambient runtime services the workload platforms assume inside the
 * deployed container, keyed by contributor and extended via module
 * augmentation — AWS registers its credential-chain services so inline
 * impls can use AWS bindings without providing them:
 *
 * ```ts
 * declare module "../../Kubernetes/ClusterAdapter.ts" {
 *   interface WorkloadServicesRegistry {
 *     aws: Credentials | Region | AWSEnvironment;
 *   }
 * }
 * ```
 */
export interface WorkloadServicesRegistry {}

/** The union of all registered ambient workload services. */
export type WorkloadServices =
  WorkloadServicesRegistry[keyof WorkloadServicesRegistry];

/**
 * The image-source shape shared by every workload: exactly one of `main`
 * (bundle an inline Effect program), `context`/`dockerfile` (build the
 * user's Dockerfile), or `image` (a pre-built registry reference).
 * Structurally mirrors the AWS container platforms' source props.
 */
export interface WorkloadImageSource {
  main?: string;
  handler?: string;
  /**
   * Bundler configuration for `main`: rolldown `input`/`output` overrides
   * plus pure-annotation options (`pure`). `effect`, `@effect/*`,
   * `alchemy`, `@alchemy.run/*`, and `@distilled.cloud/*` are annotated as
   * pure by default so unused code from those packages is tree-shaken; list
   * additional packages via `pure.packages`, or disable with `pure: false`.
   */
  build?: Bundle.BundleConfig;
  context?: string;
  dockerfile?: string | InlineDockerfile;
  image?: string;
}

export interface WorkloadIdentityReconcileOptions {
  /** Logical resource id. */
  id: string;
  /** The resolved cluster connection. */
  connection: Connection;
  /** The namespace the workload runs in. */
  namespace: string;
  /** The service account name the workload's pods run as. */
  serviceAccount: string;
  /** Host bindings attached to the workload. */
  bindings: ResourceBinding<WorkloadBindingContract>[];
  /** Cloud-specific identity options from the workload's `identity` prop. */
  options: WorkloadIdentityOptions | undefined;
  /**
   * Previously persisted identity state, if any — untyped hints because
   * legacy pre-rename rows carry the old flat attribute shape; adapters
   * narrow structurally and re-observe cloud state as the authority.
   */
  state: Record<string, unknown> | undefined;
  /** Internal + user tags for identity-owned cloud resources. */
  tags: Record<string, string>;
}

export interface WorkloadIdentityResult {
  /** Extra container environment collected from bindings. */
  env: Record<string, any>;
  /** Annotations to stamp on the workload's ServiceAccount object. */
  serviceAccountAnnotations?: Record<string, string>;
  /** Serializable state persisted on the workload's attributes. */
  state: IdentityState | undefined;
}

export interface WorkloadIdentityDeleteOptions {
  /** The persisted cluster connection (may reference a gone cluster). */
  connection: Connection | undefined;
  /**
   * The persisted identity state. Untyped because legacy pre-rename rows
   * carry the old flat attribute shape — adapters narrow structurally.
   */
  state: Record<string, unknown> | undefined;
}

export interface ImageRegistryResolveOptions {
  /** Logical resource id — keys generated repository names. */
  id: string;
  /** The image-source props bag. */
  source: WorkloadImageSource;
  /** Target image platform (`linux/amd64` / `linux/arm64`). */
  platform: string;
  /** Port the generated Dockerfile exposes (`main` sources only). */
  port?: number;
  /** True when `main` bundles as-is (no Effect bootstrap entry). */
  isExternal?: boolean;
  /** The generated-entry bootstrap wrapped around `main`. */
  bootstrap: (importPath: string) => string;
  /** Tags for registry-owned cloud resources. */
  tags: Record<string, string>;
  /**
   * Previously persisted registry state, if any — untyped hints because
   * legacy pre-rename rows carry the old flat attribute shape; adapters
   * narrow structurally.
   */
  state: Record<string, unknown> | undefined;
  /** Plan-status session for build/push progress notes. */
  session: { note: (message: string) => Effect.Effect<void> };
}

export interface ImageRegistryResult {
  /** Full image reference the pod spec should run. */
  imageUri: string;
  /** Content hash identifying the image. */
  codeHash: string;
  /** Serializable state persisted on the workload's attributes. */
  state: RegistryState | undefined;
}

export interface ImageRegistryHashOptions {
  source: WorkloadImageSource;
  platform: string;
  port?: number;
  isExternal?: boolean;
  bootstrap: (importPath: string) => string;
}

export interface ImageRegistryDeleteOptions {
  /**
   * The persisted registry state. Untyped because legacy pre-rename rows
   * carry the old flat attribute shape — adapters narrow structurally.
   */
  state: Record<string, unknown> | undefined;
}

export interface ClusterAdapterService {
  readonly kind: "Kubernetes.ClusterAdapter";
  /**
   * Resolve the transport for a connection: discover the endpoint/CA when
   * the connection doesn't carry them, and return a per-request auth
   * header mint. Fails with {@link ClusterNotFoundError} when the cluster
   * definitively no longer exists.
   */
  readonly connect: (
    connection: Connection,
  ) => Effect.Effect<ClusterTransport, ClusterNotFoundError | Error>;
  /** Workload identity provisioning (Pod Identity on EKS). */
  readonly identity?: {
    readonly reconcile: (
      options: WorkloadIdentityReconcileOptions,
    ) => Effect.Effect<WorkloadIdentityResult, any, AdapterLifecycleServices>;
    readonly delete: (
      options: WorkloadIdentityDeleteOptions,
    ) => Effect.Effect<void, any, AdapterLifecycleServices>;
  };
  /** Managed container-image registry (ECR on EKS). */
  readonly registry?: {
    readonly resolve: (
      options: ImageRegistryResolveOptions,
    ) => Effect.Effect<ImageRegistryResult, any, AdapterLifecycleServices>;
    /** Plan-time content hash used by `diff` to surface source drift. */
    readonly hash: (
      options: ImageRegistryHashOptions,
    ) => Effect.Effect<string | undefined, any, AdapterLifecycleServices>;
    readonly delete: (
      options: ImageRegistryDeleteOptions,
    ) => Effect.Effect<void, any, AdapterLifecycleServices>;
  };
  /**
   * Platform-specific generated container entries for Effect-native
   * workloads. Defaults to the platform-neutral bootstraps when omitted.
   */
  readonly bootstrap?: {
    readonly server?: (handler: string) => (importPath: string) => string;
    readonly job?: (handler: string) => (importPath: string) => string;
  };
  /**
   * Platform defaults applied to a `LoadBalancer` Service (EKS Auto Mode
   * sets `loadBalancerClass: eks.amazonaws.com/nlb` and defaults the
   * scheme to internet-facing). User `serviceAnnotations` always win.
   */
  readonly loadBalancerDefaults?: (options: {
    connection: Connection;
  }) => Effect.Effect<
    {
      loadBalancerClass?: string | undefined;
      annotations?: Record<string, string>;
    },
    any,
    AdapterLifecycleServices
  >;
}

const adapterKey = (authKind: string) =>
  `Kubernetes.ClusterAdapter/${authKind}`;

/**
 * The keyed Context tag for an adapter. Same auth kind → same tag, so a
 * layer built with `ClusterAdapter("aws-eks")` is found by any dynamic
 * lookup for that kind.
 */
export const ClusterAdapter = (
  authKind: string,
): Context.Service<ClusterAdapterService, ClusterAdapterService> =>
  Context.Service<ClusterAdapterService, ClusterAdapterService>()(
    adapterKey(authKind),
  ) as any;

/**
 * Resolve the {@link ClusterAdapterService} for a connection's auth kind
 * from the ambient context (the stack's composed provider layers). Dies
 * with setup guidance when no adapter is registered — that means the
 * provider layer contributing it (e.g. `AWS.providers()` for `aws-eks`)
 * is missing from the stack.
 */
export const findClusterAdapter = (
  authKind: string,
): Effect.Effect<ClusterAdapterService> =>
  Effect.serviceOption(ClusterAdapter(authKind)).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (adapter) => Effect.succeed(adapter),
        onNone: () =>
          Effect.die(
            new Error(
              `No Kubernetes cluster adapter is registered for auth kind ` +
                `'${authKind}'. Add the provider layer that contributes it ` +
                `to the stack's providers — e.g. 'aws-eks' ships with ` +
                "`AWS.providers()`; the built-in kinds (kubeconfig, token, " +
                "client-cert, exec) ship with `Kubernetes.providers()`. " +
                "Compose multiple provider layers with " +
                "`Layer.mergeAll(AWS.providers(), Kubernetes.providers())`.",
            ),
          ),
      }),
    ),
  );

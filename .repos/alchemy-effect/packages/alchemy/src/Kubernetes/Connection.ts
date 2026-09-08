/**
 * The cluster-agnostic Kubernetes connection model.
 *
 * Every `Kubernetes.*` workload (`Deployment`, `Job`, `Manifest`,
 * `HelmChart`) targets a cluster through a serializable {@link Connection}:
 * the API server endpoint (or enough information to discover it) plus an
 * {@link ConnectionAuth} descriptor whose `kind` selects the
 * {@link ClusterAdapter} that knows how to authenticate requests — and,
 * for managed clouds, how to provision workload identity and container
 * images.
 *
 * A `Connection` is plain data on purpose: it is resolved from resource
 * attributes at reconcile time and persisted on workload attributes so
 * `delete` can reconnect without the original resource graph.
 */

/**
 * The auth descriptor registry, keyed by adapter kind. Cloud providers
 * extend it via module augmentation — e.g. AWS registers:
 *
 * ```ts
 * declare module "../../Kubernetes/Connection.ts" {
 *   interface AuthRegistry {
 *     "aws-eks": { clusterName: string; region?: string };
 *   }
 * }
 * ```
 *
 * The built-in kinds cover anything `kubectl` can reach: a kubeconfig
 * context (including `exec` credential plugins — `aws eks get-token`,
 * `kubelogin`, `gke-gcloud-auth-plugin`), a static bearer token, a client
 * certificate, or a raw exec credential plugin invocation.
 */
export interface AuthRegistry {
  /**
   * Resolve the cluster, user, and credentials from a kubeconfig file —
   * the "anything kubectl can reach" adapter. Honors client certificates,
   * static tokens, and `exec` credential plugins declared in the file.
   */
  kubeconfig: {
    /**
     * Path to the kubeconfig file.
     * @default `$KUBECONFIG` or `~/.kube/config`
     */
    path?: string;
    /**
     * The context to use.
     * @default the file's `current-context`
     */
    context?: string;
  };
  /** Authenticate with a static bearer token. */
  token: {
    /** The bearer token sent as `Authorization: Bearer <token>`. */
    token: string;
  };
  /** Authenticate with a client certificate (mutual TLS). */
  "client-cert": {
    /** PEM-encoded client certificate. */
    certificate: string;
    /** PEM-encoded client private key. */
    key: string;
  };
  /**
   * Mint credentials with a kubeconfig-style exec credential plugin
   * (`client.authentication.k8s.io` ExecCredential protocol).
   */
  exec: {
    /** The command to run (e.g. `aws`). */
    command: string;
    /** Arguments (e.g. `["eks", "get-token", "--cluster-name", "x"]`). */
    args?: string[];
    /** Extra environment variables for the plugin process. */
    env?: Record<string, string>;
  };
}

/**
 * The discriminated auth union — one member per {@link AuthRegistry} entry,
 * each tagged with its registry key as `kind`.
 */
export type ConnectionAuth = {
  [K in keyof AuthRegistry]: { readonly kind: K } & AuthRegistry[K];
}[keyof AuthRegistry];

/**
 * A serializable description of how to reach and authenticate against a
 * Kubernetes API server.
 */
export interface Connection {
  /**
   * The API server endpoint URL. Optional when the auth adapter can
   * discover it (a kubeconfig file carries the server; the EKS adapter
   * re-describes the cluster).
   */
  endpoint?: string;
  /** Base64-encoded PEM certificate authority bundle for the endpoint. */
  certificateAuthorityData?: string;
  /** Skip TLS verification (self-signed local clusters). */
  insecureSkipTlsVerify?: boolean;
  /** How to authenticate — selects the {@link ClusterAdapter} by `kind`. */
  auth: ConnectionAuth;
}

/**
 * Anything a `Kubernetes.*` workload accepts as its `cluster` prop: a raw
 * {@link Connection}, or any value exposing one as a `connection` field —
 * which is how managed cluster resources (`AWS.EKS.Cluster`) participate:
 * their attributes carry a `connection`, so the whole resource can be
 * passed directly.
 */
export type ClusterLike = Connection | { connection: Connection };

const isConnection = (value: ClusterLike): value is Connection =>
  "auth" in value && value.auth !== undefined;

/**
 * Normalize a {@link ClusterLike} to its {@link Connection}. Throws when
 * the value carries neither shape — e.g. a managed cluster resource whose
 * attributes predate the `connection` field.
 */
export const toConnection = (cluster: ClusterLike): Connection => {
  if (isConnection(cluster)) return cluster;
  if (cluster.connection !== undefined) return cluster.connection;
  throw new Error(
    "The `cluster` value carries no Kubernetes connection. Pass a cluster " +
      "resource whose attributes expose `connection` (e.g. `AWS.EKS.Cluster`" +
      " — redeploy the cluster if it was created before the `connection` " +
      "attribute existed), a `Kubernetes.KubeConfig(...)`, or a raw " +
      "`Kubernetes.Connection`.",
  );
};

/**
 * Connect `Kubernetes.*` workloads to any cluster your local kubeconfig can
 * reach — k3s, kind, on-prem, AKS, GKE, anything `kubectl` works against.
 * Exec credential plugins declared in the file (`aws eks get-token`,
 * `kubelogin`, `gke-gcloud-auth-plugin`) are honored, so cloud-CLI-managed
 * contexts work as-is.
 *
 * This is a plain helper, not a resource: nothing is provisioned and the
 * cluster appears in no plan — it only describes how to reach the API
 * server.
 *
 * ```ts
 * const cluster = Kubernetes.KubeConfig({ context: "prod-east" });
 *
 * const api = yield* Kubernetes.Deployment("Api", {
 *   cluster,
 *   image: "ghcr.io/acme/api:v3",
 *   port: 8080,
 * });
 * ```
 */
export const KubeConfig = (options?: {
  /**
   * Path to the kubeconfig file.
   * @default `$KUBECONFIG` or `~/.kube/config`
   */
  path?: string;
  /**
   * The context to use.
   * @default the file's `current-context`
   */
  context?: string;
}): Connection => ({
  auth: {
    kind: "kubeconfig",
    path: options?.path,
    context: options?.context,
  },
});

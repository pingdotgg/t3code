import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { isPlainObject } from "alchemy/Util/data";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  applyObject,
  connectCluster,
  deleteObject,
  ifClusterExists,
  readObject,
} from "./Client.ts";
import { toConnection, type ClusterLike, type Connection } from "./Connection.ts";
import { driftMask, hashDriftSelection } from "./internal/declared.ts";
import { connectionIdentity, connectionOfOutput, tryConnectionOf } from "./internal/workload.ts";
import type { KubernetesObjectDefinition, KubernetesObjectRef } from "./Objects.ts";
import type { Providers } from "./Providers.ts";

export class ManifestInvalidProps extends Data.TaggedError("ManifestInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A literal Kubernetes object: `apiVersion` + `kind` + `metadata`, with the
 * rest of the object's fields (`spec`, `data`, …) carried as-is. Any kind is
 * accepted — built-in objects and CRDs alike; the API server validates the
 * shape on apply.
 */
export interface KubernetesManifest {
  apiVersion: string;
  kind: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ManifestProps {
  /**
   * Target cluster the manifest is applied onto. Pass a managed cluster
   * resource (e.g. `AWS.EKS.Cluster`), a `Kubernetes.KubeConfig(...)`, or
   * a raw `Kubernetes.Connection`.
   */
  cluster: ClusterLike;
  /**
   * The Kubernetes object to apply (server-side apply, field manager
   * `alchemy`) — a literal object with `apiVersion`, `kind`, `metadata`, and
   * the kind's own fields. Arbitrary CRDs are supported via API discovery.
   */
  manifest: KubernetesManifest;
}

export interface Manifest extends Resource<
  "Kubernetes.Manifest",
  ManifestProps,
  {
    /** The connection of the cluster the object is applied to. */
    connection: Connection;
    /** The Kubernetes API version of the applied object. */
    apiVersion: string;
    /** The Kubernetes kind of the applied object. */
    kind: string;
    /** The name of the applied object. */
    name: string;
    /** The namespace of the applied object (`undefined` for cluster-scoped kinds). */
    namespace: string | undefined;
    /** Reference to the applied Kubernetes object. */
    ref: KubernetesObjectRef;
    /** The server-assigned UID of the applied object, when returned. */
    uid: string | undefined;
    /**
     * Fingerprint of the declared fields last applied. `read` compares a GET
     * projected through {@link driftMask} to this.
     */
    baselineHash?: string;
    /**
     * Declared-field mask from the last apply. Older state omits it and is
     * compared with the same selection against the stored manifest.
     */
    driftMask?: unknown;
    /**
     * Set by `read` when the live object diverges. Reconcile does not persist
     * it; the extra field is what `alchemy drift` compares.
     */
    observedHash?: string;
  },
  {},
  Providers
> {}

/**
 * Applies a raw Kubernetes manifest onto any cluster via server-side
 * apply.
 *
 * Any literal object is accepted — built-in kinds and custom resources
 * alike; unknown kinds are resolved through the Kubernetes API discovery
 * endpoint, so CRDs work without any registration. The target `cluster`
 * can be a managed cluster resource (e.g. `AWS.EKS.Cluster`) or any
 * cluster your kubeconfig can reach (`Kubernetes.KubeConfig(...)`).
 * ### Applying Manifests
 * **Example:** StatefulSet
 * ```typescript
 * const sts = yield* Kubernetes.Manifest("Cache", {
 *   cluster,
 *   manifest: {
 *     apiVersion: "apps/v1",
 *     kind: "StatefulSet",
 *     metadata: { name: "cache", namespace: "apps" },
 *     spec: {
 *       serviceName: "cache",
 *       replicas: 3,
 *       selector: { matchLabels: { app: "cache" } },
 *       template: {
 *         metadata: { labels: { app: "cache" } },
 *         spec: { containers: [{ name: "redis", image: "redis:7" }] },
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Custom resource (CRD)
 * ```typescript
 * const widget = yield* Kubernetes.Manifest("Widget", {
 *   cluster,
 *   manifest: {
 *     apiVersion: "acme.io/v1",
 *     kind: "Widget",
 *     metadata: { name: "w", namespace: "default" },
 *     spec: { size: 3 },
 *   },
 * });
 * ```
 *
 * ### Namespaces
 * **Example:** Create a Namespace
 * ```typescript
 * const ns = yield* Kubernetes.Manifest("AppsNamespace", {
 *   cluster,
 *   manifest: {
 *     apiVersion: "v1",
 *     kind: "Namespace",
 *     metadata: { name: "apps" },
 *   },
 * });
 * ```
 *
 * ### Any Cluster
 * **Example:** Apply onto a kubeconfig context
 * ```typescript
 * const local = Kubernetes.KubeConfig({ context: "kind-dev" });
 *
 * const config = yield* Kubernetes.Manifest("AppConfig", {
 *   cluster: local,
 *   manifest: {
 *     apiVersion: "v1",
 *     kind: "ConfigMap",
 *     metadata: { name: "app-config", namespace: "default" },
 *     data: { LOG_LEVEL: "info" },
 *   },
 * });
 * ```
 *
 * @resource
 * @product Manifest
 */
export const Manifest = Resource<Manifest>("Kubernetes.Manifest", {
  aliases: ["AWS.EKS.Manifest"],
});

const toObjectDefinition = (
  manifest: KubernetesManifest,
): Effect.Effect<KubernetesObjectDefinition, Error> => {
  const name = manifest.metadata?.name;
  if (!name) {
    return Effect.fail(
      new ManifestInvalidProps({
        message: `Kubernetes.Manifest requires manifest.metadata.name (got ${manifest.apiVersion}/${manifest.kind})`,
      }),
    );
  }
  return Effect.succeed(manifest as KubernetesObjectDefinition);
};

export const ManifestProvider = () =>
  Provider.effect(
    Manifest,
    Effect.gen(function* () {
      return {
        stables: ["connection", "apiVersion", "kind", "name", "namespace"],
        // In-cluster objects have no cloud-side enumeration that attributes
        // them to alchemy; refresh happens per-instance through `read`.
        list: () => Effect.succeed([] as Manifest["Attributes"][]),
        diff: Effect.fn(function* ({ olds = {} as ManifestProps, news }) {
          if (!isResolved(news)) return;
          const oldManifest = olds.manifest as KubernetesManifest | undefined;
          const newManifest = news.manifest as KubernetesManifest;
          const oldCluster = connectionIdentity(tryConnectionOf(olds.cluster));
          const newCluster = connectionIdentity(tryConnectionOf(news.cluster));
          // Object identity (cluster, group/version/kind, name, namespace) is
          // immutable — changing any of it is a replacement.
          if (
            oldManifest &&
            ((oldCluster !== undefined && newCluster !== undefined && oldCluster !== newCluster) ||
              oldManifest.apiVersion !== newManifest.apiVersion ||
              oldManifest.kind !== newManifest.kind ||
              oldManifest.metadata?.name !== newManifest.metadata?.name ||
              oldManifest.metadata?.namespace !== newManifest.metadata?.namespace)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output, olds }) {
          if (!output) return undefined;
          const connection = connectionOfOutput(output);
          if (!connection) return undefined;
          // ClusterNotFound fails the drift row. undefined means this object is gone.
          const transport = yield* connectCluster(connection);
          const observed = yield* readObject({
            transport,
            object: output.ref,
          }).pipe(Effect.catchTag("KubernetesNotFound", () => Effect.undefined));
          if (!observed) return undefined;
          const uid = (observed as { metadata?: { uid?: string } }).metadata?.uid;
          const attrs = { ...output, uid };
          const manifest = olds?.manifest;
          // A stored mask is the apply-time selection. Older rows have the
          // manifest and no mask; they use that same selection, not the
          // previous whole-object hash.
          const desired =
            output.driftMask === undefined && manifest !== undefined
              ? yield* toObjectDefinition(manifest)
              : undefined;
          const mask = output.driftMask ?? (desired === undefined ? undefined : driftMask(desired));
          if (mask === undefined) return attrs;
          const liveHash = yield* hashDriftSelection(mask, observed);
          const baseline =
            output.driftMask !== undefined && output.baselineHash !== undefined
              ? output.baselineHash
              : desired === undefined
                ? undefined
                : yield* hashDriftSelection(mask, desired);
          if (baseline !== undefined && liveHash !== baseline) {
            return { ...attrs, observedHash: liveHash };
          }
          return attrs;
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const connection = toConnection(news.cluster);
          const transport = yield* connectCluster(connection);
          const object = yield* toObjectDefinition(news.manifest);
          const ref: KubernetesObjectRef = {
            apiVersion: object.apiVersion,
            kind: object.kind,
            name: object.metadata.name,
            namespace: object.metadata.namespace,
          };

          // Server-side apply is a true upsert: create-if-missing and
          // converge-if-present in one call, `force: true` so alchemy owns
          // the fields it manages regardless of prior managers.
          const applied = yield* applyObject({ transport, object });
          const witnessed = isPlainObject(applied) ? applied : undefined;
          const baselineHash = yield* hashDriftSelection(object, witnessed ?? object);

          yield* session.note(
            `Applied ${ref.apiVersion}/${ref.kind} ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}`,
          );

          const uid = (applied as { metadata?: { uid?: string } })?.metadata?.uid ?? output?.uid;

          return {
            connection,
            apiVersion: ref.apiVersion,
            kind: ref.kind,
            name: ref.name,
            namespace: ref.namespace,
            ref,
            uid,
            baselineHash,
            driftMask: driftMask(object, witnessed),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const connection = connectionOfOutput(output);
          if (!connection) return;
          const transport = yield* ifClusterExists(connectCluster(connection));
          if (!transport) return;
          // 404 (including a removed CRD's discovery 404) is already success.
          // 403/5xx must surface: the object is still there.
          yield* deleteObject({ transport, object: output.ref });
        }),
      };
    }),
  );

import * as Effect from "effect/Effect";
import type { Cluster } from "../AWS/EKS/Cluster.ts";
import {
  kubernetesBindingSid,
  kubernetesObjectKey,
  toKubernetesObjectRef,
  type KubernetesObjectDefinition,
  type KubernetesObjectMetadata,
} from "./types.ts";

export interface ObjectProps {
  /**
   * Target EKS cluster that will own this Kubernetes object.
   */
  cluster: Cluster;
  /**
   * Kubernetes API version.
   */
  apiVersion: string;
  /**
   * Kubernetes kind.
   */
  kind: string;
  /**
   * Object metadata. `name` defaults to the logical id.
   */
  metadata?: Omit<KubernetesObjectMetadata, "name"> & {
    name?: string;
  };
  /**
   * Extra top-level fields merged into the final Kubernetes object.
   */
  body?: Record<string, unknown>;
}

export interface ObjectRef {
  cluster: Cluster;
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | undefined;
  key: string;
  object: KubernetesObjectDefinition;
}

/**
 * Binds a Kubernetes object definition onto an `AWS.EKS.Cluster`.
 *
 * This is the low-level escape hatch for TypeScript-defined Kubernetes objects.
 *
 * @example Bind a raw Kubernetes object
 * ```typescript
 * const object = yield* Object("demo", {
 *   cluster,
 *   apiVersion: "v1",
 *   kind: "ConfigMap",
 *   metadata: {
 *     namespace: "default",
 *   },
 *   body: {
 *     data: {
 *       EXAMPLE: "true",
 *     },
 *   },
 * });
 * ```
 */
const KubernetesObject = Effect.fn(function* (id: string, props: ObjectProps) {
  const object = {
    apiVersion: props.apiVersion,
    kind: props.kind,
    metadata: {
      name: props.metadata?.name ?? id,
      namespace: props.metadata?.namespace,
      labels: props.metadata?.labels,
      annotations: props.metadata?.annotations,
    },
    ...props.body,
  } satisfies KubernetesObjectDefinition;

  yield* props.cluster.bind(kubernetesBindingSid(object), {
    type: "kubernetes-object",
    object,
  });

  const ref = toKubernetesObjectRef(object);

  return {
    cluster: props.cluster,
    apiVersion: ref.apiVersion,
    kind: ref.kind,
    name: ref.name,
    namespace: ref.namespace,
    key: kubernetesObjectKey(ref),
    object,
  } satisfies ObjectRef;
});

export { KubernetesObject as Object };

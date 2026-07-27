/**
 * Internal helpers for binding Kubernetes objects onto an `AWS.EKS.Cluster`
 * through its `KubernetesObjectBinding` contract. The cluster's reconciler
 * server-side-applies every bound object after the control plane is ACTIVE.
 * Not exported from the EKS index — the public path for raw manifests is
 * `AWS.EKS.Manifest`.
 */
import * as Effect from "effect/Effect";
import type { Cluster } from "../Cluster.ts";
import {
  kubernetesObjectKey,
  toKubernetesObjectRef,
  type KubernetesObjectDefinition,
  type KubernetesObjectMetadata,
} from "./objects.ts";

export interface ClusterObjectProps {
  /** Target EKS cluster that will own this Kubernetes object. */
  cluster: Cluster;
  /** Kubernetes API version. */
  apiVersion: string;
  /** Kubernetes kind. */
  kind: string;
  /** Object metadata. `name` defaults to the logical id. */
  metadata?: Omit<KubernetesObjectMetadata, "name"> & {
    name?: string;
  };
  /** Extra top-level fields merged into the final Kubernetes object. */
  body?: Record<string, unknown>;
}

export interface ClusterObjectRef {
  cluster: Cluster;
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | undefined;
  key: string;
  object: KubernetesObjectDefinition;
}

export const kubernetesBindingSid = (object: KubernetesObjectDefinition) =>
  `Kubernetes.Object(${kubernetesObjectKey(toKubernetesObjectRef(object))})`;

export const ClusterObject = Effect.fn(function* (
  id: string,
  props: ClusterObjectProps,
) {
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
  } satisfies ClusterObjectRef;
});

export const namespaceNameOf = (
  namespace: string | { name: string } | ClusterObjectRef,
): string => (typeof namespace === "string" ? namespace : namespace.name);

export const clusterServiceAccount = (
  id: string,
  props: {
    cluster: Cluster;
    namespace: string | { name: string } | ClusterObjectRef;
    name?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  },
) =>
  ClusterObject(id, {
    cluster: props.cluster,
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: props.name,
      namespace: namespaceNameOf(props.namespace),
      labels: props.labels,
      annotations: props.annotations,
    },
  });

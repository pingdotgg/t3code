import type { Cluster } from "../AWS/EKS/Cluster.ts";
import type * as Effect from "effect/Effect";
import { Object, type ObjectRef } from "./Object.ts";

export interface NamespaceProps {
  /**
   * Target EKS cluster.
   */
  cluster: Cluster;
  /**
   * Optional explicit namespace name. Defaults to the logical id.
   */
  name?: string;
  /**
   * Namespace labels.
   */
  labels?: Record<string, string>;
  /**
   * Namespace annotations.
   */
  annotations?: Record<string, string>;
}

export interface Namespace extends ObjectRef {
  kind: "Namespace";
  namespace: undefined;
}

/**
 * A Kubernetes namespace bound to an EKS cluster.
 *
 * @example Create a namespace
 * ```typescript
 * const ns = yield* Namespace("demo", {
 *   cluster,
 * });
 * ```
 */
export const Namespace = (id: string, props: NamespaceProps) =>
  Object(id, {
    cluster: props.cluster,
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: props.name,
      labels: props.labels,
      annotations: props.annotations,
    },
  }) as Effect.Effect<Namespace>;

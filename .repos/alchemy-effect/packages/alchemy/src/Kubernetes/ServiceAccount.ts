import type { Cluster } from "../AWS/EKS/Cluster.ts";
import { metadataWithNamespace } from "./common.ts";
import { Object, type ObjectRef } from "./Object.ts";

export interface ServiceAccountProps {
  /**
   * Target EKS cluster.
   */
  cluster: Cluster;
  /**
   * Namespace name or namespace helper result.
   */
  namespace: string | { name: string } | ObjectRef;
  /**
   * Optional explicit service account name. Defaults to the logical id.
   */
  name?: string;
  /**
   * Service account labels.
   */
  labels?: Record<string, string>;
  /**
   * Service account annotations.
   */
  annotations?: Record<string, string>;
}

/**
 * A Kubernetes service account bound to an EKS cluster.
 *
 * @example Create a service account
 * ```typescript
 * const sa = yield* ServiceAccount("api", {
 *   cluster,
 *   namespace: "default",
 * });
 * ```
 */
export const ServiceAccount = (id: string, props: ServiceAccountProps) =>
  Object(id, {
    cluster: props.cluster,
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: metadataWithNamespace(props.namespace, {
      name: props.name,
      labels: props.labels,
      annotations: props.annotations,
    }),
  });

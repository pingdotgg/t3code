import type { Cluster } from "../AWS/EKS/Cluster.ts";
import { metadataWithNamespace } from "./common.ts";
import { Object, type ObjectRef } from "./Object.ts";

export interface ConfigMapProps {
  /**
   * Target EKS cluster.
   */
  cluster: Cluster;
  /**
   * Namespace name or namespace helper result.
   */
  namespace: string | { name: string } | ObjectRef;
  /**
   * Optional explicit config map name. Defaults to the logical id.
   */
  name?: string;
  /**
   * Config map string data.
   */
  data?: Record<string, string>;
  /**
   * Config map labels.
   */
  labels?: Record<string, string>;
  /**
   * Config map annotations.
   */
  annotations?: Record<string, string>;
}

/**
 * A Kubernetes config map bound to an EKS cluster.
 *
 * @example Create a config map
 * ```typescript
 * const config = yield* ConfigMap("app-config", {
 *   cluster,
 *   namespace: "default",
 *   data: {
 *     LOG_LEVEL: "debug",
 *   },
 * });
 * ```
 */
export const ConfigMap = (id: string, props: ConfigMapProps) =>
  Object(id, {
    cluster: props.cluster,
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: metadataWithNamespace(props.namespace, {
      name: props.name,
      labels: props.labels,
      annotations: props.annotations,
    }),
    body: {
      data: props.data,
    },
  });

import type { Cluster } from "../AWS/EKS/Cluster.ts";
import { metadataWithNamespace } from "./common.ts";
import { Object, type ObjectRef } from "./Object.ts";

export interface ServicePort {
  port: number;
  targetPort?: number;
  protocol?: "TCP" | "UDP";
  name?: string;
}

export interface ServiceProps {
  /**
   * Target EKS cluster.
   */
  cluster: Cluster;
  /**
   * Namespace name or namespace helper result.
   */
  namespace: string | { name: string } | ObjectRef;
  /**
   * Optional explicit service name. Defaults to the logical id.
   */
  name?: string;
  /**
   * Service type.
   * @default "ClusterIP"
   */
  type?: "ClusterIP" | "NodePort" | "LoadBalancer";
  /**
   * Selector labels for backing pods.
   */
  selector: Record<string, string>;
  /**
   * Service ports.
   */
  ports: ServicePort[];
  /**
   * Service labels.
   */
  labels?: Record<string, string>;
  /**
   * Service annotations.
   */
  annotations?: Record<string, string>;
}

/**
 * A Kubernetes service bound to an EKS cluster.
 *
 * @example Expose a deployment on a ClusterIP service
 * ```typescript
 * const service = yield* Service("api", {
 *   cluster,
 *   namespace: "default",
 *   selector: { "app.kubernetes.io/name": "api" },
 *   ports: [{ port: 80, targetPort: 8080 }],
 * });
 * ```
 */
export const Service = (id: string, props: ServiceProps) =>
  Object(id, {
    cluster: props.cluster,
    apiVersion: "v1",
    kind: "Service",
    metadata: metadataWithNamespace(props.namespace, {
      name: props.name,
      labels: props.labels,
      annotations: props.annotations,
    }),
    body: {
      spec: {
        type: props.type ?? "ClusterIP",
        selector: props.selector,
        ports: props.ports,
      },
    },
  });

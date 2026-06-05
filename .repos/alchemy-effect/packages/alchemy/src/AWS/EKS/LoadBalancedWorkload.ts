import {
  Workload,
  type WorkloadProps,
  type WorkloadServiceProps,
} from "./Workload.ts";

export type LoadBalancerScheme = "internet-facing" | "internal";

export interface LoadBalancedWorkloadProps extends Omit<
  WorkloadProps,
  "service"
> {
  /**
   * Service ports exposed by the load balancer.
   */
  ports: WorkloadServiceProps["ports"];
  /**
   * Optional explicit service name. Defaults to the workload name.
   */
  serviceName?: string;
  /**
   * Whether the Service should be internet-facing or internal.
   * @default "internet-facing"
   */
  scheme?: LoadBalancerScheme;
  /**
   * Additional annotations to apply to the Service.
   */
  serviceAnnotations?: Record<string, string>;
  /**
   * Labels to apply to the Service.
   */
  serviceLabels?: Record<string, string>;
}

/**
 * Creates a workload exposed through a Kubernetes `LoadBalancer` service.
 *
 * This helper is the ergonomic path for the common "run a deployment and make
 * it reachable through the EKS-managed load balancer integration" flow.
 *
 * @example Internet-facing workload
 * ```typescript
 * const app = yield* LoadBalancedWorkload("api", {
 *   cluster: cluster.cluster,
 *   namespace: "default",
 *   containers: [
 *     {
 *       name: "api",
 *       image: "nginx:latest",
 *       ports: [{ containerPort: 8080 }],
 *     },
 *   ],
 *   ports: [{ port: 80, targetPort: 8080 }],
 * });
 * ```
 */
export const LoadBalancedWorkload = (
  id: string,
  props: LoadBalancedWorkloadProps,
) =>
  Workload(id, {
    ...props,
    service: {
      name: props.serviceName,
      type: "LoadBalancer",
      ports: props.ports,
      labels: props.serviceLabels,
      annotations: {
        "service.beta.kubernetes.io/aws-load-balancer-scheme":
          props.scheme ?? "internet-facing",
        ...props.serviceAnnotations,
      },
    },
    ...props.serviceAnnotations,
  });

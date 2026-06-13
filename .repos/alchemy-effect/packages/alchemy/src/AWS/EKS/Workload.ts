import * as Effect from "effect/Effect";
import * as Namespace from "../../Namespace.ts";
import * as Kubernetes from "../../Kubernetes/index.ts";
import type { Cluster } from "./Cluster.ts";

export interface WorkloadServiceProps {
  /**
   * Optional explicit service name. Defaults to the workload name.
   */
  name?: string;
  /**
   * Service type.
   * @default "ClusterIP"
   */
  type?: "ClusterIP" | "NodePort" | "LoadBalancer";
  /**
   * Service ports.
   */
  ports: Kubernetes.ServicePort[];
  /**
   * Service labels.
   */
  labels?: Record<string, string>;
  /**
   * Service annotations.
   */
  annotations?: Record<string, string>;
}

export interface WorkloadProps {
  /**
   * Target EKS cluster.
   */
  cluster: Cluster;
  /**
   * Namespace name or namespace helper result.
   */
  namespace: string | { name: string } | Kubernetes.ObjectRef;
  /**
   * Optional explicit workload name. Defaults to the logical id.
   */
  name?: string;
  /**
   * Deployment labels.
   */
  labels?: Record<string, string>;
  /**
   * Pod labels. Defaults to `labels`.
   */
  podLabels?: Record<string, string>;
  /**
   * Replica count.
   * @default 1
   */
  replicas?: number;
  /**
   * Service account name for the pod template.
   */
  serviceAccountName?: string | { name: string } | Kubernetes.ObjectRef;
  /**
   * Container specs for the pod template.
   */
  containers: Kubernetes.ContainerSpec[];
  /**
   * Optional service to create for the workload.
   */
  service?: WorkloadServiceProps;
}

export interface WorkloadResources {
  deployment: Kubernetes.ObjectRef;
  service: Kubernetes.ObjectRef | undefined;
  name: string;
  labels: Record<string, string>;
  podLabels: Record<string, string>;
}

/**
 * Creates a Kubernetes deployment with an optional service on an EKS cluster.
 *
 * `Workload` is the higher-level helper for the common "run pods and maybe
 * expose them on a Service" pattern without dropping down to each individual
 * Kubernetes primitive.
 *
 * @example Deployment with a ClusterIP service
 * ```typescript
 * const app = yield* Workload("api", {
 *   cluster: cluster.cluster,
 *   namespace: "default",
 *   containers: [
 *     {
 *       name: "api",
 *       image: "nginx:latest",
 *       ports: [{ containerPort: 8080 }],
 *     },
 *   ],
 *   service: {
 *     ports: [{ port: 80, targetPort: 8080 }],
 *   },
 * });
 * ```
 */
export const Workload = (id: string, props: WorkloadProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const name = props.name ?? id;
      const labels = props.labels ?? {
        "app.kubernetes.io/name": name,
      };
      const podLabels = props.podLabels ?? labels;

      const deployment = yield* Kubernetes.Deployment("Deployment", {
        cluster: props.cluster,
        namespace: props.namespace,
        name,
        labels,
        podLabels,
        replicas: props.replicas,
        serviceAccountName: props.serviceAccountName,
        containers: props.containers,
      });

      const service = props.service
        ? yield* Kubernetes.Service("Service", {
            cluster: props.cluster,
            namespace: props.namespace,
            name: props.service.name ?? name,
            type: props.service.type,
            selector: podLabels,
            ports: props.service.ports,
            labels: props.service.labels ?? labels,
            annotations: props.service.annotations,
          })
        : undefined;

      return {
        deployment,
        service,
        name,
        labels,
        podLabels,
      } satisfies WorkloadResources;
    }),
  );

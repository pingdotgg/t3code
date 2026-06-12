import type { Cluster } from "../AWS/EKS/Cluster.ts";
import { metadataWithNamespace, objectNameOf } from "./common.ts";
import { Object, type ObjectRef } from "./Object.ts";

export interface ContainerPort {
  containerPort: number;
  name?: string;
}

export interface ContainerEnvVar {
  name: string;
  value: string;
}

export interface ContainerResourceList {
  cpu?: string;
  memory?: string;
}

export interface ContainerResources {
  requests?: ContainerResourceList;
  limits?: ContainerResourceList;
}

export interface ContainerSpec {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: ContainerEnvVar[];
  ports?: ContainerPort[];
  resources?: ContainerResources;
}

export interface DeploymentProps {
  /**
   * Target EKS cluster.
   */
  cluster: Cluster;
  /**
   * Namespace name or namespace helper result.
   */
  namespace: string | { name: string } | ObjectRef;
  /**
   * Optional explicit deployment name. Defaults to the logical id.
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
  serviceAccountName?: string | { name: string } | ObjectRef;
  /**
   * Container specs for the pod template.
   */
  containers: ContainerSpec[];
}

/**
 * A Kubernetes deployment bound to an EKS cluster.
 *
 * @example Deploy a simple workload
 * ```typescript
 * const app = yield* Deployment("api", {
 *   cluster,
 *   namespace: "default",
 *   containers: [
 *     {
 *       name: "api",
 *       image: "nginx:latest",
 *     },
 *   ],
 * });
 * ```
 */
export const Deployment = (id: string, props: DeploymentProps) => {
  const name = props.name ?? id;
  const labels = props.labels ?? {
    "app.kubernetes.io/name": name,
  };
  const podLabels = props.podLabels ?? labels;

  return Object(id, {
    cluster: props.cluster,
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: metadataWithNamespace(props.namespace, {
      name,
      labels,
    }),
    body: {
      spec: {
        replicas: props.replicas ?? 1,
        selector: {
          matchLabels: podLabels,
        },
        template: {
          metadata: {
            labels: podLabels,
          },
          spec: {
            serviceAccountName: props.serviceAccountName
              ? objectNameOf(props.serviceAccountName)
              : undefined,
            containers: props.containers,
          },
        },
      },
    },
  });
};

import type { Cluster } from "../AWS/EKS/Cluster.ts";
import { metadataWithNamespace, objectNameOf } from "./common.ts";
import { Object, type ObjectRef } from "./Object.ts";
import type { ContainerSpec } from "./Deployment.ts";

export interface JobProps {
  /**
   * Target EKS cluster.
   */
  cluster: Cluster;
  /**
   * Namespace name or namespace helper result.
   */
  namespace: string | { name: string } | ObjectRef;
  /**
   * Optional explicit job name. Defaults to the logical id.
   */
  name?: string;
  /**
   * Job labels.
   */
  labels?: Record<string, string>;
  /**
   * Restart policy.
   * @default "Never"
   */
  restartPolicy?: "Never" | "OnFailure";
  /**
   * Service account name for the pod template.
   */
  serviceAccountName?: string | { name: string } | ObjectRef;
  /**
   * Pod containers.
   */
  containers: ContainerSpec[];
}

/**
 * A Kubernetes job bound to an EKS cluster.
 *
 * @example Run a one-shot job
 * ```typescript
 * const job = yield* Job("seed", {
 *   cluster,
 *   namespace: "default",
 *   containers: [
 *     {
 *       name: "seed",
 *       image: "busybox:latest",
 *       command: ["/bin/sh", "-lc"],
 *       args: ["echo hello"],
 *     },
 *   ],
 * });
 * ```
 */
export const Job = (id: string, props: JobProps) =>
  Object(id, {
    cluster: props.cluster,
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: metadataWithNamespace(props.namespace, {
      name: props.name,
      labels: props.labels,
    }),
    body: {
      spec: {
        template: {
          metadata: {
            labels: props.labels,
          },
          spec: {
            restartPolicy: props.restartPolicy ?? "Never",
            serviceAccountName: props.serviceAccountName
              ? objectNameOf(props.serviceAccountName)
              : undefined,
            containers: props.containers,
          },
        },
      },
    },
  });

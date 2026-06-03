import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import * as Kubernetes from "../../Kubernetes/index.ts";
import * as Namespace from "../../Namespace.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import type { RoleArn, Role as RoleResource } from "../IAM/Role.ts";
import type { Cluster } from "./Cluster.ts";
import type { PodIdentityAssociation as PodIdentityAssociationResource } from "./PodIdentityAssociation.ts";
import { PodIdentityServiceAccount } from "./PodIdentityServiceAccount.ts";
import { Workload, type WorkloadServiceProps } from "./Workload.ts";

export interface PodIdentityWorkloadProps {
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
   * Optional explicit service account name. Defaults to the workload name.
   */
  serviceAccountName?: string;
  /**
   * Existing IAM role ARN to use for pod identity.
   */
  roleArn?: string;
  /**
   * Optional role name when Alchemy creates the IAM role.
   */
  roleName?: string;
  /**
   * Managed policy ARNs to attach when creating the IAM role.
   */
  managedPolicyArns?: string[];
  /**
   * Inline policies to attach when creating the IAM role.
   */
  inlinePolicies?: Record<string, PolicyDocument>;
  /**
   * Optional role description when Alchemy creates the IAM role.
   */
  description?: string;
  /**
   * Disable session tags for the pod identity association.
   */
  disableSessionTags?: boolean;
  /**
   * Optional target role ARN for chained role assumption.
   */
  targetRoleArn?: string;
  /**
   * Optional inline session policy JSON.
   */
  policy?: string;
  /**
   * Deployment labels.
   */
  labels?: Record<string, string>;
  /**
   * Pod labels. Defaults to `labels`.
   */
  podLabels?: Record<string, string>;
  /**
   * Labels applied to the Kubernetes service account.
   */
  serviceAccountLabels?: Record<string, string>;
  /**
   * Annotations applied to the Kubernetes service account.
   */
  serviceAccountAnnotations?: Record<string, string>;
  /**
   * Replica count.
   * @default 1
   */
  replicas?: number;
  /**
   * Container specs for the pod template.
   */
  containers: Kubernetes.ContainerSpec[];
  /**
   * Optional service to create for the workload.
   */
  service?: WorkloadServiceProps;
  /**
   * Tags applied to AWS resources.
   */
  tags?: Record<string, string>;
}

export interface PodIdentityWorkloadResources {
  deployment: Kubernetes.ObjectRef;
  service: Kubernetes.ObjectRef | undefined;
  serviceAccount: Kubernetes.ObjectRef;
  podIdentityAssociation: PodIdentityAssociationResource;
  role: RoleResource | undefined;
  roleArn: Input<string> | RoleArn;
  name: string;
  labels: Record<string, string>;
  podLabels: Record<string, string>;
}

/**
 * Creates a pod-identity-enabled workload on an EKS cluster.
 *
 * This helper combines `PodIdentityServiceAccount` with `Workload` so callers
 * can declare a service-account-backed deployment without manually wiring the
 * IAM role, EKS pod identity association, Kubernetes service account, and
 * deployment together.
 *
 * @example Pod identity workload with generated role
 * ```typescript
 * const app = yield* PodIdentityWorkload("api", {
 *   cluster: cluster.cluster,
 *   namespace: "default",
 *   managedPolicyArns: ["arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"],
 *   containers: [
 *     {
 *       name: "api",
 *       image: "nginx:latest",
 *     },
 *   ],
 * });
 * ```
 */
export const PodIdentityWorkload = (
  id: string,
  props: PodIdentityWorkloadProps,
) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const name = props.name ?? id;
      const serviceAccountName = props.serviceAccountName ?? name;

      const identity = yield* PodIdentityServiceAccount("Identity", {
        cluster: props.cluster,
        namespace: props.namespace,
        serviceAccountName,
        roleArn: props.roleArn,
        roleName: props.roleName,
        managedPolicyArns: props.managedPolicyArns,
        inlinePolicies: props.inlinePolicies,
        description: props.description,
        disableSessionTags: props.disableSessionTags,
        targetRoleArn: props.targetRoleArn,
        policy: props.policy,
        labels: props.serviceAccountLabels,
        annotations: props.serviceAccountAnnotations,
        tags: props.tags,
      });

      const workload = yield* Workload("Workload", {
        cluster: props.cluster,
        namespace: props.namespace,
        name,
        labels: props.labels,
        podLabels: props.podLabels,
        replicas: props.replicas,
        serviceAccountName: identity.serviceAccount,
        containers: props.containers,
        service: props.service,
      });

      return {
        deployment: workload.deployment,
        service: workload.service,
        serviceAccount: identity.serviceAccount,
        podIdentityAssociation: identity.podIdentityAssociation,
        role: identity.role,
        roleArn: identity.roleArn,
        name: workload.name,
        labels: workload.labels,
        podLabels: workload.podLabels,
      } satisfies PodIdentityWorkloadResources;
    }),
  );

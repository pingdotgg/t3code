import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import * as Kubernetes from "../../Kubernetes/index.ts";
import * as Namespace from "../../Namespace.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import { Role, type RoleArn, type Role as RoleResource } from "../IAM/Role.ts";
import type { Cluster } from "./Cluster.ts";
import {
  PodIdentityAssociation,
  type PodIdentityAssociation as PodIdentityAssociationResource,
} from "./PodIdentityAssociation.ts";

export interface PodIdentityServiceAccountProps {
  /**
   * Target EKS cluster.
   */
  cluster: Cluster;
  /**
   * Namespace name or namespace helper result.
   */
  namespace: string | { name: string } | Kubernetes.ObjectRef;
  /**
   * Optional explicit service account name. Defaults to the logical id.
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
   * Labels applied to the Kubernetes service account.
   */
  labels?: Record<string, string>;
  /**
   * Annotations applied to the Kubernetes service account.
   */
  annotations?: Record<string, string>;
  /**
   * Tags applied to AWS resources.
   */
  tags?: Record<string, string>;
}

export interface PodIdentityServiceAccountResources {
  serviceAccount: Kubernetes.ObjectRef;
  podIdentityAssociation: PodIdentityAssociationResource;
  role: RoleResource | undefined;
  roleArn: Input<string> | RoleArn;
}

/**
 * Creates a Kubernetes service account and binds it to EKS Pod Identity.
 *
 * @example Service account with generated IAM role
 * ```typescript
 * const identity = yield* PodIdentityServiceAccount("ApiIdentity", {
 *   cluster: cluster.cluster,
 *   namespace: "default",
 *   managedPolicyArns: ["arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"],
 * });
 * ```
 */
export const PodIdentityServiceAccount = (
  id: string,
  props: PodIdentityServiceAccountProps,
) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const serviceAccountName = props.serviceAccountName ?? id;

      const role = props.roleArn
        ? undefined
        : yield* Role("Role", {
            roleName: props.roleName,
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: {
                    Service: "pods.eks.amazonaws.com",
                  },
                  Action: ["sts:AssumeRole", "sts:TagSession"],
                },
              ],
            },
            description:
              props.description ??
              `Pod identity role for service account ${serviceAccountName}.`,
            managedPolicyArns: props.managedPolicyArns,
            inlinePolicies: props.inlinePolicies,
            tags: props.tags,
          });

      const serviceAccount = yield* Kubernetes.ServiceAccount(
        "ServiceAccount",
        {
          cluster: props.cluster,
          namespace: props.namespace,
          name: serviceAccountName,
          labels: props.labels,
          annotations: props.annotations,
        },
      );

      const podIdentityAssociation = yield* PodIdentityAssociation(
        "PodIdentityAssociation",
        {
          clusterName: props.cluster.clusterName,
          namespace: Kubernetes.namespaceNameOf(props.namespace),
          serviceAccount: serviceAccount.name,
          roleArn: props.roleArn ?? role!.roleArn,
          disableSessionTags: props.disableSessionTags,
          targetRoleArn: props.targetRoleArn,
          policy: props.policy,
          tags: props.tags,
        },
      );

      return {
        serviceAccount,
        podIdentityAssociation,
        role,
        roleArn: props.roleArn ?? role!.roleArn,
      } satisfies PodIdentityServiceAccountResources;
    }),
  );

import type * as eks from "@distilled.cloud/aws/eks";
import * as Effect from "effect/Effect";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import type { NetworkResources } from "../EC2/Network.ts";
import type { Role as RoleResource } from "../IAM/Role.ts";
import { Role } from "../IAM/Role.ts";
import type { Cluster as ClusterResource } from "./Cluster.ts";
import { Cluster } from "./Cluster.ts";

const clusterManagedPolicyArns = [
  "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
  "arn:aws:iam::aws:policy/AmazonEKSComputePolicy",
  "arn:aws:iam::aws:policy/AmazonEKSBlockStoragePolicy",
  "arn:aws:iam::aws:policy/AmazonEKSLoadBalancingPolicy",
  "arn:aws:iam::aws:policy/AmazonEKSNetworkingPolicy",
];

const nodeManagedPolicyArns = [
  "arn:aws:iam::aws:policy/AmazonEKSWorkerNodeMinimalPolicy",
  "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly",
];

export interface AutoClusterProps {
  /**
   * Pre-built VPC layout from `AWS.EC2.Network`.
   */
  network?: NetworkResources;
  /**
   * Explicit subnet IDs to use instead of deriving them from `network`.
   */
  subnetIds?: string[];
  /**
   * Optional security groups to associate with the control plane ENIs.
   */
  securityGroupIds?: string[];
  /**
   * Whether the Kubernetes API server endpoint is public.
   * @default true
   */
  endpointPublicAccess?: boolean;
  /**
   * Whether the Kubernetes API server endpoint is private.
   * @default true
   */
  endpointPrivateAccess?: boolean;
  /**
   * Optional CIDR allowlist for public endpoint access.
   */
  publicAccessCidrs?: string[];
  /**
   * Cluster name. If omitted, a unique name is generated.
   */
  clusterName?: string;
  /**
   * Desired Kubernetes version.
   */
  version?: string;
  /**
   * Override the cluster role ARN. If omitted, `AutoCluster` creates one.
   */
  clusterRoleArn?: string;
  /**
   * Override the node role ARN. If omitted, `AutoCluster` creates one.
   */
  nodeRoleArn?: string;
  /**
   * Name to use when `AutoCluster` creates the cluster role.
   */
  clusterRoleName?: string;
  /**
   * Name to use when `AutoCluster` creates the node role.
   */
  nodeRoleName?: string;
  /**
   * Additional or replacement managed policies for the cluster role.
   */
  clusterRoleManagedPolicyArns?: string[];
  /**
   * Additional or replacement managed policies for the node role.
   */
  nodeRoleManagedPolicyArns?: string[];
  /**
   * Cluster access configuration.
   */
  accessConfig?: eks.CreateAccessConfigRequest;
  /**
   * Auto Mode compute configuration overrides.
   */
  computeConfig?: Omit<eks.ComputeConfigRequest, "nodeRoleArn">;
  /**
   * Auto Mode storage configuration overrides.
   */
  storageConfig?: eks.StorageConfigRequest;
  /**
   * Kubernetes network configuration overrides.
   */
  kubernetesNetworkConfig?: eks.KubernetesNetworkConfigRequest;
  /**
   * Control plane logging configuration.
   */
  logging?: eks.Logging;
  /**
   * Upgrade support policy for the cluster.
   */
  upgradePolicy?: eks.UpgradePolicyRequest;
  /**
   * Whether deletion protection is enabled.
   * @default false
   */
  deletionProtection?: boolean;
  /**
   * Tags applied to the cluster and any IAM roles created by this helper.
   */
  tags?: Record<string, string>;
}

export interface AutoClusterResources {
  cluster: ClusterResource;
  clusterRole: RoleResource | undefined;
  nodeRole: RoleResource | undefined;
  clusterRoleArn: Output.Output<string, never>;
  nodeRoleArn: Output.Output<string, never>;
  subnetIds: Array<string | NetworkResources["publicSubnetIds"][number]>;
  publicSubnetIds: NetworkResources["publicSubnetIds"];
  privateSubnetIds: NetworkResources["privateSubnetIds"];
}

export type AutoCluster = Effect.Success<ReturnType<typeof AutoCluster>>;

/**
 * Creates a working EKS Auto Mode cluster from an existing VPC network.
 *
 * `AutoCluster` is the higher-level entry point that composes `IAM.Role` and
 * the canonical `EKS.Cluster` resource so callers can stand up a usable EKS
 * Auto Mode cluster with just `EC2.Network` plus this helper.
 *
 * @section Creating Auto Mode Clusters
 * @example Auto Mode Cluster on Top of `EC2.Network`
 * ```typescript
 * const network = yield* AWS.EC2.Network("AppNetwork", {
 *   cidrBlock: "10.42.0.0/16",
 *   availabilityZones: 2,
 *   nat: "single",
 * });
 *
 * const cluster = yield* AWS.EKS.AutoCluster("AppCluster", {
 *   network,
 * });
 * ```
 */
export const AutoCluster = (id: string, props: AutoClusterProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const subnetIds = resolveSubnetIds(props);
      if (subnetIds.length < 2) {
        return yield* Effect.fail(
          new Error(
            "AWS.EKS.AutoCluster requires at least two subnet IDs, either explicitly or through EC2.Network",
          ),
        );
      }

      const tags = props.tags;

      const clusterRole = props.clusterRoleArn
        ? undefined
        : yield* Role("ClusterRole", {
            roleName: props.clusterRoleName,
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: {
                    Service: "eks.amazonaws.com",
                  },
                  Action: ["sts:AssumeRole", "sts:TagSession"],
                },
              ],
            },
            description: "Cluster role for EKS Auto Mode.",
            managedPolicyArns:
              props.clusterRoleManagedPolicyArns ?? clusterManagedPolicyArns,
            tags,
          });

      const nodeRole = props.nodeRoleArn
        ? undefined
        : yield* Role("NodeRole", {
            roleName: props.nodeRoleName,
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: {
                    Service: "ec2.amazonaws.com",
                  },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            description: "Node role for EKS Auto Mode managed instances.",
            managedPolicyArns:
              props.nodeRoleManagedPolicyArns ?? nodeManagedPolicyArns,
            tags,
          });

      const cluster = yield* Cluster("Cluster", {
        clusterName: props.clusterName,
        roleArn: props.clusterRoleArn ?? clusterRole!.roleArn,
        version: props.version,
        resourcesVpcConfig: {
          subnetIds,
          securityGroupIds: props.securityGroupIds,
          endpointPublicAccess: props.endpointPublicAccess ?? true,
          endpointPrivateAccess: props.endpointPrivateAccess ?? true,
          publicAccessCidrs: props.publicAccessCidrs,
        },
        accessConfig: {
          bootstrapClusterCreatorAdminPermissions: true,
          authenticationMode: "API",
          ...props.accessConfig,
        },
        computeConfig: {
          enabled: true,
          nodePools: ["system", "general-purpose"],
          ...props.computeConfig,
          nodeRoleArn: props.nodeRoleArn ?? nodeRole!.roleArn,
        },
        kubernetesNetworkConfig: {
          ...props.kubernetesNetworkConfig,
          elasticLoadBalancing: {
            enabled: true,
            ...props.kubernetesNetworkConfig?.elasticLoadBalancing,
          },
        },
        storageConfig: {
          blockStorage: {
            enabled: true,
            ...props.storageConfig?.blockStorage,
          },
        },
        logging: props.logging,
        upgradePolicy: props.upgradePolicy,
        deletionProtection: props.deletionProtection,
        tags,
      });

      return {
        cluster,
        clusterRole,
        nodeRole,
        clusterRoleArn: props.clusterRoleArn
          ? Output.literal(props.clusterRoleArn)
          : clusterRole!.roleArn,
        nodeRoleArn: props.nodeRoleArn
          ? Output.literal(props.nodeRoleArn)
          : nodeRole!.roleArn,
        subnetIds,
        publicSubnetIds: props.network?.publicSubnetIds ?? [],
        privateSubnetIds: props.network?.privateSubnetIds ?? [],
      } satisfies AutoClusterResources;
    }).pipe(Effect.orDie),
  );

const resolveSubnetIds = (props: AutoClusterProps) => {
  if (props.subnetIds && props.subnetIds.length > 0) {
    return props.subnetIds;
  }

  if (!props.network) {
    return [];
  }

  if (props.network.privateSubnetIds.length >= 2) {
    return props.network.privateSubnetIds;
  }

  return [
    ...new Set([
      ...props.network.privateSubnetIds,
      ...props.network.publicSubnetIds,
    ]),
  ];
};

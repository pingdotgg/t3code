import * as eks from "@distilled.cloud/aws/eks";
import * as iam from "@distilled.cloud/aws/iam";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import {
  deleteObjects,
  reconcileObjects,
  type KubernetesClusterConnection,
} from "./internal/client.ts";
import {
  type KubernetesObjectBinding,
  type KubernetesObjectDefinition,
  type KubernetesObjectRef,
} from "./internal/objects.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  hasTags,
} from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";

export type ClusterName = string;
export type ClusterArn =
  `arn:aws:eks:${RegionID}:${AccountID}:cluster/${ClusterName}`;

export interface ClusterProps {
  /**
   * Cluster name. If omitted, a unique name is generated.
   */
  clusterName?: string;
  /**
   * `"auto"` turns on EKS Auto Mode with sensible defaults: managed compute
   * (`system` + `general-purpose` node pools), block storage, elastic load
   * balancing, and `API` authentication with bootstrap admin permissions.
   * When `roleArn` (or `computeConfig.nodeRoleArn`) is omitted, the cluster
   * provisions and owns the required IAM roles with the standard Auto Mode
   * managed policies. Explicit `accessConfig` / `computeConfig` /
   * `storageConfig` / `kubernetesNetworkConfig` props override the defaults.
   */
  compute?: "auto";
  /**
   * IAM role ARN assumed by the EKS control plane. Required unless
   * `compute: "auto"`, in which case an Auto Mode cluster role is created
   * and managed automatically when omitted.
   */
  roleArn?: string;
  /**
   * VPC configuration for the cluster control plane.
   */
  resourcesVpcConfig: eks.VpcConfigRequest;
  /**
   * Desired Kubernetes version.
   */
  version?: string;
  /**
   * Cluster access configuration.
   */
  accessConfig?: eks.CreateAccessConfigRequest;
  /**
   * Auto Mode compute configuration.
   */
  computeConfig?: eks.ComputeConfigRequest;
  /**
   * Auto Mode storage configuration.
   */
  storageConfig?: eks.StorageConfigRequest;
  /**
   * Kubernetes network configuration.
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
   * User-defined tags to apply to the cluster.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.EKS.Cluster",
  ClusterProps,
  {
    /** The ARN of the cluster. */
    clusterArn: ClusterArn;
    /** The name of the cluster. */
    clusterName: ClusterName;
    /** The cluster status (e.g. `CREATING`, `ACTIVE`, `UPDATING`). */
    status: string;
    /** The Kubernetes API server endpoint URL. */
    endpoint: string | undefined;
    /** The base64-encoded certificate authority data for the cluster. */
    certificateAuthorityData: string | undefined;
    /** The Kubernetes version the cluster is running (e.g. `1.31`). */
    version: string | undefined;
    /** The EKS platform version of the cluster. */
    platformVersion: string | undefined;
    /** The ARN of the IAM role the EKS control plane assumes. */
    roleArn: string;
    /** The VPC configuration of the cluster (subnets, security groups, endpoint access). */
    resourcesVpcConfig: eks.VpcConfigResponse;
    /** The access configuration (authentication mode, bootstrap admin). */
    accessConfig: eks.AccessConfigResponse | undefined;
    /** The EKS Auto Mode compute configuration, if enabled. */
    computeConfig: eks.ComputeConfigResponse | undefined;
    /** The EKS Auto Mode block storage configuration, if enabled. */
    storageConfig: eks.StorageConfigResponse | undefined;
    /** The Kubernetes network configuration (service CIDR, IP family, elastic load balancing). */
    kubernetesNetworkConfig: eks.KubernetesNetworkConfigResponse | undefined;
    /** The control-plane log types shipped to CloudWatch. */
    logging: eks.Logging | undefined;
    /** The cluster's upgrade policy (support type). */
    upgradePolicy: eks.UpgradePolicyResponse | undefined;
    /** Whether deletion protection is enabled on the cluster. */
    deletionProtection: boolean;
    /** The OIDC identity provider issuer URL for the cluster. */
    oidcIssuer: string | undefined;
    /** The tags applied to the cluster. */
    tags: Record<string, string>;
    /** References to Kubernetes objects applied via `kubernetes` props. */
    kubernetesObjects: KubernetesObjectRef[];
    /** The name of the cluster IAM role created for `compute: "auto"`, if managed by alchemy. */
    managedClusterRoleName: string | undefined;
    /** The name of the node IAM role created for `compute: "auto"`, if managed by alchemy. */
    managedNodeRoleName: string | undefined;
  },
  KubernetesObjectBinding,
  Providers
> {}

/**
 * An Amazon EKS cluster with support for EKS Auto Mode settings.
 * @resource
 * @section Creating Clusters
 * @example Auto Mode Cluster (managed roles)
 * ```typescript
 * const cluster = yield* Cluster("AppCluster", {
 *   compute: "auto",
 *   resourcesVpcConfig: {
 *     subnetIds: network.privateSubnetIds,
 *   },
 * });
 * ```
 *
 * @example Auto Mode Cluster from Existing Roles and Subnets
 * ```typescript
 * const cluster = yield* Cluster("AppCluster", {
 *   roleArn: clusterRole.roleArn,
 *   resourcesVpcConfig: {
 *     subnetIds: network.privateSubnetIds,
 *     endpointPublicAccess: true,
 *     endpointPrivateAccess: true,
 *   },
 *   accessConfig: {
 *     authenticationMode: "API",
 *   },
 *   computeConfig: {
 *     enabled: true,
 *     nodeRoleArn: nodeRole.roleArn,
 *     nodePools: ["system", "general-purpose"],
 *   },
 *   kubernetesNetworkConfig: {
 *     elasticLoadBalancing: { enabled: true },
 *   },
 *   storageConfig: {
 *     blockStorage: { enabled: true },
 *   },
 * });
 * ```
 *
 * @section Running Workloads
 * @example Cluster with a Managed Node Group and an Add-on
 * ```typescript
 * const cluster = yield* AWS.EKS.Cluster("AppCluster", {
 *   roleArn: clusterRole.roleArn,
 *   resourcesVpcConfig: { subnetIds: network.privateSubnetIds },
 *   accessConfig: { authenticationMode: "API" },
 * });
 *
 * const nodes = yield* AWS.EKS.Nodegroup("AppNodes", {
 *   clusterName: cluster.clusterName,
 *   nodeRole: nodeRole.roleArn,
 *   subnets: network.privateSubnetIds,
 *   instanceTypes: ["t3.medium"],
 *   scalingConfig: { minSize: 1, maxSize: 2, desiredSize: 1 },
 * });
 *
 * const metricsServer = yield* AWS.EKS.Addon("MetricsServer", {
 *   clusterName: cluster.clusterName,
 *   addonName: "metrics-server",
 * });
 * ```
 */
export const Cluster = Resource<Cluster>("AWS.EKS.Cluster");

class ClusterNotReady extends Data.TaggedError("EKS.ClusterNotReady")<{
  status: string | undefined;
}> {}

class ClusterStillExists extends Data.TaggedError(
  "EKS.ClusterStillExists",
)<{}> {}

class ClusterUpdateNotComplete extends Data.TaggedError(
  "EKS.ClusterUpdateNotComplete",
)<{
  status: eks.UpdateStatus | undefined;
}> {}

const normalizeTags = (tags: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

// Wait budget: ~30 min at 10s spacing. Cluster create/delete takes ~10–15 min
// and async config/version updates ~5–15 min. The interval MUST be flat, not
// exponential: `Schedule.exponential` with no delay cap sleeps 8.5/17/34 min
// between late attempts — a silent multi-minute park that presents as a
// deadlocked (0% CPU, no output) deploy and blows any hook budget.
const updateRetrySchedule = Schedule.max([
  Schedule.spaced("10 seconds"),
  Schedule.recurs(180),
]);

const getKubernetesConnection = (
  state: Pick<
    Cluster["Attributes"],
    "clusterName" | "endpoint" | "certificateAuthorityData"
  >,
): KubernetesClusterConnection => {
  if (!state.endpoint || !state.certificateAuthorityData) {
    throw new Error(
      `EKS cluster '${state.clusterName}' is missing endpoint or certificate authority data`,
    );
  }

  return {
    clusterName: state.clusterName,
    endpoint: state.endpoint,
    certificateAuthorityData: state.certificateAuthorityData,
  };
};

const getDesiredKubernetesObjects = (
  bindings: ReadonlyArray<ResourceBinding<KubernetesObjectBinding>>,
): KubernetesObjectDefinition[] =>
  bindings
    .filter(
      (binding): binding is ResourceBinding<KubernetesObjectBinding> =>
        binding.data.type === "kubernetes-object",
    )
    .map((binding) => binding.data.object);

const autoClusterManagedPolicyArns = [
  "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
  "arn:aws:iam::aws:policy/AmazonEKSComputePolicy",
  "arn:aws:iam::aws:policy/AmazonEKSBlockStoragePolicy",
  "arn:aws:iam::aws:policy/AmazonEKSLoadBalancingPolicy",
  "arn:aws:iam::aws:policy/AmazonEKSNetworkingPolicy",
];

const autoNodeManagedPolicyArns = [
  "arn:aws:iam::aws:policy/AmazonEKSWorkerNodeMinimalPolicy",
  "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly",
];

/**
 * Expand `compute: "auto"` into the concrete EKS Auto Mode configuration
 * (explicit user props always win over the defaults).
 */
const applyAutoModeDefaults = (
  news: ClusterProps,
  roles: { roleArn: string; nodeRoleArn: string | undefined },
): ClusterProps & { roleArn: string } =>
  news.compute === "auto"
    ? {
        ...news,
        roleArn: roles.roleArn,
        accessConfig: {
          bootstrapClusterCreatorAdminPermissions: true,
          authenticationMode: "API",
          ...news.accessConfig,
        },
        computeConfig: {
          enabled: true,
          nodePools: ["system", "general-purpose"],
          ...news.computeConfig,
          nodeRoleArn: roles.nodeRoleArn,
        },
        kubernetesNetworkConfig: {
          ...news.kubernetesNetworkConfig,
          elasticLoadBalancing: {
            enabled: true,
            ...news.kubernetesNetworkConfig?.elasticLoadBalancing,
          },
        },
        storageConfig: {
          blockStorage: {
            enabled: true,
            ...news.storageConfig?.blockStorage,
          },
        },
      }
    : { ...news, roleArn: roles.roleArn };

const stringSetEqual = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
) =>
  JSON.stringify([...(a ?? [])].sort()) ===
  JSON.stringify([...(b ?? [])].sort());

/** Flatten an EKS `Logging` shape into a `logType -> enabled` map. */
const loggingByType = (logging: eks.Logging | undefined) => {
  const byType: Record<string, boolean> = {};
  for (const setup of logging?.clusterLogging ?? []) {
    for (const type of setup.types ?? []) {
      byType[type] = setup.enabled ?? false;
    }
  }
  return byType;
};

interface ClusterConfigUpdate {
  /** Stable category slug — also feeds the per-category idempotency token. */
  category: string;
  request: Omit<eks.UpdateClusterConfigRequest, "name" | "clientRequestToken">;
}

/**
 * Plan the `updateClusterConfig` calls needed to converge observed cloud
 * state to the desired props.
 *
 * EKS's UpdateClusterConfig API accepts exactly ONE update category per call
 * (`InvalidParameterException: Only one type of update can be allowed.`), so
 * drift is computed per category and each drifted category becomes its own
 * request — the caller issues them serially, waiting for each async update
 * to complete before the next.
 *
 * Comparison is desired-subset only: a field the user did not specify is
 * "don't care" and is never diffed against server-populated response fields
 * (vpcId, clusterSecurityGroupId, default upgradePolicy, ...). A freshly
 * created cluster therefore plans zero updates.
 */
const planClusterConfigUpdates = (
  observed: Cluster["Attributes"],
  desired: ClusterProps,
): ClusterConfigUpdate[] => {
  const updates: ClusterConfigUpdate[] = [];

  // Access config — authenticationMode is the only mutable field.
  const desiredAuthMode = desired.accessConfig?.authenticationMode;
  if (
    desiredAuthMode !== undefined &&
    desiredAuthMode !== observed.accessConfig?.authenticationMode
  ) {
    updates.push({
      category: "access",
      request: { accessConfig: { authenticationMode: desiredAuthMode } },
    });
  }

  // Auto Mode trio — computeConfig, storageConfig and kubernetesNetworkConfig
  // count as ONE update category and must ship together in a single call.
  const desiredCompute = desired.computeConfig;
  const observedCompute = observed.computeConfig;
  const computeDrift =
    desiredCompute !== undefined &&
    ((desiredCompute.enabled !== undefined &&
      desiredCompute.enabled !== (observedCompute?.enabled ?? false)) ||
      (desiredCompute.nodePools !== undefined &&
        !stringSetEqual(
          desiredCompute.nodePools,
          observedCompute?.nodePools,
        )) ||
      (desiredCompute.nodeRoleArn !== undefined &&
        desiredCompute.nodeRoleArn !== observedCompute?.nodeRoleArn));
  const desiredBlockStorage = desired.storageConfig?.blockStorage?.enabled;
  const storageDrift =
    desiredBlockStorage !== undefined &&
    desiredBlockStorage !==
      (observed.storageConfig?.blockStorage?.enabled ?? false);
  const desiredElb =
    desired.kubernetesNetworkConfig?.elasticLoadBalancing?.enabled;
  const elbDrift =
    desiredElb !== undefined &&
    desiredElb !==
      (observed.kubernetesNetworkConfig?.elasticLoadBalancing?.enabled ??
        false);
  if (computeDrift || storageDrift || elbDrift) {
    updates.push({
      category: "auto-mode",
      request: {
        computeConfig: desiredCompute ?? {
          enabled: observedCompute?.enabled ?? false,
          nodePools: observedCompute?.nodePools,
          nodeRoleArn: observedCompute?.nodeRoleArn,
        },
        storageConfig: {
          blockStorage: {
            enabled:
              desiredBlockStorage ??
              observed.storageConfig?.blockStorage?.enabled ??
              false,
          },
        },
        // serviceIpv4Cidr / ipFamily are create-only (diff replaces on
        // change) — never send them on update.
        kubernetesNetworkConfig: {
          elasticLoadBalancing: {
            enabled:
              desiredElb ??
              observed.kubernetesNetworkConfig?.elasticLoadBalancing?.enabled ??
              false,
          },
        },
      },
    });
  }

  // VPC endpoint access (public/private endpoint + public access CIDRs).
  const desiredVpc = desired.resourcesVpcConfig;
  const observedVpc = observed.resourcesVpcConfig;
  const endpointPublicDrift =
    desiredVpc.endpointPublicAccess !== undefined &&
    desiredVpc.endpointPublicAccess !== observedVpc.endpointPublicAccess;
  const endpointPrivateDrift =
    desiredVpc.endpointPrivateAccess !== undefined &&
    desiredVpc.endpointPrivateAccess !== observedVpc.endpointPrivateAccess;
  const publicCidrsDrift =
    desiredVpc.publicAccessCidrs !== undefined &&
    !stringSetEqual(
      desiredVpc.publicAccessCidrs,
      observedVpc.publicAccessCidrs,
    );
  if (endpointPublicDrift || endpointPrivateDrift || publicCidrsDrift) {
    updates.push({
      category: "vpc-endpoint",
      request: {
        resourcesVpcConfig: {
          endpointPublicAccess: desiredVpc.endpointPublicAccess,
          endpointPrivateAccess: desiredVpc.endpointPrivateAccess,
          publicAccessCidrs: desiredVpc.publicAccessCidrs,
        },
      },
    });
  }

  // VPC subnet / security-group membership — separate from endpoint access.
  const subnetsDrift =
    desiredVpc.subnetIds !== undefined &&
    !stringSetEqual(desiredVpc.subnetIds, observedVpc.subnetIds);
  const securityGroupsDrift =
    desiredVpc.securityGroupIds !== undefined &&
    !stringSetEqual(desiredVpc.securityGroupIds, observedVpc.securityGroupIds);
  if (subnetsDrift || securityGroupsDrift) {
    updates.push({
      category: "vpc-network",
      request: {
        resourcesVpcConfig: {
          subnetIds: desiredVpc.subnetIds,
          securityGroupIds: desiredVpc.securityGroupIds,
        },
      },
    });
  }

  // Control-plane logging — compare per log type; types the user didn't
  // mention are "don't care".
  if (desired.logging !== undefined) {
    const observedLogging = loggingByType(observed.logging);
    const desiredLogging = loggingByType(desired.logging);
    if (
      Object.entries(desiredLogging).some(
        ([type, enabled]) => (observedLogging[type] ?? false) !== enabled,
      )
    ) {
      updates.push({
        category: "logging",
        request: { logging: desired.logging },
      });
    }
  }

  // Upgrade policy.
  if (
    desired.upgradePolicy?.supportType !== undefined &&
    desired.upgradePolicy.supportType !== observed.upgradePolicy?.supportType
  ) {
    updates.push({
      category: "upgrade-policy",
      request: { upgradePolicy: desired.upgradePolicy },
    });
  }

  // Deletion protection.
  if (
    desired.deletionProtection !== undefined &&
    desired.deletionProtection !== observed.deletionProtection
  ) {
    updates.push({
      category: "deletion-protection",
      request: { deletionProtection: desired.deletionProtection },
    });
  }

  return updates;
};

const mapClusterState = (
  cluster: eks.Cluster,
  tags: Record<string, string>,
  kubernetesObjects: KubernetesObjectRef[],
  managedRoles: {
    managedClusterRoleName?: string;
    managedNodeRoleName?: string;
  } = {},
): Cluster["Attributes"] => ({
  managedClusterRoleName: managedRoles.managedClusterRoleName,
  managedNodeRoleName: managedRoles.managedNodeRoleName,
  clusterArn: cluster.arn as ClusterArn,
  clusterName: cluster.name!,
  status: cluster.status ?? "CREATING",
  endpoint: cluster.endpoint,
  certificateAuthorityData: cluster.certificateAuthority?.data,
  version: cluster.version,
  platformVersion: cluster.platformVersion,
  roleArn: cluster.roleArn!,
  resourcesVpcConfig: {
    subnetIds: cluster.resourcesVpcConfig?.subnetIds ?? [],
    securityGroupIds: cluster.resourcesVpcConfig?.securityGroupIds ?? [],
    clusterSecurityGroupId: cluster.resourcesVpcConfig?.clusterSecurityGroupId,
    vpcId: cluster.resourcesVpcConfig?.vpcId,
    endpointPublicAccess: cluster.resourcesVpcConfig?.endpointPublicAccess,
    endpointPrivateAccess: cluster.resourcesVpcConfig?.endpointPrivateAccess,
    publicAccessCidrs: cluster.resourcesVpcConfig?.publicAccessCidrs ?? [],
  },
  accessConfig: cluster.accessConfig,
  computeConfig: cluster.computeConfig,
  storageConfig: cluster.storageConfig,
  kubernetesNetworkConfig: cluster.kubernetesNetworkConfig,
  logging: cluster.logging,
  upgradePolicy: cluster.upgradePolicy,
  deletionProtection: cluster.deletionProtection ?? false,
  oidcIssuer: cluster.identity?.oidc?.issuer,
  tags,
  kubernetesObjects,
});

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const toClusterName = (
        id: string,
        props: { clusterName?: string } = {},
      ) =>
        props.clusterName
          ? Effect.succeed(props.clusterName)
          : createPhysicalName({ id, maxLength: 100 });

      const toClientRequestToken = (id: string, action: string) =>
        createPhysicalName({
          id: `${id}-${action}`,
          maxLength: 64,
          delimiter: "-",
        });

      const validateProps = Effect.fn(function* (props: ClusterProps) {
        const subnetIds = props.resourcesVpcConfig.subnetIds ?? [];
        if (subnetIds.length < 2) {
          return yield* Effect.fail(
            new Error("AWS.EKS.Cluster requires at least two subnet IDs"),
          );
        }
        if (!props.roleArn && props.compute !== "auto") {
          return yield* Effect.fail(
            new Error(
              "AWS.EKS.Cluster requires roleArn unless compute is 'auto'",
            ),
          );
        }
        if (
          props.computeConfig?.enabled &&
          props.accessConfig?.authenticationMode === "CONFIG_MAP"
        ) {
          return yield* Effect.fail(
            new Error(
              "AWS.EKS.Cluster Auto Mode requires accessConfig.authenticationMode to include API access",
            ),
          );
        }
      });

      // Ensure an alchemy-managed IAM role for `compute: "auto"` (cluster or
      // node role). Idempotent: creates on miss, adopts our own role on race,
      // and converges managed policy attachments.
      const ensureManagedRole = Effect.fn(function* ({
        id,
        roleName,
        service,
        actions,
        managedPolicyArns,
        userTags,
      }: {
        id: string;
        roleName: string;
        service: string;
        actions: string[];
        managedPolicyArns: string[];
        userTags: Record<string, string> | undefined;
      }) {
        const tags = yield* createInternalTags(id);
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: service },
                  Action: actions,
                },
              ],
            }),
            Tags: Object.entries({ ...tags, ...userTags }).map(
              ([Key, Value]) => ({ Key, Value }),
            ),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }).pipe(
                Effect.filterOrFail(
                  (existing) => hasTags(tags, existing.Role?.Tags),
                  () =>
                    new Error(
                      `Role '${roleName}' already exists and is not managed by alchemy`,
                    ),
                ),
              ),
            ),
          );
        for (const policyArn of managedPolicyArns) {
          yield* iam
            .attachRolePolicy({ RoleName: roleName, PolicyArn: policyArn })
            .pipe(Effect.catchTag("LimitExceededException", () => Effect.void));
        }
        return role.Role!.Arn!;
      });

      const deleteManagedRole = Effect.fn(function* (roleName: string) {
        yield* iam.listAttachedRolePolicies.items({ RoleName: roleName }).pipe(
          Stream.mapEffect((policy) =>
            iam
              .detachRolePolicy({
                RoleName: roleName,
                PolicyArn: policy.PolicyArn!,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              ),
          ),
          Stream.runDrain,
          Effect.catchTag("NoSuchEntityException", () => Effect.void),
        );
        yield* iam.listRolePolicies.items({ RoleName: roleName }).pipe(
          Stream.mapEffect((policyName) =>
            iam
              .deleteRolePolicy({
                RoleName: roleName,
                PolicyName: policyName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              ),
          ),
          Stream.runDrain,
          Effect.catchTag("NoSuchEntityException", () => Effect.void),
        );
        yield* iam
          .deleteRole({ RoleName: roleName })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
      });

      const readCluster = Effect.fn(function* ({
        clusterName,
        kubernetesObjects,
        managedRoles,
      }: {
        clusterName: string;
        kubernetesObjects?: KubernetesObjectRef[];
        managedRoles?: {
          managedClusterRoleName?: string;
          managedNodeRoleName?: string;
        };
      }) {
        const described = yield* eks
          .describeCluster({
            name: clusterName,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const cluster = described?.cluster;
        if (!cluster?.arn || !cluster.name || !cluster.roleArn) {
          return undefined;
        }
        const listedTags = yield* eks
          .listTagsForResource({
            resourceArn: cluster.arn,
          })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const tags = normalizeTags(listedTags?.tags ?? cluster.tags);
        return mapClusterState(
          cluster,
          tags,
          kubernetesObjects ?? [],
          managedRoles,
        );
      });

      const waitForClusterActive = (
        clusterName: string,
        kubernetesObjects: KubernetesObjectRef[] = [],
        managedRoles?: {
          managedClusterRoleName?: string;
          managedNodeRoleName?: string;
        },
      ) =>
        readCluster({
          clusterName,
          kubernetesObjects,
          managedRoles,
        }).pipe(
          Effect.flatMap((state) => {
            if (!state) {
              return Effect.fail(
                new ClusterNotReady({
                  status: undefined,
                }),
              );
            }
            if (state.status === "ACTIVE") {
              return Effect.succeed(state);
            }
            if (state.status === "FAILED") {
              return Effect.fail(
                new Error(`EKS cluster '${clusterName}' entered FAILED state`),
              );
            }
            return Effect.fail(
              new ClusterNotReady({
                status: state.status,
              }),
            );
          }),
          Effect.retry({
            while: (error) => error instanceof ClusterNotReady,
            schedule: updateRetrySchedule,
          }),
        );

      const waitForClusterDeleted = (clusterName: string) =>
        readCluster({
          clusterName,
        }).pipe(
          Effect.flatMap((state) =>
            state
              ? Effect.fail(new ClusterStillExists())
              : Effect.succeed(undefined),
          ),
          Effect.retry({
            while: (error) => error instanceof ClusterStillExists,
            schedule: updateRetrySchedule,
          }),
        );

      const waitForUpdate = (clusterName: string, updateId: string) =>
        eks
          .describeUpdate({
            name: clusterName,
            updateId,
          })
          .pipe(
            Effect.flatMap(({ update }) => {
              if (update?.status === "Successful") {
                return Effect.succeed(update);
              }
              if (
                update?.status === "Failed" ||
                update?.status === "Cancelled"
              ) {
                return Effect.fail(
                  new Error(
                    `EKS cluster update '${updateId}' failed with status '${update?.status}'`,
                  ),
                );
              }
              return Effect.fail(
                new ClusterUpdateNotComplete({
                  status: update?.status,
                }),
              );
            }),
            Effect.retry({
              while: (error) => error instanceof ClusterUpdateNotComplete,
              schedule: updateRetrySchedule,
            }),
          );

      return {
        stables: ["clusterArn", "clusterName"],
        // Enumerate every cluster in the ambient account/region. `listClusters`
        // returns only names, so we paginate it exhaustively then hydrate each
        // name through `readCluster` (describe + tags) to produce the full
        // `Attributes` shape `read` returns. Concurrency is bounded so we don't
        // stampede `describeCluster`.
        list: () =>
          Effect.gen(function* () {
            const names = yield* eks.listClusters.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.clusters ?? []),
              ),
            );
            const states = yield* Effect.forEach(
              names,
              (clusterName) => readCluster({ clusterName }),
              { concurrency: 8 },
            );
            return states.filter(
              (state): state is Cluster["Attributes"] => state !== undefined,
            );
          }),
        diff: Effect.fn(function* ({ id, olds = {} as ClusterProps, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toClusterName(id, olds)) !==
            (yield* toClusterName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (olds.roleArn !== news.roleArn) {
            return { action: "replace" } as const;
          }
          if (
            olds.accessConfig?.bootstrapClusterCreatorAdminPermissions !==
            news.accessConfig?.bootstrapClusterCreatorAdminPermissions
          ) {
            return { action: "replace" } as const;
          }
          if (
            olds.kubernetesNetworkConfig?.serviceIpv4Cidr !==
              news.kubernetesNetworkConfig?.serviceIpv4Cidr ||
            olds.kubernetesNetworkConfig?.ipFamily !==
              news.kubernetesNetworkConfig?.ipFamily
          ) {
            return { action: "replace" } as const;
          }
          if (
            olds.computeConfig?.nodeRoleArn !==
              news.computeConfig?.nodeRoleArn &&
            (olds.computeConfig?.enabled || news.computeConfig?.enabled)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const clusterName =
            output?.clusterName ?? (yield* toClusterName(id, olds ?? {}));
          const state = yield* readCluster({
            clusterName,
            kubernetesObjects: output?.kubernetesObjects,
            managedRoles: output,
          });
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags))
            ? state
            : Unowned(state);
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          bindings,
          session,
        }) {
          yield* validateProps(news);

          const clusterName = yield* toClusterName(id, news);
          const desiredObjects = getDesiredKubernetesObjects(bindings);
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Ensure `compute: "auto"` managed IAM roles before touching the
          // cluster. Physical names are cached in the output so re-runs and
          // updates converge on the same roles.
          const auto = news.compute === "auto";
          let managedClusterRoleName = output?.managedClusterRoleName;
          let managedNodeRoleName = output?.managedNodeRoleName;
          let roleArn = news.roleArn;
          if (!roleArn && auto) {
            managedClusterRoleName ??= yield* createPhysicalName({
              id: `${id}-cluster-role`,
              maxLength: 64,
            });
            roleArn = yield* ensureManagedRole({
              id,
              roleName: managedClusterRoleName,
              service: "eks.amazonaws.com",
              actions: ["sts:AssumeRole", "sts:TagSession"],
              managedPolicyArns: autoClusterManagedPolicyArns,
              userTags: news.tags,
            });
          } else if (roleArn) {
            managedClusterRoleName = undefined;
          }
          let nodeRoleArn = news.computeConfig?.nodeRoleArn;
          if (!nodeRoleArn && auto) {
            managedNodeRoleName ??= yield* createPhysicalName({
              id: `${id}-node-role`,
              maxLength: 64,
            });
            nodeRoleArn = yield* ensureManagedRole({
              id,
              roleName: managedNodeRoleName,
              service: "ec2.amazonaws.com",
              actions: ["sts:AssumeRole"],
              managedPolicyArns: autoNodeManagedPolicyArns,
              userTags: news.tags,
            });
          } else if (nodeRoleArn) {
            managedNodeRoleName = undefined;
          }
          if (!roleArn) {
            return yield* Effect.fail(
              new Error(
                "AWS.EKS.Cluster requires roleArn unless compute is 'auto'",
              ),
            );
          }
          const managedRoles = { managedClusterRoleName, managedNodeRoleName };
          const effective = applyAutoModeDefaults(news, {
            roleArn,
            nodeRoleArn,
          });

          // Observe — fetch live cloud state. We always fetch fresh so
          // adoption, drift, and partial-prior-runs all converge.
          let state = yield* readCluster({
            clusterName,
            kubernetesObjects: output?.kubernetesObjects,
            managedRoles,
          });

          // Ensure — create cluster if missing. Tolerate
          // `ResourceInUseException` as a race with a peer reconciler:
          // re-read and continue with the sync path. The control plane
          // takes 10+ minutes; we wait for ACTIVE before any sync work.
          if (!state) {
            yield* eks
              .createCluster({
                name: clusterName,
                version: effective.version,
                roleArn: effective.roleArn,
                resourcesVpcConfig: effective.resourcesVpcConfig,
                kubernetesNetworkConfig: effective.kubernetesNetworkConfig,
                logging: effective.logging,
                accessConfig: effective.accessConfig,
                computeConfig: effective.computeConfig,
                storageConfig: effective.storageConfig,
                deletionProtection: effective.deletionProtection,
                upgradePolicy: effective.upgradePolicy,
                tags: desiredTags,
                clientRequestToken: yield* toClientRequestToken(id, "create"),
              })
              .pipe(
                Effect.catchTag("ResourceInUseException", () => Effect.void),
              );

            yield* session.note(`Creating EKS cluster ${clusterName}...`);
            state = yield* waitForClusterActive(clusterName, [], managedRoles);
          }

          const clusterArn = state.clusterArn;

          // Sync cluster config — EKS's UpdateClusterConfig accepts exactly
          // ONE update category per call ("Only one type of update can be
          // allowed"), so we plan the observed↔desired drift per category and
          // issue one serialized updateClusterConfig per drifted category,
          // waiting for each async update to land (Successful + cluster back
          // to ACTIVE) before the next. Everything settable at create time is
          // already passed to createCluster, so a greenfield create plans
          // zero updates.
          for (const { category, request } of planClusterConfigUpdates(
            state,
            effective,
          )) {
            const configUpdate = yield* eks.updateClusterConfig({
              name: clusterName,
              ...request,
              clientRequestToken: yield* toClientRequestToken(
                id,
                `config-${category}`,
              ),
            });
            if (configUpdate.update?.id) {
              yield* session.note(
                `Updating EKS cluster ${category} config (${clusterName})...`,
              );
              yield* waitForUpdate(clusterName, configUpdate.update.id);
              state =
                (yield* waitForClusterActive(
                  clusterName,
                  output?.kubernetesObjects ?? [],
                  managedRoles,
                )) ?? state;
            }
          }

          // Sync version — observed ↔ desired.
          if (effective.version && state.version !== effective.version) {
            const versionUpdate = yield* eks.updateClusterVersion({
              name: clusterName,
              version: effective.version,
              clientRequestToken: yield* toClientRequestToken(id, "version"),
            });
            if (versionUpdate.update?.id) {
              yield* session.note(
                `Updating EKS cluster version ${clusterName}...`,
              );
              yield* waitForUpdate(clusterName, versionUpdate.update.id);
              state =
                (yield* waitForClusterActive(
                  clusterName,
                  output?.kubernetesObjects ?? [],
                  managedRoles,
                )) ?? state;
            }
          }

          // Sync tags — diff observed cloud tags against desired.
          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (upsert.length > 0) {
            yield* eks.tagResource({
              resourceArn: clusterArn,
              tags: Object.fromEntries(
                upsert.map((tag) => [tag.Key, tag.Value] as const),
              ),
            });
          }
          if (removed.length > 0) {
            yield* eks.untagResource({
              resourceArn: clusterArn,
              tagKeys: removed,
            });
          }

          yield* session.note(clusterArn);

          // Re-read final state so returned attributes reflect the post-
          // sync cloud state.
          const final = yield* readCluster({
            clusterName,
            kubernetesObjects: output?.kubernetesObjects ?? [],
            managedRoles,
          });
          if (!final) {
            return yield* Effect.fail(
              new Error(
                `EKS cluster '${clusterName}' could not be read after reconcile`,
              ),
            );
          }

          const kubernetesObjects = yield* reconcileObjects({
            connection: getKubernetesConnection(final),
            previousObjects: output?.kubernetesObjects ?? [],
            desiredObjects,
          });

          return {
            ...final,
            kubernetesObjects,
          };
        }),
        delete: Effect.fn(function* ({ id, output }) {
          if ((output.kubernetesObjects ?? []).length > 0) {
            yield* deleteObjects({
              connection: getKubernetesConnection(output),
              objects: output.kubernetesObjects ?? [],
            });
          }

          if (output.deletionProtection) {
            const disableDeletionProtection = yield* eks.updateClusterConfig({
              name: output.clusterName,
              deletionProtection: false,
              clientRequestToken: yield* toClientRequestToken(
                id,
                "disable-deletion-protection",
              ),
            });
            if (disableDeletionProtection.update?.id) {
              yield* waitForUpdate(
                output.clusterName,
                disableDeletionProtection.update.id,
              );
              yield* waitForClusterActive(
                output.clusterName,
                output.kubernetesObjects ?? [],
              );
            }
          }

          yield* eks
            .deleteCluster({
              name: output.clusterName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          yield* waitForClusterDeleted(output.clusterName);

          // Delete the `compute: "auto"` managed IAM roles this cluster owns.
          if (output.managedClusterRoleName) {
            yield* deleteManagedRole(output.managedClusterRoleName);
          }
          if (output.managedNodeRoleName) {
            yield* deleteManagedRole(output.managedNodeRoleName);
          }
        }),
      };
    }),
  );

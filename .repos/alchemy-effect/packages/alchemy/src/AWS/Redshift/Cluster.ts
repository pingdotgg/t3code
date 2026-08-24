import * as redshift from "@distilled.cloud/aws/redshift";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import { durationToDays, unwrapRedactedString } from "../IAM/common.ts";
import type { Providers } from "../Providers.ts";
import {
  applyRedshiftTagDelta,
  redshiftArn,
  sameStringSet,
  toTagRecord,
} from "./internal.ts";

/**
 * Creating a provisioned Redshift cluster requires either a
 * `masterUserPassword` or `manageMasterPassword: true`.
 */
export class RedshiftMasterPasswordRequired extends Data.TaggedError(
  "RedshiftMasterPasswordRequired",
)<{
  readonly clusterIdentifier: string;
}> {}

export interface ClusterProps {
  /**
   * Unique identifier of the cluster. Must be 1-63 lowercase alphanumeric
   * characters or hyphens, starting with a letter. If omitted, a
   * deterministic physical name is generated. Changing the identifier
   * replaces the cluster.
   */
  clusterIdentifier?: string;
  /**
   * Node type of the cluster, e.g. `ra3.large`, `ra3.xlplus` or
   * `dc2.large`. Changing the node type triggers an in-place resize.
   * @default "ra3.large"
   */
  nodeType?: string;
  /**
   * Number of compute nodes. `1` provisions a single-node cluster; any
   * larger value provisions a multi-node cluster. Changing the count
   * triggers an in-place resize.
   * @default 1
   */
  numberOfNodes?: number;
  /**
   * Admin username for the cluster database. Changing the username replaces
   * the cluster.
   * @default "awsuser"
   */
  masterUsername?: string;
  /**
   * Admin password. Must be 8-64 characters with at least one uppercase
   * letter, one lowercase letter and one number. Provide this or set
   * `manageMasterPassword`.
   */
  masterUserPassword?: Redacted.Redacted<string>;
  /**
   * Let Amazon Redshift manage the admin password in Secrets Manager
   * instead of supplying `masterUserPassword`. The secret ARN is surfaced
   * as the `masterPasswordSecretArn` attribute.
   * @default false
   */
  manageMasterPassword?: boolean;
  /**
   * Name of the initial database created in the cluster. Changing the
   * database name replaces the cluster.
   * @default "dev"
   */
  dbName?: string;
  /**
   * Name of the {@link ClusterSubnetGroup} the cluster's nodes are placed
   * into. Changing the subnet group replaces the cluster.
   * @default the default cluster subnet group
   */
  clusterSubnetGroupName?: string;
  /**
   * VPC security group IDs that control network access to the cluster
   * endpoint.
   * @default the VPC's default security group
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Name of the {@link ClusterParameterGroup} applied to the cluster.
   * @default the family's default parameter group
   */
  clusterParameterGroupName?: string;
  /**
   * Whether the cluster endpoint is reachable from the public internet.
   * @default false
   */
  publiclyAccessible?: boolean;
  /**
   * Whether data at rest is encrypted. RA3 node types are always encrypted.
   * @default true
   */
  encrypted?: boolean;
  /**
   * Customer-managed KMS key used for encryption at rest.
   * @default AWS-owned Redshift key
   */
  kmsKeyId?: string;
  /**
   * Port the cluster database accepts connections on. Changing the port
   * replaces the cluster.
   * @default 5439
   */
  port?: number;
  /**
   * Availability Zone the cluster is provisioned in. Changing the AZ
   * replaces the cluster.
   * @default chosen by Redshift
   */
  availabilityZone?: string;
  /**
   * Weekly maintenance window, e.g. `sun:05:00-sun:05:30` (UTC).
   */
  preferredMaintenanceWindow?: string;
  /**
   * How long automated snapshots are retained, e.g. `"7 days"` or
   * `Duration.days(7)` (a bare number is milliseconds). Rounded to whole
   * days on the wire; zero disables automated snapshots.
   */
  automatedSnapshotRetentionPeriod?: Duration.Input;
  /**
   * Whether major engine upgrades may be applied during the maintenance
   * window.
   * @default true
   */
  allowVersionUpgrade?: boolean;
  /**
   * Whether enhanced VPC routing forces COPY/UNLOAD traffic through the
   * VPC.
   * @default false
   */
  enhancedVpcRouting?: boolean;
  /**
   * IAM role ARNs the cluster can assume for COPY/UNLOAD and federated
   * queries (max 50).
   */
  iamRoles?: string[];
  /**
   * User-defined tags for the cluster.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.Redshift.Cluster",
  ClusterProps,
  {
    /**
     * Unique identifier of the cluster.
     */
    clusterIdentifier: string;
    /**
     * ARN of the cluster.
     */
    clusterArn: string;
    /**
     * ARN of the cluster's namespace (used by datashares and the Data API).
     */
    clusterNamespaceArn: string | undefined;
    /**
     * Current cluster status (e.g. `"available"`).
     */
    clusterStatus: string;
    /**
     * Node type of the cluster (e.g. `"ra3.large"`).
     */
    nodeType: string;
    /**
     * Number of compute nodes in the cluster.
     */
    numberOfNodes: number;
    /**
     * Name of the initial database.
     */
    dbName: string;
    /**
     * Admin (master) user name.
     */
    masterUsername: string | undefined;
    /**
     * DNS address of the cluster endpoint (pgwire host).
     */
    endpointAddress: string | undefined;
    /**
     * Port of the cluster endpoint (5439 by default).
     */
    endpointPort: number | undefined;
    /**
     * ID of the VPC the cluster runs in.
     */
    vpcId: string | undefined;
    /**
     * Availability zone the cluster is placed in.
     */
    availabilityZone: string | undefined;
    /**
     * Name of the cluster subnet group the cluster is placed in, if any.
     */
    clusterSubnetGroupName: string | undefined;
    /**
     * Whether the cluster endpoint is reachable from the public internet.
     */
    publiclyAccessible: boolean | undefined;
    /**
     * Whether the cluster's data is encrypted at rest.
     */
    encrypted: boolean | undefined;
    /**
     * KMS key encrypting the cluster, if any.
     */
    kmsKeyId: string | undefined;
    /**
     * ARN of the Secrets Manager secret holding the admin password when
     * `manageMasterPassword` is enabled.
     */
    masterPasswordSecretArn: string | undefined;
    /**
     * Tags on the cluster (including internal Alchemy tags).
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A provisioned Amazon Redshift data-warehouse cluster.
 *
 * Clusters take roughly 5-10 minutes to provision and are billed hourly per
 * node while they exist (`ra3.large` and `dc2.large` are the smallest node
 * types). For serverless data warehousing see the `RedshiftServerless`
 * namespace instead. Destroy clusters you are not using.
 * @resource
 * @section Creating a Cluster
 * @example Single-Node Cluster
 * ```typescript
 * const cluster = yield* Redshift.Cluster("Warehouse", {
 *   nodeType: "ra3.large",
 *   numberOfNodes: 1,
 *   masterUsername: "admin",
 *   masterUserPassword: warehousePassword,
 *   dbName: "analytics",
 * });
 * ```
 * @example Cluster in a VPC Subnet Group
 * ```typescript
 * const subnetGroup = yield* Redshift.ClusterSubnetGroup("WarehouseSubnets", {
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * const cluster = yield* Redshift.Cluster("Warehouse", {
 *   nodeType: "ra3.large",
 *   numberOfNodes: 2,
 *   masterUsername: "admin",
 *   manageMasterPassword: true,
 *   clusterSubnetGroupName: subnetGroup.clusterSubnetGroupName,
 *   publiclyAccessible: false,
 *   encrypted: true,
 * });
 * ```
 */
export const Cluster = Resource<Cluster>("AWS.Redshift.Cluster");

const DEFAULT_NODE_TYPE = "ra3.large";
const DEFAULT_MASTER_USERNAME = "awsuser";
const DEFAULT_DB_NAME = "dev";

/**
 * Retry an effect while the cluster is mid-transition
 * (`InvalidClusterStateFault`), bounded to ~5 minutes.
 *
 * Expressed as an explicitly-typed module-scope helper: inlining
 * `Effect.retry` in a lifecycle operation leaves `Retry.Return`'s
 * conditional type unresolved in the provider's inferred layer type, which
 * declaration emit widens to an `unknown` R — poisoning `AWS.providers()`
 * for every downstream consumer.
 */
const retryWhileClusterTransitioning = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "InvalidClusterStateFault",
    schedule: Schedule.max([Schedule.fixed("15 seconds"), Schedule.recurs(20)]),
  });

/**
 * Bounded status polling (~20 minutes; cluster provisioning/resizing
 * typically completes in 5-10). Same explicit-annotation rationale as
 * {@link retryWhileClusterTransitioning}.
 */
const retryUntilSettled = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    schedule: Schedule.max([Schedule.fixed("15 seconds"), Schedule.recurs(80)]),
  });

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ClusterProps>) =>
        props.clusterIdentifier
          ? Effect.succeed(props.clusterIdentifier)
          : createPhysicalName({ id, maxLength: 63, lowercase: true });

      const readCluster = Effect.fn(function* (identifier: string) {
        const response = yield* redshift
          .describeClusters({ ClusterIdentifier: identifier })
          .pipe(
            Effect.catchTag("ClusterNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.Clusters?.[0];
      });

      const waitForAvailable = Effect.fn(function* (identifier: string) {
        return yield* retryUntilSettled(
          readCluster(identifier).pipe(
            Effect.flatMap((cluster) => {
              if (cluster === undefined) {
                return Effect.fail(
                  new Error(`Cluster '${identifier}' not found`),
                );
              }
              if (cluster.ClusterStatus !== "available") {
                return Effect.fail(
                  new Error(
                    `Cluster '${identifier}' not available (status: ${cluster.ClusterStatus})`,
                  ),
                );
              }
              return Effect.succeed(cluster);
            }),
          ),
        );
      });

      // Wait for a cluster to leave a transitional state before delete.
      // Ends when the cluster is available, deleting, or gone.
      const waitUntilSettled = Effect.fn(function* (identifier: string) {
        return yield* retryUntilSettled(
          readCluster(identifier).pipe(
            Effect.flatMap((cluster) => {
              if (
                cluster !== undefined &&
                cluster.ClusterStatus !== "available" &&
                cluster.ClusterStatus !== "deleting"
              ) {
                return Effect.fail(
                  new Error(
                    `Cluster '${identifier}' still settling (status: ${cluster.ClusterStatus})`,
                  ),
                );
              }
              return Effect.succeed(cluster);
            }),
          ),
        );
      });

      const toAttrs = Effect.fn(function* (cluster: redshift.Cluster) {
        const { accountId, region } = yield* AWSEnvironment.current;
        if (!cluster.ClusterIdentifier) {
          return yield* Effect.fail(
            new Error("Cluster is missing its identifier"),
          );
        }
        return {
          clusterIdentifier: cluster.ClusterIdentifier,
          clusterArn: redshiftArn(
            region,
            accountId,
            "cluster",
            cluster.ClusterIdentifier,
          ),
          clusterNamespaceArn: cluster.ClusterNamespaceArn,
          clusterStatus: cluster.ClusterStatus ?? "available",
          nodeType: cluster.NodeType ?? DEFAULT_NODE_TYPE,
          numberOfNodes: cluster.NumberOfNodes ?? 1,
          dbName: cluster.DBName ?? DEFAULT_DB_NAME,
          masterUsername: cluster.MasterUsername,
          endpointAddress: cluster.Endpoint?.Address,
          endpointPort: cluster.Endpoint?.Port,
          vpcId: cluster.VpcId,
          availabilityZone: cluster.AvailabilityZone,
          clusterSubnetGroupName: cluster.ClusterSubnetGroupName,
          publiclyAccessible: cluster.PubliclyAccessible,
          encrypted: cluster.Encrypted,
          kmsKeyId: cluster.KmsKeyId,
          masterPasswordSecretArn: cluster.MasterPasswordSecretArn,
          tags: toTagRecord(cluster.Tags),
        };
      });

      return {
        stables: ["clusterIdentifier", "clusterArn", "clusterNamespaceArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const n = news ?? {};
          const o = olds ?? {};
          if ((yield* toName(id, o)) !== (yield* toName(id, n))) {
            return { action: "replace" } as const;
          }
          // Create-only properties force a replacement.
          if ((n.dbName ?? DEFAULT_DB_NAME) !== (o.dbName ?? DEFAULT_DB_NAME)) {
            return { action: "replace" } as const;
          }
          if (
            (n.masterUsername ?? DEFAULT_MASTER_USERNAME) !==
            (o.masterUsername ?? DEFAULT_MASTER_USERNAME)
          ) {
            return { action: "replace" } as const;
          }
          if (
            n.clusterSubnetGroupName !== undefined &&
            o.clusterSubnetGroupName !== undefined &&
            n.clusterSubnetGroupName !== o.clusterSubnetGroupName
          ) {
            return { action: "replace" } as const;
          }
          if ((n.port ?? undefined) !== (o.port ?? undefined)) {
            return { action: "replace" } as const;
          }
          if (
            (n.availabilityZone ?? undefined) !==
            (o.availabilityZone ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.clusterIdentifier ?? (yield* toName(id, olds ?? {}));
          const cluster = yield* readCluster(identifier);
          if (cluster === undefined) return undefined;
          const attrs = yield* toAttrs(cluster);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const identifier =
            output?.clusterIdentifier ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredNodes = news.numberOfNodes ?? 1;
          const desiredNodeType = news.nodeType ?? DEFAULT_NODE_TYPE;
          const clusterType = desiredNodes > 1 ? "multi-node" : "single-node";

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readCluster(identifier);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            if (!news.masterUserPassword && !news.manageMasterPassword) {
              return yield* Effect.fail(
                new RedshiftMasterPasswordRequired({
                  clusterIdentifier: identifier,
                }),
              );
            }
            yield* redshift
              .createCluster({
                ClusterIdentifier: identifier,
                NodeType: desiredNodeType,
                ClusterType: clusterType,
                NumberOfNodes: desiredNodes > 1 ? desiredNodes : undefined,
                MasterUsername: news.masterUsername ?? DEFAULT_MASTER_USERNAME,
                MasterUserPassword: news.manageMasterPassword
                  ? undefined
                  : news.masterUserPassword,
                ManageMasterPassword: news.manageMasterPassword,
                DBName: news.dbName ?? DEFAULT_DB_NAME,
                ClusterSubnetGroupName: news.clusterSubnetGroupName,
                VpcSecurityGroupIds: news.vpcSecurityGroupIds,
                ClusterParameterGroupName: news.clusterParameterGroupName,
                PubliclyAccessible: news.publiclyAccessible ?? false,
                Encrypted: news.encrypted ?? true,
                KmsKeyId: news.kmsKeyId,
                Port: news.port,
                AvailabilityZone: news.availabilityZone,
                PreferredMaintenanceWindow: news.preferredMaintenanceWindow,
                AutomatedSnapshotRetentionPeriod: durationToDays(
                  news.automatedSnapshotRetentionPeriod,
                ),
                AllowVersionUpgrade: news.allowVersionUpgrade,
                EnhancedVpcRouting: news.enhancedVpcRouting,
                IamRoles: news.iamRoles,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag("ClusterAlreadyExistsFault", () =>
                  Effect.succeed(undefined),
                ),
              );
          }

          // Provisioning and in-flight modifications both surface as a
          // non-available status; wait (bounded) so modify calls do not hit
          // InvalidClusterStateFault.
          observed = yield* waitForAvailable(identifier);

          // 3. Sync — compute the update delta from OBSERVED state.
          const update: redshift.ModifyClusterMessage = {
            ClusterIdentifier: identifier,
          };
          let mutated = false;
          if (
            desiredNodeType !== observed.NodeType ||
            desiredNodes !== (observed.NumberOfNodes ?? 1)
          ) {
            // Resizes must specify node type, count and cluster type
            // together even when only one of them changes.
            update.NodeType = desiredNodeType;
            update.NumberOfNodes = desiredNodes;
            update.ClusterType = clusterType;
            mutated = true;
          }
          const observedSecurityGroups = (
            observed.VpcSecurityGroups ?? []
          ).flatMap((group) =>
            group.VpcSecurityGroupId ? [group.VpcSecurityGroupId] : [],
          );
          if (
            news.vpcSecurityGroupIds !== undefined &&
            !sameStringSet(news.vpcSecurityGroupIds, observedSecurityGroups)
          ) {
            update.VpcSecurityGroupIds = news.vpcSecurityGroupIds;
            mutated = true;
          }
          if (
            news.clusterParameterGroupName !== undefined &&
            !(observed.ClusterParameterGroups ?? []).some(
              (group) =>
                group.ParameterGroupName === news.clusterParameterGroupName,
            )
          ) {
            update.ClusterParameterGroupName = news.clusterParameterGroupName;
            mutated = true;
          }
          if (
            news.publiclyAccessible !== undefined &&
            news.publiclyAccessible !== observed.PubliclyAccessible
          ) {
            update.PubliclyAccessible = news.publiclyAccessible;
            mutated = true;
          }
          if (
            news.encrypted !== undefined &&
            news.encrypted !== observed.Encrypted
          ) {
            update.Encrypted = news.encrypted;
            update.KmsKeyId = news.kmsKeyId;
            mutated = true;
          } else if (
            news.kmsKeyId !== undefined &&
            news.kmsKeyId !== observed.KmsKeyId
          ) {
            update.Encrypted = news.encrypted ?? true;
            update.KmsKeyId = news.kmsKeyId;
            mutated = true;
          }
          if (
            news.preferredMaintenanceWindow !== undefined &&
            news.preferredMaintenanceWindow !==
              observed.PreferredMaintenanceWindow
          ) {
            update.PreferredMaintenanceWindow = news.preferredMaintenanceWindow;
            mutated = true;
          }
          const desiredRetentionDays = durationToDays(
            news.automatedSnapshotRetentionPeriod,
          );
          if (
            desiredRetentionDays !== undefined &&
            desiredRetentionDays !== observed.AutomatedSnapshotRetentionPeriod
          ) {
            update.AutomatedSnapshotRetentionPeriod = desiredRetentionDays;
            mutated = true;
          }
          if (
            news.allowVersionUpgrade !== undefined &&
            news.allowVersionUpgrade !== observed.AllowVersionUpgrade
          ) {
            update.AllowVersionUpgrade = news.allowVersionUpgrade;
            mutated = true;
          }
          if (
            news.enhancedVpcRouting !== undefined &&
            news.enhancedVpcRouting !== observed.EnhancedVpcRouting
          ) {
            update.EnhancedVpcRouting = news.enhancedVpcRouting;
            mutated = true;
          }
          // The live password is unobservable — apply it only when the
          // declared value actually changed (olds is a hint, never truth).
          if (
            olds !== undefined &&
            news.masterUserPassword !== undefined &&
            (olds.masterUserPassword === undefined ||
              unwrapRedactedString(news.masterUserPassword) !==
                unwrapRedactedString(olds.masterUserPassword))
          ) {
            update.MasterUserPassword = news.masterUserPassword;
            mutated = true;
          }
          if (
            news.manageMasterPassword === true &&
            observed.MasterPasswordSecretArn === undefined
          ) {
            update.ManageMasterPassword = true;
            mutated = true;
          }

          if (mutated) {
            yield* retryWhileClusterTransitioning(
              redshift.modifyCluster(update),
            );
            observed = yield* waitForAvailable(identifier);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags (describe
          //     surfaces them inline).
          const { accountId, region } = yield* AWSEnvironment.current;
          const arn = redshiftArn(region, accountId, "cluster", identifier);
          const { removed, upsert } = diffTags(
            toTagRecord(observed.Tags),
            desiredTags,
          );
          yield* applyRedshiftTagDelta({ arn, upsert, removed });

          yield* session.note(arn);
          const attrs = yield* toAttrs(observed);
          return { ...attrs, tags: desiredTags };
        }),

        delete: Effect.fn(function* ({ output }) {
          const identifier = output.clusterIdentifier;
          // A cluster mid-create/modify rejects deletion with
          // InvalidClusterStateFault — wait (bounded) for it to settle
          // first. A cluster already deleting (or gone) is success.
          yield* waitUntilSettled(identifier).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          yield* retryWhileClusterTransitioning(
            redshift
              .deleteCluster({
                ClusterIdentifier: identifier,
                SkipFinalClusterSnapshot: true,
              })
              .pipe(
                Effect.catchTag("ClusterNotFoundFault", () =>
                  Effect.succeed(undefined),
                ),
              ),
          ).pipe(
            Effect.catchTag("InvalidClusterStateFault", () => Effect.void),
          );
        }),

        list: () =>
          // Top-level account/region collection: exhaustively paginate
          // describeClusters; tags come inline on each cluster.
          redshift.describeClusters.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.Clusters ?? []).filter(
                  (cluster) => cluster.ClusterIdentifier !== undefined,
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((cluster) => toAttrs(cluster), {
                concurrency: 4,
              }),
            ),
          ),
      };
    }),
  );

import * as ec2 from "@distilled.cloud/aws/ec2";
import * as rds from "@distilled.cloud/aws/rds";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
  type PolicyDocument,
} from "../IAM/Policy.ts";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { toWireDays, toWireSeconds } from "../../Util/Duration.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { sha256 } from "../../Util/sha256.ts";

export interface DBInstanceProps {
  /**
   * Instance identifier. If omitted, Alchemy generates one.
   */
  dbInstanceIdentifier?: string;
  /**
   * Aurora cluster the instance belongs to. When set, the instance is a
   * cluster member and most storage/backup props are managed by the cluster.
   * Replacing this forces a new instance.
   */
  dbClusterIdentifier?: string;
  /**
   * Instance class such as `db.serverless` or `db.t3.micro`.
   */
  dbInstanceClass: string;
  /**
   * Database engine, e.g. `mysql`, `postgres`, `aurora-postgresql`.
   * Changing the engine forces replacement.
   */
  engine: string;
  /**
   * Optional engine version. Changed in place via `modifyDBInstance`.
   */
  engineVersion?: string;
  /**
   * Standalone (non-Aurora) database name created with the instance.
   * Immutable — forces replacement.
   */
  dbName?: string;
  /**
   * Minimum allocated storage in GiB (standalone instances). RDS cannot
   * shrink storage; omission/removal retains any larger existing allocation.
   * Defaults to 100 GiB for io1/io2, 40 GiB for other RDS Custom storage,
   * and 20 GiB otherwise. In-place increases request at least 10% growth.
   * Cluster members inherit storage from their cluster.
   */
  allocatedStorage?: number;
  /**
   * Upper limit (GiB) for storage autoscaling on standalone instances.
   * Omission or `0` disables autoscaling, including after adoption or drift.
   * Disabling never shrinks allocated storage. RDS requires the current
   * allocation as the modify request's reset value, not a zero ceiling.
   * Not supported for cluster members or RDS Custom.
   * @default 0
   */
  maxAllocatedStorage?: number;
  /**
   * Storage type: `gp2` | `gp3` | `io1` | `io2` | `standard`. Omission/removal
   * selects gp3, including for existing instances. Magnetic (`standard`)
   * storage is accepted only for existing instances; Db2 does not support gp2.
   * AWS engine, instance-class, and regional restrictions still apply.
   * Cluster members inherit storage from their cluster.
   * @default "gp3"
   */
  storageType?: string;
  /**
   * Provisioned IOPS (io1/io2/gp3). Omission/removal selects a deterministic
   * baseline, not the observed setting: gp3 uses 3000 IOPS, or 12000 for
   * striped storage; io1/io2 use at least 1000. Allocation, autoscaling,
   * engine, and declared throughput can raise that baseline.
   * Small non-SQL Server gp3 volumes have fixed performance. AWS rate-limits
   * changes and may require a storage-optimization cooldown.
   */
  iops?: number;
  /**
   * Storage throughput in MiBps (gp3 only). Omission/removal selects 125,
   * or 500 for striped storage. MySQL/MariaDB IOPS can raise the baseline.
   * gp3 is striped at 200 GiB for Oracle and 400 GiB for other engines,
   * except SQL Server, which does not use the striped baseline.
   */
  storageThroughput?: number;
  /**
   * Master username (standalone instances). Immutable — forces replacement.
   */
  masterUsername?: string;
  /**
   * Master password (standalone instances). In-place modify.
   */
  masterUserPassword?: Redacted.Redacted<string>;
  /**
   * Let RDS manage the master user password in Secrets Manager.
   */
  manageMasterUserPassword?: boolean;
  /**
   * Rotate the managed master user password on the next reconcile.
   */
  rotateMasterUserPassword?: boolean;
  /**
   * KMS key used to encrypt the managed master user secret.
   */
  masterUserSecretKmsKeyId?: string;
  /**
   * Resource policy for this instance's RDS-managed master secret. Omission or
   * removal deletes an existing policy, including after adoption or drift.
   * RDS retains ownership of the secret value, rotation, and deletion.
   * Requires Secrets Manager GetResourcePolicy, ValidateResourcePolicy,
   * PutResourcePolicy, and DeleteResourcePolicy permissions. Declared policies
   * are validated even on no-op plans; writes also use BlockPublicPolicy.
   * Cluster-owned secrets and RDS Custom are not supported by this property.
   */
  masterUserSecretResourcePolicy?: PolicyDocument;
  /**
   * Standalone listener port. Omission/removal restores the engine default:
   * PostgreSQL 5432, MySQL/MariaDB 3306, Oracle 1521, SQL Server 1433, Db2 50000.
   * Unknown engines require an explicit port. RDS Custom supports creation
   * with a port, but changing an existing Custom listener is not supported here.
   * Ignored for Aurora and cluster members: configure the DBCluster port.
   * Changes restart the database and are sent as `DBPortNumber` on modify.
   */
  port?: number;
  /**
   * Multi-AZ deployment (standalone instances). In-place modify.
   */
  multiAZ?: boolean;
  /**
   * Availability zone (standalone single-AZ). Immutable — forces replacement.
   */
  availabilityZone?: string;
  /**
   * Backup retention period (e.g. `"7 days"` or `Duration.days(7)`).
   * Sent to the API in whole days. In-place modify.
   */
  backupRetentionPeriod?: Duration.Input;
  /**
   * Daily backup window, e.g. `07:00-09:00`. In-place modify.
   */
  preferredBackupWindow?: string;
  /**
   * Weekly maintenance window, e.g. `Mon:00:00-Mon:03:00`. In-place modify.
   */
  preferredMaintenanceWindow?: string;
  /**
   * Optional DB subnet group. Effectively immutable for an in-VPC instance.
   */
  dbSubnetGroupName?: string;
  /**
   * DB parameter group. Omission/removal restores `default.<engine-family>`.
   * The family follows the requested version, otherwise the existing engine
   * version, otherwise the regional default for a new instance. Aurora uses
   * its cluster's version. Pending-reboot associations are returned without
   * automatically rebooting. Unsupported on RDS Custom; Db2 BYOL requires
   * an explicit group with IBM licensing IDs.
   */
  dbParameterGroupName?: string;
  /**
   * VPC security groups attached to the instance, compared as a set.
   * Omission/removal restores the default group in the effective instance VPC:
   * the declared subnet group's VPC, the existing instance VPC, or the regional
   * default VPC for a new instance. An empty array is invalid.
   * Resetting changes network access according to the default group's rules;
   * it does not delete detached group resources. Ignored for cluster members,
   * whose security groups are managed on DBCluster. Existing RDS Custom
   * attachments cannot be changed through this provider.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Option group (MySQL/Oracle/SQL Server). In-place modify.
   */
  optionGroupName?: string;
  /**
   * License model, e.g. `license-included` | `bring-your-own-license`.
   */
  licenseModel?: string;
  /**
   * Whether storage is encrypted. Immutable — forces replacement.
   */
  storageEncrypted?: boolean;
  /**
   * KMS key for storage encryption. Immutable — forces replacement.
   */
  kmsKeyId?: string;
  /**
   * CA certificate identifier. In-place modify.
   */
  caCertificateIdentifier?: string;
  /**
   * Enable IAM database authentication. Omission/removal disables it, including
   * after adoption or drift. Cluster members inherit their cluster's setting.
   * Applying a change or a queued IAM change uses ApplyImmediately, which also
   * applies unrelated pending RDS modifications. Supported on standalone
   * PostgreSQL, MySQL, and MariaDB; unsupported on RDS Custom.
   * @default false
   */
  enableIAMDatabaseAuthentication?: boolean;
  /**
   * Enable Performance Insights. In-place modify.
   */
  enablePerformanceInsights?: boolean;
  /**
   * KMS key for Performance Insights. In-place modify.
   */
  performanceInsightsKMSKeyId?: string;
  /**
   * Performance Insights retention (e.g. `"7 days"`). Sent to the API in
   * whole days (valid: 7, 731, or month multiples).
   */
  performanceInsightsRetentionPeriod?: Duration.Input;
  /**
   * Enhanced-monitoring granularity (e.g. `"60 seconds"`). Sent to the API
   * in whole seconds (valid: 0, 1, 5, 10, 15, 30, 60).
   */
  monitoringInterval?: Duration.Input;
  /**
   * IAM role ARN for enhanced monitoring. In-place modify.
   */
  monitoringRoleArn?: string;
  /**
   * Log types to export to CloudWatch Logs, compared as a set. Omission/removal
   * disables all exports. Changes apply immediately without flushing unrelated
   * pending modifications. Cluster members inherit their cluster's exports.
   * Unsupported on RDS Custom.
   * @default []
   */
  enableCloudwatchLogsExports?: string[];
  /**
   * Block accidental deletion. Omission/removal disables protection, including
   * after adoption or drift. Ignored for cluster members: configure DBCluster.
   * Aurora cluster protection does not prevent deleting individual instances.
   * @default false
   */
  deletionProtection?: boolean;
  /**
   * Network type: `IPV4` | `DUAL`. Omission/removal restores IPv4. DUAL requires
   * IPv6-enabled subnets. Ignored for cluster members: configure DBCluster.
   * Changes apply immediately and can also apply unrelated pending RDS changes.
   * @default "IPV4"
   */
  networkType?: string;
  /**
   * Allow a major engine-version upgrade during a modify. Modify-only flag.
   */
  allowMajorVersionUpgrade?: boolean;
  /**
   * Whether the instance has a public address. Omission/removal restores private
   * access, including after adoption or drift. Also managed on Aurora instances;
   * non-Aurora Multi-AZ cluster members inherit their cluster's configuration.
   * Changes apply immediately without flushing unrelated pending modifications.
   * @default false
   */
  publiclyAccessible?: boolean;
  /**
   * Promotion tier inside the cluster.
   */
  promotionTier?: number;
  /**
   * Auto minor version upgrades.
   */
  autoMinorVersionUpgrade?: boolean;
  /**
   * Copy tags to snapshots.
   */
  copyTagsToSnapshot?: boolean;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
  /**
   * Skip the final snapshot when the instance is deleted. Set `false` to
   * have RDS take a final snapshot on teardown — belt-and-suspenders beyond
   * `deletionProtection` for databases whose data must survive a deliberate
   * destroy. Persisted into state so `delete` honors it without props.
   * @default true
   */
  skipFinalSnapshot?: boolean;
  /**
   * Identifier for the final snapshot taken when `skipFinalSnapshot` is
   * `false`. Defaults to `<instance-identifier>-final-<timestamp>` so
   * repeated destroy/create cycles never collide on snapshot names.
   */
  finalDBSnapshotIdentifier?: string;
}

export interface DBInstance extends Resource<
  "AWS.RDS.DBInstance",
  DBInstanceProps,
  {
    /**
     * Identifier of the instance.
     */
    dbInstanceIdentifier: string;
    /**
     * ARN of the instance.
     */
    dbInstanceArn: string;
    /**
     * Aurora cluster the instance belongs to, if any.
     */
    dbClusterIdentifier: string | undefined;
    /**
     * DNS address of the instance endpoint.
     */
    endpointAddress: string | undefined;
    /**
     * Port of the instance endpoint.
     */
    endpointPort: number | undefined;
    /**
     * Instance class (e.g. `db.serverless`, `db.t3.micro`).
     */
    dbInstanceClass: string | undefined;
    /**
     * Database engine.
     */
    engine: string | undefined;
    /**
     * Engine version in use.
     */
    engineVersion: string | undefined;
    /**
     * Status of the instance (e.g. `available`).
     */
    status: string | undefined;
    /**
     * Failover promotion tier inside the cluster.
     */
    promotionTier: number | undefined;
    /**
     * Whether the instance has a public address.
     */
    publiclyAccessible: boolean | undefined;
    /**
     * Subnet group the instance is placed in.
     */
    dbSubnetGroupName: string | undefined;
    /**
     * Parameter groups applied to the instance.
     */
    dbParameterGroupNames: string[];
    /**
     * Observed parameter-group apply statuses, including pending-reboot.
     */
    dbParameterGroupApplyStatuses: Record<string, string | undefined>;
    /**
     * Observed VPC security-group attachments, including cluster-owned groups.
     */
    vpcSecurityGroupIds: string[];
    /**
     * Observed VPC security-group application states, such as `active`.
     */
    vpcSecurityGroupStatuses: Record<string, string | undefined>;
    /**
     * Allocated storage in GiB.
     */
    allocatedStorage: number | undefined;
    /**
     * Storage autoscaling ceiling in GiB.
     */
    maxAllocatedStorage: number | undefined;
    /**
     * Storage type (e.g. `gp3`, `io1`, `aurora`).
     */
    storageType: string | undefined;
    /**
     * Provisioned IOPS.
     */
    iops: number | undefined;
    /**
     * Storage throughput in MiBps (gp3).
     */
    storageThroughput: number | undefined;
    /**
     * Whether the instance is Multi-AZ.
     */
    multiAZ: boolean | undefined;
    /**
     * Availability Zone of the instance.
     */
    availabilityZone: string | undefined;
    /**
     * Standby AZ for Multi-AZ deployments.
     */
    secondaryAvailabilityZone: string | undefined;
    /**
     * Backup retention period in days.
     */
    backupRetentionPeriod: number | undefined;
    /**
     * Daily backup window (`hh:mm-hh:mm` UTC).
     */
    preferredBackupWindow: string | undefined;
    /**
     * Weekly maintenance window.
     */
    preferredMaintenanceWindow: string | undefined;
    /**
     * KMS key used for storage encryption.
     */
    kmsKeyId: string | undefined;
    /**
     * Whether storage is encrypted.
     */
    storageEncrypted: boolean | undefined;
    /**
     * CA certificate identifier.
     */
    caCertificateIdentifier: string | undefined;
    /**
     * Whether IAM database authentication is enabled.
     */
    iamDatabaseAuthenticationEnabled: boolean | undefined;
    /**
     * Observed IAM authentication change awaiting application. A pending value
     * is not evidence that authentication has changed on the database.
     */
    pendingIamDatabaseAuthenticationEnabled: boolean | undefined;
    /**
     * Whether Performance Insights is enabled.
     */
    performanceInsightsEnabled: boolean | undefined;
    /**
     * Enhanced-monitoring granularity in seconds.
     */
    monitoringInterval: number | undefined;
    /**
     * ARN of the enhanced-monitoring CloudWatch Logs stream.
     */
    enhancedMonitoringResourceArn: string | undefined;
    /**
     * Log types exported to CloudWatch Logs.
     */
    enabledCloudwatchLogsExports: string[];
    /**
     * Whether deletion protection is enabled.
     */
    deletionProtection: boolean | undefined;
    /**
     * Immutable region-unique instance resource ID (used in IAM auth ARNs).
     */
    dbiResourceId: string | undefined;
    /**
     * Master username.
     */
    masterUsername: string | undefined;
    /**
     * Whether the final snapshot is skipped on delete, persisted from the
     * prop of the same name. `delete` receives only the stored attributes,
     * never live props, so the snapshot decision must ride in state;
     * `undefined` (older state without this attr) is treated as skip.
     */
    skipFinalSnapshot: boolean | undefined;
    /**
     * Identifier used for the final snapshot when `skipFinalSnapshot` is
     * `false`, persisted from props so `delete` can name the snapshot without
     * live props. `undefined` means `delete` falls back to the default
     * `<instance-identifier>-final-<timestamp>` naming scheme.
     */
    finalDBSnapshotIdentifier: string | undefined;
    /**
     * Salted SHA-256 fingerprint of the last `masterUserPassword` this
     * provider sent to RDS — `sha256(`${dbInstanceIdentifier}:${password}`)`,
     * never the secret itself. Lets reconcile skip the `MasterUserPassword`
     * modify (and the `resetting-master-credentials` cycle it triggers) when
     * the configured password has not changed.
     *
     * Persisted `Redacted` because a password hash is still sensitive: an
     * unsalted digest is vulnerable to rainbow-table lookup, so the state
     * store must not surface it in plaintext (logs, `stringify`, dumps). The
     * per-resource identifier salt additionally defeats precomputed tables;
     * it is stable across a resource's life, so the fingerprint stays
     * comparable across reconciles.
     */
    masterUserPasswordFingerprint: Redacted.Redacted<string> | undefined;
    /**
     * ARN of the Secrets Manager secret holding master credentials.
     */
    masterUserSecretArn: string | undefined;
    /**
     * Canonical policy observed during read or reconciliation. Undefined when
     * there is no instance-managed secret or no resource policy. Inventory
     * listing does not load policy metadata and leaves this attribute undefined.
     */
    masterUserSecretResourcePolicy: string | undefined;
    /**
     * Option group memberships.
     */
    optionGroupMemberships: string[];
    /**
     * License model.
     */
    licenseModel: string | undefined;
    /**
     * Configured database port.
     */
    dbInstancePort: number | undefined;
    /**
     * Network type (`IPV4` or `DUAL`).
     */
    networkType: string | undefined;
    /**
     * Tags on the instance.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An RDS database instance — either a standalone (non-Aurora) database or a
 * member of an Aurora `DBCluster`.
 *
 * Exposes the full storage, backup, monitoring, performance-insights,
 * encryption, networking, and log-export surface of `createDBInstance` /
 * `modifyDBInstance`. Mutable fields are reconciled in place against the
 * observed cloud state; immutable fields (`engine`, `dbName`,
 * `masterUsername`, `availabilityZone`, `storageEncrypted`, `kmsKeyId`,
 * `dbSubnetGroupName`) force a replacement.
 * ### Standalone Instance
 * **Example:** A gp3 MySQL instance
 * ```typescript
 * const db = yield* DBInstance("Db", {
 *   engine: "mysql",
 *   dbInstanceClass: "db.t3.micro",
 *   allocatedStorage: 20,
 *   storageType: "gp3",
 *   masterUsername: "admin",
 *   masterUserPassword: Redacted.make("supersecret"),
 *   backupRetentionPeriod: "7 days",
 *   deletionProtection: false,
 * });
 * ```
 *
 * ### Storage Defaults
 * Omitted storage settings describe desired defaults, including on existing
 * instances: gp3 storage, a minimum allocation of 20 GiB, and the engine's
 * baseline performance. RDS Custom defaults to 40 GiB; io1/io2 default to
 * 100 GiB and at least 1000 IOPS. Only allocated capacity is a floor because
 * RDS cannot shrink a database. Storage type and performance are reconciled
 * even when the program is unchanged and the cloud settings have drifted.
 *
 * **Example:** PostgreSQL with default storage and autoscaling disabled
 * ```typescript
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 * });
 * ```
 *
 * This starts with 20 GiB of gp3 storage, 3000 IOPS, and 125 MiBps. For small
 * non-SQL Server gp3 volumes, these performance values are fixed and Alchemy
 * omits the unsupported performance fields from AWS requests.
 *
 * ### Resetting Storage Performance
 * Removing performance settings restores the baseline for the desired
 * storage type, effective allocation, engine, and autoscaling limit. AWS
 * requires coupled storage fields together on modifications; Alchemy sends
 * the resolved allocation, type, supported performance fields, and ceiling
 * in the same request. Existing database contents are retained.
 *
 * **Example:** Restore the PostgreSQL gp3 baseline at 400 GiB
 * ```diff lang="typescript"
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 *   allocatedStorage: 400,
 * -  iops: 16000,
 * -  storageThroughput: 750,
 * });
 * ```
 *
 * At this allocation PostgreSQL uses striped gp3 storage, so removal requests
 * 12000 IOPS and 500 MiBps. Removing `storageType: "gp2"` instead selects gp3
 * without shrinking the allocation. Changes remain subject to AWS's storage
 * optimization cooldown; redeploying cannot bypass that restriction.
 *
 * ### Storage Autoscaling
 * `allocatedStorage` is a minimum, not a shrink target. RDS can increase the
 * allocation but cannot reduce it in place. `maxAllocatedStorage` controls
 * future automatic growth; omitting it or setting it to `0` disables autoscaling.
 *
 * **Example:** Start with 20 GiB and allow automatic growth to 100 GiB
 * ```typescript
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 *   storageType: "gp2",
 *   allocatedStorage: 20,
 *   maxAllocatedStorage: 100,
 * });
 * ```
 *
 * If RDS grows this database to 30 GiB, redeploying keeps that capacity and the
 * 100 GiB autoscaling limit. It does not attempt to shrink the database to 20 GiB.
 * An externally changed autoscaling limit is reset to the declared value.
 *
 * ### Disabling Storage Autoscaling
 * Removing `maxAllocatedStorage` resets autoscaling to its disabled default.
 * Existing allocated storage and database contents remain intact.
 *
 * **Example:** Remove the autoscaling limit to disable future automatic growth
 * ```diff lang="typescript"
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 *   storageType: "gp2",
 *   allocatedStorage: 20,
 * -  maxAllocatedStorage: 100,
 * });
 * ```
 *
 * `maxAllocatedStorage: 0` has the same behavior. Redeploying with either form
 * also disables autoscaling if it was enabled outside Alchemy.
 *
 * ### Cluster Member
 * **Example:** An Aurora writer instance
 * ```typescript
 * const writer = yield* DBInstance("Writer", {
 *   dbClusterIdentifier: cluster.dbClusterIdentifier,
 *   dbInstanceClass: "db.serverless",
 *   engine: "aurora-postgresql",
 * });
 * ```
 *
 * ### Listener Port Defaults
 * Omitted listener ports select the database engine's default: PostgreSQL
 * 5432, MySQL/MariaDB 3306, Oracle 1521, SQL Server 1433, and Db2 50000.
 * Alchemy compares the actual endpoint port, including pending changes,
 * rather than the separate `DbInstancePort` field returned by AWS.
 *
 * **Example:** PostgreSQL listening on its default port
 * ```typescript
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 * });
 * ```
 *
 * ### Resetting the Listener Port
 * Removing a custom port restores the engine default. Unchanged programs
 * also detect and repair external listener changes. Port changes restart
 * the database, including when restoring defaults after adoption.
 *
 * **Example:** Restore PostgreSQL's port 5432
 * ```diff lang="typescript"
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 * -  port: 5433,
 * });
 * ```
 *
 * Aurora and other cluster members inherit their listener from `DBCluster`;
 * instance `port` declarations are ignored. RDS Custom creation accepts a
 * port, but an existing Custom instance that needs a listener change fails
 * explicitly instead of silently retaining the wrong port or replacing data.
 *
 * ### Association Defaults
 * Parameter and security-group associations are desired configuration.
 * Omission selects a compatible engine default parameter group and the
 * effective VPC's default security group, including during adoption.
 * Existing database versions and VPC placement constrain those defaults;
 * the currently attached groups are never used as fallback desired values.
 *
 * **Example:** Use default associations in a declared network
 * ```typescript
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 *   dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
 * });
 * ```
 *
 * ### Resetting Associations
 * Removing declarations restores defaults. Unchanged programs also repair
 * external attachment drift. Reordering or duplicating security-group IDs
 * does not resend the association request.
 *
 * **Example:** Restore the engine and VPC default groups
 * ```diff lang="typescript"
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 *   dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
 * -  dbParameterGroupName: customParameters.dbParameterGroupName,
 * -  vpcSecurityGroupIds: [applicationGroup.groupId],
 * });
 * ```
 *
 * The default security group's rules determine network access after reset.
 * Detached group resources remain intact. Parameter changes can require a
 * reboot; `dbParameterGroupApplyStatuses` reports `pending-reboot` without
 * automatically restarting the database. Aurora instance parameter groups
 * remain instance-managed, while security groups belong to its cluster.
 * Multi-AZ DB cluster associations are cluster-managed. RDS Custom cannot
 * manage parameter groups or modify existing security-group attachments;
 * Db2 BYOL requires an explicit parameter group with IBM licensing IDs.
 *
 * ### Security Defaults
 * Omission is desired configuration, not permission to retain external state:
 * IAM authentication, public access, and deletion protection default to false,
 * network type to IPV4, and log exports to an empty set. Removal and unchanged
 * declarations repair these settings after drift or adoption.
 *
 * **Example:** Enable IAM authentication and PostgreSQL log exports
 * ```typescript
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 *   dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
 *   enableIAMDatabaseAuthentication: true,
 *   enableCloudwatchLogsExports: ["postgresql"],
 * });
 * ```
 *
 * Removing the last two properties disables IAM authentication and log exports.
 * Public access remains instance-managed for Aurora, while IAM authentication,
 * deletion protection, network type, and exports belong to DBCluster. Requested
 * or observed cluster membership suppresses instance writes to those settings.
 * Non-Aurora Multi-AZ cluster members also inherit public accessibility.
 *
 * ### Pending Security Changes
 * **Example:** Inspect applied and pending IAM authentication separately
 * ```typescript
 * return {
 *   enabled: db.iamDatabaseAuthenticationEnabled,
 *   pending: db.pendingIamDatabaseAuthenticationEnabled,
 *   securityGroupStatuses: db.vpcSecurityGroupStatuses,
 * };
 * ```
 *
 * Deployment waits for applied security settings and an operational instance.
 * A matching queued IAM value is promoted with ApplyImmediately without
 * resending the IAM field; an incompatible queued value is overwritten even
 * when the applied value already matches. AWS has no selective queue flush:
 * applying IAM or network-type changes immediately can apply unrelated pending
 * modifications and cause downtime. Alchemy does not wait until maintenance.
 * Network type has no field in AWS PendingModifiedValues, so an externally
 * queued network change cannot be detected until it starts applying.
 * Public access, deletion protection, and log exports use ApplyImmediately:false
 * because AWS applies these immediately regardless of that flag. They do not
 * flush the maintenance queue. Other declared updates retain their existing
 * immediate-application behavior. Static parameter changes remain pending-reboot;
 * Alchemy never calls RebootDBInstance automatically.
 *
 * ### Managed Master Secret Policy
 * **Example:** Allow a role to read the RDS-managed master secret
 * ```typescript
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 *   masterUserSecretResourcePolicy: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { AWS: reader.roleArn },
 *       Action: ["secretsmanager:GetSecretValue"],
 *       Resource: "*",
 *     }],
 *   },
 * });
 * ```
 *
 * Declared policies are checked with `ValidateResourcePolicy`, including
 * unchanged plans, and writes additionally use `BlockPublicPolicy`. Deployment
 * requires `secretsmanager:ValidateResourcePolicy` permission. Alchemy compares
 * live policy metadata without reading secret values. RDS owns credential
 * generation, rotation, and secret deletion. Only instance-managed secrets are
 * supported; an Aurora or Multi-AZ cluster owns its own secret, and RDS Custom
 * does not support managed credentials. Explicit denies can still obstruct the
 * deployer's access or RDS rotation; policy validation is not a guarantee that
 * every declared permission is operationally safe.
 *
 * ### Removing a Managed Secret Policy
 * **Example:** Restore the default of no resource policy
 * ```diff lang="typescript"
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 * -  masterUserSecretResourcePolicy: readerPolicy,
 * });
 * ```
 *
 * Omission or removal deletes the resource policy, including external policies
 * discovered during adoption or unchanged-input drift detection. Identity-based
 * IAM permissions still apply. The secret, its credentials, and RDS rotation
 * remain intact. Deployment waits for policy readback before returning; managing
 * an existing secret also requires `secretsmanager:GetResourcePolicy` and, when
 * resetting a policy, `secretsmanager:DeleteResourcePolicy`.
 *
 * ### Readiness
 * Deployment waits for an instance ARN and an operational status: `available`
 * or `storage-optimization`. Storage optimization remains online and can
 * continue for hours. Missing or pending observations retain the ten-minute
 * provisioning budget; SDK failures keep their original typed errors rather
 * than being retried by the readiness loop. Unknown statuses and blue/green
 * `storage-initialization` remain bounded pending observations, never ready.
 *
 * **Example:** Return the ready database's status from a stack
 * ```typescript
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   masterUsername: "admin",
 *   manageMasterUserPassword: true,
 * });
 * return { status: db.status };
 * ```
 *
 * States requiring intervention, including `stopped`, `storage-full`, and
 * incompatible or failed configurations, fail with `DBInstanceReadinessBlocked`.
 * Alchemy does not automatically start a stopped instance. Restore its
 * operational state and deploy again. Unchanged declarations also check
 * readiness, while storage, port, and association updates wait for both their
 * requested values and an operational instance before returning.
 *
 * ### Monitoring & Logs
 * **Example:** Enhanced monitoring + log export
 * ```typescript
 * const db = yield* DBInstance("Db", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t3.micro",
 *   allocatedStorage: 20,
 *   monitoringInterval: "60 seconds",
 *   monitoringRoleArn: monitoringRole.roleArn,
 *   enablePerformanceInsights: true,
 *   enableCloudwatchLogsExports: ["postgresql", "upgrade"],
 * });
 * ```
 *
 * @resource
 */
export const DBInstance = Resource<DBInstance>("AWS.RDS.DBInstance");

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

/**
 * Whether two optional master-password fingerprints match, compared by their
 * underlying (`Redacted`-unwrapped) digest. A missing stored fingerprint
 * counts as "does not match" so a pre-existing instance sends its password
 * once, then records the fingerprint for subsequent reconciles.
 */
const sameFingerprint = (
  a: Redacted.Redacted<string> | undefined,
  b: Redacted.Redacted<string> | undefined,
): boolean =>
  a !== undefined && b !== undefined && Redacted.value(a) === Redacted.value(b);

const toAttrs = ({
  instance,
  tags,
  skipFinalSnapshot,
  finalDBSnapshotIdentifier,
  masterUserPasswordFingerprint,
  masterUserSecretResourcePolicy,
}: {
  instance: rds.DBInstance;
  tags: Record<string, string>;
  skipFinalSnapshot?: boolean | undefined;
  finalDBSnapshotIdentifier?: string | undefined;
  masterUserPasswordFingerprint?: Redacted.Redacted<string> | undefined;
  masterUserSecretResourcePolicy?: string | undefined;
}): DBInstance["Attributes"] => ({
  skipFinalSnapshot,
  finalDBSnapshotIdentifier,
  masterUserPasswordFingerprint,
  dbInstanceIdentifier: instance.DBInstanceIdentifier ?? "",
  dbInstanceArn: instance.DBInstanceArn ?? "",
  dbClusterIdentifier: instance.DBClusterIdentifier,
  endpointAddress: instance.Endpoint?.Address,
  endpointPort: instance.Endpoint?.Port,
  dbInstanceClass: instance.DBInstanceClass,
  engine: instance.Engine,
  engineVersion: instance.EngineVersion,
  status: instance.DBInstanceStatus,
  promotionTier: instance.PromotionTier,
  publiclyAccessible: instance.PubliclyAccessible,
  dbSubnetGroupName: instance.DBSubnetGroup?.DBSubnetGroupName,
  dbParameterGroupNames: (instance.DBParameterGroups ?? []).flatMap((group) =>
    group.DBParameterGroupName ? [group.DBParameterGroupName] : [],
  ),
  dbParameterGroupApplyStatuses: Object.fromEntries(
    (instance.DBParameterGroups ?? []).flatMap((group) =>
      group.DBParameterGroupName
        ? [[group.DBParameterGroupName, group.ParameterApplyStatus]]
        : [],
    ),
  ),
  vpcSecurityGroupIds: (instance.VpcSecurityGroups ?? []).flatMap((group) =>
    group.VpcSecurityGroupId ? [group.VpcSecurityGroupId] : [],
  ),
  vpcSecurityGroupStatuses: Object.fromEntries(
    (instance.VpcSecurityGroups ?? []).flatMap((group) =>
      group.VpcSecurityGroupId
        ? [[group.VpcSecurityGroupId, group.Status]]
        : [],
    ),
  ),
  allocatedStorage: instance.AllocatedStorage,
  maxAllocatedStorage: instance.MaxAllocatedStorage,
  storageType: instance.StorageType,
  iops: instance.Iops,
  storageThroughput: instance.StorageThroughput,
  multiAZ: instance.MultiAZ,
  availabilityZone: instance.AvailabilityZone,
  secondaryAvailabilityZone: instance.SecondaryAvailabilityZone,
  backupRetentionPeriod: instance.BackupRetentionPeriod,
  preferredBackupWindow: instance.PreferredBackupWindow,
  preferredMaintenanceWindow: instance.PreferredMaintenanceWindow,
  kmsKeyId: instance.KmsKeyId,
  storageEncrypted: instance.StorageEncrypted,
  caCertificateIdentifier: instance.CACertificateIdentifier,
  iamDatabaseAuthenticationEnabled: instance.IAMDatabaseAuthenticationEnabled,
  pendingIamDatabaseAuthenticationEnabled:
    instance.PendingModifiedValues?.IAMDatabaseAuthenticationEnabled,
  performanceInsightsEnabled: instance.PerformanceInsightsEnabled,
  monitoringInterval: instance.MonitoringInterval,
  enhancedMonitoringResourceArn: instance.EnhancedMonitoringResourceArn,
  enabledCloudwatchLogsExports: instance.EnabledCloudwatchLogsExports ?? [],
  deletionProtection: instance.DeletionProtection,
  dbiResourceId: instance.DbiResourceId,
  masterUsername: instance.MasterUsername,
  masterUserSecretArn: instance.MasterUserSecret?.SecretArn,
  masterUserSecretResourcePolicy,
  optionGroupMemberships: (instance.OptionGroupMemberships ?? []).flatMap(
    (membership) =>
      membership.OptionGroupName ? [membership.OptionGroupName] : [],
  ),
  licenseModel: instance.LicenseModel,
  dbInstancePort: instance.DbInstancePort,
  networkType: instance.NetworkType,
  tags,
});

/**
 * Compute the CloudWatch Logs export delta. The modify API is delta-shaped
 * (`EnableLogTypes`/`DisableLogTypes`), so it must NOT carry the full set.
 * Returns `undefined` when there is no change.
 */
const logExportDelta = (
  observed: string[] | undefined,
  desired: string[] | undefined,
): rds.CloudwatchLogsExportConfiguration | undefined => {
  if (desired === undefined) return undefined;
  const have = new Set(observed ?? []);
  const want = new Set(desired);
  const EnableLogTypes = [...want].filter((t) => !have.has(t));
  const DisableLogTypes = [...have].filter((t) => !want.has(t));
  if (EnableLogTypes.length === 0 && DisableLogTypes.length === 0) {
    return undefined;
  }
  return {
    ...(EnableLogTypes.length > 0 ? { EnableLogTypes } : {}),
    ...(DisableLogTypes.length > 0 ? { DisableLogTypes } : {}),
  };
};

const sameMembers = (
  desired: readonly string[],
  observed: readonly (string | undefined)[],
) => {
  const want = new Set(desired);
  const have = new Set(observed);
  return want.size === have.size && [...want].every((value) => have.has(value));
};

const clusterOwnsConfiguration = (
  props: DBInstanceProps,
  observed?: rds.DBInstance,
) =>
  props.dbClusterIdentifier !== undefined ||
  observed?.DBClusterIdentifier !== undefined ||
  props.engine.startsWith("aurora") ||
  observed?.Engine?.startsWith("aurora") === true;

const securityConfiguration = (
  props: DBInstanceProps,
  observed?: rds.DBInstance,
) => {
  const clusterOwned = clusterOwnsConfiguration(props, observed);
  const custom =
    props.engine.startsWith("custom-") ||
    observed?.Engine?.startsWith("custom-") === true;
  const supportsIam = ["postgres", "mysql", "mariadb"].includes(
    observed?.Engine ?? props.engine,
  );
  return {
    publiclyAccessible:
      clusterOwned &&
      !props.engine.startsWith("aurora") &&
      !observed?.Engine?.startsWith("aurora")
        ? undefined
        : (props.publiclyAccessible ?? false),
    iamAuthentication: clusterOwned
      ? undefined
      : (props.enableIAMDatabaseAuthentication ??
        (supportsIam ? false : undefined)),
    deletionProtection: clusterOwned
      ? undefined
      : (props.deletionProtection ?? false),
    networkType: clusterOwned ? undefined : (props.networkType ?? "IPV4"),
    logExports: clusterOwned
      ? undefined
      : (props.enableCloudwatchLogsExports ?? (custom ? undefined : [])),
  };
};

type SecurityConfiguration = ReturnType<typeof securityConfiguration>;

const pendingLogExports = (instance: rds.DBInstance) =>
  instance.PendingModifiedValues?.PendingCloudwatchLogsExports;

const effectiveLogExports = (instance: rds.DBInstance) => {
  const exports = new Set(instance.EnabledCloudwatchLogsExports ?? []);
  for (const log of pendingLogExports(instance)?.LogTypesToDisable ?? []) {
    exports.delete(log);
  }
  for (const log of pendingLogExports(instance)?.LogTypesToEnable ?? []) {
    exports.add(log);
  }
  return [...exports];
};

const iamConverged = (
  desired: SecurityConfiguration,
  instance: rds.DBInstance,
) =>
  desired.iamAuthentication === undefined ||
  (desired.iamAuthentication === instance.IAMDatabaseAuthenticationEnabled &&
    instance.PendingModifiedValues?.IAMDatabaseAuthenticationEnabled ===
      undefined);

const securityConverged = (
  desired: SecurityConfiguration,
  instance: rds.DBInstance,
) =>
  iamConverged(desired, instance) &&
  (desired.publiclyAccessible === undefined ||
    desired.publiclyAccessible === instance.PubliclyAccessible) &&
  (desired.deletionProtection === undefined ||
    desired.deletionProtection === instance.DeletionProtection) &&
  (desired.networkType === undefined ||
    desired.networkType === instance.NetworkType) &&
  (desired.logExports === undefined ||
    (sameMembers(
      desired.logExports,
      instance.EnabledCloudwatchLogsExports ?? [],
    ) &&
      (pendingLogExports(instance)?.LogTypesToEnable?.length ?? 0) === 0 &&
      (pendingLogExports(instance)?.LogTypesToDisable?.length ?? 0) === 0));

class DBInstanceSecurityPending extends Data.TaggedError(
  "DBInstanceSecurityPending",
)<{ instanceId: string }> {
  override get message() {
    return `DB instance '${this.instanceId}' security configuration did not converge`;
  }
}

class InvalidDBInstanceAssociations extends Data.TaggedError(
  "InvalidDBInstanceAssociations",
)<{
  message: string;
}> {}

const resolveAssociations = Effect.fn(function* (
  props: DBInstanceProps,
  observed?: rds.DBInstance,
) {
  const clusterIdentifier =
    props.dbClusterIdentifier ?? observed?.DBClusterIdentifier;
  const clusterOwned = clusterOwnsConfiguration(props, observed);
  const aurora =
    props.engine.startsWith("aurora") ||
    observed?.Engine?.startsWith("aurora") === true;
  const custom = props.engine.startsWith("custom-");
  if (clusterOwned && !aurora) {
    if (props.dbParameterGroupName !== undefined) {
      return yield* new InvalidDBInstanceAssociations({
        message: "Multi-AZ DB cluster associations are managed on the cluster",
      });
    }
    return { dbParameterGroupName: undefined, vpcSecurityGroupIds: undefined };
  }
  if (
    props.engine.startsWith("db2-") &&
    props.dbParameterGroupName === undefined &&
    (props.licenseModel ??
      observed?.LicenseModel ??
      "bring-your-own-license") === "bring-your-own-license"
  ) {
    return yield* new InvalidDBInstanceAssociations({
      message:
        "Db2 BYOL requires an explicit parameter group with IBM licensing IDs",
    });
  }
  let dbParameterGroupName = props.dbParameterGroupName;
  if (custom && dbParameterGroupName !== undefined) {
    return yield* new InvalidDBInstanceAssociations({
      message: "RDS Custom does not support DB parameter-group associations",
    });
  }
  if (!custom && dbParameterGroupName === undefined) {
    let engineVersion = props.engineVersion ?? observed?.EngineVersion;
    if (clusterIdentifier !== undefined) {
      engineVersion = (yield* rds.describeDBClusters({
        DBClusterIdentifier: clusterIdentifier,
      })).DBClusters?.[0]?.EngineVersion;
      if (!engineVersion) {
        return yield* new InvalidDBInstanceAssociations({
          message: "The DB cluster did not return an engine version",
        });
      }
    }
    const pages = yield* rds.describeDBEngineVersions
      .pages({
        Engine: props.engine,
        EngineVersion: engineVersion,
        DefaultOnly: engineVersion === undefined ? true : undefined,
        IncludeAll: engineVersion !== undefined ? true : undefined,
      })
      .pipe(Stream.runCollect);
    const families = new Set(
      pages.flatMap((page) =>
        (page.DBEngineVersions ?? []).map(
          (version) => version.DBParameterGroupFamily,
        ),
      ),
    );
    const family = [...families][0];
    if (families.size !== 1 || !family) {
      return yield* new InvalidDBInstanceAssociations({
        message:
          "No unambiguous DB parameter group family; declare engineVersion or dbParameterGroupName",
      });
    }
    dbParameterGroupName = `default.${family}`;
  }
  if (clusterOwned)
    return { dbParameterGroupName, vpcSecurityGroupIds: undefined };
  let vpcSecurityGroupIds = props.vpcSecurityGroupIds;
  if (vpcSecurityGroupIds === undefined) {
    const vpcId =
      props.dbSubnetGroupName !== undefined
        ? (yield* rds.describeDBSubnetGroups({
            DBSubnetGroupName: props.dbSubnetGroupName,
          })).DBSubnetGroups?.[0]?.VpcId
        : (observed?.DBSubnetGroup?.VpcId ??
          (yield* ec2.describeVpcs({
            Filters: [{ Name: "is-default", Values: ["true"] }],
          })).Vpcs?.[0]?.VpcId);
    if (!vpcId) {
      return yield* new InvalidDBInstanceAssociations({
        message:
          "No VPC found for the DB instance; declare dbSubnetGroupName or provide a default VPC",
      });
    }
    const groups = yield* ec2.describeSecurityGroups({
      Filters: [
        { Name: "vpc-id", Values: [vpcId] },
        { Name: "group-name", Values: ["default"] },
      ],
    });
    vpcSecurityGroupIds = (groups.SecurityGroups ?? []).flatMap((group) =>
      group.GroupId ? [group.GroupId] : [],
    );
    if (vpcSecurityGroupIds.length !== 1) {
      return yield* new InvalidDBInstanceAssociations({
        message: `Expected one default security group in VPC '${vpcId}'`,
      });
    }
  }
  if (vpcSecurityGroupIds.length === 0) {
    return yield* new InvalidDBInstanceAssociations({
      message:
        "At least one VPC security group is required; omit vpcSecurityGroupIds to select the VPC default group",
    });
  }
  return {
    dbParameterGroupName,
    vpcSecurityGroupIds: [...new Set(vpcSecurityGroupIds)],
  };
});

type Associations = Effect.Success<ReturnType<typeof resolveAssociations>>;

const parameterGroupMatches = (
  desired: Associations,
  instance: rds.DBInstance,
) =>
  desired.dbParameterGroupName === undefined ||
  sameMembers(
    [desired.dbParameterGroupName],
    (instance.DBParameterGroups ?? []).map(
      (group) => group.DBParameterGroupName,
    ),
  );

const securityGroupsMatch = (desired: Associations, instance: rds.DBInstance) =>
  desired.vpcSecurityGroupIds === undefined ||
  sameMembers(
    desired.vpcSecurityGroupIds,
    (instance.VpcSecurityGroups ?? []).map((group) => group.VpcSecurityGroupId),
  );

const associationsConverged = (
  desired: Associations,
  instance: rds.DBInstance,
) =>
  parameterGroupMatches(desired, instance) &&
  (desired.dbParameterGroupName === undefined ||
    (instance.DBParameterGroups ?? []).every(
      (group) =>
        group.ParameterApplyStatus === "in-sync" ||
        group.ParameterApplyStatus === "pending-reboot",
    )) &&
  securityGroupsMatch(desired, instance) &&
  (desired.vpcSecurityGroupIds === undefined ||
    (instance.VpcSecurityGroups ?? []).every(
      (group) => group.Status === "active",
    ));

class InvalidDBInstancePort extends Data.TaggedError("InvalidDBInstancePort")<{
  message: string;
}> {}

const desiredInstancePort = Effect.fn(function* (
  props: DBInstanceProps,
  observed?: rds.DBInstance,
) {
  if (clusterOwnsConfiguration(props, observed)) {
    return undefined;
  }
  if (props.port !== undefined) {
    if (
      !Number.isInteger(props.port) ||
      props.port < 1150 ||
      props.port > 65535
    ) {
      return yield* new InvalidDBInstancePort({
        message: "port must be an integer between 1150 and 65535",
      });
    }
    return props.port;
  }
  if (props.engine === "postgres") return 5432;
  if (props.engine === "mysql" || props.engine === "mariadb") return 3306;
  if (
    props.engine.startsWith("oracle-") ||
    props.engine.startsWith("custom-oracle-")
  )
    return 1521;
  if (
    props.engine.startsWith("sqlserver-") ||
    props.engine.startsWith("custom-sqlserver-")
  )
    return 1433;
  if (props.engine.startsWith("db2-")) return 50000;
  return yield* new InvalidDBInstancePort({
    message: `Declare port explicitly for engine '${props.engine}'`,
  });
});

const portConverged = (instance: rds.DBInstance, port: number | undefined) =>
  port === undefined ||
  (instance.Endpoint?.Port === port &&
    instance.PendingModifiedValues?.Port === undefined);

class InvalidDBInstanceStorage extends Data.TaggedError(
  "InvalidDBInstanceStorage",
)<{ message: string }> {}

type StorageRequest = Required<
  Pick<rds.CreateDBInstanceMessage, "AllocatedStorage" | "StorageType">
> &
  Pick<rds.CreateDBInstanceMessage, "Iops" | "StorageThroughput">;

interface DesiredStorage {
  request: StorageRequest;
  iops: number;
  throughput: number;
}

const resolveStorage = Effect.fn(function* (
  props: DBInstanceProps,
  allocatedFloor = 0,
) {
  if (props.dbClusterIdentifier || props.engine.startsWith("aurora")) {
    if (
      props.allocatedStorage !== undefined ||
      props.storageType !== undefined ||
      props.iops !== undefined ||
      props.storageThroughput !== undefined
    ) {
      return yield* new InvalidDBInstanceStorage({
        message: "Configure cluster-owned storage on DBCluster, not DBInstance",
      });
    }
    return undefined;
  }
  const sqlServer = props.engine.includes("sqlserver-");
  const oracle = props.engine.includes("oracle-");
  const storageType = props.storageType ?? "gp3";
  const provisioned = storageType === "io1" || storageType === "io2";
  if (
    !["standard", "gp2", "gp3", "io1", "io2"].includes(storageType) ||
    (storageType === "standard" && allocatedFloor === 0) ||
    (storageType === "gp2" && props.engine.startsWith("db2-"))
  ) {
    return yield* new InvalidDBInstanceStorage({
      message: `Storage type '${storageType}' is not supported for '${props.engine}'`,
    });
  }
  const custom = props.engine.startsWith("custom-");
  const minimum = custom
    ? 40
    : sqlServer
      ? 20
      : provisioned
        ? 100
        : storageType === "standard"
          ? 5
          : 20;
  const requested =
    props.allocatedStorage ?? (provisioned ? 100 : custom ? 40 : 20);
  if (!Number.isInteger(requested) || requested <= 0) {
    return yield* new InvalidDBInstanceStorage({
      message: "allocatedStorage must be a positive integer",
    });
  }
  // An in-place increase must be at least ten percent of the current allocation.
  const allocation =
    requested > allocatedFloor && allocatedFloor > 0
      ? Math.max(requested, Math.ceil((allocatedFloor * 11) / 10))
      : Math.max(requested, allocatedFloor);
  if (allocation < minimum) {
    return yield* new InvalidDBInstanceStorage({
      message: `Effective allocated storage must be at least ${minimum} GiB for ${storageType}`,
    });
  }
  const ratioCapacity = Math.max(allocation, props.maxAllocatedStorage ?? 0);
  if (storageType !== "gp3") {
    if (
      props.storageThroughput !== undefined ||
      (!provisioned && props.iops !== undefined)
    ) {
      return yield* new InvalidDBInstanceStorage({
        message: `${storageType} does not support the declared IOPS/throughput settings`,
      });
    }
    const minimumIops = provisioned
      ? Math.max(
          1000,
          Math.ceil(
            ratioCapacity * (sqlServer && storageType === "io1" ? 1 : 0.5),
          ),
        )
      : 0;
    const iops = props.iops ?? minimumIops;
    const maximumIops = allocation * (storageType === "io1" ? 50 : 1000);
    if (
      provisioned &&
      (!Number.isInteger(iops) || iops < minimumIops || iops > maximumIops)
    ) {
      return yield* new InvalidDBInstanceStorage({
        message: `The allocation and autoscaling limit require ${storageType} IOPS between ${minimumIops} and ${maximumIops}`,
      });
    }
    return {
      request: {
        AllocatedStorage: allocation,
        StorageType: storageType,
        Iops: provisioned ? iops : undefined,
      },
      iops,
      throughput: 0,
    } satisfies DesiredStorage;
  }
  const striped = !sqlServer && allocation >= (oracle ? 200 : 400);
  const configurable = sqlServer || striped;
  const baselineIops = striped ? 12000 : 3000;
  const baselineThroughput = striped ? 500 : 125;
  const minimumIops = Math.max(
    baselineIops,
    sqlServer ? Math.ceil(ratioCapacity * 0.5) : 0,
    (props.storageThroughput ?? baselineThroughput) * 4,
  );
  const iops = props.iops ?? minimumIops;
  const minimumThroughput = Math.max(
    baselineThroughput,
    ["mysql", "mariadb"].includes(props.engine) ? Math.ceil(iops / 64) : 0,
  );
  const throughput = props.storageThroughput ?? minimumThroughput;
  if (
    !Number.isInteger(iops) ||
    iops < minimumIops ||
    !Number.isInteger(throughput) ||
    throughput < minimumThroughput ||
    throughput > iops * 0.25 ||
    (!configurable &&
      (iops !== baselineIops || throughput !== baselineThroughput))
  ) {
    return yield* new InvalidDBInstanceStorage({
      message: configurable
        ? `gp3 requires at least ${minimumIops} IOPS and ${minimumThroughput} MiBps, with throughput <= IOPS / 4`
        : `Small ${props.engine} gp3 storage has fixed 3000 IOPS and 125 MiBps`,
    });
  }
  return {
    request: {
      AllocatedStorage: allocation,
      StorageType: storageType,
      Iops: configurable ? iops : undefined,
      StorageThroughput: configurable ? throughput : undefined,
    },
    iops,
    throughput,
  } satisfies DesiredStorage;
});

const hasPendingStorage = (instance: rds.DBInstance) =>
  instance.PendingModifiedValues?.AllocatedStorage !== undefined ||
  instance.PendingModifiedValues?.StorageType !== undefined ||
  instance.PendingModifiedValues?.Iops !== undefined ||
  instance.PendingModifiedValues?.StorageThroughput !== undefined;

const storageConverged = (
  observed: rds.DBInstance,
  desired: DesiredStorage | undefined,
): boolean =>
  desired === undefined ||
  ((observed.AllocatedStorage ?? 0) >= desired.request.AllocatedStorage &&
    observed.StorageType === desired.request.StorageType &&
    (observed.Iops ?? 0) === desired.iops &&
    (observed.StorageThroughput ?? 0) === desired.throughput &&
    !hasPendingStorage(observed));

const toStorageConfiguration = Effect.fn(function* (props: DBInstanceProps) {
  const supportsAutoscaling =
    props.dbClusterIdentifier === undefined &&
    !props.engine.startsWith("aurora") &&
    !props.engine.startsWith("custom-");
  if (!supportsAutoscaling && props.maxAllocatedStorage !== undefined) {
    return yield* new InvalidDBInstanceStorage({
      message:
        "maxAllocatedStorage is not supported for cluster members or RDS Custom",
    });
  }
  const maxAllocatedStorage = supportsAutoscaling
    ? (props.maxAllocatedStorage ?? 0)
    : undefined;
  if (
    maxAllocatedStorage !== undefined &&
    (!Number.isInteger(maxAllocatedStorage) || maxAllocatedStorage < 0)
  ) {
    return yield* new InvalidDBInstanceStorage({
      message: "maxAllocatedStorage must be a nonnegative integer in GiB",
    });
  }
  return {
    allocatedStorage:
      props.dbClusterIdentifier === undefined
        ? props.allocatedStorage
        : undefined,
    maxAllocatedStorage,
  };
});

type StorageConfiguration = Effect.Success<
  ReturnType<typeof toStorageConfiguration>
>;

const allocationConverged = (
  desired: StorageConfiguration,
  observed: rds.DBInstance,
) =>
  desired.allocatedStorage === undefined ||
  (observed.AllocatedStorage !== undefined &&
    observed.AllocatedStorage >= desired.allocatedStorage);

const autoscalingConverged = (
  desired: StorageConfiguration,
  observed: rds.DBInstance,
) => {
  const ceiling = desired.maxAllocatedStorage;
  if (ceiling === undefined) return true;
  // RDS reports disabled autoscaling as zero; equality also prevents growth.
  if (ceiling === 0 || ceiling === observed.AllocatedStorage) {
    return (
      (observed.MaxAllocatedStorage ?? 0) === 0 ||
      observed.MaxAllocatedStorage === observed.AllocatedStorage
    );
  }
  return ceiling === observed.MaxAllocatedStorage;
};

class InvalidDBInstanceSecretPolicy extends Data.TaggedError(
  "InvalidDBInstanceSecretPolicy",
)<{ message: string }> {}

class DBInstanceManagedSecretMissing extends Data.TaggedError(
  "DBInstanceManagedSecretMissing",
)<{ instanceId: string }> {
  override get message() {
    return `DB instance '${this.instanceId}' has no RDS-managed master secret for its resource policy`;
  }
}

class DBInstanceSecretPolicyPending extends Data.TaggedError(
  "DBInstanceSecretPolicyPending",
)<{ instanceId: string }> {
  override get message() {
    return `DB instance '${this.instanceId}' managed-secret resource policy has not propagated`;
  }
}

class DBInstancePending extends Data.TaggedError("DBInstancePending")<{
  instanceId: string;
  status: string | undefined;
}> {
  override get message() {
    return `DB instance '${this.instanceId}' is not ready (status: ${this.status ?? "not yet visible"})`;
  }
}

class DBInstanceReadinessBlocked extends Data.TaggedError(
  "DBInstanceReadinessBlocked",
)<{
  instanceId: string;
  status: string;
}> {
  override get message() {
    return `DB instance '${this.instanceId}' requires intervention (status: ${this.status})`;
  }
}

const blockedStatuses = new Set([
  "automation-paused",
  "delete-precheck",
  "deleted",
  "deleting",
  "failed",
  "inaccessible-encryption-credentials",
  "inaccessible-encryption-credentials-recoverable",
  "incompatible-create",
  "incompatible-network",
  "incompatible-option-group",
  "incompatible-parameters",
  "incompatible-restore",
  "insufficient-capacity",
  "restore-error",
  "stopped",
  "stopping",
  "storage-full",
  "unsupported-configuration",
  "upgrade-failed",
]);

const instanceReady = (
  instance: rds.DBInstance | undefined,
): instance is rds.DBInstance & { DBInstanceArn: string } =>
  !!instance?.DBInstanceArn &&
  (instance.DBInstanceStatus === "available" ||
    instance.DBInstanceStatus === "storage-optimization");

export const DBInstanceProvider = () =>
  Provider.effect(
    DBInstance,
    Effect.gen(function* () {
      const toIdentifier = (id: string, props: DBInstanceProps) =>
        props.dbInstanceIdentifier
          ? Effect.succeed(props.dbInstanceIdentifier)
          : createPhysicalName({ id, maxLength: 63 });

      const readInstance = Effect.fn(function* (instanceId: string) {
        const response = yield* rds
          .describeDBInstances({
            DBInstanceIdentifier: instanceId,
          })
          .pipe(
            Effect.catchTag("DBInstanceNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBInstances?.[0];
      });

      const observeReadiness = Effect.fn(function* (instanceId: string) {
        const instance = yield* readInstance(instanceId);
        const status = instance?.DBInstanceStatus;
        if (status !== undefined && blockedStatuses.has(status)) {
          return yield* new DBInstanceReadinessBlocked({ instanceId, status });
        }
        return instance;
      });

      // Storage optimization is online; provisioning retains its ten-minute budget.
      const waitForInstance = Effect.fn(function* (instanceId: string) {
        return yield* observeReadiness(instanceId).pipe(
          Effect.flatMap((instance) =>
            instanceReady(instance)
              ? Effect.succeed(instance)
              : Effect.fail(
                  new DBInstancePending({
                    instanceId,
                    status: instance?.DBInstanceStatus,
                  }),
                ),
          ),
          Effect.retry({
            while: (error) => error._tag === "DBInstancePending",
            schedule: Schedule.max([
              Schedule.fixed("10 seconds"),
              Schedule.recurs(60),
            ]),
          }),
        );
      });

      const waitForSecurity = Effect.fn(function* (
        instanceId: string,
        desired: SecurityConfiguration,
      ) {
        const instance = yield* observeReadiness(instanceId).pipe(
          Effect.repeat({
            schedule: Schedule.min([
              Schedule.exponential("5 seconds"),
              Schedule.spaced("1 minute"),
            ]),
            times: 10,
            until: (instance) =>
              instanceReady(instance) && securityConverged(desired, instance),
          }),
        );
        if (!instanceReady(instance) || !securityConverged(desired, instance)) {
          return yield* new DBInstanceSecurityPending({ instanceId });
        }
        return instance;
      });

      const waitForAssociations = Effect.fn(function* (
        instanceId: string,
        desired: Associations,
      ) {
        const instance = yield* observeReadiness(instanceId).pipe(
          Effect.flatMap((instance) =>
            instance?.DBParameterGroups?.some(
              (group) => group.ParameterApplyStatus === "failed-to-apply",
            )
              ? Effect.fail(
                  new InvalidDBInstanceAssociations({
                    message: `DB instance '${instanceId}' parameter group failed to apply`,
                  }),
                )
              : Effect.succeed(instance),
          ),
          Effect.repeat({
            schedule: Schedule.min([
              Schedule.exponential("5 seconds"),
              Schedule.spaced("1 minute"),
            ]),
            times: 10,
            until: (instance) =>
              instanceReady(instance) &&
              associationsConverged(desired, instance),
          }),
        );
        if (
          !instanceReady(instance) ||
          !associationsConverged(desired, instance)
        ) {
          return yield* new InvalidDBInstanceAssociations({
            message: `DB instance '${instanceId}' associations did not converge`,
          });
        }
        return instance;
      });

      const waitForPort = Effect.fn(function* (
        instanceId: string,
        port: number,
      ) {
        const instance = yield* observeReadiness(instanceId).pipe(
          Effect.repeat({
            schedule: Schedule.min([
              Schedule.exponential("5 seconds"),
              Schedule.spaced("1 minute"),
            ]),
            times: 10,
            until: (instance) =>
              instanceReady(instance) && portConverged(instance, port),
          }),
        );
        if (!instanceReady(instance) || !portConverged(instance, port)) {
          return yield* new InvalidDBInstancePort({
            message: `DB instance '${instanceId}' listener did not converge (status: ${instance?.DBInstanceStatus}, desired: ${port}, observed: ${instance?.Endpoint?.Port}, pending: ${instance?.PendingModifiedValues?.Port})`,
          });
        }
        return instance;
      });

      const waitForStorage = Effect.fn(function* (
        instanceId: string,
        converged: (instance: rds.DBInstance) => boolean,
      ) {
        // RDS can remain available while an accepted storage resize is pending.
        const instance = yield* observeReadiness(instanceId).pipe(
          Effect.repeat({
            schedule: Schedule.min([
              Schedule.exponential("5 seconds"),
              Schedule.spaced("1 minute"),
            ]),
            times: 10,
            until: (instance) => instanceReady(instance) && converged(instance),
          }),
        );
        if (!instanceReady(instance) || !converged(instance)) {
          return yield* new InvalidDBInstanceStorage({
            message: `DB instance '${instanceId}' storage did not converge (status: ${instance?.DBInstanceStatus}, allocated: ${instance?.AllocatedStorage}, maximum: ${instance?.MaxAllocatedStorage}, pending allocation: ${instance?.PendingModifiedValues?.AllocatedStorage})`,
          });
        }
        return instance;
      });

      const validateMasterSecretPolicy = Effect.fn(function* (
        policy: PolicyDocument | undefined,
      ) {
        if (policy === undefined) return;
        const validation = yield* secretsmanager.validateResourcePolicy({
          ResourcePolicy: stringifyPolicyDocument(policy),
        });
        if (validation.PolicyValidationPassed !== true) {
          return yield* new InvalidDBInstanceSecretPolicy({
            message: `Managed-secret resource policy validation failed: ${(validation.ValidationErrors ?? []).map((error) => `${error.CheckName}: ${error.ErrorMessage}`).join("; ")}`,
          });
        }
      });

      const readMasterSecretPolicy = Effect.fn(function* (secretArn: string) {
        const observed = yield* secretsmanager.getResourcePolicy({
          SecretId: secretArn,
        });
        return observed.ResourcePolicy === undefined
          ? undefined
          : normalizePolicyDocument(observed.ResourcePolicy);
      });

      const readObservedSecretPolicy = (instance: rds.DBInstance) =>
        instance.MasterUserSecret?.SecretArn === undefined ||
        instance.DBClusterIdentifier !== undefined
          ? Effect.succeed(undefined)
          : readMasterSecretPolicy(instance.MasterUserSecret.SecretArn).pipe(
              Effect.retry({
                while: (error) => error._tag === "ResourceNotFoundException",
                schedule: Schedule.fixed("5 seconds"),
                times: 10,
              }),
            );

      const reconcileMasterSecretPolicy = Effect.fn(function* (
        instanceId: string,
        instance: rds.DBInstance,
        policy: PolicyDocument | undefined,
      ) {
        if (instance.DBClusterIdentifier !== undefined) {
          return { instance, policy: undefined };
        }
        if (
          instance.MasterUserSecret?.SecretArn === undefined &&
          policy !== undefined
        ) {
          instance = yield* readInstance(instanceId).pipe(
            Effect.flatMap((current) =>
              current?.MasterUserSecret?.SecretArn === undefined
                ? Effect.fail(
                    new DBInstanceManagedSecretMissing({ instanceId }),
                  )
                : Effect.succeed(current),
            ),
            Effect.retry({
              while: (error) => error._tag === "DBInstanceManagedSecretMissing",
              schedule: Schedule.fixed("5 seconds"),
              times: 10,
            }),
          );
        }
        const secretArn = instance.MasterUserSecret?.SecretArn;
        if (secretArn === undefined) return { instance, policy: undefined };
        const desired =
          policy === undefined ? undefined : normalizePolicyDocument(policy);
        const observed = yield* readObservedSecretPolicy(instance);
        if (observed === desired) return { instance, policy: observed };
        const writePolicy =
          policy === undefined
            ? secretsmanager.deleteResourcePolicy({ SecretId: secretArn })
            : secretsmanager.putResourcePolicy({
                SecretId: secretArn,
                ResourcePolicy: stringifyPolicyDocument(policy),
                BlockPublicPolicy: true,
              });
        yield* writePolicy.pipe(
          Effect.retry({
            while: (error) => error._tag === "ResourceNotFoundException",
            schedule: Schedule.fixed("5 seconds"),
            times: 10,
          }),
        );
        // A missing secret is not evidence that its policy has been removed.
        const applied = yield* readMasterSecretPolicy(secretArn).pipe(
          Effect.flatMap((actual) =>
            actual === desired
              ? Effect.succeed(actual)
              : Effect.fail(new DBInstanceSecretPolicyPending({ instanceId })),
          ),
          Effect.retry({
            while: (error) =>
              error._tag === "DBInstanceSecretPolicyPending" ||
              error._tag === "ResourceNotFoundException",
            schedule: Schedule.fixed("5 seconds"),
            times: 10,
          }),
        );
        return { instance, policy: applied };
      });

      return {
        stables: ["dbInstanceArn", "dbInstanceIdentifier"],
        // Pattern (a) AWS account/region collection: `describeDBInstances` is
        // paginated (items: "DBInstances") and returns each instance's
        // `TagList` inline, so we hydrate directly into the same shape `read`
        // produces — no per-item tag fetch needed. An empty/no-instances
        // account simply yields no pages. `DBInstanceNotFoundFault` is in the
        // op's typed error union; treat a stray one as "nothing to list".
        list: () =>
          rds.describeDBInstances.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.DBInstances ?? [])
                  .filter(
                    (
                      instance,
                    ): instance is typeof instance & {
                      DBInstanceArn: string;
                    } => instance.DBInstanceArn != null,
                  )
                  .map((instance) =>
                    toAttrs({
                      instance,
                      tags: toTagRecord(instance.TagList),
                    }),
                  ),
              ),
            ),
            Effect.catchTag("DBInstanceNotFoundFault", () =>
              Effect.succeed([] as DBInstance["Attributes"][]),
            ),
          ),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          yield* validateMasterSecretPolicy(
            news.masterUserSecretResourcePolicy,
          );
          if (
            (yield* toIdentifier(id, olds ?? ({} as DBInstanceProps))) !==
            (yield* toIdentifier(id, news))
          ) {
            return { action: "replace" } as const;
          }
          // Immutable props — any change forces a fresh instance.
          if (
            olds !== undefined &&
            (olds.engine !== news.engine ||
              olds.dbName !== news.dbName ||
              olds.masterUsername !== news.masterUsername ||
              olds.availabilityZone !== news.availabilityZone ||
              olds.storageEncrypted !== news.storageEncrypted ||
              olds.kmsKeyId !== news.kmsKeyId ||
              olds.dbSubnetGroupName !== news.dbSubnetGroupName)
          ) {
            return { action: "replace" } as const;
          }
          const storage = yield* toStorageConfiguration(news);
          if (output !== undefined) {
            const instance = yield* readInstance(output.dbInstanceIdentifier);
            if (!instance?.DBInstanceArn) {
              return { action: "update", stables: [] } as const;
            }
            if (!instanceReady(instance)) {
              return { action: "update" } as const;
            }
            const port = yield* desiredInstancePort(news, instance);
            const associations = yield* resolveAssociations(news, instance);
            const desiredStorage = yield* resolveStorage(
              news,
              instance.AllocatedStorage,
            );
            if (
              !storageConverged(instance, desiredStorage) ||
              !autoscalingConverged(storage, instance) ||
              !portConverged(instance, port) ||
              !associationsConverged(associations, instance) ||
              !securityConverged(
                securityConfiguration(news, instance),
                instance,
              ) ||
              !Object.hasOwn(output, "vpcSecurityGroupStatuses") ||
              (news.masterUserSecretResourcePolicy !== undefined &&
                instance.MasterUserSecret?.SecretArn === undefined) ||
              (news.masterUserSecretResourcePolicy === undefined
                ? undefined
                : normalizePolicyDocument(
                    news.masterUserSecretResourcePolicy,
                  )) !== (yield* readObservedSecretPolicy(instance))
            ) {
              return { action: "update" } as const;
            }
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbInstanceIdentifier ??
            (yield* toIdentifier(
              id,
              olds ?? { dbInstanceClass: "", engine: "" },
            ));
          const instance = yield* readInstance(identifier);
          if (!instance?.DBInstanceArn) {
            return undefined;
          }
          return toAttrs({
            instance,
            tags: toTagRecord(instance.TagList),
            // Not observable from AWS — carry the stored deletion behavior
            // and last-sent fingerprint forward so a refresh drops neither.
            skipFinalSnapshot: output?.skipFinalSnapshot,
            finalDBSnapshotIdentifier: output?.finalDBSnapshotIdentifier,
            masterUserPasswordFingerprint:
              output?.masterUserPasswordFingerprint,
            masterUserSecretResourcePolicy:
              yield* readObservedSecretPolicy(instance),
          });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          yield* validateMasterSecretPolicy(
            news.masterUserSecretResourcePolicy,
          );
          const identifier =
            output?.dbInstanceIdentifier ?? (yield* toIdentifier(id, news));
          // AWS never returns the master password, so there is nothing to
          // observe-and-diff — fingerprint the configured value instead and
          // only send `MasterUserPassword` when the fingerprint changed.
          // Without this, every reconcile of an instance whose props carry a
          // password triggers a live `resetting-master-credentials` modify.
          // The hash is salted with the (stable) instance identifier so the
          // persisted digest is not rainbow-table-lookupable, and kept
          // `Redacted` so it never leaks in plaintext through state/logs.
          const passwordFingerprint =
            news.masterUserPassword !== undefined
              ? Redacted.make(
                  yield* sha256(
                    `${identifier}:${Redacted.value(news.masterUserPassword)}`,
                  ),
                )
              : undefined;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          // Duration props → the exact wire units the RDS API expects.
          const backupRetentionDays = toWireDays(news.backupRetentionPeriod);
          const performanceInsightsRetentionDays = toWireDays(
            news.performanceInsightsRetentionPeriod,
          );
          const monitoringIntervalSeconds = toWireSeconds(
            news.monitoringInterval,
          );

          const storage = yield* toStorageConfiguration(news);
          // Observe — fetch live instance state.
          let observed = yield* observeReadiness(identifier);
          if (observed?.DBInstanceArn) {
            observed = yield* waitForInstance(identifier);
          }
          if (
            news.masterUserSecretResourcePolicy !== undefined &&
            (news.dbClusterIdentifier !== undefined ||
              news.engine.startsWith("custom-") ||
              observed?.DBClusterIdentifier !== undefined ||
              news.manageMasterUserPassword === false ||
              (!observed?.MasterUserSecret?.SecretArn &&
                !news.manageMasterUserPassword))
          ) {
            return yield* new InvalidDBInstanceSecretPolicy({
              message:
                "A master secret resource policy requires an instance-managed secret; enable manageMasterUserPassword on a standalone DBInstance",
            });
          }
          let security = securityConfiguration(news, observed);
          let port = yield* desiredInstancePort(news, observed);
          let associations = yield* resolveAssociations(news, observed);
          let desiredStorage = yield* resolveStorage(
            news,
            observed?.AllocatedStorage,
          );

          // Ensure — create if missing. Tolerate
          // `DBInstanceAlreadyExistsFault` as a race with a peer reconciler.
          let created = false;
          if (!observed?.DBInstanceArn) {
            created = yield* rds
              .createDBInstance({
                DBInstanceIdentifier: identifier,
                DBClusterIdentifier: news.dbClusterIdentifier,
                DBInstanceClass: news.dbInstanceClass,
                Engine: news.engine,
                EngineVersion: news.engineVersion,
                DBName: news.dbName,
                ...desiredStorage?.request,
                // Omission at creation leaves autoscaling disabled.
                MaxAllocatedStorage: storage.maxAllocatedStorage || undefined,
                MasterUsername: news.masterUsername,
                MasterUserPassword: news.masterUserPassword,
                ManageMasterUserPassword: news.manageMasterUserPassword,
                MasterUserSecretKmsKeyId: news.masterUserSecretKmsKeyId,
                Port: port,
                MultiAZ: news.multiAZ,
                AvailabilityZone: news.availabilityZone,
                BackupRetentionPeriod: backupRetentionDays,
                PreferredBackupWindow: news.preferredBackupWindow,
                PreferredMaintenanceWindow: news.preferredMaintenanceWindow,
                DBSubnetGroupName: news.dbSubnetGroupName,
                DBParameterGroupName: associations.dbParameterGroupName,
                OptionGroupName: news.optionGroupName,
                LicenseModel: news.licenseModel,
                StorageEncrypted: news.storageEncrypted,
                KmsKeyId: news.kmsKeyId,
                CACertificateIdentifier: news.caCertificateIdentifier,
                EnableIAMDatabaseAuthentication: security.iamAuthentication,
                EnablePerformanceInsights: news.enablePerformanceInsights,
                PerformanceInsightsKMSKeyId: news.performanceInsightsKMSKeyId,
                PerformanceInsightsRetentionPeriod:
                  performanceInsightsRetentionDays,
                MonitoringInterval: monitoringIntervalSeconds,
                MonitoringRoleArn: news.monitoringRoleArn,
                EnableCloudwatchLogsExports: security.logExports,
                DeletionProtection: security.deletionProtection,
                NetworkType: security.networkType,
                VpcSecurityGroupIds: associations.vpcSecurityGroupIds,
                PubliclyAccessible: security.publiclyAccessible,
                PromotionTier: news.promotionTier,
                AutoMinorVersionUpgrade: news.autoMinorVersionUpgrade,
                CopyTagsToSnapshot: news.copyTagsToSnapshot,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.as(true),
                Effect.catchTag("DBInstanceAlreadyExistsFault", () =>
                  Effect.succeed(false),
                ),
              );

            observed = yield* waitForInstance(identifier);
          }
          if (!created) {
            if (hasPendingStorage(observed)) {
              observed = yield* waitForStorage(
                identifier,
                (instance) => !hasPendingStorage(instance),
              );
            }
            desiredStorage = yield* resolveStorage(
              news,
              observed.AllocatedStorage,
            );

            associations = yield* resolveAssociations(news, observed);

            // syncCoreSettings — single `modifyDBInstance` carrying scalar
            // in-place fields. Only emit a field when the desired value differs
            // from the observed cloud state, to avoid spurious
            // `PendingModifiedValues`. The listener port is synchronized below.
            const core: rds.ModifyDBInstanceMessage = {
              DBInstanceIdentifier: identifier,
              ApplyImmediately: true,
            };
            let coreDirty = false;
            const setIf = <K extends keyof rds.ModifyDBInstanceMessage>(
              key: K,
              desired: rds.ModifyDBInstanceMessage[K] | undefined,
              observedValue: unknown,
            ) => {
              if (desired !== undefined && desired !== observedValue) {
                core[key] = desired;
                coreDirty = true;
              }
            };
            setIf("DBInstanceClass", news.dbInstanceClass, observed.DBInstanceClass); // prettier-ignore
            setIf("EngineVersion", news.engineVersion, observed.EngineVersion);
            if (desiredStorage && !storageConverged(observed, desiredStorage)) {
              Object.assign(core, desiredStorage.request);
              core.MaxAllocatedStorage =
                storage.maxAllocatedStorage === 0
                  ? desiredStorage.request.AllocatedStorage
                  : storage.maxAllocatedStorage;
              coreDirty = true;
            }
            setIf("MultiAZ", news.multiAZ, observed.MultiAZ);
            setIf("BackupRetentionPeriod", backupRetentionDays, observed.BackupRetentionPeriod); // prettier-ignore
            setIf("PreferredBackupWindow", news.preferredBackupWindow, observed.PreferredBackupWindow); // prettier-ignore
            setIf("PreferredMaintenanceWindow", news.preferredMaintenanceWindow, observed.PreferredMaintenanceWindow); // prettier-ignore
            setIf("OptionGroupName", news.optionGroupName, undefined);
            setIf("LicenseModel", news.licenseModel, observed.LicenseModel);
            setIf("CACertificateIdentifier", news.caCertificateIdentifier, observed.CACertificateIdentifier); // prettier-ignore
            setIf("EnablePerformanceInsights", news.enablePerformanceInsights, observed.PerformanceInsightsEnabled); // prettier-ignore
            setIf("PerformanceInsightsKMSKeyId", news.performanceInsightsKMSKeyId, observed.PerformanceInsightsKMSKeyId); // prettier-ignore
            setIf("PerformanceInsightsRetentionPeriod", performanceInsightsRetentionDays, observed.PerformanceInsightsRetentionPeriod); // prettier-ignore
            setIf("MonitoringInterval", monitoringIntervalSeconds, observed.MonitoringInterval); // prettier-ignore
            setIf("MonitoringRoleArn", news.monitoringRoleArn, observed.MonitoringRoleArn); // prettier-ignore
            if (!parameterGroupMatches(associations, observed)) {
              core.DBParameterGroupName = associations.dbParameterGroupName;
              coreDirty = true;
            }
            setIf("PromotionTier", news.promotionTier, observed.PromotionTier);
            setIf("AutoMinorVersionUpgrade", news.autoMinorVersionUpgrade, observed.AutoMinorVersionUpgrade); // prettier-ignore
            setIf("CopyTagsToSnapshot", news.copyTagsToSnapshot, observed.CopyTagsToSnapshot); // prettier-ignore
            if (!securityGroupsMatch(associations, observed)) {
              if (news.engine.startsWith("custom-")) {
                return yield* new InvalidDBInstanceAssociations({
                  message:
                    "Changing existing RDS Custom security-group associations through ModifyDBInstance is not supported",
                });
              }
              core.VpcSecurityGroupIds = associations.vpcSecurityGroupIds;
              coreDirty = true;
            }
            if (news.allowMajorVersionUpgrade) {
              core.AllowMajorVersionUpgrade = true;
            }
            // syncMasterPassword — rotation or explicit password update. The
            // explicit branch is fingerprint-guarded: send only when the
            // configured password actually changed (or was never
            // fingerprinted — pre-existing state sends once, then records).
            if (
              news.manageMasterUserPassword &&
              !observed.MasterUserSecret?.SecretArn &&
              !observed.DBClusterIdentifier
            ) {
              core.ManageMasterUserPassword = true;
              core.MasterUserSecretKmsKeyId = news.masterUserSecretKmsKeyId;
              coreDirty = true;
            }
            if (
              news.manageMasterUserPassword &&
              news.rotateMasterUserPassword
            ) {
              core.RotateMasterUserPassword = true;
              coreDirty = true;
            } else if (
              news.masterUserPassword !== undefined &&
              !sameFingerprint(
                passwordFingerprint,
                output?.masterUserPasswordFingerprint,
              )
            ) {
              core.MasterUserPassword = news.masterUserPassword;
              coreDirty = true;
            }
            if (coreDirty) {
              yield* rds.modifyDBInstance(core);
              observed = yield* waitForInstance(identifier);
              if (
                core.DBParameterGroupName !== undefined ||
                core.VpcSecurityGroupIds !== undefined
              ) {
                observed = yield* waitForAssociations(identifier, associations);
              }
              if (core.AllocatedStorage !== undefined) {
                observed = yield* waitForStorage(identifier, (instance) =>
                  storageConverged(instance, desiredStorage),
                );
              }
            }
          }

          if (hasPendingStorage(observed)) {
            observed = yield* waitForStorage(
              identifier,
              (instance) => !hasPendingStorage(instance),
            );
          }
          desiredStorage = yield* resolveStorage(
            news,
            observed.AllocatedStorage,
          );
          if (desiredStorage && !storageConverged(observed, desiredStorage)) {
            yield* rds.modifyDBInstance({
              DBInstanceIdentifier: identifier,
              ...desiredStorage.request,
              MaxAllocatedStorage:
                storage.maxAllocatedStorage === 0
                  ? desiredStorage.request.AllocatedStorage
                  : storage.maxAllocatedStorage,
              ApplyImmediately: true,
            });
            observed = yield* waitForInstance(identifier);
            observed = yield* waitForStorage(identifier, (instance) =>
              storageConverged(instance, desiredStorage),
            );
          }
          if (!autoscalingConverged(storage, observed)) {
            const ceiling =
              storage.maxAllocatedStorage === 0
                ? observed.AllocatedStorage
                : storage.maxAllocatedStorage;
            if (ceiling === undefined) {
              return yield* new InvalidDBInstanceStorage({
                message:
                  "RDS did not return the allocated storage needed to disable autoscaling",
              });
            }
            // AWS disables autoscaling when the ceiling equals live allocation.
            yield* rds.modifyDBInstance({
              DBInstanceIdentifier: identifier,
              MaxAllocatedStorage: ceiling,
              ApplyImmediately: true,
            });
            observed = yield* waitForStorage(
              identifier,
              (instance) =>
                allocationConverged(storage, instance) &&
                autoscalingConverged(storage, instance),
            );
          }

          port = yield* desiredInstancePort(news, observed);
          if (port !== undefined && !portConverged(observed, port)) {
            if (observed.PendingModifiedValues?.Port !== port) {
              if (news.engine.startsWith("custom-")) {
                return yield* new InvalidDBInstancePort({
                  message:
                    "Changing an existing RDS Custom listener through ModifyDBInstance is not supported",
                });
              }
              // Port changes restart immediately without applying unrelated pending settings.
              yield* rds.modifyDBInstance({
                DBInstanceIdentifier: identifier,
                DBPortNumber: port,
                ApplyImmediately: false,
              });
            }
            observed = yield* waitForPort(identifier, port);
          }

          associations = yield* resolveAssociations(news, observed);
          if (!associationsConverged(associations, observed)) {
            const parameterChanged = !parameterGroupMatches(
              associations,
              observed,
            );
            const securityChanged = !securityGroupsMatch(
              associations,
              observed,
            );
            if (securityChanged && news.engine.startsWith("custom-")) {
              return yield* new InvalidDBInstanceAssociations({
                message:
                  "Changing existing RDS Custom security-group associations through ModifyDBInstance is not supported",
              });
            }
            if (parameterChanged || securityChanged) {
              yield* rds.modifyDBInstance({
                DBInstanceIdentifier: identifier,
                DBParameterGroupName: parameterChanged
                  ? associations.dbParameterGroupName
                  : undefined,
                VpcSecurityGroupIds: securityChanged
                  ? associations.vpcSecurityGroupIds
                  : undefined,
                ApplyImmediately: true,
              });
            }
            observed = yield* waitForAssociations(identifier, associations);
          }

          security = securityConfiguration(news, observed);
          const iamPending =
            observed.PendingModifiedValues?.IAMDatabaseAuthenticationEnabled;
          const iamChanged = !iamConverged(security, observed);
          const networkChanged =
            security.networkType !== undefined &&
            security.networkType !== observed.NetworkType;
          if (iamChanged || networkChanged) {
            // IAM and network changes honor maintenance scheduling. AWS cannot
            // selectively apply one queued change without applying the rest.
            yield* rds.modifyDBInstance({
              DBInstanceIdentifier: identifier,
              EnableIAMDatabaseAuthentication:
                iamChanged && iamPending !== security.iamAuthentication
                  ? security.iamAuthentication
                  : undefined,
              NetworkType: networkChanged ? security.networkType : undefined,
              ApplyImmediately: true,
            });
            observed = yield* waitForInstance(identifier);
          }

          const publicChanged =
            security.publiclyAccessible !== undefined &&
            security.publiclyAccessible !== observed.PubliclyAccessible;
          const protectionChanged =
            security.deletionProtection !== undefined &&
            security.deletionProtection !== observed.DeletionProtection;
          const logDelta = logExportDelta(
            effectiveLogExports(observed),
            security.logExports,
          );
          if (publicChanged || protectionChanged || logDelta) {
            // These fields apply immediately even with false; leave unrelated
            // maintenance-window changes queued rather than flushing them.
            yield* rds.modifyDBInstance({
              DBInstanceIdentifier: identifier,
              PubliclyAccessible: publicChanged
                ? security.publiclyAccessible
                : undefined,
              DeletionProtection: protectionChanged
                ? security.deletionProtection
                : undefined,
              CloudwatchLogsExportConfiguration: logDelta,
              ApplyImmediately: false,
            });
          }
          observed = yield* waitForSecurity(identifier, security);

          const dbInstanceArn = observed.DBInstanceArn ?? "";

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = toTagRecord(observed.TagList);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbInstanceArn) {
            yield* rds.addTagsToResource({
              ResourceName: dbInstanceArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbInstanceArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: dbInstanceArn,
              TagKeys: removed,
            });
          }

          const managedSecret = yield* reconcileMasterSecretPolicy(
            identifier,
            observed,
            news.masterUserSecretResourcePolicy,
          );
          yield* session.note(dbInstanceArn || identifier);
          return toAttrs({
            instance: managedSecret.instance,
            tags: desiredTags,
            skipFinalSnapshot: news.skipFinalSnapshot,
            finalDBSnapshotIdentifier: news.finalDBSnapshotIdentifier,
            masterUserPasswordFingerprint: passwordFingerprint,
            masterUserSecretResourcePolicy: managedSecret.policy,
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          // Default preserves the existing behavior (no final snapshot). When
          // the resource was declared with `skipFinalSnapshot: false`, take
          // one — timestamped by default so repeated destroy/create cycles
          // never collide on snapshot names.
          const skipFinalSnapshot = output.skipFinalSnapshot ?? true;
          const finalDBSnapshotIdentifier = skipFinalSnapshot
            ? undefined
            : (output.finalDBSnapshotIdentifier ??
              (yield* Effect.sync(
                () =>
                  `${output.dbInstanceIdentifier}-final-${new Date()
                    .toISOString()
                    .replaceAll(/[:.]/g, "-")
                    .toLowerCase()}`,
              )));
          yield* rds
            .deleteDBInstance({
              DBInstanceIdentifier: output.dbInstanceIdentifier,
              SkipFinalSnapshot: skipFinalSnapshot,
              FinalDBSnapshotIdentifier: finalDBSnapshotIdentifier,
            })
            .pipe(
              Effect.catchTag("DBInstanceNotFoundFault", () => Effect.void),
            );
          // Block until the instance is fully gone. RDS deletion is async; if we
          // return while it is still `deleting`, a dependent (e.g. a
          // DBSubnetGroup or VPC) is torn down next and AWS rejects it with
          // `InvalidDBSubnetGroupStateFault: ... still using it`.
          yield* Effect.repeat(
            rds
              .describeDBInstances({
                DBInstanceIdentifier: output.dbInstanceIdentifier,
              })
              .pipe(
                Effect.as(true),
                Effect.catchTag("DBInstanceNotFoundFault", () =>
                  Effect.succeed(false),
                ),
              ),
            {
              schedule: Schedule.max([
                Schedule.fixed("15 seconds"),
                // A final snapshot serializes before the delete, so give
                // that path a larger budget than the plain-delete wait.
                Schedule.recurs(skipFinalSnapshot ? 40 : 80),
              ]),
              until: (exists) => exists === false,
            },
          ).pipe(Effect.catch(() => Effect.void));
        }),
      };
    }),
  );

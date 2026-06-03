import * as rds from "@distilled.cloud/aws/rds";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBClusterProps {
  /**
   * Cluster identifier. If omitted, Alchemy generates one.
   */
  dbClusterIdentifier?: string;
  /**
   * Aurora engine, such as `aurora-postgresql`.
   */
  engine: string;
  /**
   * Optional engine version.
   */
  engineVersion?: string;
  /**
   * Optional database name created with the cluster.
   */
  databaseName?: string;
  /**
   * Subnet group used by the cluster.
   */
  dbSubnetGroupName?: string;
  /**
   * Cluster parameter group name.
   */
  dbClusterParameterGroupName?: string;
  /**
   * Security groups attached to the cluster.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Optional listener port.
   */
  port?: number;
  /**
   * Enable IAM database authentication.
   */
  enableIAMDatabaseAuthentication?: boolean;
  /**
   * Enable Aurora Data API / HTTP endpoint support.
   */
  enableHttpEndpoint?: boolean;
  /**
   * Engine mode, for example `provisioned` or `serverless`.
   */
  engineMode?: string;
  /**
   * Serverless v2 scaling configuration.
   */
  serverlessV2ScalingConfiguration?: rds.ServerlessV2ScalingConfiguration;
  /**
   * Whether to copy tags to snapshots.
   */
  copyTagsToSnapshot?: boolean;
  /**
   * Whether to block accidental deletion.
   */
  deletionProtection?: boolean;
  /**
   * Whether the storage is encrypted.
   */
  storageEncrypted?: boolean;
  /**
   * Optional KMS key used for storage encryption.
   */
  kmsKeyId?: string;
  /**
   * Let RDS manage the master user password in Secrets Manager.
   */
  manageMasterUserPassword?: boolean;
  /**
   * Explicit master username when not deriving credentials from a secret.
   */
  masterUsername?: string;
  /**
   * Explicit master password when not deriving credentials from a secret.
   */
  masterUserPassword?: string;
  /**
   * Existing Secrets Manager secret ARN whose JSON payload contains
   * `username` and `password`.
   */
  masterUserSecretArn?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBCluster extends Resource<
  "AWS.RDS.DBCluster",
  DBClusterProps,
  {
    dbClusterIdentifier: string;
    dbClusterArn: string;
    dbSubnetGroupName: string | undefined;
    endpoint: string | undefined;
    readerEndpoint: string | undefined;
    port: number | undefined;
    engine: string;
    engineVersion: string | undefined;
    status: string | undefined;
    databaseName: string | undefined;
    masterUsername: string | undefined;
    masterUserSecretArn: string | undefined;
    vpcSecurityGroupIds: string[];
    httpEndpointEnabled: boolean | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Aurora DB cluster.
 *
 * `DBCluster` owns the writer and reader endpoints, cluster-wide networking,
 * and Data API enablement. It can bootstrap master credentials directly or by
 * reading a Secrets Manager secret that contains `username` and `password`.
 */
export const DBCluster = Resource<DBCluster>("AWS.RDS.DBCluster");

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

const resolveMasterCredentials = (props: DBClusterProps) =>
  Effect.gen(function* () {
    if (props.masterUserSecretArn) {
      const value = yield* secretsmanager.getSecretValue({
        SecretId: props.masterUserSecretArn,
      });
      const secretString = value.SecretString
        ? typeof value.SecretString === "string"
          ? value.SecretString
          : Redacted.value(value.SecretString)
        : undefined;
      const secret = secretString
        ? (JSON.parse(secretString) as {
            username?: string;
            password?: string;
          })
        : {};
      return {
        MasterUsername: props.masterUsername ?? secret.username,
        MasterUserPassword: props.masterUserPassword ?? secret.password,
      };
    }

    return {
      MasterUsername: props.masterUsername,
      MasterUserPassword: props.masterUserPassword,
    };
  });

const toAttrs = ({
  cluster,
  tags,
}: {
  cluster: rds.DBCluster;
  tags: Record<string, string>;
}): DBCluster["Attributes"] => ({
  dbClusterIdentifier: cluster.DBClusterIdentifier ?? "",
  dbClusterArn: cluster.DBClusterArn ?? "",
  dbSubnetGroupName: cluster.DBSubnetGroup,
  endpoint: cluster.Endpoint,
  readerEndpoint: cluster.ReaderEndpoint,
  port: cluster.Port,
  engine: cluster.Engine ?? "",
  engineVersion: cluster.EngineVersion,
  status: cluster.Status,
  databaseName: cluster.DatabaseName,
  masterUsername: cluster.MasterUsername,
  masterUserSecretArn: cluster.MasterUserSecret?.SecretArn,
  vpcSecurityGroupIds: (cluster.VpcSecurityGroups ?? []).flatMap((group) =>
    group.VpcSecurityGroupId ? [group.VpcSecurityGroupId] : [],
  ),
  httpEndpointEnabled: cluster.HttpEndpointEnabled,
  tags,
});

export const DBClusterProvider = () =>
  Provider.effect(
    DBCluster,
    Effect.gen(function* () {
      const toIdentifier = (id: string, props: DBClusterProps) =>
        props.dbClusterIdentifier
          ? Effect.succeed(props.dbClusterIdentifier)
          : createPhysicalName({ id, maxLength: 63 });

      const readCluster = Effect.fn(function* (clusterId: string) {
        const response = yield* rds
          .describeDBClusters({
            DBClusterIdentifier: clusterId,
          })
          .pipe(
            Effect.catchTag("DBClusterNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBClusters?.[0];
      });

      const waitForCluster = Effect.fn(function* (clusterId: string) {
        const readinessPolicy = Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(30)),
        );
        return yield* readCluster(clusterId).pipe(
          Effect.flatMap((cluster) =>
            cluster?.DBClusterArn
              ? Effect.succeed(cluster)
              : Effect.fail(new Error(`DB cluster '${clusterId}' not ready`)),
          ),
          Effect.retry({ schedule: readinessPolicy }),
        );
      });

      return {
        stables: ["dbClusterArn", "dbClusterIdentifier"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toIdentifier(id, olds ?? ({} as DBClusterProps))) !==
            (yield* toIdentifier(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if (olds?.engine !== news.engine) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbClusterIdentifier ??
            (yield* toIdentifier(
              id,
              olds ?? ({ engine: "" } as DBClusterProps),
            ));
          const cluster = yield* readCluster(identifier);
          if (!cluster?.DBClusterArn) {
            return undefined;
          }
          return toAttrs({
            cluster,
            tags: toTagRecord(cluster.TagList),
          });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const identifier =
            output?.dbClusterIdentifier ?? (yield* toIdentifier(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const credentials = yield* resolveMasterCredentials(news);

          // Observe — fetch live cluster state. We never trust `output`
          // blindly: the cluster may have been deleted out-of-band, or this
          // may be a first-time reconcile after adoption.
          let observed = yield* readCluster(identifier);

          // Ensure — create the cluster if it's missing. Tolerate
          // `DBClusterAlreadyExistsFault` as a race with a peer reconciler
          // (e.g. retry after state-persistence failure).
          if (!observed?.DBClusterArn) {
            yield* rds
              .createDBCluster({
                DBClusterIdentifier: identifier,
                Engine: news.engine,
                EngineVersion: news.engineVersion,
                DatabaseName: news.databaseName,
                DBSubnetGroupName: news.dbSubnetGroupName,
                DBClusterParameterGroupName: news.dbClusterParameterGroupName,
                VpcSecurityGroupIds: news.vpcSecurityGroupIds,
                Port: news.port,
                EnableIAMDatabaseAuthentication:
                  news.enableIAMDatabaseAuthentication,
                EnableHttpEndpoint: news.enableHttpEndpoint,
                EngineMode: news.engineMode,
                ServerlessV2ScalingConfiguration:
                  news.serverlessV2ScalingConfiguration,
                CopyTagsToSnapshot: news.copyTagsToSnapshot,
                DeletionProtection: news.deletionProtection,
                StorageEncrypted: news.storageEncrypted,
                KmsKeyId: news.kmsKeyId,
                ManageMasterUserPassword: news.manageMasterUserPassword,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
                ...credentials,
              })
              .pipe(
                Effect.catchTag(
                  "DBClusterAlreadyExistsFault",
                  () => Effect.void,
                ),
              );

            observed = yield* waitForCluster(identifier);
          } else {
            // Sync mutable cluster config — push the desired shape via
            // `modifyDBCluster`. Many fields land in `PendingModifiedValues`
            // and apply on next reboot; `ApplyImmediately` shortens that.
            yield* rds.modifyDBCluster({
              DBClusterIdentifier: identifier,
              EngineVersion: news.engineVersion,
              DBClusterParameterGroupName: news.dbClusterParameterGroupName,
              VpcSecurityGroupIds: news.vpcSecurityGroupIds,
              Port: news.port,
              EnableIAMDatabaseAuthentication:
                news.enableIAMDatabaseAuthentication,
              EnableHttpEndpoint: news.enableHttpEndpoint,
              ServerlessV2ScalingConfiguration:
                news.serverlessV2ScalingConfiguration,
              CopyTagsToSnapshot: news.copyTagsToSnapshot,
              DeletionProtection: news.deletionProtection,
              MasterUserPassword: credentials.MasterUserPassword,
              ApplyImmediately: true,
            });
            observed = yield* waitForCluster(identifier);
          }

          const dbClusterArn = observed.DBClusterArn ?? "";

          // Sync tags — diff observed cloud tags against desired so the
          // reconciler converges regardless of what was on the resource
          // before (initial create, adoption, or drift).
          const observedTags = toTagRecord(observed.TagList);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbClusterArn) {
            yield* rds.addTagsToResource({
              ResourceName: dbClusterArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbClusterArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: dbClusterArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbClusterArn || identifier);
          return toAttrs({ cluster: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBCluster({
              DBClusterIdentifier: output.dbClusterIdentifier,
              SkipFinalSnapshot: true,
            })
            .pipe(Effect.catchTag("DBClusterNotFoundFault", () => Effect.void));
        }),
      };
    }),
  );

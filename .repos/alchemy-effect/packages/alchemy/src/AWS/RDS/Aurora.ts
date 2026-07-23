import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import * as IAM from "../IAM/index.ts";
import {
  Secret,
  type GenerateSecretStringProps,
  type SecretProps,
  type Secret as SecretResource,
} from "../SecretsManager/Secret.ts";
import {
  DBCluster,
  type DBClusterProps,
  type DBCluster as DBClusterResource,
} from "./DBCluster.ts";
import {
  DBClusterParameterGroup,
  type DBClusterParameterGroupProps,
  type DBClusterParameterGroup as DBClusterParameterGroupResource,
} from "./DBClusterParameterGroup.ts";
import {
  DBInstance,
  type DBInstanceProps,
  type DBInstance as DBInstanceResource,
} from "./DBInstance.ts";
import {
  DBParameterGroup,
  type DBParameterGroupProps,
  type DBParameterGroup as DBParameterGroupResource,
} from "./DBParameterGroup.ts";
import {
  DBProxy,
  type DBProxyProps,
  type DBProxy as DBProxyResource,
} from "./DBProxy.ts";
import {
  DBProxyEndpoint,
  type DBProxyEndpointProps,
  type DBProxyEndpoint as DBProxyEndpointResource,
} from "./DBProxyEndpoint.ts";
import {
  DBProxyTargetGroup,
  type DBProxyTargetGroupProps,
  type DBProxyTargetGroup as DBProxyTargetGroupResource,
} from "./DBProxyTargetGroup.ts";
import {
  DBSubnetGroup,
  type DBSubnetGroupProps,
  type DBSubnetGroup as DBSubnetGroupResource,
} from "./DBSubnetGroup.ts";

export interface AuroraSecretProps extends Omit<
  SecretProps,
  "secretString" | "secretBinary" | "generateSecretString"
> {
  /**
   * Existing secret to reuse instead of creating one.
   */
  resource?: SecretResource;
  /**
   * Master username written into a generated secret payload.
   * @default "app"
   */
  username?: string;
  /**
   * Optional explicit JSON/string secret payload.
   */
  secretString?: Redacted.Redacted<string>;
  /**
   * Optional explicit binary secret payload.
   */
  secretBinary?: Redacted.Redacted<Uint8Array<ArrayBufferLike>>;
  /**
   * Password generation settings for the created secret.
   */
  generateSecretString?: GenerateSecretStringProps;
}

export interface AuroraProxyProps extends Omit<
  DBProxyProps,
  "engineFamily" | "auth" | "roleArn" | "vpcSubnetIds"
> {
  /**
   * Override the default proxy auth config.
   */
  auth?: DBProxyProps["auth"];
  /**
   * Additional target-group configuration for the default proxy target group.
   */
  targetGroup?: Omit<
    DBProxyTargetGroupProps,
    "dbProxyName" | "dbClusterIdentifiers"
  >;
  /**
   * Optional extra endpoint to create for the proxy.
   * Use `true` for sensible defaults.
   */
  endpoint?: true | Omit<DBProxyEndpointProps, "dbProxyName" | "vpcSubnetIds">;
}

export interface AuroraProps {
  /**
   * Database name created in the cluster.
   * @default "app"
   */
  databaseName?: string;
  /**
   * Aurora engine.
   * @default "aurora-postgresql"
   */
  engine?: string;
  /**
   * Optional engine version.
   */
  engineVersion?: string;
  /**
   * Subnets for the cluster and optional proxy.
   */
  subnetIds: Input<SubnetId[]>;
  /**
   * Security groups attached to the cluster and instance.
   */
  securityGroupIds: Input<SecurityGroupId[]>;
  /**
   * Number of read replicas to create alongside the writer.
   * @default 0
   */
  readers?: number;
  /**
   * Cluster-wide tags applied to all created resources by default.
   */
  tags?: Record<string, Input<string>>;
  /**
   * Tune the generated or reused admin secret.
   */
  secret?: AuroraSecretProps;
  /**
   * Override subnet group creation.
   */
  subnetGroup?: Omit<DBSubnetGroupProps, "subnetIds">;
  /**
   * Optional cluster parameter group.
   */
  clusterParameterGroup?: Omit<DBClusterParameterGroupProps, "family"> & {
    family: string;
  };
  /**
   * Optional instance parameter group.
   */
  parameterGroup?: Omit<DBParameterGroupProps, "family"> & {
    family: string;
  };
  /**
   * Tune the Aurora cluster resource.
   */
  cluster?: Omit<
    DBClusterProps,
    | "engine"
    | "engineVersion"
    | "databaseName"
    | "dbSubnetGroupName"
    | "dbClusterParameterGroupName"
    | "vpcSecurityGroupIds"
    | "masterUserSecretArn"
    | "masterUsername"
    | "masterUserPassword"
    | "tags"
  > & {
    tags?: Record<string, Input<string>>;
  };
  /**
   * Tune the writer/readers.
   */
  instance?: Omit<
    DBInstanceProps,
    | "dbClusterIdentifier"
    | "engine"
    | "engineVersion"
    | "dbSubnetGroupName"
    | "dbParameterGroupName"
    | "vpcSecurityGroupIds"
    | "tags"
  > & {
    tags?: Record<string, Input<string>>;
  };
  /**
   * Whether to enable the Aurora Data API.
   * @default true
   */
  dataApi?: boolean;
  /**
   * Opt in to an auto-wired RDS Proxy.
   */
  proxy?: boolean | AuroraProxyProps;
}

export interface AuroraDatabase {
  secret: SecretResource;
  subnetGroup: DBSubnetGroupResource;
  clusterParameterGroup?: DBClusterParameterGroupResource;
  parameterGroup?: DBParameterGroupResource;
  cluster: DBClusterResource;
  writer: DBInstanceResource;
  readers: DBInstanceResource[];
  instances: [DBInstanceResource, ...DBInstanceResource[]];
  proxy?: {
    role: IAM.Role;
    proxy: DBProxyResource;
    targetGroup: DBProxyTargetGroupResource;
    endpoint?: DBProxyEndpointResource;
  };
}

const mergeTags = (
  base: AuroraProps["tags"] | undefined,
  extra: Record<string, Input<string>> | undefined,
) => ({
  ...base,
  ...extra,
});

const inferProxyEngineFamily = (engine: string) => {
  if (engine.includes("postgres")) {
    return "POSTGRESQL" as const;
  }
  if (engine.includes("mysql")) {
    return "MYSQL" as const;
  }
  return "POSTGRESQL" as const;
};

/**
 * Opinionated Aurora bring-up helper.
 *
 * `Aurora` is the fast-start L2 for getting a working database online with one
 * call. It creates a generated admin secret, DB subnet group, Aurora cluster,
 * and a single writer instance by default. Optional readers, parameter groups,
 * and an auto-wired RDS Proxy can be enabled as needs grow.
 *
 * The return value intentionally exposes the underlying `DB*` resources so
 * users can expand into the lower-level surface without rewriting the stack.
 *
 * @example Start a Small Aurora Cluster
 * ```typescript
 * const db = yield* AWS.RDS.Aurora("AppDb", {
 *   subnetIds: [privateSubnetA.subnetId, privateSubnetB.subnetId],
 *   securityGroupIds: [databaseSecurityGroup.groupId],
 * });
 * ```
 *
 * @example Add Readers and a Proxy
 * ```typescript
 * const db = yield* AWS.RDS.Aurora("AppDb", {
 *   subnetIds: [privateSubnetA.subnetId, privateSubnetB.subnetId],
 *   securityGroupIds: [databaseSecurityGroup.groupId],
 *   readers: 2,
 *   proxy: true,
 * });
 * ```
 */
export const Aurora = (id: string, props: AuroraProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const engine = props.engine ?? "aurora-postgresql";
      const engineVersion = props.engineVersion;
      const databaseName = props.databaseName ?? "app";
      const username = props.secret?.username ?? "app";
      const subnetIds = props.subnetIds;
      const securityGroupIds = props.securityGroupIds;
      const commonTags = props.tags;
      const proxyConfig: AuroraProxyProps | undefined =
        props.proxy === true ? {} : props.proxy || undefined;

      const secret =
        props.secret?.resource ??
        (yield* Secret("Secret", {
          name: props.secret?.name,
          description:
            props.secret?.description ??
            `Credentials for Aurora database ${id}`,
          kmsKeyId: props.secret?.kmsKeyId,
          secretString: props.secret?.secretString,
          secretBinary: props.secret?.secretBinary,
          generateSecretString:
            props.secret?.secretString || props.secret?.secretBinary
              ? undefined
              : {
                  secretStringTemplate: JSON.stringify({ username }),
                  generateStringKey: "password",
                  PasswordLength: 32,
                  ExcludeCharacters: "\"'@/\\",
                  ...props.secret?.generateSecretString,
                },
          tags: mergeTags(commonTags, props.secret?.tags),
        }));

      const subnetGroup = yield* DBSubnetGroup("SubnetGroup", {
        dbSubnetGroupName: props.subnetGroup?.dbSubnetGroupName,
        description: props.subnetGroup?.description,
        subnetIds,
        tags: mergeTags(commonTags, props.subnetGroup?.tags),
      });

      const clusterParameterGroup = props.clusterParameterGroup
        ? yield* DBClusterParameterGroup("ClusterParameterGroup", {
            dbClusterParameterGroupName:
              props.clusterParameterGroup.dbClusterParameterGroupName,
            family: props.clusterParameterGroup.family,
            description: props.clusterParameterGroup.description,
            tags: mergeTags(commonTags, props.clusterParameterGroup.tags),
          })
        : undefined;

      const parameterGroup = props.parameterGroup
        ? yield* DBParameterGroup("ParameterGroup", {
            dbParameterGroupName: props.parameterGroup.dbParameterGroupName,
            family: props.parameterGroup.family,
            description: props.parameterGroup.description,
            tags: mergeTags(commonTags, props.parameterGroup.tags),
          })
        : undefined;

      const cluster = yield* DBCluster("Cluster", {
        engine,
        engineVersion,
        databaseName,
        dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
        dbClusterParameterGroupName:
          clusterParameterGroup?.dbClusterParameterGroupName,
        vpcSecurityGroupIds: securityGroupIds,
        enableHttpEndpoint: props.dataApi ?? true,
        copyTagsToSnapshot: props.cluster?.copyTagsToSnapshot ?? true,
        deletionProtection: props.cluster?.deletionProtection ?? false,
        serverlessV2ScalingConfiguration: props.cluster
          ?.serverlessV2ScalingConfiguration ?? {
          MinCapacity: 0.5,
          MaxCapacity: 1,
        },
        masterUserSecretArn: secret.secretArn,
        tags: mergeTags(commonTags, props.cluster?.tags),
        ...props.cluster,
      });

      const writer = yield* DBInstance("Writer", {
        dbClusterIdentifier: cluster.dbClusterIdentifier,
        dbInstanceClass: props.instance?.dbInstanceClass ?? "db.serverless",
        engine,
        engineVersion,
        dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
        dbParameterGroupName: parameterGroup?.dbParameterGroupName,
        vpcSecurityGroupIds: securityGroupIds,
        publiclyAccessible: props.instance?.publiclyAccessible ?? false,
        promotionTier: props.instance?.promotionTier ?? 0,
        autoMinorVersionUpgrade:
          props.instance?.autoMinorVersionUpgrade ?? true,
        copyTagsToSnapshot: props.instance?.copyTagsToSnapshot ?? true,
        tags: mergeTags(commonTags, props.instance?.tags),
        ...props.instance,
      });

      const readers = yield* Effect.all(
        Array.from({ length: props.readers ?? 0 }, (_, index) =>
          DBInstance(`Reader${index + 1}`, {
            dbClusterIdentifier: cluster.dbClusterIdentifier,
            dbInstanceClass: props.instance?.dbInstanceClass ?? "db.serverless",
            engine,
            engineVersion,
            dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
            dbParameterGroupName: parameterGroup?.dbParameterGroupName,
            vpcSecurityGroupIds: securityGroupIds,
            publiclyAccessible: props.instance?.publiclyAccessible ?? false,
            promotionTier: index + 1,
            autoMinorVersionUpgrade:
              props.instance?.autoMinorVersionUpgrade ?? true,
            copyTagsToSnapshot: props.instance?.copyTagsToSnapshot ?? true,
            tags: mergeTags(commonTags, props.instance?.tags),
            ...props.instance,
          }),
        ),
        { concurrency: "unbounded" },
      );

      const proxy =
        proxyConfig === undefined
          ? undefined
          : yield* Effect.gen(function* () {
              const role = yield* IAM.Role("ProxyRole", {
                assumeRolePolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Principal: {
                        Service: "rds.amazonaws.com",
                      },
                      Action: ["sts:AssumeRole"],
                      Resource: ["*"],
                    },
                  ],
                },
                inlinePolicies: {
                  ReadSecret: {
                    Version: "2012-10-17",
                    Statement: [
                      {
                        Effect: "Allow",
                        Action: [
                          "secretsmanager:GetSecretValue",
                          "secretsmanager:DescribeSecret",
                        ],
                        Resource: [secret.secretArn],
                      },
                    ],
                  },
                },
                tags: mergeTags(commonTags, undefined),
              });

              const proxy = yield* DBProxy("Proxy", {
                dbProxyName: proxyConfig.dbProxyName,
                engineFamily: inferProxyEngineFamily(engine),
                auth: proxyConfig.auth ?? [
                  {
                    AuthScheme: "SECRETS",
                    SecretArn: secret.secretArn,
                    IAMAuth: "DISABLED",
                  },
                ],
                roleArn: role.roleArn,
                vpcSubnetIds: subnetIds,
                vpcSecurityGroupIds: securityGroupIds,
                requireTLS: proxyConfig.requireTLS ?? true,
                idleClientTimeout: proxyConfig.idleClientTimeout,
                debugLogging: proxyConfig.debugLogging,
                endpointNetworkType: proxyConfig.endpointNetworkType,
                targetConnectionNetworkType:
                  proxyConfig.targetConnectionNetworkType,
                tags: mergeTags(commonTags, proxyConfig.tags),
              });

              const targetGroup = yield* DBProxyTargetGroup(
                "ProxyTargetGroup",
                {
                  targetGroupName: proxyConfig.targetGroup?.targetGroupName,
                  dbProxyName: proxy.dbProxyName,
                  dbClusterIdentifiers: [cluster.dbClusterIdentifier],
                  dbInstanceIdentifiers:
                    proxyConfig.targetGroup?.dbInstanceIdentifiers,
                  connectionPoolConfig:
                    proxyConfig.targetGroup?.connectionPoolConfig,
                },
              );

              const endpoint =
                proxyConfig.endpoint === undefined
                  ? undefined
                  : yield* DBProxyEndpoint("ProxyEndpoint", {
                      dbProxyName: proxy.dbProxyName,
                      vpcSubnetIds: subnetIds,
                      vpcSecurityGroupIds: securityGroupIds,
                      ...(proxyConfig.endpoint === true
                        ? {}
                        : proxyConfig.endpoint),
                      tags: mergeTags(
                        commonTags,
                        proxyConfig.endpoint === true
                          ? undefined
                          : proxyConfig.endpoint.tags,
                      ),
                    });

              return {
                role,
                proxy,
                targetGroup,
                endpoint,
              };
            });

      return {
        secret,
        subnetGroup,
        clusterParameterGroup,
        parameterGroup,
        cluster,
        writer,
        readers,
        instances: [writer, ...readers] as [
          DBInstanceResource,
          ...DBInstanceResource[],
        ],
        proxy,
      } satisfies AuroraDatabase as AuroraDatabase;
    }),
  );

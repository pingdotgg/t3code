import type { Input } from "alchemy/Input";
import { moduleExtension } from "alchemy/Util/Node";
import * as Duration from "effect/Duration";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import { Function as LambdaFunction } from "../Lambda/Function.ts";

export interface MigrationRunnerProps {
  /**
   * Subnets the runner attaches to. They need a route to the database; no
   * internet or NAT access is required.
   */
  subnetIds: Input<SubnetId[]>;
  /**
   * Security groups for the runner. The database's security group must
   * allow ingress on its port from one of them.
   */
  securityGroupIds: Input<SecurityGroupId[]>;
  /**
   * Longest single SQL operation (one query, or one migration's
   * transaction) the runner allows before Lambda stops it.
   * @default 15 minutes
   */
  timeout?: Duration.Duration;
  /**
   * Memory for the runner function, in MB.
   * @default 512
   */
  memorySize?: number;
}

/**
 * A Lambda function inside a VPC that applies SQL migrations to RDS
 * databases the deploying machine can't reach. Pass it as
 * `migrationsTransport` on a `DBInstance` or `Aurora`: during deploy,
 * Alchemy invokes the runner once per SQL operation, and the runner
 * connects to the database from inside the VPC.
 *
 * The runner receives the database credentials in its invocation payload,
 * so it needs no access to Secrets Manager and no outbound internet. It
 * supports PostgreSQL, MySQL and MariaDB engines, including Aurora. The
 * `pg` and `mysql2` drivers are installed into the function's artifact at
 * deploy time, which requires `npm` on the deploying machine.
 *
 * ### Migrating a private database
 * **Example:** Standalone PostgreSQL in private subnets
 * ```typescript
 * const runnerSecurityGroup = yield* AWS.EC2.SecurityGroup("RunnerSg", {
 *   vpcId: network.vpcId,
 * });
 * const databaseSecurityGroup = yield* AWS.EC2.SecurityGroup("DatabaseSg", {
 *   vpcId: network.vpcId,
 *   ingress: [
 *     {
 *       ipProtocol: "tcp",
 *       fromPort: 5432,
 *       toPort: 5432,
 *       referencedGroupId: runnerSecurityGroup.groupId,
 *     },
 *   ],
 * });
 * const runner = yield* AWS.RDS.MigrationRunner("MigrationRunner", {
 *   subnetIds: network.privateSubnetIds,
 *   securityGroupIds: [runnerSecurityGroup.groupId],
 * });
 * const database = yield* AWS.RDS.DBInstance("Database", {
 *   engine: "postgres",
 *   dbInstanceClass: "db.t4g.micro",
 *   allocatedStorage: 20,
 *   dbName: "app",
 *   masterUsername: "app",
 *   manageMasterUserPassword: true,
 *   dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
 *   vpcSecurityGroupIds: [databaseSecurityGroup.groupId],
 *   migrations: "./migrations",
 *   migrationsTransport: runner,
 * });
 * ```
 *
 * @resource
 */
export const MigrationRunner = (id: string, props: MigrationRunnerProps) =>
  LambdaFunction(id, {
    main: new URL(`./MigrationRunnerHandler${moduleExtension(import.meta.url)}`, import.meta.url)
      .href,
    handler: "handler",
    runtime: "nodejs24.x",
    vpc: {
      subnetIds: props.subnetIds,
      securityGroupIds: props.securityGroupIds,
    },
    timeout: props.timeout ?? Duration.minutes(15),
    memorySize: props.memorySize ?? 512,
    // Exact pins: the runner's drivers must not depend on the deploying
    // project's lockfile, which usually lists neither package.
    build: { install: { pg: "8.23.1", mysql2: "3.24.5" } },
  });

import * as EC2 from "@alchemy.run/aws/EC2";
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as RDS from "@alchemy.run/aws/RDS";
import * as SecretsManager from "@alchemy.run/aws/SecretsManager";
import * as Drizzle from "@alchemy.run/drizzle/Postgres";
import { sql } from "drizzle-orm";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * An isolated VPC (no internet) with an Aurora PostgreSQL cluster that only
 * the Web Function's security group may reach. IAM auth needs no AWS API
 * call at runtime (the token is presigned locally), so the function needs
 * nothing but the in-VPC socket.
 */
export const RdsWebInfra = Effect.gen(function* () {
  const vpc = yield* EC2.Vpc("RdsWebVpc", { cidrBlock: "10.62.0.0/16" });
  const subnetA = yield* EC2.Subnet("RdsWebSubnetA", {
    vpcId: vpc.vpcId,
    cidrBlock: "10.62.0.0/24",
    availabilityZone: "us-west-2a",
  });
  const subnetB = yield* EC2.Subnet("RdsWebSubnetB", {
    vpcId: vpc.vpcId,
    cidrBlock: "10.62.1.0/24",
    availabilityZone: "us-west-2b",
  });
  const appSecurityGroup = yield* EC2.SecurityGroup("RdsWebAppSg", {
    vpcId: vpc.vpcId,
    description: "Web Function egress to Aurora",
  });
  const dbSecurityGroup = yield* EC2.SecurityGroup("RdsWebDbSg", {
    vpcId: vpc.vpcId,
    description: "Aurora: Postgres from the Web Function only",
    ingress: [
      {
        ipProtocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        referencedGroupId: appSecurityGroup.groupId,
      },
    ],
  });
  const subnetGroup = yield* RDS.DBSubnetGroup("RdsWebSubnetGroup", {
    description: "WebFunction RDS.Connect test cluster",
    subnetIds: [subnetA.subnetId, subnetB.subnetId],
  });
  const secret = yield* SecretsManager.Secret("RdsWebSecret", {
    description: "Master credentials for the WebFunction RDS.Connect test cluster",
    generateSecretString: {
      secretStringTemplate: JSON.stringify({ username: "app" }),
      generateStringKey: "password",
      PasswordLength: 32,
      ExcludeCharacters: "\"'@/\\",
    },
  });
  const cluster = yield* RDS.DBCluster("RdsWebCluster", {
    engine: "aurora-postgresql",
    engineMode: "provisioned",
    databaseName: "app",
    dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
    vpcSecurityGroupIds: [dbSecurityGroup.groupId],
    // The test bootstraps the IAM user through the Data API.
    enableHttpEndpoint: true,
    enableIAMDatabaseAuthentication: true,
    serverlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 1 },
    masterUserSecretArn: secret.secretArn,
  });
  yield* RDS.DBInstance("RdsWebWriter", {
    dbClusterIdentifier: cluster.dbClusterIdentifier,
    dbInstanceClass: "db.serverless",
    engine: "aurora-postgresql",
  });
  return { subnetA, subnetB, appSecurityGroup, secret, cluster };
});

export class RdsWebFunction extends Lambda.WebFunction<Lambda.WebFunction>()("RdsWebFunction") {}

/**
 * No `vpc` prop: `RDS.Connect` with `subnetIds`/`securityGroupIds` requests
 * the VPC access through the binding channel, and the Web Function turns it
 * into its egress network connector.
 */
export default RdsWebFunction.make(
  {
    main: import.meta.url,
    authType: "ApplicationManaged",
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const { cluster, subnetA, subnetB, appSecurityGroup } = yield* RdsWebInfra;
    const connect = yield* RDS.Connect(cluster, {
      auth: "iam",
      username: "app_iam",
      database: "app",
      subnetIds: [subnetA.subnetId, subnetB.subnetId],
      securityGroupIds: [appSecurityGroup.groupId],
    });
    const db = yield* Drizzle.Postgres(Effect.map(connect, (info) => info.url));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const { pathname } = new URL(request.originalUrl, "http://localhost");
        if (pathname === "/drizzle-health") {
          const rows = yield* db.execute<{ one: number }>(sql`select 1 as one`, "objects");
          return yield* HttpServerResponse.json({ rows });
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(RDS.ConnectHttp)),
);

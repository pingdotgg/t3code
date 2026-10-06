import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export const database = Effect.gen(function* () {
  const vpc = yield* AWS.EC2.Vpc("Vpc", { cidrBlock: "10.62.0.0/16" });
  const subnetA = yield* AWS.EC2.Subnet("SubnetA", {
    vpcId: vpc.vpcId,
    cidrBlock: "10.62.0.0/24",
    availabilityZone: "us-west-2a",
  });
  const subnetB = yield* AWS.EC2.Subnet("SubnetB", {
    vpcId: vpc.vpcId,
    cidrBlock: "10.62.1.0/24",
    availabilityZone: "us-west-2b",
  });
  const lambdaSecurityGroup = yield* AWS.EC2.SecurityGroup(
    "LambdaSecurityGroup",
    {
      vpcId: vpc.vpcId,
      description: "Aurora example application; no inbound connections",
    },
  );
  const dbSecurityGroup = yield* AWS.EC2.SecurityGroup(
    "DatabaseSecurityGroup",
    {
      vpcId: vpc.vpcId,
      description: "Postgres from the application security group only",
      ingress: [
        {
          ipProtocol: "tcp",
          fromPort: 5432,
          toPort: 5432,
          referencedGroupId: lambdaSecurityGroup.groupId,
        },
      ],
    },
  );
  const subnetIds = [subnetA.subnetId, subnetB.subnetId];
  const aurora = yield* AWS.RDS.Aurora("Database", {
    databaseName: "app",
    engine: "aurora-postgresql",
    engineVersion: "17.5",
    subnetIds,
    securityGroupIds: [dbSecurityGroup.groupId],
    secret: { username: "dbadmin" },
    dataApi: true,
    cluster: {
      enableIAMDatabaseAuthentication: true,
      serverlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 1 },
    },
    instance: { dbInstanceClass: "db.serverless", publiclyAccessible: false },
  });
  return { ...aurora, vpc, subnetIds, lambdaSecurityGroup };
});

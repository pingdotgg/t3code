import { Network } from "@alchemy.run/aws/EC2/Network";
import { SecurityGroup } from "@alchemy.run/aws/EC2/SecurityGroup";
import * as RDS from "@alchemy.run/aws/RDS";
import * as Effect from "effect/Effect";

/**
 * A standalone Postgres `DBInstance` for the `RDS.Connect` fixture, shared by
 * the Lambda fixture and the test's stack program (declarations dedupe by
 * logical ID).
 *
 * Topology: an isolated network (no NAT), a security group for the
 * VPC-attached Lambda, a database security group that admits Postgres from
 * that Lambda only, and an endpoint security group that admits HTTPS from it
 * (the test adds a Secrets Manager interface endpoint so the Lambda can read
 * the instance's managed master secret).
 */
export const RdsConnectInfra = Effect.gen(function* () {
  const network = yield* Network("ConnectNet", { cidrBlock: "10.48.0.0/16" });

  const lambdaSecurityGroup = yield* SecurityGroup("ConnectLambdaSecurityGroup", {
    vpcId: network.vpcId,
    description: "VPC-attached Lambda for the RDS.Connect DBInstance fixture",
  });

  const dbSecurityGroup = yield* SecurityGroup("ConnectDbSecurityGroup", {
    vpcId: network.vpcId,
    description: "RDS.Connect DBInstance (Postgres from the Lambda SG)",
    ingress: [
      {
        ipProtocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        referencedGroupId: lambdaSecurityGroup.groupId,
        description: "Postgres from the RDS.Connect Lambda",
      },
    ],
  });

  const endpointSecurityGroup = yield* SecurityGroup("ConnectEndpointSecurityGroup", {
    vpcId: network.vpcId,
    description: "Secrets Manager endpoint (HTTPS from the Lambda SG)",
    ingress: [
      {
        ipProtocol: "tcp",
        fromPort: 443,
        toPort: 443,
        referencedGroupId: lambdaSecurityGroup.groupId,
        description: "HTTPS from the RDS.Connect Lambda",
      },
    ],
  });

  const subnetGroup = yield* RDS.DBSubnetGroup("ConnectSubnetGroup", {
    description: "RDS.Connect DBInstance fixture",
    subnetIds: network.privateSubnetIds,
  });

  // No `Secret` resource: the instance's credentials live in the
  // RDS-managed master user secret, which `RDS.Connect` reads by default.
  const instance = yield* RDS.DBInstance("ConnectInstance", {
    engine: "postgres",
    dbInstanceClass: "db.t3.micro",
    allocatedStorage: 20,
    storageType: "gp2",
    masterUsername: "alchemy",
    manageMasterUserPassword: true,
    enableIAMDatabaseAuthentication: true,
    backupRetentionPeriod: "1 day",
    deletionProtection: false,
    dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
    vpcSecurityGroupIds: [dbSecurityGroup.groupId],
    publiclyAccessible: false,
  });

  return { network, lambdaSecurityGroup, endpointSecurityGroup, instance };
});

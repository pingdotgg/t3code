import * as EC2 from "@/AWS/EC2";
import * as RDS from "@/AWS/RDS";
import * as SecretsManager from "@/AWS/SecretsManager";
import * as Effect from "effect/Effect";

/**
 * Shared Aurora fixture infrastructure for the RDSData bindings Lambda and
 * the Drizzle-over-IAM Lambda. Both fixtures yield this effect; resource
 * declarations dedupe by logical ID so the stack provisions one cluster.
 *
 * Topology: an isolated VPC (no gateways — the Data API is HTTP and the
 * IAM-auth Lambda only opens an in-VPC socket), two subnets in distinct AZs
 * for the DB subnet group, an ingress-free security group for the Lambda,
 * and a DB security group that admits Postgres traffic from the Lambda
 * security group only.
 */
export const RDSDataInfra = Effect.gen(function* () {
  const vpc = yield* EC2.Vpc("Vpc", {
    cidrBlock: "10.61.0.0/16",
  });
  const subnetA = yield* EC2.Subnet("SubnetA", {
    vpcId: vpc.vpcId,
    cidrBlock: "10.61.0.0/24",
    availabilityZone: "us-west-2a",
  });
  const subnetB = yield* EC2.Subnet("SubnetB", {
    vpcId: vpc.vpcId,
    cidrBlock: "10.61.1.0/24",
    availabilityZone: "us-west-2b",
  });

  // Security group for the VPC-attached Drizzle Lambda. No ingress — it only
  // dials out to the cluster.
  const lambdaSecurityGroup = yield* EC2.SecurityGroup("LambdaSecurityGroup", {
    vpcId: vpc.vpcId,
    description: "VPC-attached Lambda for the Aurora IAM-auth socket path",
  });

  const securityGroup = yield* EC2.SecurityGroup("DbSecurityGroup", {
    vpcId: vpc.vpcId,
    description: "Aurora Data API test cluster (Postgres from the Lambda SG)",
    ingress: [
      {
        ipProtocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        referencedGroupId: lambdaSecurityGroup.groupId,
        description: "Postgres from the Drizzle IAM-auth Lambda",
      },
    ],
  });

  const subnetGroup = yield* RDS.DBSubnetGroup("SubnetGroup", {
    description: "RDSData bindings test cluster",
    subnetIds: [subnetA.subnetId, subnetB.subnetId],
  });

  // The Data API authenticates with a Secrets Manager secret whose JSON
  // payload carries `username` + `password`; the cluster reads the same
  // secret for its master credentials (`masterUserSecretArn`).
  const secret = yield* SecretsManager.Secret("Secret", {
    description: "Credentials for the RDSData bindings test cluster",
    generateSecretString: {
      secretStringTemplate: JSON.stringify({ username: "app" }),
      generateStringKey: "password",
      PasswordLength: 32,
      ExcludeCharacters: "\"'@/\\",
    },
  });

  const cluster = yield* RDS.DBCluster("Cluster", {
    engine: "aurora-postgresql",
    engineMode: "provisioned",
    databaseName: "app",
    dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
    vpcSecurityGroupIds: [securityGroup.groupId],
    enableHttpEndpoint: true,
    // Exercised by the RDS.Connect IAM-auth path (rds-db:connect + presigned
    // token as the password).
    enableIAMDatabaseAuthentication: true,
    serverlessV2ScalingConfiguration: {
      MinCapacity: 0.5,
      MaxCapacity: 1,
    },
    masterUserSecretArn: secret.secretArn,
  });

  // Cluster members inherit the subnet group and security groups from the
  // cluster — RDS rejects `CreateDBInstance` with VpcSecurityGroupIds for a
  // cluster member ("Set vpc security group for the DB Cluster").
  yield* RDS.DBInstance("Writer", {
    dbClusterIdentifier: cluster.dbClusterIdentifier,
    dbInstanceClass: "db.serverless",
    engine: "aurora-postgresql",
  });

  return {
    vpc,
    subnetA,
    subnetB,
    lambdaSecurityGroup,
    securityGroup,
    subnetGroup,
    secret,
    cluster,
  };
});

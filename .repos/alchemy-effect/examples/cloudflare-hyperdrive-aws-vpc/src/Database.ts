import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const DB_USER = "app";
export const DB_NAME = "app";

/**
 * A VPC with public subnets (for the tunnel connector) and private subnets
 * (for Aurora). Nothing in the private subnets is reachable from the internet.
 */
export const Network = AWS.EC2.Network("Network", {
  cidrBlock: "10.63.0.0/16",
  availabilityZones: 2,
});

/** Security group for the `cloudflared` connector — outbound only. */
export const ConnectorSecurityGroup = Effect.gen(function* () {
  const network = yield* Network;
  return yield* AWS.EC2.SecurityGroup("ConnectorSecurityGroup", {
    vpcId: network.vpcId,
    description: "cloudflared connector; no inbound connections",
  });
});

/** Database password, generated once and kept in state. */
export const DbPassword = Alchemy.Random("DbPassword", { bytes: 24 });

/** Private Aurora PostgreSQL that only admits the connector. */
export const Database = Effect.gen(function* () {
  const network = yield* Network;
  const connector = yield* ConnectorSecurityGroup;
  const password = yield* DbPassword;
  const dbSecurityGroup = yield* AWS.EC2.SecurityGroup("DatabaseSecurityGroup", {
    vpcId: network.vpcId,
    description: "Postgres from the cloudflared connector only",
    ingress: [
      {
        ipProtocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        referencedGroupId: connector.groupId,
      },
    ],
  });
  const secret = yield* AWS.SecretsManager.Secret("DatabaseSecret", {
    secretString: Output.map(password.text, (password) =>
      Redacted.make(JSON.stringify({ username: DB_USER, password: Redacted.value(password) })),
    ),
  });
  return yield* AWS.RDS.Aurora("Database", {
    databaseName: DB_NAME,
    engine: "aurora-postgresql",
    engineVersion: "17.5",
    subnetIds: network.privateSubnetIds,
    securityGroupIds: [dbSecurityGroup.groupId],
    secret: { resource: secret },
    instance: { dbInstanceClass: "db.serverless", publiclyAccessible: false },
  });
});

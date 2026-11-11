import * as AWS from "@alchemy.run/aws";
import { DbInstance } from "@alchemy.run/aws/Timestream";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as influxdb from "@distilled.cloud/aws/timestream-influxdb";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const envList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const defaultNetwork = Effect.gen(function* () {
  const subnetIds = envList(process.env.AWS_TEST_SUBNET_IDS);
  const securityGroupIds = envList(process.env.AWS_TEST_SECURITY_GROUP_IDS);
  if (subnetIds.length > 0 && securityGroupIds.length > 0) {
    return { subnetIds, securityGroupIds };
  }
  const vpc = yield* getDefaultVpc;
  const subnets = yield* EC2.describeSubnets({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "default-for-az", Values: ["true"] },
    ],
  });
  const groups = yield* EC2.describeSecurityGroups({
    Filters: [
      { Name: "vpc-id", Values: [vpc.vpcId] },
      { Name: "group-name", Values: ["default"] },
    ],
  });
  const defaultSubnetIds = (subnets.Subnets ?? [])
    .map((s) => s.SubnetId)
    .filter((id): id is string => id !== undefined)
    .sort()
    .slice(0, 1);
  const securityGroupId = groups.SecurityGroups?.[0]?.GroupId;
  if (defaultSubnetIds.length === 0 || securityGroupId === undefined) {
    return yield* Effect.die(
      new Error("default VPC is missing subnets or its default security group"),
    );
  }
  return { subnetIds: defaultSubnetIds, securityGroupIds: [securityGroupId] };
});

// timestream-influxdb IS accessible (unlike Timestream LiveAnalytics), but
// provisioning a DB instance takes ~15–20 minutes and is EC2-backed/costly.
// The ungated probe asserts the distilled wiring produces a typed error; the
// full lifecycle is skipped under `--fast`.
describe(
  "AWS.Timestream.DbInstance",
  { tags: ["provider:aws", "provider:aws:timestream", "live"] },
  () => {
    test.provider(
      "getDbInstance for a bad identifier yields a typed ValidationException",
      (_stack) =>
        Effect.gen(function* () {
          // A malformed identifier is rejected up-front with a typed
          // ValidationException (a well-formed but absent id would instead yield
          // ResourceNotFoundException); either way the distilled wiring surfaces
          // a typed error rather than an untyped catch-all.
          const error = yield* influxdb
            .getDbInstance({ identifier: "alchemy-timestream-does-not-exist" })
            .pipe(Effect.flip);
          expect(["ValidationException", "ResourceNotFoundException"]).toContain(error._tag);
        }),
      { timeout: 60_000 },
    );

    test.provider.skipIf(!!process.env.FAST)(
      "create, wait, and delete an InfluxDB instance",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // Explicit AWS_TEST_SUBNET_IDS / AWS_TEST_SECURITY_GROUP_IDS win;
          // otherwise use the default VPC's default-for-AZ subnets and its
          // default security group.
          const network = yield* defaultNetwork;

          const instance = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* DbInstance("Influx", {
                dbInstanceType: "db.influx.medium",
                allocatedStorage: 20,
                vpcSubnetIds: network.subnetIds,
                vpcSecurityGroupIds: network.securityGroupIds,
                password: Redacted.make("AlchemySuperSecretPw1"),
                tags: { Environment: "test" },
              });
            }),
          );

          expect(instance.id).toBeDefined();
          expect(instance.arn).toBeDefined();
          expect(instance.status).toBe("AVAILABLE");

          const described = yield* influxdb.getDbInstance({ identifier: instance.id });
          expect(described.name).toBe(instance.name);

          yield* stack.destroy();

          yield* Effect.gen(function* () {
            const gone = yield* influxdb.getDbInstance({ identifier: instance.id }).pipe(
              Effect.map(() => false),
              Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
            );
            if (!gone) return yield* Effect.fail({ _tag: "StillExists" as const });
          }).pipe(
            Effect.retry({
              while: (e: { _tag: string }) => e._tag === "StillExists",
              schedule: Schedule.max([Schedule.spaced("20 seconds"), Schedule.recurs(90)]),
            }),
          );
        }),
      { timeout: 2_400_000 },
    );
  },
);

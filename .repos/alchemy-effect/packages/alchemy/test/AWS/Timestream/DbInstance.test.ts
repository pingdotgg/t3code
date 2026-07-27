import * as AWS from "@/AWS";
import { DbInstance } from "@/AWS/Timestream";
import * as Test from "@/Test/Alchemy";
import * as influxdb from "@distilled.cloud/aws/timestream-influxdb";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// timestream-influxdb IS accessible (unlike Timestream LiveAnalytics), but
// provisioning a DB instance takes ~15–20 minutes and is EC2-backed/costly.
// The ungated probe asserts the distilled wiring produces a typed error; the
// full lifecycle is gated behind AWS_TEST_SLOW=1.
describe("AWS.Timestream.DbInstance", () => {
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
        expect(["ValidationException", "ResourceNotFoundException"]).toContain(
          error._tag,
        );
      }),
    { timeout: 60_000 },
  );

  test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
    "create, wait, and delete an InfluxDB instance",
    (stack) =>
      Effect.gen(function* () {
        const subnetIds = (process.env.AWS_TEST_SUBNET_IDS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const securityGroupIds = (process.env.AWS_TEST_SECURITY_GROUP_IDS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        expect(subnetIds.length).toBeGreaterThan(0);
        expect(securityGroupIds.length).toBeGreaterThan(0);

        const instance = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* DbInstance("Influx", {
              name: "alchemy-influx-test",
              dbInstanceType: "db.influx.medium",
              allocatedStorage: 20,
              vpcSubnetIds: subnetIds,
              vpcSecurityGroupIds: securityGroupIds,
              password: Redacted.make("alchemy-super-secret-pw-1"),
              tags: { Environment: "test" },
            });
          }),
        );

        expect(instance.id).toBeDefined();
        expect(instance.arn).toBeDefined();
        expect(instance.status).toBe("AVAILABLE");

        const described = yield* influxdb.getDbInstance({
          identifier: instance.id,
        });
        expect(described.name).toBe("alchemy-influx-test");

        yield* stack.destroy();

        yield* Effect.gen(function* () {
          const gone = yield* influxdb
            .getDbInstance({ identifier: instance.id })
            .pipe(
              Effect.map(() => false),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(true),
              ),
            );
          if (!gone)
            return yield* Effect.fail({ _tag: "StillExists" as const });
        }).pipe(
          Effect.retry({
            while: (e: { _tag: string }) => e._tag === "StillExists",
            schedule: Schedule.max([
              Schedule.spaced("20 seconds"),
              Schedule.recurs(90),
            ]),
          }),
        );
      }),
    { timeout: 2_400_000 },
  );
});

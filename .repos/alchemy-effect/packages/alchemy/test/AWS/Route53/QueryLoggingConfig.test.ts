import * as AWS from "@/AWS";
import { HostedZone, QueryLoggingConfig } from "@/AWS/Route53";
import * as Test from "@/Test/Alchemy";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Route 53 only delivers query logs to us-east-1 log groups, and the
// CloudWatch Logs resource policy that authorizes it must live there too.
const inUsEast1 = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

// Deterministic, test-owned names. The account resource-policy quota is 10
// per region and cannot be raised — this suite is quota-aware by owning a
// single dedicated policy (net-zero after cleanup) instead of touching any
// shared policy.
const POLICY_NAME = "alchemy-test-route53-query-logging";
const LOG_GROUP_A = "/aws/route53/alchemy-test-qlc-a";
const LOG_GROUP_B = "/aws/route53/alchemy-test-qlc-b";

const ensureLogGroup = (logGroupName: string) =>
  inUsEast1(
    logs
      .createLogGroup({ logGroupName })
      .pipe(
        Effect.catchTag("ResourceAlreadyExistsException", () => Effect.void),
      ),
  );

const removeLogGroup = (logGroupName: string) =>
  inUsEast1(
    logs
      .deleteLogGroup({ logGroupName })
      .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
  );

const removePolicy = inUsEast1(
  logs
    .deleteResourcePolicy({ policyName: POLICY_NAME })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
);

const assertConfigGone = (id: string) =>
  route53.getQueryLoggingConfig({ Id: id }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error("query logging config still exists")),
    ),
    Effect.catchTag("NoSuchQueryLoggingConfig", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, replace on log-group change, and delete query logging config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { Account: accountId } = yield* sts.getCallerIdentity({});
      const logGroupArnA = `arn:aws:logs:us-east-1:${accountId}:log-group:${LOG_GROUP_A}`;
      const logGroupArnB = `arn:aws:logs:us-east-1:${accountId}:log-group:${LOG_GROUP_B}`;

      const cleanup = Effect.gen(function* () {
        yield* stack.destroy();
        yield* removeLogGroup(LOG_GROUP_A);
        yield* removeLogGroup(LOG_GROUP_B);
        yield* removePolicy;
      });

      // Everything from the first out-of-band create onwards runs under
      // `Effect.ensuring(cleanup)` so a failure at ANY point (including while
      // provisioning the prerequisites themselves) still tears down the log
      // groups + resource policy. All ops are idempotent (AlreadyExists /
      // NotFound caught), so re-runs reclaim any leftovers from a crash.
      const replacedId = yield* Effect.gen(function* () {
        // Out-of-band us-east-1 prerequisites: two log groups and the resource
        // policy that lets Route 53 write to them. (The Logs LogGroup /
        // ResourcePolicy resources follow the ambient region, so the test
        // provisions these via distilled directly.)
        yield* ensureLogGroup(LOG_GROUP_A);
        yield* ensureLogGroup(LOG_GROUP_B);
        yield* inUsEast1(
          logs.putResourcePolicy({
            policyName: POLICY_NAME,
            policyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "route53.amazonaws.com" },
                  Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                  Resource: `arn:aws:logs:us-east-1:${accountId}:log-group:/aws/route53/alchemy-test-qlc-*`,
                },
              ],
            }),
          }),
        );

        // Create.
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const zone = yield* HostedZone("QueryLogZone", {
              name: "alchemy-test-qlc.alchemy.",
              forceDestroy: true,
            });
            return yield* QueryLoggingConfig("QueryLogging", {
              hostedZoneId: zone.id,
              cloudWatchLogsLogGroupArn: logGroupArnA,
            });
          }),
        );

        expect(created.id).toBeDefined();
        expect(created.cloudWatchLogsLogGroupArn).toBe(logGroupArnA);

        // Out-of-band verification.
        const observed = yield* route53.getQueryLoggingConfig({
          Id: created.id,
        });
        expect(observed.QueryLoggingConfig.HostedZoneId).toBe(
          created.hostedZoneId,
        );
        expect(observed.QueryLoggingConfig.CloudWatchLogsLogGroupArn).toBe(
          logGroupArnA,
        );

        // Changing the log group replaces the configuration (no update API).
        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            const zone = yield* HostedZone("QueryLogZone", {
              name: "alchemy-test-qlc.alchemy.",
              forceDestroy: true,
            });
            return yield* QueryLoggingConfig("QueryLogging", {
              hostedZoneId: zone.id,
              cloudWatchLogsLogGroupArn: logGroupArnB,
            });
          }),
        );

        expect(replaced.id).not.toBe(created.id);
        expect(replaced.cloudWatchLogsLogGroupArn).toBe(logGroupArnB);
        expect(replaced.hostedZoneId).toBe(created.hostedZoneId);

        // The old configuration must be gone.
        yield* assertConfigGone(created.id);

        return replaced.id;
      }).pipe(Effect.ensuring(cleanup.pipe(Effect.ignore)));

      // `cleanup` owns the successful destroy as well as failure cleanup. Do
      // not destroy twice on the success path: under a saturated account the
      // redundant refresh can consume the test's remaining timeout budget.
      yield* assertConfigGone(replacedId);
    }),
  { timeout: 120_000 },
);

import * as AWS from "@/AWS";
import { LogGroup } from "@/AWS/Logs";
import { LoggingConfiguration, WebACL } from "@/AWS/WAFv2";
import * as Test from "@/Test/Alchemy";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class LoggingConfigStillExists extends Data.TaggedError(
  "LoggingConfigStillExists",
)<{
  readonly resourceArn: string;
}> {}

const assertLoggingDeleted = (resourceArn: string) =>
  wafv2.getLoggingConfiguration({ ResourceArn: resourceArn }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new LoggingConfigStillExists({ resourceArn })),
    ),
    Effect.catchTag("WAFNonexistentItemException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "LoggingConfigStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "enable logging to CloudWatch Logs, add a filter, delete",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      // Destinations must be named aws-waf-logs-*.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const acl = yield* WebACL("LoggedAcl", {});
          const logGroup = yield* LogGroup("WafLogGroup", {
            logGroupName: "aws-waf-logs-alchemy-wafv2-test",
          });
          const logging = yield* LoggingConfiguration("Logging", {
            resourceArn: acl.webAclArn,
            logDestinationConfigs: [logGroup.logGroupArn],
          });
          return { acl, logging };
        }),
      );

      expect(deployed.logging.scope).toBe("REGIONAL");
      expect(deployed.logging.logDestinationConfigs).toHaveLength(1);

      // out-of-band verification via distilled
      const created = yield* wafv2.getLoggingConfiguration({
        ResourceArn: deployed.acl.webAclArn,
      });
      expect(
        created.LoggingConfiguration?.LogDestinationConfigs?.[0],
      ).toContain("aws-waf-logs-alchemy-wafv2-test");
      expect(created.LoggingConfiguration?.LoggingFilter).toBeUndefined();

      // update in place: add a redacted field + logging filter
      yield* stack.deploy(
        Effect.gen(function* () {
          const acl = yield* WebACL("LoggedAcl", {});
          const logGroup = yield* LogGroup("WafLogGroup", {
            logGroupName: "aws-waf-logs-alchemy-wafv2-test",
          });
          const logging = yield* LoggingConfiguration("Logging", {
            resourceArn: acl.webAclArn,
            logDestinationConfigs: [logGroup.logGroupArn],
            redactedFields: [{ SingleHeader: { Name: "authorization" } }],
            loggingFilter: {
              DefaultBehavior: "KEEP",
              Filters: [
                {
                  Behavior: "DROP",
                  Requirement: "MEETS_ANY",
                  Conditions: [{ ActionCondition: { Action: "ALLOW" } }],
                },
              ],
            },
          });
          return { acl, logging };
        }),
      );

      const updated = yield* wafv2.getLoggingConfiguration({
        ResourceArn: deployed.acl.webAclArn,
      });
      expect(updated.LoggingConfiguration?.LoggingFilter?.DefaultBehavior).toBe(
        "KEEP",
      );
      expect(
        updated.LoggingConfiguration?.RedactedFields?.[0]?.SingleHeader?.Name,
      ).toBe("authorization");

      yield* stack.destroy();
      yield* assertLoggingDeleted(deployed.acl.webAclArn);
    }),
  { timeout: 300_000 },
);

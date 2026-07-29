import * as AWS from "@/AWS";
import { FlowLog, Vpc } from "@/AWS/EC2";
import { LogGroup } from "@/AWS/Logs/LogGroup.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class FlowLogStillExists extends Data.TaggedError("FlowLogStillExists") {}

const assertDeleted = Effect.fn(function* (flowLogId: string) {
  yield* EC2.describeFlowLogs({ FlowLogIds: [flowLogId] }).pipe(
    Effect.flatMap((r) =>
      (r.FlowLogs?.length ?? 0) === 0
        ? Effect.void
        : Effect.fail(new FlowLogStillExists()),
    ),
    Effect.retry({
      while: (e) => e instanceof FlowLogStillExists,
      schedule: Schedule.max([Schedule.exponential(300), Schedule.recurs(8)]),
    }),
    Effect.catchTag("InvalidFlowLogId.NotFound", () => Effect.void),
  );
});

const flowLogStack = (tags?: Record<string, string>) =>
  Effect.gen(function* () {
    const vpc = yield* Vpc("FlowLogVpc", { cidrBlock: "10.50.0.0/16" });
    const logGroup = yield* LogGroup("FlowLogGroup", {});
    const role = yield* Role("FlowLogRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "vpc-flow-logs.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        deliver: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:DescribeLogStreams",
              ],
              Resource: "*",
            },
          ],
        },
      },
    });
    const flowLog = yield* FlowLog("VpcFlowLog", {
      resourceType: "VPC",
      resourceId: vpc.vpcId,
      trafficType: "ALL",
      logGroupName: logGroup.logGroupName,
      deliverLogsPermissionArn: role.roleArn,
      tags,
    });
    return { vpc, flowLog };
  });

test.provider(
  "create, update tags, delete VPC flow log to CloudWatch Logs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { vpc, flowLog } = yield* stack.deploy(flowLogStack());

      expect(flowLog.flowLogId).toMatch(/^fl-/);
      expect(flowLog.resourceId).toEqual(vpc.vpcId);
      expect(flowLog.trafficType).toEqual("ALL");
      expect(flowLog.logDestinationType).toEqual("cloud-watch-logs");

      // Verify out-of-band.
      const described = yield* EC2.describeFlowLogs({
        FlowLogIds: [flowLog.flowLogId],
      });
      const fl = described.FlowLogs?.[0];
      expect(fl?.FlowLogId).toEqual(flowLog.flowLogId);
      expect(fl?.ResourceId).toEqual(vpc.vpcId);
      expect(fl?.TrafficType).toEqual("ALL");
      expect(fl?.LogDestinationType).toEqual("cloud-watch-logs");

      // Update tags in place (flow log id unchanged).
      const { flowLog: updated } = yield* stack.deploy(
        flowLogStack({ env: "prod" }),
      );
      expect(updated.flowLogId).toEqual(flowLog.flowLogId);

      const tags = yield* EC2.describeTags({
        Filters: [
          { Name: "resource-id", Values: [flowLog.flowLogId] },
          { Name: "resource-type", Values: ["vpc-flow-log"] },
        ],
      });
      expect(
        tags.Tags?.some((t) => t.Key === "env" && t.Value === "prod"),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertDeleted(flowLog.flowLogId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "list enumerates the deployed flow log",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { flowLog } = yield* stack.deploy(flowLogStack());

      const provider = yield* Provider.findProvider(FlowLog);
      const all = yield* provider.list();
      expect(all.some((x) => x.flowLogId === flowLog.flowLogId)).toBe(true);

      yield* stack.destroy();
      yield* assertDeleted(flowLog.flowLogId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

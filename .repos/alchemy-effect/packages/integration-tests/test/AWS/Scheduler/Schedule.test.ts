import * as AWS from "@alchemy.run/aws";
import { Role } from "@alchemy.run/aws/IAM";
import { Schedule } from "@alchemy.run/aws/Scheduler/Schedule";
import { ScheduleGroup } from "@alchemy.run/aws/Scheduler/ScheduleGroup";
import { Queue } from "@alchemy.run/aws/SQS/Queue";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { driftActions, repairDrift, waitForDrift } from "../drift.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection across all
// schedule groups): deploy a real schedule (with the IAM role + SQS target it
// requires), resolve the provider from context via the typed `findProvider`,
// call `list()`, and assert the deployed schedule appears in the
// exhaustively-paginated result.
test.provider(
  "list enumerates the deployed schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The Schedule provider internally retries the "execution role must allow
      // EventBridge Scheduler to assume the role" ValidationException until the
      // freshly-created IAM role propagates, so the deploy needs no retry here.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Queue("ListScheduleQueue", {
            queueName: "alchemy-test-schedule-list-queue",
          });

          const role = yield* Role("ListScheduleRole", {
            roleName: "alchemy-test-schedule-list-role",
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "scheduler.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            inlinePolicies: {
              ScheduleTarget: {
                Version: "2012-10-17",
                Statement: [
                  { Effect: "Allow", Action: ["sqs:SendMessage"], Resource: [queue.queueArn] },
                ],
              },
            },
          });

          return yield* Schedule("ListSchedule", {
            name: "alchemy-test-schedule-list",
            scheduleExpression: "rate(1 hour)",
            flexibleTimeWindow: { Mode: "OFF" },
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Schedule);
      const all = yield* provider.list();

      expect(all.some((s) => s.scheduleName === deployed.scheduleName)).toBe(true);
      expect(
        all.some(
          (s) => s.scheduleName === deployed.scheduleName && s.scheduleArn === deployed.scheduleArn,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:iam",
      "provider:aws:scheduler",
      "provider:aws:sqs",
      "live",
    ],
  },
);

// #2688: `read` must observe the schedule definition and the group's tags,
// or an out-of-band change reads as `unchanged`.
test.provider(
  "drift detects and repairs out-of-band schedule and group changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { schedule, group } = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* Queue("DriftScheduleQueue", {});
          const role = yield* Role("DriftScheduleRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "scheduler.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            inlinePolicies: {
              ScheduleTarget: {
                Version: "2012-10-17",
                Statement: [
                  { Effect: "Allow", Action: ["sqs:SendMessage"], Resource: [queue.queueArn] },
                ],
              },
            },
          });
          const group = yield* ScheduleGroup("DriftScheduleGroup", {
            tags: { team: "declared" },
          });
          const schedule = yield* Schedule("DriftSchedule", {
            groupName: group.scheduleGroupName,
            scheduleExpression: "rate(1 hour)",
            scheduleExpressionTimezone: "UTC",
            flexibleTimeWindow: { Mode: "OFF" },
            target: { Arn: queue.queueArn, RoleArn: role.roleArn },
          });
          return { schedule, group };
        }),
      );
      const actions = yield* driftActions(stack);
      expect(Object.values(actions).every((action) => action === "unchanged")).toBe(true);

      const observed = yield* scheduler.getSchedule({
        Name: schedule.scheduleName,
        GroupName: schedule.groupName,
      });
      yield* scheduler.updateSchedule({
        Name: schedule.scheduleName,
        GroupName: schedule.groupName,
        ScheduleExpression: "rate(7 days)",
        FlexibleTimeWindow: { Mode: "FLEXIBLE", MaximumWindowInMinutes: 15 },
        Target: observed.Target!,
      });
      yield* scheduler.tagResource({
        ResourceArn: group.scheduleGroupArn,
        Tags: [{ Key: "team", Value: "out-of-band" }],
      });

      const drifted = yield* waitForDrift(stack, "DriftSchedule", "drifted");
      expect(drifted?.attr?.configuration).toMatchObject({
        scheduleExpression: "rate(7 days)",
        flexibleTimeWindow: { Mode: "FLEXIBLE" },
      });
      const groupDrifted = yield* waitForDrift(stack, "DriftScheduleGroup", "drifted");
      expect(groupDrifted?.attr?.tags?.team).toBe("out-of-band");

      const repaired = yield* repairDrift(stack);
      expect(repaired.resources.DriftSchedule?.action).toBe("repaired");
      expect(repaired.resources.DriftScheduleGroup?.action).toBe("repaired");
      const after = yield* driftActions(stack);
      expect(Object.values(after).every((action) => action === "unchanged")).toBe(true);
      const restored = yield* scheduler.getSchedule({
        Name: schedule.scheduleName,
        GroupName: schedule.groupName,
      });
      expect(restored.ScheduleExpression).toBe("rate(1 hour)");
      expect(restored.FlexibleTimeWindow?.Mode).toBe("OFF");

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:iam",
      "provider:aws:scheduler",
      "provider:aws:sqs",
      "live",
    ],
    timeout: 240_000,
  },
);

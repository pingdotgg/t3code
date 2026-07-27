import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM";
import { Schedule } from "@/AWS/Scheduler/Schedule.ts";
import { Queue } from "@/AWS/SQS/Queue.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection across all
// schedule groups): deploy a real schedule (with the IAM role + SQS target it
// requires), resolve the provider from context via the typed `findProvider`,
// call `list()`, and assert the deployed schedule appears in the
// exhaustively-paginated result.
test.provider("list enumerates the deployed schedule", (stack) =>
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
                {
                  Effect: "Allow",
                  Action: ["sqs:SendMessage"],
                  Resource: [queue.queueArn],
                },
              ],
            },
          },
        });

        return yield* Schedule("ListSchedule", {
          name: "alchemy-test-schedule-list",
          scheduleExpression: "rate(1 hour)",
          flexibleTimeWindow: { Mode: "OFF" },
          target: {
            Arn: queue.queueArn,
            RoleArn: role.roleArn,
          },
        });
      }),
    );

    const provider = yield* Provider.findProvider(Schedule);
    const all = yield* provider.list();

    expect(all.some((s) => s.scheduleName === deployed.scheduleName)).toBe(
      true,
    );
    expect(
      all.some(
        (s) =>
          s.scheduleName === deployed.scheduleName &&
          s.scheduleArn === deployed.scheduleArn,
      ),
    ).toBe(true);

    yield* stack.destroy();
  }),
);

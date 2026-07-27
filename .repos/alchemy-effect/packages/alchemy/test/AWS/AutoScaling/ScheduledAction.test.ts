import * as AWS from "@/AWS";
import {
  AutoScalingGroup,
  LaunchTemplate,
  ScheduledAction,
} from "@/AWS/AutoScaling";
import { amazonLinux2023 } from "@/AWS/EC2";
import * as Test from "@/Test/Alchemy";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getAutoScalingTestSubnetId } from "./TestNetwork.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic, account-unique names so leftover cleanup from an interrupted
// run works. The action uses a cron `recurrence` (no StartTime) so nothing is
// scheduled in the past and no instances launch (min/max/desired 0).
const asgName = "alchemy-test-scheduled-action-asg";
const actionName = "alchemy-test-scheduled-action";

const cleanupAsg = autoscaling
  .deleteAutoScalingGroup({ AutoScalingGroupName: asgName, ForceDelete: true })
  .pipe(Effect.catch(() => Effect.void));

// `describeScheduledActions` for a deleted Auto Scaling Group raises AWS wire
// code `ValidationError` ("AutoScalingGroup ... not found"), typed as
// `AutoScalingGroupNotFound` via the auto-scaling distilled patch. Treat it as
// "action gone" for the out-of-band assertions after teardown.
const describeAction = autoscaling
  .describeScheduledActions({
    AutoScalingGroupName: asgName,
    ScheduledActionNames: [actionName],
  } as any)
  .pipe(
    Effect.map((r) => r.ScheduledUpdateGroupActions?.[0]),
    Effect.catchTag("AutoScalingGroupNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

test.provider(
  "creates, updates, and deletes a scheduled action on an ASG",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanupAsg;
      yield* stack.destroy();

      const imageId = (yield* amazonLinux2023()) ?? "ami-00000000000000000";

      const subnetId = yield* getAutoScalingTestSubnetId;

      const deployAction = (recurrence: string, desiredCapacity: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const template = yield* LaunchTemplate("ScheduleTemplate", {
              imageId,
              instanceType: "t3.micro",
            });
            const group = yield* AutoScalingGroup("ScheduleGroup", {
              autoScalingGroupName: asgName,
              launchTemplate: template,
              subnetIds: [subnetId],
              minSize: 0,
              maxSize: 0,
              desiredCapacity: 0,
            });
            return yield* ScheduledAction("Action", {
              scheduledActionName: actionName,
              autoScalingGroup: group.autoScalingGroupName,
              recurrence,
              timeZone: "America/New_York",
              minSize: 0,
              maxSize: 3,
              desiredCapacity,
            });
          }),
        );

      // Create — daily 09:00 recurrence.
      const created = yield* deployAction("0 9 * * *", 1);
      expect(created.scheduledActionName).toEqual(actionName);
      expect(created.autoScalingGroupName).toEqual(asgName);
      expect(created.recurrence).toEqual("0 9 * * *");
      expect(created.timeZone).toEqual("America/New_York");
      expect(created.minSize).toEqual(0);
      expect(created.maxSize).toEqual(3);
      expect(created.desiredCapacity).toEqual(1);
      expect(created.scheduledActionARN).toMatch(/^arn:aws:autoscaling:/);

      const liveCreated = yield* describeAction;
      expect(liveCreated?.ScheduledActionName).toEqual(actionName);
      expect(liveCreated?.Recurrence).toEqual("0 9 * * *");
      expect(liveCreated?.DesiredCapacity).toEqual(1);

      // Update the recurrence + desired capacity in place (same name → no
      // replacement).
      const updated = yield* deployAction("0 18 * * *", 2);
      expect(updated.scheduledActionName).toEqual(actionName);
      expect(updated.recurrence).toEqual("0 18 * * *");
      expect(updated.desiredCapacity).toEqual(2);

      const liveUpdated = yield* describeAction;
      expect(liveUpdated?.Recurrence).toEqual("0 18 * * *");
      expect(liveUpdated?.DesiredCapacity).toEqual(2);

      // Delete via stack teardown; assert the action is gone out-of-band.
      yield* stack.destroy();
      const gone = yield* describeAction.pipe(
        Effect.repeat({
          until: (action) => action === undefined,
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
        }),
      );
      expect(gone).toBeUndefined();

      // The ASG itself is deleted by the stack teardown too — prove the suite
      // left nothing behind.
      const groupsLeft = yield* autoscaling
        .describeAutoScalingGroups({ AutoScalingGroupNames: [asgName] } as any)
        .pipe(
          Effect.map((r) => (r.AutoScalingGroups ?? []).length),
          Effect.repeat({
            until: (count) => count === 0,
            schedule: Schedule.spaced("3 seconds"),
            times: 10,
          }),
        );
      expect(groupsLeft).toBe(0);
    }).pipe(Effect.ensuring(cleanupAsg)),
  { timeout: 240_000 },
);

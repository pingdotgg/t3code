import * as AWS from "@/AWS";
import {
  AutoScalingGroup,
  LaunchTemplate,
  LifecycleHook,
} from "@/AWS/AutoScaling";
import { amazonLinux2023 } from "@/AWS/EC2";
import * as Test from "@/Test/Alchemy";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import { expect } from "alchemy-test";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getAutoScalingTestSubnetId } from "./TestNetwork.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic, account-unique names so leftover cleanup from an interrupted
// run works. The fleet is sized to zero (min/max/desired 0) so no EC2 instances
// launch — the hook is created and observed against a stable, instance-free ASG.
const asgName = "alchemy-test-lifecycle-hook-asg";
const hookName = "alchemy-test-lifecycle-hook";

const cleanupAsg = autoscaling
  .deleteAutoScalingGroup({ AutoScalingGroupName: asgName, ForceDelete: true })
  .pipe(Effect.catch(() => Effect.void));

// `describeLifecycleHooks` for a deleted Auto Scaling Group raises AWS wire code
// `ValidationError` ("AutoScalingGroup ... not found"), typed as
// `AutoScalingGroupNotFound` via the auto-scaling distilled patch. Treat it as
// "hook gone" for the out-of-band assertions after teardown.
const describeHook = autoscaling
  .describeLifecycleHooks({
    AutoScalingGroupName: asgName,
    LifecycleHookNames: [hookName],
  } as any)
  .pipe(
    Effect.map((r) => r.LifecycleHooks?.[0]),
    Effect.catchTag("AutoScalingGroupNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

test.provider(
  "creates, updates, and deletes a lifecycle hook on an ASG",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanupAsg;
      yield* stack.destroy();

      // Launch templates do not validate the AMI at creation time; fall back to
      // a syntactically valid id if the lookup returns nothing.
      const imageId = (yield* amazonLinux2023()) ?? "ami-00000000000000000";

      // Place the fleet into a subnet of the account's default VPC (resolved
      // out-of-band) rather than a throwaway Vpc resource — a failed run loses
      // its scratch state and orphaned VPCs exhaust the 5-per-region quota.
      const subnetId = yield* getAutoScalingTestSubnetId;

      const deployHook = (heartbeatTimeout: Duration.Input) =>
        stack.deploy(
          Effect.gen(function* () {
            const template = yield* LaunchTemplate("HookTemplate", {
              imageId,
              instanceType: "t3.micro",
            });
            const group = yield* AutoScalingGroup("HookGroup", {
              autoScalingGroupName: asgName,
              launchTemplate: template,
              subnetIds: [subnetId],
              minSize: 0,
              maxSize: 0,
              desiredCapacity: 0,
            });
            return yield* LifecycleHook("Hook", {
              lifecycleHookName: hookName,
              autoScalingGroup: group,
              lifecycleTransition: "TERMINATING",
              heartbeatTimeout,
              defaultResult: "CONTINUE",
            });
          }),
        );

      // Create.
      const created = yield* deployHook("300 seconds");
      expect(created.lifecycleHookName).toEqual(hookName);
      expect(created.autoScalingGroupName).toEqual(asgName);
      expect(created.lifecycleTransition).toEqual(
        "autoscaling:EC2_INSTANCE_TERMINATING",
      );
      expect(created.heartbeatTimeout).toEqual(300);
      expect(created.defaultResult).toEqual("CONTINUE");

      // Out-of-band proof.
      const liveCreated = yield* describeHook;
      expect(liveCreated?.LifecycleHookName).toEqual(hookName);
      expect(liveCreated?.HeartbeatTimeout).toEqual(300);
      expect(liveCreated?.DefaultResult).toEqual("CONTINUE");

      // Update the heartbeat timeout in place (same name → no replacement).
      const updated = yield* deployHook("120 seconds");
      expect(updated.lifecycleHookName).toEqual(hookName);
      expect(updated.heartbeatTimeout).toEqual(120);

      const liveUpdated = yield* describeHook;
      expect(liveUpdated?.HeartbeatTimeout).toEqual(120);

      // Delete via stack teardown; assert the hook is gone out-of-band.
      yield* stack.destroy();
      const gone = yield* describeHook.pipe(
        Effect.repeat({
          until: (hook) => hook === undefined,
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

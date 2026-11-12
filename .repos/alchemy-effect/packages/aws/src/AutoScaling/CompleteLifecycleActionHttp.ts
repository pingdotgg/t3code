import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";
import {
  CompleteLifecycleAction,
  type CompleteLifecycleActionRequest,
  type RecordLifecycleActionHeartbeatRequest,
} from "./CompleteLifecycleAction.ts";

export const CompleteLifecycleActionHttp = Layer.effect(
  CompleteLifecycleAction,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const complete = yield* AWSBindings.withCredentials(autoscaling.completeLifecycleAction);
    const heartbeat = yield* AWSBindings.withCredentials(
      autoscaling.recordLifecycleActionHeartbeat,
    );

    return Effect.fn(function* (group: AutoScalingGroup) {
      const AutoScalingGroupName = yield* group.autoScalingGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.AutoScaling.CompleteLifecycleAction(${group})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "autoscaling:CompleteLifecycleAction",
                "autoscaling:RecordLifecycleActionHeartbeat",
              ],
              Resource: [group.autoScalingGroupArn],
            },
          ],
        });
      }
      return {
        complete: Effect.fn(`AWS.AutoScaling.CompleteLifecycleAction(${group.LogicalId})`)(
          function* (request: CompleteLifecycleActionRequest) {
            return yield* complete({
              ...request,
              AutoScalingGroupName: yield* AutoScalingGroupName,
            });
          },
        ),
        heartbeat: Effect.fn(`AWS.AutoScaling.RecordLifecycleActionHeartbeat(${group.LogicalId})`)(
          function* (request: RecordLifecycleActionHeartbeatRequest) {
            return yield* heartbeat({
              ...request,
              AutoScalingGroupName: yield* AutoScalingGroupName,
            });
          },
        ),
      };
    });
  }),
);

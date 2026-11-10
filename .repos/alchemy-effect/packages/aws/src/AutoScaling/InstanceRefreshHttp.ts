import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";
import {
  InstanceRefresh,
  type CancelInstanceRefreshRequest,
  type DescribeInstanceRefreshesRequest,
  type StartInstanceRefreshRequest,
} from "./InstanceRefresh.ts";

// Bespoke (not the shared scaffold): a multi-operation client over the four
// instance refresh operations behind one two-statement IAM grant (the write
// actions are group-scoped, Describe* only supports `*`).
export const InstanceRefreshHttp = Layer.effect(
  InstanceRefresh,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const start = yield* AWSBindings.withCredentials(autoscaling.startInstanceRefresh);
    const cancel = yield* AWSBindings.withCredentials(autoscaling.cancelInstanceRefresh);
    const rollback = yield* AWSBindings.withCredentials(autoscaling.rollbackInstanceRefresh);
    const describe = yield* AWSBindings.withCredentials(autoscaling.describeInstanceRefreshes);

    return Effect.fn(function* (group: AutoScalingGroup) {
      const AutoScalingGroupName = yield* group.autoScalingGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.AutoScaling.InstanceRefresh(${group})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "autoscaling:StartInstanceRefresh",
                "autoscaling:CancelInstanceRefresh",
                "autoscaling:RollbackInstanceRefresh",
              ],
              Resource: [group.autoScalingGroupArn],
            },
            {
              Effect: "Allow",
              Action: ["autoscaling:DescribeInstanceRefreshes"],
              Resource: ["*"],
            },
          ],
        });
      }
      return {
        start: Effect.fn(`AWS.AutoScaling.StartInstanceRefresh(${group.LogicalId})`)(function* (
          request?: StartInstanceRefreshRequest,
        ) {
          return yield* start({
            ...request,
            AutoScalingGroupName: yield* AutoScalingGroupName,
          });
        }),
        cancel: Effect.fn(`AWS.AutoScaling.CancelInstanceRefresh(${group.LogicalId})`)(function* (
          request?: CancelInstanceRefreshRequest,
        ) {
          return yield* cancel({
            ...request,
            AutoScalingGroupName: yield* AutoScalingGroupName,
          });
        }),
        rollback: Effect.fn(`AWS.AutoScaling.RollbackInstanceRefresh(${group.LogicalId})`)(
          function* () {
            return yield* rollback({
              AutoScalingGroupName: yield* AutoScalingGroupName,
            });
          },
        ),
        describe: Effect.fn(`AWS.AutoScaling.DescribeInstanceRefreshes(${group.LogicalId})`)(
          function* (request?: DescribeInstanceRefreshesRequest) {
            return yield* describe({
              ...request,
              AutoScalingGroupName: yield* AutoScalingGroupName,
            });
          },
        ),
      };
    });
  }),
);

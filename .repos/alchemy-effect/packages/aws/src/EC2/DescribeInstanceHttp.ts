import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { DescribeInstance } from "./DescribeInstance.ts";
import { type Instance } from "./Instance.ts";

// Bespoke (not the shared scaffold): `describeInstances` nests results under
// Reservations[].Instances[] and the client unwraps the single bound
// instance.
export const DescribeInstanceHttp = Layer.effect(
  DescribeInstance,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const describe = yield* AWSBindings.withCredentials(ec2.describeInstances);

    return Effect.fn(function* (instance: Instance) {
      const instanceId = yield* instance.instanceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.EC2.DescribeInstance(${instance})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["ec2:DescribeInstances"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.EC2.DescribeInstance(${instance.LogicalId})`)(function* () {
        const result = yield* describe({
          InstanceIds: [yield* instanceId],
        });
        return result.Reservations?.[0]?.Instances?.[0];
      });
    });
  }),
);

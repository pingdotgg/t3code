import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { ListEffectiveDeployments } from "./ListEffectiveDeployments.ts";

export const ListEffectiveDeploymentsHttp = Layer.effect(
  ListEffectiveDeployments,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.ListEffectiveDeployments",
    operation: greengrassv2.listEffectiveDeployments,
    // Effective deployments are backed by IoT Jobs; enumerating them resolves
    // each job, its execution on the device, and the thing/thing-group target
    // with the caller's credentials (documented dependent actions).
    actions: [
      "greengrass:ListEffectiveDeployments",
      "iot:DescribeJob",
      "iot:DescribeJobExecution",
      "iot:DescribeThing",
      "iot:DescribeThingGroup",
      "iot:GetThingShadow",
    ],
  }),
);

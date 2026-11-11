import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { ListDeployments } from "./ListDeployments.ts";

export const ListDeploymentsHttp = Layer.effect(
  ListDeployments,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.ListDeployments",
    operation: greengrassv2.listDeployments,
    // Enumerating deployments resolves each deployment's backing IoT Job
    // and thing/thing-group target with the caller's credentials.
    actions: [
      "greengrass:ListDeployments",
      "iot:DescribeJob",
      "iot:DescribeThing",
      "iot:DescribeThingGroup",
      "iot:GetThingShadow",
    ],
  }),
);

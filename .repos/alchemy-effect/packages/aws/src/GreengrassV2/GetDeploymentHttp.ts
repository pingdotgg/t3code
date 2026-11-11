import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassDeploymentHttpBinding } from "./BindingHttp.ts";
import { GetDeployment } from "./GetDeployment.ts";

export const GetDeploymentHttp = Layer.effect(
  GetDeployment,
  makeGreengrassDeploymentHttpBinding({
    tag: "AWS.GreengrassV2.GetDeployment",
    operation: greengrassv2.getDeployment,
    actions: ["greengrass:GetDeployment"],
    // Deployments are backed by IoT Jobs; reading one resolves the job and
    // the thing/thing-group target with the caller's credentials.
    dependentActions: [
      "iot:DescribeJob",
      "iot:DescribeThing",
      "iot:DescribeThingGroup",
      "iot:GetThingShadow",
    ],
  }),
);

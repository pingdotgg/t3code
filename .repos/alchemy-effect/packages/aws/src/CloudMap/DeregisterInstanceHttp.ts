import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Layer from "effect/Layer";
import { makeCloudMapServiceHttpBinding } from "./BindingHttp.ts";
import { DeregisterInstance } from "./DeregisterInstance.ts";

export const DeregisterInstanceHttp = Layer.effect(
  DeregisterInstance,
  makeCloudMapServiceHttpBinding({
    tag: "AWS.CloudMap.DeregisterInstance",
    operation: SD.deregisterInstance,
    actions: ["servicediscovery:DeregisterInstance"],
    extraStatements: [
      {
        // Cloud Map deletes the Route 53 records/health check it created
        // for the instance; these actions have no resource-level scoping
        // for this use.
        Effect: "Allow",
        Action: [
          "route53:GetHealthCheck",
          "route53:DeleteHealthCheck",
          "route53:UpdateHealthCheck",
          "route53:ChangeResourceRecordSets",
        ],
        Resource: ["*"],
      },
    ],
  }),
);

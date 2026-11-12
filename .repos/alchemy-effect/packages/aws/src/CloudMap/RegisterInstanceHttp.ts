import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Layer from "effect/Layer";
import { makeCloudMapServiceHttpBinding } from "./BindingHttp.ts";
import { RegisterInstance } from "./RegisterInstance.ts";

export const RegisterInstanceHttp = Layer.effect(
  RegisterInstance,
  makeCloudMapServiceHttpBinding({
    tag: "AWS.CloudMap.RegisterInstance",
    operation: SD.registerInstance,
    actions: ["servicediscovery:RegisterInstance"],
    extraStatements: [
      {
        // For DNS services Cloud Map creates Route 53 records and
        // (optionally) health checks on the caller's behalf; these
        // actions have no resource-level scoping for this use.
        Effect: "Allow",
        Action: [
          "route53:GetHealthCheck",
          "route53:CreateHealthCheck",
          "route53:UpdateHealthCheck",
          "route53:ChangeResourceRecordSets",
          "ec2:DescribeInstances",
        ],
        Resource: ["*"],
      },
    ],
  }),
);

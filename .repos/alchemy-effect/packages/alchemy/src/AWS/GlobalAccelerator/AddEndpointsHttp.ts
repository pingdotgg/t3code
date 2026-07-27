import * as ga from "@distilled.cloud/aws/global-accelerator";
import * as Layer from "effect/Layer";
import { AddEndpoints } from "./AddEndpoints.ts";
import { makeGaEndpointGroupHttpBinding } from "./BindingHttp.ts";

export const AddEndpointsHttp = Layer.effect(
  AddEndpoints,
  makeGaEndpointGroupHttpBinding({
    tag: "AWS.GlobalAccelerator.AddEndpoints",
    operation: ga.addEndpoints,
    // Global Accelerator authorizes AddEndpoints as an update to the
    // endpoint group ("not authorized to perform:
    // globalaccelerator:UpdateEndpointGroup" when only AddEndpoints is
    // granted), so both actions are required.
    actions: [
      "globalaccelerator:AddEndpoints",
      "globalaccelerator:UpdateEndpointGroup",
    ],
    // Global Accelerator validates new endpoints by describing them on the
    // caller's behalf, so adding endpoints requires read access to the
    // underlying EC2 / ELB resources (none support resource-level scoping).
    // https://docs.aws.amazon.com/global-accelerator/latest/dg/security_iam_service-with-iam.html
    extraStatements: [
      {
        Effect: "Allow",
        Action: [
          "ec2:DescribeAddresses",
          "ec2:DescribeInstances",
          "ec2:DescribeInternetGateways",
          "ec2:DescribeSubnets",
          "elasticloadbalancing:DescribeLoadBalancers",
        ],
        Resource: ["*"],
      },
    ],
  }),
);

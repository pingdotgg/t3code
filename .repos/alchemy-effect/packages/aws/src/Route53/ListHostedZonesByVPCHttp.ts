import * as route53 from "@distilled.cloud/aws/route-53";
import * as Layer from "effect/Layer";
import { makeRoute53AccountHttpBinding } from "./BindingHttp.ts";
import { ListHostedZonesByVPC } from "./ListHostedZonesByVPC.ts";

export const ListHostedZonesByVPCHttp = Layer.effect(
  ListHostedZonesByVPC,
  makeRoute53AccountHttpBinding({
    tag: "AWS.Route53.ListHostedZonesByVPC",
    operation: route53.listHostedZonesByVPC,
    // Route 53 verifies the VPC on the caller's behalf via ec2:DescribeVpcs —
    // without that grant every call fails with AccessDeniedException
    // ("Failed to verify the given VPC by calling ec2:DescribeVpcs").
    actions: ["route53:ListHostedZonesByVPC", "ec2:DescribeVpcs"],
  }),
);

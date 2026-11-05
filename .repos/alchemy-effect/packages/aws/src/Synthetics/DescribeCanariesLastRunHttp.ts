import * as synthetics from "@distilled.cloud/aws/synthetics";
import * as Layer from "effect/Layer";
import { makeSyntheticsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeCanariesLastRun } from "./DescribeCanariesLastRun.ts";

export const DescribeCanariesLastRunHttp = Layer.effect(
  DescribeCanariesLastRun,
  makeSyntheticsAccountHttpBinding({
    tag: "AWS.Synthetics.DescribeCanariesLastRun",
    operation: synthetics.describeCanariesLastRun,
    actions: ["synthetics:DescribeCanariesLastRun"],
  }),
);

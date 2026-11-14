import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeReleaseLabel } from "./DescribeReleaseLabel.ts";

export const DescribeReleaseLabelHttp = Layer.effect(
  DescribeReleaseLabel,
  makeEmrAccountHttpBinding({
    tag: "AWS.EMR.DescribeReleaseLabel",
    operation: emr.describeReleaseLabel,
    actions: ["elasticmapreduce:DescribeReleaseLabel"],
  }),
);

import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeVolumes } from "./DescribeVolumes.ts";

export const DescribeVolumesHttp = Layer.effect(
  DescribeVolumes,
  makeFSxAccountHttpBinding({
    tag: "AWS.FSx.DescribeVolumes",
    operation: fsx.describeVolumes,
    actions: ["fsx:DescribeVolumes"],
  }),
);

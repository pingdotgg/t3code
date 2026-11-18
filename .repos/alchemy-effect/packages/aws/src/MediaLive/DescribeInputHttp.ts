import * as medialive from "@distilled.cloud/aws/medialive";
import * as Layer from "effect/Layer";
import { makeMediaLiveInputHttpBinding } from "./BindingHttp.ts";
import { DescribeInput } from "./DescribeInput.ts";

export const DescribeInputHttp = Layer.effect(
  DescribeInput,
  makeMediaLiveInputHttpBinding({
    tag: "AWS.MediaLive.DescribeInput",
    operation: medialive.describeInput,
    actions: ["medialive:DescribeInput"],
  }),
);

import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Layer from "effect/Layer";
import { makeMediaConnectFlowHttpBinding } from "./BindingHttp.ts";
import { DescribeFlow } from "./DescribeFlow.ts";

export const DescribeFlowHttp = Layer.effect(
  DescribeFlow,
  makeMediaConnectFlowHttpBinding({
    tag: "AWS.MediaConnect.DescribeFlow",
    operation: mediaconnect.describeFlow,
    actions: ["mediaconnect:DescribeFlow"],
  }),
);

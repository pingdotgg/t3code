import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Layer from "effect/Layer";
import { makeMediaConnectFlowHttpBinding } from "./BindingHttp.ts";
import { DescribeFlowSourceMetadata } from "./DescribeFlowSourceMetadata.ts";

export const DescribeFlowSourceMetadataHttp = Layer.effect(
  DescribeFlowSourceMetadata,
  makeMediaConnectFlowHttpBinding({
    tag: "AWS.MediaConnect.DescribeFlowSourceMetadata",
    operation: mediaconnect.describeFlowSourceMetadata,
    actions: ["mediaconnect:DescribeFlowSourceMetadata"],
  }),
);

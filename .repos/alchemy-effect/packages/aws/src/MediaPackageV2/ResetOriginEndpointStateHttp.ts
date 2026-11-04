import * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import * as Layer from "effect/Layer";
import { makeMediaPackageV2OriginEndpointHttpBinding } from "./BindingHttp.ts";
import { ResetOriginEndpointState } from "./ResetOriginEndpointState.ts";

export const ResetOriginEndpointStateHttp = Layer.effect(
  ResetOriginEndpointState,
  makeMediaPackageV2OriginEndpointHttpBinding({
    tag: "AWS.MediaPackageV2.ResetOriginEndpointState",
    operation: mediapackagev2.resetOriginEndpointState,
    actions: ["mediapackagev2:ResetOriginEndpointState"],
  }),
);

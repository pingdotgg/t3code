import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Layer from "effect/Layer";
import { makeMediaConnectFlowHttpBinding } from "./BindingHttp.ts";
import { RevokeFlowEntitlement } from "./RevokeFlowEntitlement.ts";

export const RevokeFlowEntitlementHttp = Layer.effect(
  RevokeFlowEntitlement,
  makeMediaConnectFlowHttpBinding({
    tag: "AWS.MediaConnect.RevokeFlowEntitlement",
    operation: mediaconnect.revokeFlowEntitlement,
    actions: ["mediaconnect:RevokeFlowEntitlement"],
    // The IAM resource types for RevokeFlowEntitlement are the flow AND
    // the entitlement; entitlement ARNs are siblings of (not derived
    // from) the flow ARN, so they are granted by wildcard.
    extraResources: ["arn:aws:mediaconnect:*:*:entitlement:*"],
  }),
);

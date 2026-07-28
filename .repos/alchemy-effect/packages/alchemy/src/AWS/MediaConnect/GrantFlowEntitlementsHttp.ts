import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Layer from "effect/Layer";
import { makeMediaConnectFlowHttpBinding } from "./BindingHttp.ts";
import { GrantFlowEntitlements } from "./GrantFlowEntitlements.ts";

export const GrantFlowEntitlementsHttp = Layer.effect(
  GrantFlowEntitlements,
  makeMediaConnectFlowHttpBinding({
    tag: "AWS.MediaConnect.GrantFlowEntitlements",
    operation: mediaconnect.grantFlowEntitlements,
    actions: ["mediaconnect:GrantFlowEntitlements"],
    // The IAM resource types for GrantFlowEntitlements are the flow AND
    // the entitlement; entitlement ARNs are siblings of (not derived
    // from) the flow ARN, so they are granted by wildcard.
    extraResources: ["arn:aws:mediaconnect:*:*:entitlement:*"],
  }),
);

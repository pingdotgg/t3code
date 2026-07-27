import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Layer from "effect/Layer";
import { makeMediaConnectAccountHttpBinding } from "./BindingHttp.ts";
import { ListEntitlements } from "./ListEntitlements.ts";

export const ListEntitlementsHttp = Layer.effect(
  ListEntitlements,
  makeMediaConnectAccountHttpBinding({
    tag: "AWS.MediaConnect.ListEntitlements",
    operation: mediaconnect.listEntitlements,
    actions: ["mediaconnect:ListEntitlements"],
  }),
);

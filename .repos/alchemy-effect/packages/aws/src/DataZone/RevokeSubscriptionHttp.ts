import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { RevokeSubscription } from "./RevokeSubscription.ts";

export const RevokeSubscriptionHttp = Layer.effect(
  RevokeSubscription,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.RevokeSubscription",
    operation: datazone.revokeSubscription,
    actions: ["datazone:RevokeSubscription"],
  }),
);

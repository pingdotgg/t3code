import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { CancelSubscription } from "./CancelSubscription.ts";

export const CancelSubscriptionHttp = Layer.effect(
  CancelSubscription,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.CancelSubscription",
    operation: datazone.cancelSubscription,
    actions: ["datazone:CancelSubscription"],
  }),
);

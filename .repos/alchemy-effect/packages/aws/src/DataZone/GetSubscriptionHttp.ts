import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { GetSubscription } from "./GetSubscription.ts";

export const GetSubscriptionHttp = Layer.effect(
  GetSubscription,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.GetSubscription",
    operation: datazone.getSubscription,
    actions: ["datazone:GetSubscription"],
  }),
);

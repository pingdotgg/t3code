import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { AcceptSubscriptionRequest } from "./AcceptSubscriptionRequest.ts";

export const AcceptSubscriptionRequestHttp = Layer.effect(
  AcceptSubscriptionRequest,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.AcceptSubscriptionRequest",
    operation: datazone.acceptSubscriptionRequest,
    actions: ["datazone:AcceptSubscriptionRequest"],
  }),
);

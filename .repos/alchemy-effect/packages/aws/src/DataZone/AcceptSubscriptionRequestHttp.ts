import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { AcceptSubscriptionRequest } from "./AcceptSubscriptionRequest.ts";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";

export const AcceptSubscriptionRequestHttp = Layer.effect(
  AcceptSubscriptionRequest,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.AcceptSubscriptionRequest",
    operation: datazone.acceptSubscriptionRequest,
    actions: ["datazone:AcceptSubscriptionRequest"],
  }),
);

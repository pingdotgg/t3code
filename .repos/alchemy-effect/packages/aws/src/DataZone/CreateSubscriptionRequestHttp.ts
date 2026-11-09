import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { CreateSubscriptionRequest } from "./CreateSubscriptionRequest.ts";

export const CreateSubscriptionRequestHttp = Layer.effect(
  CreateSubscriptionRequest,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.CreateSubscriptionRequest",
    operation: datazone.createSubscriptionRequest,
    actions: ["datazone:CreateSubscriptionRequest"],
  }),
);

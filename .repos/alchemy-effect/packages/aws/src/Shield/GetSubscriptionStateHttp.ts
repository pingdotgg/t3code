import * as shield from "@distilled.cloud/aws/shield";
import * as Layer from "effect/Layer";
import { makeShieldHttpBinding } from "./BindingHttp.ts";
import { GetSubscriptionState } from "./GetSubscriptionState.ts";

export const GetSubscriptionStateHttp = Layer.effect(
  GetSubscriptionState,
  makeShieldHttpBinding({
    tag: "AWS.Shield.GetSubscriptionState",
    operation: shield.getSubscriptionState,
    actions: ["shield:GetSubscriptionState"],
  }),
);

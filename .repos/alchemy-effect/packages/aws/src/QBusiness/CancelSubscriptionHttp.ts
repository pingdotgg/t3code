import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { CancelSubscription } from "./CancelSubscription.ts";

export const CancelSubscriptionHttp = Layer.effect(
  CancelSubscription,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.CancelSubscription",
    operation: qbusiness.cancelSubscription,
    actions: ["qbusiness:CancelSubscription"],
  }),
);

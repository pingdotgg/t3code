import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { UpdateSubscription } from "./UpdateSubscription.ts";

export const UpdateSubscriptionHttp = Layer.effect(
  UpdateSubscription,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.UpdateSubscription",
    operation: qbusiness.updateSubscription,
    actions: ["qbusiness:UpdateSubscription"],
  }),
);

import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { ListSubscriptions } from "./ListSubscriptions.ts";

export const ListSubscriptionsHttp = Layer.effect(
  ListSubscriptions,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.ListSubscriptions",
    operation: qbusiness.listSubscriptions,
    actions: ["qbusiness:ListSubscriptions"],
  }),
);

import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { ListSubscriptions } from "./ListSubscriptions.ts";

export const ListSubscriptionsHttp = Layer.effect(
  ListSubscriptions,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.ListSubscriptions",
    operation: sns.listSubscriptions,
    actions: ["sns:ListSubscriptions"],
  }),
);

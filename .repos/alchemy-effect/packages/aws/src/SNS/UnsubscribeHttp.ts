import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { Unsubscribe } from "./Unsubscribe.ts";

export const UnsubscribeHttp = Layer.effect(
  Unsubscribe,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.Unsubscribe",
    operation: sns.unsubscribe,
    actions: ["sns:Unsubscribe"],
  }),
);

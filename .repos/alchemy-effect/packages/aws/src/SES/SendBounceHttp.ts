import * as ses from "@distilled.cloud/aws/ses";
import * as Layer from "effect/Layer";
import { makeSESHttpBinding } from "./BindingHttp.ts";
import { SendBounce } from "./SendBounce.ts";

export const SendBounceHttp = Layer.effect(
  SendBounce,
  makeSESHttpBinding({
    tag: "AWS.SES.SendBounce",
    operation: ses.sendBounce,
    actions: ["ses:SendBounce"],
  }),
);

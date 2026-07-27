import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { GetWhatsAppFlow } from "./GetWhatsAppFlow.ts";

export const GetWhatsAppFlowHttp = Layer.effect(
  GetWhatsAppFlow,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.GetWhatsAppFlow",
    operation: socialmessaging.getWhatsAppFlow,
    actions: ["social-messaging:GetWhatsAppFlow"],
  }),
);

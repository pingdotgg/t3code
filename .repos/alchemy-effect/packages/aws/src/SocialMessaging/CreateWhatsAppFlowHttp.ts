import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { CreateWhatsAppFlow } from "./CreateWhatsAppFlow.ts";

export const CreateWhatsAppFlowHttp = Layer.effect(
  CreateWhatsAppFlow,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.CreateWhatsAppFlow",
    operation: socialmessaging.createWhatsAppFlow,
    actions: ["social-messaging:CreateWhatsAppFlow"],
  }),
);

import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { UpdateWhatsAppFlow } from "./UpdateWhatsAppFlow.ts";

export const UpdateWhatsAppFlowHttp = Layer.effect(
  UpdateWhatsAppFlow,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.UpdateWhatsAppFlow",
    operation: socialmessaging.updateWhatsAppFlow,
    actions: ["social-messaging:UpdateWhatsAppFlow"],
  }),
);

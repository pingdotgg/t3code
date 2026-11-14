import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { DeleteWhatsAppFlow } from "./DeleteWhatsAppFlow.ts";

export const DeleteWhatsAppFlowHttp = Layer.effect(
  DeleteWhatsAppFlow,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.DeleteWhatsAppFlow",
    operation: socialmessaging.deleteWhatsAppFlow,
    actions: ["social-messaging:DeleteWhatsAppFlow"],
  }),
);

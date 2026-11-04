import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { GetWhatsAppMessageTemplate } from "./GetWhatsAppMessageTemplate.ts";

export const GetWhatsAppMessageTemplateHttp = Layer.effect(
  GetWhatsAppMessageTemplate,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.GetWhatsAppMessageTemplate",
    operation: socialmessaging.getWhatsAppMessageTemplate,
    actions: ["social-messaging:GetWhatsAppMessageTemplate"],
  }),
);

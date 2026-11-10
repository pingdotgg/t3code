import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { CreateWhatsAppMessageTemplate } from "./CreateWhatsAppMessageTemplate.ts";

export const CreateWhatsAppMessageTemplateHttp = Layer.effect(
  CreateWhatsAppMessageTemplate,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.CreateWhatsAppMessageTemplate",
    operation: socialmessaging.createWhatsAppMessageTemplate,
    actions: ["social-messaging:CreateWhatsAppMessageTemplate"],
  }),
);

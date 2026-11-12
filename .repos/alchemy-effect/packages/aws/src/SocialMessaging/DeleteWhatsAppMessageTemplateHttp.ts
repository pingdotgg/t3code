import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { DeleteWhatsAppMessageTemplate } from "./DeleteWhatsAppMessageTemplate.ts";

export const DeleteWhatsAppMessageTemplateHttp = Layer.effect(
  DeleteWhatsAppMessageTemplate,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.DeleteWhatsAppMessageTemplate",
    operation: socialmessaging.deleteWhatsAppMessageTemplate,
    actions: ["social-messaging:DeleteWhatsAppMessageTemplate"],
  }),
);

import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { UpdateWhatsAppMessageTemplate } from "./UpdateWhatsAppMessageTemplate.ts";

export const UpdateWhatsAppMessageTemplateHttp = Layer.effect(
  UpdateWhatsAppMessageTemplate,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.UpdateWhatsAppMessageTemplate",
    operation: socialmessaging.updateWhatsAppMessageTemplate,
    actions: ["social-messaging:UpdateWhatsAppMessageTemplate"],
  }),
);

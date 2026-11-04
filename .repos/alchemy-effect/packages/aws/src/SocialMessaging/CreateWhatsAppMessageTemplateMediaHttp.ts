import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { CreateWhatsAppMessageTemplateMedia } from "./CreateWhatsAppMessageTemplateMedia.ts";

export const CreateWhatsAppMessageTemplateMediaHttp = Layer.effect(
  CreateWhatsAppMessageTemplateMedia,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.CreateWhatsAppMessageTemplateMedia",
    operation: socialmessaging.createWhatsAppMessageTemplateMedia,
    actions: ["social-messaging:CreateWhatsAppMessageTemplateMedia"],
  }),
);

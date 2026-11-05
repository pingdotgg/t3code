import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { CreateWhatsAppMessageTemplateFromLibrary } from "./CreateWhatsAppMessageTemplateFromLibrary.ts";

export const CreateWhatsAppMessageTemplateFromLibraryHttp = Layer.effect(
  CreateWhatsAppMessageTemplateFromLibrary,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.CreateWhatsAppMessageTemplateFromLibrary",
    operation: socialmessaging.createWhatsAppMessageTemplateFromLibrary,
    actions: ["social-messaging:CreateWhatsAppMessageTemplateFromLibrary"],
  }),
);

import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { ListWhatsAppMessageTemplates } from "./ListWhatsAppMessageTemplates.ts";

export const ListWhatsAppMessageTemplatesHttp = Layer.effect(
  ListWhatsAppMessageTemplates,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.ListWhatsAppMessageTemplates",
    operation: socialmessaging.listWhatsAppMessageTemplates,
    actions: ["social-messaging:ListWhatsAppMessageTemplates"],
  }),
);

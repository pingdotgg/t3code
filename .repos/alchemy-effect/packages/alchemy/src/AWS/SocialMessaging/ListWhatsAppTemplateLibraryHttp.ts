import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { ListWhatsAppTemplateLibrary } from "./ListWhatsAppTemplateLibrary.ts";

export const ListWhatsAppTemplateLibraryHttp = Layer.effect(
  ListWhatsAppTemplateLibrary,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.ListWhatsAppTemplateLibrary",
    operation: socialmessaging.listWhatsAppTemplateLibrary,
    actions: ["social-messaging:ListWhatsAppTemplateLibrary"],
  }),
);

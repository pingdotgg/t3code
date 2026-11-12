import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaPhonePlaneHttpBinding } from "./BindingHttp.ts";
import { DeleteWhatsAppMessageMedia } from "./DeleteWhatsAppMessageMedia.ts";

export const DeleteWhatsAppMessageMediaHttp = Layer.effect(
  DeleteWhatsAppMessageMedia,
  makeWabaPhonePlaneHttpBinding({
    tag: "AWS.SocialMessaging.DeleteWhatsAppMessageMedia",
    operation: socialmessaging.deleteWhatsAppMessageMedia,
    actions: ["social-messaging:DeleteWhatsAppMessageMedia"],
  }),
);

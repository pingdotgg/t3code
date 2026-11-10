import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaPhonePlaneHttpBinding } from "./BindingHttp.ts";
import { GetWhatsAppMessageMedia } from "./GetWhatsAppMessageMedia.ts";

export const GetWhatsAppMessageMediaHttp = Layer.effect(
  GetWhatsAppMessageMedia,
  makeWabaPhonePlaneHttpBinding({
    tag: "AWS.SocialMessaging.GetWhatsAppMessageMedia",
    operation: socialmessaging.getWhatsAppMessageMedia,
    actions: ["social-messaging:GetWhatsAppMessageMedia"],
  }),
);

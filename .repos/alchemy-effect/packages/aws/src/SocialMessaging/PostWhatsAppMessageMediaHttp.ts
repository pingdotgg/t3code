import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaPhonePlaneHttpBinding } from "./BindingHttp.ts";
import { PostWhatsAppMessageMedia } from "./PostWhatsAppMessageMedia.ts";

export const PostWhatsAppMessageMediaHttp = Layer.effect(
  PostWhatsAppMessageMedia,
  makeWabaPhonePlaneHttpBinding({
    tag: "AWS.SocialMessaging.PostWhatsAppMessageMedia",
    operation: socialmessaging.postWhatsAppMessageMedia,
    actions: ["social-messaging:PostWhatsAppMessageMedia"],
  }),
);

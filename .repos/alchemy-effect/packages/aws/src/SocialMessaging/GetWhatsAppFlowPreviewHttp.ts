import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { GetWhatsAppFlowPreview } from "./GetWhatsAppFlowPreview.ts";

export const GetWhatsAppFlowPreviewHttp = Layer.effect(
  GetWhatsAppFlowPreview,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.GetWhatsAppFlowPreview",
    operation: socialmessaging.getWhatsAppFlowPreview,
    actions: ["social-messaging:GetWhatsAppFlowPreview"],
  }),
);

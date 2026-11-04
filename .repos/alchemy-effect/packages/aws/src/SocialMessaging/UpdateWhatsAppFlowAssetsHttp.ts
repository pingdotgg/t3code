import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { UpdateWhatsAppFlowAssets } from "./UpdateWhatsAppFlowAssets.ts";

export const UpdateWhatsAppFlowAssetsHttp = Layer.effect(
  UpdateWhatsAppFlowAssets,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.UpdateWhatsAppFlowAssets",
    operation: socialmessaging.updateWhatsAppFlowAssets,
    actions: ["social-messaging:UpdateWhatsAppFlowAssets"],
  }),
);

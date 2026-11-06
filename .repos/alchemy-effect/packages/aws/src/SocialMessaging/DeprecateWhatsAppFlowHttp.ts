import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { DeprecateWhatsAppFlow } from "./DeprecateWhatsAppFlow.ts";

export const DeprecateWhatsAppFlowHttp = Layer.effect(
  DeprecateWhatsAppFlow,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.DeprecateWhatsAppFlow",
    operation: socialmessaging.deprecateWhatsAppFlow,
    actions: ["social-messaging:DeprecateWhatsAppFlow"],
  }),
);

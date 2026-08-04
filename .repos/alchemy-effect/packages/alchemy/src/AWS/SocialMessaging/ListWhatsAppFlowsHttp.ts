import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaScopedHttpBinding } from "./BindingHttp.ts";
import { ListWhatsAppFlows } from "./ListWhatsAppFlows.ts";

export const ListWhatsAppFlowsHttp = Layer.effect(
  ListWhatsAppFlows,
  makeWabaScopedHttpBinding({
    tag: "AWS.SocialMessaging.ListWhatsAppFlows",
    operation: socialmessaging.listWhatsAppFlows,
    actions: ["social-messaging:ListWhatsAppFlows"],
  }),
);

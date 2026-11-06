import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Layer from "effect/Layer";
import { makeWabaPhonePlaneHttpBinding } from "./BindingHttp.ts";
import { GetLinkedWhatsAppBusinessAccountPhoneNumber } from "./GetLinkedWhatsAppBusinessAccountPhoneNumber.ts";

export const GetLinkedWhatsAppBusinessAccountPhoneNumberHttp = Layer.effect(
  GetLinkedWhatsAppBusinessAccountPhoneNumber,
  makeWabaPhonePlaneHttpBinding({
    tag: "AWS.SocialMessaging.GetLinkedWhatsAppBusinessAccountPhoneNumber",
    operation: socialmessaging.getLinkedWhatsAppBusinessAccountPhoneNumber,
    actions: ["social-messaging:GetLinkedWhatsAppBusinessAccountPhoneNumber"],
  }),
);

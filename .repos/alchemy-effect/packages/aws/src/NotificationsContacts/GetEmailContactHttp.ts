import * as contacts from "@distilled.cloud/aws/notificationscontacts";
import * as Layer from "effect/Layer";
import { makeEmailContactHttpBinding } from "./BindingHttp.ts";
import { GetEmailContact } from "./GetEmailContact.ts";

export const GetEmailContactHttp = Layer.effect(
  GetEmailContact,
  makeEmailContactHttpBinding({
    tag: "AWS.NotificationsContacts.GetEmailContact",
    actions: ["notifications-contacts:GetEmailContact"],
    operation: contacts.getEmailContact,
  }),
);

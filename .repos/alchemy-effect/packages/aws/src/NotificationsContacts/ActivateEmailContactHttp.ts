import * as contacts from "@distilled.cloud/aws/notificationscontacts";
import * as Layer from "effect/Layer";
import { ActivateEmailContact } from "./ActivateEmailContact.ts";
import { makeEmailContactHttpBinding } from "./BindingHttp.ts";

export const ActivateEmailContactHttp = Layer.effect(
  ActivateEmailContact,
  makeEmailContactHttpBinding({
    tag: "AWS.NotificationsContacts.ActivateEmailContact",
    actions: ["notifications-contacts:ActivateEmailContact"],
    operation: contacts.activateEmailContact,
  }),
);

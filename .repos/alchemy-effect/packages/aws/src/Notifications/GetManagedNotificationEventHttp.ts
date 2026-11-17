import * as notifications from "@distilled.cloud/aws/notifications";
import * as Layer from "effect/Layer";
import { makeNotificationsHttpBinding } from "./BindingHttp.ts";
import { GetManagedNotificationEvent } from "./GetManagedNotificationEvent.ts";

export const GetManagedNotificationEventHttp = Layer.effect(
  GetManagedNotificationEvent,
  makeNotificationsHttpBinding({
    capability: "GetManagedNotificationEvent",
    iamActions: ["notifications:GetManagedNotificationEvent"],
    operation: notifications.getManagedNotificationEvent,
  }),
);

import * as notifications from "@distilled.cloud/aws/notifications";
import * as Layer from "effect/Layer";
import { makeNotificationsHttpBinding } from "./BindingHttp.ts";
import { GetNotificationEvent } from "./GetNotificationEvent.ts";

export const GetNotificationEventHttp = Layer.effect(
  GetNotificationEvent,
  makeNotificationsHttpBinding({
    capability: "GetNotificationEvent",
    iamActions: ["notifications:GetNotificationEvent"],
    operation: notifications.getNotificationEvent,
  }),
);

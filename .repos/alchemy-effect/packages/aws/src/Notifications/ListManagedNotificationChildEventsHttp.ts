import * as notifications from "@distilled.cloud/aws/notifications";
import * as Layer from "effect/Layer";
import { makeNotificationsHttpBinding } from "./BindingHttp.ts";
import { ListManagedNotificationChildEvents } from "./ListManagedNotificationChildEvents.ts";

export const ListManagedNotificationChildEventsHttp = Layer.effect(
  ListManagedNotificationChildEvents,
  makeNotificationsHttpBinding({
    capability: "ListManagedNotificationChildEvents",
    iamActions: ["notifications:ListManagedNotificationChildEvents"],
    operation: notifications.listManagedNotificationChildEvents,
  }),
);

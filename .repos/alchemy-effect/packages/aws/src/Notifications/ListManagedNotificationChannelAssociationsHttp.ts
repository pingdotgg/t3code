import * as notifications from "@distilled.cloud/aws/notifications";
import * as Layer from "effect/Layer";
import { makeNotificationsHttpBinding } from "./BindingHttp.ts";
import { ListManagedNotificationChannelAssociations } from "./ListManagedNotificationChannelAssociations.ts";

export const ListManagedNotificationChannelAssociationsHttp = Layer.effect(
  ListManagedNotificationChannelAssociations,
  makeNotificationsHttpBinding({
    capability: "ListManagedNotificationChannelAssociations",
    iamActions: ["notifications:ListManagedNotificationChannelAssociations"],
    operation: notifications.listManagedNotificationChannelAssociations,
  }),
);

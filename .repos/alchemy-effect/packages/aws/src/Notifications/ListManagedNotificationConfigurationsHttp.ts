import * as notifications from "@distilled.cloud/aws/notifications";
import * as Layer from "effect/Layer";
import { makeNotificationsHttpBinding } from "./BindingHttp.ts";
import { ListManagedNotificationConfigurations } from "./ListManagedNotificationConfigurations.ts";

export const ListManagedNotificationConfigurationsHttp = Layer.effect(
  ListManagedNotificationConfigurations,
  makeNotificationsHttpBinding({
    capability: "ListManagedNotificationConfigurations",
    iamActions: ["notifications:ListManagedNotificationConfigurations"],
    operation: notifications.listManagedNotificationConfigurations,
  }),
);

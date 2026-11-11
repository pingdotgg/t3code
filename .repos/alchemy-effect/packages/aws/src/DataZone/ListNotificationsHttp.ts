import * as datazone from "@distilled.cloud/aws/datazone";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import { ListNotifications } from "./ListNotifications.ts";

export const ListNotificationsHttp = Layer.effect(
  ListNotifications,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.ListNotifications",
    operation: datazone.listNotifications,
    actions: ["datazone:ListNotifications"],
  }),
);

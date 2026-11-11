import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";
import { ListNotifications } from "./ListNotifications.ts";

export const ListNotificationsHttp = Layer.effect(
  ListNotifications,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.ListNotifications",
    operation: auditmanager.listNotifications,
    actions: ["auditmanager:ListNotifications"],
  }),
);

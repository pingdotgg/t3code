import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";
import { ListProtectedResources } from "./ListProtectedResources.ts";

export const ListProtectedResourcesHttp = Layer.effect(
  ListProtectedResources,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.ListProtectedResources",
    operation: backup.listProtectedResources,
    actions: ["backup:ListProtectedResources"],
  }),
);

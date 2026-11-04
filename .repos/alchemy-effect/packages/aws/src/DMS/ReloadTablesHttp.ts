import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Layer from "effect/Layer";
import { makeDmsAccountHttpBinding } from "./BindingHttp.ts";
import { ReloadTables } from "./ReloadTables.ts";

export const ReloadTablesHttp = Layer.effect(
  ReloadTables,
  makeDmsAccountHttpBinding({
    tag: "AWS.DMS.ReloadTables",
    actions: ["dms:ReloadTables"],
    operation: dms.reloadTables,
  }),
);

import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueDatabaseHttpBinding } from "./BindingHttp.ts";
import { GetTables } from "./GetTables.ts";

export const GetTablesHttp = Layer.effect(
  GetTables,
  makeGlueDatabaseHttpBinding({
    tag: "AWS.Glue.GetTables",
    operation: glue.getTables,
    actions: ["glue:GetTables"],
  }),
);

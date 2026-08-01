import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueTableHttpBinding } from "./BindingHttp.ts";
import { GetTable } from "./GetTable.ts";

export const GetTableHttp = Layer.effect(
  GetTable,
  makeGlueTableHttpBinding({
    tag: "AWS.Glue.GetTable",
    operation: glue.getTable,
    actions: ["glue:GetTable"],
    tableNameKey: "Name",
  }),
);

import * as docdb from "@distilled.cloud/aws/docdb";
import * as Layer from "effect/Layer";
import { makeDocDBInstanceHttpBinding } from "./BindingHttp.ts";
import { RebootDBInstance } from "./RebootDBInstance.ts";

export const RebootDBInstanceHttp = Layer.effect(
  RebootDBInstance,
  makeDocDBInstanceHttpBinding({
    tag: "AWS.DocDB.RebootDBInstance",
    operation: docdb.rebootDBInstance,
    actions: ["rds:RebootDBInstance"],
  }),
);

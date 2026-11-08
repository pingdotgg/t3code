import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { ListTables } from "./ListTables.ts";

export const ListTablesHttp = Layer.effect(
  ListTables,
  makeAccountHttpBinding({
    tag: "AWS.DynamoDB.ListTables",
    operation: DynamoDB.listTables,
    actions: ["dynamodb:ListTables"],
  }),
);

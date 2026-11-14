import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { UpdateItem } from "./UpdateItem.ts";

export const UpdateItemHttp = Layer.effect(
  UpdateItem,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.UpdateItem",
    operation: DynamoDB.updateItem,
    actions: ["dynamodb:UpdateItem"],
  }),
);

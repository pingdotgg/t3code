import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { GetItem } from "./GetItem.ts";

export const GetItemHttp = Layer.effect(
  GetItem,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.GetItem",
    operation: DynamoDB.getItem,
    actions: ["dynamodb:GetItem"],
  }),
);

import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { PutItem } from "./PutItem.ts";

export const PutItemHttp = Layer.effect(
  PutItem,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.PutItem",
    operation: DynamoDB.putItem,
    actions: ["dynamodb:PutItem"],
  }),
);

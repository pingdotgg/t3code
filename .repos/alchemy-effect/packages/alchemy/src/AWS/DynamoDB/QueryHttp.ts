import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { Query } from "./Query.ts";

export const QueryHttp = Layer.effect(
  Query,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.Query",
    operation: DynamoDB.query,
    actions: ["dynamodb:Query"],
    resources: (table) => [
      table.tableArn,
      Output.interpolate`${table.tableArn}/index/*`,
    ],
  }),
);

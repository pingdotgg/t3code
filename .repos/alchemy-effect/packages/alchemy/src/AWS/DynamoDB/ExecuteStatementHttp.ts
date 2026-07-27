import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeTableIamHttpBinding } from "./BindingHttp.ts";
import { ExecuteStatement } from "./ExecuteStatement.ts";

export const ExecuteStatementHttp = Layer.effect(
  ExecuteStatement,
  makeTableIamHttpBinding({
    tag: "AWS.DynamoDB.ExecuteStatement",
    operation: DynamoDB.executeStatement,
    actions: [
      "dynamodb:PartiQLDelete",
      "dynamodb:PartiQLInsert",
      "dynamodb:PartiQLSelect",
      "dynamodb:PartiQLUpdate",
    ],
    resources: (table) => [
      table.tableArn,
      Output.interpolate`${table.tableArn}/index/*`,
    ],
  }),
);

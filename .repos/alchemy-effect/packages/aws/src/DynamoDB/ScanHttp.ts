import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Output from "alchemy/Output";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { Scan } from "./Scan.ts";

export const ScanHttp = Layer.effect(
  Scan,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.Scan",
    operation: DynamoDB.scan,
    actions: ["dynamodb:Scan"],
    resources: (table) => [table.tableArn, Output.interpolate`${table.tableArn}/index/*`],
  }),
);

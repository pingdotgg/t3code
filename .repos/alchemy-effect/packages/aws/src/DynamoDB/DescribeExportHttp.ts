import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Output from "alchemy/Output";
import * as Layer from "effect/Layer";
import { makeTableIamHttpBinding } from "./BindingHttp.ts";
import { DescribeExport } from "./DescribeExport.ts";

export const DescribeExportHttp = Layer.effect(
  DescribeExport,
  makeTableIamHttpBinding({
    tag: "AWS.DynamoDB.DescribeExport",
    operation: DynamoDB.describeExport,
    actions: ["dynamodb:DescribeExport"],
    resources: (table) => [Output.interpolate`${table.tableArn}/export/*`],
  }),
);

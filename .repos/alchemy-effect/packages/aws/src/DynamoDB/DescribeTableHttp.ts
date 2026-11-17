import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { DescribeTable } from "./DescribeTable.ts";

export const DescribeTableHttp = Layer.effect(
  DescribeTable,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.DescribeTable",
    operation: DynamoDB.describeTable,
    actions: ["dynamodb:DescribeTable"],
  }),
);

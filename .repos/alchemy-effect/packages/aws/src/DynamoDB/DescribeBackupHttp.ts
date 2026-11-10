import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Output from "alchemy/Output";
import * as Layer from "effect/Layer";
import { makeTableIamHttpBinding } from "./BindingHttp.ts";
import { DescribeBackup } from "./DescribeBackup.ts";

export const DescribeBackupHttp = Layer.effect(
  DescribeBackup,
  makeTableIamHttpBinding({
    tag: "AWS.DynamoDB.DescribeBackup",
    operation: DynamoDB.describeBackup,
    actions: ["dynamodb:DescribeBackup"],
    resources: (table) => [Output.interpolate`${table.tableArn}/backup/*`],
  }),
);

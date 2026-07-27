import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
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

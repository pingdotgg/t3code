import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeTableIamHttpBinding } from "./BindingHttp.ts";
import { DeleteBackup } from "./DeleteBackup.ts";

export const DeleteBackupHttp = Layer.effect(
  DeleteBackup,
  makeTableIamHttpBinding({
    tag: "AWS.DynamoDB.DeleteBackup",
    operation: DynamoDB.deleteBackup,
    actions: ["dynamodb:DeleteBackup"],
    resources: (table) => [Output.interpolate`${table.tableArn}/backup/*`],
  }),
);

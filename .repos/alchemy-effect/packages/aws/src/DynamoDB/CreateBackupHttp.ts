import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Layer from "effect/Layer";
import { makeTableHttpBinding } from "./BindingHttp.ts";
import { CreateBackup } from "./CreateBackup.ts";

export const CreateBackupHttp = Layer.effect(
  CreateBackup,
  makeTableHttpBinding({
    tag: "AWS.DynamoDB.CreateBackup",
    operation: DynamoDB.createBackup,
    actions: ["dynamodb:CreateBackup"],
  }),
);

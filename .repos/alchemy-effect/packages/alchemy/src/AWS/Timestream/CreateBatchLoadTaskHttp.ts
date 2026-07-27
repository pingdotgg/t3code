import * as TSW from "@distilled.cloud/aws/timestream-write";
import * as Layer from "effect/Layer";
import { makeWriteTableHttpBinding } from "./BindingHttp.ts";
import {
  CreateBatchLoadTask,
  type CreateBatchLoadTaskRequest,
} from "./CreateBatchLoadTask.ts";

export const CreateBatchLoadTaskHttp = Layer.effect(
  CreateBatchLoadTask,
  makeWriteTableHttpBinding({
    tag: "AWS.Timestream.CreateBatchLoadTask",
    operation: TSW.createBatchLoadTask,
    actions: ["timestream:CreateBatchLoadTask"],
    // Batch load authorizes against both the target table and its database.
    grantDatabaseArn: true,
    toRequest: (request: CreateBatchLoadTaskRequest, names) => ({
      ...request,
      TargetDatabaseName: names.DatabaseName,
      TargetTableName: names.TableName,
    }),
  }),
);

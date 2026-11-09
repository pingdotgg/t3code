import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Layer from "effect/Layer";
import {
  BatchExecuteStatement,
  type BatchExecuteStatementRequest,
} from "./BatchExecuteStatement.ts";
import { makeRDSDataHttpBinding } from "./BindingHttp.ts";

export const BatchExecuteStatementHttp = Layer.effect(
  BatchExecuteStatement,
  makeRDSDataHttpBinding({
    tag: "AWS.RDSData.BatchExecuteStatement",
    action: "rds-data:BatchExecuteStatement",
    operation: rdsdata.batchExecuteStatement,
    makeInput: (
      request: BatchExecuteStatementRequest,
      { resourceArn, secretArn, database, schema },
    ): rdsdata.BatchExecuteStatementRequest => ({
      ...request,
      resourceArn,
      secretArn,
      database,
      schema,
    }),
  }),
);

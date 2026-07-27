import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Layer from "effect/Layer";
import { makeRDSDataHttpBinding } from "./BindingHttp.ts";
import {
  CommitTransaction,
  type CommitTransactionRequest,
} from "./CommitTransaction.ts";

export const CommitTransactionHttp = Layer.effect(
  CommitTransaction,
  makeRDSDataHttpBinding({
    tag: "AWS.RDSData.CommitTransaction",
    action: "rds-data:CommitTransaction",
    operation: rdsdata.commitTransaction,
    // commit is transaction-scoped — no database/schema on the wire
    makeInput: (
      request: CommitTransactionRequest,
      { resourceArn, secretArn },
    ): rdsdata.CommitTransactionRequest => ({
      ...request,
      resourceArn,
      secretArn,
    }),
  }),
);

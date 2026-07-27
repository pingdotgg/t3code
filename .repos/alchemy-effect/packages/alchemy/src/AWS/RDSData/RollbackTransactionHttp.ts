import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Layer from "effect/Layer";
import { makeRDSDataHttpBinding } from "./BindingHttp.ts";
import {
  RollbackTransaction,
  type RollbackTransactionRequest,
} from "./RollbackTransaction.ts";

export const RollbackTransactionHttp = Layer.effect(
  RollbackTransaction,
  makeRDSDataHttpBinding({
    tag: "AWS.RDSData.RollbackTransaction",
    action: "rds-data:RollbackTransaction",
    operation: rdsdata.rollbackTransaction,
    // rollback is transaction-scoped — no database/schema on the wire
    makeInput: (
      request: RollbackTransactionRequest,
      { resourceArn, secretArn },
    ): rdsdata.RollbackTransactionRequest => ({
      ...request,
      resourceArn,
      secretArn,
    }),
  }),
);

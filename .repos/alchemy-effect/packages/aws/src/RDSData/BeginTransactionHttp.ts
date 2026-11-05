import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Layer from "effect/Layer";
import { BeginTransaction } from "./BeginTransaction.ts";
import { makeRDSDataHttpBinding } from "./BindingHttp.ts";

export const BeginTransactionHttp = Layer.effect(
  BeginTransaction,
  makeRDSDataHttpBinding({
    tag: "AWS.RDSData.BeginTransaction",
    action: "rds-data:BeginTransaction",
    operation: rdsdata.beginTransaction,
    // the runtime callable takes no request — everything comes from bind time
    makeInput: (
      _request: void,
      { resourceArn, secretArn, database, schema },
    ): rdsdata.BeginTransactionRequest => ({
      resourceArn,
      secretArn,
      database,
      schema,
    }),
  }),
);

import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Layer from "effect/Layer";
import { makeRDSDataHttpBinding } from "./BindingHttp.ts";
import {
  ExecuteStatement,
  type ExecuteStatementRequest,
} from "./ExecuteStatement.ts";

export const ExecuteStatementHttp = Layer.effect(
  ExecuteStatement,
  makeRDSDataHttpBinding({
    tag: "AWS.RDSData.ExecuteStatement",
    action: "rds-data:ExecuteStatement",
    operation: rdsdata.executeStatement,
    makeInput: (
      request: ExecuteStatementRequest,
      { resourceArn, secretArn, database, schema },
    ): rdsdata.ExecuteStatementRequest => ({
      ...request,
      resourceArn,
      secretArn,
      database,
      schema,
    }),
  }),
);

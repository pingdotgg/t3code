import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Layer from "effect/Layer";
import { makeRDSDataHttpBinding } from "./BindingHttp.ts";
import { ExecuteSql, type ExecuteSqlRequest } from "./ExecuteSql.ts";

export const ExecuteSqlHttp = Layer.effect(
  ExecuteSql,
  makeRDSDataHttpBinding({
    tag: "AWS.RDSData.ExecuteSql",
    action: "rds-data:ExecuteSql",
    operation: rdsdata.executeSql,
    // the deprecated ExecuteSql API uses legacy wire keys for the same pair
    makeInput: (
      request: ExecuteSqlRequest,
      { resourceArn, secretArn, database, schema },
    ): rdsdata.ExecuteSqlRequest => ({
      ...request,
      dbClusterOrInstanceArn: resourceArn,
      awsSecretStoreArn: secretArn,
      database,
      schema,
    }),
  }),
);

import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import {
  makeServerlessNamespaceHttpBinding,
  serverlessArnPrefix,
} from "./BindingHttp.ts";
import { RestoreTableFromRecoveryPoint } from "./RestoreTableFromRecoveryPoint.ts";

export const RestoreTableFromRecoveryPointHttp = Layer.effect(
  RestoreTableFromRecoveryPoint,
  makeServerlessNamespaceHttpBinding({
    tag: "AWS.RedshiftServerless.RestoreTableFromRecoveryPoint",
    operation: serverless.restoreTableFromRecoveryPoint,
    actions: ["redshift-serverless:RestoreTableFromRecoveryPoint"],
    // The operation authorizes against sibling resource ARNs (snapshots,
    // recovery points, the serving workgroup) in addition to the namespace.
    extraResources: (arn) => {
      const prefix = serverlessArnPrefix(arn);
      return [`${prefix}:recoverypoint/*`, `${prefix}:workgroup/*`];
    },
  }),
);

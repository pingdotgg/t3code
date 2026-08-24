import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import {
  makeServerlessNamespaceHttpBinding,
  serverlessArnPrefix,
} from "./BindingHttp.ts";
import { RestoreFromRecoveryPoint } from "./RestoreFromRecoveryPoint.ts";

export const RestoreFromRecoveryPointHttp = Layer.effect(
  RestoreFromRecoveryPoint,
  makeServerlessNamespaceHttpBinding({
    tag: "AWS.RedshiftServerless.RestoreFromRecoveryPoint",
    operation: serverless.restoreFromRecoveryPoint,
    actions: ["redshift-serverless:RestoreFromRecoveryPoint"],
    // The operation authorizes against sibling resource ARNs (snapshots,
    // recovery points, the serving workgroup) in addition to the namespace.
    extraResources: (arn) => {
      const prefix = serverlessArnPrefix(arn);
      return [`${prefix}:recoverypoint/*`, `${prefix}:workgroup/*`];
    },
  }),
);

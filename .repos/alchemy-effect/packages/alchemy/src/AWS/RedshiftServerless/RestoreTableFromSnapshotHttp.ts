import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import {
  makeServerlessNamespaceHttpBinding,
  serverlessArnPrefix,
} from "./BindingHttp.ts";
import { RestoreTableFromSnapshot } from "./RestoreTableFromSnapshot.ts";

export const RestoreTableFromSnapshotHttp = Layer.effect(
  RestoreTableFromSnapshot,
  makeServerlessNamespaceHttpBinding({
    tag: "AWS.RedshiftServerless.RestoreTableFromSnapshot",
    operation: serverless.restoreTableFromSnapshot,
    actions: ["redshift-serverless:RestoreTableFromSnapshot"],
    // The operation authorizes against sibling resource ARNs (snapshots,
    // recovery points, the serving workgroup) in addition to the namespace.
    extraResources: (arn) => {
      const prefix = serverlessArnPrefix(arn);
      return [`${prefix}:snapshot/*`, `${prefix}:workgroup/*`];
    },
  }),
);

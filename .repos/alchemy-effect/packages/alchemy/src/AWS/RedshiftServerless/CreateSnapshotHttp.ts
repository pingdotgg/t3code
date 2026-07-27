import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import {
  makeServerlessNamespaceHttpBinding,
  serverlessArnPrefix,
} from "./BindingHttp.ts";
import { CreateSnapshot } from "./CreateSnapshot.ts";

export const CreateSnapshotHttp = Layer.effect(
  CreateSnapshot,
  makeServerlessNamespaceHttpBinding({
    tag: "AWS.RedshiftServerless.CreateSnapshot",
    operation: serverless.createSnapshot,
    actions: [
      "redshift-serverless:CreateSnapshot",
      "redshift-serverless:TagResource",
    ],
    // The operation authorizes against sibling resource ARNs (snapshots,
    // recovery points, the serving workgroup) in addition to the namespace.
    extraResources: (arn) => {
      const prefix = serverlessArnPrefix(arn);
      return [`${prefix}:snapshot/*`];
    },
  }),
);

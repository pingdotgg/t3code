import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import { makeServerlessAccountHttpBinding } from "./BindingHttp.ts";
import { ConvertRecoveryPointToSnapshot } from "./ConvertRecoveryPointToSnapshot.ts";

export const ConvertRecoveryPointToSnapshotHttp = Layer.effect(
  ConvertRecoveryPointToSnapshot,
  makeServerlessAccountHttpBinding({
    tag: "AWS.RedshiftServerless.ConvertRecoveryPointToSnapshot",
    operation: serverless.convertRecoveryPointToSnapshot,
    actions: [
      "redshift-serverless:ConvertRecoveryPointToSnapshot",
      "redshift-serverless:TagResource",
    ],
  }),
);

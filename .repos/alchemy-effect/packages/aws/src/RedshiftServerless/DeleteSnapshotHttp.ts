import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import { makeServerlessAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteSnapshot } from "./DeleteSnapshot.ts";

export const DeleteSnapshotHttp = Layer.effect(
  DeleteSnapshot,
  makeServerlessAccountHttpBinding({
    tag: "AWS.RedshiftServerless.DeleteSnapshot",
    operation: serverless.deleteSnapshot,
    actions: ["redshift-serverless:DeleteSnapshot"],
  }),
);

import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import { makeServerlessAccountHttpBinding } from "./BindingHttp.ts";
import { UpdateSnapshot } from "./UpdateSnapshot.ts";

export const UpdateSnapshotHttp = Layer.effect(
  UpdateSnapshot,
  makeServerlessAccountHttpBinding({
    tag: "AWS.RedshiftServerless.UpdateSnapshot",
    operation: serverless.updateSnapshot,
    actions: ["redshift-serverless:UpdateSnapshot"],
  }),
);

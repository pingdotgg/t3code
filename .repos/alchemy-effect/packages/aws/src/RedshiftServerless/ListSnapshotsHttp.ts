import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import { makeServerlessAccountHttpBinding } from "./BindingHttp.ts";
import { ListSnapshots } from "./ListSnapshots.ts";

export const ListSnapshotsHttp = Layer.effect(
  ListSnapshots,
  makeServerlessAccountHttpBinding({
    tag: "AWS.RedshiftServerless.ListSnapshots",
    operation: serverless.listSnapshots,
    actions: ["redshift-serverless:ListSnapshots"],
  }),
);

import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import { makeServerlessAccountHttpBinding } from "./BindingHttp.ts";
import { GetSnapshot } from "./GetSnapshot.ts";

export const GetSnapshotHttp = Layer.effect(
  GetSnapshot,
  makeServerlessAccountHttpBinding({
    tag: "AWS.RedshiftServerless.GetSnapshot",
    operation: serverless.getSnapshot,
    actions: ["redshift-serverless:GetSnapshot"],
  }),
);

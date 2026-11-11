import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import { makeServerlessAccountHttpBinding } from "./BindingHttp.ts";
import { ListRecoveryPoints } from "./ListRecoveryPoints.ts";

export const ListRecoveryPointsHttp = Layer.effect(
  ListRecoveryPoints,
  makeServerlessAccountHttpBinding({
    tag: "AWS.RedshiftServerless.ListRecoveryPoints",
    operation: serverless.listRecoveryPoints,
    actions: ["redshift-serverless:ListRecoveryPoints"],
  }),
);

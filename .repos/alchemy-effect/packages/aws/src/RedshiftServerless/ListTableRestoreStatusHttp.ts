import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import * as Layer from "effect/Layer";
import { makeServerlessAccountHttpBinding } from "./BindingHttp.ts";
import { ListTableRestoreStatus } from "./ListTableRestoreStatus.ts";

export const ListTableRestoreStatusHttp = Layer.effect(
  ListTableRestoreStatus,
  makeServerlessAccountHttpBinding({
    tag: "AWS.RedshiftServerless.ListTableRestoreStatus",
    operation: serverless.listTableRestoreStatus,
    actions: ["redshift-serverless:ListTableRestoreStatus"],
  }),
);

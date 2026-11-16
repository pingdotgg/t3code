import * as mwaa from "@distilled.cloud/aws/mwaa";
import * as Layer from "effect/Layer";
import { makeMWAAAirflowRoleHttpBinding } from "./BindingHttp.ts";
import { InvokeRestApi } from "./InvokeRestApi.ts";

export const InvokeRestApiHttp = Layer.effect(
  InvokeRestApi,
  makeMWAAAirflowRoleHttpBinding({
    tag: "AWS.MWAA.InvokeRestApi",
    operation: mwaa.invokeRestApi,
    actions: ["airflow:InvokeRestApi"],
  }),
);

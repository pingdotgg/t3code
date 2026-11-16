import * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import * as Layer from "effect/Layer";
import { makeMwaaServerlessHttpBinding } from "./BindingHttp.ts";
import { GetTaskInstance } from "./GetTaskInstance.ts";

export const GetTaskInstanceHttp = Layer.effect(
  GetTaskInstance,
  makeMwaaServerlessHttpBinding({
    tag: "AWS.MWAAServerless.GetTaskInstance",
    operation: mwaa.getTaskInstance,
    actions: ["airflow-serverless:GetTaskInstance"],
  }),
);

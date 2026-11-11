import * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import * as Layer from "effect/Layer";
import { makeMwaaServerlessHttpBinding } from "./BindingHttp.ts";
import { ListTaskInstances } from "./ListTaskInstances.ts";

export const ListTaskInstancesHttp = Layer.effect(
  ListTaskInstances,
  makeMwaaServerlessHttpBinding({
    tag: "AWS.MWAAServerless.ListTaskInstances",
    operation: mwaa.listTaskInstances,
    actions: ["airflow-serverless:ListTaskInstances"],
  }),
);

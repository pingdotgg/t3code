import * as mwaa from "@distilled.cloud/aws/mwaa";
import * as Layer from "effect/Layer";
import { makeMWAAAirflowRoleHttpBinding } from "./BindingHttp.ts";
import { CreateWebLoginToken } from "./CreateWebLoginToken.ts";

export const CreateWebLoginTokenHttp = Layer.effect(
  CreateWebLoginToken,
  makeMWAAAirflowRoleHttpBinding({
    tag: "AWS.MWAA.CreateWebLoginToken",
    operation: mwaa.createWebLoginToken,
    actions: ["airflow:CreateWebLoginToken"],
  }),
);

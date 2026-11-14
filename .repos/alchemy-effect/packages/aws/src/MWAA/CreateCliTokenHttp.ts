import * as mwaa from "@distilled.cloud/aws/mwaa";
import * as Layer from "effect/Layer";
import { makeMWAAEnvironmentHttpBinding } from "./BindingHttp.ts";
import { CreateCliToken } from "./CreateCliToken.ts";

export const CreateCliTokenHttp = Layer.effect(
  CreateCliToken,
  makeMWAAEnvironmentHttpBinding({
    tag: "AWS.MWAA.CreateCliToken",
    operation: mwaa.createCliToken,
    actions: ["airflow:CreateCliToken"],
  }),
);

import * as mwaa from "@distilled.cloud/aws/mwaa";
import * as Layer from "effect/Layer";
import { makeMWAAEnvironmentHttpBinding } from "./BindingHttp.ts";
import { GetEnvironment } from "./GetEnvironment.ts";

export const GetEnvironmentHttp = Layer.effect(
  GetEnvironment,
  makeMWAAEnvironmentHttpBinding({
    tag: "AWS.MWAA.GetEnvironment",
    operation: mwaa.getEnvironment,
    actions: ["airflow:GetEnvironment"],
  }),
);

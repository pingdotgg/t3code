import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { GetExperimentTargetAccountConfiguration } from "./GetExperimentTargetAccountConfiguration.ts";

export const GetExperimentTargetAccountConfigurationHttp = Layer.effect(
  GetExperimentTargetAccountConfiguration,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.GetExperimentTargetAccountConfiguration",
    operation: fis.getExperimentTargetAccountConfiguration,
    actions: ["fis:GetExperimentTargetAccountConfiguration"],
  }),
);

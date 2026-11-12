import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { ListExperimentTargetAccountConfigurations } from "./ListExperimentTargetAccountConfigurations.ts";

export const ListExperimentTargetAccountConfigurationsHttp = Layer.effect(
  ListExperimentTargetAccountConfigurations,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.ListExperimentTargetAccountConfigurations",
    operation: fis.listExperimentTargetAccountConfigurations,
    actions: ["fis:ListExperimentTargetAccountConfigurations"],
  }),
);

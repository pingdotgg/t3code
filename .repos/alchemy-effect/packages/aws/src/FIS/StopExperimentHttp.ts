import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { StopExperiment } from "./StopExperiment.ts";

export const StopExperimentHttp = Layer.effect(
  StopExperiment,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.StopExperiment",
    operation: fis.stopExperiment,
    actions: ["fis:StopExperiment"],
  }),
);

import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { GetExperiment } from "./GetExperiment.ts";

export const GetExperimentHttp = Layer.effect(
  GetExperiment,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.GetExperiment",
    operation: fis.getExperiment,
    actions: ["fis:GetExperiment"],
  }),
);

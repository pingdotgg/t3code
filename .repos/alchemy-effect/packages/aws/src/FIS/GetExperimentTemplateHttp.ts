import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisTemplateHttpBinding } from "./BindingHttp.ts";
import { GetExperimentTemplate } from "./GetExperimentTemplate.ts";

export const GetExperimentTemplateHttp = Layer.effect(
  GetExperimentTemplate,
  makeFisTemplateHttpBinding({
    tag: "AWS.FIS.GetExperimentTemplate",
    operation: fis.getExperimentTemplate,
    actions: ["fis:GetExperimentTemplate"],
    requestKey: "id",
  }),
);

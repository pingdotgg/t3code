import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { ListExperimentTemplates } from "./ListExperimentTemplates.ts";

export const ListExperimentTemplatesHttp = Layer.effect(
  ListExperimentTemplates,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.ListExperimentTemplates",
    operation: fis.listExperimentTemplates,
    actions: ["fis:ListExperimentTemplates"],
  }),
);

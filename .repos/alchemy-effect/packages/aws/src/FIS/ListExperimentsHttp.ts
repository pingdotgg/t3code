import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { ListExperiments } from "./ListExperiments.ts";

export const ListExperimentsHttp = Layer.effect(
  ListExperiments,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.ListExperiments",
    operation: fis.listExperiments,
    actions: ["fis:ListExperiments"],
  }),
);

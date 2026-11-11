import * as bcm from "@distilled.cloud/aws/bcm-data-exports";
import * as Layer from "effect/Layer";
import { makeExportHttpBinding } from "./BindingHttp.ts";
import { ListExecutions } from "./ListExecutions.ts";

export const ListExecutionsHttp = Layer.effect(
  ListExecutions,
  makeExportHttpBinding({
    capability: "ListExecutions",
    iamActions: ["bcm-data-exports:ListExecutions"],
    operation: bcm.listExecutions,
  }),
);

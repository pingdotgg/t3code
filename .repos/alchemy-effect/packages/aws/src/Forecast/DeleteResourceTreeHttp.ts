import * as forecast from "@distilled.cloud/aws/forecast";
import * as Layer from "effect/Layer";
import { makeForecastHttpBinding } from "./BindingHttp.ts";
import { DeleteResourceTree } from "./DeleteResourceTree.ts";

export const DeleteResourceTreeHttp = Layer.effect(
  DeleteResourceTree,
  makeForecastHttpBinding({
    capability: "DeleteResourceTree",
    iamActions: ["forecast:DeleteResourceTree"],
    operation: forecast.deleteResourceTree,
  }),
);

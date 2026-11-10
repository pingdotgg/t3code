import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { DeleteResourceSet } from "./DeleteResourceSet.ts";

export const DeleteResourceSetHttp = Layer.effect(
  DeleteResourceSet,
  makeFmsHttpBinding({
    capability: "DeleteResourceSet",
    iamActions: ["fms:DeleteResourceSet"],
    operation: fms.deleteResourceSet,
  }),
);

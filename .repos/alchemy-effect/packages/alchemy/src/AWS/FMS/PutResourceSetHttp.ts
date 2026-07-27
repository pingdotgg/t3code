import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { PutResourceSet } from "./PutResourceSet.ts";

export const PutResourceSetHttp = Layer.effect(
  PutResourceSet,
  makeFmsHttpBinding({
    capability: "PutResourceSet",
    iamActions: ["fms:PutResourceSet"],
    operation: fms.putResourceSet,
  }),
);

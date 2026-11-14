import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { BatchDisassociateResource } from "./BatchDisassociateResource.ts";
import { makeFmsHttpBinding } from "./BindingHttp.ts";

export const BatchDisassociateResourceHttp = Layer.effect(
  BatchDisassociateResource,
  makeFmsHttpBinding({
    capability: "BatchDisassociateResource",
    iamActions: ["fms:BatchDisassociateResource"],
    operation: fms.batchDisassociateResource,
  }),
);

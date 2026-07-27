import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { BatchAssociateResource } from "./BatchAssociateResource.ts";

export const BatchAssociateResourceHttp = Layer.effect(
  BatchAssociateResource,
  makeFmsHttpBinding({
    capability: "BatchAssociateResource",
    iamActions: ["fms:BatchAssociateResource"],
    operation: fms.batchAssociateResource,
  }),
);

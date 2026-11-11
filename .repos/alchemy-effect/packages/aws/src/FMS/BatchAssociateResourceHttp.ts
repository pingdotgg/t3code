import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { BatchAssociateResource } from "./BatchAssociateResource.ts";
import { makeFmsHttpBinding } from "./BindingHttp.ts";

export const BatchAssociateResourceHttp = Layer.effect(
  BatchAssociateResource,
  makeFmsHttpBinding({
    capability: "BatchAssociateResource",
    iamActions: ["fms:BatchAssociateResource"],
    operation: fms.batchAssociateResource,
  }),
);

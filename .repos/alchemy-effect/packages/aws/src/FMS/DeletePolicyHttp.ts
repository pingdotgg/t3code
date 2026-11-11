import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { DeletePolicy } from "./DeletePolicy.ts";

export const DeletePolicyHttp = Layer.effect(
  DeletePolicy,
  makeFmsHttpBinding({
    capability: "DeletePolicy",
    iamActions: ["fms:DeletePolicy"],
    operation: fms.deletePolicy,
  }),
);

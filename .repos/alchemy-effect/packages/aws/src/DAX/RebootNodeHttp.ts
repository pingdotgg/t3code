import * as dax from "@distilled.cloud/aws/dax";
import * as Layer from "effect/Layer";
import { makeDaxClusterHttpBinding } from "./BindingHttp.ts";
import { RebootNode } from "./RebootNode.ts";

export const RebootNodeHttp = Layer.effect(
  RebootNode,
  makeDaxClusterHttpBinding({
    tag: "AWS.DAX.RebootNode",
    operation: dax.rebootNode,
    actions: ["dax:RebootNode"],
  }),
);

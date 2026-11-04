import * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import * as Layer from "effect/Layer";
import { makeVpcLatticeTargetGroupHttpBinding } from "./BindingHttp.ts";
import { ListTargets } from "./ListTargets.ts";

export const ListTargetsHttp = Layer.effect(
  ListTargets,
  makeVpcLatticeTargetGroupHttpBinding({
    tag: "AWS.VpcLattice.ListTargets",
    operation: vpclattice.listTargets,
    actions: ["vpc-lattice:ListTargets"],
  }),
);

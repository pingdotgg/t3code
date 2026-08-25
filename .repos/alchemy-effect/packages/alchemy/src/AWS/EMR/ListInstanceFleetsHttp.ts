import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { ListInstanceFleets } from "./ListInstanceFleets.ts";

export const ListInstanceFleetsHttp = Layer.effect(
  ListInstanceFleets,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.ListInstanceFleets",
    operation: emr.listInstanceFleets,
    actions: ["elasticmapreduce:ListInstanceFleets"],
  }),
);

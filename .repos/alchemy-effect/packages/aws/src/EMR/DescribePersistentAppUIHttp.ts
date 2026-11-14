import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { DescribePersistentAppUI } from "./DescribePersistentAppUI.ts";

export const DescribePersistentAppUIHttp = Layer.effect(
  DescribePersistentAppUI,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.DescribePersistentAppUI",
    operation: emr.describePersistentAppUI,
    actions: ["elasticmapreduce:DescribePersistentAppUI"],
    inject: "none",
  }),
);

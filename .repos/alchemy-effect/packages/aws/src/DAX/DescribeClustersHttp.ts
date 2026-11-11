import * as dax from "@distilled.cloud/aws/dax";
import * as Layer from "effect/Layer";
import { makeDaxAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeClusters } from "./DescribeClusters.ts";

export const DescribeClustersHttp = Layer.effect(
  DescribeClusters,
  makeDaxAccountHttpBinding({
    tag: "AWS.DAX.DescribeClusters",
    operation: dax.describeClusters,
    actions: ["dax:DescribeClusters"],
  }),
);

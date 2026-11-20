import * as redshift from "@distilled.cloud/aws/redshift";
import * as Layer from "effect/Layer";
import { makeRedshiftAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeClusters } from "./DescribeClusters.ts";

export const DescribeClustersHttp = Layer.effect(
  DescribeClusters,
  makeRedshiftAccountHttpBinding({
    tag: "AWS.Redshift.DescribeClusters",
    operation: redshift.describeClusters,
    actions: ["redshift:DescribeClusters"],
  }),
);

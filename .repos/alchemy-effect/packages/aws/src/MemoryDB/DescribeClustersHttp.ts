import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Layer from "effect/Layer";
import { makeMemoryDBAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeClusters } from "./DescribeClusters.ts";

export const DescribeClustersHttp = Layer.effect(
  DescribeClusters,
  makeMemoryDBAccountHttpBinding({
    tag: "AWS.MemoryDB.DescribeClusters",
    operation: memorydb.describeClusters,
    actions: ["memorydb:DescribeClusters"],
  }),
);

import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { makeNeptuneAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDBClusters } from "./DescribeDBClusters.ts";

export const DescribeDBClustersHttp = Layer.effect(
  DescribeDBClusters,
  makeNeptuneAccountHttpBinding({
    tag: "AWS.Neptune.DescribeDBClusters",
    operation: neptune.describeDBClusters,
    actions: ["rds:DescribeDBClusters"],
  }),
);

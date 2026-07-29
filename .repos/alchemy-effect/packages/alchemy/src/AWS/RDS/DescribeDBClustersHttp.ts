import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDBClusters } from "./DescribeDBClusters.ts";

export const DescribeDBClustersHttp = Layer.effect(
  DescribeDBClusters,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.DescribeDBClusters",
    operation: rds.describeDBClusters,
    actions: ["rds:DescribeDBClusters"],
  }),
);

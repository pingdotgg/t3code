import * as docdb from "@distilled.cloud/aws/docdb";
import * as Layer from "effect/Layer";
import { makeDocDBAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDBClusters } from "./DescribeDBClusters.ts";

export const DescribeDBClustersHttp = Layer.effect(
  DescribeDBClusters,
  makeDocDBAccountHttpBinding({
    tag: "AWS.DocDB.DescribeDBClusters",
    operation: docdb.describeDBClusters,
    actions: ["rds:DescribeDBClusters"],
  }),
);

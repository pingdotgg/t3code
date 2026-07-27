import * as docdb from "@distilled.cloud/aws/docdb";
import * as Layer from "effect/Layer";
import { makeDocDBAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDBInstances } from "./DescribeDBInstances.ts";

export const DescribeDBInstancesHttp = Layer.effect(
  DescribeDBInstances,
  makeDocDBAccountHttpBinding({
    tag: "AWS.DocDB.DescribeDBInstances",
    operation: docdb.describeDBInstances,
    actions: ["rds:DescribeDBInstances"],
  }),
);

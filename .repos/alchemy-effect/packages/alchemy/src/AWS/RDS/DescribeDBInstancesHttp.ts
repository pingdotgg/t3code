import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDBInstances } from "./DescribeDBInstances.ts";

export const DescribeDBInstancesHttp = Layer.effect(
  DescribeDBInstances,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.DescribeDBInstances",
    operation: rds.describeDBInstances,
    actions: ["rds:DescribeDBInstances"],
  }),
);

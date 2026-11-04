import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { makeNeptuneAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDBInstances } from "./DescribeDBInstances.ts";

export const DescribeDBInstancesHttp = Layer.effect(
  DescribeDBInstances,
  makeNeptuneAccountHttpBinding({
    tag: "AWS.Neptune.DescribeDBInstances",
    operation: neptune.describeDBInstances,
    actions: ["rds:DescribeDBInstances"],
  }),
);

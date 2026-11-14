import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { makeNeptuneAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDBClusterEndpoints } from "./DescribeDBClusterEndpoints.ts";

export const DescribeDBClusterEndpointsHttp = Layer.effect(
  DescribeDBClusterEndpoints,
  makeNeptuneAccountHttpBinding({
    tag: "AWS.Neptune.DescribeDBClusterEndpoints",
    operation: neptune.describeDBClusterEndpoints,
    actions: ["rds:DescribeDBClusterEndpoints"],
  }),
);

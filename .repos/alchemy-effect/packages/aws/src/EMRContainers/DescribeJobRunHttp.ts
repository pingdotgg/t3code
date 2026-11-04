import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Layer from "effect/Layer";
import { makeEMRContainersVirtualClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeJobRun } from "./DescribeJobRun.ts";

export const DescribeJobRunHttp = Layer.effect(
  DescribeJobRun,
  makeEMRContainersVirtualClusterHttpBinding({
    tag: "AWS.EMRContainers.DescribeJobRun",
    operation: emrc.describeJobRun,
    actions: ["emr-containers:DescribeJobRun"],
  }),
);

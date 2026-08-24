import * as efs from "@distilled.cloud/aws/efs";
import * as Layer from "effect/Layer";
import { makeEfsFileSystemHttpBinding } from "./BindingHttp.ts";
import { DescribeReplicationConfigurations } from "./DescribeReplicationConfigurations.ts";

export const DescribeReplicationConfigurationsHttp = Layer.effect(
  DescribeReplicationConfigurations,
  makeEfsFileSystemHttpBinding({
    tag: "AWS.EFS.DescribeReplicationConfigurations",
    operation: efs.describeReplicationConfigurations,
    actions: ["elasticfilesystem:DescribeReplicationConfigurations"],
  }),
);

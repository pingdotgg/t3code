import * as efs from "@distilled.cloud/aws/efs";
import * as Layer from "effect/Layer";
import { makeEfsFileSystemHttpBinding } from "./BindingHttp.ts";
import { DescribeLifecycleConfiguration } from "./DescribeLifecycleConfiguration.ts";

export const DescribeLifecycleConfigurationHttp = Layer.effect(
  DescribeLifecycleConfiguration,
  makeEfsFileSystemHttpBinding({
    tag: "AWS.EFS.DescribeLifecycleConfiguration",
    operation: efs.describeLifecycleConfiguration,
    actions: ["elasticfilesystem:DescribeLifecycleConfiguration"],
  }),
);

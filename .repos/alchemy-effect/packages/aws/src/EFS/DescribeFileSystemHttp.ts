import * as efs from "@distilled.cloud/aws/efs";
import * as Layer from "effect/Layer";
import { makeEfsFileSystemHttpBinding } from "./BindingHttp.ts";
import { DescribeFileSystem } from "./DescribeFileSystem.ts";

export const DescribeFileSystemHttp = Layer.effect(
  DescribeFileSystem,
  makeEfsFileSystemHttpBinding({
    tag: "AWS.EFS.DescribeFileSystem",
    operation: efs.describeFileSystems,
    actions: ["elasticfilesystem:DescribeFileSystems"],
  }),
);

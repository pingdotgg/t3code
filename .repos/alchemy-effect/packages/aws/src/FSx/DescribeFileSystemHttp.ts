import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxFileSystemHttpBinding } from "./BindingHttp.ts";
import { DescribeFileSystem } from "./DescribeFileSystem.ts";

export const DescribeFileSystemHttp = Layer.effect(
  DescribeFileSystem,
  makeFSxFileSystemHttpBinding({
    tag: "AWS.FSx.DescribeFileSystem",
    operation: fsx.describeFileSystems,
    actions: ["fsx:DescribeFileSystems"],
    requestKey: "FileSystemIds",
  }),
);

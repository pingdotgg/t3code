import * as ds from "@distilled.cloud/aws/directory-service";
import * as Layer from "effect/Layer";
import { makeDirectoryServiceAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeDirectories } from "./DescribeDirectories.ts";

export const DescribeDirectoriesHttp = Layer.effect(
  DescribeDirectories,
  makeDirectoryServiceAccountHttpBinding({
    tag: "AWS.DirectoryService.DescribeDirectories",
    operation: ds.describeDirectories,
    actions: ["ds:DescribeDirectories"],
  }),
);

import * as efs from "@distilled.cloud/aws/efs";
import * as Layer from "effect/Layer";
import { makeEfsFileSystemHttpBinding } from "./BindingHttp.ts";
import { DescribeMountTargets } from "./DescribeMountTargets.ts";

export const DescribeMountTargetsHttp = Layer.effect(
  DescribeMountTargets,
  makeEfsFileSystemHttpBinding({
    tag: "AWS.EFS.DescribeMountTargets",
    operation: efs.describeMountTargets,
    actions: ["elasticfilesystem:DescribeMountTargets"],
  }),
);

import * as efs from "@distilled.cloud/aws/efs";
import * as Layer from "effect/Layer";
import { makeEfsFileSystemHttpBinding } from "./BindingHttp.ts";
import { PutLifecycleConfiguration } from "./PutLifecycleConfiguration.ts";

export const PutLifecycleConfigurationHttp = Layer.effect(
  PutLifecycleConfiguration,
  makeEfsFileSystemHttpBinding({
    tag: "AWS.EFS.PutLifecycleConfiguration",
    operation: efs.putLifecycleConfiguration,
    actions: ["elasticfilesystem:PutLifecycleConfiguration"],
  }),
);

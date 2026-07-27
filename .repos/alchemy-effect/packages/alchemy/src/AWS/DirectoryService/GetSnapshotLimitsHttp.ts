import * as ds from "@distilled.cloud/aws/directory-service";
import * as Layer from "effect/Layer";
import { makeDirectoryHttpBinding } from "./BindingHttp.ts";
import { GetSnapshotLimits } from "./GetSnapshotLimits.ts";

export const GetSnapshotLimitsHttp = Layer.effect(
  GetSnapshotLimits,
  makeDirectoryHttpBinding({
    tag: "AWS.DirectoryService.GetSnapshotLimits",
    operation: ds.getSnapshotLimits,
    actions: ["ds:GetSnapshotLimits"],
  }),
);

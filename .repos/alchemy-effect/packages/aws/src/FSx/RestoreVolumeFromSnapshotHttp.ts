import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxAccountHttpBinding } from "./BindingHttp.ts";
import { RestoreVolumeFromSnapshot } from "./RestoreVolumeFromSnapshot.ts";

export const RestoreVolumeFromSnapshotHttp = Layer.effect(
  RestoreVolumeFromSnapshot,
  makeFSxAccountHttpBinding({
    tag: "AWS.FSx.RestoreVolumeFromSnapshot",
    operation: fsx.restoreVolumeFromSnapshot,
    actions: ["fsx:RestoreVolumeFromSnapshot"],
  }),
);

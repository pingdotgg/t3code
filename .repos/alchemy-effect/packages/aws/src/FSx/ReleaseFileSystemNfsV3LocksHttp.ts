import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxFileSystemHttpBinding } from "./BindingHttp.ts";
import { ReleaseFileSystemNfsV3Locks } from "./ReleaseFileSystemNfsV3Locks.ts";

export const ReleaseFileSystemNfsV3LocksHttp = Layer.effect(
  ReleaseFileSystemNfsV3Locks,
  makeFSxFileSystemHttpBinding({
    tag: "AWS.FSx.ReleaseFileSystemNfsV3Locks",
    operation: fsx.releaseFileSystemNfsV3Locks,
    actions: ["fsx:ReleaseFileSystemNfsV3Locks"],
  }),
);

import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxAccountHttpBinding } from "./BindingHttp.ts";
import { UpdateSnapshot } from "./UpdateSnapshot.ts";

export const UpdateSnapshotHttp = Layer.effect(
  UpdateSnapshot,
  makeFSxAccountHttpBinding({
    tag: "AWS.FSx.UpdateSnapshot",
    operation: fsx.updateSnapshot,
    actions: ["fsx:UpdateSnapshot"],
  }),
);

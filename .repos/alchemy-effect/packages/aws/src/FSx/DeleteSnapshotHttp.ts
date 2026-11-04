import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteSnapshot } from "./DeleteSnapshot.ts";

export const DeleteSnapshotHttp = Layer.effect(
  DeleteSnapshot,
  makeFSxAccountHttpBinding({
    tag: "AWS.FSx.DeleteSnapshot",
    operation: fsx.deleteSnapshot,
    actions: ["fsx:DeleteSnapshot"],
  }),
);

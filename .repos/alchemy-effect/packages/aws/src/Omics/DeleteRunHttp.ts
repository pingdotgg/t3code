import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteRun } from "./DeleteRun.ts";

export const DeleteRunHttp = Layer.effect(
  DeleteRun,
  makeOmicsAccountHttpBinding({
    tag: "AWS.Omics.DeleteRun",
    operation: omics.deleteRun,
    actions: ["omics:DeleteRun"],
  }),
);

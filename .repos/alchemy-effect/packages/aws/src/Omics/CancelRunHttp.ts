import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsAccountHttpBinding } from "./BindingHttp.ts";
import { CancelRun } from "./CancelRun.ts";

export const CancelRunHttp = Layer.effect(
  CancelRun,
  makeOmicsAccountHttpBinding({
    tag: "AWS.Omics.CancelRun",
    operation: omics.cancelRun,
    actions: ["omics:CancelRun"],
  }),
);

import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsAccountHttpBinding } from "./BindingHttp.ts";
import { GetRun } from "./GetRun.ts";

export const GetRunHttp = Layer.effect(
  GetRun,
  makeOmicsAccountHttpBinding({
    tag: "AWS.Omics.GetRun",
    operation: omics.getRun,
    actions: ["omics:GetRun"],
  }),
);

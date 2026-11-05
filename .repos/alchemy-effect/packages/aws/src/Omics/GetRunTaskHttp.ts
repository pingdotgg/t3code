import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsAccountHttpBinding } from "./BindingHttp.ts";
import { GetRunTask } from "./GetRunTask.ts";

export const GetRunTaskHttp = Layer.effect(
  GetRunTask,
  makeOmicsAccountHttpBinding({
    tag: "AWS.Omics.GetRunTask",
    operation: omics.getRunTask,
    actions: ["omics:GetRunTask"],
  }),
);

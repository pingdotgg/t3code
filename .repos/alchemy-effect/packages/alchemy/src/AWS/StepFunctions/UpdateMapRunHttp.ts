import * as sfn from "@distilled.cloud/aws/sfn";
import * as Layer from "effect/Layer";
import { makeExecutionScopedHttpBinding } from "./BindingHttp.ts";
import { UpdateMapRun } from "./UpdateMapRun.ts";

export const UpdateMapRunHttp = Layer.effect(
  UpdateMapRun,
  makeExecutionScopedHttpBinding({
    tag: "AWS.StepFunctions.UpdateMapRun",
    operation: sfn.updateMapRun,
    actions: ["states:UpdateMapRun"],
    scope: "mapRun",
  }),
);

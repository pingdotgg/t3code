import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxAccountHttpBinding } from "./BindingHttp.ts";
import { CancelDataRepositoryTask } from "./CancelDataRepositoryTask.ts";

export const CancelDataRepositoryTaskHttp = Layer.effect(
  CancelDataRepositoryTask,
  makeFSxAccountHttpBinding({
    tag: "AWS.FSx.CancelDataRepositoryTask",
    operation: fsx.cancelDataRepositoryTask,
    actions: ["fsx:CancelDataRepositoryTask"],
  }),
);

import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxFileSystemHttpBinding } from "./BindingHttp.ts";
import { CreateDataRepositoryTask } from "./CreateDataRepositoryTask.ts";

export const CreateDataRepositoryTaskHttp = Layer.effect(
  CreateDataRepositoryTask,
  makeFSxFileSystemHttpBinding({
    tag: "AWS.FSx.CreateDataRepositoryTask",
    operation: fsx.createDataRepositoryTask,
    actions: ["fsx:CreateDataRepositoryTask", "fsx:TagResource"],
    // The operation also authorizes on the new task's own ARN, which is
    // unknowable at deploy time.
    extraResourceArns: ["arn:aws:fsx:*:*:task/*"],
  }),
);

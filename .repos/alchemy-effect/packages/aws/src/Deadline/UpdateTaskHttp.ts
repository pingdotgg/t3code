import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { UpdateTask } from "./UpdateTask.ts";

export const UpdateTaskHttp = Layer.effect(
  UpdateTask,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.UpdateTask",
    operation: deadline.updateTask,
    actions: ["deadline:UpdateTask"],
  }),
);

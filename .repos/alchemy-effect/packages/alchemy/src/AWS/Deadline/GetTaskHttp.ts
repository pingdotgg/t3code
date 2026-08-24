import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { GetTask } from "./GetTask.ts";

export const GetTaskHttp = Layer.effect(
  GetTask,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.GetTask",
    operation: deadline.getTask,
    actions: ["deadline:GetTask"],
  }),
);

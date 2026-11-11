import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { UpdateJob } from "./UpdateJob.ts";

export const UpdateJobHttp = Layer.effect(
  UpdateJob,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.UpdateJob",
    operation: deadline.updateJob,
    actions: ["deadline:UpdateJob"],
  }),
);

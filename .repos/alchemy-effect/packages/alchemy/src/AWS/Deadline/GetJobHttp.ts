import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { GetJob } from "./GetJob.ts";

export const GetJobHttp = Layer.effect(
  GetJob,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.GetJob",
    operation: deadline.getJob,
    actions: ["deadline:GetJob"],
  }),
);

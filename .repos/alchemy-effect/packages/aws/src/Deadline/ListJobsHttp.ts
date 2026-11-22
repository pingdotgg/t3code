import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { ListJobs } from "./ListJobs.ts";

export const ListJobsHttp = Layer.effect(
  ListJobs,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.ListJobs",
    operation: deadline.listJobs,
    actions: ["deadline:ListJobs"],
  }),
);

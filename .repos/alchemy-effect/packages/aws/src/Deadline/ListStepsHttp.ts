import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { ListSteps } from "./ListSteps.ts";

export const ListStepsHttp = Layer.effect(
  ListSteps,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.ListSteps",
    operation: deadline.listSteps,
    actions: ["deadline:ListSteps"],
  }),
);

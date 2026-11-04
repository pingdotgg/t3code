import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { ListTasks } from "./ListTasks.ts";

export const ListTasksHttp = Layer.effect(
  ListTasks,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.ListTasks",
    operation: deadline.listTasks,
    actions: ["deadline:ListTasks"],
  }),
);

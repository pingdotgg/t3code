import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueSearchHttpBinding } from "./BindingHttp.ts";
import { SearchTasks } from "./SearchTasks.ts";

export const SearchTasksHttp = Layer.effect(
  SearchTasks,
  makeDeadlineQueueSearchHttpBinding({
    tag: "AWS.Deadline.SearchTasks",
    operation: deadline.searchTasks,
    actions: ["deadline:SearchTasks"],
  }),
);

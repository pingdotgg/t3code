import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueSearchHttpBinding } from "./BindingHttp.ts";
import { SearchSteps } from "./SearchSteps.ts";

export const SearchStepsHttp = Layer.effect(
  SearchSteps,
  makeDeadlineQueueSearchHttpBinding({
    tag: "AWS.Deadline.SearchSteps",
    operation: deadline.searchSteps,
    actions: ["deadline:SearchSteps"],
  }),
);

import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { ListSessionActions } from "./ListSessionActions.ts";

export const ListSessionActionsHttp = Layer.effect(
  ListSessionActions,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.ListSessionActions",
    operation: deadline.listSessionActions,
    actions: ["deadline:ListSessionActions"],
  }),
);

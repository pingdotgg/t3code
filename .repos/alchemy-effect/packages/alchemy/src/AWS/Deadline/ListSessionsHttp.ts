import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { ListSessions } from "./ListSessions.ts";

export const ListSessionsHttp = Layer.effect(
  ListSessions,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.ListSessions",
    operation: deadline.listSessions,
    actions: ["deadline:ListSessions"],
  }),
);

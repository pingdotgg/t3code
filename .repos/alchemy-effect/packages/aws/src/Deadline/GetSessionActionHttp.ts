import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { GetSessionAction } from "./GetSessionAction.ts";

export const GetSessionActionHttp = Layer.effect(
  GetSessionAction,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.GetSessionAction",
    operation: deadline.getSessionAction,
    actions: ["deadline:GetSessionAction"],
  }),
);

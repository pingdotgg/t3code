import * as deadline from "@distilled.cloud/aws/deadline";
import * as Layer from "effect/Layer";
import { makeDeadlineQueueHttpBinding } from "./BindingHttp.ts";
import { GetSession } from "./GetSession.ts";

export const GetSessionHttp = Layer.effect(
  GetSession,
  makeDeadlineQueueHttpBinding({
    tag: "AWS.Deadline.GetSession",
    operation: deadline.getSession,
    actions: ["deadline:GetSession"],
  }),
);

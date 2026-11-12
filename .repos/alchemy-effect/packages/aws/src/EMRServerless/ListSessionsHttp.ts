import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Layer from "effect/Layer";
import { makeEmrServerlessHttpBinding } from "./BindingHttp.ts";
import { ListSessions } from "./ListSessions.ts";

export const ListSessionsHttp = Layer.effect(
  ListSessions,
  makeEmrServerlessHttpBinding({
    tag: "AWS.EMRServerless.ListSessions",
    operation: emr.listSessions,
    actions: ["emr-serverless:ListSessions"],
  }),
);

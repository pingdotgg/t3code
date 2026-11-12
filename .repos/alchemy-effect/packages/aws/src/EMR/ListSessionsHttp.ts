import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import { ListSessions } from "./ListSessions.ts";

export const ListSessionsHttp = Layer.effect(
  ListSessions,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.ListSessions",
    operation: emr.listSessions,
    actions: ["elasticmapreduce:ListSessions"],
  }),
);

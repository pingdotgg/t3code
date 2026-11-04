import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataSetHttpBinding } from "./BindingHttp.ts";
import { ListDataSetRevisions } from "./ListDataSetRevisions.ts";

export const ListDataSetRevisionsHttp = Layer.effect(
  ListDataSetRevisions,
  makeDataSetHttpBinding({
    tag: "AWS.DataExchange.ListDataSetRevisions",
    operation: dataexchange.listDataSetRevisions,
    actions: ["dataexchange:ListDataSetRevisions"],
  }),
);

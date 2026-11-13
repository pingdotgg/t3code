import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeRevisionHttpBinding } from "./BindingHttp.ts";
import { GetRevision } from "./GetRevision.ts";

export const GetRevisionHttp = Layer.effect(
  GetRevision,
  makeRevisionHttpBinding({
    tag: "AWS.DataExchange.GetRevision",
    operation: dataexchange.getRevision,
    actions: ["dataexchange:GetRevision"],
  }),
);

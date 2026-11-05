import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeRevisionHttpBinding } from "./BindingHttp.ts";
import { RevokeRevision } from "./RevokeRevision.ts";

export const RevokeRevisionHttp = Layer.effect(
  RevokeRevision,
  makeRevisionHttpBinding({
    tag: "AWS.DataExchange.RevokeRevision",
    operation: dataexchange.revokeRevision,
    actions: ["dataexchange:RevokeRevision"],
  }),
);

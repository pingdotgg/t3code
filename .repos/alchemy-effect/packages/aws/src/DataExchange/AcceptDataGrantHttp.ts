import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { AcceptDataGrant } from "./AcceptDataGrant.ts";
import { makeDataExchangeAccountHttpBinding } from "./BindingHttp.ts";

export const AcceptDataGrantHttp = Layer.effect(
  AcceptDataGrant,
  makeDataExchangeAccountHttpBinding({
    tag: "AWS.DataExchange.AcceptDataGrant",
    operation: dataexchange.acceptDataGrant,
    actions: ["dataexchange:AcceptDataGrant"],
  }),
);

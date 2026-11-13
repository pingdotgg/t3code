import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataExchangeAccountHttpBinding } from "./BindingHttp.ts";
import { GetReceivedDataGrant } from "./GetReceivedDataGrant.ts";

export const GetReceivedDataGrantHttp = Layer.effect(
  GetReceivedDataGrant,
  makeDataExchangeAccountHttpBinding({
    tag: "AWS.DataExchange.GetReceivedDataGrant",
    operation: dataexchange.getReceivedDataGrant,
    actions: ["dataexchange:GetReceivedDataGrant"],
  }),
);

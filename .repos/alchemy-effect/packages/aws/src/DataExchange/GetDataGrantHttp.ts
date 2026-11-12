import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataExchangeAccountHttpBinding } from "./BindingHttp.ts";
import { GetDataGrant } from "./GetDataGrant.ts";

export const GetDataGrantHttp = Layer.effect(
  GetDataGrant,
  makeDataExchangeAccountHttpBinding({
    tag: "AWS.DataExchange.GetDataGrant",
    operation: dataexchange.getDataGrant,
    actions: ["dataexchange:GetDataGrant"],
  }),
);

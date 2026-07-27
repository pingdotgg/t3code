import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataExchangeAccountHttpBinding } from "./BindingHttp.ts";
import { ListReceivedDataGrants } from "./ListReceivedDataGrants.ts";

export const ListReceivedDataGrantsHttp = Layer.effect(
  ListReceivedDataGrants,
  makeDataExchangeAccountHttpBinding({
    tag: "AWS.DataExchange.ListReceivedDataGrants",
    operation: dataexchange.listReceivedDataGrants,
    actions: ["dataexchange:ListReceivedDataGrants"],
  }),
);

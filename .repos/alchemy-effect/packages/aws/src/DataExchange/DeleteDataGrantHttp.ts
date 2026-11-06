import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataExchangeAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteDataGrant } from "./DeleteDataGrant.ts";

export const DeleteDataGrantHttp = Layer.effect(
  DeleteDataGrant,
  makeDataExchangeAccountHttpBinding({
    tag: "AWS.DataExchange.DeleteDataGrant",
    operation: dataexchange.deleteDataGrant,
    actions: ["dataexchange:DeleteDataGrant"],
  }),
);

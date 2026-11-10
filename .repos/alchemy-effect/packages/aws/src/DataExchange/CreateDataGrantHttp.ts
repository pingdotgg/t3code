import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataExchangeAccountHttpBinding } from "./BindingHttp.ts";
import { CreateDataGrant } from "./CreateDataGrant.ts";

export const CreateDataGrantHttp = Layer.effect(
  CreateDataGrant,
  makeDataExchangeAccountHttpBinding({
    tag: "AWS.DataExchange.CreateDataGrant",
    operation: dataexchange.createDataGrant,
    actions: ["dataexchange:CreateDataGrant"],
  }),
);

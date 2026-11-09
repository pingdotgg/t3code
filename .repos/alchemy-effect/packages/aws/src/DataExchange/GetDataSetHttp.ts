import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataSetHttpBinding } from "./BindingHttp.ts";
import { GetDataSet } from "./GetDataSet.ts";

export const GetDataSetHttp = Layer.effect(
  GetDataSet,
  makeDataSetHttpBinding({
    tag: "AWS.DataExchange.GetDataSet",
    operation: dataexchange.getDataSet,
    actions: ["dataexchange:GetDataSet"],
  }),
);

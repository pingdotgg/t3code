import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataExchangeAccountHttpBinding } from "./BindingHttp.ts";
import { CancelJob } from "./CancelJob.ts";

export const CancelJobHttp = Layer.effect(
  CancelJob,
  makeDataExchangeAccountHttpBinding({
    tag: "AWS.DataExchange.CancelJob",
    operation: dataexchange.cancelJob,
    actions: ["dataexchange:CancelJob"],
  }),
);

import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataExchangeAccountHttpBinding } from "./BindingHttp.ts";
import { GetJob } from "./GetJob.ts";

export const GetJobHttp = Layer.effect(
  GetJob,
  makeDataExchangeAccountHttpBinding({
    tag: "AWS.DataExchange.GetJob",
    operation: dataexchange.getJob,
    actions: ["dataexchange:GetJob"],
  }),
);

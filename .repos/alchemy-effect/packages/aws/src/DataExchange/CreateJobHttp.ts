import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Layer from "effect/Layer";
import { makeDataExchangeAccountHttpBinding } from "./BindingHttp.ts";
import { CreateJob } from "./CreateJob.ts";

export const CreateJobHttp = Layer.effect(
  CreateJob,
  makeDataExchangeAccountHttpBinding({
    tag: "AWS.DataExchange.CreateJob",
    operation: dataexchange.createJob,
    actions: ["dataexchange:CreateJob"],
  }),
);

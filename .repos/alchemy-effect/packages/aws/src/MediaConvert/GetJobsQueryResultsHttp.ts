import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Layer from "effect/Layer";
import { makeMediaConvertHttpBinding } from "./BindingHttp.ts";
import { GetJobsQueryResults } from "./GetJobsQueryResults.ts";

export const GetJobsQueryResultsHttp = Layer.effect(
  GetJobsQueryResults,
  makeMediaConvertHttpBinding({
    capability: "GetJobsQueryResults",
    iamActions: ["mediaconvert:GetJobsQueryResults"],
    operation: mediaconvert.getJobsQueryResults,
  }),
);

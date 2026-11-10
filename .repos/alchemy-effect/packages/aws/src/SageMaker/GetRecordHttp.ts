import * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import * as Layer from "effect/Layer";
import { makeFeatureGroupHttpBinding } from "./BindingHttp.ts";
import { GetRecord, type GetRecordRequest } from "./GetRecord.ts";

export const GetRecordHttp = Layer.effect(
  GetRecord,
  makeFeatureGroupHttpBinding({
    tag: "AWS.SageMaker.GetRecord",
    operation: featurestore.getRecord,
    actions: ["sagemaker:GetRecord"],
    prepare: (request: GetRecordRequest, featureGroupName) => ({
      ...request,
      FeatureGroupName: featureGroupName,
    }),
  }),
);

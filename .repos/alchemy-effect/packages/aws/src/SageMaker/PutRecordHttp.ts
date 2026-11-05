import * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import * as Layer from "effect/Layer";
import { makeFeatureGroupHttpBinding } from "./BindingHttp.ts";
import { PutRecord, type PutRecordRequest } from "./PutRecord.ts";

export const PutRecordHttp = Layer.effect(
  PutRecord,
  makeFeatureGroupHttpBinding({
    tag: "AWS.SageMaker.PutRecord",
    operation: featurestore.putRecord,
    actions: ["sagemaker:PutRecord"],
    prepare: (request: PutRecordRequest, featureGroupName) => ({
      ...request,
      FeatureGroupName: featureGroupName,
    }),
  }),
);

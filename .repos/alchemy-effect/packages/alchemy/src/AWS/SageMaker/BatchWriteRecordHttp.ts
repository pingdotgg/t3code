import * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import * as Layer from "effect/Layer";
import {
  BatchWriteRecord,
  type BatchWriteRecordRequest,
} from "./BatchWriteRecord.ts";
import { makeFeatureGroupHttpBinding } from "./BindingHttp.ts";

export const BatchWriteRecordHttp = Layer.effect(
  BatchWriteRecord,
  makeFeatureGroupHttpBinding({
    tag: "AWS.SageMaker.BatchWriteRecord",
    operation: featurestore.batchWriteRecord,
    actions: ["sagemaker:BatchWriteRecord"],
    // The wire request identifies the feature group per entry — scope every
    // entry to the bound feature group.
    prepare: (request: BatchWriteRecordRequest, featureGroupName) => ({
      Entries: request.Entries.map((entry) => ({
        ...entry,
        FeatureGroupName: featureGroupName,
      })),
      TtlDuration: request.TtlDuration,
    }),
  }),
);

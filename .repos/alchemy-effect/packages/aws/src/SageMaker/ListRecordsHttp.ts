import * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import * as Layer from "effect/Layer";
import { makeFeatureGroupHttpBinding } from "./BindingHttp.ts";
import { ListRecords, type ListRecordsRequest } from "./ListRecords.ts";

export const ListRecordsHttp = Layer.effect(
  ListRecords,
  makeFeatureGroupHttpBinding({
    tag: "AWS.SageMaker.ListRecords",
    operation: featurestore.listRecords,
    actions: ["sagemaker:ListRecords"],
    prepare: (request: ListRecordsRequest | undefined, featureGroupName) => ({
      ...request,
      FeatureGroupName: featureGroupName,
    }),
  }),
);

import * as featurestore from "@distilled.cloud/aws/sagemaker-featurestore-runtime";
import * as Layer from "effect/Layer";
import { makeFeatureGroupHttpBinding } from "./BindingHttp.ts";
import { DeleteRecord, type DeleteRecordRequest } from "./DeleteRecord.ts";

export const DeleteRecordHttp = Layer.effect(
  DeleteRecord,
  makeFeatureGroupHttpBinding({
    tag: "AWS.SageMaker.DeleteRecord",
    operation: featurestore.deleteRecord,
    actions: ["sagemaker:DeleteRecord"],
    prepare: (request: DeleteRecordRequest, featureGroupName) => ({
      ...request,
      FeatureGroupName: featureGroupName,
    }),
  }),
);

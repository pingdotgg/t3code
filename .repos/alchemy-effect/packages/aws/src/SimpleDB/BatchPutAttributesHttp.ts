import * as sdb from "@distilled.cloud/aws/simpledb";
import * as Layer from "effect/Layer";
import { BatchPutAttributes } from "./BatchPutAttributes.ts";
import { makeSimpleDbBinding } from "./Binding.ts";

export const BatchPutAttributesHttp = Layer.effect(
  BatchPutAttributes,
  makeSimpleDbBinding({
    operation: "BatchPutAttributes",
    method: sdb.batchPutAttributes,
  }),
);

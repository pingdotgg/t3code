import * as sdb from "@distilled.cloud/aws/simpledb";
import * as Layer from "effect/Layer";
import { BatchDeleteAttributes } from "./BatchDeleteAttributes.ts";
import { makeSimpleDbBinding } from "./Binding.ts";

export const BatchDeleteAttributesHttp = Layer.effect(
  BatchDeleteAttributes,
  makeSimpleDbBinding({
    operation: "BatchDeleteAttributes",
    method: sdb.batchDeleteAttributes,
  }),
);

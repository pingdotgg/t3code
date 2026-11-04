import * as sdb from "@distilled.cloud/aws/simpledb";
import * as Layer from "effect/Layer";
import { makeSimpleDbBinding } from "./Binding.ts";
import { PutAttributes } from "./PutAttributes.ts";

export const PutAttributesHttp = Layer.effect(
  PutAttributes,
  makeSimpleDbBinding({
    operation: "PutAttributes",
    method: sdb.putAttributes,
  }),
);

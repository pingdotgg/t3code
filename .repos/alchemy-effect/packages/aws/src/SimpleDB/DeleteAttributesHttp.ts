import * as sdb from "@distilled.cloud/aws/simpledb";
import * as Layer from "effect/Layer";
import { makeSimpleDbBinding } from "./Binding.ts";
import { DeleteAttributes } from "./DeleteAttributes.ts";

export const DeleteAttributesHttp = Layer.effect(
  DeleteAttributes,
  makeSimpleDbBinding({
    operation: "DeleteAttributes",
    method: sdb.deleteAttributes,
  }),
);

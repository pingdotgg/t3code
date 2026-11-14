import * as sdb from "@distilled.cloud/aws/simpledb";
import * as Layer from "effect/Layer";
import { makeSimpleDbBinding } from "./Binding.ts";
import { GetAttributes } from "./GetAttributes.ts";

export const GetAttributesHttp = Layer.effect(
  GetAttributes,
  makeSimpleDbBinding({
    operation: "GetAttributes",
    method: sdb.getAttributes,
  }),
);

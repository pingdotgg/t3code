import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Layer from "effect/Layer";
import { makeB2biAccountHttpBinding } from "./BindingHttp.ts";
import { TestMapping } from "./TestMapping.ts";

export const TestMappingHttp = Layer.effect(
  TestMapping,
  makeB2biAccountHttpBinding({
    tag: "AWS.B2BI.TestMapping",
    operation: b2bi.testMapping,
    actions: ["b2bi:TestMapping"],
  }),
);

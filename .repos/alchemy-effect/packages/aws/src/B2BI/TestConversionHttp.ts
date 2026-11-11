import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Layer from "effect/Layer";
import { makeB2biAccountHttpBinding } from "./BindingHttp.ts";
import { TestConversion } from "./TestConversion.ts";

export const TestConversionHttp = Layer.effect(
  TestConversion,
  makeB2biAccountHttpBinding({
    tag: "AWS.B2BI.TestConversion",
    operation: b2bi.testConversion,
    // `target.outputSampleFile` is read through the caller's session
    // (forward-access), so the S3 read grants ride along.
    actions: ["b2bi:TestConversion", "s3:GetObject", "s3:GetObjectAttributes"],
  }),
);

import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Layer from "effect/Layer";
import { makeB2biAccountHttpBinding } from "./BindingHttp.ts";
import { TestParsing } from "./TestParsing.ts";

export const TestParsingHttp = Layer.effect(
  TestParsing,
  makeB2biAccountHttpBinding({
    tag: "AWS.B2BI.TestParsing",
    operation: b2bi.testParsing,
    // B2BI reads `inputFile` through the caller's session (verified live:
    // "Access denied when getting object attributes from s3://…" without
    // the S3 grants), so the documented companion permissions are granted
    // alongside.
    actions: ["b2bi:TestParsing", "s3:GetObject", "s3:GetObjectAttributes"],
  }),
);

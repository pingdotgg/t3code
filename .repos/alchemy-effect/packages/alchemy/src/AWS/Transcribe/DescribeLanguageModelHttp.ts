import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { DescribeLanguageModel } from "./DescribeLanguageModel.ts";

export const DescribeLanguageModelHttp = Layer.effect(
  DescribeLanguageModel,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.DescribeLanguageModel",
    operation: transcribe.describeLanguageModel,
    actions: ["transcribe:DescribeLanguageModel"],
  }),
);

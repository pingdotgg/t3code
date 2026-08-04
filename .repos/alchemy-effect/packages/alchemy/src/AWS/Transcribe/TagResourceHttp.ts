import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { TagResource } from "./TagResource.ts";

export const TagResourceHttp = Layer.effect(
  TagResource,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.TagResource",
    operation: transcribe.tagResource,
    actions: ["transcribe:TagResource"],
  }),
);

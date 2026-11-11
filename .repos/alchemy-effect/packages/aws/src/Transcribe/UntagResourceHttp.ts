import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { UntagResource } from "./UntagResource.ts";

export const UntagResourceHttp = Layer.effect(
  UntagResource,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.UntagResource",
    operation: transcribe.untagResource,
    actions: ["transcribe:UntagResource"],
  }),
);

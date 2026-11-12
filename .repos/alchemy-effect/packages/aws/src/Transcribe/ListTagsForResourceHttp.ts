import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";
import { ListTagsForResource } from "./ListTagsForResource.ts";

export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.ListTagsForResource",
    operation: transcribe.listTagsForResource,
    actions: ["transcribe:ListTagsForResource"],
  }),
);

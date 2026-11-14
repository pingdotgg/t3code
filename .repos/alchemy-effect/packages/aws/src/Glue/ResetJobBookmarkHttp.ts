import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueJobHttpBinding } from "./BindingHttp.ts";
import { ResetJobBookmark } from "./ResetJobBookmark.ts";

export const ResetJobBookmarkHttp = Layer.effect(
  ResetJobBookmark,
  makeGlueJobHttpBinding({
    tag: "AWS.Glue.ResetJobBookmark",
    operation: glue.resetJobBookmark,
    actions: ["glue:ResetJobBookmark"],
    // Glue evaluates bookmark actions without a resource — an ARN-scoped
    // grant never matches (verified live via the IAM policy simulator).
    anyResource: true,
  }),
);

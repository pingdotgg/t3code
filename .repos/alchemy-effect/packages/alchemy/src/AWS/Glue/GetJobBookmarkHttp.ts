import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueJobHttpBinding } from "./BindingHttp.ts";
import { GetJobBookmark } from "./GetJobBookmark.ts";

export const GetJobBookmarkHttp = Layer.effect(
  GetJobBookmark,
  makeGlueJobHttpBinding({
    tag: "AWS.Glue.GetJobBookmark",
    operation: glue.getJobBookmark,
    actions: ["glue:GetJobBookmark"],
    // Glue evaluates bookmark actions without a resource — an ARN-scoped
    // grant never matches (verified live via the IAM policy simulator).
    anyResource: true,
  }),
);

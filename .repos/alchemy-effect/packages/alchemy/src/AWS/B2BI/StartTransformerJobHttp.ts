import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Layer from "effect/Layer";
import { makeTransformerScopedHttpBinding } from "./BindingHttp.ts";
import { StartTransformerJob } from "./StartTransformerJob.ts";

export const StartTransformerJobHttp = Layer.effect(
  StartTransformerJob,
  makeTransformerScopedHttpBinding({
    tag: "AWS.B2BI.StartTransformerJob",
    operation: b2bi.startTransformerJob,
    actions: ["b2bi:StartTransformerJob"],
    // B2BI reads `inputFile` and writes `outputLocation` through the
    // caller's session (verified live: "Access denied when getting object
    // attributes from s3://…" without these). The buckets are request-time
    // values, so the grant cannot be resource-scoped here.
    companionStatements: [
      {
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:GetObjectAttributes",
          "s3:PutObject",
          "s3:ListBucket",
        ],
        Resource: ["*"],
      },
    ],
  }),
);

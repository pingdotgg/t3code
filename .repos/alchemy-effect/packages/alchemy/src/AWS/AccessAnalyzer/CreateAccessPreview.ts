import type * as aa from "@distilled.cloud/aws/accessanalyzer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Analyzer } from "./Analyzer.ts";

/** `CreateAccessPreview` request with `analyzerArn` injected from the bound {@link Analyzer}. */
export interface CreateAccessPreviewRequest extends Omit<
  aa.CreateAccessPreviewRequest,
  "analyzerArn"
> {}

/**
 * Runtime binding for `access-analyzer:CreateAccessPreview`.
 *
 * Previews the findings a proposed resource policy would generate, before
 * deploying the policy. Provide the implementation with
 * `Effect.provide(AWS.AccessAnalyzer.CreateAccessPreviewHttp)`.
 * @binding
 * @section Access Previews
 * @example Preview a Proposed Bucket Policy
 * ```typescript
 * const createPreview =
 *   yield* AWS.AccessAnalyzer.CreateAccessPreview(analyzer);
 * const preview = yield* createPreview({
 *   configurations: {
 *     [bucketArn]: { s3Bucket: { bucketPolicy: proposedPolicy } },
 *   },
 * });
 * ```
 */
export interface CreateAccessPreview extends Binding.Service<
  CreateAccessPreview,
  "AWS.AccessAnalyzer.CreateAccessPreview",
  (
    analyzer: Analyzer,
  ) => Effect.Effect<
    (
      request: CreateAccessPreviewRequest,
    ) => Effect.Effect<
      aa.CreateAccessPreviewResponse,
      aa.CreateAccessPreviewError
    >
  >
> {}

export const CreateAccessPreview = Binding.Service<CreateAccessPreview>(
  "AWS.AccessAnalyzer.CreateAccessPreview",
);

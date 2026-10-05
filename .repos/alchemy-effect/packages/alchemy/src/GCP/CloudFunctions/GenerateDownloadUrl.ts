import type * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Function as CloudFunction } from "./Function.ts";

export interface GenerateDownloadUrlRequest extends Omit<
  cloudfunctions.GenerateDownloadUrlProjectsLocationsFunctionsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Functions `functions.generateDownloadUrl`.
 *
 * Bind this operation to a {@link Function} in a Function/Action init phase.
 * Provide {@link GenerateDownloadUrlHttp}. The returned URL is valid for a
 * limited time (about 30 minutes). Grants `roles/cloudfunctions.developer`
 * (the narrowest predefined role with `functions.sourceCodeGet`) on the
 * project under an IAM Condition naming only the bound function (2nd gen
 * functions accept only invoker roles on their own IAM policy).
 *
 * ### Downloading Source
 * **Example:** Generate a signed download URL
 * ```typescript
 * const download = yield* GCP.CloudFunctions.GenerateDownloadUrl(hello);
 * const { downloadUrl } = yield* download();
 * ```
 *
 * @binding
 * @category CloudFunctions
 */
export interface GenerateDownloadUrl extends Binding.Service<
  GenerateDownloadUrl,
  "GCP.CloudFunctions.GenerateDownloadUrl",
  (
    fn: CloudFunction,
  ) => Effect.Effect<
    (
      request?: GenerateDownloadUrlRequest,
    ) => Effect.Effect<
      cloudfunctions.GenerateDownloadUrlResponse,
      cloudfunctions.GenerateDownloadUrlProjectsLocationsFunctionsError,
      RuntimeContext
    >
  >
> {}

export const GenerateDownloadUrl = Binding.Service<GenerateDownloadUrl>(
  "GCP.CloudFunctions.GenerateDownloadUrl",
);

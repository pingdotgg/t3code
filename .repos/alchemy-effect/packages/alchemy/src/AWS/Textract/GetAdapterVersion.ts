import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Adapter } from "./Adapter.ts";

/**
 * Runtime binding for `textract:GetAdapterVersion` — read the training
 * status, dataset configuration, and evaluation metrics of a version of
 * the bound adapter.
 *
 * @binding
 * @section Managing Adapters
 * @example Poll Adapter Version Training
 * ```typescript
 * // init
 * const getAdapterVersion = yield* AWS.Textract.GetAdapterVersion(adapter);
 *
 * // runtime
 * const result = yield* getAdapterVersion({ AdapterVersion: "1" });
 * if (result.Status === "ACTIVE") {
 *   // ready for AnalyzeDocument AdaptersConfig
 * }
 * ```
 */
export interface GetAdapterVersion extends Binding.Service<
  GetAdapterVersion,
  "AWS.Textract.GetAdapterVersion",
  <A extends Adapter>(
    adapter: A,
  ) => Effect.Effect<
    (
      request: Omit<textract.GetAdapterVersionRequest, "AdapterId">,
    ) => Effect.Effect<
      textract.GetAdapterVersionResponse,
      textract.GetAdapterVersionError
    >
  >
> {}
export const GetAdapterVersion = Binding.Service<GetAdapterVersion>(
  "AWS.Textract.GetAdapterVersion",
);

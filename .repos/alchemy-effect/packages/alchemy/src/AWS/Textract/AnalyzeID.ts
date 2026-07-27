import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:AnalyzeID` — synchronous extraction of
 * identity-document fields (name, date of birth, document number, …) from
 * images of passports, driver licenses, and other government IDs.
 *
 * @binding
 * @section Synchronous Analysis
 * @example Analyze an Identity Document
 * ```typescript
 * // init
 * const analyzeID = yield* AWS.Textract.AnalyzeID();
 *
 * // runtime
 * const result = yield* analyzeID({
 *   DocumentPages: [{ Bytes: licenseBytes }],
 * });
 * const fields = result.IdentityDocuments?.[0]?.IdentityDocumentFields;
 * ```
 */
export interface AnalyzeID extends Binding.Service<
  AnalyzeID,
  "AWS.Textract.AnalyzeID",
  () => Effect.Effect<
    (
      request: textract.AnalyzeIDRequest,
    ) => Effect.Effect<textract.AnalyzeIDResponse, textract.AnalyzeIDError>
  >
> {}
export const AnalyzeID = Binding.Service<AnalyzeID>("AWS.Textract.AnalyzeID");

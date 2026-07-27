import type * as textract from "@distilled.cloud/aws/textract";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `textract:AnalyzeDocument` — synchronous analysis of
 * relationships in a document: forms (key-value pairs), tables, layout,
 * signatures, and natural-language queries. Pass the document as raw bytes
 * or as an S3 object reference; the caller needs `s3:GetObject` on the
 * bucket for S3 input (bind `AWS.S3.GetObject(bucket)` alongside).
 *
 * @binding
 * @section Synchronous Analysis
 * @example Analyze Forms and Tables
 * ```typescript
 * // init
 * const analyzeDocument = yield* AWS.Textract.AnalyzeDocument();
 *
 * // runtime
 * const result = yield* analyzeDocument({
 *   Document: { Bytes: documentBytes },
 *   FeatureTypes: ["FORMS", "TABLES"],
 * });
 * const tables = (result.Blocks ?? []).filter((b) => b.BlockType === "TABLE");
 * ```
 */
export interface AnalyzeDocument extends Binding.Service<
  AnalyzeDocument,
  "AWS.Textract.AnalyzeDocument",
  () => Effect.Effect<
    (
      request: textract.AnalyzeDocumentRequest,
    ) => Effect.Effect<
      textract.AnalyzeDocumentResponse,
      textract.AnalyzeDocumentError
    >
  >
> {}
export const AnalyzeDocument = Binding.Service<AnalyzeDocument>(
  "AWS.Textract.AnalyzeDocument",
);

import type * as documentai from "@distilled.cloud/gcp/documentai_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Processor } from "./Processor.ts";

export interface ProcessRequest extends Omit<
  documentai.ProcessProjectsLocationsProcessorsRequest,
  "name"
> {}

/**
 * Runtime binding for Document AI `processors.process`.
 *
 * Bind this operation to a {@link Processor} in a Function/Action init
 * phase. Provide {@link ProcessHttp}.
 *
 * ### Processing a Document
 * **Example:** OCR a raw PDF
 * ```typescript
 * const process = yield* GCP.DocumentAI.Process(processor);
 * const result = yield* process({
 *   body: {
 *     rawDocument: {
 *       content: pdfBase64,
 *       mimeType: "application/pdf",
 *     },
 *     skipHumanReview: true,
 *   },
 * });
 * ```
 *
 * @binding
 * @category DocumentAI
 */
export interface Process extends Binding.Service<
  Process,
  "GCP.DocumentAI.Process",
  (
    processor: Processor,
  ) => Effect.Effect<
    (
      request?: ProcessRequest,
    ) => Effect.Effect<
      documentai.GoogleCloudDocumentaiV1ProcessResponse,
      documentai.ProcessProjectsLocationsProcessorsError,
      RuntimeContext
    >
  >
> {}

export const Process = Binding.Service<Process>("GCP.DocumentAI.Process");

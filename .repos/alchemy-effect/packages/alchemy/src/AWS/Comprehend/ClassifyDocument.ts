import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:ClassifyDocument` — classify a single
 * document in real time against a custom classifier endpoint or a
 * Comprehend prebuilt model ARN (`EndpointArn`).
 *
 * The binding takes no arguments and grants the action on `*` — endpoints
 * are addressed per-request via `EndpointArn`, so the grant cannot be
 * scoped tighter at deploy time.
 *
 * @binding
 * @section Real-Time Analysis
 * @example Classify a Document Against a Custom Endpoint
 * ```typescript
 * // init
 * const classifyDocument = yield* AWS.Comprehend.ClassifyDocument();
 *
 * // runtime
 * const result = yield* classifyDocument({
 *   Text: "Subject: your invoice for March is attached",
 *   EndpointArn: endpointArn,
 * });
 * // result.Classes: [{ Name: "INVOICE", Score: 0.98 }, …]
 * ```
 */
export interface ClassifyDocument extends Binding.Service<
  ClassifyDocument,
  "AWS.Comprehend.ClassifyDocument",
  () => Effect.Effect<
    (
      request: comprehend.ClassifyDocumentRequest,
    ) => Effect.Effect<
      comprehend.ClassifyDocumentResponse,
      comprehend.ClassifyDocumentError
    >
  >
> {}
export const ClassifyDocument = Binding.Service<ClassifyDocument>(
  "AWS.Comprehend.ClassifyDocument",
);

import type * as b2bi from "@distilled.cloud/aws/b2bi";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `b2bi:TestConversion`.
 *
 * Synchronously converts an inline JSON or XML document into an outbound
 * X12 EDI document — the inline counterpart of an outbound transformer's
 * conversion step. Provide the implementation with
 * `Effect.provide(AWS.B2BI.TestConversionHttp)`.
 * @binding
 * @section Converting Documents to EDI
 * @example Convert JSON to an X12 850
 * ```typescript
 * // init — account-level, no resource argument
 * const testConversion = yield* AWS.B2BI.TestConversion();
 *
 * // runtime
 * const result = yield* testConversion({
 *   source: { fileFormat: "JSON", inputFile: { fileContent } },
 *   target: {
 *     fileFormat: "X12",
 *     formatDetails: {
 *       x12: { transactionSet: "X12_850", version: "VERSION_4010" },
 *     },
 *   },
 * });
 * // result.convertedFileContent — the generated X12 document
 * ```
 */
export interface TestConversion extends Binding.Service<
  TestConversion,
  "AWS.B2BI.TestConversion",
  () => Effect.Effect<
    (
      request: b2bi.TestConversionRequest,
    ) => Effect.Effect<b2bi.TestConversionResponse, b2bi.TestConversionError>
  >
> {}
export const TestConversion = Binding.Service<TestConversion>(
  "AWS.B2BI.TestConversion",
);

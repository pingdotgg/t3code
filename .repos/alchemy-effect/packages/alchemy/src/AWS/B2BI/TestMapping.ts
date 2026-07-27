import type * as b2bi from "@distilled.cloud/aws/b2bi";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `b2bi:TestMapping`.
 *
 * Synchronously maps sample content with a mapping template (JSONATA or
 * XSLT) — the inline counterpart of a transformer's mapping step, useful for
 * validating templates or transforming small documents on the fly without a
 * deployed transformer. Provide the implementation with
 * `Effect.provide(AWS.B2BI.TestMappingHttp)`.
 * @binding
 * @section Testing Mappings
 * @example Map a JSON Document with a JSONATA Template
 * ```typescript
 * // init — account-level, no resource argument
 * const testMapping = yield* AWS.B2BI.TestMapping();
 *
 * // runtime
 * const result = yield* testMapping({
 *   inputFileContent: JSON.stringify({ customer: "acme" }),
 *   mappingTemplate: '{ "name": customer }',
 *   fileFormat: "JSON",
 * });
 * // result.mappedFileContent === '{"name":"acme"}'
 * ```
 */
export interface TestMapping extends Binding.Service<
  TestMapping,
  "AWS.B2BI.TestMapping",
  () => Effect.Effect<
    (
      request: b2bi.TestMappingRequest,
    ) => Effect.Effect<b2bi.TestMappingResponse, b2bi.TestMappingError>
  >
> {}
export const TestMapping = Binding.Service<TestMapping>("AWS.B2BI.TestMapping");

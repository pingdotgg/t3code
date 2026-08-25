import type * as b2bi from "@distilled.cloud/aws/b2bi";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `b2bi:TestParsing`.
 *
 * Synchronously parses an EDI document in S3 (e.g. an X12 file) into the
 * JSON or XML representation B2BI's mapping step consumes. B2BI reads the
 * `inputFile` with its service principal, so the bucket needs a bucket
 * policy granting `b2bi.amazonaws.com` read access. Provide the
 * implementation with `Effect.provide(AWS.B2BI.TestParsingHttp)`.
 * @binding
 * @section Parsing EDI Documents
 * @example Parse an X12 850 into JSON
 * ```typescript
 * // init — account-level, no resource argument
 * const testParsing = yield* AWS.B2BI.TestParsing();
 *
 * // runtime
 * const result = yield* testParsing({
 *   inputFile: { bucketName: "my-edi-bucket", key: "inbound/order.edi" },
 *   fileFormat: "JSON",
 *   ediType: {
 *     x12Details: { transactionSet: "X12_850", version: "VERSION_4010" },
 *   },
 * });
 * // result.parsedFileContent — the JSON representation of the EDI file
 * ```
 */
export interface TestParsing extends Binding.Service<
  TestParsing,
  "AWS.B2BI.TestParsing",
  () => Effect.Effect<
    (
      request: b2bi.TestParsingRequest,
    ) => Effect.Effect<b2bi.TestParsingResponse, b2bi.TestParsingError>
  >
> {}
export const TestParsing = Binding.Service<TestParsing>("AWS.B2BI.TestParsing");

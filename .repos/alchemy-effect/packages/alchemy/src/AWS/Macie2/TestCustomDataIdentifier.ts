import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:TestCustomDataIdentifier`.
 *
 * Tests criteria for a custom data identifier.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.TestCustomDataIdentifierHttp)`.
 * @binding
 * @section Custom Data Identifiers & Lists
 * @example Test a Detection Regex
 * ```typescript
 * // init — account-level binding, no resource argument
 * const testCustomDataIdentifier = yield* AWS.Macie2.TestCustomDataIdentifier();
 *
 * // runtime
 * const { matchCount } = yield* testCustomDataIdentifier({
 *   regex: "EMP-[0-9]{8}",
 *   sampleText: "id EMP-12345678",
 * });
 * ```
 */
export interface TestCustomDataIdentifier extends Binding.Service<
  TestCustomDataIdentifier,
  "AWS.Macie2.TestCustomDataIdentifier",
  () => Effect.Effect<
    (
      request?: macie2.TestCustomDataIdentifierRequest,
    ) => Effect.Effect<
      macie2.TestCustomDataIdentifierResponse,
      macie2.TestCustomDataIdentifierError
    >
  >
> {}
export const TestCustomDataIdentifier =
  Binding.Service<TestCustomDataIdentifier>(
    "AWS.Macie2.TestCustomDataIdentifier",
  );

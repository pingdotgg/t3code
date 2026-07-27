import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:CreateSampleFindings`.
 *
 * Creates sample findings.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.CreateSampleFindingsHttp)`.
 * @binding
 * @section Working with Findings
 * @example Generate Sample Findings
 * ```typescript
 * // init — account-level binding, no resource argument
 * const createSampleFindings = yield* AWS.Macie2.CreateSampleFindings();
 *
 * // runtime
 * yield* createSampleFindings({});
 * ```
 */
export interface CreateSampleFindings extends Binding.Service<
  CreateSampleFindings,
  "AWS.Macie2.CreateSampleFindings",
  () => Effect.Effect<
    (
      request?: macie2.CreateSampleFindingsRequest,
    ) => Effect.Effect<
      macie2.CreateSampleFindingsResponse,
      macie2.CreateSampleFindingsError
    >
  >
> {}
export const CreateSampleFindings = Binding.Service<CreateSampleFindings>(
  "AWS.Macie2.CreateSampleFindings",
);

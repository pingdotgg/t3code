import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListSensitivityInspectionTemplates`.
 *
 * Retrieves a subset of information about the sensitivity inspection template for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListSensitivityInspectionTemplatesHttp)`.
 * @binding
 * @section Automated Discovery
 * @example List Inspection Templates
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listSensitivityInspectionTemplates = yield* AWS.Macie2.ListSensitivityInspectionTemplates();
 *
 * // runtime
 * const { sensitivityInspectionTemplates } = yield* listSensitivityInspectionTemplates();
 * ```
 */
export interface ListSensitivityInspectionTemplates extends Binding.Service<
  ListSensitivityInspectionTemplates,
  "AWS.Macie2.ListSensitivityInspectionTemplates",
  () => Effect.Effect<
    (
      request?: macie2.ListSensitivityInspectionTemplatesRequest,
    ) => Effect.Effect<
      macie2.ListSensitivityInspectionTemplatesResponse,
      macie2.ListSensitivityInspectionTemplatesError
    >
  >
> {}
export const ListSensitivityInspectionTemplates =
  Binding.Service<ListSensitivityInspectionTemplates>(
    "AWS.Macie2.ListSensitivityInspectionTemplates",
  );

import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:UpdateSensitivityInspectionTemplate`.
 *
 * Updates the settings for the sensitivity inspection template for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.UpdateSensitivityInspectionTemplateHttp)`.
 * @binding
 * @section Automated Discovery
 * @example Tune the Inspection Template
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateSensitivityInspectionTemplate = yield* AWS.Macie2.UpdateSensitivityInspectionTemplate();
 *
 * // runtime
 * yield* updateSensitivityInspectionTemplate({
 *   id: templateId,
 *   includes: { managedDataIdentifierIds: ["CREDIT_CARD_NUMBER"] },
 * });
 * ```
 */
export interface UpdateSensitivityInspectionTemplate extends Binding.Service<
  UpdateSensitivityInspectionTemplate,
  "AWS.Macie2.UpdateSensitivityInspectionTemplate",
  () => Effect.Effect<
    (
      request: macie2.UpdateSensitivityInspectionTemplateRequest,
    ) => Effect.Effect<
      macie2.UpdateSensitivityInspectionTemplateResponse,
      macie2.UpdateSensitivityInspectionTemplateError
    >
  >
> {}
export const UpdateSensitivityInspectionTemplate =
  Binding.Service<UpdateSensitivityInspectionTemplate>(
    "AWS.Macie2.UpdateSensitivityInspectionTemplate",
  );

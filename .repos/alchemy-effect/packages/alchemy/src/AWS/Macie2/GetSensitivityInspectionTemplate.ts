import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetSensitivityInspectionTemplate`.
 *
 * Retrieves the settings for the sensitivity inspection template for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetSensitivityInspectionTemplateHttp)`.
 * @binding
 * @section Automated Discovery
 * @example Read a Sensitivity Inspection Template
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getSensitivityInspectionTemplate = yield* AWS.Macie2.GetSensitivityInspectionTemplate();
 *
 * // runtime
 * const template = yield* getSensitivityInspectionTemplate({ id: templateId });
 * ```
 */
export interface GetSensitivityInspectionTemplate extends Binding.Service<
  GetSensitivityInspectionTemplate,
  "AWS.Macie2.GetSensitivityInspectionTemplate",
  () => Effect.Effect<
    (
      request: macie2.GetSensitivityInspectionTemplateRequest,
    ) => Effect.Effect<
      macie2.GetSensitivityInspectionTemplateResponse,
      macie2.GetSensitivityInspectionTemplateError
    >
  >
> {}
export const GetSensitivityInspectionTemplate =
  Binding.Service<GetSensitivityInspectionTemplate>(
    "AWS.Macie2.GetSensitivityInspectionTemplate",
  );

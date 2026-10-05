import type * as recaptchaenterprise from "@distilled.cloud/gcp/recaptchaenterprise_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Key } from "./Key.ts";

export interface CreateAssessmentRequest extends Omit<
  recaptchaenterprise.CreateProjectsAssessmentsRequest,
  "parent"
> {}

/**
 * Runtime binding for reCAPTCHA Enterprise `assessments.create`.
 *
 * Bind this operation to a {@link Key} in a Function/Action init phase.
 * Provide {@link CreateAssessmentHttp}. The key's site key is filled in
 * on `event.siteKey` when omitted.
 *
 * ### Creating an Assessment
 * **Example:** Assess a login event
 * ```typescript
 * const createAssessment = yield* GCP.RecaptchaEnterprise.CreateAssessment(
 *   key,
 * );
 * const assessment = yield* createAssessment({
 *   body: {
 *     event: {
 *       token: recaptchaToken,
 *       expectedAction: "login",
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 * @category RecaptchaEnterprise
 */
export interface CreateAssessment extends Binding.Service<
  CreateAssessment,
  "GCP.RecaptchaEnterprise.CreateAssessment",
  (
    key: Key,
  ) => Effect.Effect<
    (
      request?: CreateAssessmentRequest,
    ) => Effect.Effect<
      recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1Assessment,
      recaptchaenterprise.CreateProjectsAssessmentsError,
      RuntimeContext
    >
  >
> {}

export const CreateAssessment = Binding.Service<CreateAssessment>(
  "GCP.RecaptchaEnterprise.CreateAssessment",
);

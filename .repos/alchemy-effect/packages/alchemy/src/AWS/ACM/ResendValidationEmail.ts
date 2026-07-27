import type * as acm from "@distilled.cloud/aws/acm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Certificate } from "./Certificate.ts";

/**
 * The resend request without the injected `CertificateArn`.
 */
export interface ResendValidationEmailRequest extends Omit<
  acm.ResendValidationEmailRequest,
  "CertificateArn"
> {}

/**
 * Runtime binding for `acm:ResendValidationEmail`.
 *
 * Bind this operation to a {@link Certificate} requested with
 * `validationMethod: "EMAIL"` to get a callable that re-sends the domain
 * ownership validation email — e.g. behind a "resend email" button in an
 * onboarding flow. Calling it on a DNS-validated certificate fails with the
 * typed `InvalidStateException`. Provide the implementation with
 * `Effect.provide(AWS.ACM.ResendValidationEmailHttp)`.
 * @binding
 * @section Validating Certificates
 * @example Re-send the Validation Email
 * ```typescript
 * // init — bind the operation to the certificate
 * const resendValidationEmail =
 *   yield* AWS.ACM.ResendValidationEmail(certificate);
 *
 * // runtime
 * yield* resendValidationEmail({
 *   Domain: "www.example.com",
 *   ValidationDomain: "example.com",
 * });
 * ```
 */
export interface ResendValidationEmail extends Binding.Service<
  ResendValidationEmail,
  "AWS.ACM.ResendValidationEmail",
  (
    certificate: Certificate,
  ) => Effect.Effect<
    (
      request: ResendValidationEmailRequest,
    ) => Effect.Effect<
      acm.ResendValidationEmailResponse,
      acm.ResendValidationEmailError
    >
  >
> {}

export const ResendValidationEmail = Binding.Service<ResendValidationEmail>(
  "AWS.ACM.ResendValidationEmail",
);

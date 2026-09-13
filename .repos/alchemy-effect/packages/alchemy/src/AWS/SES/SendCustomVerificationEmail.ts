import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EmailIdentityRef } from "./BindingHttp.ts";
import type { ConfigurationSet } from "./ConfigurationSet.ts";
import type { EmailIdentity } from "./EmailIdentity.ts";

/**
 * Runtime binding for `sesv2:SendCustomVerificationEmail`.
 *
 * Sends the branded verification email defined by a
 * {@link CustomVerificationEmailTemplate} to a new email address, kicking off
 * the address-verification flow. Pass the template name and the address to
 * verify; SES takes the FROM address from the template.
 *
 * Bind it to the identity the function is allowed to VERIFY — SES authorizes
 * this action against the identity of the address in the request, not against
 * the template's FROM identity. Bind a domain to allow any address at it, or
 * a single address to allow exactly that one. Without a bound identity the
 * binding would let any holder send verification mail to arbitrary addresses.
 * The identity is not injected into the request. Optionally bind a
 * {@link ConfigurationSet}, which is injected into each request.
 *
 * The identity may be a managed {@link EmailIdentity} or a plain reference —
 * `{ emailIdentity: "signups.example.com" }`. The reference form creates no
 * resource edge and takes no ownership, so it can scope the grant to an
 * identity the stack does not manage without a destroy ever deleting it.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.SES.SendCustomVerificationEmailHttp)`.
 *
 * Note: actually sending a custom verification email requires the account to
 * be out of the SES sandbox — in the sandbox the call fails with the typed
 * `BadRequestException`.
 * ### Verifying Addresses
 * **Example:** Send a Custom Verification Email
 * ```typescript
 * // init — the function may verify addresses at this identity's domain
 * const sendVerification = yield* SES.SendCustomVerificationEmail(identity);
 *
 * // runtime
 * const { MessageId } = yield* sendVerification({
 *   EmailAddress: "new-user@example.com",
 *   TemplateName: yield* template.templateName,
 * });
 * ```
 *
 * **Example:** Scope to a Domain the Stack Does Not Manage
 * ```typescript
 * // Any address at signups.example.com may be verified. No resource edge and
 * // no ownership — nothing is created, adopted, or destroyed.
 * const sendVerification = yield* SES.SendCustomVerificationEmail({
 *   emailIdentity: "signups.example.com",
 * });
 * ```
 *
 * **Example:** Attribute the Send to a Configuration Set
 * ```typescript
 * // ConfigurationSetName is injected into every request
 * const sendVerification = yield* SES.SendCustomVerificationEmail(
 *   identity,
 *   configSet,
 * );
 * ```
 *
 * @binding
 */
export interface SendCustomVerificationEmail extends Binding.Service<
  SendCustomVerificationEmail,
  "AWS.SES.SendCustomVerificationEmail",
  (
    identity: EmailIdentity | EmailIdentityRef,
    configurationSet?: ConfigurationSet,
  ) => Effect.Effect<
    (
      request: Omit<
        sesv2.SendCustomVerificationEmailRequest,
        "ConfigurationSetName"
      >,
    ) => Effect.Effect<
      sesv2.SendCustomVerificationEmailResponse,
      sesv2.SendCustomVerificationEmailError
    >
  >
> {}
export const SendCustomVerificationEmail =
  Binding.Service<SendCustomVerificationEmail>(
    "AWS.SES.SendCustomVerificationEmail",
  );

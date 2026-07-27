import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ConfigurationSet } from "./ConfigurationSet.ts";
import type { EmailIdentity } from "./EmailIdentity.ts";

/**
 * The `sendEmail` request with the binding-injected members removed:
 * `ConfigurationSetName` comes from the bound configuration set, and
 * `FromEmailAddress` defaults to the bound identity (override it for domain
 * identities, e.g. `hello@{domain}`).
 */
export interface SendEmailRequest extends Omit<
  sesv2.SendEmailRequest,
  "ConfigurationSetName"
> {}

/**
 * Runtime binding for `sesv2:SendEmail`.
 *
 * Bind this operation to an `EmailIdentity` (and optionally a
 * `ConfigurationSet`) inside a function runtime to get a callable that sends
 * simple, raw, or templated email. The binding grants the function
 * `ses:SendEmail` (and the raw/templated variants) scoped to the identity,
 * the account's templates, and the configuration set.
 *
 * For an email-address identity, `FromEmailAddress` defaults to the identity
 * itself. For a domain identity, pass an address at the domain explicitly.
 *
 * Note: while the account is in the SES sandbox, both the sender identity
 * must be verified and every recipient must be a verified identity or the
 * SES mailbox simulator (e.g. `success@simulator.amazonses.com`).
 * @binding
 * @section Sending Email
 * @example Send a Simple Message
 * ```typescript
 * // init
 * const sendEmail = yield* SES.SendEmail(identity);
 *
 * // runtime
 * const result = yield* sendEmail({
 *   Destination: { ToAddresses: ["success@simulator.amazonses.com"] },
 *   Content: {
 *     Simple: {
 *       Subject: { Data: "Hello" },
 *       Body: { Text: { Data: "Hello from SES." } },
 *     },
 *   },
 * });
 * // result.MessageId
 * ```
 *
 * @example Send Through a Configuration Set
 * ```typescript
 * const sendEmail = yield* SES.SendEmail(identity, configSet);
 * ```
 *
 * @example Send a Templated Message
 * ```typescript
 * const result = yield* sendEmail({
 *   Destination: { ToAddresses: ["customer@example.com"] },
 *   Content: {
 *     Template: {
 *       TemplateName: "welcome-template",
 *       TemplateData: JSON.stringify({ name: "Ada" }),
 *     },
 *   },
 * });
 * ```
 */
export interface SendEmail extends Binding.Service<
  SendEmail,
  "AWS.SES.SendEmail",
  <I extends EmailIdentity>(
    identity: I,
    configurationSet?: ConfigurationSet,
  ) => Effect.Effect<
    (
      request: SendEmailRequest,
    ) => Effect.Effect<sesv2.SendEmailResponse, sesv2.SendEmailError>
  >
> {}
export const SendEmail = Binding.Service<SendEmail>("AWS.SES.SendEmail");
